/**
 * dsh-perf-hud — 浏览器端性能 HUD(纯客户端)。
 *
 * 这一半就是全部实现:Host 侧只有一行空 apply()。仪表固定在右下角
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
		const LS_PRECISE = 'dsh-perf-hud:precise';
		const LS_MAP = 'dsh-perf-hud:map';     // 按 rev 缓存的 section 分段表
		const LS_MARKS = 'dsh-perf-hud:marks';
		const LS_GROUPS = 'dsh-perf-hud:groups';
		const HOST_ROUTE = '/api/dsh-perf-hud/host';
		const RTT_INTERVAL_MS = 10000;
		const LOAD_INTERVAL_MS = 60000;
		const LOAD_BYTES = 65536;
		const MUT_WINDOW_MS = 2000;            // fiber 归因只看最近 2 秒被改动的节点
		const BASELINE_MS = 60000;
		const STEP_MS = 60000;         // 隔离实验:每个候选"关闭后"的测量窗口
		const BRACKET_MS = 30000;      // 隔离实验:每个候选前后各打一次基线(对照 + 噪声采样)
		const EXPERIMENT_IDLE_WAIT_MS = 300000;   // 开跑前最多等 5 分钟,等会话空闲(流式窗口不可比)
		const IDLE_GAP_MS = 3000;
		const DEFAULT_CANDIDATES = ['dsh-status-rotator', 'dsh-notify-me', 'dsh-better-sidebar', 'dsh-context'];
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
				const name = type.displayName ?? type.name;
				if (typeof name !== 'string' || name === '' || REACT_INTERNAL.has(name) || looksLikeInfrastructure(name)) continue;
				// 生产构建会把组件名压成 n5 / t3 / Bn 这种(大小写都有),对人毫无意义 ——
				// 跳过它继续往上找。代价是极少数真的只有 1~2 个字母的组件名会被略过,
				// 换来的是不再拿压缩名冒充"组件名"(线上导出里真出现过 `(n5)` 和 `(Bn)`)。
				if (/^[A-Za-z]{1,2}\d{0,3}$/.test(name)) continue;
				return name;
			}
			return null;
		}

		/** 最近 2 秒被改动过的节点里,能给出组件名的那个(相当于"这次渲染是谁"). */
		const FIBER_SCAN_MAX = 64;   // 每次 longtask 最多试 64 个入口:够用,且不会变成新的长任务

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
			ltLegs: { fiber: 0, dom: 0, owner: 0, none: 0 },   // 三条腿的累计命中数
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
			requestRender: null,     // 面板挂载时注册:自测要立刻重渲染,不能等 0.5 秒的定时器
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

		// ───────────────────────────── FPS:1 秒滚动窗口 ─────────────────────────────
		function frame() {
			if (state.on === false) return;
			const now = performance.now();
			const busy = state.busyMs;
			state.busyMs = 0;
			state.windowFrames += 1;
			if (state.lastFrameAt !== 0) {
				const delta = now - state.lastFrameAt;
				if (delta > state.worstFrameMs) state.worstFrameMs = delta;
				const idle = delta - busy;
				if (idle > 0) state.unattrSum += idle;
				state.unattrCount += 1;
				if (idle > state.unattrWorst) state.unattrWorst = idle;
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
			state.ltTotal += 1;
			state.ltThisSecond += 1;
			state.longTasks.push({
				t: Date.now(),
				at: round1(entry.startTime),
				ms: round1(entry.duration),
				owner,
				component,
				domComponent,
				source: owner === null ? (component === null ? 'none' : 'render') : (component === null ? 'scheduler' : 'scheduler+render'),
			});
			const record = state.longTasks[state.longTasks.length - 1];
			// 命中口径 = 三条腿任一非 none,与面板上的分布完全同一套判定
			// (旧版这里漏了 dom 腿:只有 DOM 写入归因的长任务进了分布、却没进命中数)
			if (legOf(record) !== 'none') state.ltBlamed += 1;
			applyLongTaskStats(record);
			if (state.longTasks.length > 200) state.longTasks.splice(0, state.longTasks.length - 200);
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
		}

		function flush(force) {
			if (dirty === false && force !== true) return;
			dirty = false;
			try {
				localStorage.setItem(LS_RING, JSON.stringify({ v: 1, savedAt: Date.now(), samples: ring }));
			} catch (error) { /* 配额满:持久化放弃,内存缓冲照常 */ }
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
			return { fiber: legs.fiber, dom: legs.dom, owner: legs.owner, none: legs.none, total: state.ltTotal, top, topNames: top.slice(0, 3) };
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
			if (fiber !== null && looksLikeInfrastructure(fiber) === false) return fiber;
			const dom = row.domComponent ?? null;
			if (dom !== null) return dom;
			if (fiber !== null) return fiber;
			if (row.owner !== null && row.owner !== undefined) return short(row.owner);
			return null;
		}

		function blameText(row) {
			if (row === null || row === undefined) return translate('none');
			const fiber = row.component ?? null;
			const dom = row.domComponent ?? null;
			if (fiber !== null && looksLikeInfrastructure(fiber) === false) {
				return dom !== null && dom !== fiber ? `${fiber} / ${dom}(${translate('stressFromDom')})` : fiber;
			}
			if (dom !== null) return `${dom}(${translate('stressFromDom')})`;
			if (fiber !== null) return fiber;
			if (row.owner !== null && row.owner !== undefined) return short(row.owner);
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
				ownPackageNames: {
					'dsh-status-rotator': seen.has('dsh-status-rotator'),
					'dsh-notify-me': seen.has('dsh-notify-me'),
				},
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
		const experiment = {
			phase: 'idle',        // idle | running | done | aborted | failed
			message: '',
			candidates: DEFAULT_CANDIDATES.slice(),
			results: [],
			original: null,
			candidateState: [],
			restored: null,
			baseline: null,
			noise: null,          // 基线之间的漂移,当噪声底
			drifts: [],
			method: '空闲筛查:基线 → (关闭 → 窗口 → 恢复 → 恢复后基线) × N,每个候选只跟紧邻基线对照;只看空闲负载下的固定开销,不是"这插件拖慢了多少"的因果证明',
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
			return true;
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
				page: location.href,
				userAgent: navigator.userAgent,
				instrumented: state.on,
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

		function setEnabled(on) {
			try { localStorage.setItem(LS_ON, on ? '1' : '0'); } catch (error) { /* 记住开关是尽力而为 */ }
			if (on) start(); else stop();
		}

		function start() {
			if (state.on) return;
			state.on = true;
			W.setTimeout = wrappers.timeout;
			W.setInterval = wrappers.interval;
			W.requestAnimationFrame = wrappers.raf;
			Node.prototype.appendChild = mutWrappers.appendChild;
			Node.prototype.insertBefore = mutWrappers.insertBefore;
			Element.prototype.setAttribute = mutWrappers.setAttribute;
			state.windowStart = performance.now();
			state.windowFrames = 0;
			state.lastFrameAt = 0;
			state.worstFrameMs = 0;
			state.fpsLoop = natives.requestAnimationFrame(frame);
			state.sampleTimer = natives.setInterval(sampleTick, 1000);
			state.domTimer = natives.setInterval(sampleDom, 2000);
			state.flushTimer = natives.setInterval(() => flush(false), 5000);
			state.ltObserver = startLongTask();
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
			// 只在全局仍是我们自己那份包装时恢复:同页热更新出新实例时,别把新的踩掉。
			if (W.setTimeout === wrappers.timeout) W.setTimeout = natives.setTimeout;
			if (W.setInterval === wrappers.interval) W.setInterval = natives.setInterval;
			if (W.requestAnimationFrame === wrappers.raf) W.requestAnimationFrame = natives.requestAnimationFrame;
			if (Node.prototype.appendChild === mutWrappers.appendChild) Node.prototype.appendChild = mutNatives.appendChild;
			if (Node.prototype.insertBefore === mutWrappers.insertBefore) Node.prototype.insertBefore = mutNatives.insertBefore;
			if (Element.prototype.setAttribute === mutWrappers.setAttribute) Element.prototype.setAttribute = mutNatives.setAttribute;
			natives.cancelAnimationFrame(state.fpsLoop);
			natives.clearInterval(state.sampleTimer);
			natives.clearInterval(state.domTimer);
			natives.clearInterval(state.flushTimer);
			natives.clearInterval(state.linkTimer);
			natives.clearInterval(state.loadTimer);
			stopDomWatch();
			if (state.ltObserver !== null) { state.ltObserver.disconnect(); state.ltObserver = null; }
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
			clear() {
				ring.length = 0;
				state.longTasks.length = 0;
				state.plugins.clear();
				state.domWrites.clear();
				state.mutations = 0;
				state.ltTotal = 0;
				state.ltBlamed = 0;
				state.ltNames.clear();
				state.ltLegs = { fiber: 0, dom: 0, owner: 0, none: 0 };
				state.recent.length = 0;
				recentWrites.length = 0;
				state.lastTick = 0;
				state.dom.series.length = 0;
				state.heapSeries.length = 0;
				for (const entry of state.targets.values()) entry.series.length = 0;
				dirty = true;
				flush(true);
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

		/** 合计耗时:小于 0.05ms/s 不写成 0 —— "0"读起来像"一点都没花",其实是四舍五入没了。 */
		function msPerSecText(value) {
			if (!(value > 0)) return '0ms/s';
			return value < 0.05 ? '<0.1ms/s' : `${round1(value)}ms/s`;
		}

		/** 概览的 hover:把口径(三条腿)与名字分布都摊开,免得只看到一个被抬高的命中率。 */
		function overviewTitle() {
			const tally = longTaskTally();
			return `${translate('overviewHint')}\n` +
				`${translate('hit')} = 三条腿任一命中:${translate('legFiber')} ${tally.fiber} · ${translate('legDom')} ${tally.dom} · ${translate('legOwner')} ${tally.owner} · ${translate('unblamed')} ${tally.none}` +
				(tally.topNames.length === 0 ? '' : `\n${translate('topBlame')}: ${tally.topNames.map(([name, count]) => `${name} ${count}×`).join(' · ')}`);
		}

		/** 折叠摘要里的一句话节点数:取不到就如实说未采集。 */
		function containerNodes(id) {
			const entry = state.targets.get(id);
			return entry === undefined || entry.nodes === null ? translate('notYet') : String(entry.nodes);
		}

		/** 折叠/展开一个分组,并把选择记住。 */
		function toggleGroup(key) {
			if (Object.hasOwn(state.groups, key) === false) return;
			state.groups[key] = state.groups[key] !== true;
			try { localStorage.setItem(LS_GROUPS, JSON.stringify(state.groups)); } catch (error) { /* 记不住就本次会话有效 */ }
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
		}

		// ───────────────────────────────── 文案 ─────────────────────────────────
		const DICT = {
			zh: {
				title: '性能 HUD', off: '已关', turnOn: '开启', turnOff: '关闭',
				fps: 'FPS', frameWorst: '最差帧', longtask: 'Longtask 60s', blame: '回调归因(耗时)',
				rest: '其余', dom: 'DOM 节点', none: '无', exportJson: '导出 JSON', clear: '清空',
				collapse: '折叠', expand: '展开', sessions: '会话列表', messages: '消息区', perMin: '/分',
				unattr: '帧内未归因', peak: '峰',
				unattrHint: '帧间隔里没被插桩回调解释掉的部分:样式重算、绘制、以及等待 vsync。CSS 动画的开销只在这里现形。',
				rateWindow: '速率近12s', heap: 'JS 堆(近60s)', domWrites: 'DOM 写入(按插件)', est: '≈',
				worstSecond: '最差那秒', ltCount: 'Longtask 次数', hits: '归因命中', hit: '命中', times: ' 次',
				maxBlame: '最多', topBlame: '归属 Top', legFiber: 'fiber', legDom: 'DOM写入', legOwner: '包名',
				perSec: '/s', samples: '次采样', unblamed: '未归因',
				domWritesHint: '前一项是精确总次数;下面按插件给出估算(每 10 次采样一次栈,命中按 10 折算)。',
				precise: '精确归因', preciseHint: '开启后按合并 bundle 的 sourcemap 分段还原单包名(懒加载,同一个 rev 只拉一次 map)',
				component: '组件', cumulative: '累计', maps: '批次分段',
				overview: '概览', overviewHint: '三秒判断:最差帧 + 最差 longtask 及其归属 + 归因命中数',
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
				suspect: '疑似链路', isolation: '隔离实验', candidate: '候选', baseline: '基线',
				startExp: '开始实验', abortExp: '中止并恢复', stress: '自测:渲染卡顿',
				stressHint: '自测:一次同步提交渲染 8000 个离屏节点 + 显式燃烧 80ms(节点数凑不稳,故明着燃烧),用来自检归因链路',
				stressRunning: '自测进行中', stressDone: '自测结果', nodes: '节点',
				stressNoTask: '未观察到长任务', stressCommit: '提交', stressBurn: '人为燃烧', stressSync: '同步', stressSliced: '切片', stressNoFlush: 'flushSync 不可用', stressFromDom: 'DOM 写入',
				expHint: '开跑前会等会话空闲(最多 5 分钟;流式窗口的对照不可比)。随后逐候选关闭 60 秒并恢复,每步记宿主回执、恢复后逐项核验;每个候选只跟紧邻基线对照,基线漂移作为噪声底。',
				method: '方法', noiseFloor: '噪声底', beyondNoise: '超出噪声', confounded: '窗口含流式,该对照不可比',
				skipped: '跳过', restore: '恢复', marks: '场景标记',
				via: '通道', viaRemote: 'ctx.remote(客户端 remote)', viaRoute: '宿主路由 /api/dsh-perf-hud/host',
				unattrShort: '未归因', unattrSuffix: '/帧', mark: '标记', markPlaceholder: '备注(可选)', noNote: '(无备注)',
				verify: '验收', vPrecise: '独立包名', vLt: 'longtask 归因', vIdle: '空闲基线',
			},
			en: {
				title: 'Perf HUD', off: 'off', turnOn: 'on', turnOff: 'off',
				fps: 'FPS', frameWorst: 'worst frame', longtask: 'longtask 60s', blame: 'attribution (time)',
				rest: 'rest', dom: 'DOM nodes', none: 'n/a', exportJson: 'Export JSON', clear: 'Clear',
				collapse: 'Collapse', expand: 'Expand', sessions: 'Sessions', messages: 'Messages', perMin: '/min',
				unattr: 'unattributed/frame', peak: 'peak',
				unattrHint: 'Frame gap not explained by instrumented callbacks: style recalc, paint, and vsync wait. CSS-animation cost only shows up here.',
				rateWindow: 'rate 12s', heap: 'JS heap (60s)', domWrites: 'DOM writes (by plugin)', est: '≈',
				worstSecond: 'worst second', ltCount: 'longtask count', hits: 'attributed', hit: 'hit', times: '',
				maxBlame: 'top', topBlame: 'attribution top', legFiber: 'fiber', legDom: 'DOM write', legOwner: 'package',
				perSec: '/s', samples: ' samples', unblamed: 'unattributed',
				domWritesHint: 'First number is the exact total; the rows below are estimates (stacks sampled every 10th write, hits scaled by 10).',
				precise: 'precise', preciseHint: 'Resolve single package names from the merged bundle sourcemap sections (lazy; one map fetch per rev)',
				component: 'component', cumulative: 'total', maps: 'maps',
				overview: 'overview', overviewHint: 'Three-second read: worst frame + worst longtask and its owner + attribution hit ratio',
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
				suspect: 'link suspected', isolation: 'isolation', candidate: 'candidates', baseline: 'baseline',
				startExp: 'Run experiment', abortExp: 'Abort and restore', stress: 'Self-test: render stall',
				stressHint: 'Self-test: one synchronous commit rendering 8000 offscreen nodes plus an explicit 80ms burn (node counts alone are not reliable), to self-check the attribution chain',
				stressRunning: 'self-test running', stressDone: 'self-test result', nodes: 'nodes',
				stressNoTask: 'no long task observed', stressCommit: 'commit', stressBurn: 'synthetic burn', stressSync: 'sync', stressSliced: 'sliced', stressNoFlush: 'flushSync unavailable', stressFromDom: 'DOM write',
				expHint: 'Waits for an idle session first (up to 5 min; streaming windows are not comparable). Then disables each candidate for 60s and restores it, recording the host receipt and verifying the restore. Each candidate is compared with its nearest baseline, with baseline drift as the noise floor.',
				method: 'method', noiseFloor: 'noise floor', beyondNoise: 'beyond noise', confounded: 'window had streaming; this comparison is not valid',
				skipped: 'skipped', restore: 'restore', marks: 'marks',
				via: 'channel', viaRemote: 'ctx.remote (client remote)', viaRoute: 'host route /api/dsh-perf-hud/host',
				unattrShort: 'unattr', unattrSuffix: '/frame', mark: 'Mark', markPlaceholder: 'note (optional)', noNote: '(no note)',
				verify: 'acceptance', vPrecise: 'own package names', vLt: 'longtask attribution', vIdle: 'idle baseline',
			},
		};
		const fallback = (key) => DICT.zh[key] ?? key;
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
			row: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginTop: 5 },
			// 标签不换行、不收缩(原来 flex:1 1 auto 会被长数值挤成一字一行);
			// 数值占满剩余宽度、右对齐、必要时在自己那一列换行。
			label: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 700, flex: '0 0 auto', whiteSpace: 'nowrap', lineHeight: 1.5 },
			num: { fontFamily: MONO_FONT, fontWeight: 700, fontVariantNumeric: 'tabular-nums', flex: '1 1 auto', textAlign: 'right', whiteSpace: 'normal', overflowWrap: 'break-word', lineHeight: 1.5 },
			btn: {
				font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'transparent',
				border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, padding: '2px 8px', cursor: 'pointer', flex: '0 0 auto',
			},
			sub: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginTop: 3, lineHeight: 1.5, whiteSpace: 'normal', overflowWrap: 'break-word' },
			sep: { marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--dsw-alias-border-l2)' },
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
				const id = natives.setInterval(() => force((n) => (n + 1) % 1000000), 500);
				// 自测需要"点了立刻渲染":把它暴露给模块级,而不是等下一次 0.5 秒 tick。
				state.requestRender = () => force((n) => (n + 1) % 1000000);
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
			const writeTop = domWriteTable()[0] ?? null;
			const tally = longTaskTally();
			const rows = pluginTable();
			const top = rows.slice(0, TOP_N);
			const rest = rows.slice(TOP_N);
			const restMs = rest.reduce((sum, row) => sum + row.ms, 0);
			const restCount = rest.reduce((sum, row) => sum + row.count, 0);

			const head = h('div', { style: S.head },
				h('span', { style: S.brand }, t('title')),
				h('span', { style: { ...S.num, flex: '0 0 auto', marginLeft: 'auto', color: levelDown(state.fps, 50, 30) } }, `${state.fps.toFixed(1)} fps`),
				h('button', {
					type: 'button',
					style: { ...S.btn, color: state.precise ? 'var(--dsw-alias-brand-primary)' : undefined },
					title: t('preciseHint'),
					onClick: () => setPrecise(state.precise === false),
				}, `${t('precise')}${state.precise ? '✓' : ''}`),
				h('button', { type: 'button', style: S.btn, title: open ? t('collapse') : t('expand'), onClick: toggle }, open ? '–' : '+'),
				h('button', { type: 'button', style: S.btn, title: t('turnOff'), onClick: () => setEnabled(false) }, t('turnOff')));

			if (open === false) {
				// 折叠不是"看不见":至少留下 fps / 最差帧 / 最差 longtask 三个读数。
				return h('div', { ref: setRoot, style: S.root(false) },
					h('div', { style: S.head },
						h('span', { style: S.brand }, t('title')),
						h('span', { style: { ...S.num, flex: '0 0 auto', marginLeft: 'auto', color: levelDown(state.fps, 50, 30) } }, `${state.fps.toFixed(0)} fps`),
						h('span', { style: S.label }, `${t('frameWorst')} ${state.frameWorst.toFixed(0)}ms`),
						worst === null ? null : h('span', { style: S.label }, `LT ${worst.ms.toFixed(0)}ms`),
						h('button', { type: 'button', style: S.btn, title: t('expand'), onClick: toggle }, '+'),
						h('button', { type: 'button', style: S.btn, title: t('turnOff'), onClick: () => setEnabled(false) }, t('turnOff'))));
			}

			const body = h('div', null,
				// ── 常显 1:卡不卡 + 谁的锅(原来"最差帧/长任务/命中"三行合一行)──
				h('div', { style: S.row },
					h('span', { style: S.label, title: overviewTitle() }, t('overview')),
					h('span', { style: { ...S.num, color: levelUp(state.frameWorst, 60, 120) } },
						`${t('frameWorst')} ${state.frameWorst.toFixed(0)}ms · ` +
						`LT ${worst === null ? t('none') : `${worst.ms.toFixed(0)}ms ${blameText(worst)}`}` +
						` · ${t('hit')} ${state.ltBlamed}/${state.ltTotal}${tally.topNames.length === 0 ? '' : ` · ${t('maxBlame')} ${short(tally.topNames[0][0])} ${tally.topNames[0][1]}×`}`)),

				// ── 常显 2:帧里"JS 之外"的残差(唯一能反映 CSS/绘制卡顿的数字)──
				h('div', { style: S.row },
					h('span', { style: S.label, title: t('unattrHint') }, t('unattr')),
					h('span', { style: S.num }, `${state.unattrAvg.toFixed(1)}ms · ${t('peak')} ${state.unattrPeak.toFixed(0)}ms`)),
				// ── 常显 3:回调归因 Top3(每插件一行,hover 补 msps 与累计)──
				h('div', { style: S.sep },
					h('div', { style: S.row },
						h('span', { style: S.label }, t('blame')),
						h('span', { style: S.num }, msPerSecText(state.attributedPerSec))),
					h('div', null, top.map((row, index) => h('div', { key: row.id, style: S.row },
						h('span', { style: S.label, title: `${row.id} · ${row.msps}ms${t('perSec')} · ${t('cumulative')} ${row.count}× / ${row.ms.toFixed(0)}ms` }, `${index + 1}. ${short(row.id)}`),
						h('span', { style: S.num }, attrText(row))))),
					rest.length === 0 ? null : h('div', { style: S.row },
						h('span', { style: S.label }, `${t('rest')} (${rest.length})`),
						h('span', { style: S.num }, `${restCount}× ${restMs.toFixed(0)}ms`))),

				// ── 折叠 1:取证明细(最差那秒 + DOM 写入者)──
				group('detail', t('groupDetail'),
					`${t('worstSecond')} ${worstSecondText()} · ${t('domWrites')} ${state.mutations}${writeTop === null ? '' : ` · ${short(writeTop.id)}`}`,
					h('div', { style: S.row },
						h('span', { style: S.label }, t('topBlame')),
						h('span', { style: S.num }, tally.topNames.length === 0
							? t('none')
							: tally.topNames.map(([name, count]) => `${short(name)} ${count}×`).join(' · ') + (tally.top.length > 3 ? ` · ${t('rest')} ${tally.top.length - 3}` : ''))),
					h('div', { style: S.row },
						h('span', { style: S.label }, `${t('hit')} (${t('legFiber')}/${t('legDom')}/${t('legOwner')})`),
						h('span', { style: S.num }, `${tally.fiber}/${tally.dom}/${tally.owner}${tally.none === 0 ? '' : ` · ${t('unblamed')} ${tally.none}`}`)),
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('domWritesHint') }, t('domWrites')),
						h('span', { style: S.num }, String(state.mutations))),
					writeRows()),

				// ── 折叠 2:DOM 与堆 ──
				group('dom', t('groupDom'),
					`${state.dom.total}${t('nodesSuffix')} ${rateText(state.dom.series)} · ${t('messages')} ${containerNodes('messages')}${state.heap === null ? '' : ` · ${t('heap')} ${mb(state.heap)}MB`}`,
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
				group('host', t('groupHost'),
					`${t('hostLoop')} ${loop === null ? (state.hostError === null ? t('notYet') : t('hostDown')) : `p50 ${loop.p50}ms · p99 ${loop.p99}ms`} · ${t('link')} ${link.count === 0 ? t('notYet') : `p50 ${link.p50}ms`}`,
					h('div', { style: S.row },
						h('span', { style: S.label }, t('stream')),
						h('span', { style: S.num }, `${state.streaming ? t('running') : t('idle')}${state.streaming || state.idleSince === 0 ? '' : ` ${Math.round((performance.now() - state.idleSince) / 1000)}s`}${state.baselineRunning ? ` · ${t('idleBase')}…` : ''}`)),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('hostLoop')),
						h('span', { style: { ...S.num, color: loop === null ? undefined : levelUp(loop.p99, 20, 60) } },
							state.hostError !== null ? `${t('hostDown')}:${state.hostError.slice(0, 26)}`
								: loop === null ? t('notYet') : `p50 ${loop.p50}ms · p99 ${loop.p99}ms`)),
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('hostEventsHint') }, t('hostEvents')),
						h('span', { style: S.num }, hostEventsText())),
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('linkHint') }, t('link')),
						h('span', { style: { ...S.num, color: linkSuspect ? 'var(--dsw-alias-state-warn-primary)' : undefined } }, linkRowText())),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('idleBase')),
						h('span', { style: S.num }, idleBase === null || idleBase === undefined
							? t('notYet')
							: `${idleBase.fps}fps · LT ${idleBase.longTasks} · ${idleBase.domPerMin}${t('perMin')}`)),
					idleBase === null || idleBase === undefined || idleBase.domPerMin <= 0 ? null : h('div', { style: S.sub },
						`${t('idleWriter')}: ${(idleBase.domTop ?? []).map((row) => `${short(row?.id ?? '?')}${row?.component === null || row?.component === undefined ? '' : `(${row.component})`}`).join(' / ') || t('none')}`)),

				// ── 折叠 4:工具箱(隔离实验 / 场景标记 / 验收)──
				group('tools', t('groupTools'),
					`${t('isolation')} ${experiment.phase}${experiment.phase === 'running' ? ` ${experiment.message}` : ''} · ${t('marks')} ${state.marks.length}`,
					h('div', { style: S.row },
						h('span', { style: S.label, title: `${t('expHint')}\n${t('method')}: ${experiment.method}` }, t('isolation')),
						h('span', { style: S.num }, experimentText())),
					h('div', { style: S.sub }, `${t('candidate')}: ${experiment.candidates.join(' ')}${experiment.via === null ? '' : ` · ${viaLabel(experiment.via)}`}`),
					experiment.baseline === null ? null : h('div', { style: S.sub }, `${t('baseline')}: ${experiment.baseline.fps}fps · LT ${experiment.baseline.longTasks} · ${experiment.baseline.domPerMin}${t('perMin')}`),
					experiment.noise === null ? null : h('div', { style: S.sub }, `${t('noiseFloor')}: ±${experiment.noise.fps}fps · ±${experiment.noise.unattrAvg}ms${t('unattrSuffix')} · ±${experiment.noise.longTasks}LT · ±${experiment.noise.domPerMin}${t('perMin')}`),
					experiment.results.length === 0 ? null : h('div', null, experiment.results.map((row) => h('div', { key: row.name },
						h('div', { style: S.row },
							h('span', { style: S.label, title: JSON.stringify(row.changeResult ?? row.error ?? null) }, `${short(row.name)}${row.applied ? '' : ` ${t('skipped')}`}`),
							h('span', { style: S.num }, row.delta === undefined || row.delta === null ? (row.reason ?? '') : `Δfps ${signed(row.delta.fps)} · ΔLT ${signed(row.delta.longTasks)}`)),
						row.delta === undefined || row.delta === null ? null : h('div', { style: S.sub },
							`Δ${t('unattrShort')} ${signed(row.delta.unattrAvg)}ms · ΔDOM ${signed(row.delta.domPerMin)}${t('perMin')} · ${t('restore')} ${row.restore?.ok === true ? '✓' : '✗'}` +
							` · ${t('beyondNoise')} ${beyondNoiseText(row)}` +
							(row.confounded === true ? ` · ⚠️ ${t('confounded')}` : ''))))),
					experiment.restored === null ? null : h('div', { style: S.sub },
						`${t('restore')}: ${experiment.restored.ok === true ? `✓ ${experiment.restored.restores?.length ?? 0}` : `✗ ${experiment.restored.diff?.length ?? 0} 处不一致`}`),
					h('div', { style: S.buttons },
						h('button', { type: 'button', style: S.btn, disabled: experiment.phase === 'running', onClick: () => runExperiment() }, t('startExp')),
						h('button', { type: 'button', style: S.btn, onClick: () => abortExperiment() }, t('abortExp')),
						h('button', { type: 'button', style: S.btn, title: t('stressHint'), onClick: () => W.__perfHud.stress() }, t('stress'))),
					h('div', { style: S.sub }, stressText()),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('marks')),
						h('span', { style: S.num }, state.marks.length === 0 ? t('none') : `${state.marks.length} · ${clock(state.marks[state.marks.length - 1]?.t ?? Date.now())}`)),
					state.marks.length === 0 ? null : h('div', { style: S.sub },
						`${(state.marks[state.marks.length - 1]?.note || t('noNote'))} · ${state.marks[state.marks.length - 1]?.fps ?? '?'}fps · LT ${state.marks[state.marks.length - 1]?.longTask ? `${state.marks[state.marks.length - 1].longTask.ms}ms` : t('none')}`),
					h('div', { style: S.buttons },
						h('input', {
							type: 'text',
							value: draft,
							placeholder: t('markPlaceholder'),
							onChange: (event) => setDraft(event.target.value),
							style: S.input,
						}),
						h('button', { type: 'button', style: S.btn, onClick: () => { addMark(draft); setDraft(''); } }, t('mark'))),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('verify')),
						h('span', { style: S.num }, `${v.precise.mapStates?.ready ?? 0}/${v.precise.bundles} ${t('maps')}`)),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('vPrecise')),
						h('span', { style: S.num }, `${v.ownPackageNames['dsh-status-rotator'] ? '✓' : '✗'} rotator / ${v.ownPackageNames['dsh-notify-me'] ? '✓' : '✗'} notify-me`)),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('vLt')),
						h('span', { style: S.num }, `${v.longTask.attributed}/${v.longTask.total} · ${t('component')} ${v.longTask.withComponent}`)),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('vIdle')),
						h('span', { style: S.num }, v.idle.baseline === null ? t('notYet') : `${t('messages')} ${v.idle.baseline.domPerMin}${t('perMin')}`))),

				h('div', { style: { ...S.sep, display: 'flex', gap: 6 } },
					h('button', { type: 'button', style: S.btn, onClick: exportJson }, t('exportJson')),
					h('button', { type: 'button', style: S.btn, onClick: () => W.__perfHud.clear() }, t('clear'))));

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

			// 页面隐藏/关闭前落盘,别丢最后 5 秒的样本。
			const persist = () => flush(true);
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
