/**
 * dsh-perf-hud — 浏览器端性能 HUD(纯客户端)。
 *
 * 浏览器半的全部实现在这个文件里;Host 侧(index.js)是可选的:它只提供
 * perf_hooks 事件循环采样与一个 /api/dsh-perf-hud/host 路由(事件循环读数、
 * session/event 到达延迟、bundle 读写代理)。宿主半没加载时面板照常工作,
 * 只是那三处显示不可用并写明原因。仪表固定在右下角
 * (实时 fps + 插桩状态药丸),展开后是完整面板。
 *
 * 四项测量:
 *   1. FPS      —— 自己的 rAF 循环(走原生 rAF,不自我归因),1 秒滚动窗口
 *   2. Longtask —— PerformanceObserver({ entryTypes: ['longtask'] }),近 60 秒最差一次
 *   3. 归因     —— 包住 setTimeout / setInterval / requestAnimationFrame 三个调度点,
 *                  在"调度时"抓 CallSite 栈,取最上层 /plugins/... 帧里的插件 id;
 *                  累计每插件回调次数与回调同步耗时,面板给 Top3 + 其余
 *   4. DOM      —— 节点总数(减掉 HUD 自身子树)+ 会话列表 / 消息区两个容器的新增速率
 *
 * 为什么归因要自己插桩:本版本(0.2.0-rc.2)的客户端不往 DOM 上打 data-dsh-plugin,
 * 插件脚本是以懒加载 <script> 装载的,URL 形如
 *   plugins/??<包名>/client.js&rev=<hash>       ← 一包一条 combo(正常情况)
 *   /plugins/<包名>/<分片>.js?rev=<hash>         ← 包内分片
 *   plugins/??a/client.js,b/client.js&rev=<h>    ← 启动批(本版本只 preload,不执行)
 * 所以"当前代码属于哪个插件"只能从脚本 URL 反推,而 URL 只在栈帧里。
 *
 * 依赖:react(浏览器模块表提供)。除此之外零运行时依赖。
 */
window.__ModuleLoader__.load({
	id: 'dsh-perf-hud',
	factory: (require) => {
		const React = require('react');
		const h = React.createElement;

		const PKG = 'dsh-perf-hud';
		const NS = 'perf-hud';
		const LS_RING = 'dsh-perf-hud:ring:v1';
		const LS_ON = 'dsh-perf-hud:on';
		const LS_UI = 'dsh-perf-hud:collapsed';
		const RING_MAX = 500;        // 环形缓冲条数(1 条/秒 ≈ 8 分钟)
		const TOP_N = 3;             // 面板展示的插件条数
		const LT_WINDOW_MS = 60000;  // longtask 观察窗口
		const RECENT_MAX = 256;      // 用于 longtask 归因的最近回调(含仍在执行的)
		const MUT_SAMPLE = 10;       // DOM 写入归因:每 10 次抓一次栈
		const MUT_TOP = 2;           // 面板展示的 DOM 写入者条数
		const BUNDLE_PREFIX = 'bundle:';       // 多包合并 URL 的 key 前缀
		const LS_DEEP = 'dsh-perf-hud:deep';
		const LS_PRECISE = 'dsh-perf-hud:precise';
		const LS_MAP = 'dsh-perf-hud:map';     // 按 rev 缓存的 section 分段表
		const LS_MARKS = 'dsh-perf-hud:marks';
		const LS_GROUPS = 'dsh-perf-hud:groups';
		const LS_INCIDENTS = 'dsh-perf-hud:incidents:v1';   // 守夜层留存的事故(要活过刷新)
		const LS_SESSIONS = 'dsh-perf-hud:sessions:v1';     // A2 跨会话基线(每个会话一条,只进导出件)
		const SESSION_KEEP = 20;                            // 跨会话基线保留最近几个会话
		const HOST_ROUTE = '/api/dsh-perf-hud/host';
		const RTT_INTERVAL_MS = 10000;
		const LOAD_INTERVAL_MS = 60000;
		const LOAD_BYTES = 65536;
		const MUT_WINDOW_MS = 2000;            // fiber 归因只看最近 2 秒被改动的节点
		const BASELINE_MS = 60000;
		const STEP_MS = 60000;         // 隔离实验:每个候选"关闭后"的测量窗口
		const BRACKET_MS = 30000;      // 隔离实验:每个候选前后各打一次基线(对照 + 噪声采样)
		const EXPERIMENT_IDLE_WAIT_MS = 300000;   // 开跑前最多等 5 分钟,等会话空闲(流式窗口不可比)
		const EXPERIMENT_LOAD_BURN_MS = 8;        // 合成负载:每拍燃烧的毫秒数
		const EXPERIMENT_LOAD_PERIOD_MS = 250;    // 合成负载:两拍之间的间隔
		const IDLE_GAP_MS = 3000;
		const EXPERIMENT_MAX_CANDIDATES = 4;   // 隔离实验最多测几个候选(每个 ≈90 秒:60s 窗口 + 前后基线)
		// 守夜层(默认常开、不插桩):帧级环形缓冲 + LoAF 观察器 + 最差 N 次事件留存。
		// 它要解决的不是"读数更全",而是"卡顿发生时你没在看,事后还能把那 10 秒捞回来"。
		const WATCH_FRAMES = 12000;            // 帧级环形缓冲条数(60fps ≈ 3.3 分钟)
		const WATCH_LOAF_MAX = 200;            // 保留多少条长动画帧
		const WATCH_SCRIPT_MAX = 12;           // 一条长动画帧最多记多少个脚本
		const WATCH_INCIDENT_MAX = 10;         // 全局最差档:自动留存最差几次(真正的天花板是 WATCH_PERSIST_MAX_BYTES)
		const WATCH_DAILY_DAYS = 7;            // 每天最差档:最多留最近几天的"当天最差一条"
		// 两档合起来的上限。单靠全局最差那一档不行:实测一次会话「捕获 40 · 丢弃 38」,
		// 最差 10 条会全挤在同一小时里,于是"昨天下午那次卡"永远留不下来。
		const WATCH_KEEP_MAX = WATCH_INCIDENT_MAX + WATCH_DAILY_DAYS;
		const WATCH_PRE_MS = 10000;            // 前摇:事件发生前的 10 秒
		const WATCH_POST_MS = 3000;            // 后摇:事件发生后再等 3 秒才切片
		const WATCH_TRIGGER_MS = 100;          // 帧间隔 / blockingDuration 越过它就起一次捕获
		const PICK_MIN_MS = WATCH_TRIGGER_MS;   // 翻帧清单的下限:blocking ≥ 它才值得回看(与守夜触发线同一条)
		const WATCH_GAP_MS = 1000;             // 帧间隔超过它视为 rAF 挂起:是间隙,不是卡顿
		const WATCH_REACTION_MS = 3000;        // 手动标记时回退的"人的反应时间"
		// A4:交互延迟(event timing)。只收 ≥100ms 的 —— 与守夜同一条线,而且要的不是全量事件流
		// (mousemove/keydown 那种量级会把环形缓冲冲掉)。element timing 走同一个观察器。
		const WATCH_EVENT_MS = 100;
		const WATCH_EVENT_MAX = 200;           // 交互计时的环形上限
		const WATCH_PERSIST_MAX_BYTES = 2097152;  // 事故落盘的字节上限(超了丢最弱的);512KB 时实测只装得下 8 条
		/** React 自身的容器型具名组件:不是"谁在渲染"的答案,走查时跳过。 */
		const REACT_INTERNAL = new Set(['Fragment', 'Suspense', 'StrictMode', 'Profiler', 'ForwardRef', 'Memo', 'Provider', 'Consumer', 'Root', 'Anonymous']);

		const W = window;
		// 自测要的是"一次同步提交"里的重负载。React 18 默认会把长渲染时间切片,
		// 切片之后每片都很小 → 根本不会出现 longtask(实测点自测卡在"进行中"就是这个)。
		// react-dom 的 flushSync 能强制同步提交;模块表里拿不到就如实退化,并在面板写明。
		let flushSync = null;
		try {
			const reactDom = require('react-dom');
			if (reactDom !== null && reactDom !== undefined && typeof reactDom.flushSync === 'function') flushSync = reactDom.flushSync;
		} catch (error) {
			flushSync = null;
		}
		// 原生调度器:插桩前后都从这里取,保证能恢复、且自身循环零开销。
		const natives = {
			setTimeout: W.setTimeout.bind(W),
			clearTimeout: W.clearTimeout.bind(W),
			setInterval: W.setInterval.bind(W),
			clearInterval: W.clearInterval.bind(W),
			requestAnimationFrame: W.requestAnimationFrame.bind(W),
			cancelAnimationFrame: W.cancelAnimationFrame.bind(W),
		};

		// ───────────────────────── 归因:script URL → 插件 id ─────────────────────────
		// 默认栈深 10 帧,插件把调度藏在几层包装后面时会丢归属;抬到 30 帧。
		// 只影响错误对象的栈深度,不影响性能测量本身。
		if (typeof Error.stackTraceLimit === 'number' && Error.stackTraceLimit < 30) Error.stackTraceLimit = 30;

		const PLUGIN_URL = /(?:^|\/)plugins\/(?:\?\?([^&]+)|((?:@[^/?#]+\/)?[^/?#]+)\/[^?#]*)/;

		function ownerOfUrl(url) {
			const m = PLUGIN_URL.exec(url);
			if (m === null) return null;
			if (m[1] !== undefined) {
				const ids = m[1].split(',').map((s) => s.replace(/\/[^/,]+\.js(\.map)?$/, '')).filter(Boolean);
				if (ids.length === 0) return null;
				if (ids.length === 1) return ids[0];
				// 多包同 URL:包名只能由 section 分段表还原,不再拼成一串包名糊弄面板。
				const key = BUNDLE_PREFIX + url;
				state.bundleKeys.add(key);
				if (state.bundleKeys.size > 50) state.bundleKeys.delete(state.bundleKeys.values().next().value);
				return BUNDLE_PREFIX + url;
			}
			return m[2] ?? null;
		}

		// ─────────────── A. 精确归因:合并 bundle 的 indexed sourcemap 分段表 ───────────────
		// 合并包里没有 sourceURL 边界标记,唯一可靠的边界是它自带的 indexed sourcemap:
		// sections[i].offset.line 是该包源码在合并文件里的起始行(0-based),sources[0] 指向
		// /plugins/<包>/…。V8 的 CallSite 行号是 1-based,换算时减一(单测钉住这一点)。
		const bundleMaps = new Map();   // bundle key -> { state, offsets, names, count, reason, source }
		const bundleMeta = new Map();   // bundle key -> { phase, count }

		/** 把栈帧里可能出现的相对 URL 绝对化。 */
		function absolutePluginUrl(url) {
			if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) return url;
			const at = url.indexOf('plugins/??');
			return `${location.origin}/${at === -1 ? url.replace(/^\//, '') : url.slice(at)}`;
		}

		/** 合并脚本 URL → 它的 indexed sourcemap URL(给列表里每一项加 .map,按 loader 的 comboSearch 形态)。 */
		function mapUrlOf(scriptUrl) {
			const at = scriptUrl.indexOf('??');
			if (at === -1) return null;
			const revAt = scriptUrl.indexOf('&rev=');
			const list = scriptUrl.slice(at + 2, revAt === -1 ? undefined : revAt);
			if (list === '') return null;
			const mapped = list.split(',').map((item) => `${item}.map`).join(',');
			return `${scriptUrl.slice(0, at + 2)}${mapped}${revAt === -1 ? '' : scriptUrl.slice(revAt)}`;
		}

		/** 一个 section 属于哪个包:优先按 sources 里的 /plugins/<包>/ 取。 */
		function sectionName(section) {
			const sources = section?.map?.sources;
			if (Array.isArray(sources) === false) return null;
			for (const source of sources) {
				if (typeof source !== 'string') continue;
				const m = /\/plugins\/((?:@[^/]+\/)?[^/?#]+)\//.exec(source);
				if (m !== null) return m[1];
			}
			return null;
		}

		/** 合并批次的名字与包数:优先读 boot payload,其次数 URL 里的逗号列表。 */
		function bundleMetaOf(key) {
			const cached = bundleMeta.get(key);
			if (cached !== undefined) return cached;
			const scriptUrl = absolutePluginUrl(key.slice(BUNDLE_PREFIX.length));
			const list = /\/plugins\/\?\?([^&]+)/.exec(scriptUrl);
			let meta = { phase: '', count: list === null ? 0 : list[1].split(',').length };
			const boot = W.__DSH_BOOT__;
			if (boot !== null && typeof boot === 'object' && Array.isArray(boot.batches)) {
				const relative = scriptUrl.replace(`${location.origin}/`, '');
				for (const batch of boot.batches) {
					if (batch?.url !== relative && batch?.url !== scriptUrl) continue;
					meta = { phase: typeof batch.phase === 'string' ? batch.phase : '', count: Array.isArray(batch.entries) ? batch.entries.length : meta.count };
					break;
				}
			}
			bundleMeta.set(key, meta);
			return meta;
		}

		/** 面板/归因表里显示的一行:批次名 + 包数(+状态),绝不展开成 58 个名字。 */
		function bundleLabel(key) {
			const meta = bundleMetaOf(key);
			if (state.precise === false) return `${meta.phase === '' ? '合并' : meta.phase}批次(${meta.count} 包)`;
			const entry = bundleMaps.get(key);
			const status = entry === undefined || entry.state === 'pending'
				? '·解析中'
				: entry.state === 'ready' ? '' : `·map失败(${entry.reason})`;
			return `${meta.phase === '' ? '合并' : meta.phase}批次(${meta.count} 包)${status}`;
		}

		/**
		 * 懒加载 + 按 rev 缓存。只有「精确归因」打开、并且真的遇到多包 URL 时才拉 map,
		 * 而且同一 rev 只解析一次(12.8MB 只下这一次)。
		 */
		function bundleMap(key) {
			const existing = bundleMaps.get(key);
			if (existing !== undefined) return existing;
			const scriptUrl = absolutePluginUrl(key.slice(BUNDLE_PREFIX.length));
			const entry = { state: 'pending', offsets: null, names: null, count: 0, reason: '', source: '' };
			bundleMaps.set(key, entry);
			const revMatch = /[?&]rev=([^&#]*)/.exec(scriptUrl);
			const signature = `v1:${revMatch === null ? 'norev' : revMatch[1]}:${scriptUrl.length}`;
			const storageKey = `${LS_MAP}:${signature}`;
			entry.storageKey = `${LS_MAP}:${signature}`;
			try {
				const saved = localStorage.getItem(storageKey);
				const parsed = saved === null ? null : JSON.parse(saved);
				if (parsed !== null && Array.isArray(parsed.offsets) && parsed.offsets.length > 1 && Array.isArray(parsed.names)) {
					entry.offsets = parsed.offsets;
					entry.names = parsed.names;
					entry.count = parsed.offsets.length;
					entry.state = 'ready';
					entry.source = 'localStorage';
					return entry;
				}
			} catch (error) { /* 缓存坏了就重取 */ }
			loadBundleMap(entry, scriptUrl);
			return entry;
		}

		async function loadBundleMap(entry, scriptUrl) {
			const url = mapUrlOf(scriptUrl);
			if (url === null) {
				entry.state = 'failed';
				entry.reason = 'URL 里没有 ?? 列表';
				return;
			}
			try {
				const response = await fetch(url, { credentials: 'same-origin' });
				if (response.ok === false) throw new Error(`HTTP ${response.status}`);
				const document = JSON.parse(await response.text());
				const sections = Array.isArray(document?.sections) ? document.sections : null;
				if (sections === null || sections.length === 0) throw new Error('没有 sections');
				const offsets = [];
				const names = [];
				for (const section of sections) {
					const line = section?.offset?.line;
					const name = sectionName(section);
					if (typeof line !== 'number' || name === null) continue;
					offsets.push([line, name]);
					names.push(name);
				}
				if (offsets.length === 0) throw new Error('sections 里没有可用边界');
				offsets.sort((a, b) => a[0] - b[0]);
				entry.offsets = offsets;
				entry.names = names;
				entry.count = offsets.length;
				entry.state = 'ready';
				entry.source = 'sourcemap';
				try {
					// 只留 offsets/names,原始 JSON 立刻丢掉。
					localStorage.setItem(entry.storageKey, JSON.stringify({ v: 1, offsets, names }));
				} catch (error) { /* 配额不够就只留内存 */ }
			} catch (error) {
				entry.reason = error instanceof Error ? error.message : String(error);
				await loadBundleMapByProbe(entry, scriptUrl);
			}
		}

		/** 兜底:map 拿不到时,用各单包响应的开头在合并文本里定位边界(代价高,只在失败后走一次)。 */
		async function loadBundleMapByProbe(entry, scriptUrl) {
			try {
				const list = /\/plugins\/\?\?([^&]+)/.exec(scriptUrl);
				if (list === null) throw new Error('URL 里没有 ?? 列表');
				const ids = list[1].split(',').map((item) => item.replace(/\/[^/,]+\.js(\.map)?$/, '')).filter(Boolean);
				const revMatch = /[?&]rev=([^&#]*)/.exec(scriptUrl);
				const suffix = revMatch === null ? '' : `&rev=${revMatch[1]}`;
				const [text, probes] = await Promise.all([
					fetch(scriptUrl, { credentials: 'same-origin' }).then((response) => response.text()),
					Promise.all(ids.map(async (id) => {
						try {
							const response = await fetch(`${location.origin}/plugins/??${id}/client.js${suffix}`, { credentials: 'same-origin' });
							const body = await response.text();
							return { id, head: body.slice(0, 200) };
						} catch (error) {
							return { id, head: '' };
						}
					})),
				]);
				const hits = [];
				for (const probe of probes) {
					if (probe.head === '') continue;
					const offset = text.indexOf(probe.head);
					if (offset === -1) continue;
					hits.push({ offset, id: probe.id });
				}
				if (hits.length === 0) throw new Error(`${entry.reason} / 单包首字节也定位不到`);
				hits.sort((a, b) => a.offset - b.offset);
				const offsets = [];
				let line = 0;
				let cursor = 0;
				for (const hit of hits) {
					for (let i = cursor; i < hit.offset; i += 1) if (text.charCodeAt(i) === 10) line += 1;
					cursor = hit.offset;
					offsets.push([line, hit.id]);
				}
				entry.offsets = offsets;
				entry.names = offsets.map((item) => item[1]);
				entry.count = offsets.length;
				entry.state = 'ready';
				entry.source = 'probe';
				try { localStorage.setItem(entry.storageKey, JSON.stringify({ v: 1, offsets, names: entry.names })); } catch (error) { /* 同上 */ }
			} catch (error) {
				entry.state = 'failed';
				entry.reason = error instanceof Error ? error.message : String(error);
			}
		}

		/** V8 行号(1-based)二分到 section(offset 0-based)。 */
		function sectionOwner(entry, lineNumber) {
			const offsets = entry.offsets;
			const line0 = lineNumber - 1;
			let lo = 0;
			let hi = offsets.length - 1;
			let found = -1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (offsets[mid][0] <= line0) {
					found = mid;
					lo = mid + 1;
				} else hi = mid - 1;
			}
			return found === -1 ? null : offsets[found][1];
		}

		/** 把 ownerOfUrl 的结果落成"具体包名";多包 URL 未解析完成时给一行批次标签。 */
		function resolveOwner(owner, line) {
			if (owner.startsWith(BUNDLE_PREFIX) === false) return owner;
			if (state.precise === false) return bundleLabel(owner);
			const entry = bundleMap(owner);
			if (entry.state !== 'ready') return bundleLabel(owner);
			const name = sectionOwner(entry, line);
			return name ?? `${bundleLabel(owner)}·越界`;
		}

		/** 打开精确归因时,把已经见过的多包 URL 一次性登记解析。 */
		function primeBundleMaps() {
			for (const key of state.bundleKeys) bundleMap(key);
		}

		// ──────── A2. LoAF 脚本 → 包名:字符位置 → 行号 → 分段表 ────────
		// LoAF 的 scripts[] 给的是「合并批 URL + 字符位置」,而包名藏在合并批里(见 §6.1)。
		// 单包 URL 直接从 URL 读得出包名;多包 URL 必须把字符位置换算成行号,再查分段表。
		// 换算要那段脚本文本(同源 fetch,浏览器内存缓存命中),所以后台预取一次、按 URL 缓存。
		const scriptLines = new Map();   // url -> { state, starts, reason }
		const SCRIPT_LINES_MAX = 8;      // 有界:实测一个会话里真正出现的合并批只有一两个

		/** 取一段脚本文本的「每行起始偏移」,用于 charPos → 1-based 行号。 */
		async function loadScriptLines(url) {
			const entry = { state: 'pending', starts: null, reason: '' };
			scriptLines.set(url, entry);
			try {
				const response = await fetch(url, { credentials: 'same-origin' });
				if (response.ok === false) throw new Error(`HTTP ${response.status}`);
				const text = await response.text();
				// 逐 UTF-16 code unit 扫 —— 与 V8 给的 sourceCharPosition 同一套计数,
				// 不能用 code point(遇到 emoji 一类会整体错位)
				const starts = [0];
				for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
				entry.starts = starts;
				entry.length = text.length;
				entry.state = 'ready';
			} catch (error) {
				entry.state = 'failed';
				entry.reason = error instanceof Error ? error.message : String(error);
			}
			if (scriptLines.size > SCRIPT_LINES_MAX) {
				const oldest = scriptLines.keys().next().value;
				if (oldest !== url) scriptLines.delete(oldest);
			}
			return entry;
		}

		/** 幂等预取(后台跑,不挡切片)。 */
		function ensureScriptLines(url) {
			if (scriptLines.has(url)) return;
			loadScriptLines(url);
		}

		/** charPos → 1-based 行号;文本还没到位返回 null,落在文本之外返回 -1(都不猜)。 */
		function scriptLineOf(url, charPos) {
			const entry = scriptLines.get(url);
			if (entry === undefined || entry.state !== 'ready') return null;
			if (typeof charPos !== 'number' || charPos < 0) return null;
			if (typeof entry.length === 'number' && charPos >= entry.length) return -1;
			const starts = entry.starts;
			let lo = 0;
			let hi = starts.length - 1;
			let found = 0;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (starts[mid] <= charPos) { found = mid; lo = mid + 1; } else hi = mid - 1;
			}
			return found + 1;
		}

		/**
		 * 一条 LoAF 脚本 → 包名。`via` 说明这个名字是怎么来的,拿不到就写清为什么 ——
		 * 面板与导出件都要能回答"为什么这一条没名字"。
		 */
		function packageOfScript(url, charPos) {
			if (typeof url !== 'string' || url === '') return { pkg: null, via: 'no-url' };
			const owner = ownerOfUrl(url);
			if (owner === null) return { pkg: null, via: 'not-plugin' };
			if (owner.startsWith(BUNDLE_PREFIX) === false) return { pkg: owner, via: 'url' };
			if (state.precise === false) return { pkg: null, via: 'precise-off' };
			const lines = scriptLines.get(url);
			if (lines === undefined) { ensureScriptLines(url); return { pkg: null, via: 'text-pending' }; }
			if (lines.state === 'failed') return { pkg: null, via: `text-failed(${lines.reason})` };
			if (lines.state !== 'ready') return { pkg: null, via: 'text-pending' };
			const line = scriptLineOf(url, charPos);
			if (line === null) return { pkg: null, via: 'no-charpos' };
			if (line < 1) return { pkg: null, via: 'out-of-range' };   // 字符位置超出了这段脚本
			const entry = bundleMap(owner);
			if (entry.state !== 'ready') return { pkg: null, via: `map-${entry.state}` };
			const name = sectionOwner(entry, line);
			return name === null ? { pkg: null, via: 'out-of-range' } : { pkg: name, via: 'section' };
		}

		/**
		 * 宿主外壳组件不算"谁在渲染"。
		 *
		 * 实测长任务命中报成 `SlotOutlet` —— 那是 DSH 把插件内容渲染进槽位的那个**座**:
		 * 技术上算命中,却答不了"谁的锅",而且还很容易被误读成某个插件。这类名字跳过,
		 * 继续往上找真正的组件;另一条 DOM 写入路径会做交叉验证。
		 */
		function looksLikeInfrastructure(name) {
			if (typeof name !== 'string' || name === '') return false;
			// 清单来自实测观察到的宿主组件:槽位座(SlotOutlet)、布局列(CenterColumn)、
			// 各种 Provider/Boundary/Context。插件若真把组件叫 XxxColumn 会被跳过 ——
			// 代价是这次归属退到另一条腿,比把宿主列名当答案好(另一条腿会交叉验证)。
			if (/Slot|Outlet|Column/.test(name)) return true;
			if (/(Boundary|Provider|Context)$/.test(name)) return true;
			return false;
		}

		/**
		 * B1:本记录器自己的名字。
		 *
		 * 它必须被**标注**,不能静默剔除 —— 记录器每帧都在自己的 rAF 回调里跑,归因腿命中它
		 * 是必然的;静默丢掉会让人以为"这段时间没人干活",而如实标出来才答得了"是我自己在花时间,
		 * 还是页面在卡"。所以:命名上打标、汇总里单列,只有"别的候选都说不通"时才让它当元凶。
		 * PerfHudStress 是自测夹具(显式燃烧那一段),同一个包,一样算自己。
		 */
		const SELF_NAMES = new Set(['PerfHud', 'PerfHudStress', PKG]);
		function isRecorderName(name) {
			return typeof name === 'string' && SELF_NAMES.has(name);
		}

		/** @deepseek-ai/* 是 DSH 自带的核心包:React、scheduler、外壳 UI 都在这一层。 */
		function isCore(id) {
			return id.startsWith('@deepseek-ai/');
		}

		/**
		 * V8 快路径:把 Error.prepareStackTrace 临时换成"返回 CallSite 数组",
		 * 省掉每帧文本格式化 —— 每帧只取 getFileName(),比 Error.stack 字符串便宜得多。
		 */
		function callSites(skip) {
			if (typeof Error.captureStackTrace !== 'function') return null;
			const previous = Error.prepareStackTrace;
			Error.prepareStackTrace = (error, sites) => sites;
			const holder = {};
			Error.captureStackTrace(holder, skip);
			const sites = holder.stack;
			Error.prepareStackTrace = previous;
			return Array.isArray(sites) ? sites : null;
		}

		/** 最上层 /plugins/... 帧所属的插件 id;没有则 null(宿主内联脚本、React 内部等)。 */
		/**
		 * 栈里"最该负责的插件"。
		 *
		 * 关键取舍:React 自己的调度/提交栈帧属于核心包,而**发起这次重渲染的插件**
		 * 的帧在更深处。只取最上层 /plugins/ 帧会把 React 干的事全记到核心包头上
		 * (实测面板清一色 @deepseek-ai/...),所以这里优先返回最上层**非核心**包,
		 * 一个非核心包都没有时才退回最上层的核心包。
		 */
		function ownerFromStack(skip) {
			const sites = callSites(skip);
			if (sites !== null) {
				let fallback = null;
				for (const site of sites) {
					let file;
					let line = 0;
					try {
						file = site.getFileName();
						line = site.getLineNumber();
					} catch (error) { continue; }
					if (!file) continue;
					const raw = ownerOfUrl(file);
					if (raw === null) continue;
					const owner = resolveOwner(raw, line);
					if (!isCore(owner)) return owner;
					// 精确归因还没解析完时,批次标签不是"核心包",会被上面的分支直接返回 —— 这是
					// 有意的:宁可显示"application批次(58 包)",也不把归属错记到核心包头上。
					if (fallback === null) fallback = owner;
				}
				return fallback;
			}
			// 字符串兜底(没有 CallSite):从 "…:行:列)" 里取行号,单包 URL 才解析得到。
			const text = new Error().stack ?? '';
			let fallback = null;
			for (const frame of text.split('\n')) {
				const matched = /((?:[a-z][a-z\d+.-]*:\/\/|\/)?[^\s()]*plugins\/\?\?[^\s()]*?):(\d+):(\d+)/.exec(frame);
				const raw = ownerOfUrl(frame);
				if (raw === null) continue;
				const owner = matched === null ? raw : resolveOwner(raw, Number(matched[2]));
				if (!isCore(owner)) return owner;
				if (fallback === null) fallback = owner;
			}
			return fallback;
		}

		// ───────────── B. longtask 补 fiber:渲染型卡顿没有调度点可抓 ─────────────
		// 只留最近 MUT_WINDOW_MS 内被改动过的节点引用(childList+subtree;属性变更太吵,
		// 而且对"谁在渲染"没有额外信息)。longtask 到来时用这些节点当入口,顺着
		// __reactFiber$ 往 return 方向走,取最近的具名函数组件。
		const changedNodes = [];
		let domWatch = null;
		// 最近 2 秒被采样到的写入者(owner + 组件):React 提交阶段栈里没有插件帧时,
		// 组件名是唯一线索,长任务归属靠它做第二条腿。
		const recentWrites = [];
		const RECENT_WRITES_MAX = 96;

		function trimChangedNodes(now) {
			while (changedNodes.length > 0 && now - changedNodes[0].at > MUT_WINDOW_MS) changedNodes.shift();
			if (changedNodes.length > 4000) changedNodes.splice(0, changedNodes.length - 4000);
		}

		function startDomWatch() {
			if (domWatch !== null || typeof W.MutationObserver !== 'function') return;
			const observer = new W.MutationObserver((records) => {
				const now = performance.now();
				for (const record of records) changedNodes.push({ node: record.target, at: now });
				trimChangedNodes(now);
			});
			observer.observe(document.documentElement, { childList: true, subtree: true });
			domWatch = observer;
		}

		function stopDomWatch() {
			if (domWatch !== null) {
				domWatch.disconnect();
				domWatch = null;
			}
			changedNodes.length = 0;
		}

		/** 找一个节点上的 React fiber(键名带随机后缀,只能前缀匹配)。 */
		function fiberOf(node) {
			if (node === null || typeof node !== 'object') return null;
			let keys;
			try { keys = Object.keys(node); } catch (error) { return null; }
			for (const key of keys) {
				if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return node[key];
			}
			return null;
		}

		/** 沿 fiber.return 上溯,取最近的具名函数组件(最深 = 离节点最近)。 */
		function componentOf(node) {
			let fiber;
			try { fiber = fiberOf(node); } catch (error) { return null; }
			let depth = 0;
			for (let current = fiber; current !== null && current !== undefined && depth < 64; current = current.return, depth += 1) {
				const type = current.type ?? current.elementType;
				if (typeof type !== 'function') continue;
				// 错误边界不是"谁在渲染":它有 componentDidCatch / getDerivedStateFromError,
				// 而且常常就套在真正的渲染组件外面(实测自测结果报成 HudBoundary 就是它挡的)。
				if (type.prototype !== undefined
					&& (typeof type.prototype.componentDidCatch === 'function' || typeof type.getDerivedStateFromError === 'function')) continue;
				const name = usableComponentName(type);
				if (name === null) continue;
				return name;
			}
			return null;
		}

		/**
		 * 从被改动节点**往子树里**找名字 —— 补"整棵子树一次性挂载"这一个空档。
		 *
		 * 实测场景:切到 dsh-context 的「上下文」视图时,React 把新视图整棵挂进宿主容器,
		 * 观察器只看到"容器变了",往祖先方向找只能得到宿主容器(DefaultConversationViews)。
		 * 真正的插件组件在子树里 —— 优先看 **alternate === null** 的孩子(React 用这个标记
		 * "这一次新挂载的子树"),没有就退化为有界广度优先。
		 */
		function descendantComponentOf(node) {
			const fiber = fiberOf(node);
			if (fiber === null) return null;
			const fresh = [];
			const all = [];
			for (let child = fiber.child; child !== null && child !== undefined; child = child.sibling) {
				all.push(child);
				if (child.alternate === null || child.alternate === undefined) fresh.push(child);
			}
			const roots = fresh.length > 0 ? fresh : all;
			const queue = roots.slice();
			let visited = 0;
			while (queue.length > 0 && visited < DESCEND_MAX) {
				const current = queue.shift();
				if (current === null || current === undefined) continue;
				visited += 1;
				const name = usableComponentName(current.type ?? current.elementType);
				if (name !== null) return name;
				if (current.child !== null && current.child !== undefined) queue.push(current.child);
				if (current.sibling !== null && current.sibling !== undefined) queue.push(current.sibling);
			}
			return null;
		}

		/** 被改动节点的子树里的组件名(入口扫描有上界,理由同 fiberOwner)。 */
		function subtreeOwner() {
			const now = performance.now();
			trimChangedNodes(now);
			let scanned = 0;
			for (let i = changedNodes.length - 1; i >= 0 && scanned < 8; i -= 1, scanned += 1) {
				const name = descendantComponentOf(changedNodes[i].node);
				if (name !== null) return name;
			}
			return null;
		}

		/** 最近 2 秒被改动过的节点里,能给出组件名的那个(相当于"这次渲染是谁"). */
		const FIBER_SCAN_MAX = 64;   // 每次 longtask 最多试 64 个入口:够用,且不会变成新的长任务
		const DESCEND_MAX = 200;     // 往子树里找时最多访问 200 个 fiber
		/** 名字是否够格当归属:具名函数组件、非 React 内建、非宿主外壳、非压缩名。 */
		function usableComponentName(type) {
			if (typeof type !== 'function') return null;
			const name = type.displayName ?? type.name;
			if (typeof name !== 'string' || name === '' || REACT_INTERNAL.has(name) || looksLikeInfrastructure(name)) return null;
			if (/^[A-Za-z]{1,2}\d{0,3}$/.test(name)) return null;
			// 打包器生成的 `$` 开头名字对读的人零信息,一律挡掉(实测生产构建里 `$c` / `$w`
			// 会混进"独立包名/组件名"的读数,而且看着像真名字,比匿名更误导)。
			// 括号形态 `(Name)` **不在这里处理**:它是 DOM 写入表那个"组件兜底桶"的显示标记,
			// 由渲染层加上去,不会作为 type 回到这个函数(这个函数的入参只有 React 的 type)。
			// ⚠️ 曾经写过"括号名更早被 looksLikeInfrastructure 挡掉" —— **那是错的**:
			// `looksLikeInfrastructure('(ChatView)')` 实测为 false(两条正则都不匹配它)。
			if (name.startsWith('$')) return null;
			return name;
		}

		function fiberOwner() {
			const now = performance.now();
			trimChangedNodes(now);
			let scanned = 0;
			for (let i = changedNodes.length - 1; i >= 0 && scanned < FIBER_SCAN_MAX; i -= 1, scanned += 1) {
				const name = componentOf(changedNodes[i].node);
				if (name !== null) return name;
			}
			return null;
		}

		// ───────────────────────────────── 状态 ─────────────────────────────────
		const state = {
			on: false,
			want: true,
			collapsed: false,
			since: Date.now(),
			root: null,              // HUD 根元素:DOM 统计里排除它
			fps: 0,
			windowStart: 0,
			windowFrames: 0,
			lastFrameAt: 0,
			worstFrameMs: 0,
			frameWorst: 0,
			busyMs: 0,              // 当前帧间隔内,插桩回调花掉的时间
			attributedMs: 0,        // 当前 1 秒窗口内,插桩回调总耗时
			attributedPerSec: 0,
			unattrSum: 0,           // 帧间隔里没被插桩解释掉的部分(样式/绘制/vsync 等待)
			unattrCount: 0,
			unattrWorst: 0,
			unattrAvg: 0,
			unattrPeak: 0,
			fpsLoop: 0,
			sampleTimer: 0,
			domTimer: 0,
			flushTimer: 0,
			linkTimer: 0,
			loadTimer: 0,
			linkText: '',
			stressNodes: 0,
			ltObserver: null,
			longTasks: [],           // { t, at, ms, owner }
			ltTotal: 0,              // 观察到的 longtask 条数
			ltNames: new Map(),      // 归属名字的累计计数(与 ltTotal 同窗口,不受 200 条明细上限影响)
			ltLegs: { fiber: 0, subtree: 0, dom: 0, owner: 0, none: 0 },   // 四条腿的累计命中数
			ltBlamed: 0,             // 其中成功指认出"谁干的"的条数
			ltThisSecond: 0,
			ltPerSec: 0,             // 上一秒的 longtask 条数(写进每秒采样)
			plugins: new Map(),      // id -> { count, ms, cps, msps, cpsPeak, ... }
			stack: [],               // 正在执行的回调 { owner, from, to }
			recent: [],              // 最近完成的回调,给 longtask 找元凶
			dom: { total: 0, series: [] },
			targets: new Map(),      // 容器 id -> { nodes, series }
			domWrites: new Map(),    // 插件 id -> { count(采样估算), ops }
			mutations: 0,            // DOM 写入总次数(精确)
			mutSeq: 0,
			heap: null,              // usedJSHeapSize,仅 Chrome 有
			heapSeries: [],
			lastTick: 0,
			// A 精确归因
			precise: false,
			deep: false,           // 深录:装插桩 + 精确归因;默认关(守夜/现场都不装)
			selfRing: [],          // 最近 SELF_RING 次自身 rAF 回调耗时(A1 自证开销)
			selfAt: 0,
			selfCount: 0,
			selfMax: 0,
			bundleKeys: new Set(),   // 见过的多包 URL
			// B fiber
			idleBaseline: null,
			streaming: false,
			idleSince: 0,
			baselineAt: 0,
			baselineRunning: false,
			baselineMs: null,        // 覆盖空闲基线窗口长度(默认 BASELINE_MS),自测用
			errors: [],              // 面板自己捕获的渲染错误(导出件里能读到)
			// 分组折叠:常显只有"现在顺不顺 + 谁的锅",过程/取证/工具默认收起(头部带摘要)
			groups: { detail: false, dom: false, host: false, tools: false },
			stress: null,            // 最近一次自测 { at, nodes, burnMs, sync, commitMs }
			stressBurn: 0,           // 自测渲染时显式燃烧的毫秒数
			// G 守夜层:默认常开,不包装任何原型;开关跟着总开关走
			watch: {
				on: false,
				loaf: [],                // 最近的 LoAF 摘要(时间升序)
				loafObserver: null,
				pickT: null,             // 用户用 ◀ ▶ 选中的那一帧的 t(null = 自动跟着最差那条)
				loafState: 'not-started',   // not-started / on / stopped / unsupported:… / error:…
				incidents: [],           // 最差 N 次(severity 降序,取用按索引 0 最差)
				pending: null,           // 正在等后摇的那一次
				pendingTimer: 0,
				seq: 0,
				captured: 0,             // 一共捕获过几次
				coalesced: 0,            // 被并进 pending 的触发次数(同一串卡顿算一次)
				dropped: 0,              // 抓到了、但没比已留存的更差,于是丢掉的次数
				trimmedByBytes: 0,       // 因为超过 WATCH_PERSIST_MAX_BYTES 被裁掉的条数(内存与落盘保持一致)
				deduped: 0,              // 同一个 id 被存过多次时,读回时去掉的条数
				restored: 0,             // 这次启动从落盘里读回了几条
				// A4:交互延迟(event / element timing)。只进导出件,面板不显示
				eventObserver: null,
				eventState: 'not-started',   // not-started / on / stopped / unsupported:… / error:…
				eventSupported: [],          // 浏览器实际支持的 entryType(照实记,不假设)
				interactions: [],            // 最近的交互计时(升序)
				eventCount: 0,
				elementCount: 0,
				persistError: null,      // 落盘失败的原因(失败就照实说,不假装存下来了)
				coveredUntil: 0,         // 最近一份事故窗口的结束时刻(perf ms):这段不再另立事故
			},
			requestRender: null,     // 面板挂载时注册:用户动作要立刻重渲染,不能等 0.5 秒的定时器
			displayKey: '',          // 面板显示值的指纹:没变就跳过这次 tick 的渲染
			marks: [],
			markDraft: '',
			// D 宿主/链路
			host: null,
			hostAt: 0,
			hostError: null,
			hostEvents: null,        // 宿主 session/event 派发计时回执 {installed, reason, stats}
			hostWatchAsked: false,
			hostWatchOff: false,
			link: [],                // { t, kind, rtt, kbps?, error? }
			loadState: 'pending',    // pending | ok | failed:吞吐那一格现在是哪种状态
			loadKbps: null,          // 吞吐数值(KB/s),显示时 >=1024 折成 MB/s
			linkAt: 0,
			loadAt: 0,
		};
		const ring = [];
		let dirty = false;

		// 容器:都用宿主自己的稳定钩子,不用哈希类名。
		const TARGETS = [
			{
				id: 'sessions',
				label: () => translate('sessions'),
				find: () => { const row = document.querySelector('[data-row-key]'); return row === null ? null : row.parentElement; },
			},
			{
				id: 'messages',
				label: () => translate('messages'),
				find: () => document.querySelector('[data-conversation-content]') ?? document.querySelector('[data-chat-flow]'),
			},
		];

		// ───────────────────────── 插桩:调度点抓栈 + 回调计时 ─────────────────────────
		/** 把回调包成"记归属 + 记同步耗时"的版本;arguments 原样透传(rAF 的时间戳等)。 */
		function measure(owner, callback) {
			return function measured() {
				const from = performance.now();
				// to 先等于 from(标记"仍在执行");收尾时补齐。执行中的回调是找元凶的第一手证据。
				const frame = { owner, from, to: from };
				state.stack.push(frame);
				try {
					return callback.apply(this, arguments);
				} finally {
					const to = performance.now();
					frame.to = to;
					const at = state.stack.lastIndexOf(frame);
					if (at !== -1) state.stack.splice(at, 1);
					let entry = state.plugins.get(owner);
					if (entry === undefined) {
						entry = { count: 0, ms: 0 };
						state.plugins.set(owner, entry);
					}
					entry.count += 1;
					entry.ms += to - from;
					state.busyMs += to - from;
					state.attributedMs += to - from;
					state.recent.push(frame);
					if (state.recent.length > RECENT_MAX) state.recent.shift();
				}
			};
		}

		/** 包一层调度函数:在调度点抓栈,归属到"发起调度"的那个插件。 */
		function scheduleWrapper(native) {
			function wrapped(...args) {
				const callback = args[0];
				if (state.on === false || typeof callback !== 'function') return native(...args);
				const owner = ownerFromStack(wrapped);
				// null = 宿主内联/其他运行时;PKG = 本 HUD 自己(不算进自己的面板)。
				if (owner === null || owner === PKG) return native(...args);
				args[0] = measure(owner, callback);
				return native(...args);
			}
			return wrapped;
		}

		const wrappers = {
			timeout: scheduleWrapper(natives.setTimeout),
			interval: scheduleWrapper(natives.setInterval),
			raf: scheduleWrapper(natives.requestAnimationFrame),
		};

		// ─────────────────── DOM 写入归因:谁在疯狂加节点 ───────────────────
		// 只包三个真正的"写"入口:appendChild / insertBefore / setAttribute。
		// 每一次都精确计数;每 MUT_SAMPLE(10)次抓一次栈定归属,命中者按采样步长
		// 折算 —— 所以面板/JSON 里带 ≈ 的数字是统计估计,不是精确值。
		const mutNatives = {
			appendChild: Node.prototype.appendChild,
			insertBefore: Node.prototype.insertBefore,
			setAttribute: Element.prototype.setAttribute,
		};

		function mutationWrapper(native) {
			function wrapped() {
				if (state.on) {
					state.mutations += 1;
					state.mutSeq = (state.mutSeq + 1) % MUT_SAMPLE;
					if (state.mutSeq === 0) {
						const owner = ownerFromStack(wrapped);
						// this = 接收新子节点的父节点,它的 fiber 上方最近的具名组件就是"谁在渲染"。
						const component = componentOf(this);
						const at = performance.now();
						if (owner === PKG) {
							// 本 HUD 自己的写入不记账:否则 PerfHud 会把自己顶成 DOM 写入第一名
							// (实测真的发生过,面板摘要里出现了 (PerfHud))。
						} else if (owner !== null) {
							recentWrites.push({ at, owner, component });
							if (recentWrites.length > RECENT_WRITES_MAX) recentWrites.shift();
							let entry = state.domWrites.get(owner);
							if (entry === undefined) {
								entry = { count: 0, ops: 0, components: new Map() };
								state.domWrites.set(owner, entry);
							}
							entry.count += MUT_SAMPLE;
							entry.ops += 1;
							if (component !== null) entry.components.set(component, (entry.components.get(component) ?? 0) + MUT_SAMPLE);
						} else if (component !== null) {
							// 拿不到插件(宿主内联脚本/React 自己的提交)时,组件名仍然是有效线索。
							const key = `(${component})`;
							let entry = state.domWrites.get(key);
							if (entry === undefined) {
								entry = { count: 0, ops: 0, components: new Map() };
								state.domWrites.set(key, entry);
							}
							entry.count += MUT_SAMPLE;
							entry.ops += 1;
							entry.components.set(component, (entry.components.get(component) ?? 0) + MUT_SAMPLE);
						}
					}
				}
				return native.apply(this, arguments);
			}
			return wrapped;
		}

		const mutWrappers = {
			appendChild: mutationWrapper(mutNatives.appendChild),
			insertBefore: mutationWrapper(mutNatives.insertBefore),
			setAttribute: mutationWrapper(mutNatives.setAttribute),
		};

		// ───────────── G. 守夜层:帧级环形缓冲 + LoAF(默认常开,不插桩)─────────────
		// 它解决的问题只有一个:卡顿发生时你不在看面板,事后还要能把它捞出来。
		// 所以这一层**不包装任何原型**(不碰 setTimeout/rAF/DOM 方法),只用本来就在跑的
		// rAF 循环 + 一个 PerformanceObserver —— 代价接近零,因此可以默认开着。
		// 代价是归因比四条腿弱:这里没有 fiber / 子树 / 调度点包名;它靠 LoAF 给的脚本 URL
		// 与 forcedStyleAndLayoutDuration,加上既有 longtask 表落在窗口内的明细。
		// 它**不做推断** —— 只把当时的东西原样装进事故包,结论留给读它的人(或 agent)。

		/** 帧级环形缓冲:每帧一条,满了覆盖最早的。12000 条 ≈ 60fps 下 3.3 分钟。 */
		const frameRing = {
			at: new Float64Array(WATCH_FRAMES),   // perf 毫秒用 float64:float32 在几小时后会丢到 ~1ms
			ms: new Float32Array(WATCH_FRAMES),
			gap: new Uint8Array(WATCH_FRAMES),    // 1 = rAF 被挂起(页面隐藏),不是卡顿
			head: 0,
			size: 0,
			total: 0,
			push(at, ms, isGap) {
				this.at[this.head] = at;
				this.ms[this.head] = ms;
				this.gap[this.head] = isGap ? 1 : 0;
				this.head = (this.head + 1) % WATCH_FRAMES;
				if (this.size < WATCH_FRAMES) this.size += 1;
				this.total += 1;
			},
			/** 按时间升序取 [from, to] 区间(两端含)。环形里天然升序,所以过了 to 就可以停。 */
			slice(from, to) {
				const out = [];
				const first = (this.head - this.size + WATCH_FRAMES) % WATCH_FRAMES;
				for (let i = 0; i < this.size; i += 1) {
					const index = (first + i) % WATCH_FRAMES;
					const at = this.at[index];
					if (at < from) continue;
					if (at > to) break;
					out.push({ t: round1(at), ms: round1(this.ms[index]), gap: this.gap[index] === 1 });
				}
				return out;
			},
			reset() { this.head = 0; this.size = 0; this.total = 0; },
			/**
			 * 整个环的分布 = 会话基线。没有它,"最差帧 325ms" 判不出是"这一段变坏了"还是
			 * "这台机器/这个浏览器一直这样"(实测 headless 全程 16fps,单看绝对值会误判)。
			 */
			stats(excludeFrom, excludeTo) {
				// 可以排除一个区间:_基线必须把这次事故自己排除掉_,否则"比会话最差还差"
				// 永远不可能成立(基线里就含着它),而那正是读者要问的问题。
				const live = [];
				for (let i = 0; i < this.size; i += 1) {
					const index = (this.head - this.size + i + WATCH_FRAMES) % WATCH_FRAMES;
					if (this.gap[index] === 1) continue;
					if (typeof excludeFrom === 'number' && this.at[index] >= excludeFrom && this.at[index] <= excludeTo) continue;
					live.push(this.ms[index]);
				}
				if (live.length === 0) return null;
				live.sort((a, b) => a - b);
				const pick = (p) => round1(live[Math.min(live.length - 1, Math.floor(p * live.length))]);
				// 跨度按"剩下的帧"两端算:排除掉中间一段之后,fps 不该把那段时长算进去
				let oldest = Infinity;
				let newest = -Infinity;
				for (let i = 0; i < this.size; i += 1) {
					const index = (this.head - this.size + i + WATCH_FRAMES) % WATCH_FRAMES;
					if (this.gap[index] === 1) continue;
					if (typeof excludeFrom === 'number' && this.at[index] >= excludeFrom && this.at[index] <= excludeTo) continue;
					if (this.at[index] < oldest) oldest = this.at[index];
					if (this.at[index] > newest) newest = this.at[index];
				}
				const span = round1(newest - oldest);
				// fps 的分母必须是"真的在跑的时间"(Σ 帧间隔),不能用首尾跨度:中间夹一次
				// 22.7s 的挂起会把 60fps 算成 43fps(实测踩过,读的人会以为一直在掉帧)。
				let busy = 0;
				for (const value of live) busy += value;
				return {
					frames: live.length,
					spanMs: span,
					busyMs: round1(busy),
					fps: busy <= 0 ? null : round1((live.length * 1000) / busy),
					p50: pick(0.5),
					p90: pick(0.9),
					p99: pick(0.99),
					worstMs: round1(live[live.length - 1]),
				};
			},
		};

		/**
		 * 触发判据:低于 WATCH_TRIGGER_MS 的帧不配叫卡顿。纯函数,便于单测,
		 * 也便于回答"为什么这次没抓到"。返回严重度,不触发返回 null。
		 */
		function watchTrigger(ms) {
			return typeof ms === 'number' && ms >= WATCH_TRIGGER_MS ? round1(ms) : null;
		}

		/** 本页性能时钟的原点(墙上时间毫秒)。跨会话读事故时,perf 毫秒要靠它才能对齐。 */
		function perfOrigin() {
			return typeof performance.timeOrigin === 'number' && performance.timeOrigin > 0
				? performance.timeOrigin
				: Date.now() - performance.now();
		}

		/** perf 时间 → 墙上时间。 */
		function wallClock(perfMs) {
			return new Date(perfOrigin() + perfMs).toISOString();
		}

		/** 一条 LoAF 里最多记 WATCH_SCRIPT_MAX 个脚本:只用于回答"谁",不做统计。 */
		function loafScripts(entry) {
			const out = [];
			try {
				const scripts = Array.isArray(entry.scripts) ? entry.scripts : [];
				for (const script of scripts) {
					if (out.length >= WATCH_SCRIPT_MAX) break;
					const scriptUrl = typeof script.sourceURL === 'string' ? script.sourceURL : null;
					if (scriptUrl !== null && state.precise === true && scriptUrl.indexOf(',') !== -1) {
						// 多包:后台把脚本文本与分段表准备好。这两个请求都是浏览器内存缓存命中,
						// 但走的是异步,所以只预取、不在这里等。
						ensureScriptLines(scriptUrl);
						const owner = ownerOfUrl(scriptUrl);
						if (owner !== null && owner.startsWith(BUNDLE_PREFIX)) bundleMap(owner);
					}
					out.push({
						url: scriptUrl,
						fn: typeof script.sourceFunctionName === 'string' && script.sourceFunctionName !== '' ? script.sourceFunctionName : null,
						invoker: typeof script.invoker === 'string' ? script.invoker.slice(0, 80) : null,
						invokerType: script.invokerType ?? null,
						charPos: typeof script.sourceCharPosition === 'number' ? script.sourceCharPosition : null,
						ms: round1(script.duration ?? 0),
						forcedMs: round1(script.forcedStyleAndLayoutDuration ?? 0),
						pauseMs: round1(script.pauseDuration ?? 0),
					});
				}
			} catch (error) { /* 条目形状变了:宁可少记,不要抛 */ }
			return out;
		}

		/** 收一条长动画帧。触发按 blockingDuration —— 它才是"这一帧挡了多久",纯渲染不算卡。 */
		function watchLoaf(entry) {
			const watch = state.watch;
			const row = {
				t: round1(entry.startTime),
				dur: round1(entry.duration),
				blocking: round1(entry.blockingDuration ?? 0),
				renderStart: round1(entry.renderStart ?? 0),
				styleAndLayoutStart: round1(entry.styleAndLayoutStart ?? 0),
				scripts: loafScripts(entry),
			};
			watch.loaf.push(row);
			if (watch.loaf.length > WATCH_LOAF_MAX) watch.loaf.splice(0, watch.loaf.length - WATCH_LOAF_MAX);
			const severity = watchTrigger(row.blocking);
			if (severity !== null) triggerCapture('loaf', entry.startTime, severity);
		}

		/** 装上 LoAF 观察器(可还原:stop() 里 disconnect)。返回状态串,照实写进导出件。 */
		function startLoaf() {
			const watch = state.watch;
			if (watch.loafObserver !== null) return watch.loafState;
			const Observer = W.PerformanceObserver;
			if (typeof Observer !== 'function') return (watch.loafState = 'unsupported:no-PerformanceObserver');
			const supported = Observer.supportedEntryTypes;
			if (Array.isArray(supported) && supported.indexOf('long-animation-frame') === -1) {
				return (watch.loafState = 'unsupported:no-long-animation-frame');
			}
			try {
				const observer = new Observer((list) => {
					for (const entry of list.getEntries()) watchLoaf(entry);
				});
				// 不带 buffered:每次重新挂观察器(disable→enable、HMR 重载)都会把最近 200 条重放
				// 一遍,同一个 startTime 于是被重新触发 —— 实测同一次卡顿裂成了 i2 / i29 / i31
				// 三条不同 id 的事故(时间戳一模一样)。挂上之前的帧我们本来也没采,不需要它。
				observer.observe({ type: 'long-animation-frame' });
				watch.loafObserver = observer;
				watch.loafState = 'on';
			} catch (error) {
				watch.loafState = `error:${error instanceof Error ? error.message : String(error)}`;
			}
			return watch.loafState;
		}

		/**
		 * A4(页面内那一半):交互延迟。
		 *
		 * `event` timing 是页面内**唯一**能拿到"这一下点了多久才反应"的 API:它给端到端时长
		 * (`duration`)与 `processingStart/End`,所以能说清"有多少是排在主线程后面等出来的"。
		 * ⚠️ **不承诺帧内拆分** —— 输入延迟 / 处理 / 呈现这三段的进一步拆分页面内没有 API
		 * (要拆只能看 DevTools 的 Interactions 轨道,已写进 missing)。
		 * `element` timing 只观察带 `elementtiming` 属性的元素,DSH 的 DOM 上没有这个属性,
		 * 所以这一路**大概率恒为 0** —— 照实记 0 并写进导出件,不假装采到了。
		 */
		function watchInteraction(entry) {
			const watch = state.watch;
			const isElement = entry.entryType === 'element';
			if (isElement) watch.elementCount += 1;
			else watch.eventCount += 1;
			const start = entry.startTime ?? 0;
			const processingStart = entry.processingStart ?? start;
			const processingEnd = entry.processingEnd ?? processingStart;
			watch.interactions.push({
				type: entry.entryType,
				// 事件名(click / keydown…)或元素选择器
				name: String(isElement ? (entry.element ?? entry.name ?? '?') : (entry.name ?? '?')).slice(0, 60),
				at: round1(start),
				ms: round1(entry.duration ?? 0),      // 端到端(到下一次渲染更新为止)
				// 下面两个是推导值,但读文件的人第一眼要的就是它们:多少是排队等出来的、多少是处理
				waitMs: round1(processingStart - start),          // 输入延迟:事件发生 → 处理器真正开始
				handlerMs: round1(processingEnd - processingStart),   // 处理器本身
				processingStart: round1(entry.processingStart ?? 0),
				processingEnd: round1(entry.processingEnd ?? 0),
				interactionId: typeof entry.interactionId === 'number' ? entry.interactionId : null,
				// interactionId > 0 才是"一次交互"里的那一批;0 的是 pointerover 这类被动事件
				isInteraction: typeof entry.interactionId === 'number' && entry.interactionId > 0,
				renderTime: isElement ? round1(entry.renderTime ?? 0) : undefined,
			});
			if (watch.interactions.length > WATCH_EVENT_MAX) watch.interactions.splice(0, watch.interactions.length - WATCH_EVENT_MAX);
		}

		/** 装上交互计时观察器(可还原:stop() 里 disconnect)。返回状态串,照实写进导出件。 */
		function startInteractions() {
			const watch = state.watch;
			if (watch.eventObserver !== null) return watch.eventState;
			const Observer = W.PerformanceObserver;
			if (typeof Observer !== 'function') return (watch.eventState = 'unsupported:no-PerformanceObserver');
			const supported = Array.isArray(Observer.supportedEntryTypes) ? Observer.supportedEntryTypes : [];
			watch.eventSupported = supported.filter((type) => type === 'event' || type === 'element');
			if (watch.eventSupported.length === 0) return (watch.eventState = 'unsupported:no-event-timing');
			try {
				const observer = new Observer((list) => {
					for (const entry of list.getEntries()) watchInteraction(entry);
				});
				// 也不带 buffered:挂上之前的事件不属于这段时间的交互(同 LoAF 那条的理由)
				for (const type of watch.eventSupported) {
					if (type === 'event') observer.observe({ type: 'event', durationThreshold: WATCH_EVENT_MS });
					else observer.observe({ type: 'element' });
				}
				watch.eventObserver = observer;
				watch.eventState = 'on';
			} catch (error) {
				watch.eventState = `error:${error instanceof Error ? error.message : String(error)}`;
			}
			return watch.eventState;
		}

		/**
		 * 每帧一次(从 FPS 循环里调)。
		 * 帧间隔超过 WATCH_GAP_MS 说明 rAF 被挂起(标签页隐藏/系统休眠):那是间隙,
		 * 既不算卡顿也不触发 —— 否则每次切回标签页都会"抓到"一次几百秒的假事故。
		 */
		function watchFrame(at, ms, isGap) {
			if (state.watch.on === false) return;
			frameRing.push(at, ms, isGap);
			if (isGap) return;
			const severity = watchTrigger(ms);
			if (severity !== null) triggerCapture('frame', at, severity);
		}

		/**
		 * 起一次捕获。同时只留一个 pending:一次卡顿通常是一串,归并成一条比抓成一堆碎
		 * 事件有用(被归并的次数记进 coalesced,不假装没发生)。
		 */
		function triggerCapture(cause, at, severity, note) {
			const watch = state.watch;
			if (watch.on === false) return null;
			if (watch.pending !== null) { watch.coalesced += 1; return null; }
			// 这个时刻已经被上一份事故的窗口覆盖了(证据就在那份包里),别再另立一份 ——
			// 实测过一次卡顿裂成两份(第二份其实只是又碰了一下同一段窗口)。
			// 手动标记例外:那是明确意图,哪怕落在窗口里也收。
			if (cause !== 'manual' && watch.coveredUntil > 0 && at <= watch.coveredUntil) {
				watch.coalesced += 1;
				return null;
			}
			watch.pending = { cause, at, severity: round1(severity), note: note ?? null, until: at + WATCH_POST_MS };
			const delay = Math.max(0, watch.pending.until - performance.now());
			if (delay <= 0) return settleCapture();
			watch.pendingTimer = natives.setTimeout(settleCapture, Math.ceil(delay));
			return null;
		}

		/**
		 * 留存策略:两档并集。
		 *   ① 全局最差 WATCH_INCIDENT_MAX 条;
		 *   ② 每天最差 1 条,最多最近 WATCH_DAILY_DAYS 天。
		 * 只有 ① 时,短时间里连抓 10 次就把更早的整天挤掉了;② 保证"每天至少留一条证据"。
		 * "抓到了但没留存"和"没抓到"是两件事,所以 dropped 单独计数,不混进 captured。
		 */
		function keepIncident(incident) {
			const watch = state.watch;
			const list = watch.incidents;
			const previous = list.slice();
			const kept = pruneIncidents(previous.concat(incident));
			const survived = kept.indexOf(incident) !== -1;
			const displaced = previous.some((row) => kept.indexOf(row) === -1);
			list.length = 0;
			for (const row of kept) list.push(row);
			if (survived === false) { watch.dropped += 1; return 'dropped'; }
			return displaced ? 'replaced' : 'kept';
		}

		/** 事故发生在哪一天(本地日期)—— 只用于"每天最差一条"那个档位;取不到时间算 null。 */
		function dayKeyOf(row) {
			const at = Date.parse(row === null || row === undefined ? '' : row.at);
			if (Number.isFinite(at) === false) return null;
			const d = new Date(at);
			// 补零:日期键要按字符串排序取"最近 N 天",'2026-10-8' > '2026-10-10' 是错的
			const p = (n) => String(n).padStart(2, '0');
			return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
		}

		/**
		 * 按两档策略裁一次,并给活下来的每条写上 `tier`(它是靠哪一档留下的)。
		 * 出入都按**严重度降序** —— 落盘的字节裁切(`list.pop()` 丢最弱的)依赖这个不变量。
		 */
		function pruneIncidents(list) {
			const sorted = list.slice().sort((a, b) => b.severity - a.severity);
			const worst = sorted.slice(0, WATCH_INCIDENT_MAX);
			const bestOfDay = new Map();
			for (const row of sorted) {
				const key = row.day ?? dayKeyOf(row);
				row.day = key;
				// 降序遍历:每天碰到的第一条就是当天最差
				if (key === null || bestOfDay.has(key)) continue;
				bestOfDay.set(key, row);
			}
			const days = [...bestOfDay.keys()].sort().slice(-WATCH_DAILY_DAYS);   // 最近的 N 天
			const kept = new Set(worst);
			for (const key of days) kept.add(bestOfDay.get(key));
			const daily = new Set(days.map((key) => bestOfDay.get(key)));
			const out = sorted.filter((row) => kept.has(row));
			for (const row of out) {
				const inWorst = worst.indexOf(row) !== -1;
				const inDaily = daily.has(row);
				row.tier = inWorst && inDaily ? 'both' : (inWorst ? 'worst' : 'daily');
			}
			return out;
		}

		/**
		 * 把一个事件窗口切成事故包:前摇 WATCH_PRE_MS + 后摇 WATCH_POST_MS,原样带上帧序列、
		 * LoAF 条目、窗口内的 longtask 明细。严重度取"触发时的值"与"窗口里最差帧"的较大者 ——
		 * 手动标记传进来的 0 因此不会因为"不够差"而被留存策略丢掉。
		 */
		function assembleIncident(pending) {
			const from = pending.at - WATCH_PRE_MS;
			const to = pending.until;
			const frames = frameRing.slice(from, to);
			const rows = state.watch.loaf.filter((row) => row.t >= from && row.t <= to);
			// URL 抽表:实测一份事故里同一个 combo URL 会被写 27 遍 —— 116.6KB 里有 75.4KB 是
			// 那个 2.9KB 的 URL 重复(导出的缩进版 138.6KB 里更糟)。脚本只留下标之后:
			// 紧凑 29.6KB / 导出 51.5KB / 512KB 能放 17 条(原来 4 条)。信息一点没少。
			// u = -1 表示这条脚本没有 URL。
			const urls = [];
			const urlIndex = (url) => {
				if (typeof url !== 'string' || url === '') return -1;
				const found = urls.indexOf(url);
				if (found !== -1) return found;
				urls.push(url);
				return urls.length - 1;
			};
			const loaf = rows.map((row) => ({
				t: row.t,
				dur: row.dur,
				blocking: row.blocking,
				renderStart: row.renderStart,
				styleAndLayoutStart: row.styleAndLayoutStart,
				scripts: row.scripts.map((script) => ({
					u: urlIndex(script.url),
					fn: script.fn,
					invoker: script.invoker,
					invokerType: script.invokerType,
					charPos: script.charPos,
					ms: script.ms,
					forcedMs: script.forcedMs,
					pauseMs: script.pauseMs,
				})),
			}));
			const longTasks = state.longTasks.filter((row) => row.at >= from && row.at <= to);
			// A4:窗口内的交互延迟(端到端时长;页面内没有帧内拆分,见 watchInteraction 的说明)
			const interactions = (state.watch.interactions ?? []).filter((row) => row.at >= from && row.at <= to);
			let worst = null;
			let live = 0;
			let over50 = 0;
			let over100 = 0;
			let gaps = 0;
			const durations = [];
			for (const row of frames) {
				if (row.gap) { gaps += 1; continue; }
				live += 1;
				durations.push(row.ms);
				if (row.ms >= 50) over50 += 1;
				if (row.ms >= 100) over100 += 1;
				if (worst === null || row.ms > worst.ms) worst = row;
			}
			durations.sort((a, b) => a - b);
			const quantile = (p) => (durations.length === 0 ? null : round1(durations[Math.min(durations.length - 1, Math.floor(p * durations.length))]));
			const pick50 = quantile(0.5);
			const pick90 = quantile(0.9);
			const pick99 = quantile(0.99);
			// 每条脚本尽力定包名(拿不到就写清 via),再按包汇总一次 ——
			// 「是谁」在合并批里原来只能给到那个 58 包的 URL,等于没有答案。
			for (const row of loaf) {
				for (const script of row.scripts) {
					const resolved = packageOfScript(script.u >= 0 ? urls[script.u] : '', script.charPos);
					script.pkg = resolved.pkg;
					script.pkgVia = resolved.via;
				}
			}
			const scripts = [];
			for (const row of loaf) for (const script of row.scripts) scripts.push({ at: row.t, ...script });
			scripts.sort((a, b) => b.ms - a.ms);
			const byPkg = new Map();
			let pkgResolved = 0;
			for (const script of scripts) {
				if (script.pkg === null) continue;
				pkgResolved += 1;
				const row = byPkg.get(script.pkg);
				if (row === undefined) byPkg.set(script.pkg, { pkg: script.pkg, ms: script.ms, count: 1 });
				else { row.ms = round1(row.ms + script.ms); row.count += 1; }
			}
			const packages = [...byPkg.values()].sort((a, b) => b.ms - a.ms);
			const pkgVia = {};
			for (const script of scripts) {
				const key = script.pkgVia === null || script.pkgVia === undefined ? 'unknown' : script.pkgVia;
				pkgVia[key] = (pkgVia[key] ?? 0) + 1;
			}
			let blocking = 0;
			for (const row of loaf) blocking += row.blocking;
			// 最差那一帧有没有 JS 解释?用 longtask / LoAF 与它的区间是否重叠判。
			// 再往前一步:如果它既没有 JS 证据、前后又都是健康帧,那更可能是**浏览器把 rAF
			// 节流/挂起了一次**(Windows 遮挡、省电),不是页面真的忙了这么久 —— 实测有一帧
			// 983.7ms,前后都是 16.7ms(正好 60fps),而 983.7 恰好卡在 1 秒间隙线下面。
			let worstJs = 'none';
			let suspectedThrottle = false;
			let neighboursMs = null;
			if (worst !== null) {
				const start = worst.t - worst.ms;
				const end = worst.t;
				const hasJs = longTasks.some((row) => row.at < end && row.at + row.ms > start)
					|| loaf.some((row) => row.t < end && row.t + row.dur > start);
				worstJs = hasJs ? 'js' : 'none';
				const index = frames.indexOf(worst);
				const around = frames.slice(Math.max(0, index - 5), index).concat(frames.slice(index + 1, index + 6))
					.filter((row) => row.gap === false).map((row) => row.ms).sort((a, b) => a - b);
				neighboursMs = around.length === 0 ? null : round1(around[Math.floor(around.length / 2)]);
				suspectedThrottle = worst.ms >= 500 && hasJs === false && neighboursMs !== null && neighboursMs < WATCH_TRIGGER_MS;
			}
			return {
				id: `i${(state.watch.seq += 1)}`,
				cause: pending.cause,          // frame / loaf / manual
				note: pending.note,
				kept: null,                    // settleCapture 填 kept / replaced / dropped
				severity: round1(Math.max(pending.severity, worst === null ? 0 : worst.ms)),
				atPerfMs: round1(pending.at),
				at: wallClock(pending.at),
				window: {
					fromMs: round1(from), toMs: round1(to),
					preMs: WATCH_PRE_MS, postMs: WATCH_POST_MS,
					from: wallClock(from), to: wallClock(to),
				},
				summary: {
					worstFrameMs: worst === null ? null : worst.ms,
					worstFrameAt: worst === null ? null : wallClock(worst.t),
					frames: live,
					framesOver50Ms: over50,
					framesOver100Ms: over100,
					hiddenGaps: gaps,
					loafEntries: loaf.length,
					blockingMs: round1(blocking),
					pkgCoverage: { resolved: pkgResolved, total: scripts.length },   // 有名字的脚本占比
					pkgVia,                       // 每一条脚本"是怎么定名的"(url / section / not-plugin / …)
					longTasksInWindow: longTasks.length,
					interactionsInWindow: interactions.length,   // A4:窗口内的交互次数(≥100ms 的那些)
					topScripts: scripts.slice(0, 5).map((script) => ({
						at: script.at, u: script.u, ms: script.ms, fn: script.fn, invokerType: script.invokerType, charPos: script.charPos,
						pkg: script.pkg, pkgVia: script.pkgVia,
					})),
					// 窗口自己的分位:没有它,howToRead 里那句"拿 summary 和 baseline 比"在
					// 文件内根本没法执行(实测一位只读文件的读者就卡在这)
					p50: pick50,
					p90: pick90,
					p99: pick99,
					worstFrameJs: worstJs,                  // js = 有 longtask/LoAF 重叠;none = 没有任何 JS 解释
					worstFrameNeighboursMs: neighboursMs,   // 最差帧前后各 5 帧的中位(健康帧 ≈ 16.7ms)
					suspectedThrottle,                      // true = 更像 rAF 被节流/挂起,而不是页面真忙
					streaming: state.streaming,
					visibility: document.visibilityState,
				},
				urls,                          // 脚本 URL 表(scripts[].u 是它的下标)
				packages,                      // 按包汇总的脚本耗时(降序):「是谁」在这一层才有答案
				frames,
				loaf,
				longTasks,
				interactions,
				baseline: frameRing.stats(from, to),   // 排除本窗口之后的分布:含自己就永远"比不上"
				host: state.host === null || state.host === undefined ? null : {
					at: state.hostAt > 0 ? new Date(state.hostAt).toISOString() : null,
					// 快照年龄:这份宿主数据是事故时刻之前多少毫秒采到的(正 = 更早,负 = 事故之后才采到)。
					// 以前这里写的是"距现在多久",口径没定义,读的人只能猜。
					snapshotAgeMs: state.hostAt > 0 ? Math.round(perfOrigin() + pending.at - state.hostAt) : null,
					eventLoop: state.host.eventLoop ?? null,
				},
				env: {
					domNodes: state.dom.total,
					heapUsedBytes: state.heap,
					instrumented: state.on && state.deep === true,
					deep: state.deep === true,
					precise: state.precise,
					// 跨会话(落盘后重开页面)读这份事故时,perf 毫秒要靠它才能对齐墙上时间
					perfOrigin: new Date(perfOrigin()).toISOString(),
					// 渲染环境:判断"这段是坏还是这台机器一直这样"的另一个前提
					viewport: `${W.innerWidth}×${W.innerHeight}`,
				// 本地时区偏移(分钟,UTC+8 = 480)—— 只读文件的人靠它把 ISO 换成本地时间;
				// 注意 JS 的 getTimezoneOffset() 符号是反的
				utcOffsetMin: -new Date().getTimezoneOffset(),
					devicePixelRatio: W.devicePixelRatio,
					hardwareConcurrency: navigator.hardwareConcurrency ?? null,
					visibility: document.visibilityState,
				},
			};
		}

		/** 后摇到点:切片、计数、按策略留存。 */
		function settleCapture() {
			const watch = state.watch;
			if (watch.pendingTimer !== 0) { natives.clearTimeout(watch.pendingTimer); watch.pendingTimer = 0; }
			const pending = watch.pending;
			watch.pending = null;
			if (pending === null) return null;
			const incident = assembleIncident(pending);
			watch.captured += 1;
			incident.kept = keepIncident(incident);
			watch.coveredUntil = pending.until;   // 这段窗口已经有主了,见 triggerCapture 的去重
			saveIncidents();
			return incident;
		}

		/**
		 * 落盘:事故要能活过刷新 —— "等了很久才抓到"的东西丢了最肉疼。
		 * localStorage 有配额,所以三步兜底:超过字节上限就丢最弱的 → 写失败再把列表砍半重试 →
		 * 仍失败就把原因记进 persistError,并在 watch() 里照实说"这次没能落盘"。
		 */
		function saveIncidents() {
			const watch = state.watch;
			// 按触发时刻去重:同一 at(0.1ms 精度)就是同一次事件 —— 即使 id 不同也只留一条。
			// 这是兜底:buffered 重放那条根因已修,但读回来的旧数据里可能还带着重复。
			const seenAt = new Set();
			const list = [];
			for (const row of watch.incidents) {
				// 只有两个字段都在才谈得上"同一次事件";缺字段的一律不参与去重(不能把它们
				// 当成同一条而把真事故吃掉)。
				const key = typeof row.at === 'string' && typeof row.cause === 'string' ? `${row.at}|${row.cause}` : null;
				if (key !== null) {
					if (seenAt.has(key)) { watch.deduped += 1; continue; }
					seenAt.add(key);
				}
				list.push(row);
			}
			const afterDedupe = list.length;
			for (let attempt = 0; attempt < 3; attempt += 1) {
				let payload;
				try {
					payload = JSON.stringify({ v: 1, savedAt: Date.now(), incidents: list });
				} catch (error) {
					watch.persistError = `serialize:${error instanceof Error ? error.message : String(error)}`;
					return false;
				}
				if (payload.length > WATCH_PERSIST_MAX_BYTES && list.length > 1) {
					list.pop();   // 列表按严重度降序,去掉最弱的那条
					continue;
				}
				try {
					localStorage.setItem(LS_INCIDENTS, payload);
					watch.persistError = null;
					// 内存里也按同一份裁掉:"看到的"必须等于"刷新后还在的"。
					// 以前这里只裁落盘的那份,面板说"抓到 10 次"、刷新后可能只回来 7 条,对不上。
					// 两个计数分开:去重的算 deduped,字节装不下的才算 trimmedByBytes。
					if (watch.incidents.length !== list.length) {
						watch.incidents.length = 0;
						for (const row of list) watch.incidents.push(row);
					}
					watch.trimmedByBytes += Math.max(0, afterDedupe - list.length);
					return true;
				} catch (error) {
					watch.persistError = error instanceof Error ? error.message : String(error);
					if (list.length > 1) { list.length = Math.ceil(list.length / 2); continue; }
					return false;
				}
			}
			return false;
		}

		/** 读回落盘的事故。形状不对的条目直接丢(丢了不会静默:restored 会告诉你读回几条)。 */
		function restoreIncidents() {
			const watch = state.watch;
			let parsed = null;
			try { parsed = JSON.parse(localStorage.getItem(LS_INCIDENTS) ?? 'null'); } catch (error) { return; }
			if (parsed === null || Array.isArray(parsed.incidents) === false) return;
			const rows = [];
			for (const row of parsed.incidents) {
				if (row === null || typeof row !== 'object') continue;
				if (typeof row.id !== 'string' || typeof row.severity !== 'number') continue;
				if (Array.isArray(row.frames) === false || Array.isArray(row.loaf) === false) continue;
				row.restored = true;   // 跨会话的 perf 毫秒要靠 env.perfOrigin 对齐,标出来免得误读
				rows.push(row);
			}
			rows.sort((a, b) => b.severity - a.severity);
			// 同一个 id 只留一条:实测落盘里出现过同一条事故被存了三遍(占掉 3 个留存位),
			// 原因没复现出来(disable→enable 不会重复),所以这里按 id 兜住 —— 有牙齿的是断言。
			const seen = new Set();
			const unique = [];
			for (const row of rows) {
				const key = typeof row.at === 'string' && typeof row.cause === 'string' ? `${row.at}|${row.cause}` : null;
				if (key !== null) {
					if (seen.has(key)) { watch.deduped += 1; continue; }
					seen.add(key);
				}
				unique.push(row);
			}
			// 读回来也按同一份两档策略裁一遍:落盘那份是旧版本写的、或天数已经翻过去了,
			// 都可能比现在的上限多。裁不动也要保证"看到的 = 刷新后还在的"。
			watch.incidents = pruneIncidents(unique);
			watch.restored = watch.incidents.length;
			// 新事故的序号从读回来的最大 id 之后继续,否则新 id 会和旧的撞(旧包里的 i2 撞了三次)
			for (const row of watch.incidents) {
				const n = /^i(\d+)$/.exec(row.id);
				if (n !== null) watch.seq = Math.max(watch.seq, Number(n[1]));
			}
		}

		/**
		 * 手动标记"刚刚卡了一下":回退 WATCH_REACTION_MS(默认 3 秒,人的反应时间),
		 * 立刻切片(不等后摇)。note 原样进事故包,方便事后知道当时在干什么。
		 */
		function captureNow(note) {
			if (state.watch.on === false) return { ok: false, reason: 'not-recording(HUD 关闭时不记录)' };
			const incident = triggerCapture('manual', performance.now() - WATCH_REACTION_MS, 0, note ?? null);
			return incident === null ? { ok: false, reason: 'coalesced(已并进正在等的那一次)' } : { ok: true, incident };
		}

		/** 守夜层状态:装没装上、录了多少、抓到几次 —— 一律照实,不写"运行中"。 */
		function watchStatus() {
			const watch = state.watch;
			const oldest = frameRing.size === 0 ? 0 : frameRing.at[(frameRing.head - frameRing.size + WATCH_FRAMES) % WATCH_FRAMES];
			return {
				recording: watch.on,
				loaf: watch.loafState,
				// A4:交互延迟(event / element timing)。面板不显示,导出件里照实写状态与计数
				interactions: {
					state: watch.eventState,
					supported: watch.eventSupported,
					thresholdMs: WATCH_EVENT_MS,
					events: watch.eventCount,
					elements: watch.elementCount,
					kept: watch.interactions.length,
				},
				frameSamples: frameRing.size,
				frameBudget: WATCH_FRAMES,
				coveredMs: oldest === 0 ? 0 : round1(performance.now() - oldest),
				loafEntries: watch.loaf.length,
				pending: watch.pending === null ? null : { cause: watch.pending.cause, severity: watch.pending.severity },
				captured: watch.captured,
				coalesced: watch.coalesced,
				dropped: watch.dropped,
				restored: watch.restored,
				trimmedByBytes: watch.trimmedByBytes,
				deduped: watch.deduped,
				persistError: watch.persistError,
				kept: watch.incidents.map((row) => ({ id: row.id, severity: row.severity, cause: row.cause, at: row.at, note: row.note, tier: row.tier ?? null, day: row.day ?? null })),
				triggers: {
					frameMs: WATCH_TRIGGER_MS, gapMs: WATCH_GAP_MS,
					preMs: WATCH_PRE_MS, postMs: WATCH_POST_MS, keep: WATCH_INCIDENT_MAX,
					dailyDays: WATCH_DAILY_DAYS, keepMax: WATCH_KEEP_MAX,
					reactionMs: WATCH_REACTION_MS,
				},
			};
		}

		// ───────────────────────────── FPS:1 秒滚动窗口 ─────────────────────────────
		const SELF_RING = 600;

		/**
		 * A1:记录器自身开销。测量别人的东西必须先自证"我没让它变慢" —— 每帧给自己的
		 * rAF 回调计时,留最近 600 帧,面板与导出件都给 p99 与峰。
		 */
		function recordSelf(ms) {
			const ring = state.selfRing;
			if (ring.length < SELF_RING) ring.push(ms);
			else { ring[state.selfAt % SELF_RING] = ms; state.selfAt += 1; }
			state.selfCount += 1;
			if (ms > state.selfMax) state.selfMax = ms;
		}

		function selfStats() {
			const ring = state.selfRing;
			if (ring.length === 0) return { p99: null, max: null, samples: 0 };
			const sorted = ring.slice().sort((a, b) => a - b);
			return { p99: round1(percentile(sorted, 99)), max: round1(state.selfMax), samples: state.selfCount };   // percentile 的 p 是百分数
		}

		function recorderText() {
			const stats = selfStats();
			return stats.p99 === null ? translate('none') : `p99 ${stats.p99}ms · ${translate('peak')} ${stats.max}ms · ${stats.samples}`;
		}

		function frame() {
			if (state.on === false) return;
			const selfStarted = performance.now();
			const now = performance.now();
			const busy = state.busyMs;
			state.busyMs = 0;
			state.windowFrames += 1;
			if (state.lastFrameAt !== 0) {
				const delta = now - state.lastFrameAt;
				// rAF 被挂起(标签页隐藏/系统休眠)后回来的第一帧,delta 可能是几百秒。
				// 那是间隙不是卡顿:以前它会直接顶成"最差帧",面板红一整秒(实测误导读数)。
				// 现在间隙只进守夜层的帧环(标记 gap),并且重置这一秒的窗口 —— 间隙期间
				// 我们本来就没在测量,不该拿它去算 FPS 与最差帧。
				const isGap = delta >= WATCH_GAP_MS;
				if (isGap) {
					state.windowStart = now;
					state.windowFrames = 0;
					state.worstFrameMs = 0;
					state.unattrSum = 0;
					state.unattrCount = 0;
					state.unattrWorst = 0;
				} else {
					if (delta > state.worstFrameMs) state.worstFrameMs = delta;
					const idle = delta - busy;
					if (idle > 0) state.unattrSum += idle;
					state.unattrCount += 1;
					if (idle > state.unattrWorst) state.unattrWorst = idle;
				}
				watchFrame(now, delta, isGap);
			}
			state.lastFrameAt = now;
			const span = now - state.windowStart;
			if (span >= 1000) {
				state.fps = (state.windowFrames * 1000) / span;
				state.frameWorst = state.worstFrameMs;
				state.attributedPerSec = state.attributedMs;
				state.ltPerSec = state.ltThisSecond;
				state.ltThisSecond = 0;
				state.unattrAvg = state.unattrCount === 0 ? 0 : state.unattrSum / state.unattrCount;
				state.unattrPeak = state.unattrWorst;
				state.windowFrames = 0;
				state.worstFrameMs = 0;
				state.attributedMs = 0;
				state.unattrSum = 0;
				state.unattrCount = 0;
				state.unattrWorst = 0;
				state.windowStart = now;
			}
			recordSelf(performance.now() - selfStarted);
			state.fpsLoop = natives.requestAnimationFrame(frame);
		}

		// ───────────────────────────── Longtask + 元凶 ─────────────────────────────
		/** 哪段回调与这条 longtask 时间上重叠最多 —— 那就是最可能的元凶。 */
		function blame(start, duration) {
			const end = start + duration;
			const now = performance.now();
			let owner = null;
			let best = 0;
			const consider = (frame, to) => {
				const overlap = Math.min(to, end) - Math.max(frame.from, start);
				if (overlap > best) { best = overlap; owner = frame.owner; }
			};
			// 先看此刻仍在执行的回调:一口吃满 60ms 的那次,通常在 longtask 上报时还挂在栈上。
			for (const frame of state.stack) consider(frame, now);
			for (let i = state.recent.length - 1; i >= 0; i--) {
				const frame = state.recent[i];
				if (frame.to > start) consider(frame, frame.to);
			}
			return owner;
		}

		/** 这段时间里被采样到的 DOM 写入者组件(多数票)。fiber 那条只看到"容器变了"时,它才是线索。 */
		function recentWriteComponent(start, duration) {
			const end = start + duration + 200;
			const tally = new Map();
			for (const write of recentWrites) {
				if (write.at < start - 200 || write.at > end || write.component === null) continue;
				tally.set(write.component, (tally.get(write.component) ?? 0) + 1);
			}
			let top = null;
			for (const [name, count] of tally) if (top === null || count > top[1]) top = [name, count];
			return top === null ? null : top[0];
		}

		function addLongTask(entry) {
			const owner = blame(entry.startTime, entry.duration);
			const component = fiberOwner();
			const domComponent = recentWriteComponent(entry.startTime, entry.duration);
			const subtreeComponent = subtreeOwner();
			state.ltTotal += 1;
			state.ltThisSecond += 1;
			state.longTasks.push({
				t: Date.now(),
				at: round1(entry.startTime),
				ms: round1(entry.duration),
				owner,
				component,
				subtreeComponent,
				domComponent,
				source: owner === null ? (component === null ? 'none' : 'render') : (component === null ? 'scheduler' : 'scheduler+render'),
			});
			const record = state.longTasks[state.longTasks.length - 1];
			// 命中口径 = 三条腿任一非 none,与面板上的分布完全同一套判定
			// (旧版这里漏了 dom 腿:只有 DOM 写入归因的长任务进了分布、却没进命中数)
			if (legOf(record) !== 'none') state.ltBlamed += 1;
			applyLongTaskStats(record);
			if (state.longTasks.length > 200) state.longTasks.splice(0, state.longTasks.length - 200);
			state.displayKey = displayKey();
		}

		function startLongTask() {
			if (typeof W.PerformanceObserver !== 'function') return null;
			const supported = W.PerformanceObserver.supportedEntryTypes;
			if (Array.isArray(supported) && supported.indexOf('longtask') === -1) return null;
			try {
				const observer = new W.PerformanceObserver((list) => {
					for (const entry of list.getEntries()) addLongTask(entry);
				});
				observer.observe({ entryTypes: ['longtask'] });
				return observer;
			} catch (error) {
				return null; // 不支持 longtask 观测:其余三项照常工作
			}
		}

		function worstLongTask() {
			const cutoff = performance.now() - LT_WINDOW_MS;
			let worst = null;
			for (const item of state.longTasks) if (item.at >= cutoff && (worst === null || item.ms > worst.ms)) worst = item;
			return worst;
		}

		// ───────────────────────────────── DOM ─────────────────────────────────
		function nodeCount(root) {
			return root === null ? 0 : root.getElementsByTagName('*').length + 1;
		}

		function push(series, point) {
			series.push(point);
			if (series.length > 40) series.shift(); // 2 秒一点 ≈ 80 秒窗口
		}

		function sampleDom() {
			state.dom.total = document.getElementsByTagName('*').length - nodeCount(state.root);
			push(state.dom.series, { t: performance.now(), n: state.dom.total });
			// 堆用量:非标准 API,只有 Chromium 系有;没有就不显示这一行。
			const memory = W.performance === undefined ? undefined : W.performance.memory;
			state.heap = memory === undefined ? null : memory.usedJSHeapSize;
			if (state.heap !== null) push(state.heapSeries, { t: performance.now(), n: state.heap });
			for (const target of TARGETS) {
				let entry = state.targets.get(target.id);
				if (entry === undefined) {
					entry = { nodes: null, series: [] };
					state.targets.set(target.id, entry);
				}
				const element = target.find() ?? null;
				entry.nodes = element === null ? null : nodeCount(element);
				if (entry.nodes !== null) push(entry.series, { t: performance.now(), n: entry.nodes });
			}
		}

		/**
		 * 增速(个/分钟,堆那一路是字节/分钟)。默认只取最近 6 个采样点(≈12 秒):
		 * 用 80 秒窗口时页面早就停止增长了、读数还在慢慢衰减,看不出"空闲时是否还在涨"。
		 */
		function rate(series, points = 6) {
			const slice = series.length > points ? series.slice(-points) : series;
			if (slice.length < 2) return 0;
			const first = slice[0];
			const last = slice[slice.length - 1];
			const span = last.t - first.t;
			return span < 500 ? 0 : ((last.n - first.n) * 60000) / span;
		}

		// ───────────────────────── 归因表 / 采样 / 持久化 ─────────────────────────
		/**
		 * 每秒打一次"活桩":算每个插件这一秒的回调次数/耗时,再做 EMA 平滑。
		 * 单次便宜但高频(每 1.5 秒一次那种)在总和上不显眼,在"次/秒"上很显眼。
		 */
		function updateRates(now) {
			const seconds = state.lastTick === 0 ? 1 : Math.max((now - state.lastTick) / 1000, 0.2);
			state.lastTick = now;
			for (const entry of state.plugins.values()) {
				// 第一次只建立基线:若把基线当成"这一秒 0 次",EMA 会被 0 拖低。
				const first = entry.lastCount === undefined;
				const count = first ? 0 : entry.count - entry.lastCount;
				const ms = first ? 0 : entry.ms - entry.lastMs;
				entry.lastCount = entry.count;
				entry.lastMs = entry.ms;
				if (first) continue;
				const cps = count / seconds;
				const msps = ms / seconds;
				entry.cps = entry.cps === undefined ? cps : entry.cps * 0.6 + cps * 0.4;
				entry.msps = entry.msps === undefined ? msps : entry.msps * 0.6 + msps * 0.4;
				if (entry.cpsPeak === undefined || cps > entry.cpsPeak) entry.cpsPeak = cps;
			}
		}

		function pluginTable() {
			const rows = [];
			for (const [id, value] of state.plugins) {
				rows.push({
					id,
					count: value.count,
					ms: round1(value.ms),
					cps: round1(value.cps ?? 0),
					msps: round1(value.msps ?? 0),
					cpsPeak: round1(value.cpsPeak ?? 0),
				});
			}
			rows.sort((a, b) => b.ms - a.ms || b.count - a.count);
			return rows;
		}

		/** 窗口开始时的写入计数快照,用来算"这段时间谁真的写了节点"。 */
		function domWriteSnapshot() {
			const snapshot = new Map();
			for (const [id, entry] of state.domWrites) {
				snapshot.set(id, { count: entry.count, components: new Map(entry.components ?? new Map()) });
			}
			return snapshot;
		}

		/**
		 * 窗口内的写入增量。必须用增量:累计表会在"这一分钟一个节点都没加"的空闲窗口里
		 * 照样列出历史第一名(实测导出里就是这样冤枉了 ReasoningRow),那就等于没点名。
		 */
		function domWriteDelta(snapshot) {
			const rows = [];
			for (const [id, entry] of state.domWrites) {
				const before = snapshot.get(id);
				const gained = entry.count - (before === undefined ? 0 : before.count);
				if (gained <= 0) continue;
				const components = [];
				for (const [name, count] of entry.components ?? new Map()) {
					const base = before === undefined ? 0 : before.components.get(name) ?? 0;
					if (count - base > 0) components.push({ name, count: count - base });
				}
				components.sort((a, b) => b.count - a.count);
				rows.push({
					id,
					estimatedCount: gained,
					component: components.length === 0 ? null : components[0].name,
					components: components.slice(0, 2),
				});
			}
			rows.sort((a, b) => b.estimatedCount - a.estimatedCount);
			return rows;
		}

		/** DOM 写入估算表(命中者按采样步长折算)。 */
		function domWriteTable() {
			const rows = [];
			for (const [id, entry] of state.domWrites) {
				const components = [...(entry.components ?? new Map()).entries()].sort((a, b) => b[1] - a[1]);
				rows.push({
					id,
					estimatedCount: entry.count,
					sampled: entry.ops,
					component: components.length === 0 ? null : components[0][0],
					components: components.slice(0, 2).map(([name, count]) => ({ name, count })),
				});
			}
			rows.sort((a, b) => b.estimatedCount - a.estimatedCount);
			return rows;
		}

		function sampleTick() {
			updateRates(performance.now());
			idleTick(performance.now());
			const worst = worstLongTask();
			ring.push({
				t: Date.now(),
				fps: round1(state.fps),
				frameMs: round1(state.frameWorst),
				ltCount: state.ltPerSec,
				nodes: state.dom.total,
				heap: state.heap,
				streaming: state.streaming,
				rtt: linkStats(10).p50,
				hostP99: hostP99(),
				attributedMsPerSec: round1(state.attributedPerSec),
				unattrMsPerFrame: [round1(state.unattrAvg), round1(state.unattrPeak)],
				lt: worst === null ? null : { at: new Date(worst.t).toISOString(), ms: round1(worst.ms), owner: worst.owner },
				top: pluginTable().slice(0, TOP_N).map((row) => [row.id, row.count, row.ms, row.cps]),
			});
			if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
			state.displayKey = displayKey();
			dirty = true;
		}

		function restore() {
			try {
				const raw = localStorage.getItem(LS_RING);
				const parsed = raw === null ? null : JSON.parse(raw);
				if (parsed !== null && Array.isArray(parsed.samples)) for (const sample of parsed.samples.slice(-RING_MAX)) ring.push(sample);
			} catch (error) { /* 历史损坏:丢弃,不阻塞启动 */ }
			try { state.want = localStorage.getItem(LS_ON) !== '0'; } catch (error) { state.want = true; }
			try { state.collapsed = localStorage.getItem(LS_UI) === '1'; } catch (error) { state.collapsed = false; }
			try { state.precise = localStorage.getItem(LS_PRECISE) === '1'; } catch (error) { state.precise = false; }
			try { state.deep = localStorage.getItem(LS_DEEP) === '1'; } catch (error) { state.deep = false; }
			// 深录关着的时候不该还挂着精确归因(那会白拉那份 12MB 的 map)
			if (state.deep === false) state.precise = false;
			try {
				const saved = JSON.parse(localStorage.getItem(LS_GROUPS) ?? 'null');
				if (saved !== null && typeof saved === 'object') {
					for (const key of Object.keys(state.groups)) if (typeof saved[key] === 'boolean') state.groups[key] = saved[key];
				}
			} catch (error) { /* 折叠状态记不住就用默认 */ }
			try {
				const parsed = JSON.parse(localStorage.getItem(LS_MARKS) ?? 'null');
				if (Array.isArray(parsed)) state.marks = parsed.slice(-100);
			} catch (error) { /* 标记坏了就算了 */ }
			restoreIncidents();
		}

		function flush(force) {
			if (dirty === false && force !== true) return;
			dirty = false;
			try {
				localStorage.setItem(LS_RING, JSON.stringify({ v: 1, savedAt: Date.now(), samples: ring }));
			} catch (error) { /* 配额满:持久化放弃,内存缓冲照常 */ }
		}

		// ───────────────────────── A2:跨会话基线 ─────────────────────────
		/**
		 * 一次会话的帧分布(整段帧环,不排除任何窗口)。
		 *
		 * 事故包里的 `baseline` 只是**同一个会话**的其余部分 —— 换一个会话就没法回答"这台机器
		 * 平时是多少"。所以每个会话落一条,只进导出件(面板不显示:它不是"现在"的读数)。
		 */
		function sessionRecord() {
			const stats = frameRing.stats();
			if (stats === null) return null;   // 一帧都没采到:不编数字
			return {
				at: new Date().toISOString(),          // 这条记录最后一次更新的时刻
				since: new Date(state.since > 0 ? state.since : Date.now()).toISOString(),   // 会话身份
				frames: stats.frames,
				p50: stats.p50, p90: stats.p90, p99: stats.p99, worstMs: stats.worstMs,
				fps: stats.fps, spanMs: stats.spanMs, busyMs: stats.busyMs,
			};
		}

		/**
		 * 把本次会话的分布写进跨会话基线(同一个会话只占一条,按 since 认人)。
		 * 写失败不抛:拿不到跨会话基线不影响本次读数,导出件里就只是少一段。
		 */
		function saveSessionBaseline() {
			const record = sessionRecord();
			if (record === null) return [];
			let list = [];
			try {
				const parsed = JSON.parse(localStorage.getItem(LS_SESSIONS) ?? 'null');
				if (parsed !== null && Array.isArray(parsed.sessions)) list = parsed.sessions;
			} catch (error) { list = []; }
			const kept = list.filter((row) => row !== null && typeof row === 'object' && row.since !== record.since);
			kept.push(record);
			if (kept.length > SESSION_KEEP) kept.splice(0, kept.length - SESSION_KEEP);
			try {
				localStorage.setItem(LS_SESSIONS, JSON.stringify({ v: 1, savedAt: Date.now(), sessions: kept }));
			} catch (error) { /* 配额满:放弃持久化,不假装成功 */ }
			return kept;
		}

		/**
		 * 导出件里的跨会话基线。**口径必须写死在文件里**:它是"粗参照",不是回归判定 ——
		 * 会话之间的负载、视口、是否插桩都不同,帧数量级能差一个数量级(实测有的会话 5156 帧、
		 * 有的 184 帧),拿它当"变慢了"的证据会得出错误结论。
		 */
		function sessionBaselines() {
			return {
				note: '粗参照,不是回归判定:每个会话的分布只代表那一次(负载、视口、是否插桩都不同,帧数量级也可能差一个数量级);只用来看"这次是不是比平时差一个量级"',
				keep: SESSION_KEEP,
				sessions: saveSessionBaseline(),
			};
		}

		// ───────────── D. 宿主事件循环 + 链路 RTT / 吞吐 ─────────────
		const sleep = (ms) => new Promise((resolve) => natives.setTimeout(resolve, ms));

		/**
		 * bundle 读写的两条通道:
		 *   1. 客户端 remote face(@deepseek-ai/dsh-api-remotes 提供的 ctx.remote.pluginManager)
		 *      —— 与插件管理器面板同一条路,不需要宿主重启;
		 *   2. 本插件的宿主路由 /api/dsh-perf-hud/host —— 宿主半加载后才有,兼作 D 的事件循环数据源。
		 * 面板与导出里都记 via,不假装知道数据从哪来。
		 */
		let remoteFace = null;

		async function bundleOp(op, args) {
			const manager = remoteFace === null ? null : remoteFace.pluginManager;
			if (manager !== null && manager !== undefined) {
				if (op === 'listBundles' && typeof manager.listBundles === 'function') {
					return { ok: true, via: 'remote', bundles: await manager.listBundles() };
				}
				if (op === 'setBundle' && typeof manager.setBundleEnabled === 'function') {
					return { ok: true, via: 'remote', result: await manager.setBundleEnabled(args.name, args.enabled) };
				}
			}
			const payload = await hostOp(args);
			return { ...payload, via: 'route' };
		}

		/** 一次宿主请求:GET 兼作 RTT/吞吐探针,POST 走 op 分发。 */
		async function hostOp(body) {
			const response = await fetch(HOST_ROUTE, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				credentials: 'same-origin',
			});
			const payload = await response.json();
			return payload;
		}

		/** RTT 探针:请求带 1KB cache-buster(别缓存,也别让代理吞掉);吞吐探针多要 64KB。 */
		async function probeLink(kind) {
			const started = performance.now();
			const query = kind === 'load'
				? `?t=${Date.now()}&bytes=${LOAD_BYTES}`
				: `?t=${Date.now()}&pad=${'x'.repeat(1024)}`;
			try {
				const response = await fetch(`${HOST_ROUTE}${query}`, { cache: 'no-store', credentials: 'same-origin' });
				if (response.ok === false) throw new Error(`HTTP ${response.status}`);
				const payload = await response.json();
				const rtt = round1(performance.now() - started);
				if (kind === 'load') {
					const bytes = payload.pad === undefined ? 0 : payload.pad.length;
					const kbps = rtt <= 0 ? 0 : round1(bytes / 1024 / (rtt / 1000));
					state.link.push({ t: Date.now(), kind, rtt, kbps });
					state.linkText = `${kbps}KB/s`;
					state.loadKbps = kbps;
					state.loadState = 'ok';
				} else {
					state.link.push({ t: Date.now(), kind, rtt });
				}
				if (state.link.length > 300) state.link.shift();
				state.host = payload.host ?? null;
				state.hostAt = Date.now();
				state.hostError = null;
				if (payload.host?.eventWatch !== undefined) state.hostEvents = payload.host.eventWatch;
				await requestHostEventWatch();
			} catch (error) {
				state.hostError = error instanceof Error ? error.message : String(error);
				if (kind === 'load') state.loadState = 'failed';
				state.link.push({ t: Date.now(), kind, rtt: null, error: state.hostError });
				if (state.link.length > 300) state.link.shift();
			}
		}

		/** nearest-rank 分位:输入必须已升序。p50 不能用 values[floor(n*0.5)] 近似,那样 4 个样本会取到第 3 个。 */
		function percentile(sorted, p) {
			if (sorted.length === 0) return null;
			const rank = Math.ceil((p / 100) * sorted.length) - 1;
			return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
		}

		/**
		 * 让宿主装上 session/event 派发计时。每个页面会话只请求一次;
		 * 装没装上以宿主回执为准,面板与导出都照实显示。
		 */
		async function requestHostEventWatch() {
			if (state.hostWatchAsked || state.hostWatchOff) return;
			state.hostWatchAsked = true;
			try {
				const payload = await hostOp({ op: 'watchEvents', enable: true });
				state.hostEvents = payload.eventWatch ?? { installed: false, reason: '无回执', stats: {} };
			} catch (error) {
				state.hostEvents = { installed: false, reason: error instanceof Error ? error.message : String(error), stats: {} };
			}
			dirty = true;
		}

		function hostEventsText() {
			const watch = state.hostEvents;
			if (watch === null) return translate('notYet');
			if (watch.installed !== true) return `${translate('notInstalled')}${watch.reason === undefined || watch.reason === '' ? '' : `: ${String(watch.reason).slice(0, 22)}`}`;
			const rows = Object.entries(watch.stats ?? {}).sort((a, b) => b[1].ms - a[1].ms);
			if (rows.length === 0) return translate('waiting');
			return rows.slice(0, 2).map(([name, stat]) => `${name} ${stat.count}${translate('times')} · ${translate('cumulative')} ${stat.ms}ms · ${translate('peak')} ${stat.max}ms`).join(' / ');
		}

		/** 近 N 秒的 RTT 分位(只算成功的 RTT 探测,不含吞吐)。 */
		function linkStats(seconds = 60) {
			const cutoff = Date.now() - seconds * 1000;
			const values = state.link
				.filter((row) => row.kind === 'rtt' && row.t >= cutoff && typeof row.rtt === 'number')
				.map((row) => row.rtt)
				.sort((a, b) => a - b);
			if (values.length === 0) return { count: 0, p50: null, p99: null, max: null };
			return {
				count: values.length,
				p50: percentile(values, 50),
				p99: percentile(values, 99),
				max: percentile(values, 100),
			};
		}

		function hostP99() {
			return state.host?.eventLoop?.p99 ?? null;
		}

		/** 吞吐显示:>=1024KB/s 折成 MB/s(这一行还要放 RTT 与判定,省宽度)。 */
		function throughputText() {
			if (state.loadState === 'pending') return translate('sampling');
			if (state.loadState === 'failed') return translate('failed');
			const kbps = state.loadKbps;
			if (typeof kbps !== 'number') return state.linkText;
			return kbps >= 1024 ? `${Math.round(kbps / 1024 * 10) / 10}MB/s` : `${kbps}KB/s`;
		}

		/**
		 * 一条长任务算哪条腿。
		 * 注意:fiber 腿要求"非外壳组件",被 looksLikeInfrastructure 挡掉的名字不算 fiber 腿,
		 * 会落到 dom 腿 —— 统计口径必须和展示口径一致,否则"命中"会和分布对不上。
		 */
		function legOf(row) {
			if ((row.component ?? null) !== null && looksLikeInfrastructure(row.component) === false) return 'fiber';
			if ((row.subtreeComponent ?? null) !== null) return 'subtree';
			if ((row.domComponent ?? null) !== null) return 'dom';
			if ((row.owner ?? null) !== null) return 'owner';
			return 'none';
		}

		/**
		 * 累计统计。刻意用独立的累计计数器,而不是回头去数 state.longTasks ——
		 * 后者有 200 条上限,会让"最多 X N×"与"命中 15/18"分属两个窗口(实测就是这么不一致的)。
		 */
		function applyLongTaskStats(row) {
			state.ltLegs[legOf(row)] += 1;
			const name = primaryBlame(row);
			if (name === null) return;
			state.ltNames.set(name, (state.ltNames.get(name) ?? 0) + 1);
			if (state.ltNames.size > 60) {
				// 名字种类过多时丢掉最少的那个,避免无限增长(明细仍有 200 条上限兜底)
				let least = null;
				for (const [key, count] of state.ltNames) if (least === null || count < least[1]) least = [key, count];
				if (least !== null) state.ltNames.delete(least[0]);
			}
		}

		/**
		 * 长任务归属分布。
		 *
		 * 一个"命中 23/24"说明不了任何事:DOM 写入那条腿在流式渲染时几乎必然命中,
		 * 命中率会被它抬得很高。真正要看的是**名字分布** —— 23 次里如果 20 次是同一个
		 * 名字,那说明命中很廉价;如果分散在 8 个名字上,那才说明这段时间到处都在渲染。
		 */
		function longTaskTally() {
			const legs = state.ltLegs;
			const top = [...state.ltNames.entries()].sort((a, b) => b[1] - a[1]);
			// B1:记录器自己从"谁的锅"里分出来单列 —— 它和插件混排会让人以为本 HUD 在拖慢页面,
			// 而它每帧都在跑、必然出现在这张表里。
			const self = top.filter(([name]) => isRecorderName(name));
			const others = top.filter(([name]) => isRecorderName(name) === false);
			return {
				fiber: legs.fiber, subtree: legs.subtree, dom: legs.dom, owner: legs.owner, none: legs.none,
				total: state.ltTotal, top: others, topNames: others.slice(0, 3),
				self, selfTotal: self.reduce((sum, row) => sum + row[1], 0),
			};
		}

		/**
		 * 一条长任务该怎么念。
		 *
		 * 两条腿:fiber 走查(component)与 DOM 写入(recentWriteComponent)。fiber 给到宿主
		 * 外壳组件(如 SlotOutlet)时不算答案,退到写入那条腿;两条都有且不同就都念出来,
		 * 让人自己判断 —— 不挑一个好看的报。
		 */
		/** 分布统计用的"主名字":fiber(非外壳)> DOM 写入 > 包名;都没有则 null。 */
		function primaryBlame(row) {
			if (row === null || row === undefined) return null;
			const fiber = row.component ?? null;
			// B1:候选按原来的优先级排一遍,然后**优先取非记录器**的那个 —— 记录器自己命中时,
			// 只要还有别的候选(子树 / DOM 写入 / 包名),元凶就不是它;一个别的候选都没有时
			// 照实返回它(标注由 blameText 做),不假装未归因。
			const candidates = [];
			if (fiber !== null && looksLikeInfrastructure(fiber) === false) candidates.push(fiber);
			const subtree = row.subtreeComponent ?? null;
			if (subtree !== null) candidates.push(subtree);
			const dom = row.domComponent ?? null;
			if (dom !== null) candidates.push(dom);
			if (fiber !== null) candidates.push(fiber);
			if (row.owner !== null && row.owner !== undefined) candidates.push(short(row.owner));
			for (const name of candidates) if (isRecorderName(name) === false) return name;
			return candidates.length === 0 ? null : candidates[0];
		}

		/** 名字 + (命中记录器自己时的标注);方括号是为了不跟"哪条腿"的圆括号混在一起。 */
		function blameName(name) {
			return isRecorderName(name) ? `${name}[${translate('recorder')}]` : name;
		}

		function blameText(row) {
			if (row === null || row === undefined) return translate('none');
			const fiber = row.component ?? null;
			const subtree = row.subtreeComponent ?? null;
			const dom = row.domComponent ?? null;
			// 祖先方向拿到的名字(容器)与子树方向拿到的名字同时给出:切视图这类"整棵挂载"
			// 场景,答案在子树里;而流式那种增量更新,答案在祖先方向。
			if (fiber !== null && looksLikeInfrastructure(fiber) === false) {
				const backup = subtree !== null && subtree !== fiber ? subtree : (dom !== null && dom !== fiber ? dom : null);
				if (backup === null) return blameName(fiber);
				const label = subtree !== null && subtree !== fiber ? translate('legSubtree') : translate('stressFromDom');
				return `${blameName(fiber)} / ${blameName(backup)}(${label})`;
			}
			if (subtree !== null) return `${blameName(subtree)}(${translate('legSubtree')})`;
			if (dom !== null) return `${blameName(dom)}(${translate('stressFromDom')})`;
			if (fiber !== null) return blameName(fiber);
			if (row.owner !== null && row.owner !== undefined) return blameName(short(row.owner));
			return translate('unblamed');
		}

		/** 自测状态:点了必须看得见进度与结果,否则"毫无反应"就是必然观感。 */
		function stressText() {
			const mark = state.stress;
			if (mark === null) return `${translate('stressDone')}: ${translate('notYet')}`;
			const hit = state.longTasks
				.filter((row) => row.t >= mark.at - 500 && row.t <= mark.at + 8000)
				.reduce((top, row) => (top === null || row.ms > top.ms ? row : top), null);
			const mode = mark.sync === true ? translate('stressSync') : translate('stressSliced');
			const flush = flushSync === null ? ` · ${translate('stressNoFlush')}` : '';
			const burn = typeof mark.burnMs === 'number' && mark.burnMs > 0 ? ` · ${translate('stressBurn')} ${mark.burnMs}ms` : '';
			const commit = mark.commitMs === undefined ? '' : ` · ${translate('stressCommit')} ${mark.commitMs}ms(${mode}${burn})${flush}`;
			// 第二个来源:这段时间 DOM 写入最多的组件。React 把整棵新子树一次 appendChild 挂上去,
			// 观察器只看到"容器变了",fiber 走查因此只能给到容器所属组件;写入插桩则看到了每一个
			// 节点(含未挂载的),所以能把 PerfHudStress 精确点名。
			const wrote = mark.writes0 === undefined ? [] : domWriteDelta(mark.writes0);
			const writeWho = wrote.length === 0 ? null : wrote[0].component ?? null;
			if (hit !== null) {
				const who = hit.component === null ? translate('unblamed') : hit.component;
				const both = writeWho !== null && writeWho !== hit.component ? ` / ${writeWho}(${translate('stressFromDom')})` : '';
				return `${translate('stressDone')}: ${Math.round(hit.ms)}ms · ${who}${both}${hit.owner === null ? '' : ` (${short(hit.owner)})`}${commit}`;
			}
			if (writeWho !== null) return `${translate('stressDone')}: ${translate('stressNoTask')} · ${translate('stressFromDom')} ${writeWho}${commit}`;
			if (mark.commitMs !== undefined) return `${translate('stressDone')}: ${translate('stressNoTask')}${commit}`;
			// 状态必须能收敛:以前没有超时出口,一旦没长任务就永远停在"进行中"。
			if (Date.now() - mark.at > 8000) return `${translate('stressDone')}: ${translate('stressNoTask')}(8s)${flush}`;
			return `${translate('stressRunning')}: ${mark.nodes} ${translate('nodes')} …`;
		}

		/** 链路那一行的整句:样本数必须露出来 —— n=1 时 p50 会等于 p99,看着像 bug。 */
		function linkRowText() {
			const stats = linkStats();
			if (stats.count === 0) return translate('notYet');
			return `p50 ${stats.p50}ms · p99 ${stats.p99}ms (n=${stats.count}) · ${throughputText()}${suspectLink() ? ` · ${translate('suspect')}` : ''}`;
		}

		/** RTT 尖峰而 FPS 正常 → 怀疑链路,而不是页面。 */
		function suspectLink() {
			const stats = linkStats();
			// 至少两个样本才表态:n=1 时"p50=p99=尖峰"分不清是抖动还是常态。
			return stats.p99 !== null && stats.count >= 2 && stats.p99 > 300 && state.fps >= 50;
		}

		// ───────────── E. 空闲基线 / 场景标记 / 验收自证 ─────────────
		/** 流式判定:ui-chat 的稳定钩子,不依赖类名与第三方插件。 */
		function isStreaming() {
			try {
				return document.querySelector('[data-chat-running]') !== null;
			} catch (error) {
				return false;
			}
		}

		/** 一个固定时长的测量窗口:每秒取一次读数,出窗口后汇总。 */
		async function measureWindow(label, ms) {
			const started = performance.now();
			const fps = [];
			const lt0 = state.ltTotal;
			const dom0 = state.dom.total;
			const writes0 = domWriteSnapshot();
			let ltPeak = 0;
			let samples = 0;
			let streamingSamples = 0;
			const unattr = [];
			while (performance.now() - started < ms) {
				await sleep(1000);
				samples += 1;
				if (state.streaming) streamingSamples += 1;
				fps.push(state.fps);
				unattr.push(state.unattrAvg);
				ltPeak = Math.max(ltPeak, state.ltPerSec);
				if (experiment.aborted === true && label !== 'idle') break;
			}
			const seconds = Math.max((performance.now() - started) / 1000, 0.001);
			const domDelta = state.dom.total - dom0;
			return {
				label,
				t: Date.now(),
				seconds: Math.round(seconds * 10) / 10,
				fps: fps.length === 0 ? round1(state.fps) : round1(fps.reduce((sum, value) => sum + value, 0) / fps.length),
				fpsMin: fps.length === 0 ? round1(state.fps) : round1(Math.min.apply(null, fps)),
				longTasks: state.ltTotal - lt0,
				longTaskPeakPerSec: ltPeak,
				domDelta,
				domPerMin: round1((domDelta * 60000) / (seconds * 1000)),
				top: pluginTable().slice(0, 3).map((row) => ({ id: row.id, cps: row.cps, ms: row.ms })),
				// 只列这一段窗口里真的写过节点的插件/组件(累计表会冤枉空闲窗口)
				domTop: domWriteDelta(writes0).slice(0, 2),
				// 每帧"没被 JS 回调解释掉"的残差(样式/绘制/vsync)。负载不同时绝对 fps 没法比,
				// 但"同一帧里 JS 之外还要花多少"相对可比 —— 常驻动画/轮询那类固定开销在这里现形。
				unattrAvg: unattr.length === 0 ? 0 : round1(unattr.reduce((sum, value) => sum + value, 0) / unattr.length),
				unattrPeak: unattr.length === 0 ? 0 : round1(Math.max.apply(null, unattr)),
				samples,
				streamingSeconds: streamingSamples,
				streaming: streamingSamples > 0,
			};
		}

		/** 自动空闲基线:连续空闲 IDLE_GAP_MS 之后打一个 BASELINE_MS 的窗口,5 分钟内只打一次。 */
		function idleTick(now) {
			state.streaming = isStreaming();
			if (state.streaming) {
				state.idleSince = 0;
				return;
			}
			if (state.idleSince === 0) state.idleSince = now;
			if (state.baselineRunning || experiment.phase === 'running') return;
			if (now - state.idleSince < IDLE_GAP_MS) return;
			if (state.baselineAt !== 0 && now - state.baselineAt < 5 * 60000) return;
			state.baselineRunning = true;
			state.baselineAt = now;
			measureWindow('idle', state.baselineMs === null ? BASELINE_MS : state.baselineMs).then((windowed) => {
				state.idleBaseline = windowed;
				state.baselineRunning = false;
				dirty = true;
			});
		}

		/** 场景标记:把"卡的那一下"和当时的读数绑在一起。 */
		function addMark(note) {
			const worst = worstLongTask();
			const stats = linkStats();
			state.marks.push({
				t: Date.now(),
				iso: new Date().toISOString(),
				note: typeof note === 'string' ? note.slice(0, 200) : '',
				fps: round1(state.fps),
				frameMs: round1(state.frameWorst),
				nodes: state.dom.total,
				heap: state.heap,
				longTask: worst === null ? null : { ms: worst.ms, owner: worst.owner, component: worst.component ?? null },
				rttP99: stats.p99,
				hostP99: hostP99(),
				streaming: state.streaming,
			});
			if (state.marks.length > 100) state.marks.shift();
			try { localStorage.setItem(LS_MARKS, JSON.stringify(state.marks.slice(-100))); } catch (error) { /* 记不住就只留内存 */ }
			dirty = true;
			bump();
		}

		/** 验收自证:把这次要交的几条判据直接算出来,面板与导出都能读到同一份。 */
		function verification() {
			const seen = new Set();
			for (const id of state.plugins.keys()) seen.add(id);
			for (const id of state.domWrites.keys()) seen.add(id);
			const mapStates = { pending: 0, ready: 0, failed: 0 };
			for (const entry of bundleMaps.values()) mapStates[entry.state] += 1;
			const blamed = state.longTasks.filter((row) => row.owner !== null || row.component !== null);
			const withComponent = state.longTasks.filter((row) => (row.component ?? null) !== null || (row.domComponent ?? null) !== null);
			return {
				precise: {
					enabled: state.precise,
					bundles: bundleMaps.size,
					mapStates,
					seconds: Object.fromEntries([...bundleMaps.entries()].map(([key, entry]) => [bundleLabel(key), entry.state])),
				},
				// 精确归因是否真的还原出了**独立包名**(而不是只给合并包的 key):
				// 统计口径是"归因表与 DOM 写入表里出现过的、非合并键的 id"。
				independentPackages: (() => {
					const names = [...seen].filter((id) => id.startsWith(BUNDLE_PREFIX) === false).sort();
					return { count: names.length, sample: names.slice(0, 3) };
				})(),
				longTask: {
					total: state.ltTotal,
					attributed: state.ltBlamed,
					legs: longTaskTally(),
					withComponent: withComponent.length,
					last: blamed.length === 0 ? null : blamed[blamed.length - 1],
				},
				idle: {
					streaming: state.streaming,
					baseline: state.idleBaseline,
				},
				hostEvents: {
					installed: state.hostEvents === null ? null : state.hostEvents.installed === true,
					reason: state.hostEvents === null ? null : state.hostEvents.reason ?? '',
					eventNames: state.hostEvents === null ? [] : Object.keys(state.hostEvents.stats ?? {}),
				},
				exportSections: ['timeline', 'longTasks', 'isolation'],
			};
		}

		// ───────────── C. 自动插件隔离实验(因果,不是相关) ─────────────
		// 每一步都记宿主的真实回执(ChangeResult):没真的关掉就写 reason 跳过,不假装成功。
		// setBundle 会临时改 profile 的 bundle 选择(不是 cordis.patch.yml),所以:
		//   1) 必须先读原始列表; 2) 每步结束立刻恢复; 3) 全部结束后再读一次并逐项核验;
		//   4) 任何时刻都能中止,中止也会走恢复流程。
		/**
		 * 隔离实验的候选:从宿主真实的 bundle 列表里挑,**不写死任何插件名**。
		 * 判据:已启用 + 可移除 —— 宿主 listBundles 的 installed/removable 只对社区包为真
		 * (官方内核 bundle 两者都是 false),所以这一条天然把内核排掉;再排掉本插件自己。
		 * 按名字排序取前 EXPERIMENT_MAX_CANDIDATES 个:每个候选要 90 秒,列全了没人等。
		 */
		function pickExperimentCandidates(bundles, selfName) {
			if (Array.isArray(bundles) === false) return [];
			return bundles
				.filter((bundle) => bundle !== null && typeof bundle === 'object')
				.filter((bundle) => bundle.enabled === true && bundle.removable === true)
				.filter((bundle) => typeof bundle.name === 'string' && bundle.name !== '' && bundle.name !== selfName)
				.filter((bundle) => bundle.name.startsWith('@deepseek-ai/') === false)
				.map((bundle) => bundle.name)
				.sort()
				.slice(0, EXPERIMENT_MAX_CANDIDATES);
		}

		const experiment = {
			phase: 'idle',        // idle | running | done | aborted | failed
			message: '',
			candidates: [],
			results: [],
			original: null,
			candidateState: [],
			restored: null,
			baseline: null,
			noise: null,          // 基线之间的漂移,当噪声底
			drifts: [],
			loadTimer: 0,
			method: '所有窗口注入同一份合成负载(每 250ms 燃烧 8ms),再按 基线 → (关闭 → 窗口 → 恢复 → 恢复后基线) × N 对照;没有负载时比较毫无意义(Δ 必然≈0)',
			aborted: false,
			startedAt: 0,
			via: null,            // 'remote' | 'route' | null:数据实际从哪条通道来的
		};

		/** 两条通道给同一份人话:bundle 读写到底是走客户端 remote 还是本插件的宿主路由。 */
		function viaLabel(via) {
			if (via === 'remote') return `${translate('via')} ${translate('viaRemote')}`;
			if (via === 'route') return `${translate('via')} ${translate('viaRoute')}`;
			return `${translate('via')} ${translate('notYet')}`;
		}

		function experimentText() {
			const parts = [experiment.phase];
			if (experiment.message !== '') parts.push(experiment.message);
			return parts.join(' · ');
		}

		function abortExperiment() {
			if (experiment.phase !== 'running') return false;
			experiment.aborted = true;
			experiment.message = '中止中:正在恢复原状';
			stopExperimentLoad();
			return true;
		}

		/**
		 * 实验用的合成负载:每个窗口注入**同一份**工作。
		 *
		 * 为什么必须有:空闲下比较毫无意义(所有窗口都没活干,Δ 必然≈0),而流式又不稳定
		 * (各窗口负载不同)。所以自己造一份恒定负载,让所有窗口的对比基准一致。
		 * 用 natives.setInterval(不经过我的插桩)、只烧 CPU 不动 DOM,以免污染归因表。
		 */
		function startExperimentLoad() {
			if (experiment.loadTimer !== 0) return;
			experiment.loadTimer = natives.setInterval(() => {
				const until = performance.now() + EXPERIMENT_LOAD_BURN_MS;
				while (performance.now() < until) { /* 合成负载 */ }
			}, EXPERIMENT_LOAD_PERIOD_MS);
		}

		function stopExperimentLoad() {
			if (experiment.loadTimer === 0) return;
			natives.clearInterval(experiment.loadTimer);
			experiment.loadTimer = 0;
		}

		/**
		 * 等会话空闲(连续 IDLE_GAP_MS 没有流式),最多等 waitMs。
		 * 实测两次实验都跑在流式回合里,四行全被标"不可比" —— 与其事后标注,不如先等。
		 */
		async function waitForIdle(waitMs) {
			const started = performance.now();
			let calmSince = state.streaming ? 0 : performance.now();
			while (performance.now() - started < waitMs) {
				if (experiment.aborted === true) return false;
				if (state.streaming) {
					calmSince = 0;
				} else if (calmSince === 0) {
					calmSince = performance.now();
				} else if (performance.now() - calmSince >= IDLE_GAP_MS) {
					return true;
				}
				experiment.message = `等待会话空闲(${Math.round((performance.now() - started) / 1000)}s)`;
				await sleep(1000);
			}
			return false;
		}

		/** 把候选恢复成原始开关状态;返回每一项的真实回执。 */
		async function restoreCandidates(stateBefore) {
			const restores = [];
			for (const [name, enabled] of stateBefore) {
				if (enabled !== true) continue;
				try {
					const payload = await bundleOp('setBundle', { op: 'setBundle', name, enabled: true, confirm: true });
					restores.push({
						name,
						ok: payload.ok === true && payload.result?.application === 'applied',
						application: payload.result?.application ?? null,
						error: payload.ok === true ? null : payload.error,
					});
				} catch (error) {
					restores.push({ name, ok: false, application: null, error: error instanceof Error ? error.message : String(error) });
				}
			}
			return restores;
		}

		/** Δ 一律对照"紧邻的前一个基线窗口";缺任一侧就不写数字(宿主没真的关掉就不会走到这)。 */
		function experimentDelta(base, off) {
			if (base === null || base === undefined || off === null || off === undefined) return null;
			return {
				fps: round1(off.fps - base.fps),
				longTasks: off.longTasks - base.longTasks,
				domPerMin: round1(off.domPerMin - base.domPerMin),
				unattrAvg: round1((off.unattrAvg ?? 0) - (base.unattrAvg ?? 0)),
			};
		}

		/**
		 * 噪声底 = 「基线 → 基线」漂移的最大绝对值。
		 *
		 * 为什么必须有它:第一版实验每个候选都跟"最初那个基线"比,结果四个 Δfps 全是负的 ——
		 * 那是机器越跑越忙的系统性漂移,不是四个插件都有害。有了噪声底,任何小于它的 Δ
		 * 都标成噪声内,不把漂移包装成结论。
		 */
		function noiseFloor(drifts) {
			const pick = (key) => drifts.reduce((top, item) => Math.max(top, item === null || item === undefined ? 0 : Math.abs(item[key] ?? 0)), 0);
			return { fps: round1(pick('fps')), longTasks: pick('longTasks'), domPerMin: round1(pick('domPerMin')), unattrAvg: round1(pick('unattrAvg')) };
		}

		/** Δ 是否超出噪声底(逐指标判断)。 */
		function significance(delta, noise) {
			if (delta === null || noise === null) return null;
			return {
				fps: Math.abs(delta.fps) > noise.fps,
				longTasks: Math.abs(delta.longTasks) > noise.longTasks,
				domPerMin: Math.abs(delta.domPerMin) > noise.domPerMin,
				unattrAvg: Math.abs(delta.unattrAvg ?? 0) > noise.unattrAvg,
			};
		}

		/**
		 * 超出噪声的结论。
		 * 窗口含流式时**不给结论** —— 自己刚声明"该对照不可比",却又列出「超出噪声 fps」,
		 * 等于引诱读者挑一个数字当结论(实测第一版就被这么读)。
		 */
		function beyondNoiseText(row) {
			if (row === null || row === undefined) return translate('notYet');
			if (row.confounded === true) return translate('notApplicable');
			return metricList(row.significant);
		}

		/** 超出噪声的指标名单,给面板一行用。 */
		function metricList(sig) {
			if (sig === null || sig === undefined) return translate('notYet');
			const hit = [];
			if (sig.fps) hit.push('fps');
			if (sig.unattrAvg) hit.push(translate('unattrShort'));
			if (sig.longTasks) hit.push('LT');
			if (sig.domPerMin) hit.push('DOM');
			return hit.length === 0 ? translate('none') : hit.join('/');
		}

		async function runExperiment() {
			if (experiment.phase === 'running') return false;
			experiment.phase = 'running';
			experiment.aborted = false;
			experiment.results = [];
			experiment.restored = null;
			experiment.baseline = null;
			experiment.startedAt = Date.now();
			experiment.message = '读取原始 bundle 列表';
			experiment.via = null;
			let listed;
			try {
				listed = await bundleOp('listBundles', { op: 'listBundles' });
			} catch (error) {
				experiment.phase = 'failed';
				experiment.message = `宿主不可达:${error instanceof Error ? error.message : String(error)}`;
				return false;
			}
			if (listed.ok !== true) {
				experiment.phase = 'failed';
				experiment.message = `宿主不可用:${String(listed.error)}`;
				return false;
			}
			experiment.original = listed.bundles;
			experiment.via = listed.via ?? null;
			// 候选来自宿主刚给的列表本身,不是写死的名字 —— 换台机器换个 profile 都成立。
			experiment.candidates = pickExperimentCandidates(listed.bundles, PKG);
			if (experiment.candidates.length === 0) {
				experiment.phase = 'failed';
				experiment.message = 'bundle 列表里没有可对照的第三方插件(需要已启用且可移除的非官方包)';
				return false;
			}
			const stateBefore = new Map();
			for (const name of experiment.candidates) {
				const found = listed.bundles.find((bundle) => bundle.name === name);
				stateBefore.set(name, found === undefined ? null : found.enabled === true);
			}
			experiment.candidateState = [...stateBefore.entries()].map(([name, enabled]) => ({ name, enabledBefore: enabled }));

			experiment.message = '等待会话空闲';
			const calmed = await waitForIdle(EXPERIMENT_IDLE_WAIT_MS);
			if (experiment.aborted === true) {
				experiment.message = '已中止(还没开始测量)';
			} else if (calmed === false) {
				// 等不到也照跑,但把"这次对照会被标注不可比"说在前面,不偷偷给数字。
				experiment.message = '一直有回合在跑,继续测量(各行会被标"不可比")';
			}
			startExperimentLoad();

			experiment.message = `基线窗口 0(${Math.round(BRACKET_MS / 1000)}s)`;
			// A/B/A:每个候选都跟"紧邻它前面的那个基线"对照,并在恢复后立刻再打一次基线 ——
			// 后者既验证"恢复是否真的回到原状",又提供基线漂移样本(噪声底)。
			let previousBase = await measureWindow('base', BRACKET_MS);
			experiment.baseline = previousBase;
			experiment.drifts = [];
			experiment.noise = null;

			try {
				const total = experiment.candidates.length;
				for (let position = 0; position < total; position += 1) {
					const name = experiment.candidates[position];
					const step = `${position + 1}/${total}`;
					if (experiment.aborted === true) break;
					const before = stateBefore.get(name);
					if (before === null) {
						experiment.results.push({ name, applied: false, reason: '不在 bundle 列表里(未安装或不是 bundle)' });
						continue;
					}
					if (before === false) {
						experiment.results.push({ name, applied: false, reason: '本来就是关闭状态,无法对比' });
						continue;
					}
					experiment.message = `${step} ${name}:关闭`;
					const off = await bundleOp('setBundle', { op: 'setBundle', name, enabled: false, confirm: true });
					const offApplied = off.ok === true && off.result?.application === 'applied';
					const row = {
						name,
						applied: offApplied,
						changeResult: off.result ?? null,
						error: off.ok === true ? null : off.error,
					};
					if (offApplied === false) {
						row.reason = `宿主没有真的关掉(${String(off.result?.application ?? off.error)})`;
						experiment.results.push(row);
						continue;
					}
					experiment.message = `${step} ${name}:测量窗口(${Math.round(STEP_MS / 1000)}s)`;
					row.window = await measureWindow(`off:${name}`, STEP_MS);
					experiment.message = `${step} ${name}:恢复`;
					const back = await bundleOp('setBundle', { op: 'setBundle', name, enabled: true, confirm: true });
					row.restore = {
						ok: back.ok === true && back.result?.application === 'applied',
						application: back.result?.application ?? null,
						error: back.ok === true ? null : back.error,
					};
					experiment.message = `${step} ${name}:恢复后基线(${Math.round(BRACKET_MS / 1000)}s)`;
					const base = await measureWindow('base', BRACKET_MS);
					row.afterBase = base;
					row.delta = experimentDelta(previousBase, row.window);
					row.drift = experimentDelta(previousBase, base);
					// 窗口里有流式渲染时,帧率与长任务都被别的东西主导,这种对照不可比。
					row.confounded = row.window.streaming === true || previousBase.streaming === true;
					experiment.drifts.push(row.drift);
					previousBase = base;
					experiment.results.push(row);
				}
			} catch (error) {
				experiment.message = `中断:${error instanceof Error ? error.message : String(error)}`;
			}

			stopExperimentLoad();
			experiment.message = experiment.aborted === true ? '中止:恢复原状' : '恢复原状并核验';
			const restores = await restoreCandidates(stateBefore);
			let after = null;
			try {
				after = await bundleOp('listBundles', { op: 'listBundles' });
			} catch (error) {
				after = null;
			}
			const diff = [];
			if (after !== null && after.ok === true && Array.isArray(after.bundles) && Array.isArray(experiment.original)) {
				for (const before of experiment.original) {
					const now = after.bundles.find((bundle) => bundle.name === before.name);
					if (now === undefined || now.enabled !== before.enabled) diff.push({ name: before.name, before: before.enabled, after: now === undefined ? null : now.enabled });
				}
			}
			experiment.restored = { restores, after: after !== null && after.ok === true ? after.bundles : null, diff, ok: diff.length === 0 };
			// 噪声底先算出来,再逐条判断"这个 Δ 是不是超出噪声"。
			experiment.noise = noiseFloor(experiment.drifts);
			for (const row of experiment.results) {
				if (row.delta === undefined || row.delta === null) continue;
				row.significant = significance(row.delta, experiment.noise);
			}
			experiment.phase = experiment.aborted === true ? 'aborted' : 'done';
			experiment.message = experiment.aborted === true ? '已中止并恢复' : `完成,恢复核验:${experiment.restored.ok ? '一致' : `有 ${experiment.restored.diff.length} 处不一致`}`;
			dirty = true;
			return true;
		}

		/** 最近 60 秒里最差的那一秒 —— 用来把"卡"对齐到具体时钟刻度。 */
		function worstSecond(seconds = 60) {
			const cutoff = Date.now() - seconds * 1000;
			let worst = null;
			for (const sample of ring) {
				if (sample.t < cutoff) continue;
				if (worst === null || (sample.frameMs ?? 0) > (worst.frameMs ?? 0)) worst = sample;
			}
			return worst;
		}

		const pad = (value) => String(value).padStart(2, '0');
		const clock = (ms) => {
			const date = new Date(ms);
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		};
		const mb = (bytes) => (bytes / 1048576).toFixed(1);

		function snapshot() {
			const worst = worstLongTask();
			return {
				plugin: PKG,
				exportedAt: new Date().toISOString(),
				// 自描述头:文件离开现场后仍能自证口径
				context: {
					scenario: state.streaming ? 'streaming' : 'idle',
					idleSeconds: state.idleSince === 0 ? 0 : Math.round((performance.now() - state.idleSince) / 1000),
					instrumented: state.on && state.deep === true,
					deep: state.deep === true,
					precise: {
						enabled: state.precise,
						bundles: [...bundleMaps.entries()].map(([key, entry]) => ({
							label: bundleLabel(key), state: entry.state, source: entry.source, sections: entry.count,
						})),
					},
					host: {
						route: HOST_ROUTE,
						reachable: state.hostError === null,
						error: state.hostError,
						profile: state.host === null || state.host === undefined ? null : state.host.profile ?? null,
						nodeVersion: state.host === null || state.host === undefined ? null : state.host.nodeVersion ?? null,
						pluginVersion: state.host === null || state.host === undefined ? null : state.host.pluginVersion ?? null,
					},
					isolation: { candidates: experiment.candidates, method: experiment.method, loadBurnMs: EXPERIMENT_LOAD_BURN_MS, loadPeriodMs: EXPERIMENT_LOAD_PERIOD_MS },
					// 判色阈值也写进文件:别人拿到 JSON 能按同一套口径重新解读
					recorder: selfStats(),   // 测量工具先自证没有明显改变被测对象
					// 证据的审计属性:拿到文件的人要能判断"这份证据被裁过没有、读回来的算不算数"。
					// 事故包的 context.watch 里本来就有这几个计数,这里补的是**整机导出件**那一份。
					store: {
						restored: state.watch.restored,          // 这次启动从落盘读回几条
						trimmedByBytes: state.watch.trimmedByBytes,   // 因为字节上限被裁掉的条数
						deduped: state.watch.deduped,            // 同一 id / 同一 at|cause 去重去掉的条数
						captured: state.watch.captured,          // 一共捕获过几次
						dropped: state.watch.dropped,            // 抓到了但没留存下来的次数
					},
					// A2:跨会话基线(每个会话一条,只进导出件)。口径写在 note 里
					sessionBaselines: sessionBaselines(),
					thresholds: {
						fps: { warnBelow: 50, errorBelow: 30 },
						frameMs: { warnAbove: 120, errorAbove: 200 },
						unattrPeakForUnexplainedFrame: 100,
						hostP99Ms: { warnAbove: 50, errorAbove: 200 },
						rttP99Ms: { warnAbove: 100, errorAbove: 300 },
					},
				},
				page: location.href,
				userAgent: navigator.userAgent,
				instrumented: state.on && state.deep === true,
				deep: state.deep === true,
				since: new Date(state.since > 0 ? state.since : Date.now()).toISOString(),
				summary: {
					fps: round1(state.fps),
					worstFrameMs: round1(state.frameWorst),
					attributedMsPerSec: round1(state.attributedPerSec),
					unattributedMsPerFrame: { avg: round1(state.unattrAvg), peak: round1(state.unattrPeak) },
					worstLongTask60s: worst === null ? null : {
						at: new Date(worst.t).toISOString(),
						ms: round1(worst.ms),
						owner: worst.owner,
						startTime: round1(worst.at),
					},
					domNodes: state.dom.total,
					domGrowthPerMin: round1(rate(state.dom.series)),
					heapUsedBytes: state.heap,
					heapGrowthPerMin: state.heap === null ? null : Math.round(rate(state.heapSeries)),
					domMutations: {
						total: state.mutations,
						sampledEvery: MUT_SAMPLE,
						perPlugin: domWriteTable(),
					},
					longTaskStats: { total: state.ltTotal, attributed: state.ltBlamed },
					worstSecondLast60s: worstSecond(),
					containers: TARGETS.map((target) => {
						const entry = state.targets.get(target.id);
						return {
							id: target.id,
							nodes: entry === undefined ? null : entry.nodes,
							growthPerMin: entry === undefined ? 0 : round1(rate(entry.series)),
						};
					}),
					plugins: pluginTable(),
				},
				// ── 三段取证 ────────────────────────────────────────────────
				// 1) 采样曲线:每秒一条 + 场景标记 + 空闲基线
				timeline: {
					note: '每秒一条(t 是 epoch ms):fps / 最差帧 / longtask 条数 / 节点 / 堆 / 归因 Top3;marks 是场景标记',
					samples: ring,
					last60s: ring.slice(-60),
					marks: state.marks,
					idleBaseline: state.idleBaseline,
				},
				// 2) longtask 明细:owner = 调度方包名,component = 渲染方组件名
				longTasks: {
					note: 'owner 来自调度点插桩,component 来自 fiber 上溯;source 标明这条靠哪边定的',
					total: state.ltTotal,
					attributed: state.ltBlamed,
					records: state.longTasks,
				},
				// 3) 隔离实验:逐插件关/开的因果对照与恢复核验
				isolation: {
					note: '每步带宿主真实回执(changeResult);applied:false 表示宿主没真的关掉,该步不产出 Δ',
					phase: experiment.phase,
					message: experiment.message,
					method: experiment.method,
					via: experiment.via,
					viaLabel: viaLabel(experiment.via),
					noiseFloor: experiment.noise,
					drifts: experiment.drifts,
					startedAt: experiment.startedAt > 0 ? new Date(experiment.startedAt).toISOString() : null,
					candidates: experiment.candidates,
					candidateState: experiment.candidateState,
					baseline: experiment.baseline,
					results: experiment.results,
					restored: experiment.restored,
				},
				host: {
					at: state.hostAt > 0 ? new Date(state.hostAt).toISOString() : null,
					error: state.hostError,
					last: state.host,
					eventWatch: state.hostEvents,
				},
				link: { stats60s: linkStats(), throughput: state.linkText, suspect: suspectLink(), samples: state.link.slice(-120) },
				// A4:交互延迟(event / element timing)。只进导出件,面板不显示
				interactions: {
					state: state.watch.eventState,
					supported: state.watch.eventSupported,
					thresholdMs: WATCH_EVENT_MS,
					events: state.watch.eventCount,
					elements: state.watch.elementCount,
					note: 'event 给端到端时长(ms)与推导出来的 waitMs(输入延迟)/ handlerMs(处理器本身);isInteraction 为真的才是 interactionId>0 的"真交互",pointerover 那类被动事件也会进来(它们的 ms 是到下一次渲染更新为止)。element 只观察带 elementtiming 属性的元素(DSH 的 DOM 上没有,恒为 0 是正常的)。帧内拆分(输入延迟/处理/呈现)页面内拿不到',
					kept: state.watch.interactions.length,
					records: state.watch.interactions,
				},
				verification: verification(),
				errors: state.errors,
			};
		}

		function exportJson() {
			flush(true);
			const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' }));
			const link = document.createElement('a');
			link.href = url;
			link.download = `perf-hud-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
			link.click();   // 不挂进 body:避免污染被统计的 DOM
			natives.setTimeout(() => URL.revokeObjectURL(url), 2000);
		}

		/**
		 * 事故包:一份给"读它的人(或 agent)"的自描述文件。
		 * 只放证据与口径,不做归因推断;并且**显式写出这次没拿到什么**(missing)以及怎么补齐 ——
		 * 沿用"不许假装成功"那条:缺的东西写清楚,比不写有用。
		 */
		/**
		 * 取一条事故:数字 = 按严重度的下标(0 最差),字符串 = id,`'latest'` = 时刻最新的那条。
		 * 面板上那个「导出最近一次」以前导的就是下标 0 —— 那是**最差**的一次,而落盘读回的旧事故
		 * 常常正是最差的,于是"最近一次"导出来的是一份几天前的证据(实测踩过两次)。
		 */
		function pickIncident(id) {
			const list = state.watch.incidents;
			if (id === 'latest') {
				let newest = null;
				for (const row of list) if (newest === null || row.at > newest.at) newest = row;
				return newest;
			}
			if (typeof id === 'number') return list[id] ?? null;
			return list.find((row) => row.id === id) ?? null;
		}

		function incidentReport(id) {
			const incident = pickIncident(id);
			if (incident === null || incident === undefined) return null;
			const missing = [];
			const howToAdd = [];
			if (state.watch.loafState !== 'on') {
				missing.push(`loaf:脚本级归因(这一层唯一的"谁"的来源)—— ${state.watch.loafState}`);
				howToAdd.push('LoAF 要 Chrome 123+ 且非 dsh-app:// 源;不满足时只能靠既有 longtask 明细与人工 trace');
			} else if (incident.summary.topScripts.length === 0) {
				missing.push('loaf-scripts:这一帧没有脚本(<5ms 的脚本不上报;Mac/Windows 桌面端 dsh-app:// 上恒为空)');
			} else if (incident.summary.pkgCoverage !== undefined && incident.summary.pkgCoverage.resolved < incident.summary.pkgCoverage.total) {
				// 用完整分布(summary.pkgVia),不要只数 topScripts —— 否则会写出"2/11 没定到(not-plugin×1)"这种自相矛盾的话
				const all = incident.summary.pkgVia ?? {};
				const unresolved = Object.entries(all).filter(([key]) => key !== 'url' && key !== 'section');
				missing.push(`loaf-pkg:${incident.summary.pkgCoverage.total - incident.summary.pkgCoverage.resolved}/${incident.summary.pkgCoverage.total} 条脚本没定到包名(${unresolved.map(([k, v]) => `${k}×${v}`).join(' · ') || '原因见 summary.pkgVia'})`);
			}
			if (state.on === false) {
				missing.push('instrumentation:四条腿的归因(没插桩就没有 DOM 写入与调度点包名)');
				howToAdd.push('打开 HUD(面板「开启」或 __perfHud.enable())');
			}
			if (incident.env.precise === false) {
				missing.push('precise:合并批次里的单包名 —— 也包含 LoAF 脚本的 scripts[].pkg(需要精确归因,会拉那份 12MB 的 map)');
				howToAdd.push('面板「深录」(它同时打开精确归因)或 __perfHud.setPrecise(true) —— 只能改善之后抓到的事故,这一条不会重放');
			}
			missing.push('devtools-trace:完整的 Chrome trace(页面内录不了)');
			// A4:交互延迟采到了什么、没采到什么,一律照实写
			if (state.watch.eventState !== 'on') {
				missing.push(`interaction-timing:交互延迟(event timing)—— ${state.watch.eventState}`);
				howToAdd.push('event timing 要 Chrome 96+;装不上时这一层给不出"点了多久才反应"');
			} else if (incident.summary.interactionsInWindow === 0) {
				missing.push(`interaction-timing:这个窗口里没有 ≥${WATCH_EVENT_MS}ms 的交互(阈值以下的事件不记;长时间没有真人操作也会是 0)`);
				howToAdd.push('复现时真的点几下(≥100ms 的交互才会进环形缓冲),再导出');
			}
			if (state.watch.elementCount === 0) {
				missing.push('element-timing:元素渲染时刻 —— `element` timing 只观察带 `elementtiming` 属性的元素,DSH 的 DOM 上没有这个属性,所以这一路恒为 0(照实记,不假装采到)');
			}
			missing.push('interaction-breakdown:单次交互内部"输入延迟 / 处理 / 呈现"的拆分 —— 页面内没有 API,这里只有端到端时长与 processingStart/End');
			howToAdd.push('要拆交互的三段:DevTools → Performance 录制,Hover 到 Interactions 轨道上那一下,看 Input delay / Processing / Presentation');
			howToAdd.push('DevTools → Performance → 录制(勾 include script source maps)→ Save trace → Perfetto 打开');
			missing.push('compositor:帧时间到底花在合成 / 光栅 / GPU 的哪一段(这一层只看得到主线程侧)');
			missing.push('recorder-cost:本记录器自身的开销**没带在这份事故包里**(它每帧跑一次 rAF 采样;面板「记录器自身」与整机导出件的 `context.recorder` 有 p99 / 峰 / 样本数)');
			// A2 落地之后剩下的缺口是"跨机器 / 跨浏览器",不再是"没有对照基线"
			missing.push('baseline:跨机器 / 跨浏览器的对照基线 —— context.sessionBaselines 只来自同一个浏览器 profile,而且只是粗参照');
			missing.push(incident.host === null
				? 'host:没有任何宿主快照(宿主半未加载或路由不可达)'
				: `host-cpuprofile:宿主进程的 CPU 火焰图**没有自动采** —— 路由已经能采(POST {op:'profileStart', seconds} / {op:'profileGet'},真宿主实测 1 秒 = 292 节点 / 223 采样 / 82KB),但客户端还没接线,要的话手动打一次;而这份宿主快照是${incident.host.snapshotAgeMs >= 0 ? `事故前 ${incident.host.snapshotAgeMs}ms` : `事故**后** ${-incident.host.snapshotAgeMs}ms`}采的(每 10 秒一次),未必覆盖卡顿瞬间;别把它当"宿主没问题"的证据`);
			howToAdd.push('零成本、当场可做:chrome://gpu 看是不是落到了软件渲染;DevTools → Rendering 打开 Frame Rendering Stats(FPS 表)与 Paint flashing —— 页面完全静止时帧率是否也上不去');
			howToAdd.push('判定"主线程之外":Performance 面板录 5 秒,看 Main 轨道自身的忙碌时间是否远小于墙钟 —— 注意 blocking=0 / scripts 为空**不能**当证据(见上面的读取说明),要看 Main 轨道本身');
			howToAdd.push('宿主火焰图:插件自带路由就能采 —— 带宿主 cookie(见 AGENTS §2.2)POST /api/dsh-perf-hud/host {op:"profileStart", seconds:5},再 POST {op:"profileGet"} 取回标准 .cpuprofile(speedscope 打开);退一步也可以 kill -USR1 <dsh web pid> → chrome://inspect → Performance → Record');
			return {
				plugin: PKG,
				kind: 'perf-hud-incident',
				schema: 2,                      // 2 = 脚本 URL 抽成 incident.urls + scripts[].u
				exportedAt: new Date().toISOString(),
				context: {
					page: location.href,
					userAgent: navigator.userAgent,
					scenario: state.streaming ? 'streaming' : 'idle',
					watch: watchStatus(),
					// A2:跨会话基线(只进导出件)。readonly 参照,别当回归判定
					sessionBaselines: sessionBaselines(),
					thresholds: {
						triggerMs: WATCH_TRIGGER_MS, gapMs: WATCH_GAP_MS,
						preMs: WATCH_PRE_MS, postMs: WATCH_POST_MS,
						keep: WATCH_INCIDENT_MAX, dailyDays: WATCH_DAILY_DAYS, keepMax: WATCH_KEEP_MAX,
						reactionMs: WATCH_REACTION_MS,
					},
					missing,
					howToAdd,
					howToRead: [
						'incident.env.utcOffsetMin 是采这份包时的本地时区偏移(分钟,UTC+8 = 480):把 at 加上它才是当时墙上钟的时间',
						'incident.frames:窗口内每一帧(t 是 perf 毫秒,要靠 incident.env.perfOrigin 换成墙钟;ms 是帧间隔;gap:true 表示 rAF 被挂起,不是卡顿)。首帧晚于 window.fromMs 是正常的,但**差得多就说明这一段被挂起过**(实测有一份晚了 6.3 秒,因为中间有一次 22.7 秒的 rAF 挂起)—— 去看 frames[].gap',
						'incident.loaf 与 incident.frames 是**同一信号的两个视图**(LoAF 的 t+dur 就落在某一帧上),不是两份独立证据:别相加,也别当互相印证',
						'incident.loaf[].blocking(blockingDuration)只累计"被归因到的 >50ms 长任务"的超出部分 —— **它可以是 0,而这一帧仍然有几百毫秒**。判严重度看帧间隔,blocking=0 不等于没卡',
						'incident.longTasks 是既有四条腿落在窗口内的明细(at=任务开始的 perf 毫秒,t=上报时刻的墙钟毫秒),**它不是慢帧清单**:条数通常远少于超线帧',
						'incident.interactions 是窗口内 ≥100ms 的交互(event / element timing):`ms` 是端到端(到下一次渲染更新为止),`waitMs` 是事件发生到处理器真正开始的输入延迟、`handlerMs` 是处理器本身(两个都是推导值,原始字段 processingStart/End 也在);`isInteraction` 为真的才是 interactionId>0 的真交互,pointerover 那类被动事件也会进来。**这一层不承诺帧内拆分**(输入延迟 / 处理 / 呈现得去 DevTools 的 Interactions 轨道看);`type: "element"` 的条目只可能来自带 `elementtiming` 属性的元素,DSH 页面上恒为 0',
						'incident.baseline 是**除这一段之外**整个帧环的分布(故意排除本窗口,否则"比会话最差还差"永远不成立)—— 拿它和 summary 比,才知道这一段是真的比平时差还是这台机器一直这样',
						'context.sessionBaselines 是**跨会话**的帧分布(每个会话一条,最多 20 条;只进导出件,面板不显示)。它是**粗参照,不是回归判定**:会话之间的负载、视口、是否插桩都不同,帧数量级也能差一个数量级 —— 只看"这次是不是比平时差一个量级",别拿它下"变慢了"的结论',
						'summary.worstFrameJs / suspectedThrottle:最差那一帧有没有 longtask / LoAF 与它重叠;若 none 且前后帧都健康(worstFrameNeighboursMs < 100),更像浏览器把 rAF 节流或挂起了一次,不是页面真忙了那么久',
						'脚本的 URL 不在脚本里:incident.urls 是字符串表,scripts[].u 是它的下标(u=-1 表示没有 URL)—— 抽表是因为同一个 combo URL 会重复几十遍',
						'scripts[].pkg 是这条脚本归属的包名(合并批里靠"字符位置 → 行号 → sourcemap 分段表"还原);pkg 为 null 时看 scripts[].pkgVia:url(单包 URL 直接读出来)/ section(分段表算出来)/ precise-off(精确归因没开)/ text-pending(脚本文本还在拉)/ not-plugin(宿主自己的 bundle)…',
						'incident.packages 是按包汇总的脚本耗时(降序),summary.pkgCoverage 是有名字的脚本占比 —— 覆盖率不到 100% 时别把第一行当成全部',
						'脚本侧再往下拆一层:scripts[].forcedMs(forcedStyleAndLayoutDuration)是脚本耗时里"强制样式布局"那部分 —— **它已经算在 ms 里**,别再相加;它是"来源是样式而不是业务逻辑"的同步布局。面板「取证明细」里那两行(脚本按包 / 纯 JS 与强制布局)就是这两件事',
						'incident.summary 是上面几块的汇总(含窗口自己的 p50/p90/p99),方便直接和 incident.baseline 比;这一层不做推断,结论请自己下',
						'context.watch.kept 按**严重度降序**,不是时间序;带 restored 的条目来自上一次会话(时间靠 env.perfOrigin 对齐),所以 id 与时间看起来会跳',
						'context.watch.kept[].tier 说明这条是靠哪一档留下来的:worst = 全局最差那一档(前 10 条)、daily = 它那一天最差的一条(最多留最近 7 天)、both = 两档都占。留存是**两档并集**,所以条数上限是 10 + 7 而不是 10 —— 单靠全局最差档时,"昨天下午那次卡"会被同一小时里的 10 次挤掉',
					],
				},
				incident,
			};
		}

		/** 下载一份事故包。返回 false 表示没这个 id(不静默成功)。 */
		/**
		 * 导出文件名:`perf-hud-20261008-220358-i84.json`。
		 * 用**事故发生的本地时间**(不是导出时间)——文件名要回答"这是哪一次",不是"我什么时候导的";
		 * ISO 的 `2026-10-08T14-03-58-490Z` 既难读又和面板上的时间对不上。日期在前可排序,
		 * 不含冒号(Windows 不允许)。完整 ISO 与 perfOrigin 都在文件体里。
		 */
		function incidentFileName(incident, at) {
			const d = at instanceof Date ? at : new Date(at);
			const p = (n) => (String(n).length < 2 ? `0${n}` : String(n));
			return `perf-hud-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${incident.id}.json`;
		}

		function exportIncident(id) {
			const report = incidentReport(id);
			if (report === null) return false;
			const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
			const link = document.createElement('a');
			link.href = url;
			link.download = incidentFileName(report.incident, report.incident.at);
			link.click();
			natives.setTimeout(() => URL.revokeObjectURL(url), 2000);
			return true;
		}

		function setEnabled(on) {
			try { localStorage.setItem(LS_ON, on ? '1' : '0'); } catch (error) { /* 记住开关是尽力而为 */ }
			if (on) start(); else stop();
			bump();
		}

		/**
		 * 插桩的装/卸。**只有深录档才装**(见 AGENTS §0.1 三种模式)—— 守夜与现场都不装,
		 * 面板上那几行回调归因在没装的时候如实写"未开插桩",而不是假装读数为 0。
		 * 还原时只在"当前仍是我们那份包装"时才写回,避免踩掉别人的包装(同 §5)。
		 */
		function applyProbeState() {
			const want = state.on === true && state.deep === true;
			if (want) {
				W.setTimeout = wrappers.timeout;
				W.setInterval = wrappers.interval;
				W.requestAnimationFrame = wrappers.raf;
				Node.prototype.appendChild = mutWrappers.appendChild;
				Node.prototype.insertBefore = mutWrappers.insertBefore;
				Element.prototype.setAttribute = mutWrappers.setAttribute;
				return;
			}
			if (W.setTimeout === wrappers.timeout) W.setTimeout = natives.setTimeout;
			if (W.setInterval === wrappers.interval) W.setInterval = natives.setInterval;
			if (W.requestAnimationFrame === wrappers.raf) W.requestAnimationFrame = natives.requestAnimationFrame;
			if (Node.prototype.appendChild === mutWrappers.appendChild) Node.prototype.appendChild = mutNatives.appendChild;
			if (Node.prototype.insertBefore === mutWrappers.insertBefore) Node.prototype.insertBefore = mutNatives.insertBefore;
			if (Element.prototype.setAttribute === mutWrappers.setAttribute) Element.prototype.setAttribute = mutNatives.setAttribute;
		}

		/** 深录开关:插桩 + 精确归因一起进出(两者是"要抓全"的同一件事)。 */
		function setDeep(on) {
			state.deep = on === true;
			try { localStorage.setItem(LS_DEEP, state.deep ? '1' : '0'); } catch (error) { /* 记不住就本次会话有效 */ }
			if (state.deep === false && state.precise === true) setPrecise(false);
			if (state.deep === true && state.precise === false) setPrecise(true);
			applyProbeState();
			dirty = true;
			bump();
		}

		function start() {
			if (state.on) return;
			state.on = true;
			applyProbeState();
			state.windowStart = performance.now();
			state.windowFrames = 0;
			state.lastFrameAt = 0;
			state.worstFrameMs = 0;
			state.fpsLoop = natives.requestAnimationFrame(frame);
			state.sampleTimer = natives.setInterval(sampleTick, 1000);
			state.domTimer = natives.setInterval(sampleDom, 2000);
			state.flushTimer = natives.setInterval(() => flush(false), 5000);
			state.ltObserver = startLongTask();
			state.watch.on = true;
			startLoaf();
			startInteractions();
			startDomWatch();
			sampleDom();
			probeLink('rtt');
			// 吞吐探针原来是首个 60 秒才跑,面板那一格会空一分钟看着像被截断 —— 先补一次。
			natives.setTimeout(() => probeLink('load'), 3000);
			state.linkTimer = natives.setInterval(() => probeLink('rtt'), RTT_INTERVAL_MS);
			state.loadTimer = natives.setInterval(() => probeLink('load'), LOAD_INTERVAL_MS);
		}

		function stop() {
			if (state.on === false) return;
			state.on = false;
			// 关掉 HUD 不能把插件留在"被隔离"的状态:正在跑的实验立刻走恢复流程。
			if (experiment.phase === 'running') abortExperiment();
			applyProbeState();   // state.on 已经置 false,这里必然走"卸"的分支
			natives.cancelAnimationFrame(state.fpsLoop);
			natives.clearInterval(state.sampleTimer);
			natives.clearInterval(state.domTimer);
			natives.clearInterval(state.flushTimer);
			natives.clearInterval(state.linkTimer);
			natives.clearInterval(state.loadTimer);
			stopDomWatch();
			if (state.ltObserver !== null) { state.ltObserver.disconnect(); state.ltObserver = null; }
			// 守夜层同样要能停下来:观察器 disconnect、等后摇的定时器清掉。
			// 已经留存的事故**不清** —— 那是等了很久才抓到的东西,关一次 HUD 不该丢。
			state.watch.on = false;
			if (state.watch.pendingTimer !== 0) { natives.clearTimeout(state.watch.pendingTimer); state.watch.pendingTimer = 0; }
			state.watch.pending = null;
			if (state.watch.loafObserver !== null) {
				state.watch.loafObserver.disconnect();
				state.watch.loafObserver = null;
				state.watch.loafState = 'stopped';
			}
			if (state.watch.eventObserver !== null) {
				state.watch.eventObserver.disconnect();
				state.watch.eventObserver = null;
				state.watch.eventState = 'stopped';
			}
			state.fps = 0;
			flush(true);
		}

		function round1(value) {
			return Math.round(value * 10) / 10;
		}

		// 挂到 window:便于控制台/自动化取数,导出的 JSON 与 __perfHud.snapshot() 同源。
		W.__perfHud = {
			get enabled() { return state.on; },
			snapshot,
			export: exportJson,
			table: pluginTable,
			ring,
			longTasks: state.longTasks,
			// 守夜层(见 §G):watch 给状态,incidents 给摘要(按严重度降序,索引 0 最差),
			// incident(id 或索引)给完整事件包,capture 手动标记"刚刚卡了一下"。
			watch: watchStatus,
			incidents: () => state.watch.incidents.map((row) => ({
				id: row.id, severity: row.severity, cause: row.cause, at: row.at, note: row.note, kept: row.kept, summary: row.summary,
			})),
			incident: pickIncident,   // 数字 = 下标(0 最差)/ id / 'latest' = 时刻最新
			capture: captureNow,
			/** 事故包:report(id) 拿对象(不下载),exportIncident(id) 触发下载。 */
			report: incidentReport,
			exportIncident,
			/** 只清事故,不动别的读数 —— 与 clear() 分开,免得手滑丢掉等了很久的证据。 */
			clearIncidents() {
				state.watch.incidents.length = 0;
				state.watch.captured = 0;
				state.watch.coalesced = 0;
				state.watch.dropped = 0;
				state.watch.restored = 0;
				state.watch.trimmedByBytes = 0;
				state.watch.deduped = 0;
				saveIncidents();   // 落盘的那份也要清掉,否则刷新又"复活"
				return true;
			},
			clear() {
				// 注意:守夜层留存的事故**不在这里清** —— 那是等了很久才抓到的东西,
				// 清读数的手滑不该把它带走。要清用 clearIncidents()。
				ring.length = 0;
				state.longTasks.length = 0;
				state.plugins.clear();
				state.domWrites.clear();
				state.mutations = 0;
				state.ltTotal = 0;
				state.ltBlamed = 0;
				state.ltNames.clear();
				state.ltLegs = { fiber: 0, subtree: 0, dom: 0, owner: 0, none: 0 };
				state.recent.length = 0;
				recentWrites.length = 0;
				state.lastTick = 0;
				state.dom.series.length = 0;
				state.heapSeries.length = 0;
				for (const entry of state.targets.values()) entry.series.length = 0;
				dirty = true;
				flush(true);
				bump();
			},
			enable() { setEnabled(true); },
			disable() { setEnabled(false); },
			get precise() { return state.precise; },
			setPrecise(on) { setPrecise(on === true); },
			mark: addMark,
			experiment: runExperiment,
			abortExperiment,
			baselines: () => ({ idle: state.idleBaseline, experiment: experiment.baseline }),
			/**
			 * 渲染型卡顿自测:一次提交里塞进 N 个节点,用来验收 fiber 归因。
			 *
			 * 两个坑都踩过:① 清理定时器(400ms)比面板重渲染间隔(500ms)还短,节点还没被渲染
			 * 就被清了 —— 表现是"点了毫无反应";② 节点在屏幕外,即使生效也没有任何可见反馈。
			 * 现在:立即触发一次重渲染,渲染完由子组件自己清空,并在面板上写明进度与结果。
			 */
			stress(nodes, burnMs) {
				const count = typeof nodes === 'number' && nodes > 0 ? Math.min(nodes, 80000) : 8000;
				// 实测:两万个节点连渲染带布局只要 ~28ms,靠节点数凑不出稳定的 >50ms 长任务。
				// 所以保留节点(给 DOM 写入归因用)再显式燃烧一段 —— 面板上会写明"含人为燃烧",
				// 这是仪器自检,不冒充自然卡顿。
				const burn = typeof burnMs === 'number' && burnMs >= 0 ? Math.min(burnMs, 500) : 80;
				state.stressNodes = count;
				state.stressBurn = burn;
				state.stress = {
					at: Date.now(),
					nodes: count,
					burnMs: burn,
					sync: flushSync !== null,
					commitMs: undefined,
					writes0: domWriteSnapshot(),
				};
				natives.setTimeout(() => { state.stressNodes = 0; }, 5000);
				const render = state.requestRender;
				if (typeof render !== 'function') return;
				if (flushSync !== null) {
					// 一次同步提交:整个 1.2 万节点都在同一个任务里,长任务与 fiber 归属才算数。
					try {
						flushSync(() => render());
						return;
					} catch (error) {
						state.stress.sync = false;   // flushSync 用不了就走普通重渲染
					}
				}
				render();
			},
			host: () => state.host,
			hostEvents(on) {
				if (on === false) {
					state.hostWatchOff = true;
					hostOp({ op: 'watchEvents', enable: false }).catch(() => {});
					return;
				}
				state.hostWatchOff = false;
				state.hostWatchAsked = false;
				return requestHostEventWatch();
			},
			link: () => state.link,
			verification,
		};

		/**
		 * 归因行的主值:本秒速率 + 峰值速率。
		 * 两个都要带 /s —— 实测 `0.5/s · 峰 17.8` 会被读成"峰值 17.8 毫秒",实际是 17.8 次/秒。
		 */
		function attrText(row) {
			return `${row.cps}${translate('perSec')} · ${translate('peak')} ${row.cpsPeak}${translate('perSec')}`;
		}

		/**
		 * 「其余」行:和上面三行**同一套单位**(本秒速率 + 本秒耗时),累计值收进悬停。
		 * 原来这行给的是累计次数/累计耗时,和上面的 `/s` 并排出现,同一张表两套单位 —— 必然读错。
		 */
		function restValueText(rows) {
			return `${round1(rows.reduce((sum, row) => sum + row.cps, 0))}${translate('perSec')} · ` +
				`${round1(rows.reduce((sum, row) => sum + row.msps, 0))}ms${translate('perSec')}`;
		}

		function restTitleText(rows) {
			const count = rows.reduce((sum, row) => sum + row.count, 0);
			const ms = rows.reduce((sum, row) => sum + row.ms, 0);
			return `${translate('restHint')}\n${translate('cumulative')} ${count}${translate('times')} / ${ms.toFixed(0)}ms`;
		}

		/** 合计耗时:小于 0.05ms/s 不写成 0 —— "0"读起来像"一点都没花",其实是四舍五入没了。 */
		function msPerSecText(value) {
			if (!(value > 0)) return '0ms/s';
			return value < 0.05 ? '<0.1ms/s' : `${round1(value)}ms/s`;
		}

		/**
		 * 标题栏的场景标签。
		 * "流式还是空闲"是解读所有数字的前提 —— 之前它只藏在工具箱的「空闲基线」里,
		 * 误判正是这么来的。所以它必须常显在标题栏。
		 */
		function sceneChip() {
			if (state.streaming) return { text: translate('running'), color: 'var(--dsw-alias-state-warn-primary)' };
			if (state.idleSince === 0) return { text: translate('idle'), color: 'var(--dsw-alias-label-secondary)' };
			return { text: `${translate('idle')} ${Math.round((performance.now() - state.idleSince) / 1000)}s`, color: 'var(--dsw-alias-label-secondary)' };
		}

		/**
		 * 未解释帧的自动结论。
		 * 触发条件:最差帧够长(≥100ms)且"帧内未归因"的峰值几乎等于它 —— 说明那一帧
		 * 完全没有 JS 回调能为它负责,开销在样式/布局/绘制/vsync 一侧。
		 */
		function unexplainedFrame() {
			// 没插桩时 `unattr` 就等于帧间隔(见 unattrText),这个判据会在**每一条**长帧上
			// 得出"几乎无 JS 解释"—— 那是假的:我们根本没测有没有 JS。所以先要求插桩。
			if (state.deep !== true) return null;
			const worst = state.frameWorst;
			if (!(worst >= 100) || worst <= 0) return null;
			const share = state.unattrPeak / worst;
			if (share < 0.95) return null;
			return { ms: round1(worst), percent: Math.round(share * 100) };
		}

		/** 宿主与链路的**判定**(不是只摆数字):两者都正常时直接说"链路已排除"。 */
		function infraVerdict() {
			const eventLoop = state.host === null || state.host === undefined ? null : state.host.eventLoop;
			const link = linkStats();
			if (state.hostError !== null) return { text: translate('hostDown'), color: 'var(--dsw-alias-state-warn-primary)', bad: true };
			const hostBad = eventLoop !== null && eventLoop.p99 > 50;
			const linkBad = link.count > 0 && link.p99 > 100;
			if (hostBad || linkBad) {
				const parts = [];
				if (hostBad) parts.push(translate('hostShort'));
				if (linkBad) parts.push(translate('linkShort'));
				return { text: `${parts.join(' / ')}${translate('suspectSuffix')}`, color: 'var(--dsw-alias-state-warn-primary)', bad: true };
			}
			return { text: translate('cleared'), color: 'var(--dsw-alias-state-success-primary)', bad: false };
		}

		/** 概览第一行:帧 + 长任务 + 命中(短,必须一行放得下)。 */
		function overviewLine1() {
			const worst = worstLongTask();
			// 命中率与"最差那条有没有归属"是两个口径:并列时必须当场说清,否则读者会拿
			// "命中 4/7"去解释"最差那条未归因",而这两件事互不相干(实测被这么读过)。
			const unblamed = worst !== null && primaryBlame(worst) === null ? `(${translate('worstOne')}:${translate('unblamed')})` : '';
			return `${translate('overviewFrame')} ${state.frameWorst.toFixed(0)}ms · LT ${worst === null ? translate('none') : `${worst.ms.toFixed(0)}ms`} · ${translate('hit')} ${state.ltBlamed}/${state.ltTotal}${unblamed}`;
		}

		/**
		 * 概览第二/三行:归属,以及(**只有提供信息时**才出现的)最多。
		 *
		 * 断行由我自己给(值节点是 white-space: pre-line):交给浏览器按宽度断,会断在
		 * `最多` 后面、把 `ChatView 22×` 甩到下一行 —— 实测被吐槽过一次。
		 * 另外:若"最多"与上面那个主名字相同,它只是把同一句话说两遍,直接不显示。
		 */
		function overviewLine2() {
			const worst = worstLongTask();
			const tally = longTaskTally();
			const blame = worst === null ? translate('none') : blameText(worst);
			const primary = worst === null ? null : primaryBlame(worst);
			const lines = [`${translate('overviewBlame')}:${blame}`];
			const leader = tally.topNames.length === 0 ? null : tally.topNames[0];
			if (leader !== null && leader[0] !== primary) {
				lines.push(`${translate('maxBlame')}:${short(leader[0])} ${leader[1]}×`);
			}
			return lines.join('\n');
		}

		/** 折叠组的一句话摘要:刻意短 —— 摘要自己换行会比正文更难看(实测)。 */
		/**
		 * 一个长动画帧的时间去哪了 —— 这是页面内能拿到的极限,LoAF 只给三个时间点:
		 *   [t, renderStart)              任务(含同步 JS)
		 *     ├─ scripts[].duration       被 LoAF 归到脚本的那部分(短于上报阈值的脚本不在内)
		 *     └─ taskOther                剩下的:没上报的短脚本 + 非脚本的任务开销
		 *   [renderStart, styleAndLayout) rAF 回调 / 渲染准备
		 *   [styleAndLayout, t+dur)       样式 + 布局 + 绘制/合成
		 * **绘制与合成分不开**(要分只能录 Chrome trace,那一项在缺失声明里)——
		 * 所以最后一段是"剩下的都在这儿",不要读成"样式布局占了多少"。
		 * 脚本自己再拆三层:纯执行 / 强制样式布局 / 暂停。后两者是 scripts[] 里的
		 * forcedStyleAndLayoutDuration 与 pauseDuration,**都已经算在 duration 里**,
		 * 所以它们是 duration 的分区,不能相加。
		 * 每一层都向下 clamp:每条脚本的毫秒各自 round1,脚本多而每条约 0.05ms 时,
		 * 求和会反过来超过父区间(四舍五入的算术后果,不是猜测)—— 分区图的子项
		 * 永远不许超过父项,否则画出来是负长度的弧。
		 */
		function frameSplit(row) {
			if (row === null || row === undefined || typeof row.dur !== 'number' || row.dur <= 0) return null;
			const start = row.t;
			const total = row.dur;
			const renderStart = typeof row.renderStart === 'number' && row.renderStart > start ? row.renderStart : null;
			const styleStart = typeof row.styleAndLayoutStart === 'number' && row.styleAndLayoutStart > start ? row.styleAndLayoutStart : null;
			let rawJs = 0;
			let rawForced = 0;
			let rawPause = 0;
			for (const script of row.scripts ?? []) {
				rawJs += script.ms ?? 0;
				rawForced += script.forcedMs ?? 0;
				rawPause += script.pauseMs ?? 0;
			}
			const head = renderStart === null ? total : renderStart - start;
			const js = round1(Math.min(rawJs, head));
			const forced = round1(Math.min(rawForced, js));
			const pause = round1(Math.min(rawPause, js - forced));
			const exec = round1(Math.max(0, js - forced - pause));
			const render = renderStart === null ? 0 : (styleStart === null ? total - head : styleStart - renderStart);
			const tail = Math.max(0, total - head - render);
			return {
				at: row.t,
				total: round1(total),
				head: round1(head),                 // 任务(含同步 JS)
				js: js,                             // 其中被 LoAF 归到脚本的部分(是 head 的子集)
				taskOther: round1(head) - js,       // 任务里没归到脚本的部分(与 js 相加正好等于 head)
				exec: exec,                         // 脚本 = 纯执行 + 强制样式布局 + 暂停
				forced: forced,
				pause: pause,
				render: round1(render),
				tail: round1(tail),
				blocking: round1(row.blocking ?? 0),
			};
		}

		/**
		 * 圆环的图例:两行、每行两段 —— 四个百分比挤一行在 396px 的面板里会折行(实测同类事故),
		 * 顺序与圆环从上往下的走向一致(脚本 → 任务 → 渲染 → 样式+布局+绘制)。
		 */
		function splitLegend(split) {
			const pct = (ms) => `${Math.round((ms / split.total) * 100)}%`;
			return [
				`${translate('splitScript')} ${pct(split.js)} · ${translate('splitTask')} ${pct(split.taskOther)}`,
				`${translate('splitRender')} ${pct(split.render)} · ${translate('splitTail')} ${pct(split.tail)}`,
			];
		}

		/**
		 * 圆环的**段**:脚本那一段再按「来源」切细(同一族的红,由深到浅 = 耗时降序),
		 * 后面照旧接 任务 / 渲染 / 样式+布局+绘制 —— 所以一个环上最多 3+1+3 = 7 段。
		 * 三条硬性:
		 *   ① **只做分区**:各段之和恒等于 `split.total`(脚本那几段之和用减法凑齐,
		 *      `其余` 那一段补足差额),否则弧会互相盖住;
		 *   ② 按来源的原始求和可能**大于**脚本那一段(frameSplit 把 js 夹到了 ≤ 任务段,
		 *      而渲染阶段跑的脚本也算在 `scripts[]` 里)—— 那种情况下按比例缩一下,保持分区;
		 *   ③ 颜色只给名字(`error` / `warn` / `brand` / `neutral`),token 由渲染那侧映射。
		 */
		function frameArcs(split, sources) {
			const rows = sources ?? [];
			const sum = rows.reduce((acc, [, ms]) => acc + ms, 0);
			const scale = sum > split.js && sum > 0 ? split.js / sum : 1;
			const shades = [1, 0.72, 0.46];
			const arcs = [];
			if (split.js > 0) {
				if (rows.length === 0) {
					arcs.push({ ms: split.js, color: 'error', opacity: 1 });
				} else {
					let used = 0;
					rows.slice(0, shades.length).forEach(([, ms], index) => {
						const value = round1(ms * scale);
						used += value;
						arcs.push({ ms: value, color: 'error', opacity: shades[index] });
					});
					const rest = round1(split.js - used);
					if (rest > 0) arcs.push({ ms: rest, color: 'error', opacity: 0.28 });
				}
			}
			// 任务里没归到脚本的那部分用中性灰:它现在和"脚本的四个红"同处一环,再用红会分不清
			arcs.push({ ms: split.taskOther, color: 'neutral', opacity: 1 });
			arcs.push({ ms: split.render, color: 'warn', opacity: 1 });
			arcs.push({ ms: split.tail, color: 'brand', opacity: 1 });
			return arcs;
		}

		/** 最近那条 blocking 最大的长动画帧(面板的饼图默认看的就是它)。 */
		function worstLoaf() {
			let best = null;
			for (const row of state.watch.loaf) if (best === null || (row.blocking ?? 0) > (best.blocking ?? 0)) best = row;
			return best;
		}

		/** 按 blocking 降序的帧清单(最差的排第一)。 */
		function loafRanks() {
			return state.watch.loaf.slice().sort((a, b) => (b.blocking ?? 0) - (a.blocking ?? 0));
		}

		/**
		 * 翻帧的清单:**只收值得回看的帧**(blocking ≥ `PICK_MIN_MS`)。
		 * 200 条里绝大多数是刚过 50ms 的边角帧,全列出来 ◀ ▶ 就成了体力活(实测 68 条里
		 * 真正想看的往往是个位数)。阈值取守夜那条触发线(`WATCH_TRIGGER_MS`),这样
		 * 「翻帧翻得到的」和「守夜留得下的」是同一批帧。
		 * 一条都不到线时**退回全部**(否则按钮点了像坏的),此时 `filtered:false`,面板不显示阈值。
		 */
		function pickList() {
			const all = loafRanks();
			const hot = all.filter((row) => (row.blocking ?? 0) >= PICK_MIN_MS);
			return hot.length === 0 ? { rows: all, filtered: false } : { rows: hot, filtered: true };
		}

		/**
		 * 面板**正在看**的那一条长动画帧:默认自动跟着最差那条走;用 ◀ ▶ 选过之后就钉住。
		 * 记的是 `t` 不是下标 —— 帧环会追加新的、挤掉老的,下标会指到别的帧上。
		 * 选中的那条被挤出 200 条之外就退回自动(并清掉选择),不指着一个不存在的帧。
		 */
		function pickedLoaf() {
			const rows = state.watch.loaf;
			if (rows.length === 0) return null;
			if (state.watch.pickT !== null) {
				const hit = rows.find((row) => row.t === state.watch.pickT);
				if (hit !== undefined) return hit;
				state.watch.pickT = null;
			}
			return worstLoaf();
		}

		/** ◀ ▶:在按 blocking 降序的清单里走一步(到头就停住)。 */
		function pickStep(delta) {
			const ranks = pickList().rows;
			if (ranks.length === 0) return;
			const current = pickedLoaf();
			const at = current === null ? -1 : ranks.findIndex((row) => row.t === current.t);
			const next = Math.min(ranks.length - 1, Math.max(0, (at === -1 ? 0 : at) + delta));
			state.watch.pickT = ranks[next].t;
			dirty = true;
			bump();
		}

		/** 回到自动(跟着最差那条走)。 */
		function pickAuto() {
			state.watch.pickT = null;
			dirty = true;
			bump();
		}

		// 面板上的 60 秒帧条:一格一秒。导出件那条 ASCII 条带是按事故窗口分格,这里按整秒 ——
		// "一格 = 那一段里最差的一帧"这个读法一致,阈值也逐条对应,所以两处能对着看。
		const SPARK_SECONDS = 60;
		const SPARK_HEIGHT = 18;
		const SPARK_MAX_MS = 200;    // 画满高度的帧间隔(再高也只是画满)

		/** 最近 SPARK_SECONDS 秒的分格数据:一格一秒,格值 = 那一格里最差那帧的间隔;间隙另标。 */
		function sparkBars(now) {
			const from = now - SPARK_SECONDS * 1000;
			const cells = [];
			for (let i = 0; i < SPARK_SECONDS; i += 1) cells.push({ ms: 0, seen: false, gap: false });
			for (const row of frameRing.slice(from, now)) {
				const index = Math.min(SPARK_SECONDS - 1, Math.max(0, Math.floor((row.t - from) / 1000)));
				const cell = cells[index];
				if (row.gap === true) { cell.gap = true; continue; }
				cell.seen = true;
				if (row.ms > cell.ms) cell.ms = row.ms;
			}
			return cells;
		}

		/**
		 * 一格算哪一档 —— 与导出件 ASCII 条带**逐条对应**:
		 * `█` ≥100ms → bad · `▒` ≥50ms → warn · `·` 其余 → ok · `_` 整格 rAF 间隙 → gap · 空格 没采到 → empty。
		 * 阈值改动必须两处一起改(logic.mjs 有一条断言专门核这件事)。
		 */
		function sparkLevel(cell) {
			if (cell.seen === true) {
				if (cell.ms >= 100) return 'bad';
				if (cell.ms >= 50) return 'warn';
				return 'ok';
			}
			return cell.gap === true ? 'gap' : 'empty';
		}

		/**
		 * 一个包名都没定到时那一行:**必须留下分母** —— 直接不显示会让人以为"按包"被删了
		 * (实测被这么问过)。给不出占比是因为没有名字就没有排行,不是没采。
		 */
		function pkgZeroText(frameScripts, windowScripts) {
			return `${translate('byPkg')}:${translate('pkgZeroNamed')}(${translate('scopeFrame')} ${frameScripts} · ${translate('windowScope')} ${windowScripts} ${translate('scriptsUnit')})· ${translate('needDeep')}`;
		}

		/**
		 * 一条脚本"是谁调起来的" —— LoAF 的 `invoker` 是一句 devtools 风格的调用点描述。
		 * 真页面抓到的形态(2026-10-08,一份 24 条脚本的事故):
		 *   `DOMWebSocket.onmessage`      ×19   会话事件流的消息处理器
		 *   `TimerHandler:setTimeout`     ×2    → setTimeout
		 *   `Response.json.then`          ×2    Promise 回调
		 *   `SCRIPT[src="plugins/??…"]`   ×1    → script(整串是 URL,放不下也没信息量)
		 * 归一规则:① `SCRIPT[…]` 收敛成 `script`;② 带冒号的取**最后一段**
		 * (`TimerHandler:setTimeout` → `setTimeout`);③ 还是太长就截断;
		 * ④ 没有 invoker 就退到 `invokerType`(user-callback / event-listener / …),
		 * 都没有才写"来源未记录"。
		 * 它只回答"哪一类调用",**不回答"函数里面慢在哪"** —— 函数级要采样器,页面内没有
		 * (JS Self-Profiling 被 Document Policy 挡着,实测 `new Profiler()` 抛 NotAllowedError)。
		 */
		function invokerLabel(script) {
			const raw = typeof script.invoker === 'string' ? script.invoker : '';
			let label = '';
			if (raw.startsWith('SCRIPT[')) label = 'script';
			else if (raw !== '') {
				const cut = raw.lastIndexOf(':');
				label = cut === -1 ? raw : raw.slice(cut + 1);
			}
			if (label === '') label = typeof script.invokerType === 'string' ? script.invokerType : '';
			if (label === '') return translate('invokerUnknown');
			return label.length > 28 ? `${label.slice(0, 27)}…` : label;
		}

		/**
		 * D5 二级:脚本侧往下拆一层 —— 一份汇总,两个分母共用:
		 *   ① 按包汇总脚本耗时(`script.url` 与事故包 `incident.packages` 走**同一条**
		 *      resolve 路:单包 URL 直接读出来,合并批按 sourcemap 分段还原);
		 *   ② 纯执行 / 强制样式布局 / 暂停:LoAF 的 forcedStyleAndLayoutDuration 是读布局、
		 *      写样式逼出来的同步布局,pauseDuration 是被同步 XHR / 对话框卡住的时间 ——
		 *      两者**都已经算在** duration 里(是分区,不是相加);
		 *   ③ 按 invoker 汇总:同一份脚本耗时的**另一种切法**(谁调起来的)。
		 * ②③ 与 ① 的关系:按包那份只覆盖"定得到包名"的脚本,按来源那份覆盖全部 ——
		 * 所以「按来源」的合计 = `js`,「按包」的合计 ≤ `js`,两者不是同一件事(有断言钉住)。
		 * 计量单位统一为"脚本毫秒",但 unresolved 计的是**条数**(不是毫秒)。
		 */
		function tallyScripts(rows) {
			const byPkg = new Map();
			const byOther = new Map();
			const byInvoker = new Map();
			let js = 0;
			let forced = 0;
			let pause = 0;
			let unresolved = 0;
			let unresolvedMs = 0;
			for (const row of rows) {
				for (const script of row.scripts ?? []) {
					js += script.ms ?? 0;
					forced += script.forcedMs ?? 0;
					pause += script.pauseMs ?? 0;
					const label = invokerLabel(script);
					byInvoker.set(label, (byInvoker.get(label) ?? 0) + (script.ms ?? 0));
					const resolved = packageOfScript(script.url, script.charPos);
					if (resolved.pkg === null) {
						unresolved += 1;
						unresolvedMs += script.ms ?? 0;
						const fallback = unresolvedLabel(script);
						byOther.set(fallback, (byOther.get(fallback) ?? 0) + (script.ms ?? 0));
						continue;
					}
					byPkg.set(resolved.pkg, (byPkg.get(resolved.pkg) ?? 0) + (script.ms ?? 0));
				}
			}
			return {
				js: round1(js), exec: round1(Math.max(0, js - forced - pause)), forced: round1(forced), pause: round1(pause), unresolved, unresolvedMs: round1(unresolvedMs),
				// 窗口那几行是**累计**,必须带回它的分母:条数与跨度。没有它,`纯执行 21623.8ms`
				// 会被读成"某一次执行花了 21 秒"(真被这么质疑过)—— 其实是 200 条长帧各百来毫秒攒起来的。
				count: rows.length,
				spanMs: rows.length === 0 ? 0 : Math.round(rows[rows.length - 1].t - rows[0].t),
				top: [...byPkg.entries()].sort((a, b) => b[1] - a[1]).map(([name, ms]) => [name, round1(ms)]),
				// 定不到插件包名的那部分:按**原因 / 文件名**汇总(不是笼统的"未定名")
				byOther: [...byOther.entries()].filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]).map(([name, ms]) => [name, round1(ms)]),
				// ms 为 0 的来源不进榜:它们没占时间,列出来只是噪声
				byInvoker: [...byInvoker.entries()].filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]).map(([name, ms]) => [name, round1(ms)]),
			};
		}

		/**
		 * 脚本侧三分(纯执行 / 强制样式布局 / 暂停):本帧那一行与窗口那一行共用同一份文案。
		 * 为 0 的那两项**不显示** —— 大多数帧里它俩就是 0,写出来只是噪声,还会把这一行挤成两行
		 * (实测窗口那行 `纯执行 1116.8ms · 强制 10.7ms · 暂停 0ms` 在 396px 里折过行)。
		 */
		function jsBreakdownText(tally) {
			const parts = [`${translate('jsExec')} ${tally.exec}ms`];
			if (tally.forced > 0) parts.push(`${translate('forcedShort')} ${tally.forced}ms`);
			if (tally.pause > 0) parts.push(`${translate('jsPause')} ${tally.pause}ms`);
			return parts.join(' · ');
		}

		/** 一段跨度写成人读得懂的:43分12秒 / 1小时3分 / 47秒(秒级以下不写)。 */
		function spanText(ms) {
			const total = Math.max(0, Math.round(ms / 1000));
			const hours = Math.floor(total / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			const seconds = total % 60;
			if (hours > 0) return `${hours}${translate('hourUnit')}${minutes}${translate('minUnit')}`;
			if (minutes > 0) return `${minutes}${translate('minUnit')}${seconds}${translate('secUnit')}`;
			return `${seconds}${translate('secUnit')}`;
		}

		/**
		 * 窗口那三行的**分母**:它们是"最近 N 条长动画帧"的累计,不是某一帧的时长。
		 * 平均每条那一栏才和上面那张饼可比(最差帧 341ms vs 平均 108ms = 这条帧比平时差 3 倍),
		 * 条数与跨度顺带回答"这段时间卡了多少次"。
		 */
		function windowScopeText(tally) {
			if (tally.count === 0) return translate('notYet');
			return `${translate('windowScope')}:${tally.count} ${translate('loafRows')} · ${translate('spanOver')} ${spanText(tally.spanMs)} · ${translate('avgPerFrame')} ${round1(tally.js / tally.count)}ms`;
		}

		/**
		 * 窗口聚合(最近 WATCH_LOAF_MAX 条 LoAF):按窗口指纹缓存 —— 每 tick 重算
		 * 200×12 条脚本,会让面板自己变成新的开销。
		 */
		const scriptTallyCache = { stamp: null, value: null };
		function scriptPkgTally() {
			const rows = state.watch.loaf;
			const stamp = rows.length === 0 ? 'x' : `${rows.length}|${rows[rows.length - 1].t}`;
			if (scriptTallyCache.stamp === stamp) return scriptTallyCache.value;
			const value = tallyScripts(rows);
			scriptTallyCache.stamp = stamp;
			scriptTallyCache.value = value;
			return value;
		}

		/**
		 * 单帧聚合(饼图看的那一条):与窗口聚合**同一份口径、不同分母** —— 面板上两行
		 * 分别标了"本帧"与"窗口",避免拿两种分母的数字互相印证。只有一条 LoAF 行,
		 * 不需要缓存(≤ WATCH_SCRIPT_MAX 条脚本)。
		 */
		function framePkgTally(row) {
			if (row === null || row === undefined) return null;
			return tallyScripts([row]);
		}

		/**
		 * "是谁"那一段文案:Top3 包 + 其余 + 定不到包名的条数(本帧与窗口两行共用)。
		 * 定不到包名时也要说 —— 只报"有名字的那部分"会让人把 200ms 当成这一层的全部
		 * (实测:窗口里 1116.8ms 脚本只有 200ms 定到了包,旧文案只写 `dsh-client-modules 200ms`)。
		 */
		/**
		 * 定不到**插件包名**时,尽量给一个认得出的名字 —— 统一写"未定名"是把已知信息丢掉:
		 *   · URL 为空(`no-url`)→ 真不知道:内联 / 动态构造的处理器;
		 *   · URL 在 `plugins/` 下但还没拆开(`precise-off` / 脚本文本或 map 还在拉)→ "插件批次",
		 *     它不是"没名字",只是还没按 sourcemap 分段还原;
		 *   · 其余(有 URL、但不是 plugins 路径)→ **多半是应用自己的外壳 bundle**
		 *     (实测 `/assets/index-<hash>.js` —— React 根容器上的事件处理器就来自它)。
		 *     直接用文件名标出来,比"未定名"有用得多。
		 */
		function unresolvedLabel(script) {
			const url = typeof script.url === 'string' ? script.url : '';
			if (url === '') return translate('srcNoUrl');
			if (ownerOfUrl(url) !== null) return translate('srcBatch');
			const parts = url.split('?')[0].split('/');
			const file = parts[parts.length - 1] === '' ? url : parts[parts.length - 1];
			return file.length > 28 ? `${file.slice(0, 27)}…` : file;
		}

		function pkgWhoText(tally) {
			const others = tally.byOther ?? [];
			const top = tally.top.slice(0, 3);
			const rest = tally.top.length - top.length;
			if (top.length === 0) {
				return `${translate('pkgNone')}${tally.unresolved === 0 ? '' : `(${translate('unblamed')} ${tally.unresolved})`}`;
			}
			// 定不到插件包名的那部分:能说出是什么就说(外壳文件名 / 无 URL / 插件批次)——
			// 只写"未定名 + 条数"既丢了已知信息,又和同一行里的 ms 混单位。
			return top.map(([name, ms]) => `${short(name)} ${Math.round(ms)}ms`).join(' · ')
				+ (rest > 0 ? ` · ${translate('rest')} ${rest}` : '')
				+ (others.length === 0 ? '' : ` · ${translate('otherSources')} `
					+ others.slice(0, 2).map(([name, ms]) => `${name} ${Math.round(ms)}ms`).join(' · ')
					+ (others.length > 2 ? ` · ${translate('rest')} ${others.length - 2}` : ''));
		}

		/**
		 * 「按来源」那一段文案:Top3 调用来源 + 其余(本帧与窗口两行共用)。
		 * 它与「按包」是同一份脚本耗时的**两种切法**:按来源覆盖全部脚本、按包只覆盖定到
		 * 包名的那部分 —— 两个合计不相等是正常的,别拿它们互相印证(要看 `js` 那个总数)。
		 */
		function invokerWhoText(tally) {
			const top = tally.byInvoker.slice(0, 3);
			const rest = tally.byInvoker.length - top.length;
			if (top.length === 0) return translate('none');
			return top.map(([name, ms]) => `${name} ${Math.round(ms)}ms`).join(' · ')
				+ (rest > 0 ? ` · ${translate('rest')} ${rest}` : '');
		}

		/** 60 秒帧条本体(约 100×18 的 SVG,只用 theme token)。 */
		function sparkStrip() {
			const cells = sparkBars(performance.now());
			const colors = {
				bad: 'var(--dsw-alias-state-error-primary)',
				warn: 'var(--dsw-alias-state-warn-primary)',
				ok: 'var(--dsw-alias-label-secondary)',
				gap: 'var(--dsw-alias-border-l2)',
			};
			const bars = [];
			for (let i = 0; i < cells.length; i += 1) {
				const level = sparkLevel(cells[i]);
				if (level === 'empty') continue;
				// 间隙画成最矮的一根:它是"这段时间没在测",不是"这段时间没卡"
				const height = level === 'gap' ? 2 : Math.max(2, Math.min(SPARK_HEIGHT, Math.round((cells[i].ms / SPARK_MAX_MS) * SPARK_HEIGHT)));
				bars.push(h('rect', { key: `s${i}`, x: i, y: SPARK_HEIGHT - height, width: 1, height, fill: colors[level] }));
			}
			return h('svg', {
				width: 100, height: SPARK_HEIGHT, viewBox: `0 0 ${SPARK_SECONDS} ${SPARK_HEIGHT}`, preserveAspectRatio: 'none',
				style: { flex: '0 0 auto' },
			}, bars);
		}

		/**
		 * 「帧内未归因」的值。⚠️ 它只在**插桩**下有定义:`idle = 帧间隔 − 插桩回调耗时`,
		 * 没插桩时 busy 恒为 0,这个数就退化成"平均帧间隔"(实测 16.7ms 被当成未归因 ——
		 * 那正好是 60fps 的帧间隔)。所以未插桩时不给数,直说需要深录。
		 */
		function unattrText() {
			if (state.deep !== true) return translate('needDeep');
			return `${state.unattrAvg.toFixed(1)}ms · ${translate('peak')} ${state.unattrPeak.toFixed(0)}ms`;
		}

		/**
		 * 「命中」那一行:四条腿**只列非零的** —— 没插桩时子树 / DOM写入 / 包名恒为 0,
		 * 全列出来就是 `245/0/0/0` 这种噪声。比率与概览同一口径(命中长任务数 / 长任务总数)。
		 */
		function hitText(tally) {
			const legs = [
				[translate('legFiber'), tally.fiber], [translate('legSubtree'), tally.subtree],
				[translate('legDom'), tally.dom], [translate('legOwner'), tally.owner],
			].filter(([, count]) => count > 0).map(([name, count]) => `${name} ${count}`);
			return `${translate('hit')} ${state.ltBlamed}/${state.ltTotal}`
				+ (legs.length === 0 ? '' : ` · ${legs.join('/')}`)
				+ (tally.none === 0 ? '' : ` · ${translate('unblamed')} ${tally.none}`);
		}

		function detailSummary() {
			const second = worstSecond();
			// 帧内未归因搬进这一组之后,它的数字要留在摘要上 —— 否则常显就更"瞎"了
			// 只留"结论对"(最差秒 + 未归因):加上 DOM 写入那一段,真实量级(五位数)会在 396px
			// 里挤成两行(实测截图),而 DOM 写入展开就能看到,不必占摘要。
			// 摘要里只留平均(带峰值会撑到两行 —— 预算断言钉着 ≤26 字);
			// 没插桩时那个数没意义(见 unattrText),摘要里直说要深录
			const unattr = state.deep === true ? `${state.unattrAvg.toFixed(0)}ms` : translate('needDeep');
			return `${translate('worstSecondShort')} ${second === null ? translate('none') : `${second.frameMs.toFixed(0)}ms`} · ${translate('unattrShort')} ${unattr}`;
		}

		function domSummary() {
			return `${state.dom.total}${translate('nodesSuffix')} ${rateText(state.dom.series)} · ${translate('messages')} ${containerNodes('messages')}`;
		}

		function hostSummary() {
			const eventLoop = state.host === null || state.host === undefined ? null : state.host.eventLoop;
			const link = linkStats();
			const host = state.hostError !== null ? translate('hostDown') : eventLoop === null ? translate('notYet') : `${eventLoop.p99}ms`;
			return `${translate('hostShort')} ${host} · ${translate('linkShort')} ${link.count === 0 ? translate('notYet') : `${link.p99}ms`} · ${infraVerdict().text}`;
		}

		/** 工具箱摘要:这一组现在只装守夜(事故清单 + 备注 + 导出),摘要就照它写。 */
		function toolsSummary() {
			const worst = state.watch.incidents.length === 0 ? null : state.watch.incidents[0];
			return worst === null
				? `${translate('watch')} ${translate('watchNone')}`
				: `${translate('watch')} ${state.watch.incidents.length}${translate('times')} · ${translate('watchWorst')} ${worst.severity.toFixed(0)}ms`;
		}

		/**
		 * 守夜层在面板上的那一行:抓到几次、最差多少、有几条是刷新后读回来的。
		 * 没抓到也照实说(把当前阈值写出来,免得读成"守夜没在工作")。
		 */
		function watchPanelText() {
			const watch = state.watch;
			if (watch.on === false) return translate('watchOff');
			if (watch.incidents.length === 0) return `${translate('watchNone')}(≥${WATCH_TRIGGER_MS}ms)`;
			const worst = watch.incidents[0];
			return `${translate('watchCaught')} ${watch.incidents.length}${translate('times')} · ${translate('watchWorst')} ${Math.round(worst.severity)}ms` +
				(watch.restored === 0 ? '' : ` · ${translate('watchRestored')} ${watch.restored}`) +
				(watch.trimmedByBytes === 0 ? '' : ` · ${translate('watchTrimmed')} ${watch.trimmedByBytes}`) +
				(watch.persistError === null ? '' : ` · ⚠️ ${translate('watchPersistFailed')}`);
		}

		/** 守夜层那一行的补充:最差那条事故是什么、什么时候、带没带备注。 */
		function watchLatestText() {
			const row = state.watch.incidents[0];
			if (row === undefined) return null;
			const at = Date.parse(row.at);
			return `${row.id} · ${row.cause} · ${Math.round(row.severity)}ms` +
				(Number.isFinite(at) ? ` · ${clock(at)}` : '') +
				(row.note === null || row.note === undefined ? '' : ` · ${row.note}`);
		}

		/** 工具箱里的一条事故:`1. i7 · frame · 326ms · 14:48 · 读回`。 */
		function watchRowText(row, index) {
			const at = Date.parse(row.at);
			return `${index + 1}. ${row.id} · ${row.cause} · ${Math.round(row.severity)}ms` +
				(Number.isFinite(at) ? ` · ${clock(at)}` : '') +
				(row.restored === true ? ` · ${translate('watchRestored')}` : '') +
				// 靠"每天最差"那一档留下的要标出来,否则读者会奇怪它为什么没被更差的事故挤掉
				(row.tier === 'daily' ? ` · ${translate('watchDaily')}` : '') +
				(row.note === null || row.note === undefined ? '' : ` · ${row.note}`);
		}

		/** 概览的 hover:把口径(四条腿)与名字分布都摊开,免得只看到一个被抬高的命中率。 */
		function overviewTitle() {
			const tally = longTaskTally();
			return `${translate('overviewHint')}\n` +
				`${translate('hit')} = 四条腿任一命中:${translate('legFiber')} ${tally.fiber} · ${translate('legSubtree')} ${tally.subtree} · ${translate('legDom')} ${tally.dom} · ${translate('legOwner')} ${tally.owner} · ${translate('unblamed')} ${tally.none}` +
				(tally.topNames.length === 0 ? '' : `\n${translate('topBlame')}: ${tally.topNames.map(([name, count]) => `${name} ${count}×`).join(' · ')}`) +
				// B1:记录器自己单列,并且**明说它不在这张榜里参与排名**
				(tally.selfTotal === 0 ? '' : `\n${translate('recorder')}(${translate('blameSelfHint')}): ${tally.self.map(([name, count]) => `${name} ${count}×`).join(' · ')}`);
		}

		/** 折叠摘要里的一句话节点数:取不到就如实说未采集。 */
		function containerNodes(id) {
			const entry = state.targets.get(id);
			return entry === undefined || entry.nodes === null ? translate('notYet') : String(entry.nodes);
		}

		/**
		 * 面板"需要重渲染"的指纹:只包含面板真正显示的数值。
		 * 没变就跳过 500ms 的强制渲染 —— 全部折叠、数值不动时,HUD 自身开销应当接近零。
		 * (500ms 定时器本身不贵,贵的是一次 React 渲染 + 上万次 DOM 读。)
		 */
		function displayKey() {
			const tally = longTaskTally();
			const rows = pluginTable();
			return [
				state.on ? 1 : 0, state.precise ? 1 : 0, state.collapsed ? 1 : 0,
				state.fps.toFixed(1), state.frameWorst.toFixed(0), state.unattrAvg.toFixed(1), state.unattrPeak.toFixed(0),
				state.ltTotal, state.ltBlamed, state.longTasks.length,
				state.dom.total, state.mutations, state.heap ?? 'x',
				state.streaming ? 1 : 0, state.idleSince === 0 ? 0 : Math.round((performance.now() - state.idleSince) / 1000),
				rows.slice(0, TOP_N).map((row) => `${row.id}:${row.cps}:${row.cpsPeak}`).join(','),
				`${tally.fiber}/${tally.subtree}/${tally.dom}/${tally.owner}/${tally.none}`,
				tally.topNames.map((row) => `${row[0]}:${row[1]}`).join(','), tally.selfTotal,
				state.host === null || state.host === undefined ? 'x' : `${state.host.eventLoop?.p50}/${state.host.eventLoop?.p99}/${state.hostError}`,
				linkRowText(), state.loadState, state.linkText,
				experiment.phase, experiment.message, experiment.results.length, experiment.restored === null ? 0 : 1,
				state.marks.length, state.errors.length, state.stressNodes > 0 ? 1 : 0, state.baselineRunning ? 1 : 0,
				unexplainedFrame() === null ? 0 : 1, infraVerdict().text,
				Object.values(state.groups).map((value) => (value ? 1 : 0)).join(''),
				// 60 秒帧条:它每秒都在滚(老格子出窗口、新格子进来),而其它数字可能几百秒不动 ——
				// 不放进指纹的话,展开着也会冻在打开那一刻。用 5 秒刻度而不是每帧算一遍条子,
				// 是为了不让"面板自己的开销"变成每 tick 遍历 3600 帧。
				Math.floor(performance.now() / 5000),
			].join('|');
		}

		/** 用户动作 → 立刻重渲染并刷新指纹(动作必须即时反馈,不能等 0.5 秒)。 */
		function bump() {
			state.displayKey = displayKey();
			if (typeof state.requestRender === 'function') state.requestRender();
		}

		/** 折叠/展开一个分组,并把选择记住。 */
		function toggleGroup(key) {
			if (Object.hasOwn(state.groups, key) === false) return;
			state.groups[key] = state.groups[key] !== true;
			try { localStorage.setItem(LS_GROUPS, JSON.stringify(state.groups)); } catch (error) { /* 记不住就本次会话有效 */ }
			bump();
		}

		/**
		 * 一个可折叠分组:收起时头部**必须**带一句话摘要 —— 收起不等于丢信息,
		 * 而是把"过程/取证"这类不常看的行换成一行结论。
		 */
		function group(key, label, summary, ...children) {
			const isOpen = state.groups[key] === true;
			return h('div', { style: S.sep },
				h('div', {
					style: { ...S.row, cursor: 'pointer' },
					title: isOpen ? translate('collapse') : translate('expand'),
					onClick: () => toggleGroup(key),
				},
					h('span', { style: S.label }, `${isOpen ? '▾' : '▸'} ${label}`),
					h('span', { style: S.num }, summary)),
				isOpen ? h('div', null, children) : null);
		}

		/** 精确归因开关:开启时立刻把已经见过的多包 URL 排队解析。 */
		function setPrecise(on) {
			state.precise = on === true;
			try { localStorage.setItem(LS_PRECISE, state.precise ? '1' : '0'); } catch (error) { /* 记不住就本次会话有效 */ }
			if (state.precise) primeBundleMaps();
			dirty = true;
			bump();
		}

		// ───────────────────────────────── 文案 ─────────────────────────────────
		const DICT = {
			zh: {
				title: '性能 HUD', off: '已关', turnOn: '开启', turnOff: '关闭',
				frameWorst: '最差帧', blame: '回调归因(耗时)',
				rest: '其余', dom: 'DOM 节点', none: '无', exportJson: '导出 JSON', clear: '清空',
				collapse: '折叠', expand: '展开', sessions: '会话列表', messages: '消息区', perMin: '/分',
				unattr: '帧内未归因', peak: '峰',
				unattrHint: '帧间隔里没被插桩回调解释掉的部分:样式重算、绘制、以及等待 vsync。CSS 动画的开销只在这里现形。',
				rateWindow: '速率近12s', heap: 'JS 堆(近60s)', domWrites: 'DOM 写入(按插件)', est: '≈',
				worstSecond: '最差那秒', hit: '命中', times: ' 次',
				maxBlame: '整窗最多', topBlame: '归属 Top', blameSelfHint: '本记录器自己的回调,不算在上面那张榜里', legFiber: 'fiber', legSubtree: '子树', legDom: 'DOM写入', legOwner: '包名',
				blameHint: '本秒执行速率 / 峰值速率(EMA 平滑后的每秒执行次数)与合计耗时;悬停某一行看它的执行次数、同步耗时与累计',
				restHint: '其余 = 除 Top3 之外还有几个归属方(名字各不相同,按累计耗时排在后面);这一行给的是它们的合计速率',
				cnExec: '该秒执行', cnCost: '该秒同步耗时',
				cnScope: '口径:只含 setTimeout/setInterval/requestAnimationFrame 这三次调度的回调;事件处理器 / Promise / 微任务 / React 自身调度不计入,所以这是下界',
				perSec: '/s', samples: '次采样', unblamed: '未归因',
				domWritesHint: '前一项是精确总次数;下面按插件给出估算(每 10 次采样一次栈,命中按 10 折算)。',
				component: '组件', cumulative: '累计',
				overview: '概览', overviewHint: '三秒判断:最差帧 + 最差 longtask 及其归属 + 归因命中数',
				overviewFrame: '帧', overviewBlame: '最差那条', worstSecondShort: '最差秒', hostShort: '宿主',
				deepShort: '深录', deepHint: '深录(= 插桩 + 精确归因):装上调度点与 DOM 写入的包装,并拉那份 12MB 的 sourcemap。默认关着 —— 守夜与现场都不插桩',
				recorder: '记录器自身', recorderHint: '每帧给这个 HUD 自己的 rAF 回调计时:测量工具必须自证没有明显改变被测对象。p99 取最近 600 帧',
				split: '帧里花在哪', splitTotal: '这段长动画帧共', splitWorst: '最差那条',
				framePick: '帧', framePinned: '已钉住(点 ⟲ 回到自动)', framePickAuto: '自动:跟着最差那条走',
				frameAutoHint: '回到自动(跟着最差那条走)',
				framePickHint: '最近 200 条长动画帧里**值得回看的那些**(blocking ≥ 100ms,与守夜触发线同一条),按 blocking 降序、最差的在前。◀ ▶ 换一条,⟲ 回到自动;选中的那条被挤出 200 条之后会自动退回。一条都不到 100ms 时这里退回显示全部',
				framePickFiltered: '值得回看的帧',
				spark: '60 秒帧条',
				sparkHint: '最近 60 秒,一格一秒:高度 = 那一秒里最差那一帧的间隔,颜色与导出件的 ASCII 帧条带用同一组阈值(≥100ms 红 / ≥50ms 黄 / 其余正常)。整格都是 rAF 挂起的那一秒画成最矮的灰柱 —— 那是间隙,不是卡顿;空白 = 那一秒没采到',
				pkgNone: '未定名',
				pkgHint: '最近这段 LoAF **窗口**里(不是上面那一帧),脚本耗时按包汇总(与事故包 incident.packages 同一条 resolve 路:单包 URL 直接读出来,合并批按 sourcemap 分段还原)。合并批里没开「精确」就只能给到那个 58 包的批 URL,这是刻意的,不硬猜',
				forcedLayout: '强制样式布局', forcedShort: '强制',
				forcedHint: 'LoAF 的 forcedStyleAndLayoutDuration:读布局 / 写样式逼出来的同步布局。它**已经算在**脚本耗时里,来源却是样式而不是业务逻辑 —— 分不清"这块是 JS 慢还是样式慢"时看这一行。这一行是**窗口**聚合',
				splitScript: '脚本', splitTask: '任务', splitRender: '渲染', splitTail: '样式+布局+绘制',
				splitJs: '脚本细拆', jsExec: '纯执行', jsPause: '暂停', scopeFrame: '本帧',
				bySource: '按来源', byPkg: '按包', pkgZeroNamed: '0 条定到名', scriptsUnit: '条脚本', needDeep: '要深录', invokerUnknown: '来源未记录',
				otherSources: '其余来源', srcNoUrl: '无 URL(内联脚本)', srcBatch: '插件批次(未按 sourcemap 拆)',
				windowScope: '窗口', loafRows: '条长动画帧', spanOver: '跨', avgPerFrame: '平均每条脚本',
				hourUnit: '小时', minUnit: '分', secUnit: '秒',
				windowScopeHint: '下面三行是**累计**:最近 200 条**长动画帧**(LoAF 只报 >50ms 的帧)的脚本耗时加总,不是某一帧的时长 —— 200 条各百来毫秒,累计就是二十几秒。**只有"平均每条脚本"那一栏和上面那张饼可比**(饼是单帧);条数与跨度顺带回答"这段时间卡了多少次"。跨度越久,累计越大,别拿它当"越来越慢"',
				invokerHint: 'LoAF 的 scripts[].invoker:这条脚本是**谁调起来的** —— setTimeout / rAF、某个事件处理器(实测最多的是 `DOMWebSocket.onmessage`,即会话事件流)、Promise 回调、脚本加载。它与「按包」是同一份脚本耗时的两种切法:按来源覆盖全部脚本,按包只覆盖定得到包名的那部分(所以合计不相等是正常的,总数看上面的脚本耗时)。⚠️ 它只回答"哪一类调用",不回答"函数里面慢在哪" —— 函数级要 Chrome trace,页面内没有采样器',
				splitJsHint: '脚本自身的三分:纯执行 / 强制样式布局(读布局、写样式逼出来的同步布局)/ 暂停(同步 XHR、对话框把它卡住的时间)。三者都是 scripts[].duration 的分区内,**相加 = 脚本耗时**,不是另加的。这一行是上面那张饼的**同一帧**',
				splitNoLoaf: '暂时没有(要等到一条 >50ms 的长动画帧;LoAF 只报 50ms 以上的)',
				splitHint: 'LoAF 的三个时间点能拆出来的极限。环上最多 7 段:脚本那一段再按**调用来源**(invoker,与下面「本帧按来源」同一个顺序)切成最多 4 块 —— 同一族的红、由深到浅;任务里没归到脚本的那部分是**灰的**;再往后是渲染(rAF 回调)与样式+布局+绘制。段与段之间留了 1.4px 缝(同一族的红靠缝才看得出是几块),小段扣不起缝就不扣。**绘制与合成分不开**,所以最后一段是"剩下的都在这儿",别读成"样式布局占了多少";要分开只能录 Chrome trace',
				worstOne: '最差那条',
				unexplained: '该帧几乎无 JS 解释', unexplainedHint: '样式/布局/绘制/vsync;可用 Rendering 面板的 Paint flashing 交叉验证',
				verdict: '判定', linkShort: 'RTT', suspectSuffix: ' 存疑', cleared: '链路已排除(宿主与隧道均正常)',
				groupDetail: '取证明细', groupDom: 'DOM 与堆', groupHost: '宿主与链路', groupTools: '工具箱', nodesSuffix: ' 节点',
				stream: '状态', running: '流式', idle: '空闲', idleBase: '空闲基线(60s)', idleWriter: '空闲也在加节点的是',
				notYet: '未采集', hostLoop: '宿主 event-loop',
				notApplicable: '不适用(窗口含流式)', hostDown: '宿主不可用', link: '链路 RTT',
				hostEvents: '宿主事件到达', hostEventsHint: '宿主半用公开接口 ctx.on(\'session/event\') 记每条事件「提交(event.time)→到达监听器」的延迟;第一版想包 Context.emit,线上实测根本抓不到(该事件走带作用域过滤的派发),故改口径且写明',
				notInstalled: '未安装', waiting: '已装,等事件',
				sampling: '吞吐采样中', failed: '吞吐失败',
				renderError: '面板渲染出错', retry: '重试',
				renderErrorHint: '采集没停:上面是错误原文;点「重试」恢复面板,或直接导出(errors 段里也有)',
				linkHint: '每 10 秒一次 1KB 同源探测(带 cache-buster)算 RTT,n 是最近 60 秒的样本数;吞吐每 60 秒一次 64KB(启动后 3 秒先补一次)。p99 > 300ms 且 FPS 正常且 n≥2 才判「疑似链路」',
				suspect: '疑似链路',
				stressRunning: '自测进行中', stressDone: '自测结果', nodes: '节点',
				stressNoTask: '未观察到长任务', stressCommit: '提交', stressBurn: '人为燃烧', stressSync: '同步', stressSliced: '切片', stressNoFlush: 'flushSync 不可用', stressFromDom: 'DOM 写入',
				via: '通道', viaRemote: 'ctx.remote(客户端 remote)', viaRoute: '宿主路由 /api/dsh-perf-hud/host',
				unattrShort: '未归因', markPlaceholder: '备注(可选)',
				// 守夜层(默认常开、不插桩):面板上只露一行状态 + 工具箱里的清单与两个按钮
				watch: '守夜', watchCaught: '抓到', watchWorst: '最差', watchRestored: '读回',
				watchDaily: '当天最差',
				watchNone: '还没抓到', watchOff: '未开录', watchPersistFailed: '落盘失败', watchTrimmed: '裁掉',
				watchHint: '默认常开、不插桩:一个 rAF 循环 + 一个 LoAF 观察器。帧间隔(或 LoAF 的 blockingDuration)超过 100ms 就自动抓「前 10 秒 + 后 3 秒」原样切片,留存取**两档并集**:全局最差 10 次 + 每天最差 1 条(最多最近 7 天,清单里标「当天最差」),刷新后还在;落盘另有 2MB 上限,超了就裁掉最弱的并在这一行标出「裁掉 N」。要抓偶发卡顿就让它一直开着 —— 出事后用「导出最近一次」把证据包交给分析者。',
				watchMark: '标记刚才', watchMarkHint: '手动记一次「刚刚卡了一下」:自动回退 3 秒(人的反应时间),立刻切片,并把上面输入框的备注原样写进证据包',
				watchExport: '导出最近一次', watchExportHint: '下载**时刻最新**那一条的完整证据包(帧序列 + LoAF + 窗口内 longtask + 环境与缺失声明;不是最差那条)。要别的:__perfHud.exportIncident(\'i55\') 按 id、或 exportIncident(0) 取最差的',
				watchManualNote: '手动标记',
			},
			en: {
				title: 'Perf HUD', off: 'off', turnOn: 'on', turnOff: 'off',
				frameWorst: 'worst frame', blame: 'attribution (time)',
				rest: 'rest', dom: 'DOM nodes', none: 'n/a', exportJson: 'Export JSON', clear: 'Clear',
				collapse: 'Collapse', expand: 'Expand', sessions: 'Sessions', messages: 'Messages', perMin: '/min',
				unattr: 'unattributed/frame', peak: 'peak',
				unattrHint: 'Frame gap not explained by instrumented callbacks: style recalc, paint, and vsync wait. CSS-animation cost only shows up here.',
				rateWindow: 'rate 12s', heap: 'JS heap (60s)', domWrites: 'DOM writes (by plugin)', est: '≈',
				worstSecond: 'worst second', hit: 'hit', times: '',
				maxBlame: 'window top', topBlame: 'attribution top', blameSelfHint: 'the recorder\'s own callbacks, not part of the list above', legFiber: 'fiber', legSubtree: 'subtree', legDom: 'DOM write', legOwner: 'package',
				blameHint: 'Per-second execution rate / peak rate (EMA-smoothed) plus the summed synchronous time; hover a row for its execution count, cost and cumulative totals',
				restHint: 'rest = how many further owners fall outside the top 3 (distinct names, ranked by cumulative time); this row shows their combined rate',
				cnExec: 'executed this second', cnCost: 'sync time this second',
				cnScope: 'Scope: only callbacks scheduled through setTimeout/setInterval/requestAnimationFrame; event handlers, Promises, microtasks and React\'s own scheduling are not counted, so this is a lower bound',
				perSec: '/s', samples: ' samples', unblamed: 'unattributed',
				domWritesHint: 'First number is the exact total; the rows below are estimates (stacks sampled every 10th write, hits scaled by 10).',
				component: 'component', cumulative: 'total',
				overview: 'overview', overviewHint: 'Three-second read: worst frame + worst longtask and its owner + attribution hit ratio',
				overviewFrame: 'frame', overviewBlame: 'worst one', worstSecondShort: 'worst sec', hostShort: 'host',
				deepShort: 'deep', deepHint: 'Deep = instrumentation + precise attribution: wraps scheduling points and DOM writes and fetches the 12MB sourcemap. Off by default',
				recorder: 'HUD itself', recorderHint: 'Times this HUD own rAF callback: a measuring tool must prove it does not change what it measures. p99 over the last 600 frames',
				split: 'where the frame went', splitTotal: 'long frame total', splitWorst: 'worst',
				framePick: 'frame', framePinned: 'pinned (⟲ returns to auto)', framePickAuto: 'auto: follows the worst',
				frameAutoHint: 'back to auto (follow the worst)',
				framePickHint: 'Out of the last 200 long animation frames, only the ones **worth reviewing** (blocking ≥ 100ms, the same line the night watch triggers on), worst first. ◀ ▶ flips through them, ⟲ returns to auto; a pinned frame falls back once it leaves the 200-frame ring. When nothing reaches 100ms this falls back to showing all of them',
				framePickFiltered: 'frames above the line',
				spark: '60s frame strip',
				sparkHint: 'Last 60 seconds, one bar per second: height = the worst frame interval in that second, and the colours use the same thresholds as the ASCII frame strip in the export (>=100ms red / >=50ms yellow / otherwise normal). A second that was all rAF suspension is the shortest grey bar — a gap, not a stall; blank = nothing sampled in that second',
				pkgNone: 'unnamed',
				pkgHint: 'Script time in the recent LoAF **window** (not the single frame above), summed per package (the same resolve path as incident.packages: read straight off single-package URLs, restored from sourcemap sections for combo batches). Without precise attribution a combo batch can only be named as its 58-package batch URL — that is deliberate, nothing is guessed',
				forcedLayout: 'forced style+layout', forcedShort: 'forced',
				forcedHint: 'LoAF forcedStyleAndLayoutDuration: synchronous layout forced by reading layout or writing style. It is **already inside** script time, but it comes from styling rather than business logic — read this row when you cannot tell whether the script side is slow because of JS or because of style. This row is the **window** aggregate',
				splitScript: 'script', splitTask: 'task', splitRender: 'render', splitTail: 'style+layout+paint',
				splitJs: 'script split', jsExec: 'exec', jsPause: 'paused', scopeFrame: 'this frame',
				bySource: 'by source', byPkg: 'by package', pkgZeroNamed: '0 resolved', scriptsUnit: 'scripts', needDeep: 'needs deep', invokerUnknown: 'source not recorded',
				otherSources: 'other sources', srcNoUrl: 'no URL (inline)', srcBatch: 'plugin batch (not split)',
				windowScope: 'window', loafRows: 'long frames', spanOver: 'over', avgPerFrame: 'avg script per frame',
				hourUnit: 'h', minUnit: 'm', secUnit: 's',
				windowScopeHint: 'The three rows below are a **cumulative** sum: script time across the last 200 **long animation frames** (LoAF only reports frames >50ms), not the duration of any single frame — 200 frames of ~100ms each add up to tens of seconds. **Only "avg script per frame" is comparable to the donut above** (that is a single frame); the count and span answer "how often did it stall in that period". A longer span means a bigger total, so do not read it as "it is getting slower"',
				invokerHint: 'LoAF\'s scripts[].invoker: what invoked this script — setTimeout / rAF, an event handler (the most common one here is `DOMWebSocket.onmessage`, the session event stream), a promise callback, a script load. It and "by package" are two slicings of the same script time: "by source" covers every script, "by package" only those whose package could be resolved (so the two totals differ; the total is the script time above). ⚠️ It answers "which kind of call", not "which function inside is slow" — function level needs a Chrome trace, there is no in-page sampler',
				splitJsHint: 'The script slice split three ways: exec / forced style+layout (sync layout forced by reading layout or writing style) / paused (time blocked in sync XHR or dialogs). All three are partitions of scripts[].duration and **sum to it** — they are not additional. This row is **the same frame as the pie above**',
				splitNoLoaf: 'not yet (needs a long animation frame >50ms; LoAF only reports those)',
				splitHint: 'As far as LoAF can decompose it. Up to 7 arcs: the script slice is split again by **invoker** (same order as the "by source" row below) into up to 4 pieces — one red family, dark to light; the unattributed part of the task is **grey**; then render (rAF callbacks) and style+layout+paint. Arcs are separated by a 1.4px gap (that is the only way same-family reds read as separate pieces); slices too small to afford the gap keep their full length. Paint and compositing **cannot** be separated in-page, so the last slice is "everything else" — do not read it as "style and layout only"; separating them needs a Chrome trace',
				worstOne: 'worst one',
				unexplained: 'no JS explanation for that frame', unexplainedHint: 'style/layout/paint/vsync; cross-check with Paint flashing in the Rendering panel',
				verdict: 'verdict', linkShort: 'RTT', suspectSuffix: ' suspect', cleared: 'link cleared (host and tunnel both normal)',
				groupDetail: 'forensics', groupDom: 'DOM & heap', groupHost: 'host & link', groupTools: 'toolbox', nodesSuffix: ' nodes',
				stream: 'state', running: 'streaming', idle: 'idle', idleBase: 'idle baseline (60s)', idleWriter: 'still adding nodes while idle',
				notYet: 'n/a', hostLoop: 'host event-loop',
				notApplicable: 'n/a (window had streaming)', hostDown: 'host n/a', link: 'link RTT',
				hostEvents: 'host event arrival', hostEventsHint: 'The host half uses the public ctx.on(\'session/event\') and records commit(event.time)→listener arrival lag; the earlier attempt to wrap Context.emit never fired (that event uses scope-filtered dispatch)',
				notInstalled: 'not installed', waiting: 'installed, waiting for events',
				sampling: 'throughput sampling', failed: 'throughput failed',
				renderError: 'panel render error', retry: 'Retry',
				renderErrorHint: 'Collection keeps running: the raw error is above. Retry to restore, or export (also in the errors section)',
				linkHint: 'A 1KB same-origin probe (cache-busted) every 10s gives RTT; n is the sample count over the last 60s. Throughput is a 64KB fetch every 60s (one extra 3s after start). \"Link suspected\" needs p99 > 300ms, normal FPS, and n >= 2',
				suspect: 'link suspected',
				stressRunning: 'self-test running', stressDone: 'self-test result', nodes: 'nodes',
				stressNoTask: 'no long task observed', stressCommit: 'commit', stressBurn: 'synthetic burn', stressSync: 'sync', stressSliced: 'sliced', stressNoFlush: 'flushSync unavailable', stressFromDom: 'DOM write',
				via: 'channel', viaRemote: 'ctx.remote (client remote)', viaRoute: 'host route /api/dsh-perf-hud/host',
				unattrShort: 'unattr', markPlaceholder: 'note (optional)',
				watch: 'Night watch', watchCaught: 'caught', watchWorst: 'worst', watchRestored: 'restored',
				watchDaily: 'daily worst',
				watchNone: 'nothing caught yet', watchOff: 'not recording', watchPersistFailed: 'persist failed', watchTrimmed: 'trimmed',
				watchHint: 'On by default and it patches nothing: one rAF loop plus one LoAF observer. When a frame interval (or LoAF blockingDuration) crosses 100ms it captures the 10s before and 3s after verbatim and keeps the **union of two tiers**: the worst 10 overall plus one worst-per-day (at most the last 7 days, marked "daily worst" in the list); they survive a reload. Persistence has a 2MB byte cap; when it trims, the count shows up as "trimmed N". Leave it running to catch intermittent stalls; after one, hand the evidence pack to an analyst with "Export latest".',
				watchMark: 'Mark just now', watchMarkHint: 'Manually record "it just stuttered": rewinds 3s (human reaction time), slices immediately, and copies the note from the input above into the pack',
				watchExport: 'Export latest', watchExportHint: 'Download the **newest by time** incident (frames + LoAF + long tasks in the window + environment and missing-data notes; not the worst one). For others: __perfHud.exportIncident(\'i55\') by id, or exportIncident(0) for the worst',
				watchManualNote: 'manual mark',
			},
		};
		/**
		 * 内置兜底:语言**跟文档走**。
		 *
		 * locale 服务不在(或接口变了)时用它。以前这里写死中文 —— 英文用户看到中文是 bug;
		 * 但简单反转(`DICT.en[key] ?? key`)同样错:中文用户会看到英文串。所以先看文档语言
		 * (`document.documentElement.lang`,取不到再退 `navigator.language`),是中文就用中文那本,
		 * 其余(含认不出来)用英文那本;两本字典**键集合由断言钉住一致**(见 tests/logic.mjs),
		 * 所以"取不到"只可能是语言认不出来,不是某本字典缺键。
		 */
		function docLang() {
			const html = document.documentElement;
			if (html !== null && html !== undefined && typeof html.lang === 'string' && html.lang !== '') return html.lang.toLowerCase();
			return typeof navigator === 'object' && navigator !== null && typeof navigator.language === 'string'
				? navigator.language.toLowerCase()
				: '';
		}

		function fallback(key) {
			if (docLang().startsWith('zh')) return DICT.zh[key] ?? DICT.en[key] ?? key;
			return DICT.en[key] ?? key;
		}
		let translate = fallback;

		// ─────────────────────────────── 面板(React) ───────────────────────────────
		// 面板排版:文案走 UI 字体、数字走等宽字体;关键字加粗,数值一律 600+ 权重;
		// 分割线用更实的 border-l2(原来的 l1 太淡);所有文字都允许换行,不做省略号截断。
		const UI_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
		const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

		const S = {
			root: (open) => ({
				position: 'fixed', right: 12, bottom: 12, zIndex: 60, pointerEvents: 'auto',
				// 整数 px + 整数权重:11.5px / 650 这种分数值在 125%~150% 显示缩放下会被
				// 浏览器合成加粗并重新栅格化,观感发糊 —— "糊糊的"最常见的来源。
				font: `13px/1.5 ${UI_FONT}`,
				background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-primary)',
				border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
				boxShadow: '0 10px 30px rgba(0,0,0,.28)', boxSizing: 'border-box',
				...(open
					? { width: 396, maxHeight: '82vh', overflowY: 'auto', overflowX: 'hidden', padding: '10px 12px' }
					: { padding: '6px 10px' }),
			}),
			head: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
			brand: { fontWeight: 700, fontSize: 14, color: 'var(--dsw-alias-label-primary)' },
			row: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginTop: 4 },
			// 标签不换行、不收缩(原来 flex:1 1 auto 会被长数值挤成一字一行);
			// 数值占满剩余宽度、右对齐、必要时在自己那一列换行。
			label: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 700, flex: '0 0 auto', whiteSpace: 'nowrap', lineHeight: 1.5 },
			num: { fontFamily: MONO_FONT, fontWeight: 700, fontVariantNumeric: 'tabular-nums', flex: '1 1 auto', textAlign: 'right', whiteSpace: 'normal', overflowWrap: 'break-word', lineHeight: 1.5 },
			btn: {
				font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'transparent',
				border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, padding: '2px 8px', cursor: 'pointer', flex: '0 0 auto',
			},
			sub: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginTop: 3, lineHeight: 1.5, whiteSpace: 'normal', overflowWrap: 'break-word' },
			// 长文本不要塞进"标签左 / 数值右"的 flex 行:右对齐 + 换行会参差得像段落(实测被吐槽过)。
			// 块式:标签独占一行,值左对齐换行;pre-line 让 \n 成为受控断行。
			block: { display: 'block', marginTop: 2 },
			blockLabel: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 700 },
			blockValue: { marginTop: 2, whiteSpace: 'pre-line', lineHeight: 1.5, overflowWrap: 'break-word', fontVariantNumeric: 'tabular-nums' },
			sep: { marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l2)' },
			buttons: { display: 'flex', gap: 8, marginTop: 7, flexWrap: 'wrap' },
			input: { font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, padding: '2px 8px', flex: 1, minWidth: 0 },
		};

		/** 带符号的数值(Δ 用):非数字就原样转字符串。 */
		const signed = (value) => (typeof value === 'number' ? `${value >= 0 ? '+' : ''}${Math.round(value * 10) / 10}` : String(value));

		/**
		 * 自测用的重组件:一次提交塞进 count 个节点,制造真实的渲染型 longtask。
		 *
		 * ⚠️ 这个声明曾被"排版改造"整段替换时吞掉过一次:文件里 h(PerfHudStress, …) 还在、
		 * 定义没了 → React 抛 "Element type is invalid" → 外壳的 SlotErrorBoundary 把
		 * 整个槽位条目停用(面板凭空消失)。现在 tests/logic.mjs 有静态检查钉住这类引用。
		 */
		function PerfHudStress(props) {
			const started = performance.now();
			// 显式燃烧:自测要的是"确定地让这次渲染超过 50ms",好自检归因链路;
			// 真实卡顿不需要它(自然卡顿由流式渲染/布局产生)。面板上标注"含人为燃烧"。
			const burnUntil = performance.now() + (typeof state.stressBurn === 'number' ? state.stressBurn : 0);
			while (performance.now() < burnUntil) { /* 自测专用同步燃烧 */ }
			const items = [];
			for (let i = 0; i < props.count; i += 1) items.push(h('span', { key: i }, '.'));
			// 这次提交一结束就:① 清空标记(否则面板每 0.5 秒重渲染都会再造两万个节点)
			// ② 记下"渲染→提交"的墙钟耗时 —— 不依赖 longtask,切片提交也能给出真实数字。
			React.useEffect(() => {
				state.stressNodes = 0;
				if (state.stress !== null && state.stress.commitMs === undefined) {
					state.stress.commitMs = Math.round((performance.now() - started) * 10) / 10;
				}
			}, []);
			return h('div', {
				// 读 offsetHeight = 在当前任务里强制布局。实测:不强制时浏览器可以把布局推迟到下一帧,
				// 任务里只剩 React 提交那十几毫秒 → 根本凑不出 >50ms 的长任务(自测时有时无就是这个)。
				ref: (element) => { if (element !== null) void element.offsetHeight; },
				style: { position: 'fixed', left: -9999, top: 0, width: 1, height: 1, overflow: 'hidden' },
			}, items);
		}

		/**
		 * 面板自己捕获渲染错误。
		 *
		 * 外壳(dsh-client-ui-renderer 的 SlotErrorBoundary)一看到条目渲染抛错就把该条目
		 * **永久停用**(active:false,面板凭空消失,只能刷新页面)。实测点「自测」中过一次。
		 * 所以条目内部必须自带边界:出错降级成一块小面板,并把错误写进导出件 ——
		 * 否则连错误原文都拿不到。
		 */
		function recordError(error, info) {
			state.errors.push({
				t: Date.now(),
				iso: new Date().toISOString(),
				name: error instanceof Error ? error.name : 'Error',
				message: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error && typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 4).join(' | ').slice(0, 600) : '',
				where: typeof info?.componentStack === 'string' ? info.componentStack.split('\n').slice(1, 4).join(' | ').trim().slice(0, 300) : '',
			});
			if (state.errors.length > 5) state.errors.shift();
			dirty = true;
			flush(true);
		}

		class HudBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}

			static getDerivedStateFromError(error) {
				return { error: error instanceof Error ? error : new Error(String(error)) };
			}

			componentDidCatch(error, info) {
				recordError(error, info);
			}

			render() {
				if (this.state.error === null) return this.props.children;
				return this.props.renderError(this.state.error, () => this.setState({ error: null }));
			}
		}

		/** 出错时的降级面板:错误摊在明面上,而且仍然能导出。 */
		function renderErrorView(error, retry) {
			const message = error instanceof Error ? error.message : String(error);
			return h('div', {
				ref: (element) => { state.root = element; },
				style: { ...S.root(true), width: 380 },
			},
				h('div', { style: S.head },
					h('span', { style: S.brand }, translate('title')),
					h('span', { style: { ...S.label, color: 'var(--dsw-alias-state-error-primary)' }, title: translate('renderErrorHint') }, translate('renderError'))),
				h('div', { style: { ...S.sub, color: 'var(--dsw-alias-label-primary)' } }, `${error instanceof Error ? error.name : 'Error'}: ${message}`.slice(0, 500)),
				h('div', { style: S.buttons },
					h('button', { type: 'button', style: S.btn, onClick: retry }, translate('retry')),
					h('button', { type: 'button', style: S.btn, onClick: exportJson }, translate('exportJson'))));
		}

		/**
		 * 阈值配色(越大越糟:帧耗时 / longtask):>= warn 变黄,>= bad 变红。
		 */
		function levelUp(value, warn, bad) {
			if (value >= bad) return 'var(--dsw-alias-state-error-primary)';
			if (value >= warn) return 'var(--dsw-alias-state-warn-primary)';
			return 'var(--dsw-alias-state-success-primary)';
		}

		/**
		 * 合并判色:FPS 与最差帧**任一触发即降色**。
		 * 原来只看 fps(levelDown),于是 54.2fps 是绿的、而同期最差帧 130ms —— 绿点掩盖了卡顿。
		 */
		function levelFrame(fps, frameWorst) {
			if (fps <= 30 || frameWorst >= 200) return 'var(--dsw-alias-state-error-primary)';
			if (fps <= 50 || frameWorst >= 120) return 'var(--dsw-alias-state-warn-primary)';
			return 'var(--dsw-alias-state-success-primary)';
		}

		/** 阈值配色(越大越好:FPS):<= bad 变红,<= warn 变黄。 */
		function levelDown(value, warn, bad) {
			if (value <= bad) return 'var(--dsw-alias-state-error-primary)';
			if (value <= warn) return 'var(--dsw-alias-state-warn-primary)';
			return 'var(--dsw-alias-state-success-primary)';
		}

		/**
		 * 只去掉 @scope/ 前缀,不截断 —— 截断过的包名根本认不出来("dsh-better-sideb…"),
		 * 放不下就换行(面板宽度 + overflowWrap 已经接得住)。
		 */
		function short(id) {
			return id.replace(/^@[^/]+\//, '');
		}

		const rateText = (series) => {
			const value = rate(series);
			return `${value >= 0 ? '+' : ''}${value.toFixed(0)}${translate('perMin')}`;
		};

		function worstSecondText() {
			const sample = worstSecond();
			if (sample === null) return translate('none');
			return `${clock(sample.t)} · ${sample.fps}fps · ${sample.frameMs}ms · LT×${sample.ltCount ?? 0}`;
		}

		/** 堆增速用 60 秒窗口(2 秒一采样 → 30 点):12 秒窗口会被 GC 锯齿放大成假数字。 */
		function heapRateText() {
			const perMin = rate(state.heapSeries, 30);
			return `${perMin >= 0 ? '+' : ''}${mb(perMin)}MB${translate('perMin')}`;
		}

		/** DOM 写入者 Top N + 其余(数字带 ≈:采样估算)。 */
		function writeRows() {
			const rows = domWriteTable();
			const top = rows.slice(0, MUT_TOP);
			const rest = rows.slice(MUT_TOP);
			const restCount = rest.reduce((sum, row) => sum + row.estimatedCount, 0);
			return h('div', null,
				top.map((row, index) => h('div', { key: row.id },
					h('div', { style: S.row },
						h('span', { style: S.label, title: `${row.id} · ${row.sampled}${translate('samples')}` }, `${index + 1}. ${short(row.id)}`),
						h('span', { style: S.num }, `${translate('est')}${row.estimatedCount}`)),
					row.component === null ? null : h('div', { style: S.sub }, `${translate('component')}: ${row.component}`))),
				rest.length === 0 ? null : h('div', { style: S.row },
					h('span', { style: S.label }, `${translate('rest')} (${rest.length})`),
					h('span', { style: S.num }, `${translate('est')}${restCount}`)));
		}

		function PerfHud() {
			const [, force] = React.useState(0);
			const [open, setOpen] = React.useState(state.collapsed === false);
			const [draft, setDraft] = React.useState('');
			const setRoot = React.useCallback((element) => { state.root = element; }, []);
			React.useEffect(() => {
				// 只在"显示值变了"时渲染(兜底至少 2 秒一次):折叠着不动时 HUD 自身开销接近零。
				let lastKey = state.displayKey;
				let lastForced = performance.now();
				const id = natives.setInterval(() => {
					const changed = state.displayKey !== lastKey;
					const stale = performance.now() - lastForced >= 2000;
					if (changed === false && stale === false) return;
					lastKey = state.displayKey;
					lastForced = performance.now();
					force((n) => (n + 1) % 1000000);
				}, 500);
				// 用户动作 / 自测需要"点了立刻渲染":暴露到模块级,不等下一次 tick。
				state.requestRender = () => {
					lastKey = state.displayKey;
					lastForced = performance.now();
					force((n) => (n + 1) % 1000000);
				};
				return () => {
					natives.clearInterval(id);
					state.requestRender = null;
				};
			}, []);

			const t = translate;
			const toggle = () => {
				const next = open === false;
				setOpen(next);
				state.collapsed = next === false;
				try { localStorage.setItem(LS_UI, next ? '0' : '1'); } catch (error) { /* 折叠状态记不住无所谓 */ }
			};

			if (state.on === false) {
				return h('div', { ref: setRoot, style: S.root(false) },
					h('div', { style: S.head },
						h('span', { style: S.label }, `${t('title')} · ${t('off')}`),
						h('button', { type: 'button', style: S.btn, onClick: () => setEnabled(true) }, t('turnOn'))));
			}

			const worst = worstLongTask();
			const loop = state.host === null ? null : state.host.eventLoop;
			const link = linkStats();
			const linkSuspect = suspectLink();
			const idleBase = state.idleBaseline;
			const v = verification();
			const unexplained = unexplainedFrame();
			const infra = infraVerdict();
			const tally = longTaskTally();
			const rows = pluginTable();
			const top = rows.slice(0, TOP_N);
			const rest = rows.slice(TOP_N);

			const scene = sceneChip();
			const head = h('div', { style: S.head },
				h('span', { style: S.brand }, t('title')),
				h('span', { style: { ...S.label, color: scene.color } }, scene.text),
				h('span', { style: { ...S.num, flex: '0 0 auto', marginLeft: 'auto', color: levelFrame(state.fps, state.frameWorst) } }, `${state.fps.toFixed(1)} fps`),
				h('button', {
					type: 'button',
					style: { ...S.btn, color: state.deep ? 'var(--dsw-alias-brand-primary)' : undefined },
					title: t('deepHint'),
					onClick: () => setDeep(state.deep === false),
				}, `${t('deepShort')}${state.deep ? '✓' : ''}`),
				h('button', { type: 'button', style: S.btn, title: open ? t('collapse') : t('expand'), onClick: toggle }, open ? '–' : '+'),
				h('button', { type: 'button', style: S.btn, title: t('turnOff'), onClick: () => setEnabled(false) }, t('turnOff')));

			if (open === false) {
				// 折叠不是"看不见":至少留下 fps / 最差帧 / 最差 longtask 三个读数。
				return h('div', { ref: setRoot, style: S.root(false) },
					h('div', { style: S.head },
						h('span', { style: S.brand }, t('title')),
						h('span', { style: { ...S.label, color: sceneChip().color } }, sceneChip().text),
						h('span', { style: { ...S.num, flex: '0 0 auto', marginLeft: 'auto', color: levelFrame(state.fps, state.frameWorst) } }, `${state.fps.toFixed(0)} fps`),
						h('span', { style: S.label }, `${t('frameWorst')} ${state.frameWorst.toFixed(0)}ms`),
						worst === null ? null : h('span', { style: S.label }, `LT ${worst.ms.toFixed(0)}ms`),
						state.watch.incidents.length === 0 ? null : h('span', { style: S.label, title: t('watchHint') }, `${t('watchCaught')} ${state.watch.incidents.length}${t('times')}`),
						h('button', { type: 'button', style: S.btn, title: t('expand'), onClick: toggle }, '+'),
						h('button', { type: 'button', style: S.btn, title: t('turnOff'), onClick: () => setEnabled(false) }, t('turnOff'))));
			}

			const body = h('div', null,
				// ── 常显 1:卡不卡 + 谁的锅 ──
				// 块式而不是 flex 行:这一行长文本换行在右对齐下会参差得像段落(实测被吐槽)。
				h('div', { style: S.block, title: overviewTitle() },
					h('div', { style: S.blockLabel }, t('overview')),
					h('div', { style: { ...S.blockValue, color: levelFrame(state.fps, state.frameWorst) } }, `${overviewLine1()}\n${overviewLine2()}`)),

				// ── 常显 2:回调归因 Top3(每插件一行,hover 补 msps 与累计)──
				// (帧内未归因从常显挪进了「取证明细」:它是"解释",不是"现在卡不卡 / 谁的锅"
				//  这两个常显问题本身;它的数字挂在那一组的摘要上,展开也看得到。)
				// 没插桩 / 没抓到回调时这一块是 `0ms/s` + 空表 —— 白占地方,还会被读成"没有开销"
				(top.length === 0 && rest.length === 0) ? null : h('div', { style: S.sep },
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('blameHint') }, t('blame')),
						h('span', { style: S.num }, msPerSecText(state.attributedPerSec))),
					h('div', null, top.map((row, index) => h('div', { key: row.id, style: S.row },
						h('span', {
							style: S.label,
							title: `${row.id}\n` +
								`${t('cnExec')} ${row.cps}${t('perSec')}(${t('peak')} ${row.cpsPeak}${t('perSec')},EMA)\n` +
								`${t('cnCost')} ${row.msps}ms${t('perSec')}\n` +
								`${t('cumulative')} ${row.count}${t('times')} / ${row.ms.toFixed(0)}ms\n` +
								t('cnScope'),
						}, `${index + 1}. ${short(row.id)}`),
						h('span', { style: S.num }, attrText(row))))),
					rest.length === 0 ? null : h('div', { style: S.row },
						h('span', { style: S.label, title: restTitleText(rest) }, `${t('rest')} (${rest.length})`),
						h('span', { style: S.num }, restValueText(rest)))),

				// ── 常显 4:守夜(偶发卡顿的入口:抓到几次、最差多少)──
				h('div', { style: S.sep },
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('watchHint') }, t('watch')),
						h('span', { style: S.num }, watchPanelText())),
					watchLatestText() === null ? null : h('div', { style: S.sub }, watchLatestText())),

				// ── 折叠 1:取证明细(最差那秒 + DOM 写入者)──
				group('detail', t('groupDetail'), detailSummary(),
					// 翻帧:最近 200 条长动画帧按 blocking 降序(最差的在前),◀ ▶ 换一条、⟲ 回到自动。
					// 面板默认跟着"最差那条"走 —— 只有出现更差的才会换,所以常常同一条挂很久。
					(() => {
						const list = pickList();
						if (list.rows.length === 0) return null;
						const current = pickedLoaf();
						const at = list.rows.findIndex((row) => row.t === current.t) + 1;
						const auto = state.watch.pickT === null;
						const shown = list.filtered ? list.rows.length : 0;
						const title = `${t('framePick')} ${at}/${list.rows.length}${list.filtered ? `(≥${PICK_MIN_MS}ms)` : ''}`
							+ ` · blocking ${Math.round(current.blocking ?? 0)}ms · ${clock(current.t)}`
							+ `\n${auto ? t('framePickAuto') : t('framePinned')}`
							+ (shown === 0 ? '' : `\n${translate('framePickFiltered')} ${shown}${translate('times')}`)
							+ `\n${t('framePickHint')}`;
						return h('div', { style: { ...S.row, alignItems: 'center' }, title },
							h('span', { style: S.label }, `${t('framePick')} ${at}/${list.rows.length} · ${Math.round(current.blocking ?? 0)}ms${list.filtered ? ` · ≥${PICK_MIN_MS}ms` : ''}`),
							h('span', { style: { flex: '0 0 auto', display: 'flex', gap: 6 } },
								h('button', { type: 'button', style: S.btn, title: t('framePickHint'), onClick: () => pickStep(-1) }, '◀'),
								h('button', { type: 'button', style: S.btn, title: t('framePickHint'), onClick: () => pickStep(1) }, '▶'),
								h('button', { type: 'button', style: S.btn, title: t('frameAutoHint'), onClick: pickAuto }, '⟲')));
					})(),
					// 长动画帧的时间去向:圆环。脚本那一段再按「来源」切细(最多 7 段),
					// 页面内看不到"绘制/合成",最后一段是"剩下的都在这儿" —— 拿它当"样式布局占比"会读错。
					(() => {
						const current = pickedLoaf();
						const split = frameSplit(current);
						if (split === null) return h('div', { style: S.row },
							h('span', { style: S.label, title: t('splitHint') }, t('split')),
							h('span', { style: S.num }, t('splitNoLoaf')));
						const frameTally = framePkgTally(current);
						const sources = frameTally === null ? [] : frameTally.byInvoker;
						// 48px 的环只有 126px 周长(1% ≈ 1.3px),段一多就分不出来 —— 放大到 84px,
						// 并在段与段之间留 1.4px 的缝:同一族的红靠缝才看得出是几块。
						const R = 34;
						const C = 2 * Math.PI * R;
						const GAP = 1.4;
						const COLORS = {
							error: 'var(--dsw-alias-state-error-primary)',
							warn: 'var(--dsw-alias-state-warn-primary)',
							brand: 'var(--dsw-alias-brand-primary)',
							neutral: 'var(--dsw-alias-label-secondary)',
						};
						const slices = frameArcs(split, sources);
						let passed = 0;
						const arcs = [];
						for (let i = 0; i < slices.length; i += 1) {
							const raw = (slices[i].ms / split.total) * C;
							// 缝只在"扣得起"的段上扣:小段扣掉缝就等于消失了
							const length = raw > GAP * 2 ? raw - GAP : raw;
							// 推进量按**原始**长度走,缝才落在两段之间(而不是把后面的段往前挪)
							const offset = passed;
							passed += raw;
							if (length <= 0.05) continue;
							arcs.push(h('circle', {
								key: `slice-${i}`, cx: 42, cy: 42, r: R, fill: 'none',
								stroke: COLORS[slices[i].color], strokeWidth: 13, strokeOpacity: slices[i].opacity,
								strokeDasharray: `${length.toFixed(1)} ${(C - length).toFixed(1)}`,
								strokeDashoffset: (-offset).toFixed(1),
								transform: 'rotate(-90 42 42)',
							}));
						}
						const pctOfJs = (ms) => `${Math.round((ms / (split.js || 1)) * 100)}%`;
						const srcLine = sources.length === 0
							? ''
							: `\n${t('splitInvoker')} ${sources.slice(0, 3).map(([name, ms]) => `${name} ${pctOfJs(ms)}`).join(' · ')}`;
						const title = `${t('splitTotal')} ${split.total}ms(${t('splitWorst')} blocking ${split.blocking}ms)\n`
							+ `${t('splitScript')} ${split.js}ms(${t('jsExec')} ${split.exec} · ${t('forcedLayout')} ${split.forced} · ${t('jsPause')} ${split.pause})`
							+ `${srcLine}\n`
							+ `${t('splitTask')} ${split.taskOther}ms\n${t('splitRender')} ${split.render}ms\n${t('splitTail')} ${split.tail}ms`;
						return h('div', { style: { ...S.row, alignItems: 'center', gap: 8 } },
							h('svg', { width: 84, height: 84, viewBox: '0 0 84 84', style: { flex: '0 0 auto' } }, arcs),
							h('div', { style: { flex: '1 1 auto', textAlign: 'right', lineHeight: 1.5, minWidth: 0 } },
								h('div', { style: S.num, title }, `${t('split')} ${split.total}ms`),
								splitLegend(split).map((line, index) => h('div', { key: `legend-${index}`, style: S.sub, title }, line))));
					})(),
					// D5:脚本侧往下拆:**两个小标题各管一组**。「本帧」那组与上面那张饼吃同一条
					// LoAF(数字能对着看);窗口那组是最近 WATCH_LOAF_MAX 条的累计,它的范围写在
					// 小标题上 —— 行标签就不用再重复一遍"本帧 / ·窗口",省掉一大截字。
					// 按包那几行只在**真定到包名**时才出现:一个名都没定到时它只是噪声,换成一行说明。
					(() => {
						const frame = frameSplit(pickedLoaf());
						const framePkgs = framePkgTally(pickedLoaf());
						const window = scriptPkgTally();
						const rows = [];
						const line = (key, label, hint, value) => h('div', { key, style: S.block },
							h('span', { style: S.blockLabel, title: hint }, label),
							h('div', { style: S.blockValue }, value));
						const head = (key, text, hint) => h('div', { key, style: { ...S.blockLabel, marginTop: 8 }, title: hint }, text);
						if (frame !== null && frame.js > 0 && framePkgs !== null) {
							rows.push(head('frame-head', t('scopeFrame'), t('splitJsHint')));
							rows.push(line('frame-js', t('splitJs'), t('splitJsHint'), jsBreakdownText(frame)));
							rows.push(line('frame-src', t('bySource'), t('invokerHint'), invokerWhoText(framePkgs)));
							if (framePkgs.top.length > 0) rows.push(line('frame-pkg', t('byPkg'), t('pkgHint'), pkgWhoText(framePkgs)));
						}
						if (window.js > 0) {
							rows.push(head('win-head', windowScopeText(window), t('windowScopeHint')));
							rows.push(line('win-src', t('bySource'), t('invokerHint'), invokerWhoText(window)));
							rows.push(line('win-js', t('splitJs'), t('forcedHint'), jsBreakdownText(window)));
							if (window.top.length > 0) rows.push(line('win-pkg', t('byPkg'), t('pkgHint'), pkgWhoText(window)));
							// 一个包名都没定到:按包这一层现在没有信息,但也不能装作它不存在
							// 一个包名都没定到:这一层给不出占比(没有名字就没有排行),但**必须留下分母** ——
							// 直接不显示会让人以为"按包"被删了(实测被这么问过)。
							if (window.top.length === 0) {
								rows.push(h('div', { key: 'pkg-none', style: S.sub, title: t('pkgHint') },
									pkgZeroText(frame === null || framePkgs === null ? 0 : framePkgs.unresolved, window.unresolved)));
							}
						}
						return rows.length === 0 ? null : h('div', null, rows);
					})(),
					// 60 秒迷你时间条:一格一秒、格值取格里最差那帧,阈值与导出件 ASCII 条带一致
					h('div', { style: { ...S.row, alignItems: 'center', gap: 8 } },
						h('span', { style: S.label, title: t('sparkHint') }, t('spark')),
						h('span', { style: { flex: '1 1 auto', textAlign: 'right' } },
							frameRing.size === 0 ? t('notYet') : sparkStrip())),
					// 帧里"JS 之外"的残差:唯一能反映 CSS/绘制卡顿的数字,从常显挪进来
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('unattrHint') }, t('unattr')),
						h('span', { style: { ...S.num, color: state.deep === true && unexplained !== null ? 'var(--dsw-alias-state-warn-primary)' : undefined } },
							unattrText())),
					unexplained === null ? null : h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-warn-primary)' } },
						`${t('unexplained')}:${unexplained.ms}ms(${unexplained.percent}%)→ ${t('unexplainedHint')}`),
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('recorderHint') }, t('recorder')),
						h('span', { style: S.num }, recorderText())),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('worstSecond')),
						h('span', { style: S.num }, worstSecondText())),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('topBlame')),
						h('span', { style: S.num }, (tally.topNames.length === 0
							? t('none')
							// 记录器自己不再挂在这行尾巴上 —— 它上面就有独立的「记录器自身」一行
							: tally.topNames.map(([name, count]) => `${short(name)} ${count}×`).join(' · ') + (tally.top.length > 3 ? ` · ${t('rest')} ${tally.top.length - 3}` : '')))),
					h('div', { style: S.row },
						h('span', { style: S.label, title: `${t('legFiber')} / ${t('legSubtree')} / ${t('legDom')} / ${t('legOwner')}` }, t('hit')),
						h('span', { style: S.num }, hitText(tally))),
					// 这两行只有插桩了才有意义(不插桩时计数恒为 0)
					state.deep !== true ? null : h('div', { style: S.row },
						h('span', { style: S.label, title: t('domWritesHint') }, t('domWrites')),
						h('span', { style: S.num }, String(state.mutations))),
					state.deep !== true ? null : writeRows()),

				// ── 折叠 2:DOM 与堆 ──
				group('dom', t('groupDom'), domSummary(),
					h('div', { style: S.row },
						h('span', { style: S.label }, `${t('dom')} · ${t('rateWindow')}`),
						h('span', { style: S.num }, `${state.dom.total} · ${rateText(state.dom.series)}`)),
					TARGETS.map((target) => {
						const entry = state.targets.get(target.id);
						return h('div', { key: target.id, style: S.row },
							h('span', { style: S.label }, target.label()),
							h('span', { style: S.num }, entry === undefined || entry.nodes === null ? t('none') : `${entry.nodes} · ${rateText(entry.series)}`));
					}),
					state.heap === null ? null : h('div', { style: S.row },
						h('span', { style: S.label }, t('heap')),
						h('span', { style: S.num }, `${mb(state.heap)}MB · ${heapRateText()}`))),

				// ── 折叠 3:宿主与链路(排查"是页面卡还是链路卡"才看)──
				group('host', t('groupHost'), hostSummary(),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('stream')),
						h('span', { style: S.num }, `${state.streaming ? t('running') : t('idle')}${state.streaming || state.idleSince === 0 ? '' : ` ${Math.round((performance.now() - state.idleSince) / 1000)}s`}${state.baselineRunning ? ` · ${t('idleBase')}…` : ''}`)),
					h('div', { style: S.row },
						h('span', { style: S.label }, `${t('hostLoop')} · ${t('verdict')}`),
						h('span', { style: { ...S.num, color: infra.color } }, infra.text)),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('hostLoop')),
						h('span', { style: { ...S.num, color: loop === null ? undefined : levelUp(loop.p99, 50, 200) } },
							state.hostError !== null ? `${t('hostDown')}:${state.hostError.slice(0, 26)}`
								: loop === null ? t('notYet') : `p50 ${loop.p50}ms · p99 ${loop.p99}ms`)),
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('hostEventsHint') }, t('hostEvents')),
						h('span', { style: S.num }, hostEventsText())),
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('linkHint') }, t('link')),
						h('span', { style: { ...S.num, color: linkSuspect ? 'var(--dsw-alias-state-warn-primary)' : (link.count > 0 ? levelUp(link.p99, 100, 300) : undefined) } }, linkRowText())),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('idleBase')),
						h('span', { style: S.num }, idleBase === null || idleBase === undefined
							? t('notYet')
							: `${idleBase.fps}fps · LT ${idleBase.longTasks} · ${idleBase.domPerMin}${t('perMin')}`)),
					idleBase === null || idleBase === undefined || idleBase.domPerMin <= 0 ? null : h('div', { style: S.sub },
						`${t('idleWriter')}: ${(idleBase.domTop ?? []).map((row) => `${short(row?.id ?? '?')}${row?.component === null || row?.component === undefined ? '' : `(${row.component})`}`).join(' / ') || t('none')}`)),

				// ── 折叠 4:工具箱(隔离实验 / 场景标记 / 验收)──
				group('tools', t('groupTools'), toolsSummary(),
					// 守夜层:最差几次的清单 + 手动补记 + 导出最近一次
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('watchHint') }, t('watch')),
						h('span', { style: S.num }, watchPanelText())),
					state.watch.incidents.length === 0 ? null : h('div', null,
						state.watch.incidents.map((row, index) => h('div', { key: row.id, style: S.sub }, watchRowText(row, index)))),
					h('div', { style: S.buttons },
						// 备注输入框留着:它就是「标记刚才」写进事故包的 note
						h('input', {
							type: 'text',
							value: draft,
							placeholder: t('markPlaceholder'),
							onChange: (event) => setDraft(event.target.value),
							style: S.input,
						}),
						h('button', { type: 'button', style: S.btn, disabled: state.watch.on === false, title: t('watchMarkHint'), onClick: () => { W.__perfHud.capture(draft === '' ? t('watchManualNote') : draft); setDraft(''); } }, t('watchMark')),
						h('button', { type: 'button', style: S.btn, disabled: state.watch.incidents.length === 0, title: t('watchExportHint'), onClick: () => W.__perfHud.exportIncident('latest') }, t('watchExport'))),

				h('div', { style: { ...S.sep, display: 'flex', gap: 6 } },
					h('button', { type: 'button', style: S.btn, onClick: exportJson }, t('exportJson')),
					h('button', { type: 'button', style: S.btn, onClick: () => W.__perfHud.clear() }, t('clear')))));

			// 自带边界:渲染抛错时只降级成一块小面板,不让外壳把整个条目停用。
			return h(HudBoundary, { renderError: renderErrorView },
				h('div', { ref: setRoot, style: S.root(true) }, head, body,
					state.stressNodes > 0 ? h(PerfHudStress, { count: Math.min(state.stressNodes, 6000) }) : null));
		}

		// ───────────────────────────────── 装配 ─────────────────────────────────
		function apply(ctx) {
			state.since = Date.now();
			restore();
			// remote face 只用于 bundle 读写(插件管理器同一条路);拿不到就退宿主路由。
			try {
				remoteFace = ctx.remote ?? ctx.get('remote') ?? null;
			} catch (error) {
				remoteFace = null;
			}

			// 字典:服务不在(或接口变了)就退回内置中文,仪表照常工作。
			const locale = ctx.get('locale');
			if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
				try {
					const disposers = [locale.register(NS, 'zh', DICT.zh), locale.register(NS, 'en', DICT.en)];
					translate = locale.bind(NS);
					ctx.effect(() => () => {
						for (const dispose of disposers) dispose();
						translate = fallback;
					}, 'perf-hud: dictionaries');
				} catch (error) {
					translate = fallback;
				}
			}

			// 页面隐藏/关闭前落盘,别丢最后 5 秒的样本。顺带记一条 A2 的跨会话基线:
			// 会话结束时的分布只在这一次机会里拿得到(下次打开就是新会话了)。
			const persist = () => { flush(true); saveSessionBaseline(); };
			const persistIfHidden = () => { if (document.visibilityState === 'hidden') flush(true); };
			W.addEventListener('pagehide', persist);
			W.addEventListener('visibilitychange', persistIfHidden);
			ctx.effect(() => () => {
				W.removeEventListener('pagehide', persist);
				W.removeEventListener('visibilitychange', persistIfHidden);
			}, 'perf-hud: persist on hide');

			if (state.want) start();
			ctx.effect(() => () => { stop(); }, 'perf-hud: instrumentation');
			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: PKG,
				order: 100,
			}, PerfHud));
		}

		return { inject: ['slots'], apply };
	},
});
