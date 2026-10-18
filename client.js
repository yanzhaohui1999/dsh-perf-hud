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
		// 「包 × 来源」摘要里两个名字各自的字符上限:摘要那一行是 label(不收缩)+ value(右对齐),
		// 不截断就会折成参差的两行(实测 `dsh-client-ui-renderer · DOMWebSocket.onmessage 1234ms` = 53 字符)
		const CROSS_SUMMARY_NAME_MAX = 14;
		const CROSS_SUMMARY_SRC_MAX = 15;
		const EVIDENCE_MAX = 4;      // 「可疑脚本」那一块最多列几条(再多就不是"缩小范围"而是列清单了)
		const LT_WINDOW_MS = 60000;  // longtask 观察窗口
		const RECENT_MAX = 256;      // 用于 longtask 归因的最近回调(含仍在执行的)
		const MUT_SAMPLE = 10;       // DOM 写入归因:每 10 次抓一次栈
		const MUT_TOP = 2;           // 面板展示的 DOM 写入者条数
		const BUNDLE_PREFIX = 'bundle:';       // 多包合并 URL 的 key 前缀
		const LS_DEEP = 'dsh-perf-hud:deep';
		const LS_PRECISE = 'dsh-perf-hud:precise';
		const LS_MAP = 'dsh-perf-hud:map';     // 按 rev 缓存的 section 分段表
		const LS_MAP_INDEX = 'dsh-perf-hud:map:index';   // 上面那些键的 LRU 索引(只留最近 N 个 rev)
		const MAP_CACHE_MAX = 8;
		const LS_MARKS = 'dsh-perf-hud:marks';
		const LS_GROUPS = 'dsh-perf-hud:groups';
		const LS_INCIDENTS = 'dsh-perf-hud:incidents:v1';   // 守夜层留存的事故(要活过刷新)
		// 诊断上下文(看实时 / 看哪条历史事故 / 看事故里的哪一帧)。它是**界面状态**,与事故包分开存:
		// 事故落盘只在切片那一刻写一次,而用户来回切换上下文不该逼着再抓一次事故。
		const LS_WATCHUI = 'dsh-perf-hud:watchui:v1';
		const LS_VIEW = 'dsh-perf-hud:view:v1';        // 只存视图名 / 标签页 / 趋势窗口,不存读数
		const TALLY_TREND_SHORT_MS = 3600000;          // 主界面「最近 1 小时」
		const TALLY_TREND_LONG_MS = 86400000;          // 主界面「最近 24 小时」
		const LS_SESSIONS = 'dsh-perf-hud:sessions:v1';     // A2 跨会话基线(每个会话一条,只进导出件)
		const SESSION_KEEP = 20;                            // 跨会话基线保留最近几个会话
		// 面板根节点 id 与它自己的控件态样式表 id:纯 CSS 的 hover / focus / disabled 靠它们生效
		const ROOT_ID = 'dsh-perf-hud-root';
		const STYLE_ID = 'dsh-perf-hud-style';
		const HOST_ROUTE = '/api/dsh-perf-hud/host';
		const RTT_INTERVAL_MS = 10000;
		const LOAD_INTERVAL_MS = 60000;
		// 宿主快照超过 2.5 个轮询周期就算过期(轮询是 10s;留一次重试的余量)。
		const HOST_STALE_MS = RTT_INTERVAL_MS * 2.5;
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
		// 历史回放条最多画多少列:一条事故窗口(13 秒)可能有几百帧,一帧一个 DOM 节点会把
		// "画条子"变成面板自己的开销。每列取该列里**最差的那一帧**(所以尖刺不会被平均掉),
		// 并把那一帧的引用留在格子里 —— 点击、选中、高亮都必须映射回**真实记录**,不合成帧。
		const REPLAY_COLS = 240;
		// A4:交互延迟(event timing)。只收 ≥100ms 的 —— 与守夜同一条线,而且要的不是全量事件流
		// (mousemove/keydown 那种量级会把环形缓冲冲掉)。element timing 走同一个观察器。
		const WATCH_EVENT_MS = 100;
		const WATCH_EVENT_MAX = 200;           // 交互计时的环形上限
		// ── 捕获计数(与"留存了几份详细现场"是两件事,所以两套数据)──────────────
		// 留存清单受容量限制(最差 10 条 + 每天 1 条),它的条数**不能**当"发生了多少次卡顿";
		// 所以另起一份轻量计数:每分钟一个 6 元数组的桶,只留最近 24 小时,再按天汇总 30 天。
		// 七个计数在桶里的下标(数组比对象省一半体积:24h 最多 1440 个桶)。
		// `triggered` = 起过几次捕获(一串触发只算一次);`captured` = 切成了几份现场;
		// `coalesced` = 被并进同一串的触发数(**不是次数,是这一串有多密**)—— 三者的区别见 tallySum。
		// ⚠️ 实测踩过:一开始把"检测到"写成 `captured + coalesced`,真页面上一次卡顿在后摇窗口里
		// 每帧都会触发一次,于是**一次停顿被记成 18 次**,连"卡了几次"都答不了。
		const TALLY_FIELDS = { triggered: 0, captured: 1, coalesced: 2, dropped: 3, failed: 4, worstMs: 5, trimmed: 6 };
		const TALLY_BUCKET_MS = 60000;         // 桶的粒度:一分钟
		const TALLY_MINUTES = 1440;            // 分钟桶只留最近 24 小时
		const TALLY_DAYS = 30;                 // 按天汇总留最近 30 天
		const TALLY_SAVE_DELAY_MS = 2000;      // 一次卡顿里 coalesced 会被连加很多次,落盘要合并
		const LS_TALLY = 'dsh-perf-hud:tally:v1';
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

		// ───────────────────────── 有 deadline 的同源读取 ─────────────────────────
		// 参考点:官方 Inspector 的每个异步都有显式上限(startup/clientRuntime/query timeout),
		// 而且已关闭的 generation 不许再发布迟到结果。这里同一套纪律:
		//   · 所有会 pending 的 fetch 都走 fetchTextWithin / fetchJsonWithin,各自有命名上限;
		//   · stop() 会 abort 当前代(state.abort),旧代(state.epoch 变了)的结果一律丢弃;
		//   · 失败只写 timeout / cancelled,不把"永远 text-pending"留在面板上。
		const FETCH_TIMEOUT_MS = { host: 5000, bundle: 30000, map: 20000, script: 20000, probe: 30000 };

		function timeoutError(ms) {
			const error = new Error(`timeout ${ms}ms`);
			error.name = 'TimeoutError';
			return error;
		}

		function cancelledError() {
			const error = new Error('cancelled');
			error.name = 'AbortError';
			return error;
		}

		function isAbortError(error) {
			return error !== null && typeof error === 'object' && error.name === 'AbortError';
		}

		function fetchFailureText(error, ms) {
			if (isAbortError(error)) return 'cancelled';
			if (error !== null && typeof error === 'object' && error.name === 'TimeoutError') return `timeout ${ms}ms`;
			return error instanceof Error ? error.message : String(error);
		}

		/**
		 * 同源 fetch + 读取 body,并受两个上限约束:单次 `ms` 与当前采集代。
		 * ⚠️ 读 body 也包在 deadline 里 —— 只把 `fetch()` resolve 当完成会让慢 body 永远 pending。
		 */
		async function fetchTextWithin(url, options, ms) {
			const epoch = state.epoch;
			const controller = new AbortController();
			let timedOut = false;
			const timer = natives.setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, ms);
			const outer = state.abort === null || state.abort === undefined ? null : state.abort.signal;
			const onAbort = () => controller.abort();
			if (outer !== null) {
				if (outer.aborted) controller.abort();
				else outer.addEventListener('abort', onAbort, { once: true });
			}
			try {
				const response = await fetch(url, { ...options, signal: controller.signal });
				const text = await response.text();
				if (state.epoch !== epoch) throw cancelledError();
				return { response, text };
			} catch (error) {
				if (timedOut) throw timeoutError(ms);
				if (outer !== null && outer.aborted) throw cancelledError();
				if (state.epoch !== epoch) throw cancelledError();
				throw error;
			} finally {
				natives.clearTimeout(timer);
				if (outer !== null) outer.removeEventListener('abort', onAbort);
			}
		}

		/** 同源 JSON 读取:HTTP 状态由调用方判断,但 body 必须是合法 JSON。 */
		async function fetchJsonWithin(url, options, ms) {
			const { response, text } = await fetchTextWithin(url, options, ms);
			let data;
			try {
				data = JSON.parse(text);
			} catch (error) {
				throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
			}
			return { response, data };
		}

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

		/**
		 * 解析状态推进计数。sourcemap 分段表与脚本文本都是**异步**到位的,所以窗口聚合的缓存指纹
		 * 必须带上它:只用 `条数|最后一条 t` 的话,环满 200 条而一时没有新 LoAF 时,「窗口」那三行
		 * 与交叉表会一直冻在"插件批次(未按 sourcemap 拆)" —— 同屏「本帧」行(不缓存)已经给出真名,
		 * 窗口却还是旧结论,而且打开深录也不刷新。解析完成/失败/切换精确归因各推一次。
		 */
		let resolveSeq = 0;
		function markResolved() { resolveSeq += 1; }

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
			if (existing !== undefined) {
				// 上一代被 stop() 取消的条目不留成永久失败:下次开启精确归因时重新排队。
				if (existing.state === 'failed' && existing.reason === 'cancelled') bundleMaps.delete(key);
				else {
					// 访问即刷新 LRU 位置(内存缓存也有上限)。
					bundleMaps.delete(key);
					bundleMaps.set(key, existing);
					return existing;
				}
			}
			const scriptUrl = absolutePluginUrl(key.slice(BUNDLE_PREFIX.length));
			const entry = { state: 'pending', offsets: null, names: null, paths: null, count: 0, reason: '', source: '' };
			bundleMaps.set(key, entry);
			while (bundleMaps.size > MAP_CACHE_MAX) {
				const oldest = bundleMaps.keys().next().value;
				if (oldest === key) break;
				bundleMaps.delete(oldest);
			}
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
					// 老缓存(v1,加 paths 之前存的)没有这一项 → 文件路径那一层如实留空
					entry.paths = Array.isArray(parsed.paths) ? parsed.paths : null;
					entry.count = parsed.offsets.length;
					entry.state = 'ready';
					markResolved();
					entry.source = 'localStorage';
					return entry;
				}
			} catch (error) { /* 缓存坏了就重取 */ }
			loadBundleMap(entry, scriptUrl);
			return entry;
		}

		/**
		 * map 缓存的 LRU 索引。为什么必须有上限:rev 每次构建都变,`localStorage` 里的
		 * `dsh-perf-hud:map:<rev>:<len>` 只写不删,几个月后会悄悄吃配额,而写失败被 catch 掉。
		 * 保留最近 `MAP_CACHE_MAX` 个 rev;写入配额失败时先淘汰可重建的 map 缓存,再重试一次。
		 */
		function readMapIndex() {
			try {
				const parsed = JSON.parse(localStorage.getItem(LS_MAP_INDEX) ?? 'null');
				return parsed !== null && Array.isArray(parsed.keys) ? parsed.keys : [];
			} catch (error) { return []; }
		}

		function writeMapIndex(keys) {
			try { localStorage.setItem(LS_MAP_INDEX, JSON.stringify({ v: 1, keys })); } catch (error) { /* 索引写不进就下次重建 */ }
		}

		/** 纯函数:按 at 降序留最近 max 个;坏的条目丢掉。 */
		function pruneMapIndex(keys, max = MAP_CACHE_MAX) {
			const list = (Array.isArray(keys) ? keys : [])
				.filter((row) => row !== null && typeof row === 'object' && typeof row.key === 'string')
				.map((row) => ({ key: row.key, at: typeof row.at === 'number' ? row.at : 0 }))
				.sort((a, b) => b.at - a.at);
			return { keep: list.slice(0, max), evicted: list.slice(max) };
		}

		function evictMapEntries(count) {
			const index = readMapIndex();
			const keepCount = Math.max(0, index.length - Math.max(0, count));
			const pruned = pruneMapIndex(index, keepCount);
			for (const row of pruned.evicted) {
				try { localStorage.removeItem(row.key); } catch (error) { /* 删不掉就交给配额错误 */ }
			}
			writeMapIndex(pruned.keep);
			state.mapCache.evicted += pruned.evicted.length;
			return pruned.evicted.length;
		}

		function touchMapCache(storageKey) {
			const index = readMapIndex().filter((row) => row.key !== storageKey);
			index.push({ key: storageKey, at: Date.now() });
			const pruned = pruneMapIndex(index, MAP_CACHE_MAX);
			for (const row of pruned.evicted) {
				try { localStorage.removeItem(row.key); } catch (error) { /* 同上 */ }
			}
			writeMapIndex(pruned.keep);
			state.mapCache.evicted += pruned.evicted.length;
		}

		/** 写一份 map 缓存;配额失败时先淘汰最旧的 map(它们可重建),仍失败则只留内存。 */
		function saveMapCache(storageKey, payload) {
			const text = JSON.stringify(payload);
			try {
				localStorage.setItem(storageKey, text);
				touchMapCache(storageKey);
				return true;
			} catch (error) {
				if (evictMapEntries(2) > 0) {
					try {
						localStorage.setItem(storageKey, text);
						touchMapCache(storageKey);
						return true;
					} catch (retryError) { /* 落到下面记失败 */ }
				}
				state.mapCache.failed += 1;
				return false;
			}
		}

		/** 启动时清一次旧 rev;老安装没有索引时按 localStorage 的插入顺序保留最近 N 个。 */
		function pruneMapCache() {
			const index = readMapIndex();
			if (index.length === 0) {
				try {
					if (typeof localStorage.key !== 'function') return;
					const keys = [];
					for (let i = 0; i < localStorage.length; i += 1) {
						const key = localStorage.key(i);
						if (typeof key === 'string' && key.startsWith(`${LS_MAP}:`) && key !== LS_MAP_INDEX) keys.push(key);
					}
					const extra = keys.length - MAP_CACHE_MAX;
					if (extra > 0) {
						for (const key of keys.slice(0, extra)) localStorage.removeItem(key);
						state.mapCache.evicted += extra;
					}
				} catch (error) { /* 扫不了就算了,不影响功能 */ }
				return;
			}
			const pruned = pruneMapIndex(index, MAP_CACHE_MAX);
			for (const row of pruned.evicted) {
				try { localStorage.removeItem(row.key); } catch (error) { /* 同上 */ }
			}
			writeMapIndex(pruned.keep);
			state.mapCache.evicted += pruned.evicted.length;
		}

		async function loadBundleMap(entry, scriptUrl) {
			const url = mapUrlOf(scriptUrl);
			if (url === null) {
				entry.state = 'failed';
				markResolved();
				entry.reason = 'URL 里没有 ?? 列表';
				return;
			}
			try {
				const { response, text } = await fetchTextWithin(url, { credentials: 'same-origin' }, FETCH_TIMEOUT_MS.map);
				if (response.ok === false) throw new Error(`HTTP ${response.status}`);
				const document = JSON.parse(text);
				const sections = Array.isArray(document?.sections) ? document.sections : null;
				if (sections === null || sections.length === 0) throw new Error('没有 sections');
				// 一次建成**三列对齐**的表,再一起排序 —— 原来只 sort offsets、names 没跟着动,
				// 于是 `names[i]` 与 `offsets[i]` 从排序那一刻起就说不上是同一段(没人读过它,
				// 所以一直没暴露);paths 加上之后这个错位会直接变成"文件路径配错包"。
				const rows = [];
				for (const section of sections) {
					const line = section?.offset?.line;
					const name = sectionName(section);
					if (typeof line !== 'number' || name === null) continue;
					rows.push([line, name, sectionSource(section)]);
				}
				if (rows.length === 0) throw new Error('sections 里没有可用边界');
				rows.sort((a, b) => a[0] - b[0]);
				const offsets = rows.map((row) => [row[0], row[1]]);
				const names = rows.map((row) => row[1]);
				const paths = rows.map((row) => row[2]);
				entry.offsets = offsets;
				entry.names = names;
				entry.paths = paths;
				entry.count = offsets.length;
				entry.state = 'ready';
				markResolved();
				entry.source = 'sourcemap';
				// 只留 offsets/names/paths,原始 JSON 立刻丢掉(58 段时 paths 只多几百字节)。
				// 写不进配额时会先淘汰最旧的 map(可重建),再重试一次;失败只留内存并计数。
				saveMapCache(entry.storageKey, { v: 1, offsets, names, paths });
			} catch (error) {
				if (isAbortError(error)) {
					entry.state = 'failed';
					entry.reason = 'cancelled';
					markResolved();
					return;
				}
				entry.reason = fetchFailureText(error, FETCH_TIMEOUT_MS.map);
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
				const [merged, probes] = await Promise.all([
					fetchTextWithin(scriptUrl, { credentials: 'same-origin' }, FETCH_TIMEOUT_MS.probe),
					Promise.all(ids.map(async (id) => {
						try {
							const { text } = await fetchTextWithin(`${location.origin}/plugins/??${id}/client.js${suffix}`, { credentials: 'same-origin' }, FETCH_TIMEOUT_MS.probe);
							return { id, head: text.slice(0, 200) };
						} catch (error) {
							return { id, head: '' };
						}
					})),
				]);
				const text = merged.text;
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
				// 兜底路径只认得包 id(靠单包响应的首字节定位边界),**没有**每个 section 的
				// sources → 文件路径这一层如实留空(面板会写"未还原到分片",不拿包名冒充文件名)。
				entry.paths = null;
				entry.count = offsets.length;
				entry.state = 'ready';
				markResolved();
				entry.source = 'probe';
				saveMapCache(entry.storageKey, { v: 1, offsets, names: entry.names });
			} catch (error) {
				entry.state = 'failed';
				markResolved();
				entry.reason = isAbortError(error) ? 'cancelled' : fetchFailureText(error, FETCH_TIMEOUT_MS.probe);
			}
		}

		/**
		 * section 的**源文件路径**。合并包的 sourcemap 里,每个 section 的 `map.sources[0]`
		 * 就是那个包的那份文件(`/plugins/<包>/<文件>`)。包名只能回答"是谁",文件才回答
		 * "打开哪个文件" —— 所以两者都留。拿不到时返回 null(照实说,不猜)。
		 */
		function sectionSource(section) {
			const sources = section?.map?.sources;
			if (Array.isArray(sources) === false) return null;
			let fallback = null;
			for (const source of sources) {
				if (typeof source !== 'string' || source === '') continue;
				if (/\/plugins\/[^?#]+/.test(source)) return source;
				if (fallback === null) fallback = source;
			}
			return fallback;
		}

		/**
		 * V8 行号(1-based)二分到第几段(offset 0-based)。段表为空 / 行号非法 → -1。
		 * `sectionOwner`(包名)与 `sectionPath`(文件路径)共用它,免得两处各写一遍二分。
		 */
		function sectionIndex(entry, lineNumber) {
			const offsets = entry?.offsets;
			if (Array.isArray(offsets) === false || offsets.length === 0) return -1;
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
			return found;
		}

		/** V8 行号(1-based)二分到 section(offset 0-based)→ 包名。 */
		function sectionOwner(entry, lineNumber) {
			const index = sectionIndex(entry, lineNumber);
			return index === -1 ? null : entry.offsets[index][1];
		}

		/**
		 * 同一段的源文件路径。⚠️ `paths` 是后加的字段:老的 localStorage 缓存(v1)里没有它,
		 * 那时返回 null —— **不为了补它去重下那份 12MB 的 map**(宁可少一个文件名)。
		 */
		function sectionPath(entry, lineNumber) {
			const index = sectionIndex(entry, lineNumber);
			if (index === -1) return null;
			const paths = entry?.paths;
			if (Array.isArray(paths) === false) return null;
			const path = paths[index];
			return typeof path === 'string' && path !== '' ? path : null;
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
		// LoAF 的 scripts[] 给的是「合并批 URL + 字符位置」,而包名藏在合并批里(见 docs/mechanisms.md)。
		// 单包 URL 直接从 URL 读得出包名;多包 URL 必须把字符位置换算成行号,再查分段表。
		// 换算要那段脚本文本(同源 fetch,浏览器内存缓存命中),所以后台预取一次、按 URL 缓存。
		const scriptLines = new Map();   // url -> { state, starts, reason }
		const SCRIPT_LINES_MAX = 8;      // 有界:实测一个会话里真正出现的合并批只有一两个

		/** 取一段脚本文本的「每行起始偏移」,用于 charPos → 1-based 行号。 */
		async function loadScriptLines(url) {
			const entry = { state: 'pending', starts: null, reason: '' };
			scriptLines.set(url, entry);
			try {
				const { response, text } = await fetchTextWithin(url, { credentials: 'same-origin' }, FETCH_TIMEOUT_MS.script);
				if (response.ok === false) throw new Error(`HTTP ${response.status}`);
				// 逐 UTF-16 code unit 扫 —— 与 V8 给的 sourceCharPosition 同一套计数,
				// 不能用 code point(遇到 emoji 一类会整体错位)
				const starts = [0];
				for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
				entry.starts = starts;
				entry.length = text.length;
				entry.state = 'ready';
				markResolved();
			} catch (error) {
				entry.state = 'failed';
				entry.reason = isAbortError(error) ? 'cancelled' : fetchFailureText(error, FETCH_TIMEOUT_MS.script);
				// 取消的条目不留在缓存里:下次还能重新预取(否则永远是 failed)。
				if (isAbortError(error)) scriptLines.delete(url);
				markResolved();
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
		 * 脚本里的字符位置 → **这份脚本文本里的行号**(1-based)。返回 `{ line, via }`;
		 * line 为 null 时 `via` 说明为什么拿不到(照实显示,不猜)。
		 *
		 * ⚠️ 口径:这是**脚本文件自己的行号** —— 单包 URL 时就那个文件;合并批里是**合并后的
		 * 大文件**的行号。**不是**原始源码(TS/TSX)的行号:那要解开 section 内层 `mappings`
		 * 的 VLQ,本项目没做(见 REVIEW「还剩什么」)。所以它够用来定位"打开哪个文件的哪一段",
		 * 不够用来"跳到源码某一行"。
		 */
		function scriptPosition(url, charPos) {
			if (typeof url !== 'string' || url === '') return { line: null, via: 'no-url' };
			if (typeof charPos !== 'number' || charPos < 0) return { line: null, via: 'no-charpos' };
			const entry = scriptLines.get(url);
			// ⚠️ 这里**不预取**脚本文本:预取只发生在深录档(`loafScripts` 里判 precise)。
			// 以前这里顺手 `ensureScriptLines(url)` —— 于是"看一眼面板"会去拉整份合并批脚本文本
			// (几 MB),破坏了守夜的零成本边界;而且会在**没有包名**的情况下算出一个合并大文件里的
			// 行号(25580 这种),那不是精度,是误导。没预取就照实说"还没预取"。
			if (entry === undefined) return { line: null, via: 'text-not-fetched' };
			if (entry.state === 'failed') return { line: null, via: `text-failed(${entry.reason ?? ''})` };
			if (entry.state !== 'ready') return { line: null, via: 'text-pending' };
			const line = scriptLineOf(url, charPos);
			if (line === null) return { line: null, via: 'no-charpos' };
			if (line < 1) return { line: null, via: 'out-of-range' };
			return { line, via: 'text' };
		}

		/**
		 * 「这个包名 / 这个行号是从哪来的」压成一句人话。**故意只分五类** —— 面板正文放不下
		 * 十几个 via 码,而"直接从 URL 读出来的"与"靠 sourcemap 分段推断的"之间**信任度的差别**
		 * 才是读者要看的。原始 via 码仍然进悬停与导出件(留给分析者核对)。
		 */
		function viaText(via) {
			if (via === 'url' || via === 'text') return translate('viaDirect');
			if (via === 'section') return translate('viaInferred');
			if (via === 'not-plugin') return translate('viaNotPlugin');
			if (via === 'text-not-fetched') return translate('viaNotFetched');
			if (typeof via === 'string' && (via.startsWith('text-failed') || via.startsWith('map-'))) return translate('viaFailed');
			return translate('viaUnavailable');
		}

		/**
		 * 一条脚本的**证据**:把"函数名 / 哪个包 / 哪个文件 / 第几行 / 花了多久 / 谁调起来的"
		 * 一次算齐,每一段都带**它是怎么来的**(`pkgVia` / `lineVia`)—— 面板与导出件共用同一份
		 * 口径,不许把"推断出来的包名"说成"测出来的根因"(直接测量 / 归因推断 / 尚无法确认三者
		 * 在文案上分开)。
		 *
		 * `script` 有两个来源:帧环里的脚本(自带 `url` / `invoker`)或事故包的 `topScripts`
		 * (url 在 `incident.urls` 表里,由调用方解出来传进来)。
		 */
		function scriptEvidence(script, url) {
			const charPos = script?.charPos;
			const resolved = packageOfScript(url, charPos);
			const position = scriptPosition(url, charPos);
			const owner = typeof url === 'string' && url !== '' ? ownerOfUrl(url) : null;
			const inBundle = owner !== null && owner.startsWith(BUNDLE_PREFIX);
			let file = null;
			if (inBundle === true) {
				// 合并批:文件名只能从 sourcemap 的 section 拿(probe 兜底过就只剩包名 → null)
				if (state.precise === true && position.line !== null) {
					const entry = bundleMap(owner);
					if (entry.state === 'ready') file = sectionPath(entry, position.line);
				}
			} else if (typeof url === 'string' && url !== '') {
				// 单包 URL / 应用自己的外壳 bundle:URL 的路径部分就是那个文件。
				// ⚠️ **单包组合**(`plugins/??<包>/client.js`)不能交给 `new URL().pathname` ——
				// `??` 里第一个 `?` 会被当成查询串的开始,pathname 只剩 `/plugins/`,于是面板会
				// 把"文件路径"显示成 `/plugins/`(实测踩到)。这类 URL 自己拼:组合里只有一个包,
				// 等价于 `plugins/<包>/<文件>`。
				const combo = /\/plugins\/\?\?([^/?&,]+)\/([^?&,]+?\.js)/.exec(url);
				if (combo !== null) {
					file = `/plugins/${combo[1]}/${combo[2]}`;
				} else {
					try {
						const path = new URL(url, location.href).pathname;
						file = path === '' ? null : path;
					} catch (error) { file = null; }
				}
			}
			// 「这个行号属于哪个文件」—— 合并批的 charPos → 行号是相对**合并后的大文件**的,
			// 而 file 是那个包自己的源文件;两者不是同一个坐标系,**不许拼成 file:line**
			// (那看着精确,实际指不到任何一行)。单包 URL / 单包组合才是同一个文件。
			const lineScope = position.line === null ? null : (resolved.via === 'section' ? 'bundle' : (file === null ? null : 'file'));
			return {
				fn: typeof script?.fn === 'string' && script.fn !== '' ? script.fn : null,
				ms: typeof script?.ms === 'number' ? script.ms : 0,
				pkg: resolved.pkg,
				pkgVia: resolved.via,
				file,
				line: position.line,
				lineVia: position.via,
				lineScope,
				invoker: typeof script?.invoker === 'string' && script.invoker !== '' ? script.invoker : null,
				invokerType: typeof script?.invokerType === 'string' ? script.invokerType : null,
				url: typeof url === 'string' && url !== '' ? url : null,
			};
		}

		/**
		 * 那两行小表里的名字:`<函数> @ <包>`,缺什么就照实写缺什么。
		 * ⚠️ 字段一律用 `== null` 判:**事故包里读回的 topScripts 可能是加这几个字段之前存的**
		 * (少了 file/line/invoker),那时不能抛错、也不能渲染成 `undefined`。
		 */
		function evidenceName(ev) {
			const who = ev.fn == null || ev.fn === '' ? translate('fnUnknown') : short(ev.fn);
			const pkg = ev.pkg == null || ev.pkg === '' ? translate('pkgUnresolvedShort') : short(ev.pkg);
			return `${who} @ ${pkg}`;
		}

		/**
		 * 「文件(:行)」那一格。文件拿不到就退回脚本名,两个都没有才给 null。
		 * ⚠️ **合并批不拼 `file:line`**:那里的行号是合并后大文件里的行号,而 file 是包内源文件 ——
		 * 拼起来看着精确,其实指不到任何一行。那种情况只给文件,行号另起一段(`evidenceLine`)。
		 */
		function evidencePlace(ev) {
			const file = ev.file == null ? (ev.url == null ? null : ev.url) : ev.file;
			if (file === null && ev.line == null) return null;
			const where = file === null ? translate('fileUnresolved') : short(file);
			if (ev.line == null || ev.lineScope === 'bundle') return where;
			return `${where}:${ev.line}`;
		}

		/**
		 * 悬停/复制里的「位置」那段:文件与行号**分列**,合并批的行号明确标成"合并脚本行"。
		 * 不把两者混成一个数字,是为了让读者一眼看出"这不是原始源码行"。
		 */
		function evidenceWhereText(ev) {
			const parts = [];
			const place = evidencePlace(ev);
			if (place !== null) parts.push(place);
			if (ev.line != null && ev.lineScope === 'bundle') parts.push(`${translate('evidenceBundleLine')} ${ev.line}`);
			parts.push(`${viaText(ev.pkgVia)} / ${viaText(ev.lineVia)}`);
			return parts.join(' · ');
		}

		/**
		 * 复制一行时给的文本:自描述、能直接粘给别的 AI。末尾把两个 via 码原样带上 ——
		 * 读的人不必猜"这个包名是读出来的还是推出来的"。
		 */
		function evidenceLine(ev) {
			const parts = [evidenceName(ev)];
			const place = evidencePlace(ev);
			if (place !== null) parts.push(place);
			// 合并批:行号单独一段,写明它是**合并脚本**里的行(不是 file 里的行,也不是源码行)
			if (ev.line != null && ev.lineScope === 'bundle') parts.push(`${translate('evidenceBundleLine')} ${ev.line}`);
			parts.push(`${Math.round(typeof ev.ms === 'number' ? ev.ms : 0)}ms`);
			if (ev.invoker != null && ev.invoker !== '') parts.push(`${translate('evidenceInvoker')} ${ev.invoker}`);
			parts.push(`pkg=${ev.pkgVia ?? '-'} line=${ev.lineVia ?? '-'}`);
			return parts.join(' · ');
		}

		/**
		 * 事故里的一条证据:**优先用捕获时存下来的定位结果**,只有包里确实没有的字段才回退到现算。
		 *
		 * 为什么不能一律现算:`scriptEvidence()` 依赖**当前**会话的 `state.precise` 与内存里的
		 * `scriptLines` / `bundleMaps` 缓存 —— 刷新之后那两个缓存都是空的,现算会把捕获时已经定下来的
		 * pkg / file / line 变成 `null` / `text-not-fetched`,**历史事故的定位信息就这样丢了**
		 * (事故包落盘本来就为了活过刷新)。老包(加 file/line/lineVia/invoker 之前抓的)没有这些
		 * 字段,那时才现算 —— 它是兼容垫片,不是主路。
		 */
		function incidentScriptEvidence(script, url, fallback) {
			const stored = script ?? {};
			const computed = fallback ?? {};
			const pick = (key) => (stored[key] !== undefined ? stored[key] : (computed[key] ?? null));
			const ms = typeof stored.ms === 'number' ? stored.ms : (typeof computed.ms === 'number' ? computed.ms : 0);
			const line = pick('line');
			const pkgVia = pick('pkgVia');
			// 老包没有 lineScope:按同一条规则现推(分段表算出来的包 → 行号属于合并大文件)
			const lineScope = stored.lineScope !== undefined
				? stored.lineScope
				: (line == null ? null : (pkgVia === 'section' ? 'bundle' : 'file'));
			return {
				fn: pick('fn'),
				ms,
				pkg: pick('pkg'),
				pkgVia,
				file: pick('file'),
				line,
				lineVia: pick('lineVia'),
				lineScope,
				invoker: pick('invoker'),
				invokerType: pick('invokerType'),
				url: computed.url ?? (typeof url === 'string' && url !== '' ? url : null),
			};
		}

		/**
		 * 事故里第 N 条脚本 → 证据(URL 从事故的 URL 表里解)。**面板与复制摘要共用它** ——
		 * 两条路必须是同一份口径,否则"面板上看到一个文件:行、复制出来却没有"这种不一致会回来。
		 */
		function incidentEvidenceAt(row, script) {
			const urls = row === null || row === undefined || Array.isArray(row.urls) === false ? [] : row.urls;
			const url = script !== null && script !== undefined && script.u >= 0 ? (urls[script.u] ?? '') : '';
			const needs = script === null || script === undefined || script.pkg === undefined
				|| script.file === undefined || script.line === undefined || script.lineVia === undefined;
			return incidentScriptEvidence(script, url, needs ? scriptEvidence(script, url) : null);
		}

		/** 事故包里那几条脚本的证据行(与面板「可疑脚本」同一份口径,同样只取前 EVIDENCE_MAX 条)。 */
		function incidentEvidenceLines(row) {
			const summary = row?.summary ?? {};
			const top = Array.isArray(summary.topScripts) ? summary.topScripts : [];
			return top.slice(0, EVIDENCE_MAX).map((script) => evidenceLine(incidentEvidenceAt(row, script)));
		}

		/**
		 * 面板上「可疑脚本」那一块吃什么。**两个上下文各吃自己那一份**:
		 *
		 *   · 历史事故:先给**选中那一帧**自己的脚本记录(`incident.loaf[].scripts[]` —— 它是
		 *     捕获时存下来的,跨会话读回仍在);这一帧没有 LoAF 记录时才退回**这条事故窗口内**
		 *     的切片,并把范围写在标签上、明说"不是这一帧的"。绝不回退到实时帧环。
		 *   · 实时:当前选中的那条实时帧的脚本。
		 *
		 * 范围写在标签上,读者不会把两者当同一份数据。
		 */
		function evidenceScope() {
			if (diagMode() === 'incident') {
				const row = selectedIncident().row;
				if (row === null) return null;
				const frame = selectedIncidentFrame(row);
				const frameRows = incidentFrameEvidenceRows(row, frame);
				if (frameRows.length > 0) {
					return {
						label: `${translate('evidenceLabel')} · ${translate('evidenceScopeIncident')} ${row.id} · ${translate('ctxHistoryFrame')}`,
						scopeKind: 'history', frame: true, missing: false,
						rows: locatable(frameRows).slice(0, EVIDENCE_MAX),
						total: frameRows.length,
						named: frameRows.filter((item) => item.pkg !== null).length,
						titled: frameRows.filter((item) => item.fn !== null).length,
					};
				}
				// 这一帧没有脚本记录(老包 / 这一帧没有 LoAF):退回事故**窗口内**的切片,
				// 并把"下面这些不是这一帧的"写在 missing 上,由渲染那侧照实说。
				const summary = row.summary ?? {};
				const top = Array.isArray(summary.topScripts) ? summary.topScripts : [];
				const coverage = summary.pkgCoverage ?? { resolved: 0, total: top.length };
				const rows = top.map((script) => incidentEvidenceAt(row, script)).sort((a, b) => b.ms - a.ms);
				return {
					label: `${translate('evidenceLabel')} · ${translate('evidenceScopeIncident')} ${row.id} · ${translate('evidenceWindowPrefix')}`,
					scopeKind: 'window', frame: false, missing: frame !== null,
					rows: locatable(rows).slice(0, EVIDENCE_MAX),
					total: coverage.total ?? rows.length,
					named: coverage.resolved ?? 0,
					titled: rows.filter((item) => item.fn !== null).length,
				};
			}
			const frame = pickedLoaf();
			const scripts = frame === null || Array.isArray(frame.scripts) === false ? [] : frame.scripts;
			if (scripts.length === 0) return null;
			const rows = scripts.map((script) => scriptEvidence(script, script.url)).sort((a, b) => b.ms - a.ms);
			return {
				label: `${translate('evidenceLabel')} · ${translate('scopeFrame')}`,
				scopeKind: 'frame', frame: true, missing: false,
				rows: locatable(rows).slice(0, EVIDENCE_MAX),
				total: rows.length,
				named: rows.filter((item) => item.pkg !== null).length,
				titled: rows.filter((item) => item.fn !== null).length,
			};
		}

		/**
		 * 一条名字都没有时,不要摆一列 `函数名未记录 @ 包未定名 + 毫秒` —— 那既没缩小范围,
		 * 又把行数翻了几倍(与「按包:0 条定到名」同一条规矩)。换成**一行带分母 + 要深录**,
		 * 并说明为什么:合并批的包名要靠 sourcemap 分段(深录才拉),而函数名来自 LoAF 的
		 * `sourceFunctionName`,压缩/合并后的脚本经常就没有它。
		 */
		function evidenceZeroText(scope) {
			// 分母的范围要说对:实时帧 = 本帧,历史帧 = 历史帧,事故窗口切片 = 窗口内。
			// 三种都写成"窗口内"会把"这一帧一条都没定到名"说成"整个窗口"。
			const kind = scope.scopeKind ?? (scope.frame === true ? 'frame' : 'window');
			const prefix = kind === 'history' ? translate('ctxHistoryFrame')
				: (kind === 'frame' ? translate('scopeFrame') : translate('evidenceWindowPrefix'));
			return `${translate('evidenceLabel')}:${translate('pkgZeroNamed')}(${prefix} ${scope.total}${translate('scriptsUnit')})· ${translate('needDeep')}`;
		}

		/**
		 * 只留**能定位的**那些行:函数名 / 包名 / 文件 / 行号一个都没有的行,列出来只是"函数名未记录
		 * @ 包未定名 + 一个毫秒数"——占掉名额还不缩小范围。**分母仍然按全部脚本算**(见
		 * `evidenceFooter`),所以过滤不会把"没定到名"这件事藏起来。
		 */
		function locatable(rows) {
			// ⚠️ **光有行号不算能定位**:合并批里 charPos → 行号是相对于那个几十包合起来的大文件,
			// 不知道属于哪个包时,那个数字指不出任何可打开的东西(实测非深录档会出现 line=25580 而
			// pkg 为 null)。有包名时行号才有意义,而那已经被 pkg != null 覆盖。
			return rows.filter((row) => row.fn != null || row.pkg != null || row.file != null);
		}

		/**
		 * 块底下那两行:先给**这一块的覆盖分母**,再给口径与缺口。
		 * 分母不能省 —— `定到包 3` 不写"共 N 条"会被读成"全都定到了";而且它按**全部**脚本算,
		 * 不随上面列出的行数变(列出来的只是"能定位的那几条")。
		 */
		function evidenceFooter(scope) {
			// ⚠️ 正文只留**分母**与一句提示。以前这里把「口径」与「缺口」两整段(各两三百字)摊在正文里,
			// 而面板是**纯文本**渲染(不是 markdown),于是 `**` 与反引号原样显示出来 —— 一屏全是解释,
			// 分母反而找不着。完整口径与缺口进 evidenceFooterTitle() 的悬停;「复制摘要」那份交接件
			// 仍然照旧带全文(它本来就是给别的 AI 读的,不受这里影响)。
			return `${scope.total}${translate('scriptsUnit')} · ${translate('pkgNamed')} ${scope.named}/${scope.total} · ${translate('evidenceHoverHint')}`;
		}

		/**
		 * 上面那一行悬停时给的**完整**口径与缺口 —— 与「复制摘要」的交接件用**同一份措辞**
		 * (`evidenceCaliberPlain` / `evidenceMissingPlain`),所以两处不会各说一套。
		 */
		function evidenceFooterTitle() {
			return `${translate('evidenceCaliberPlain')}\n${translate('evidenceMissingPlain')}`;
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
			longTasks: [],           // { t, at, ms, owner, seq }
			ltTotal: 0,              // 观察到的 longtask 条数
			ltSeq: 0,                // longtask 序号(窗口完整性:seq 断档 = 环挤掉了记录)
			ltDropped: 0,            // 被 200 条上限挤掉的 longtask 总数
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
			mapCache: { evicted: 0, failed: 0 },   // map 缓存淘汰 / 写失败计数(只进导出件)
			// B fiber
			idleBaseline: null,
			streaming: false,
			idleSince: 0,
			baselineAt: 0,
			baselineRunning: false,
			baselineMs: null,        // 覆盖空闲基线窗口长度(默认 BASELINE_MS),自测用
			errors: [],              // 面板自己捕获的渲染错误(导出件里能读到)
			// 分组折叠:常显只有"现在顺不顺 + 谁的锅",过程/取证/工具默认收起(头部带摘要)
			groups: { detail: false, cross: false, dom: false, host: false, tools: false, tech: false },
			stress: null,            // 最近一次自测 { at, nodes, burnMs, sync, commitMs }
			stressBurn: 0,           // 自测渲染时显式燃烧的毫秒数
			// G 守夜层:默认常开,不包装任何原型;开关跟着总开关走
			watch: {
				on: false,
				loaf: [],                // 最近的 LoAF 摘要(时间升序)
				loafSeq: 0,              // LoAF 序号(窗口完整性:seq 断档 = 环挤掉了记录)
				loafDropped: 0,          // 被 WATCH_LOAF_MAX 挤掉的 LoAF 总数
				loafObserver: null,
				pickT: null,             // 用户用 ◀ ▶ 选中的那一帧的 t(null = 自动跟着最差那条)
				// ── 诊断上下文(本次改版的核心)──
				// 取证明细只服务**一个**上下文:`live` = 实时帧环里的当前帧,`incident` = 选中事故
				// 里的某一条**历史帧**。两个上下文的数据源不同(实时帧环 vs 事故包的 frames/loaf),
				// 所以由这一个字段决定下面所有读数来自哪里 —— 不允许"上面是历史事故、下面是实时帧"。
				mode: 'live',
				// 历史事故里选中的那一帧的 t(存 t 不存下标:同一份事故包的位置才是稳定的)。
				// null = 自动跟着这条事故里最差的那一帧。
				frameT: null,
				// 「只看异常」:历史帧导航的**过滤器**,不是第二对箭头 —— 开着时 ◀ ▶ 只落在
				// 帧间隔 ≥ 守夜触发线的帧上。以前是四个按钮(上一帧/下一帧/上一异常帧/下一异常帧),
				// 两对箭头做同一件事、只是步长不同,读的人先要弄清"异常帧"是什么才敢按。
				onlyBad: false,
				// 用户在事故清单里**选中**的事故 id(null = 自动,跟 scope 指定的那条)。
				// 「最差事件」块 / 工具箱清单 / 取证明细的翻帧共享这一个上下文 —— 否则三处各说各的。
				// 存 id 不存下标:新事故进来会按严重度重排,下标会悄悄指到另一条事故上。
				selId: null,
				// 「自动」跟哪一条:worst = 严重度最差(默认,事后回看的重点)、latest = 时刻最新
				// (刚卡的那一下在哪)。单独一个状态位而不是让 selId 兼管 —— 用户点过具体某条之后
				// 再切 scope,应该以 scope 为准,不能两个人抢同一个字段。
				scope: 'worst',
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
			causeOpen: false,          // 主界面「为什么这样判断?」的展开态(一次性,不落盘)
			packPreview: null,         // 分享前预览(构建一次存着,别每次渲染都重新序列化)
			packPreviewId: null,
			packPreviewOptions: null,
			// 视图模型(方案 1:整屏切换)。落盘只存"在看哪个视图",不存任何读数。
			view: 'main',           // main / incident / dev / settings
			devTab: 'frames',       // 开发者详情的标签页(frames / dom / host / tools / raw)
			trendMs: TALLY_TREND_SHORT_MS,   // 主界面「最近趋势」的窗口
			// 捕获计数:与"留存了几份详细现场"分开的轻量时间桶(见 §捕获计数)。
			// minute / day 的桶都是 TALLY_FIELDS 那个 6 元数组。
			tally: {
				minute: new Map(),       // 分钟下标(floor(epochMs/60000))-> 6 元数组
				day: new Map(),          // 'YYYY-MM-DD'(本地日期)-> 6 元数组
				expiredBuckets: 0,       // 超出 24h 被丢掉的分钟桶数(照实记,不静默)
				expiredDays: 0,          // 超出 30 天被丢掉的日汇总数
				prunedMinute: -1,        // 上次裁剪到了哪一分钟(免得每帧都扫 1440 个桶)
				loadError: null,         // 读回落盘计数失败的原因(照实记)
				savedAt: 0,
				dirty: false,
				timer: 0,                // 合并落盘的定时器:一次卡顿里 coalesced 会连加很多次
			},
			requestRender: null,     // 面板挂载时注册:用户动作要立刻重渲染,不能等 0.5 秒的定时器
			toggleHud: null,         // 面板挂载时注册:快捷键调用同一个 toggle(与点标题栏按钮同一条路)
			epoch: 0,                // 每个采集代递增:异步结果跨代一律丢弃(见 fetchTextWithin)
			abort: null,             // 当前采集代的 AbortController;stop() 时 abort
			displayKey: '',          // 面板显示值的指纹:没变就跳过这次 tick 的渲染
			copyNote: null,          // 「复制摘要」的结果:成功/失败**原文**都照实显示,失败不许假装成功
			pickNote: null,          // 「看这一帧」定位不到时的那句如实说明(否则按钮点了像没反应)
			marks: [],
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
			/**
			 * 按时间升序取 [from, to] 区间(两端含)。
			 *
			 * ⚠️ **从最新一帧往回走**,不是从环头正扫:环容量 WATCH_FRAMES(=12000,60fps ≈ 3.3 分钟)
			 * 远大于调用方的窗口(帧条只要最近 60 秒 ≈ 3600 条),正扫每 tick 会白扫 ~8400 条 ——
			 * 「面板自己变成被测开销」正是这个项目最该避免的事。环形里天然按时间升序,
			 * 所以倒着走遇到 `at < from` 就能停。
			 */
			slice(from, to) {
				const out = [];
				for (let step = 1; step <= this.size; step += 1) {
					const index = (this.head - step + WATCH_FRAMES) % WATCH_FRAMES;
					const at = this.at[index];
					if (at < from) break;
					if (at > to) continue;
					out.push({ t: round1(at), ms: round1(this.ms[index]), gap: this.gap[index] === 1 });
				}
				out.reverse();
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
					// 只要 URL 是**组合**(`plugins/??…`)就预取脚本文本 —— 单包组合
					// (`??<一个包>/client.js`)也算:它的 charPos 同样要靠文本才能换成行号。
					// 以前判据是 `indexOf(',') !== -1`(只看多包),单包组合于是永远停在 text-pending。
					if (scriptUrl !== null && state.precise === true && /\/plugins\/\?\?/.test(scriptUrl)) {
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
			watch.loafSeq += 1;
			const row = {
				seq: watch.loafSeq,
				t: round1(entry.startTime),
				dur: round1(entry.duration),
				blocking: round1(entry.blockingDuration ?? 0),
				renderStart: round1(entry.renderStart ?? 0),
				styleAndLayoutStart: round1(entry.styleAndLayoutStart ?? 0),
				scripts: loafScripts(entry),
			};
			watch.loaf.push(row);
			if (watch.loaf.length > WATCH_LOAF_MAX) {
				const dropped = watch.loaf.length - WATCH_LOAF_MAX;
				watch.loaf.splice(0, dropped);
				watch.loafDropped += dropped;
			}
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
			if (watch.pending !== null) { watch.coalesced += 1; bumpTally('coalesced', Date.now()); return null; }
			// 这个时刻已经被上一份事故的窗口覆盖了(证据就在那份包里),别再另立一份 ——
			// 实测过一次卡顿裂成两份(第二份其实只是又碰了一下同一段窗口)。
			// 手动标记例外:那是明确意图,哪怕落在窗口里也收。
			if (cause !== 'manual' && watch.coveredUntil > 0 && at <= watch.coveredUntil) {
				watch.coalesced += 1;
				bumpTally('coalesced', Date.now());
				return null;
			}
			watch.pending = {
				cause, at, severity: round1(severity), note: note ?? null, until: at + WATCH_POST_MS,
				// 窗口完整性的起点状态:环满 + 确实丢过记录 + 最老一条晚于窗口起点 ⇒ 前摇已经丢了记录。
				loafFull: watch.loaf.length >= WATCH_LOAF_MAX,
				loafDroppedAtTrigger: watch.loafDropped,
				loafOldestAt: watch.loaf.length === 0 ? null : watch.loaf[0].t,
				longTaskFull: state.longTasks.length >= 200,
				longTaskDroppedAtTrigger: state.ltDropped,
				longTaskOldestAt: state.longTasks.length === 0 ? null : state.longTasks[0].at,
			};
			// 起一次新捕获 = 检测到一次卡顿(同一串里的后续触发会走上面的 coalesced,不重复计)
			bumpTally('triggered', Date.now());
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
			if (survived === false) { watch.dropped += 1; bumpTally('dropped', Date.now()); return 'dropped'; }
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
		 * 窗口完整性:用序号断档判断"环是不是把记录挤掉了"。
		 * `rows` 已按时间升序;`dropped = 末序号 − 首序号 + 1 − 实际条数` 精确回答"中间缺了几条"。
		 * `preOverflow` 是另一件事:窗口起点早于环里最老的一条、环当时是满的**且确实丢过记录** —— 开头那段已经丢了,
		 * 但丢了几条无从得知(不编数字,只标原因)。老数据没有 seq 时返回 0,不假装算过。
		 */
		function windowIntegrity(rows, oldestAt, ringFull, droppedAtTrigger, from) {
			const list = Array.isArray(rows) ? rows : [];
			// 环满 ≠ 丢过记录:只有真的丢过(droppedAtTrigger>0)才谈"前摇滚出环"。
			const preOverflow = ringFull === true && droppedAtTrigger > 0 && typeof oldestAt === 'number' && oldestAt > from;
			if (list.length === 0) return { dropped: 0, preOverflow };
			const first = list[0];
			const last = list[list.length - 1];
			if (typeof first.seq !== 'number' || typeof last.seq !== 'number' || last.seq < first.seq) {
				return { dropped: 0, preOverflow: false };
			}
			return { dropped: Math.max(0, last.seq - first.seq + 1 - list.length), preOverflow };
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
			// 窗口完整性:和官方 Inspector 的 sequence gap 同一条纪律 —— 缺口必须显式,不许静默。
			const loafIntegrity = windowIntegrity(rows, pending.loafOldestAt, pending.loafFull, pending.loafDroppedAtTrigger, from);
			const longTaskIntegrity = windowIntegrity(longTasks, pending.longTaskOldestAt, pending.longTaskFull, pending.longTaskDroppedAtTrigger, from);
			const integrityReasons = [];
			if (loafIntegrity.dropped > 0) integrityReasons.push('loaf-ring-overflow');
			if (longTaskIntegrity.dropped > 0) integrityReasons.push('longtask-ring-overflow');
			if (loafIntegrity.preOverflow) integrityReasons.push('loaf-pre-window-overflow');
			if (longTaskIntegrity.preOverflow) integrityReasons.push('longtask-pre-window-overflow');
			const integrity = {
				captureComplete: integrityReasons.length === 0,
				loafDropped: loafIntegrity.dropped,
				longTaskDropped: longTaskIntegrity.dropped,
				loafKept: rows.length,
				longTaskKept: longTasks.length,
				reasons: integrityReasons,
			};
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
			// 现在顺手把**文件与行号**也按同一份证据函数算出来(面板与导出件共用这套 via 码):
			// 面板那一块能定位到"哪个文件的哪一段",事故包离开现场后也还留着这两样。
			// ⚠️ 切片是**当时**算的:脚本文本 / sourcemap 还没到位时 lineVia 就是 text-pending,
			// 照实记 —— 不给"事后补算"的假位置(事后补的会与这份包的其它读数不同源)。
			for (const row of loaf) {
				for (const script of row.scripts) {
					const evidence = scriptEvidence(script, script.u >= 0 ? urls[script.u] : '');
					script.pkg = evidence.pkg;
					script.pkgVia = evidence.pkgVia;
					script.file = evidence.file;
					script.line = evidence.line;
					script.lineVia = evidence.lineVia;
					// 行号属于哪个坐标系(合并大文件 / 那个文件自己)—— 存进包,面板与导出件才不用现推
					script.lineScope = evidence.lineScope;
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
				// 这份现场**采全了没有**。false 时不要把它当完整证据:面板、missing、manifest 都会标。
				integrity,
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
						at: script.at, u: script.u, ms: script.ms, fn: script.fn,
						invoker: script.invoker, invokerType: script.invokerType, charPos: script.charPos,
						// 「打开哪个文件、哪一段」:file = 包内那份文件(section 的 sources),
						// line = **脚本文本自己的行号**(不是原始源码行),两个 via 码说明它们是怎么来的
						pkg: script.pkg, pkgVia: script.pkgVia,
						file: script.file, line: script.line, lineVia: script.lineVia, lineScope: script.lineScope,
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
			// 计数与留存分开记:上面那个 captured 是**本次会话**的计数,下面这份是跨刷新的时间桶
			const now = Date.now();
			bumpTally('captured', now);
			noteTallySeverity(now, incident.severity);
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
					bumpTally('failed', Date.now());
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
					// 裁掉的那部分进计数桶(单列成 trimmed,不混进 dropped:一个是"没比留存更好",
					// 一个是"字节装不下",原因不同,读数的人要能分辨)
					const trimmedNow = Math.max(0, afterDedupe - list.length);
					watch.trimmedByBytes += trimmedNow;
					if (trimmedNow > 0) bumpTally('trimmed', Date.now(), trimmedNow);
					return true;
				} catch (error) {
					watch.persistError = error instanceof Error ? error.message : String(error);
					if (list.length > 1) { list.length = Math.ceil(list.length / 2); continue; }
					bumpTally('failed', Date.now());
					return false;
				}
			}
			bumpTally('failed', Date.now());
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

		// ───────────────────────── 捕获计数(与留存分离)─────────────────────────
		/**
		 * 口径写在这里,也写进导出件(`context.tally`),有断言钉住:
		 *   **检测到 = captured + coalesced** —— 同一串卡顿里被并掉的触发**也算检测到**(它确实发生了);
		 *   **已保存现场 = incidents.length** —— 受容量限制(最差 10 次 + 每天 1 条),**不等于**检测到;
		 *   **丢失 = dropped + trimmed + failed** —— 抓到了但没留下来的那部分,单列,不混进检测到。
		 * 为什么必须分开:留存清单是**证据**(受容量限制),计数回答的是**发生频次**。
		 * 拿前者回答后者会系统性少报 —— 被挤掉的卡顿不是没发生,这条正是产品计划 §3.A 要拆的东西。
		 * 时间戳用**墙上时间**(`Date.now`),因为用户问的是"什么时候",不是页面开了多久。
		 */
		function tallyDayKey(atMs) {
			const d = new Date(atMs);
			const p = (n) => (String(n).length < 2 ? `0${n}` : String(n));
			return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
		}

		function tallyBlank() {
			// 桶长度跟着 TALLY_FIELDS 走:加字段时不用记着改两个地方(读回的形状校验也用这个长度)
			return new Array(Object.keys(TALLY_FIELDS).length).fill(0);
		}

		function tallyBucketOf(store, key) {
			const found = store.get(key);
			if (found !== undefined) return found;
			const fresh = tallyBlank();
			store.set(key, fresh);
			return fresh;
		}

		/** 一个桶 → 可读字段(所有聚合都走这一个函数,口径只写一次)。 */
		function tallySum(bucket) {
			const row = { triggered: 0, captured: 0, coalesced: 0, dropped: 0, failed: 0, trimmed: 0, worstMs: 0 };
			if (bucket !== undefined && bucket !== null) {
				row.triggered = bucket[TALLY_FIELDS.triggered];
				row.captured = bucket[TALLY_FIELDS.captured];
				row.coalesced = bucket[TALLY_FIELDS.coalesced];
				row.dropped = bucket[TALLY_FIELDS.dropped];
				row.failed = bucket[TALLY_FIELDS.failed];
				row.trimmed = bucket[TALLY_FIELDS.trimmed];
				row.worstMs = bucket[TALLY_FIELDS.worstMs];
			}
			// ⚠️ 口径的定义处,只有这一份:
			//   检测到 = triggered  —— **一次卡顿一串触发只算一次**(被并进 pending / coveredUntil 的那些
			//     触发不算新的一次,它们就是同一串)。所以 `coalesced` **不是**次数,是"这一串有多密";
			//     把两者相加会把一次停顿记成十几次(实测踩过)。
			//   已保存现场 = kept —— 受容量限制,来自留存清单,不是发生次数。
			//   丢失 = (检测到但没切成现场) + dropped + trimmed + failed。
			row.detected = row.triggered;
			row.unsettled = Math.max(0, row.triggered - row.captured);
			row.lost = row.unsettled + row.dropped + row.trimmed + row.failed;
			return row;
		}

		/** 丢超出窗口的桶。只在**分钟边界**上扫一次,不是每次 bump 都扫 1440 个桶。 */
		function pruneTally(atMs) {
			const tally = state.tally;
			const nowMinute = Math.floor(atMs / TALLY_BUCKET_MS);
			if (tally.prunedMinute >= nowMinute) return tally.prunedMinute;
			tally.prunedMinute = nowMinute;
			const oldest = nowMinute - TALLY_MINUTES + 1;
			for (const key of [...tally.minute.keys()]) {
				if (key < oldest) { tally.minute.delete(key); tally.expiredBuckets += 1; }
			}
			const days = [...tally.day.keys()].sort();
			while (days.length > TALLY_DAYS) {
				tally.day.delete(days.shift());
				tally.expiredDays += 1;
			}
			return tally.prunedMinute;
		}

		/** 记一笔计数。`kind` 见 TALLY_FIELDS;认不出来就返回 null(不静默记错地方)。 */
		function bumpTally(kind, atMs, n) {
			const tally = state.tally;
			const index = TALLY_FIELDS[kind];
			if (index === undefined) return null;
			const at = typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : Date.now();
			const value = typeof n === 'number' && n > 0 ? n : 1;
			pruneTally(at);
			tallyBucketOf(tally.minute, Math.floor(at / TALLY_BUCKET_MS))[index] += value;
			tallyBucketOf(tally.day, tallyDayKey(at))[index] += value;
			markTallyDirty();
			return value;
		}

		/** 这个分钟/这一天里**最差的一次**——取 max 不是求和("最长一次"不是累计)。 */
		function noteTallySeverity(atMs, ms) {
			const tally = state.tally;
			if (typeof ms !== 'number' || Number.isFinite(ms) === false || ms <= 0) return null;
			const at = typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : Date.now();
			const minute = tallyBucketOf(tally.minute, Math.floor(at / TALLY_BUCKET_MS));
			const day = tallyBucketOf(tally.day, tallyDayKey(at));
			minute[TALLY_FIELDS.worstMs] = Math.max(minute[TALLY_FIELDS.worstMs], ms);
			day[TALLY_FIELDS.worstMs] = Math.max(day[TALLY_FIELDS.worstMs], ms);
			markTallyDirty();
			return ms;
		}

		/**
		 * 窗口聚合。窗口边界落在**分钟桶**上,所以实际覆盖范围是"从 now−ms 之后开始的那一分钟起" ——
		 * `coveredFromMs` / `coveredToMs` 一起给出来,让调用方能照实写范围,不用猜、也不用补造。
		 */
		function tallyWindow(ms, atMs) {
			const tally = state.tally;
			const span = typeof ms === 'number' && ms > 0 ? ms : TALLY_MINUTES * TALLY_BUCKET_MS;
			const at = typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : Date.now();
			const nowMinute = Math.floor(at / TALLY_BUCKET_MS);
			const oldest = Math.max(nowMinute - Math.floor(span / TALLY_BUCKET_MS) + 1, nowMinute - TALLY_MINUTES + 1);
			const bucket = tallyBlank();
			let worst = 0;
			let buckets = 0;
			for (let key = oldest; key <= nowMinute; key += 1) {
				const found = tally.minute.get(key);
				if (found === undefined) continue;
				buckets += 1;
				bucket[TALLY_FIELDS.triggered] += found[TALLY_FIELDS.triggered];
				bucket[TALLY_FIELDS.captured] += found[TALLY_FIELDS.captured];
				bucket[TALLY_FIELDS.coalesced] += found[TALLY_FIELDS.coalesced];
				bucket[TALLY_FIELDS.dropped] += found[TALLY_FIELDS.dropped];
				bucket[TALLY_FIELDS.failed] += found[TALLY_FIELDS.failed];
				bucket[TALLY_FIELDS.trimmed] += found[TALLY_FIELDS.trimmed];
				worst = Math.max(worst, found[TALLY_FIELDS.worstMs]);
			}
			bucket[TALLY_FIELDS.worstMs] = worst;
			const row = tallySum(bucket);
			row.buckets = buckets;
			row.kept = state.watch.incidents.length;      // 留存证据数 —— 和 detected 不是一个东西
			row.windowMs = span;
			row.coveredFromMs = oldest * TALLY_BUCKET_MS;
			row.coveredToMs = (nowMinute + 1) * TALLY_BUCKET_MS;
			return row;
		}

		/** 某一天的汇总(**本地日期**)。没有就是全 0 且 `exists:false`,不补造数字。 */
		function tallyOfDay(dayKey) {
			const row = tallySum(state.tally.day.get(dayKey));
			row.day = dayKey;
			row.exists = state.tally.day.has(dayKey);
			return row;
		}

		/** 悬停给完整口径:四个数各有各的名字,并写清"同一串算一次"与"留存受容量限制"。 */
		function tallyTitle(ms, atMs) {
			const row = tallyWindow(ms, atMs);
			const lines = [
				`${translate('watchDetected')} ${row.detected}${translate('times')}(${spanText(row.windowMs)}${translate('tallyScopeSuffix')})`,
				`${translate('tallyCoalesced')} ${row.coalesced}${translate('times')} —— ${translate('tallyCoalescedHint')}`,
				`${translate('watchKept')} ${row.kept}${translate('tallyUnit')} —— ${translate('tallyKeepHint')}`,
				`${translate('watchLost')} ${row.lost}${translate('tallyUnit')}`,
			];
			if (row.worstMs > 0) lines.push(`${translate('tallyWorst')} ${Math.round(row.worstMs)}ms`);
			return lines.join('\n');
		}

		/** 导出件里的那一份(整机导出与事故包共用):三个数与口径一起给出来。 */
		function tallyReport(atMs) {
			const at = typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : Date.now();
			const row = tallyWindow(TALLY_MINUTES * TALLY_BUCKET_MS, at);
			return {
				at: new Date(at).toISOString(),
				windowMs: row.windowMs,
				coveredFrom: new Date(row.coveredFromMs).toISOString(),
				coveredTo: new Date(row.coveredToMs).toISOString(),
				detected: row.detected,
				triggered: row.triggered,
				captured: row.captured,
				coalesced: row.coalesced,
				unsettled: row.unsettled,
				kept: row.kept,
				lost: row.lost,
				dropped: row.dropped,
				trimmed: row.trimmed,
				failed: row.failed,
				worstMs: round1(row.worstMs),
				buckets: row.buckets,
				expiredBuckets: state.tally.expiredBuckets,
				expiredDays: state.tally.expiredDays,
				loadError: state.tally.loadError,
				savedAt: state.tally.savedAt > 0 ? new Date(state.tally.savedAt).toISOString() : null,
				scope: 'detected = triggered:一次卡顿一串触发只算一次;coalesced 是同串里被并掉的触发数(密度,不是次数);captured = 切成了几份现场;kept 是留存证据份数,受容量限制,不等于 detected;lost = (triggered - captured) + dropped + trimmed + failed;窗口边界落在分钟桶上,实际范围以 coveredFrom / coveredTo 为准',
				sessionCounters: '这是导出时刻的滚动 24h 计数;本次会话的计数在 watch.captured 等字段里 —— 两者不是同一个窗口,别相加',
			};
		}

		/** 合并落盘:一次卡顿里 `coalesced` 会被连加很多次(每帧一次触发),不能每次都写盘。 */
		function markTallyDirty() {
			const tally = state.tally;
			tally.dirty = true;
			if (tally.timer !== 0) return;
			tally.timer = natives.setTimeout(() => { tally.timer = 0; saveTally(); }, TALLY_SAVE_DELAY_MS);
		}

		/** 落盘。体积很小(稀疏桶),但写失败照实记 —— 计数丢了要在面板上说得出原因。 */
		function saveTally() {
			const tally = state.tally;
			if (tally.dirty === false) return true;
			const payload = {
				v: 1,
				savedAt: Date.now(),
				expiredBuckets: tally.expiredBuckets,
				expiredDays: tally.expiredDays,
				minute: {},
				day: {},
			};
			for (const [key, value] of tally.minute) payload.minute[key] = value;
			for (const [key, value] of tally.day) payload.day[key] = value;
			try {
				localStorage.setItem(LS_TALLY, JSON.stringify(payload));
				tally.dirty = false;
				tally.savedAt = payload.savedAt;
				tally.loadError = null;
				return true;
			} catch (error) {
				tally.loadError = `save:${error instanceof Error ? error.message : String(error)}`;
				return false;
			}
		}

		/** 读回。形状不对的**整桶丢掉**并记原因 —— 不把坏数据当成 0 混进统计里。 */
		function restoreTally() {
			const tally = state.tally;
			let parsed = null;
			try { parsed = JSON.parse(localStorage.getItem(LS_TALLY) ?? 'null'); } catch (error) {
				tally.loadError = `parse:${error instanceof Error ? error.message : String(error)}`;
				return null;
			}
			if (parsed === null || typeof parsed !== 'object') return null;
			const pick = (source, target, asNumber) => {
				if (source === null || typeof source !== 'object') return 0;
				let rejected = 0;
				for (const key of Object.keys(source)) {
					const raw = source[key];
					if (Array.isArray(raw) === false || raw.length !== tallyBlank().length) { rejected += 1; continue; }
					if (raw.every((value) => typeof value === 'number' && Number.isFinite(value)) === false) { rejected += 1; continue; }
					target.set(asNumber === true ? Number(key) : key, raw.slice());
				}
				return rejected;
			};
			const badMinutes = pick(parsed.minute, tally.minute, true);
			const badDays = pick(parsed.day, tally.day, false);
			if (typeof parsed.expiredBuckets === 'number') tally.expiredBuckets = parsed.expiredBuckets;
			if (typeof parsed.expiredDays === 'number') tally.expiredDays = parsed.expiredDays;
			tally.savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : 0;
			tally.prunedMinute = -1;   // 让下一次 bump 重扫一遍窗口
			if (badMinutes + badDays > 0) tally.loadError = `shape:${badMinutes + badDays}`;
			return tally.savedAt;
		}

		/** 只清计数(与"清事故"、"清读数"都分开:三个问题不一样)。 */
		function clearTally() {
			const tally = state.tally;
			tally.minute.clear();
			tally.day.clear();
			tally.expiredBuckets = 0;
			tally.expiredDays = 0;
			tally.prunedMinute = -1;
			tally.dirty = true;
			saveTally();
			return true;
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
			state.ltSeq += 1;
			state.longTasks.push({
				seq: state.ltSeq,
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
			if (state.longTasks.length > 200) {
				const dropped = state.longTasks.length - 200;
				state.longTasks.splice(0, dropped);
				state.ltDropped += dropped;
			}
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

		/**
		 * 诊断上下文落盘 / 读回:看的是哪条事故、事故里的哪一帧、自动跟最差还是最近。
		 * **只存 id 与 t,不存数据本身** —— 数据在事故包里;读回时找不到那条事故 / 那一帧就
		 * 老老实实退回自动(与 selectedIncident / pickedLoaf 同一条规矩:不指着一个不存在的东西)。
		 */
		function saveWatchUI() {
			try {
				localStorage.setItem(LS_WATCHUI, JSON.stringify({
					v: 1,
					mode: state.watch.mode === 'incident' ? 'incident' : 'live',
					selId: state.watch.selId,
					frameT: state.watch.frameT,
					scope: state.watch.scope,
					onlyBad: state.watch.onlyBad === true,
				}));
			} catch (error) { /* 记不住就本次会话有效 */ }
		}

		/** 读回诊断上下文。事故清单还没读回来时**不能**判定 id 是否有效,所以先原样存着。 */
		function restoreWatchUI() {
			const watch = state.watch;
			let parsed = null;
			try { parsed = JSON.parse(localStorage.getItem(LS_WATCHUI) ?? 'null'); } catch (error) { parsed = null; }
			if (parsed === null || typeof parsed !== 'object') return;
			if (parsed.mode === 'incident') watch.mode = 'incident';
			if (parsed.scope === 'latest') watch.scope = 'latest';
			if (parsed.onlyBad === true) watch.onlyBad = true;
			if (typeof parsed.selId === 'string') watch.selId = parsed.selId;
			if (typeof parsed.frameT === 'number' && Number.isFinite(parsed.frameT)) watch.frameT = parsed.frameT;
			// 落盘的 id 已经不在留存清单里(被更差的挤掉了 / 另一台机器写的)→ 退回自动,
			// 并把模式退回实时:没有事故可看时停在"历史事故"上下文只会是一片空缺状态。
			if (watch.selId !== null && pickIncident(watch.selId) === null) {
				watch.selId = null;
				watch.frameT = null;
				watch.mode = 'live';
			}
			if (watch.incidents.length === 0) watch.mode = 'live';
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
			restoreTally();
			restoreWatchUI();
			restoreView();
			// 老 rev 的 sourcemap 分段表可重建;启动时清一次,别让它静默吃满配额。
			pruneMapCache();
		}

		function flush(force) {
			// 计数有自己的 dirty 标记:强制落盘(页面隐藏/关闭)时一并写,平时由 markTallyDirty 的
			// 定时器合并写(一次卡顿里 coalesced 每帧都会加,不能每帧写盘)
			if (force === true) saveTally();
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

		/** 只读:把落盘的跨会话基线读回来。坏 JSON / 形状不对都当空 —— 不写盘,也不静默改数。 */
		function readSessionBaselines() {
			try {
				const parsed = JSON.parse(localStorage.getItem(LS_SESSIONS) ?? 'null');
				return parsed !== null && Array.isArray(parsed.sessions) ? parsed.sessions : [];
			} catch (error) { return []; }
		}

		/**
		 * 本次会话 + 已落盘的旧会话合并成一份(按 since 认人去重,只留最近 SESSION_KEEP 条)。
		 * ⚠️ **纯函数,不写盘** —— 导出件(`snapshot()`)是文档承诺的**只读** API,验收器每轮会调它
		 * 若干次;那时每调一次就重写一遍 localStorage 是错的语义。落盘只在 `saveSessionBaseline()`
		 * 里发生,而它只由 `pagehide` 触发。
		 */
		function mergeSessionBaseline() {
			const record = sessionRecord();
			if (record === null) return [];
			const kept = readSessionBaselines().filter((row) => row !== null && typeof row === 'object' && row.since !== record.since);
			kept.push(record);
			if (kept.length > SESSION_KEEP) kept.splice(0, kept.length - SESSION_KEEP);
			return kept;
		}

		/**
		 * 把本次会话的分布写进跨会话基线(同一个会话只占一条,按 since 认人)。
		 * 写失败不抛:拿不到跨会话基线不影响本次读数,导出件里就只是少一段。
		 */
		function saveSessionBaseline() {
			const kept = mergeSessionBaseline();
			if (kept.length === 0) return [];
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
				sessions: mergeSessionBaseline(),
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
			const payload = await hostOp(args, FETCH_TIMEOUT_MS.bundle);
			return { ...payload, via: 'route' };
		}

		/** 一次宿主请求:GET 兼作 RTT/吞吐探针,POST 走 op 分发。 */
		async function hostOp(body, ms = FETCH_TIMEOUT_MS.host) {
			const { data } = await fetchJsonWithin(HOST_ROUTE, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				credentials: 'same-origin',
			}, ms);
			return data;
		}

		/** RTT 探针:请求带 1KB cache-buster(别缓存,也别让代理吞掉);吞吐探针多要 64KB。 */
		async function probeLink(kind) {
			const started = performance.now();
			const query = kind === 'load'
				? `?t=${Date.now()}&bytes=${LOAD_BYTES}`
				: `?t=${Date.now()}&pad=${'x'.repeat(1024)}`;
			try {
				const { response, data: payload } = await fetchJsonWithin(`${HOST_ROUTE}${query}`, { cache: 'no-store', credentials: 'same-origin' }, FETCH_TIMEOUT_MS.host);
				if (response.ok === false) throw new Error(`HTTP ${response.status}`);
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
				const recovered = state.hostError !== null;
				state.host = payload.host ?? null;
				state.hostAt = Date.now();
				state.hostError = null;
				if (payload.host?.eventWatch !== undefined) state.hostEvents = payload.host.eventWatch;
				// 第一次探测时宿主半可能还没加载(404),不能因此永久放弃事件监听。
				if (recovered && state.hostEvents?.installed !== true) state.hostWatchAsked = false;
				await requestHostEventWatch();
			} catch (error) {
				// 用户关掉 HUD 时 abort 是预期动作,不记成宿主错误,也不伪造一条 RTT 样本。
				if (isAbortError(error)) return;
				state.hostError = fetchFailureText(error, FETCH_TIMEOUT_MS.host);
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
				// stop() 取消这一代时允许下次重新请求;真正的失败才记进面板。
				if (isAbortError(error)) {
					state.hostWatchAsked = false;
					return;
				}
				state.hostEvents = { installed: false, reason: fetchFailureText(error, FETCH_TIMEOUT_MS.host), stats: {} };
			}
			dirty = true;
		}

		/**
		 * 宿主快照的**四态**(外加路由不可达)。
		 * 参考官方 Inspector 的 `disconnected` 标记:保留最后的快照,但必须说明它已经过期 / 没采到,
		 * 不能把旧数字当成"现在" —— 零样本时更不能给出「链路已排除」。
		 */
		function hostFreshness(now = Date.now()) {
			const loop = state.host === null || state.host === undefined ? null : state.host.eventLoop ?? null;
			if (state.hostError !== null) return { state: 'unreachable', loop: null, ageMs: null };
			if (loop === null) return { state: state.hostAt === 0 ? 'warming' : 'unsupported', loop: null, ageMs: null };
			const ageMs = state.hostAt > 0 ? Math.max(0, now - state.hostAt) : null;
			if (state.host.eventLoopLive === false) return { state: 'unsupported', loop, ageMs };
			if (ageMs === null) return { state: 'warming', loop, ageMs };
			if (ageMs > HOST_STALE_MS) return { state: 'stale', loop, ageMs };
			if (loop.seconds === 0 || loop.p50 === null || loop.p99 === null) return { state: 'warming', loop, ageMs };
			return { state: 'live', loop, ageMs };
		}

		/**
		 * 宿主 event-loop 那一行的值。p50/p99/**max** 三个都给:只给 p99 会把偶发的秒级停顿
		 * 藏掉(max 才是"最坏卡了多久";宿主半每秒采一次,ring 保留 300 秒)。
		 * 老版本宿主半没有 max 字段 → 如实只给 p50/p99,不补 0。
		 */
		function hostLoopText(loop) {
			if (loop === null || loop === undefined) return translate('notYet');
			if (loop.p50 === null || loop.p50 === undefined || loop.p99 === null || loop.p99 === undefined) return translate('notYet');
			const head = `p50 ${loop.p50}ms · p99 ${loop.p99}ms`;
			return loop.max === undefined || loop.max === null ? head : `${head} · ${translate('maxLabel')} ${loop.max}ms`;
		}

		/** 宿主那一行的**带状态**文案:不可达 / 未采到 / 等样本 / 过期 / 正常。 */
		function hostLoopStateText() {
			const fresh = hostFreshness();
			if (fresh.state === 'unreachable') return `${translate('hostDown')}:${String(state.hostError).slice(0, 26)}`;
			if (fresh.state === 'unsupported') return translate('hostUnsupported');
			if (fresh.state === 'warming') return translate('hostWarming');
			const text = hostLoopText(fresh.loop);
			if (fresh.state === 'stale') return `${text} · ${translate('hostStale')} ${Math.max(1, Math.round(fresh.ageMs / 1000))}s`;
			return text;
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

		// ───────────────────── 能力矩阵与证据出处(导出件的自证部分)─────────────────────
		/**
		 * 出处三档。**每个结论都要能回答"这是量出来的还是推出来的"** —— 这是本项目
		 * 所有"别把相关写成根因"规矩的落点:
		 *   measured = 直接测量(观察器 / 计数器给的,不是算出来的);
		 *   inferred = 归因推断(URL、sourcemap 分段表、时间重叠、采样折算);
		 *   unknown  = 证据不足(拿不到就说拿不到,不补默认值)。
		 */
		function provenanceOf(kind) {
			return kind === 'measured' || kind === 'inferred' || kind === 'unknown' ? kind : 'unknown';
		}

		/**
		 * 能力矩阵:每一条证据来源现在处于什么状态、为什么、属于哪一档出处。
		 * 这是**唯一的事实来源** —— `capabilityMissing()` 与导出件都读它,免得"某一层没采到"
		 * 这件事在三个地方各说各话(以前 `missing` / `howToAdd` 是手写的一串 if)。
		 * state 取值:on / degraded / off / unsupported;`reason` 一律是**给用户看的原因**。
		 */
		function capabilities() {
			const watch = state.watch;
			const maps = { pending: 0, ready: 0, failed: 0 };
			for (const entry of bundleMaps.values()) maps[entry.state] = (maps[entry.state] ?? 0) + 1;
			const host = state.host;
			const loop = host === null || host === undefined ? null : host.eventLoop ?? null;
			const io = state.watch.interactions.length;
			// 读数一律**防御性取值**:能力矩阵的职责是"照实说现在有什么",不是"假设字段一定在"
			const taskRows = Array.isArray(state.longTasks) ? state.longTasks.length : 0;
			const taskTotal = typeof state.ltTotal === 'number' ? state.ltTotal : taskRows;
			const linkCount = Array.isArray(state.link) ? state.link.length : 0;
			const loadState = state.loadState ?? 'pending';
			const frameCount = frameRing !== undefined && frameRing !== null && typeof frameRing.size === 'number' ? frameRing.size : 0;
			const leaf = (capState, provenance, reason) => ({ state: capState, provenance: provenanceOf(provenance), reason: reason ?? '' });
			return {
				schema: 1,
				renderer: {
					frames: leaf(state.on === true ? 'on' : 'off', 'measured',
						state.on === true ? `帧环 ${frameCount} 帧` : 'HUD 已关闭,帧环没有在采'),
					loaf: leaf(watch.loafState === 'on' ? 'on' : (watch.loafState === 'unsupported' || String(watch.loafState).startsWith('unsupported') ? 'unsupported' : 'off'),
						'measured', `LoAF 观察器:${watch.loafState}`),
					longTasks: leaf(state.on === true ? 'on' : 'off', 'measured', `longtask 明细 ${taskRows} 条 / 累计 ${taskTotal} 条`),
					// 脚本这一层是**混合**的:函数名与毫秒是 LoAF 直接给的,包名 / 文件 / 行号是推断出来的
					scriptAttribution: leaf(state.precise === true ? (maps.pending > 0 ? 'degraded' : 'on') : 'degraded', 'inferred',
						state.precise === true
							? `精确归因已开;分段表 pending ${maps.pending} / ready ${maps.ready} / failed ${maps.failed}`
							: '精确归因没开:合并批次只能给整批,拿不到单包名'),
					domWrites: leaf(state.deep === true ? 'degraded' : 'off', 'inferred',
						state.deep === true ? `插桩已开(DOM 写入按 1/${MUT_SAMPLE} 采样,估算是折算的)` : '深录没开:DOM 写入者没有记账'),
					interactions: leaf(watch.eventState === 'on' ? 'on' : (String(watch.eventState).startsWith('unsupported') ? 'unsupported' : 'off'),
						'measured', `交互计时:${watch.eventState}(窗口内保留 ${io} 条)`),
					elementTiming: leaf('unsupported', 'unknown', 'DSH 的 DOM 上没有 elementtiming 属性,这一路恒为 0'),
				},
				host: {
					eventLoop: leaf(loop === null ? 'off' : 'on', 'measured',
						loop === null ? (state.hostError === null || state.hostError === undefined ? '还没拿到宿主快照' : `宿主路由不可达:${state.hostError}`) : `p50/p99/max 已采(${host.at ?? '—'})`),
					events: leaf(state.hostEvents === null || state.hostEvents === undefined ? 'off' : (state.hostEvents.installed === true ? 'on' : 'degraded'), 'measured',
						state.hostEvents === null || state.hostEvents === undefined ? '还没请求宿主事件监听' : `session/event 到达延迟:${state.hostEvents.installed === true ? '已装' : state.hostEvents.reason ?? '没装上'}`),
					cpuProfile: leaf('off', 'unknown', '宿主路由能采 Node CPU profile,客户端还没接线(要动宿主半,排在后面)'),
				},
				link: {
					rtt: leaf(linkCount > 0 ? 'on' : 'off', 'measured', `链路样本 ${linkCount} 条(环形缓冲里全部)`),
					throughput: leaf(loadState === 'ok' ? 'on' : (String(loadState).startsWith('failed') ? 'degraded' : 'off'), 'measured', `吞吐采样:${loadState}`),
				},
				// 明确**不观测**的东西:不假装有,也不给默认值
				unobserved: [
					{ id: 'gpu-compositor', reason: '帧时间花在合成 / 光栅 / GPU 的哪一段,页面内没有 API' },
					{ id: 'electron-main', reason: 'Electron 主进程 / GPU 进程这一层本插件没有采' },
					{ id: 'raw-source-lines', reason: '原始源码(TS/TSX)行号要解 section 内层 mappings 的 VLQ,本项目没做' },
					{ id: 'frame-inner-order', reason: '帧内脚本的起止顺序 LoAF 不给(只给每条脚本的时长)' },
					{ id: 'devtools-trace', reason: '完整 Chrome trace 需要 DevTools 录制,页面内录不了' },
				],
			};
		}

		/**
		 * 事故包里的缺失声明。**从能力矩阵推**(而不是手写一串 if),但保留每一行的
		 * `前缀:` 形状与原有措辞 —— 线上/离线都靠前缀断言(见 tests/logic.mjs)。
		 * `row` 为 null 时只给与这一条事故无关的整机级缺失。
		 */
		function capabilityMissing(row) {
			const caps = capabilities();
			const missing = [];
			const howToAdd = [];
			const incident = row ?? null;
			const summary = incident === null ? null : incident.summary ?? {};
			const loaf = caps.renderer.loaf;
			if (loaf.state !== 'on') {
				missing.push(`loaf:脚本级归因(这一层唯一的"谁"的来源)—— ${state.watch.loafState}`);
				howToAdd.push('LoAF 要 Chrome 123+ 且非 dsh-app:// 源;不满足时只能靠既有 longtask 明细与人工 trace');
			} else if (incident !== null && summary.topScripts.length === 0) {
				missing.push('loaf-scripts:这一帧没有脚本(<5ms 的脚本不上报;Mac/Windows 桌面端 dsh-app:// 上恒为空)');
			} else if (incident !== null && summary.pkgCoverage !== undefined && summary.pkgCoverage.resolved < summary.pkgCoverage.total) {
				// 用完整分布(summary.pkgVia),不要只数 topScripts —— 否则会写出"2/11 没定到(not-plugin×1)"这种自相矛盾的话
				const all = summary.pkgVia ?? {};
				const unresolved = Object.entries(all).filter(([key]) => key !== 'url' && key !== 'section');
				missing.push(`loaf-pkg:${summary.pkgCoverage.total - summary.pkgCoverage.resolved}/${summary.pkgCoverage.total} 条脚本没定到包名(${unresolved.map(([k, v]) => `${k}×${v}`).join(' · ') || '原因见 summary.pkgVia'})`);
			}
			if (state.on === false) {
				missing.push('instrumentation:四条腿的归因(没插桩就没有 DOM 写入与调度点包名)');
				howToAdd.push('打开 HUD(面板「开启」或 __perfHud.enable())');
			}
			if (incident !== null && incident.env.precise === false) {
				missing.push('precise:合并批次里的单包名 —— 也包含 LoAF 脚本的 scripts[].pkg(需要精确归因,会拉那份 12MB 的 map)');
				howToAdd.push('面板「深录」(它同时打开精确归因)或 __perfHud.setPrecise(true) —— 只能改善之后抓到的事故,这一条不会重放');
			}
			missing.push('devtools-trace:完整的 Chrome trace(页面内录不了)');
			// A4:交互延迟采到了什么、没采到什么,一律照实写
			if (caps.renderer.interactions.state !== 'on') {
				missing.push(`interaction-timing:交互延迟(event timing)—— ${state.watch.eventState}`);
				howToAdd.push('event timing 要 Chrome 96+;装不上时这一层给不出"点了多久才反应"');
			} else if (incident !== null && summary.interactionsInWindow === 0) {
				missing.push(`interaction-timing:这个窗口里没有 ≥${WATCH_EVENT_MS}ms 的交互(阈值以下的事件不记;长时间没有真人操作也会是 0)`);
				howToAdd.push('复现时真的点几下(≥100ms 的交互才会进环形缓冲),再导出');
			}
			if (state.watch.elementCount === 0) {
				missing.push('element-timing:元素渲染时刻 —— element timing 只观察带 elementtiming 属性的元素,DSH 的 DOM 上没有这个属性,所以这一路恒为 0(照实记,不假装采到)');
			}
			missing.push('interaction-breakdown:单次交互内部"输入延迟 / 处理 / 呈现"的拆分 —— 页面内没有 API,这里只有端到端时长与 processingStart/End');
			howToAdd.push('要拆交互的三段:DevTools → Performance 录制,Hover 到 Interactions 轨道上那一下,看 Input delay / Processing / Presentation');
			howToAdd.push('DevTools → Performance → 录制(勾 include script source maps)→ Save trace → Perfetto 打开');
			missing.push('compositor:帧时间到底花在合成 / 光栅 / GPU 的哪一段(这一层只看得到主线程侧)');
			missing.push('recorder-cost:本记录器自身的开销**没带在这份事故包里**(它每帧跑一次 rAF 采样;面板「记录器自身」与整机导出件的 context.recorder 有 p99 / 峰 / 样本数)');
			missing.push('baseline:跨机器 / 跨浏览器的对照基线 —— context.sessionBaselines 只来自同一个浏览器 profile,而且只是粗参照');
			if (incident === null || incident.host === null) {
				missing.push('host:没有任何宿主快照(宿主半未加载或路由不可达)');
			} else {
				missing.push(`host-cpuprofile:宿主进程的 CPU 火焰图**没有自动采** —— 路由已经能采(POST {op:'profileStart', seconds} / {op:'profileGet'},真宿主实测 1 秒 = 292 节点 / 223 采样 / 82KB),但客户端还没接线,要的话手动打一次;而这份宿主快照是${incident.host.snapshotAgeMs >= 0 ? `事故前 ${incident.host.snapshotAgeMs}ms` : `事故**后** ${-incident.host.snapshotAgeMs}ms`}采的(每 10 秒一次),未必覆盖卡顿瞬间;别把它当"宿主没问题"的证据`);
			}
			if (incident !== null && incident.integrity?.captureComplete === false) {
				const drop = incident.integrity;
				missing.push(`window-integrity:这份现场不完整 —— LoAF 丢 ${drop.loafDropped} 条 / longtask 丢 ${drop.longTaskDropped} 条(${drop.reasons.join(' · ')})`);
				howToAdd.push('窗口的事后补采不了:下次卡顿前不要清空 HUD,也不要在 13 秒窗口内刷新 / 触发 HMR;要完整证据只能等下一次');
			}
			howToAdd.push('零成本、当场可做:chrome://gpu 看是不是落到了软件渲染;DevTools → Rendering 打开 Frame Rendering Stats(FPS 表)与 Paint flashing —— 页面完全静止时帧率是否也上不去');
			howToAdd.push('判定"主线程之外":Performance 面板录 5 秒,看 Main 轨道自身的忙碌时间是否远小于墙钟 —— 注意 blocking=0 / scripts 为空**不能**当证据(见上面的读取说明),要看 Main 轨道本身');
			howToAdd.push('宿主火焰图:插件自带路由就能采 —— 带宿主 cookie(见 docs/verification.md)POST /api/dsh-perf-hud/host {op:"profileStart", seconds:5},再 POST {op:"profileGet"} 取回标准 .cpuprofile(speedscope 打开);退一步也可以 kill -USR1 <dsh web pid> → chrome://inspect → Performance → Record');
			return { missing, howToAdd, capabilities: caps };
		}

		// ───────────────── 可能原因:候选假设 + 支持 / 限制 / 出处 ─────────────────
		const CAUSE_MAX = 3;

		/** 出处 / 线索强度的文字档位 —— 只给名字,颜色与排版由 UI 那一侧定。 */
		function provenanceText(kind) {
			// 逐分支写**字面量**键:logic.mjs 的"死键"断言只认字面量 translate('…'),
			// 拼出来的键名它看不见,于是会被当成"没人引用"报出来(踩过)。
			if (kind === 'measured') return translate('provenanceMeasured');
			if (kind === 'inferred') return translate('provenanceInferred');
			return translate('provenanceUnknown');
		}

		function strengthText(level) {
			if (level === 'strong') return translate('strengthStrong');
			if (level === 'medium') return translate('strengthMedium');
			if (level === 'weak') return translate('strengthWeak');
			return translate('strengthNone');
		}

		/**
		 * 候选原因(最多 `CAUSE_MAX` 条)。**这是"可能原因"那一块的唯一生成处**,面板与
		 * 诊断包读同一份 —— 所以"面板上说 A、导出件里说 B"在结构上不会发生。
		 *
		 * 三条不许越界(与 docs/reading-panel.md 的归因三档同源):
		 *   ① 每条候选都带 `limits`,而且限制里一定有那句"不等于已定位根因";
		 *   ② `worstFrameJs === 'none'` 时**不**给节流结论:要么是"更可能"(只有 `suspectedThrottle`
		 *      成立时),要么就是"证据不足";
		 *   ③ 每条候选的 `basis` 全部来自**已经采到的字段**,不合成、不推测。
		 */
		function causeCandidates(row) {
			if (row === null || row === undefined) return [];
			const summary = row.summary ?? {};
			const out = [];
			const notRoot = translate('verdictNotRootCause');
			// ① 脚本 / 包这一支:毫秒是直接测的,包名是推断的
			const packages = Array.isArray(row.packages) ? row.packages : [];
			const cov = summary.pkgCoverage ?? { resolved: 0, total: 0 };
			if (packages.length > 0) {
				const top = packages[0];
				const covered = cov.total === 0 ? true : cov.resolved >= cov.total * 0.8;
				const basis = [`${top.pkg} · ${Math.round(top.ms)}ms · ${top.count}${translate('scriptsUnit')}`,
					`${translate('pkgNamed')} ${cov.resolved}/${cov.total}`];
				const limits = [notRoot];
				if (cov.resolved < cov.total) limits.push(`${cov.total - cov.resolved}${translate('scriptsUnit')}${translate('causeUnresolvedSuffix')}`);
				out.push({
					kind: 'script',
					lead: translate('causeScriptLead'),
					name: top.pkg,
					strength: top.ms >= 100 && covered ? 'strong' : 'medium',
					basis,
					limits,
					provenance: 'inferred',
				});
			}
			// ② long task 的四条腿(owner = 调度方包名 / component = 渲染方组件名)
			const tasks = Array.isArray(row.longTasks) ? row.longTasks : [];
			const byWho = new Map();
			for (const task of tasks) {
				const name = task.component ?? task.owner ?? null;
				if (name === null || name === undefined) continue;
				byWho.set(name, round1((byWho.get(name) ?? 0) + (typeof task.ms === 'number' ? task.ms : 0)));
			}
			const ranked = [...byWho.entries()].sort((a, b) => b[1] - a[1]);
			if (ranked.length > 0) {
				const [name, ms] = ranked[0];
				out.push({
					kind: 'longtask',
					lead: translate('causeLongTaskLead'),
					name,
					strength: ms >= 100 ? 'medium' : 'weak',
					basis: [`${name} · ${ms}ms`, `${translate('cumulative')} ${ranked.length}${translate('times')}`],
					limits: [notRoot, translate('causeLongTaskLimit')],
					provenance: 'inferred',
				});
			}
			// ③ 宿主事件循环(有快照才提,快照年龄写在支持证据里)
			const host = row.host;
			const loop = host === null || host === undefined ? null : host.eventLoop ?? null;
			if (loop !== null && typeof loop.p99 === 'number' && loop.p99 > 50) {
				const age = typeof host.snapshotAgeMs === 'number' ? host.snapshotAgeMs : null;
				out.push({
					kind: 'host',
					lead: translate('causeHostLead'),
					name: translate('hostShort'),
					strength: loop.p99 > 200 ? 'strong' : 'medium',
					basis: [`${translate('causeHostBasis')} ${loop.p50}ms / ${loop.p99}ms`,
						age === null ? translate('notYet') : `${translate('maxLabel')} ${age >= 0 ? '-' : '+'}${Math.abs(age)}ms`],
					limits: [notRoot, translate('hostSnapshotNotInstant')],
					provenance: 'measured',
				});
			}
			// ④ JS 证据缺失那一支:不许把"没证据"写成"浏览器节流"
			if (summary.worstFrameJs === 'none') {
				const throttle = summary.suspectedThrottle === true;
				out.push({
					kind: 'unknown',
					lead: translate('causeNoEvidenceLead'),
					name: null,
					strength: throttle ? 'weak' : 'none',
					basis: [throttle ? translate('verdictThrottleText') : translate('verdictUnattributedText')],
					limits: [translate('jsNo')],
					provenance: 'unknown',
				});
			}
			return out.slice(0, CAUSE_MAX);
		}

		// ───────────────────────── ZIP(store 模式,零依赖)─────────────────────────
		/**
		 * 为什么自己写:本仓库**零运行时依赖、无构建步骤**,不能引 JSZip;而 store(不压缩)模式的
		 * zip 只要三个结构 + CRC32,几十行就够,而且**字节结构可以离线断言**(见 logic.mjs)。
		 * 不压缩的理由:包里全是 JSON / Markdown,deflate 能省一半体积,但要么引依赖、要么
		 * 依赖 `CompressionStream`(异步 + Safari 老版本没有)—— 为了几十 KB 不值得。
		 *
		 * 三条硬性:① 文件名与内容都按 **UTF-8 字节**写,长度用**字节数**(不是字符数);
		 * ② 本地头与中央目录里的 CRC / 长度必须一致(否则任何解压器都报 bad CRC);
		 * ③ 结尾必须有 EOCD(没有它,文件根本不被认成 zip)。
		 */
		/**
		 * 标准 CRC-32(IEEE 802.3):`'123456789'` → 0xCBF43926,有断言钉住。
		 * 用逐位算法而不是 256 项查表:一次打包只调用 4 次,现算换掉一份模块级状态更划算
		 * (而且"没有额外的模块级 const"让两个测试沙箱都好抽)。
		 */
		function crc32(bytes) {
			let crc = -1;
			for (let i = 0; i < bytes.length; i += 1) {
				crc ^= bytes[i];
				for (let k = 0; k < 8; k += 1) crc = (crc & 1) !== 0 ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
			}
			return (crc ^ -1) >>> 0;
		}

		function utf8Bytes(text) {
			return new TextEncoder().encode(String(text));
		}

		/** zip 要的是 DOS 时间戳(两个 16 位字段),不是 ISO 串。 */
		function dosStamp(atMs) {
			const date = new Date(typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : Date.now());
			const year = Math.max(1980, date.getFullYear());
			return {
				time: ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xFFFF,
				date: (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF,
			};
		}

		/** `files` = `[{ name, text }]` → zip 的字节(store,不压缩)。 */
		function zipStore(files, atMs) {
			const stamp = dosStamp(atMs);
			const parts = [];
			const central = [];
			let offset = 0;
			for (const file of files) {
				const name = utf8Bytes(file.name);
				const data = utf8Bytes(file.text);
				const crc = crc32(data);
				const local = new Uint8Array(30 + name.length);
				const lv = new DataView(local.buffer);
				lv.setUint32(0, 0x04034B50, true);      // 本地文件头签名
				lv.setUint16(4, 20, true);              // version needed to extract
				lv.setUint16(6, 0x0800, true);          // 文件名是 UTF-8
				lv.setUint16(8, 0, true);               // 0 = store
				lv.setUint16(10, stamp.time, true);
				lv.setUint16(12, stamp.date, true);
				lv.setUint32(14, crc, true);
				lv.setUint32(18, data.length, true);    // 压缩后大小 = 原始大小(store)
				lv.setUint32(22, data.length, true);
				lv.setUint16(26, name.length, true);
				lv.setUint16(28, 0, true);              // extra 长度
				local.set(name, 30);
				parts.push(local, data);
				const dir = new Uint8Array(46 + name.length);
				const dv = new DataView(dir.buffer);
				dv.setUint32(0, 0x02014B50, true);      // 中央目录签名
				dv.setUint16(4, 20, true);              // version made by
				dv.setUint16(6, 20, true);
				dv.setUint16(8, 0x0800, true);
				dv.setUint16(10, 0, true);
				dv.setUint16(12, stamp.time, true);
				dv.setUint16(14, stamp.date, true);
				dv.setUint32(16, crc, true);
				dv.setUint32(20, data.length, true);
				dv.setUint32(24, data.length, true);
				dv.setUint16(28, name.length, true);
				dv.setUint16(30, 0, true);              // extra
				dv.setUint16(32, 0, true);              // comment
				dv.setUint16(34, 0, true);              // disk number
				dv.setUint16(36, 0, true);              // internal attrs
				dv.setUint32(38, 0, true);              // external attrs
				dv.setUint32(42, offset, true);         // 本地头偏移
				dir.set(name, 46);
				central.push(dir);
				offset += local.length + data.length;
			}
			let centralSize = 0;
			for (const dir of central) centralSize += dir.length;
			const eocd = new Uint8Array(22);
			const ev = new DataView(eocd.buffer);
			ev.setUint32(0, 0x06054B50, true);          // EOCD 签名
			ev.setUint16(4, 0, true);
			ev.setUint16(6, 0, true);
			ev.setUint16(8, files.length, true);
			ev.setUint16(10, files.length, true);
			ev.setUint32(12, centralSize, true);
			ev.setUint32(16, offset, true);             // 中央目录起始偏移
			ev.setUint16(20, 0, true);                  // 注释长度
			const all = [...parts, ...central, eocd];
			let total = 0;
			for (const part of all) total += part.length;
			const out = new Uint8Array(total);
			let at = 0;
			for (const part of all) { out.set(part, at); at += part.length; }
			return out;
		}

		/** zip 字节 → base64:给验收器用(CDP 里传字节数组太笨重)。分块,避免 apply 爆栈。 */
		function zipBase64(bytes) {
			let text = '';
			const CHUNK = 0x8000;
			for (let at = 0; at < bytes.length; at += CHUNK) {
				text += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
			}
			return btoa(text);
		}

		// ───────────────────────── 诊断包(给人看,也给 AI 读)─────────────────────────
		/**
		 * 包是**数据**,不是界面文案:构建全在这几个纯函数里,UI 只负责下载。
		 * 好处很直接 —— 摘要、manifest、脱敏都能在离线套件里断言,不用开浏览器;
		 * 而且以后换界面、加 MCP,这份格式不用跟着动(产品计划 §3.B 要的就是这个解耦)。
		 *
		 * ⚠️ 包内**不含**聊天正文、提示词、Cookie、Token、请求头 —— 不是"筛掉了",是本来就没采
		 * (`capabilities` / `redactionReport` 里都照实写着)。
		 */
		// v2:incident 增加 `integrity`(captureComplete / loafDropped / longTaskDropped / reasons)。
		const PACK_SCHEMA_VERSION = 2;

		function manifestFor(row, options) {
			const caps = capabilities();
			const win = row === null || row === undefined ? null : row.window ?? null;
			const raw = {
				schemaVersion: PACK_SCHEMA_VERSION,
				kind: 'dsh-perf-hud-diagnostic-pack',
				plugin: PKG,
				pluginVersion: state.host === null || state.host === undefined ? null : state.host.pluginVersion ?? null,
				dshVersion: state.host === null || state.host === undefined ? null : state.host.dshVersion ?? null,
				platform: {
					page: location.href,
					userAgent: navigator.userAgent,
					viewport: `${W.innerWidth}×${W.innerHeight}`,
					devicePixelRatio: W.devicePixelRatio,
					hardwareConcurrency: navigator.hardwareConcurrency ?? null,
					utcOffsetMin: -new Date().getTimezoneOffset(),
				},
				captureTier: state.deep === true ? 'deep' : 'watch',
				instrumented: state.on === true && state.deep === true,
				language: docLang(),
				exportedAt: new Date().toISOString(),
				range: win === null ? null : { from: win.from ?? null, to: win.to ?? null, preMs: win.preMs ?? null, postMs: win.postMs ?? null },
				// null = 老包(没有 integrity 字段):不知道,不许冒充"完整"
				complete: row === null || row === undefined || row.integrity === undefined ? null : row.integrity.captureComplete !== false,
				incident: row === null || row === undefined ? null : {
					id: row.id, at: row.at, cause: row.cause, severity: row.severity,
					frames: Array.isArray(row.frames) ? row.frames.length : 0,
					loafEntries: Array.isArray(row.loaf) ? row.loaf.length : 0,
					longTasks: Array.isArray(row.longTasks) ? row.longTasks.length : 0,
					interactions: Array.isArray(row.interactions) ? row.interactions.length : 0,
					integrity: row.integrity ?? null,
				},
				tally: tallyReport(),
				capabilities: caps,
				// 这份包**不含**什么:与 redactionReport 的 neverCollected 是同一份口径
				notIncluded: [
					'聊天正文与提示词(本插件从不读取被测量的 DOM 内容)',
					'Cookie / Token / 请求头(只读 performance 观察器与自己的宿主路由回执)',
					'宿主进程的 CPU profile(路由能采,但这份包没有自动采)',
				],
				files: ['manifest.json', 'summary.md', 'incident.json', 'README.md'],
			};
			const safe = redactExport(raw, options);
			safe.redaction = redactionReport(options);
			return safe;
		}

		/** 摘要的固定形态:摘要 → 假设 → 缺失 → 下一步 → 元信息(产品计划 §4 要求的那六段)。 */
		function diagnosticSummary(row, options) {
			const t = translate;
			const opts = options ?? {};
			const lines = [t('packSummaryTitle'), ''];
			const verdict = incidentVerdict(row);
			const owner = incidentOwner(row);
			const win = row.window ?? {};
			const span = typeof win.fromMs === 'number' && typeof win.toMs === 'number' ? round1(win.toMs - win.fromMs) : null;
			lines.push(t('packSecSummary'));
			lines.push(`- ${t('sevLabel')}:${severityText(severityLevel(row.severity))}(${Math.round(row.severity)}ms)`);
			// ⚠️ 摘要这一行**必须吃同一个 dropFreeText**:否则同一份包里 `incident.json` 把备注置空了、
			// `summary.md` 还带着原文 —— 两份文件各说各话,而包里那份正是要交给 AI 的(实测踩过)。
			// 保留那一支也要过 scrubParams:自由文本里粘贴的凭据同样不许原样出门。
			const note = row.note === null || row.note === undefined ? '' : String(row.note);
			const noteText = note === '' ? '' : (opts.dropFreeText === true ? ` · ${t('previewNotesDropped')}` : ` · ${redactPath(scrubParams(note))}`);
			lines.push(`- ${t('worstEvent')}:${row.at}${noteText}`);
			lines.push(`- ${t('evWindow')}:${span === null ? t('none') : `${Math.round(span)}ms`} · ${Array.isArray(row.frames) ? row.frames.length : 0}${t('framesUnit')}`);
			if (row.integrity?.captureComplete === false) {
				lines.push(`- ${t('integrityIncomplete')}:LoAF ${row.integrity.loafDropped} · longtask ${row.integrity.longTaskDropped}(${row.integrity.reasons.join(' · ')})`);
			}
			lines.push(`- ${t('verdictLabel')}:${t(verdict.level === 'confirmed' ? 'verdictConfirmed' : verdict.level === 'suspected' ? 'verdictSuspected' : 'verdictUnattributed')}`);
			lines.push('');
			// 假设
			const candidates = causeCandidates(row);
			lines.push(t('packSecCandidates'));
			if (candidates.length === 0) {
				lines.push(`- ${t('packNoCandidate')}`);
			} else {
				candidates.forEach((item, index) => {
					lines.push(`### ${t('packCauseLabel')} ${index + 1}:${item.lead}${item.name === null ? '' : ` · ${item.name}`} —— ${strengthText(item.strength)}`);
					lines.push(`- ${t('packSupport')}:${item.basis.join(' / ')}`);
					lines.push(`- ${t('packLimits')}:${item.limits.join(' / ')}`);
					lines.push(`- ${t('packProvenance')}:${provenanceText(item.provenance)}`);
					lines.push('');
				});
			}
			// 缺失 / 下一步 / 元信息
			const gaps = capabilityMissing(row);
			lines.push(t('packSecMissing'));
			for (const line of gaps.missing) lines.push(`- ${line}`);
			lines.push('');
			lines.push(t('packSecNext'));
			for (const line of gaps.howToAdd) lines.push(`- ${line}`);
			lines.push('');
			lines.push(t('packSecMeta'));
			lines.push(`- plugin:${PKG}${state.host === null || state.host === undefined || state.host.pluginVersion === undefined ? '' : ` v${state.host.pluginVersion}`}`);
			lines.push(`- ${t('packTier')}:${state.deep === true ? t('deepShort') : t('watch')}`);
			lines.push(`- exportedAt:${new Date().toISOString()}`);
			lines.push(`- schemaVersion:${PACK_SCHEMA_VERSION}`);
			if (owner !== null) lines.push(`- ${t('evOwner')}:${owner.name} · ${Math.round(owner.ms)}ms`);
			lines.push('');
			return lines.join('\n');
		}

		/** 包里的 README:告诉人(和 AI)这份包是什么、怎么读、缺什么。跟着界面语言走。 */
		function packReadme(options) {
			const t = translate;
			return [
				t('packReadmeTitle'),
				'',
				t('packReadmeWhat'),
				t('packReadmeHow'),
				t('packReadmePrivacy'),
				t('packReadmeNotes'),
				'',
			].join('\n');
		}

		/**
		 * 构建诊断包(不下载)。返回 `{ files, preview }` —— 顺序固定,`manifest.json` 在最前,
		 * 因为它是"这份包该怎么读"的入口。
		 */
		function buildPack(id, options) {
			const row = pickIncident(id);
			if (row === null || row === undefined) return null;
			const opts = options ?? {};
			const report = incidentReport(id, opts);
			const files = [
				{ name: 'manifest.json', text: JSON.stringify(manifestFor(row, opts), null, 2) },
				{ name: 'summary.md', text: diagnosticSummary(row, opts) },
				{ name: 'incident.json', text: JSON.stringify(report, null, 2) },
				{ name: 'README.md', text: packReadme(opts) },
			];
			return { files, preview: packPreview(id, opts, files) };
		}

		/**
		 * 导出预览:即将包含哪些文件、各多大、脱了什么、哪些证据是缺的。
		 * `files` 传进来就直接算(避免重复构建),否则只算清单不算内容。
		 */
		function packPreview(id, options, files) {
			const row = pickIncident(id);
			if (row === null || row === undefined) return null;
			const opts = options ?? {};
			const list = files ?? buildPack(id, opts)?.files ?? [];
			// 压缩包总大小:预览里给用户看的那个数(store 模式 ≈ 各份之和 + 每个条目 ~100 字节的目录开销)
			const zipBytes = list.length === 0 ? 0 : zipStore(list).length;
			const gaps = capabilityMissing(row);
			return {
				incident: { id: row.id, at: row.at, severity: row.severity },
				tier: state.deep === true ? 'deep' : 'watch',
				files: list.map((file) => ({
					name: file.name,
					bytes: file.text.length,
				})),
				zipBytes,
				includes: [
					'事故的结构化证据:帧序列 / LoAF / 窗口内 long task / 环境读数',
					'能力矩阵与缺失声明(哪一层采到了、哪一层没有、为什么)',
					'发生频次(最近 24 小时的滚动计数)',
				],
				excludes: capabilities().unobserved.map((item) => `${item.id}:${item.reason}`),
				// 两条导出路径的**唯一实质差别**:给 AI 的那条把自由文本置空并标 noteDropped,
				// 本机调试件保留。放在预览里写明,免得用户以为两份是同一份。
				notes: opts.dropFreeText === true ? 'dropped' : 'kept',
				redaction: redactionReport(opts),
				missingCount: gaps.missing.length,
				nextStepCount: gaps.howToAdd.length,
				note: translate('packPreviewNote'),
			};
		}

		/**
		 * 下载整包:**一个 zip 一次搞定**(P1 之前是逐个下载 4 个文件 —— 部分浏览器会把后续
		 * 下载拦掉,而且用户文件夹里会散落四个文件)。文件名带 `-ai` / `-full`,两条路径落到
		 * 磁盘上也分得清。返回 false 表示没这个 id(不静默成功)。
		 */
		function exportPack(id, options) {
			const opts = options ?? {};
			const pack = buildPack(id, opts);
			if (pack === null) return false;
			const row = pickIncident(id);
			const bytes = zipStore(pack.files);
			const base = incidentFileName(row, row.at).replace(/\.json$/, '');
			const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
			const link = document.createElement('a');
			link.href = url;
			link.download = `${base}${opts.dropFreeText === true ? '-ai' : '-full'}.zip`;
			link.click();   // 不挂进 body:避免污染被统计的 DOM
			natives.setTimeout(() => URL.revokeObjectURL(url), 2000);
			return true;
		}

		// ───────────────────────────── 导出脱敏(离开本机的文件先做减法)─────────────────────────────
		/**
		 * 导出件会被交到外部 AI / 同事手里,所以**先做减法,再把减了什么写进 `context.redaction`**。
		 * 三条铁律:
		 *   ① 页面地址只留 origin + path —— DSH 首屏是 `?token=…` 进来的,查询串是凭据最可能的藏身处;
		 *   ② 脚本 URL 只留路径 + `rev`(rev 是证据),敏感参数的值换成 `<redacted>`;
		 *   ③ 用户目录与完整 UA 属于"能定位到具体的人",一并降级。
		 * 这是**减法,不是匿名化**:`redactionReport()` 的 applied / kept / neverCollected 三个数组
		 * 如实交代做了什么、没做什么、本来就没采什么 —— 不许写成"已匿名化"。
		 */
		// 单行数组:离线套件按"整行"抽常量(见 tests/logic.mjs),多行会被截断
		const SECRET_PARAM_NAMES = ['token', 'accessToken', 'access_token', 'refresh_token', 'id_token', 'api_key', 'apikey', 'api-key', 'key', 'secret', 'client_secret', 'password', 'passwd', 'pwd', 'auth', 'authorization', 'bearer', 'session', 'sessionid', 'sid', 'sig', 'signature', 'credential', 'code'];
		const SECRET_PARAM = new RegExp(`^(?:${SECRET_PARAM_NAMES.join('|')})$`, 'i');
		const HOME_PATH = /(^|[^A-Za-z0-9._-])\/(?:Users|home)\/[^/\s"']+/g;
		const WIN_HOME_PATH = /[A-Za-z]:\\Users\\[^\\\s"']+/g;

		/** 敏感参数只换**值**、保留键名 —— 读的人要知道这里本来有什么,才知道该不该去别处找。 */
		function scrubParams(text) {
			const raw = String(text);
			if (raw.indexOf('=') === -1) return raw;
			return raw
				.replace(/([?&#])([A-Za-z0-9_.-]+)=([^&#\s]*)/g,
					(all, sep, key) => (SECRET_PARAM.test(key) ? `${sep}${key}=<redacted>` : all))
				// 自由文本里的凭据常常是**裸的** `token=abc`(前面没有 ?/&),URL 那条规则漏掉它们。
				// 再按词边界扫一遍:代价是 `code=200` 这类无关键也会被换成占位符 —— 宁可多脱一个,不要漏一个。
				.replace(/(^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+)=([^\s&#]*)/g, (all, head, key, value) =>
					(SECRET_PARAM.test(key) && value !== '<redacted>' ? `${head}${key}=<redacted>` : all));
		}

		/** 页面地址:只留 origin + path(+ 脱敏过的 hash),**查询串整段丢**。 */
		function redactPageUrl(raw) {
			if (typeof raw !== 'string' || raw === '') return null;
			try {
				const url = new URL(raw, location.href);
				if (url.origin === 'null') return scrubParams(raw);
				return `${url.origin}${url.pathname}${url.hash === '' ? '' : scrubParams(url.hash)}`;
			} catch (error) {
				return scrubParams(raw);
			}
		}

		/** 脚本 URL:路径与 `rev` 都要留(它们是证据),去掉协议+主机,敏感参数换值。 */
		function redactScriptUrl(raw) {
			if (typeof raw !== 'string' || raw === '') return null;
			return scrubParams(String(raw).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, ''));
		}

		/** 用户目录 → `~`:整条路径带着用户名,把它交出去等于连人一起交出去。 */
		function redactPath(text) {
			if (typeof text !== 'string' || text === '') return text;
			return text.replace(HOME_PATH, '$1~').replace(WIN_HOME_PATH, '~');
		}

		/** UA 只留"浏览器主版本 + 系统":完整 UA 能指纹到具体机器,而兼容性判断只用到主版本。 */
		function redactUserAgent(raw) {
			if (typeof raw !== 'string' || raw === '') return null;
			const browser = /(Edg|OPR|Chrome|CriOS|Firefox|FxiOS|Version)\/(\d+)/.exec(raw);
			const os = /(Windows NT [\d.]+|Mac OS X [\d_]+|Android \d+|iPhone OS [\d_]+|Linux)/.exec(raw);
			const head = browser === null ? 'unknown-browser' : `${browser[1]}/${browser[2]}`;
			return `${head} · ${os === null ? 'unknown-os' : os[1]}`;
		}

		// 按键分派:页面地址与脚本地址的规则不同(前者丢查询串,后者要留 rev)
		const PAGE_KEYS = new Set(['page', 'href']);
		const SCRIPT_URL_KEYS = new Set(['url', 'urls', 'sourceURL', 'scriptUrl']);
		const FREE_TEXT_KEYS = new Set(['note']);

		/**
		 * 深度脱敏:导出件只有这一个出口,规则集中在这里 —— 以后加导出字段不会漏。
		 * 其余字符串一律过 `scrubParams` + `redactPath`(不对路就原样返回),所以**错误原文、
		 * 组件栈、profile 路径**这些"顺手带出来的东西"也被一并覆盖。
		 * `options.dropFreeText` 为真时把自由文本置空并标 `noteDropped:true`:那些是用户自己敲的字,
		 * 可能整段贴着敏感内容,AI 诊断包默认不带(原始导出件仍保留 —— 那是本机调试件)。
		 */
		function redactExport(value, options, key) {
			const opts = options ?? {};
			if (typeof value === 'string') {
				if (opts.dropFreeText === true && FREE_TEXT_KEYS.has(key)) return null;
				if (PAGE_KEYS.has(key)) return redactPageUrl(value);
				if (SCRIPT_URL_KEYS.has(key)) return redactScriptUrl(value);
				if (key === 'userAgent') return redactUserAgent(value);
				return redactPath(scrubParams(value));
			}
			if (Array.isArray(value)) return value.map((item) => redactExport(item, opts, key));
			if (value === null || typeof value !== 'object') return value;
			const out = {};
			for (const name of Object.keys(value)) {
				const item = value[name];
				if (opts.dropFreeText === true && FREE_TEXT_KEYS.has(name) && (item === null || typeof item === 'string')) {
					out[name] = null;
					out[`${name}Dropped`] = true;
					continue;
				}
				out[name] = redactExport(item, opts, name);
			}
			return out;
		}

		/** 这份文件做了什么减法、留了什么、本来就没采什么 —— 三问三答,给读文件的人。 */
		function redactionReport(options) {
			const opts = options ?? {};
			return {
				rule: '导出时做减法,不做匿名化;applied / kept / neverCollected 三个数组说明做了什么、没做什么',
				applied: [
					'page / href:只保留 origin + path,查询串整段丢弃(DSH 首屏的 ?token=… 就在这里)',
					`url / urls / sourceURL:去掉协议与主机,保留路径与 rev;这些键名的值会被替换成 <redacted>:${SECRET_PARAM_NAMES.join(' / ')}`,
					'其余字符串:/Users/<用户名>、/home/<用户名>、C:\\Users\\<用户名> 一律换成 ~',
					'userAgent:只保留浏览器主版本 + 操作系统(完整 UA 能指纹到具体机器)',
					opts.dropFreeText === true
						? '自由文本(note / 场景标记的 note):已置空并标 noteDropped:true'
						: '自由文本(note / 场景标记的 note):原样保留(用户自己敲的字,可能含敏感内容)',
				],
				kept: [
					'性能数值本身(毫秒、计数、分位、帧序列)—— 不含个人信息,丢了这份文件就没用了',
					'插件的包名 / 源文件路径 / 行号 —— 这是归因的全部价值,路径只做了 ~ 降级',
					'viewport / devicePixelRatio / hardwareConcurrency / 时区 —— 解读帧耗时与分位要用',
				],
				neverCollected: [
					'聊天正文与提示词(本插件从不读取被测量的 DOM 内容)',
					'Cookie / Token / 请求头(只读 performance 观察器与自己的宿主路由回执)',
					'宿主进程内存 / 磁盘 / 进程树(那是 dsh-perf-lens 的地盘)',
				],
				freeText: opts.dropFreeText === true ? [] : ['incident.note', 'timeline.marks[].note'],
			};
		}

		function snapshot(options) {
			const worst = worstLongTask();
			const payload = {
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
					// sourcemap 缓存是可重建的:淘汰 / 写失败都计数,别让它静默吃满 localStorage
					mapCache: { max: MAP_CACHE_MAX, evicted: state.mapCache.evicted, failed: state.mapCache.failed },
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
					// 发生频次(跨刷新,最近 24h 滚动窗口)—— 与上面的 store(本次会话)不是同一窗口
					tally: tallyReport(),
					// 能力矩阵:哪一层采到了、哪一层没有、为什么 —— 与事故包读同一份函数
					capabilities: capabilities(),
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
			// 唯一的出口:先脱敏,再把"减了什么"贴上去(报告本身不过脱敏,否则它会把自己的说明改掉)
			const safe = redactExport(payload, options);
			safe.context.redaction = redactionReport(options);
			return safe;
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

		/**
		 * 事故包(下载件 / 交给 AI 的那份)。`options.dropFreeText` 为真时把用户自己敲的
		 * note 置空并标 `noteDropped` —— 诊断包走 true,本机调试导出走默认(false)。
		 */
		function incidentReport(id, options) {
			const incident = pickIncident(id);
			if (incident === null || incident === undefined) return null;
			// 缺失声明**由能力矩阵推**(唯一事实来源),不再手写一串 if —— 前缀仍是线上断言认的那几个
			const gaps = capabilityMissing(incident);
			const missing = gaps.missing;
			const howToAdd = gaps.howToAdd;
			const payload = {
				plugin: PKG,
				kind: 'perf-hud-incident',
				schema: 3,                      // 3 = incident.integrity(窗口完整性);2 = URLs 抽表
				exportedAt: new Date().toISOString(),
				context: {
					page: location.href,
					userAgent: navigator.userAgent,
					scenario: state.streaming ? 'streaming' : 'idle',
					watch: watchStatus(),
					// 导出时刻的滚动 24h 计数(跨刷新)。它**不属于事故窗口** —— 用途是回答
					// "最近是偶发还是变频繁了";scope / sessionCounters 里写明别当这一条的统计口径
					tally: tallyReport(),
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
						'summary.topScripts[].file / .line 是"打开哪个文件、哪一段":file 是那个包的**源文件路径**(合并批取自 sourcemap section 的 sources;probe 兜底或老缓存时为 null);line 是**脚本文本自己的行号**(单包 = 那个文件;合并批 = 合并后的大文件)。⚠️ 它**不是**原始源码(TS/TSX)的行号 —— 那要解开 section 内层 mappings 的 VLQ,本项目没做;lineVia 说明行号是怎么来的(text / text-pending / out-of-range …)',
						'scripts[].fn(sourceFunctionName)与 scripts[].ms(sourceCharPosition→duration)是 LoAF **直接给的**(直接测量);pkg / file / line 是由 URL 与分段表**推断的**(归因推断);原始源码行号、调用栈、函数级耗时**都拿不到**(尚无法确认)—— 这条链能缩小到"哪个包的哪个文件哪一段",不能直接指出根因',
						'summary.topScripts[].invoker 是这条脚本**被谁调起来的**(与面板「按来源」同一份归一规则);事件处理器的 invoker 形如 DOMWebSocket.onmessage,不代表"这一帧的 JS 全部来自它"',
						'incident.interactions 是窗口内 ≥100ms 的交互(event timing):ms 是**端到端**时长(到下一次渲染更新),waitMs / handlerMs 是推导出来的两段;**它不拆帧内**(输入延迟/处理/呈现要 DevTools Interactions 轨道)',
						'incident.packages 是按包汇总的脚本耗时(降序),summary.pkgCoverage 是有名字的脚本占比 —— 覆盖率不到 100% 时别把第一行当成全部',
						'脚本侧再往下拆一层:scripts[].forcedMs(forcedStyleAndLayoutDuration)是脚本耗时里"强制样式布局"那部分 —— **它已经算在 ms 里**,别再相加;它是"来源是样式而不是业务逻辑"的同步布局。面板「取证明细」里那两行(脚本按包 / 纯 JS 与强制布局)就是这两件事',
						'incident.integrity.captureComplete 为 false 时,这份现场**采集本身丢过记录**(loafDropped / longTaskDropped 是窗口内的条数;reasons 写明是环形缓冲溢出还是前摇已经滚出环)—— 它仍是一份真实切片,但不能当成"完整的那 13 秒";hiddenGaps 是另一回事(rAF 被挂起,不是我们丢数据)',
						'incident.summary 是上面几块的汇总(含窗口自己的 p50/p90/p99),方便直接和 incident.baseline 比;这一层不做推断,结论请自己下',
						'context.watch.kept 按**严重度降序**,不是时间序;带 restored 的条目来自上一次会话(时间靠 env.perfOrigin 对齐),所以 id 与时间看起来会跳',
						'context.watch.kept[].tier 说明这条是靠哪一档留下来的:worst = 全局最差那一档(前 10 条)、daily = 它那一天最差的一条(最多留最近 7 天)、both = 两档都占。留存是**两档并集**,所以条数上限是 10 + 7 而不是 10 —— 单靠全局最差档时,"昨天下午那次卡"会被同一小时里的 10 次挤掉',
					],
				},
				incident,
			};
			const safe = redactExport(payload, options);
			safe.context.redaction = redactionReport(options);
			return safe;
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

		// ───────────────── 事故:选中上下文 + 面板上那几行文案 ─────────────────
		/**
		 * 事故严重度的**文字档位**。面板上"严重度"不许只靠颜色表达(色盲 / 打印 / 截图转灰度
		 * 都会丢信息),所以先算档位,再同时给文字与 token 颜色。
		 * 阈值不另立一套:红档 200ms 与面板判色的红档同一条线(见 README「面板怎么读」);
		 * 黄档用**守夜触发线** 100ms —— 它已经是一条事故了,"正常"这个词在这里没有意义。
		 */
		function severityLevel(ms) {
			if (typeof ms !== 'number' || Number.isNaN(ms)) return 'none';
			if (ms >= 200) return 'bad';
			if (ms >= WATCH_TRIGGER_MS) return 'warn';
			return 'ok';
		}

		function severityText(level) {
			if (level === 'bad') return translate('sevBad');
			if (level === 'warn') return translate('sevWarn');
			if (level === 'ok') return translate('sevOk');
			return translate('none');
		}

		function severityColor(level) {
			if (level === 'bad') return 'var(--dsw-alias-state-error-primary)';
			if (level === 'warn') return 'var(--dsw-alias-state-warn-primary)';
			if (level === 'ok') return 'var(--dsw-alias-state-success-primary)';
			return 'var(--dsw-alias-label-secondary)';
		}

		/**
		 * 这条事故"是谁":先看按包汇总(packages,已经按包聚合、降序),再退到 topScripts[0]。
		 * 两者都是同一份 scripts 数据,但 packages 去过重 —— 所以它是第一顺位。
		 * 一个包名都没定到时返回 null(面板照实写未归因,**不猜**)。
		 */
		function incidentOwner(row) {
			if (row === null || row === undefined) return null;
			const pkg = Array.isArray(row.packages) && row.packages.length > 0 ? row.packages[0] : null;
			if (pkg !== null && pkg !== undefined && pkg.pkg !== null && pkg.pkg !== undefined) {
				return { name: pkg.pkg, ms: pkg.ms, count: pkg.count };
			}
			const script = row.summary === undefined || row.summary === null ? undefined : row.summary.topScripts[0];
			if (script !== undefined && script !== null && script.pkg !== null && script.pkg !== undefined) {
				return { name: script.pkg, ms: script.ms, count: 1 };
			}
			return null;
		}

		/**
		 * 面板当前选中的那条事故。`{ row, auto }`:
		 *   auto=true  = 没选(跟严重度最差那条,incidents 由 keepIncident 维持降序);
		 *   auto=false = 用户选的;
		 * 选中的那条被更差的新事故挤出留存清单之后**退回自动** —— 不指着一个不存在的条目
		 * (与翻帧那条 `pickT` 的规矩同源)。
		 */
		function selectedIncident() {
			const list = state.watch.incidents;
			if (list.length === 0) return { row: null, auto: true };
			// 「自动」有两条口径:严重度最差(默认,事后回看的重点)或**时刻最新**(刚卡的那一下)。
			// 取不到最新(数据形状不对)时退回最差。
			const auto = state.watch.scope === 'latest' ? (pickIncident('latest') ?? list[0]) : list[0];
			if (state.watch.selId === null) return { row: auto, auto: true };
			const found = list.find((row) => row.id === state.watch.selId);
			if (found === undefined) return { row: auto, auto: true };
			return { row: found, auto: false };
		}

		/**
		 * 切换「自动」跟哪一条:最差 / 最近。**顺带清掉手选** —— 用户按这个按钮的意思就是
		 * "按这个口径来";手选还压着的话点了会像没反应(不要让两个字段抢同一件事)。
		 * 正在看历史事故时,换主体等于换了一整份窗口数据,所以把历史帧的选择也退回收起状态
		 * (退回自动 = 新主体的最差那一帧)。
		 */
		function setIncidentScope(scope) {
			state.watch.scope = scope === 'latest' ? 'latest' : 'worst';
			state.watch.selId = null;
			state.watch.frameT = null;
			state.copyNote = null;
			saveWatchUI();
			bump();
		}

		/**
		 * 选中一条事故(工具箱清单 / 「最差事件」块共用)。选中即进入**历史事故**诊断上下文:
		 * 取证明细整块换成这条事故的窗口与历史帧,不再混实时帧的数据。
		 */
		function selectIncident(id) {
			const row = pickIncident(id);
			if (row === null) return false;
			state.watch.selId = row.id;
			state.watch.mode = 'incident';
			state.watch.frameT = null;
			state.copyNote = null;
			saveWatchUI();
			bump();
			return true;
		}

		// ─────────── 诊断上下文 + 历史事故的**逐帧**数据层(全部来自事故包) ───────────
		/**
		 * 当前诊断上下文:`live` = 实时帧环里的当前帧,`incident` = 选中事故里的一条历史帧。
		 *
		 * **取证明细里每一块吃哪份数据,只由这一个函数决定** —— "上面是历史事故、下面是另一条
		 * 实时帧的编号 / 耗时 / 饼图"那类错误在结构上就无处发生(有断言钉住两个上下文不混)。
		 * 没有可看的事故时不给 `incident`:那会是一个只有缺失状态的空壳。
		 */
		function diagMode() {
			if (state.watch.mode !== 'incident') return 'live';
			return selectedIncident().row === null ? 'live' : 'incident';
		}

		/**
		 * 这条事故里**真实存在的帧**。`gap === true` 不是帧,是整段 rAF 被挂起(帧间隔突然变成
		 * 几秒)—— 它是"这段时间没在测",不参与选中、翻帧与序号,只在帧条上留白。
		 */
		function incidentFrameRows(row) {
			if (row === null || row === undefined || Array.isArray(row.frames) === false) return [];
			return row.frames.filter((frame) => frame !== null && typeof frame === 'object'
				&& frame.gap !== true && typeof frame.t === 'number' && Number.isFinite(frame.t));
		}

		/**
		 * 与这一帧**时间上重叠**的那条 LoAF(`incident.loaf`,捕获时存下来的):这一帧的时间分解
		 * 与脚本 / 来源证据都由它提供。重叠多条时取时长最大的那条(一帧里最重的那一次)。
		 * 没有重叠就是**没有记录** —— 面板照实写缺失,不回退到别的帧,更不回退到实时帧环。
		 */
		function incidentLoafAt(row, frame) {
			if (row === null || frame === null || frame === undefined || Array.isArray(row.loaf) === false) return null;
			const start = frame.t - (typeof frame.ms === 'number' ? frame.ms : 0);
			let best = null;
			for (const entry of row.loaf) {
				if (entry === null || typeof entry.t !== 'number') continue;
				if (entry.t <= frame.t && entry.t + (entry.dur ?? 0) >= start
					&& (best === null || (entry.dur ?? 0) > (best.dur ?? 0))) best = entry;
			}
			return best;
		}

		/**
		 * 这条事故里**最差的那一帧**。严重度只按**帧间隔** —— 事故的严重度口径就是它
		 * (见 README:「事故的严重度以帧间隔为准,LoAF 的 blocking 只当补充」);
		 * 实时那条清单用的是 `frameSeverity = max(blocking, LoAF 时长)`,两者各自在自己
		 * 那份数据上有定义,不互相借用。
		 */
		function incidentWorstFrame(row) {
			let worst = null;
			for (const frame of incidentFrameRows(row)) {
				if (worst === null || (frame.ms ?? 0) > (worst.ms ?? 0)) worst = frame;
			}
			return worst;
		}

		/**
		 * 历史回放**选中的那一帧**:默认跟着最差那一帧;点过帧条 / 翻过帧之后就钉住。
		 * 存的是 `t` 不是下标 —— 与实时翻帧同一个理由(下标会悄悄指到另一帧上)。
		 * 选中的 t 在这个包里找不到就退回自动,不指着一个不存在的帧。
		 */
		function selectedIncidentFrame(row) {
			const frames = incidentFrameRows(row);
			if (frames.length === 0) return null;
			if (state.watch.frameT !== null) {
				const hit = frames.find((frame) => frame.t === state.watch.frameT);
				if (hit !== undefined) return hit;
				state.watch.frameT = null;
			}
			return incidentWorstFrame(row);
		}

		/**
		 * 帧条上这一帧的档位:**与实时帧条共用 `sparkLevel`**(≥100ms 红 / ≥50ms 黄 / 其余中性灰),
		 * 判"异常帧"用同一条线(`PICK_MIN_MS` = 守夜触发线)—— 于是"翻得到的异常帧"与实时清单里
		 * "值得回看的帧"是同一批,两处读数不许打架。
		 */
		function incidentFrameLevel(frame) {
			if (frame === null || frame === undefined) return 'empty';
			if (frame.gap === true) return 'gap';
			return sparkLevel({ ms: frame.ms ?? 0, seen: true, gap: false });
		}

		/** 这一帧算不算"异常帧"(翻帧用的判据):帧间隔越过守夜触发线。 */
		function incidentFrameHot(frame) {
			if (frame === null || frame === undefined) return false;
			return frame.gap !== true && (frame.ms ?? 0) >= PICK_MIN_MS;
		}

		/**
		 * 历史帧的导航状态(序号 / 总数 / 上一条 / 下一条有没有)。渲染侧**只读它**来决定按钮的
		 * 可用性 —— 没有上一条就禁用,不留一个"点了没反应"的动作。
		 * `onlyBad`(「只看异常」开着)时,能不能走**按异常帧判**:按钮上写的是什么,判据就是什么。
		 */
		function incidentFrameNav(row, frame, onlyBad) {
			const frames = incidentFrameRows(row);
			const at = frame === null || frame === undefined ? -1 : frames.findIndex((item) => item.t === frame.t);
			const reachable = (dir) => {
				for (let i = at + dir; i >= 0 && i < frames.length; i += dir) {
					if (onlyBad !== true || incidentFrameHot(frames[i])) return true;
				}
				return false;
			};
			return {
				index: at === -1 ? 0 : at + 1,
				count: frames.length,
				hasPrev: at === -1 ? false : reachable(-1),
				hasNext: at === -1 ? false : reachable(1),
			};
		}

		/** 选中一条历史帧(点帧条 / 翻帧共用)。 */
		function selectIncidentFrame(t) {
			state.watch.frameT = typeof t === 'number' && Number.isFinite(t) ? t : null;
			state.copyNote = null;
			saveWatchUI();
			bump();
		}

		/**
		 * 历史帧翻帧:按**时间序**走一步 —— 帧条是从左到右读的,◀ ▶ 也按时间走(不是按严重度),
		 * 否则"下一帧"会在时间轴上乱跳。到头就停住(按钮那时是禁用的)。
		 * 「只看异常」开着时步长落在**异常帧**上,判据与 `incidentFrameNav` 同一个函数 ——
		 * 所以"按钮亮着"与"按下去会到哪一条"永远是同一件事,不会出现亮着却走不动。
		 */
		function incidentFrameStep(delta) {
			const row = selectedIncident().row;
			const frames = incidentFrameRows(row);
			if (frames.length === 0) return;
			const onlyBad = state.watch.onlyBad === true;
			const current = selectedIncidentFrame(row);
			const at = current === null ? -1 : frames.findIndex((frame) => frame.t === current.t);
			const base = at === -1 ? 0 : at;
			for (let i = Math.max(0, base + delta); i >= 0 && i < frames.length; i += delta) {
				if (onlyBad !== true || incidentFrameHot(frames[i])) { selectIncidentFrame(frames[i].t); return; }
			}
		}

		/** 「只看异常」开关:只是导航过滤器,不动选中的帧,也不动采集。 */
		function setOnlyBad(on) {
			state.watch.onlyBad = on === true;
			saveWatchUI();
			bump();
		}

		/**
		 * 「看这一帧」:切到**历史事故**这个诊断上下文 + 展开「取证明细」+ 选中这条事故里最差的
		 * 那一帧。数据全部来自事故包(`incident.frames` / `incident.loaf`),所以**跨会话读回的事故
		 * 也能逐帧回看** —— 不再依赖"当前帧环里有没有离它近的一帧"那种就近猜测。
		 * 实时那一侧的选中(`pickT`)**不动**:回到实时模式时,原来的实时帧上下文原样还在。
		 * 包里一条帧都没有(老包)时留一句如实说明,不假装有帧可看。
		 */
		function revealIncident(id) {
			const row = pickIncident(id);
			if (row === null) return false;
			state.watch.selId = row.id;
			state.watch.mode = 'incident';
			state.watch.frameT = null;      // 先回自动(最差那一帧),由 selectedIncidentFrame 定
			state.copyNote = null;
			state.groups.detail = true;
			saveGroups();
			if (incidentFrameRows(row).length === 0) {
				state.pickNote = translate('pickNone');
			} else {
				state.pickNote = null;
			}
			saveWatchUI();
			bump();
			return true;
		}

		/** 回到实时模式:不动实时采集数据,也不动历史那一侧的选中(来回切都还原样)。 */
		function showLiveMode() {
			state.watch.mode = 'live';
			state.copyNote = null;
			state.pickNote = null;
			saveWatchUI();
			bump();
		}

		/**
		 * 这条事故的**归因状态**:已确认 / 可疑 / 未归因(§五)。三档都从**已测量的字段**算:
		 *   · `summary.worstFrameJs`  —— 最差那一帧有没有 longtask / LoAF 与它重叠(直接测量);
		 *   · `incidentOwner()`       —— 窗口里的脚本有没有定到包(归因推断,不是因果证明);
		 *   · `summary.suspectedThrottle` —— 捕获时按 ≥500ms + 无 JS 重叠 + 前后帧中位健康判出来的。
		 *
		 * 这一层刻意不做的事:
		 *   · **不**把"没有 JS 证据"直接说成"浏览器节流 / rAF 被挂起" —— 那是一种可能,只有
		 *     `suspectedThrottle` 真的成立时才提,而且写成"更像…",不写成结论;
		 *   · **不**把"窗口里耗时最高的那个包"宣称成根因 —— 归因只缩小到包 / 文件 / 函数名,
		 *     因果关系要别的证据(Chrome trace、二分、隔离实验)。
		 */
		function incidentVerdict(row) {
			if (row === null || row === undefined) return null;
			const summary = row.summary ?? {};
			const owner = incidentOwner(row);
			const js = summary.worstFrameJs === 'js';
			if (js && owner !== null) {
				return {
					level: 'confirmed', label: translate('verdictConfirmed'),
					detail: `${translate('verdictConfirmedText')}:${short(owner.name)} ${Math.round(owner.ms)}ms · ${translate('verdictNotRootCause')}`,
				};
			}
			if (js) {
				return { level: 'suspected', label: translate('verdictSuspected'), detail: translate('verdictSuspectedJsNoPkg') };
			}
			if (summary.suspectedThrottle === true) {
				return {
					level: 'suspected', label: translate('verdictSuspected'),
					detail: `${translate('verdictThrottleText')}(${translate('verdictNeighbours')} ${summary.worstFrameNeighboursMs}ms)`,
				};
			}
			return { level: 'unattributed', label: translate('verdictUnattributed'), detail: translate('verdictUnattributedText') };
		}

		/** 归因状态的档位色:已确认绿 / 可疑橙 / 未归因中性灰(文字永远同时给,不只靠颜色)。 */
		function verdictColor(level) {
			if (level === 'confirmed') return 'var(--dsw-alias-state-success-primary)';
			if (level === 'suspected') return 'var(--dsw-alias-state-warn-primary)';
			return 'var(--dsw-alias-label-secondary)';
		}

		/** 「最差事件」块的那一行:归因状态 + 第一顺位归属(它**不**自己下结论,结论在下一行)。 */
		function eventEvidenceText(row) {
			if (row === null || row === undefined) return '';
			const owner = incidentOwner(row);
			const verdict = incidentVerdict(row);
			const who = owner === null ? translate('unblamed') : `${short(owner.name)} ${Math.round(owner.ms)}ms`;
			return `${translate('verdictLabel')} ${verdict.label} · ${translate('evOwner')} ${who}`;
		}

		/**
		 * 「最差事件」块的**归因说明**行:三档各自把"凭什么"写出来。它替代了旧的那句
		 * `无(更像 rAF 被节流)` —— 那是把一个**可能性**写成了结论。
		 */
		function eventVerdictText(row) {
			if (row === null || row === undefined) return '';
			const verdict = incidentVerdict(row);
			return `${verdict.label}:${verdict.detail}`;
		}

		/** 「最差事件」块的窗口行:窗口里有几帧、几条 LoAF、脚本按包的覆盖率(带分母)。 */
		function eventWindowText(row) {
			if (row === null || row === undefined) return '';
			const summary = row.summary ?? {};
			const cov = summary.pkgCoverage ?? { resolved: 0, total: 0 };
			return `${translate('evWindow')} ${summary.frames ?? 0}${translate('framesUnit')} · LoAF ${summary.loafEntries ?? 0} · ${translate('byPkg')} ${cov.resolved}/${cov.total}`;
		}

		/**
		 * 「复制摘要」要复制的那段文本。给的是**结论 + 口径**,不是整份事故包
		 * (整份走「导出事故包」,那是 JSON)。缺数据的地方照实写,不省略成空。
		 */
		/**
		 * 「复制摘要」的那段文本。它的用途是**交给别的 AI / 同事继续查**,所以除了结论与口径,
		 * 还要带上"缩小到哪个文件哪一段"的证据行与"缺什么" —— 只给一句"最差那条是 X"是查不下去的。
		 *
		 * ⚠️ 它会读 `incident.interactions`(交互延迟)。那一层按规矩**不进面板渲染区**
		 * (见 AGENTS:交互只当端到端时长,不能读成帧内拆分),而这里是给分析者的交接件,
		 * 所以照实写、并写明"端到端、不拆帧内"。
		 */
		function incidentSummaryText(row) {
			if (row === null || row === undefined) return '';
			const summary = row.summary ?? {};
			const owner = incidentOwner(row);
			const cov = summary.pkgCoverage ?? { resolved: 0, total: 0 };
			const verdict = incidentVerdict(row);
			const lines = [
				`${PKG} ${row.id} · ${row.cause} · ${Math.round(row.severity)}ms · ${row.at}`,
				`${translate('sevLabel')} ${severityText(severityLevel(row.severity))} · ${translate('jsEvidence')} ${summary.worstFrameJs === 'js' ? translate('jsYes') : translate('jsNo')}`,
				`${translate('verdictLabel')} ${verdict.label} · ${verdict.detail}`,
				`${translate('evOwner')} ${owner === null ? translate('unblamed') : `${owner.name} ${Math.round(owner.ms)}ms`}`,
				`${translate('evWindow')} ${summary.frames ?? 0}${translate('framesUnit')} · LoAF ${summary.loafEntries ?? 0} · ${translate('byPkg')} ${cov.resolved}/${cov.total}`,
			];
			if (row.integrity?.captureComplete === false) {
				lines.push(`${translate('integrityIncomplete')} · LoAF ${row.integrity.loafDropped} · longtask ${row.integrity.longTaskDropped}(${row.integrity.reasons.join(' · ')})`);
			}
			// 事件来源:窗口里 ≥100ms 的交互(端到端)。没有就整段不写,不摆 0。
			const interactions = Array.isArray(row.interactions) ? row.interactions : [];
			if (interactions.length > 0) {
				const top = interactions.slice().sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 2);
				lines.push(`${translate('handoffInteractions')} ${interactions.length}${translate('times')}: ${top.map((item) => `${item.name ?? item.type ?? '?'} ${Math.round(item.ms ?? 0)}ms`).join(' · ')}${translate('handoffInteractionsScope')}`);
			}
			const evidence = incidentEvidenceLines(row);
			if (evidence.length > 0) {
				lines.push(`${translate('evidenceLabel')}:`);
				for (const line of evidence) lines.push(`  - ${line}`);
			}
			// 正在逐帧回看时,把手边**这一帧**的证据也带上 —— 界面显示哪几行,复制出来就有哪几行
			// (面板与交接件共用 incidentFrameEvidenceRows 这一条路)。
			if (diagMode() === 'incident' && selectedIncident().row === row) {
				const frame = selectedIncidentFrame(row);
				if (frame !== null) {
					const nav = incidentFrameNav(row, frame);
					const frameEvidence = incidentFrameEvidenceRows(row, frame);
					if (frameEvidence.length > 0) {
						lines.push(`${translate('ctxHistoryFrame')} ${nav.index}/${nav.count} · ${Math.round(frame.ms ?? 0)}ms · ${translate('evidenceLabel')}:`);
						for (const ev of frameEvidence.slice(0, EVIDENCE_MAX)) lines.push(`  - ${evidenceLine(ev)}`);
					} else {
						lines.push(`${translate('ctxHistoryFrame')} ${nav.index}/${nav.count} · ${Math.round(frame.ms ?? 0)}ms · ${translate('handoffFrameNoEvidence')}`);
					}
				}
			}
			lines.push(`${translate('evidenceCaliberPlain')}`);
			lines.push(`${translate('evidenceMissingPlain')}`);
			return lines.join('\n');
		}

		/**
		 * 复制一段文本。**失败要如实说**:剪贴板 API 在非安全上下文、页面没聚焦、没权限时都会
		 * reject —— 按钮点了像成功是最糟的一种"假装成功"(见 AGENTS §1)。
		 */
		function copyText(text, label) {
			const done = () => { state.copyNote = `${translate('copied')} · ${label}`; bump(); };
			const fail = (error) => {
				state.copyNote = `${translate('copyFailed')}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 90);
				bump();
			};
			if (navigator.clipboard === undefined || navigator.clipboard === null || typeof navigator.clipboard.writeText !== 'function') {
				fail(new Error(translate('copyNoApi')));
				return;
			}
			try {
				const pending = navigator.clipboard.writeText(text);
				if (pending !== undefined && typeof pending.then === 'function') pending.then(done, fail);
				else done();
			} catch (error) {
				fail(error);
			}
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
			// 新一代:上一代在途的 fetch 结果即使回来了也不许再改状态(fetchTextWithin 检查 epoch)。
			state.epoch += 1;
			state.abort = typeof AbortController === 'function' ? new AbortController() : null;
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
			// 当前代作废:在途的宿主 / map / 脚本文本请求一律 abort,旧代结果不许再改状态。
			state.epoch += 1;
			if (state.abort !== null) {
				state.abort.abort();
				state.abort = null;
			}
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
			/** 发生频次(跨刷新的时间桶):tally(ms?) 给窗口内的检测到 / 已保存 / 丢失三个数。 */
			tally: (ms) => tallyWindow(ms, Date.now()),
			tallyOfDay,
			tallyTitle,
			clearTally,
			incidents: () => state.watch.incidents.map((row) => ({
				id: row.id, severity: row.severity, cause: row.cause, at: row.at, note: row.note, kept: row.kept, summary: row.summary,
			})),
			incident: pickIncident,   // 数字 = 下标(0 最差)/ id / 'latest' = 时刻最新
			capture: captureNow,
			/** 事故包:report(id) 拿对象(不下载),exportIncident(id) 触发下载。 */
			report: incidentReport,
			exportIncident,
			/** 能力矩阵:哪一层采到了、哪一层没有、为什么、属于哪一档出处。 */
			capabilities,
			/** 可能原因(候选假设):面板与诊断包读同一份,所以两边不会各说各话。 */
			causes: (id) => causeCandidates(pickIncident(id ?? 'latest')),
			/** 诊断包:pack(id) 拿对象、preview(id) 只看清单、exportPack(id) 下载一个 zip;zip(id) 给 base64 字节(验收用)。 */
			zip: (id, options) => {
				const pack = buildPack(id, options ?? { dropFreeText: true });
				return pack === null ? null : zipBase64(zipStore(pack.files));
			},
			pack: buildPack,
			preview: (id, options) => packPreview(id, options),
			exportPack,
			/** 只清事故,不动别的读数 —— 与 clear() 分开,免得手滑丢掉等了很久的证据。 */
			clearIncidents: clearIncidentsNow,
			clear() {
				// 注意:守夜层留存的事故**不在这里清** —— 那是等了很久才抓到的东西,
				// 清读数的手滑不该把它带走。要清用 clearIncidents()。
				ring.length = 0;
				// ⚠️ 帧环(`watch.loaf`)也是**读数**,原来漏了它 —— 于是 `clear()` 之后翻帧清单
				// 与「窗口:… 跨 …」纹丝不动("我清了怎么还是跨 3 分"的根因)。顺带把翻帧选择也退回自动。
				state.watch.loaf.length = 0;
				state.watch.pickT = null;
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
			/** 场景标记列表(只读):面板上「标记刚才」写进去的那一串。 */
			marks: () => state.marks,
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
			const fresh = hostFreshness();
			const link = linkStats();
			if (fresh.state === 'unreachable') return { text: translate('hostDown'), color: 'var(--dsw-alias-state-warn-primary)', bad: true };
			// 零样本 / 还在等第一个样本:**不许**给「链路已排除」。这不是"正常",是"不知道"。
			if (fresh.state === 'warming' || fresh.state === 'unsupported') {
				return { text: translate('hostUnknown'), color: 'var(--dsw-alias-label-secondary)', bad: false };
			}
			if (fresh.state === 'stale') {
				return { text: `${translate('hostShort')} ${translate('hostStale')}`, color: 'var(--dsw-alias-state-warn-primary)', bad: true };
			}
			const hostBad = fresh.loop.p99 > 50;
			const linkBad = link.count > 0 && link.p99 > 100;
			if (hostBad || linkBad) {
				const parts = [];
				if (hostBad) parts.push(translate('hostShort'));
				if (linkBad) parts.push(translate('linkShort'));
				return { text: `${parts.join(' / ')}${translate('suspectSuffix')}`, color: 'var(--dsw-alias-state-warn-primary)', bad: true };
			}
			return { text: translate('cleared'), color: 'var(--dsw-alias-state-success-primary)', bad: false };
		}

		/**
		 * 概览第一行:帧 + 长任务 + 命中(短,必须一行放得下)。
		 *
		 * ⚠️ 这里**不**再挂 `(最差那条:未归因)` 那个后缀:`overviewLine2()` 紧接着就在同一块里
		 * 写 `最差那条:<归属>`,而两者的触发条件完全相同(`primaryBlame(worst) === null`)——
		 * 于是相邻两行必然把同一句话说两遍(§5「能不说就不说」)。"命中率"与"最差那条有没有
		 * 归属"是两个口径这件事,由第二行自己的标签 `最差那条` 承担,不再靠第一行重复。
		 */
		function overviewLine1() {
			const worst = worstLongTask();
			return `${translate('overviewFrame')} ${state.frameWorst.toFixed(0)}ms · LT ${worst === null ? translate('none') : `${worst.ms.toFixed(0)}ms`} · ${translate('hit')} ${state.ltBlamed}/${state.ltTotal}`;
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
		/**
		 * 环的四段 = **一个维度**:脚本 / 任务里没归到的 / 渲染 / 样式+布局+绘制(相加恒等于整帧)。
		 * 脚本内部的「来源」细分**不在这里** —— 层级挤在环里读不出来(见 docs/reading-panel.md 的拆解铁律),
		 * 那件事交给 `barSegments` 的堆叠条。
		 */
		function frameArcs(split) {
			return [
				{ ms: split.js, color: 'error', opacity: 1 },
				{ ms: split.taskOther, color: 'neutral', opacity: 1 },
				{ ms: split.render, color: 'warn', opacity: 1 },
				{ ms: split.tail, color: 'brand', opacity: 1 },
			];
		}

		/**
		 * 一条长动画帧的严重度 = `max(blocking, 帧时长)`。**面板里"最差那条帧"只有这一个口径**:
		 * LoAF 的 blocking 在这个环境里常年偏小(实测 45 帧的 blocking 全部 < 100ms,最大 92ms),
		 * 只看它会把 92ms 的帧排到 300ms 的帧前面;而判色(120/200ms)与圆环上的「帧里花在哪」
		 * 显示的也是帧时长。
		 * 以前 `worstLoaf` / `loafRanks` 只看 blocking、`pickList` 看 max —— 于是"自动选中的那条"
		 * 可能根本不在翻帧清单里,标签会显示 `帧 0/N`。现在三处共用这一个函数。
		 */
		function frameSeverity(row) {
			if (row === null || row === undefined) return 0;
			return Math.max(row.blocking ?? 0, row.dur ?? 0);
		}

		/** 最差的那条长动画帧(面板的饼图默认看的就是它)。 */
		function worstLoaf() {
			let best = null;
			for (const row of state.watch.loaf) if (best === null || frameSeverity(row) > frameSeverity(best)) best = row;
			return best;
		}

		/** 按严重度降序的帧清单(最差的排第一)。 */
		function loafRanks() {
			return state.watch.loaf.slice().sort((a, b) => frameSeverity(b) - frameSeverity(a));
		}

		/**
		 * 翻帧的清单:**只收值得回看的帧**(`frameSeverity` ≥ `PICK_MIN_MS`,即帧时长与 blocking
		 * 里更大的那个)。200 条里绝大多数是刚过 50ms 的边角帧,全列出来 ◀ ▶ 就成了体力活
		 * (实测 68 条里真正想看的往往是个位数)。阈值取守夜那条触发线(`WATCH_TRIGGER_MS`),
		 * 这样「翻帧翻得到的」和「守夜留得下的」是同一批帧。
		 * 一条都不到线时**退回全部**(否则按钮点了像坏的),此时 `filtered:false`,面板不显示阈值。
		 */
		function pickList() {
			const all = loafRanks();
			const hot = all.filter((row) => frameSeverity(row) >= PICK_MIN_MS);
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
		const SPARK_REPLAY_HEIGHT = 24;   // 事故回放条的高度(窗口短,细节看得清一点)
		const SPARK_MAX_MS = 200;    // 画满高度的帧间隔(再高也只是画满)

		/**
		 * 最近 SPARK_SECONDS 秒的分格数据:一格一秒,格值 = 那一格里最差那帧的间隔;间隙另标。
		 * `t` 带上"最差那一帧的 perf 毫秒" —— 帧条 hover 要给出墙钟时间,点格导航也要它。
		 */
		function sparkBars(now) {
			const from = now - SPARK_SECONDS * 1000;
			const cells = [];
			for (let i = 0; i < SPARK_SECONDS; i += 1) cells.push({ ms: 0, t: null, seen: false, gap: false });
			for (const row of frameRing.slice(from, now)) {
				const index = Math.min(SPARK_SECONDS - 1, Math.max(0, Math.floor((row.t - from) / 1000)));
				const cell = cells[index];
				if (row.gap === true) { cell.gap = true; continue; }
				cell.seen = true;
				if (row.ms > cell.ms) { cell.ms = row.ms; cell.t = row.t; }
			}
			return cells;
		}

		/**
		 * 帧条上**点得动**的格子:一格 → 那一格里最差的那条**长动画帧**(LoAF 环里真实存在的)。
		 * 为什么不是每格都能点:帧条是按 `frameRing` 画的(每个 rAF 一条),而翻帧只在
		 * `state.watch.loaf` 里翻 —— 点一个没有 LoAF 的格子会"什么也没发生",那正是最糟的一种
		 * 假按钮。所以只有能真正导航过去的格子才给 onClick,别的格子只给 title 说清原因。
		 */
		function sparkPickMap(now) {
			const from = now - SPARK_SECONDS * 1000;
			const picks = new Map();
			for (const frame of state.watch.loaf) {
				const index = Math.floor((frame.t - from) / 1000);
				if (index < 0 || index >= SPARK_SECONDS) continue;
				const current = picks.get(index);
				if (current === undefined || (frame.dur ?? 0) > (current.dur ?? 0)) picks.set(index, frame);
			}
			return picks;
		}

		/**
		 * 帧条一格 hover 的说明:墙钟时间 + 这一秒最差帧多少 + 点得动还是点不动。
		 * **点不动要写在 title 里** —— 不然读者只会以为"这个面板点了没反应"。
		 */
		function sparkCellTitle(cell, pick) {
			const when = cell.t === null ? '' : `${clock(wallClock(cell.t))} · `;
			if (cell.seen !== true) {
				return when + (cell.gap === true ? translate('sparkGap') : translate('notYet'));
			}
			const base = `${when}${translate('worstOne')} ${Math.round(cell.ms)}ms`;
			return pick === undefined ? `${base} · ${translate('sparkNoPick')}` : `${base} · ${translate('sparkPickHint')}`;
		}

		// ───────────────── 事故回放(数据全部来自事故包) ─────────────────
		/**
		 * 事故回放吃的那份数据:**只用事故包里存下来的东西**(`incident.frames` / `incident.loaf` /
		 * `summary`),所以它**刷新生效**,也不花任何新的采集成本 —— 面板上面那条 60 秒帧条是
		 * **实时**帧环(刷新就没了),两者刻意分开显示、各自写明范围。
		 *
		 * 不做、也不假装的事:LoAF 不给每帧内脚本的**起止时间**,所以这里**不排帧内执行顺序**;
		 * 一帧里谁先谁后只有 Chrome trace 知道。
		 */
		function replayScope() {
			const row = selectedIncident().row;
			if (row === null || Array.isArray(row.frames) === false || row.frames.length === 0) return null;
			const frames = row.frames;
			const win = row.window ?? {};
			const from = typeof win.fromMs === 'number' ? win.fromMs : frames[0].t;
			const to = typeof win.toMs === 'number' ? win.toMs : frames[frames.length - 1].t;
			const span = Math.max(1, round1(to - from));
			let worst = null;
			let gaps = 0;
			for (const frame of frames) {
				if (frame.gap === true) { gaps += 1; continue; }
				if (worst === null || frame.ms > worst.ms) worst = frame;
			}
			// 与最差帧**时间上重叠**的那条 LoAF:只用来给这一帧的时间分解(就近,不等于"这一帧只属于它")
			let split = null;
			const loaf = Array.isArray(row.loaf) ? row.loaf : [];
			if (worst !== null) {
				for (const entry of loaf) {
					const start = worst.t - worst.ms;
					if (entry.t <= worst.t && entry.t + (entry.dur ?? 0) >= start) { split = frameSplit(entry); break; }
				}
			}
			return { row, frames, from, to, span, worst, gaps, split, summary: row.summary ?? {} };
		}

		/**
		 * 回放条上这一帧的横坐标 —— **按时间**放(不是按序号):整段 rAF 被挂起的那几秒会留白,
		 * 一眼看得出"这段时间根本没在测"。按序号放会把那个间隔压成一根柱子,那就等于说谎。
		 */
		function replayX(t, from, spanMs, width) {
			if (!(spanMs > 0) || !(width > 0)) return 0;
			const x = Math.round(((t - from) / spanMs) * width);
			return x < 0 ? 0 : (x > width ? width : x);
		}

		/** 回放范围那一行:窗口跨度 / 帧数 / 分位 / 最差 / 缺口数(每一项都带单位)。 */
		function replaySummaryText(scope) {
			const summary = scope.summary;
			const parts = [`${translate('windowScope')} ${spanText(scope.span)}`, `${scope.frames.length}${translate('framesUnit')}`];
			if (typeof summary.p50 === 'number') parts.push(`p50 ${summary.p50}ms`);
			if (typeof summary.p99 === 'number') parts.push(`p99 ${summary.p99}ms`);
			if (scope.worst !== null) parts.push(`${translate('watchWorst')} ${Math.round(scope.worst.ms)}ms`);
			if (scope.gaps > 0) parts.push(`${translate('replayGaps')} ${scope.gaps}`);
			return parts.join(' · ');
		}

		/**
		 * 事故包里某一刻的**墙钟**时间。⚠️ 不能用 `wallClock()`:那个用的是**当前页面**的
		 * timeOrigin,跨会话读回的事故(perf 时间轴已经重开)会被算成"今天的某个时刻"。
		 * 事故包自带 `env.perfOrigin`(捕获那一刻的 timeOrigin),用它才对;老包没有就返回 null,
		 * 面板照实写"时间未知",不编一个。
		 */
		function incidentWallClock(row, t) {
			if (row === null || row === undefined || typeof t !== 'number') return null;
			const origin = Date.parse(row.env?.perfOrigin ?? '');
			return Number.isFinite(origin) ? origin + t : null;
		}

		/**
		 * 历史帧条的**列**:把事故窗口按时间切成 `REPLAY_COLS` 列,每列取该列里**最差的那一帧**
		 * (所以尖刺不会被平均掉),并把那一帧的引用留在格子里。
		 *
		 * 三条硬性:
		 *   ① 横轴按**时间**放(不是序号):整段 rAF 被挂起的那几秒是**留白**,一眼看出
		 *      "这段时间根本没在测";按序号放会把那个缺口压成一根柱子 = 说谎;
		 *   ② **不合成帧**:格子里的 `frame` 一定是 `incident.frames` 里真实存在的那一条,
		 *      点击 / 选中 / 高亮全部映射回它(有断言钉住"列的 frame 都在原数组里");
		 *   ③ 只画真实存在的时间区间,采样缺失的地方不补柱子。
		 */
		function replayColumns(row) {
			const frames = row === null || row === undefined || Array.isArray(row.frames) === false ? [] : row.frames;
			if (frames.length === 0) return null;
			const win = row.window ?? {};
			const from = typeof win.fromMs === 'number' ? win.fromMs : frames[0].t;
			const to = typeof win.toMs === 'number' ? win.toMs : frames[frames.length - 1].t;
			const span = Math.max(1, round1(to - from));
			const cells = [];
			for (let i = 0; i < REPLAY_COLS; i += 1) cells.push(null);
			let liveCount = 0;
			let gapCount = 0;
			for (const frame of frames) {
				if (frame === null || typeof frame.t !== 'number' || Number.isFinite(frame.t) === false) continue;
				const index = Math.min(REPLAY_COLS - 1, Math.max(0, replayX(frame.t, from, span, REPLAY_COLS)));
				let cell = cells[index];
				if (cell === null) { cell = { index, frame: null, ms: 0, count: 0 }; cells[index] = cell; }
				cell.count += 1;
				if (frame.gap === true) { gapCount += 1; continue; }
				liveCount += 1;
				// 同一格里有多帧时留**最差**的那一条(它才是这一格里值得点开的那一帧)
				if (cell.frame === null || (frame.ms ?? 0) > cell.ms) { cell.frame = frame; cell.ms = frame.ms ?? 0; }
			}
			for (const cell of cells) if (cell !== null) cell.level = cell.frame === null ? 'gap' : incidentFrameLevel(cell.frame);
			return { row, from, to, span, cols: cells, liveCount, gapCount, frameCount: frames.length };
		}

		/**
		 * 帧条一格 hover 的说明:它在时间轴上的墙钟时刻、这一格的帧在事故窗口里的序号与耗时、
		 * 以及"点了会怎样"。**不可点的格子要写出原因**(间隙 / 那一列没有真实帧),
		 * 不留一个点了没反应的假按钮。
		 */
		function replayCellTitle(row, cell, nav) {
			const when = incidentWallClock(row, cell.frame === null ? null : cell.frame.t);
			const stamp = when === null ? '' : `${clock(when)} · `;
			if (cell.frame === null) return `${stamp}${translate('replayGapCell')} · ${translate('replayCellCount')} ${cell.count}`;
			return `${stamp}${translate('ctxHistoryFrame')} ${nav.index}/${nav.count} · ${Math.round(cell.ms)}ms · ${translate('replayCellPick')}`;
		}

		/**
		 * 事故里的一条脚本 → 与实时帧脚本**同一种形状**(`url` 从事故的 URL 表里解出来),
		 * 这样 `tallyScripts` 那一套口径(按来源 / 按包 / 交叉表)可以原样吃两边的数据。
		 * `pkg` / `pkgVia` 是**捕获时存下来的**:tallyScripts 看到它们就不再走当前会话的
		 * sourcemap 缓存 —— 刷新之后缓存是空的,现算会把历史事故的包名全变成"未定名"。
		 */
		function incidentScriptOf(row, script) {
			const urls = Array.isArray(row?.urls) ? row.urls : [];
			const index = typeof script?.u === 'number' ? script.u : -1;
			return {
				url: index >= 0 ? (urls[index] ?? '') : '',
				charPos: script?.charPos ?? null,
				ms: script?.ms ?? 0,
				forcedMs: script?.forcedMs ?? 0,
				pauseMs: script?.pauseMs ?? 0,
				invoker: script?.invoker ?? null,
				invokerType: script?.invokerType ?? null,
				pkg: script?.pkg === undefined ? undefined : script.pkg,
				pkgVia: script?.pkgVia,
			};
		}

		/** 一条历史帧的脚本聚合(只有这一帧的 LoAF 里那些脚本)。 */
		function incidentFrameTally(row, frame) {
			const loaf = incidentLoafAt(row, frame);
			if (loaf === null) return null;
			return tallyScripts([{ t: frame.t, scripts: (loaf.scripts ?? []).map((script) => incidentScriptOf(row, script)) }]);
		}

		/**
		 * 事故**窗口**的脚本聚合(整份事故包里的脚本累计)。按事故 id 缓存 —— 每 tick 重算
		 * 几百条脚本会让面板自己变成新的开销(与实时窗口聚合同一个理由)。
		 */
		const incidentTallyCache = { id: null, value: null };
		function incidentWindowTally(row) {
			if (row === null || row === undefined) return null;
			if (incidentTallyCache.id === row.id) return incidentTallyCache.value;
			const loaf = Array.isArray(row.loaf) ? row.loaf : [];
			const value = tallyScripts(loaf.map((entry) => ({ t: entry.t, scripts: (entry.scripts ?? []).map((script) => incidentScriptOf(row, script)) })));
			incidentTallyCache.id = row.id;
			incidentTallyCache.value = value;
			return value;
		}

		/**
		 * **这一帧**的脚本证据行(LoAF 的 scripts[] → 函数名 / 包 / 文件 / 行号)。
		 * 走 `incidentEvidenceAt`:捕获时存下来的定位优先,老包才现算(见它的说明)。
		 * 这一帧没有 LoAF 时返回空数组 —— **不回退**到别的帧,更不回退到实时帧环。
		 */
		function incidentFrameEvidenceRows(row, frame) {
			const loaf = incidentLoafAt(row, frame);
			if (loaf === null || Array.isArray(loaf.scripts) === false) return [];
			return loaf.scripts.map((script) => incidentEvidenceAt(row, script)).sort((a, b) => b.ms - a.ms);
		}

		/** 与这一帧**时间上重叠**的 long task 明细(事故包里存下来的四条腿归因)。 */
		function incidentLongTasksAt(row, frame) {
			if (row === null || frame === null || frame === undefined || Array.isArray(row.longTasks) === false) return [];
			const start = frame.t - (typeof frame.ms === 'number' ? frame.ms : 0);
			return row.longTasks
				.filter((task) => typeof task?.at === 'number' && task.at < frame.t && task.at + (task.ms ?? 0) > start)
				.sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0));
		}

		/** 历史帧详情区的上下文标题:`历史事故 i12 · 历史帧 3/305`(耗时单独用"核心耗时"字号给)。 */
		function incidentFrameHeadingText(row, frame, nav) {
			const id = row === null || row === undefined ? '?' : row.id;
			if (frame === null || frame === undefined) return `${translate('ctxIncident')} ${id} · ${translate('ctxHistoryFrame')}`;
			return `${translate('ctxIncident')} ${id} · ${translate('ctxHistoryFrame')} ${nav.index}/${nav.count}`;
		}

		/** 实时帧详情区的上下文标题:`实时监控 · 当前帧`(耗时同样单独给)。 */
		function liveFrameHeadingText(frame) {
			if (frame === null || frame === undefined) return `${translate('ctxLive')} · ${translate('ctxFrame')}`;
			return `${translate('ctxLive')} · ${translate('ctxFrame')}`;
		}

		/**
		 * 取证明细的**唯一**数据入口:实时与历史事故两个上下文只在这一处分流。
		 *
		 * 为什么要有它:渲染那侧如果各自 `pickedLoaf()` / `selectedIncident().row` 各取一份,
		 * "上面是历史事故、下面是另一条实时帧的编号 / 耗时 / 饼图"就会回来(那正是这次要修的)。
		 * 现在渲染只读这个返回值,而历史那一支的数据只来自 `incident.frames` / `incident.loaf`
		 * —— 拿不到就是 null / 空数组,由渲染照实写缺失。
		 */
		function detailContext() {
			if (diagMode() === 'incident') {
				const row = selectedIncident().row;
				if (row === null) {
					return { kind: 'incident', row: null, frame: null, loaf: null, nav: null, split: null, tallyFrame: null, tallyWindow: null, longTasks: [], evidence: null };
				}
				const frame = selectedIncidentFrame(row);
				const loaf = frame === null ? null : incidentLoafAt(row, frame);
				return {
					kind: 'incident', row, frame, loaf,
					nav: incidentFrameNav(row, frame, state.watch.onlyBad === true),
					split: frameSplit(loaf),
					tallyFrame: frame === null ? null : incidentFrameTally(row, frame),
					tallyWindow: incidentWindowTally(row),
					longTasks: frame === null ? [] : incidentLongTasksAt(row, frame),
					evidence: evidenceScope(),
				};
			}
			const frame = pickedLoaf();
			return {
				kind: 'live', row: null, frame, loaf: frame, nav: null,
				split: frameSplit(frame),
				tallyFrame: framePkgTally(frame),
				tallyWindow: scriptPkgTally(),
				longTasks: [],
				evidence: evidenceScope(),
			};
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
			const byPair = {};
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
					// 事故包里的脚本**带捕获时存下来的 pkg / pkgVia**(incidentScriptOf 把它们传进来):
					// 有就直接用,不再走 packageOfScript —— 那条路依赖当前会话的 sourcemap 分段表与
					// 脚本文本缓存,刷新之后是空的,现算会把历史事故的包名全算成"未定名"
					// (与 incidentEvidenceAt「存下来的优先」是同一条规矩)。
					const resolved = script.pkg !== undefined
						? { pkg: script.pkg, via: script.pkgVia ?? 'stored' }
						: packageOfScript(script.url, script.charPos);
					// "谁"这个名字一份:定得到插件包名就用它,否则用 unresolvedLabel 给的替身
					// (外壳文件名 / 无 URL / 插件批次)—— 交叉表的行与两处汇总共用同一条口径。
					let who = resolved.pkg;
					if (resolved.pkg === null) {
						unresolved += 1;
						unresolvedMs += script.ms ?? 0;
						who = unresolvedLabel(script);
						byOther.set(who, (byOther.get(who) ?? 0) + (script.ms ?? 0));
					} else {
						byPkg.set(resolved.pkg, (byPkg.get(resolved.pkg) ?? 0) + (script.ms ?? 0));
					}
					const pair = `${who}\u0000${label}`;
					byPair[pair] = round1((byPair[pair] ?? 0) + (script.ms ?? 0));
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
				byPair,
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
			// 指纹必须带 `resolveSeq`:脚本按包的结果依赖**异步**到位的 sourcemap 分段表与脚本文本,
			// 少了它,环不再变长时窗口那三行与交叉表会冻在旧的解析状态(见 markResolved 的说明)。
			const stamp = rows.length === 0 ? 'x' : `${rows.length}|${rows[rows.length - 1].t}|${resolveSeq}`;
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

		/** "谁"的两类标签合起来(插件包 + 其余来源),按耗时降序 —— 堆叠条与交叉表都用它。 */
		function whoRows(tally) {
			return [...tally.top, ...(tally.byOther ?? [])].sort((a, b) => b[1] - a[1]);
		}

		/**
		 * 一条 100% 堆叠横条的段:按耗时降序,Top3 + 其余。与环的分工是"环画分几类、条画每类里是谁"。
		 * 段宽按**这一维度的总量**算(不是段之和),所以条本身恒满格;颜色只给名字(渲染侧映射 token),
		 * 名次靠由深到浅的透明度 —— 与环当年的做法一致,读者不用记两套配色。
		 */
		function barSegments(rows) {
			const list = (rows ?? []).filter(([, ms]) => ms > 0);
			const top = list.slice(0, 3);
			const segs = top.map(([name, ms]) => ({ name, ms: round1(ms) }));
			const restMs = round1(list.slice(3).reduce((sum, [, ms]) => sum + ms, 0));
			if (restMs > 0) segs.push({ name: null, ms: restMs });
			return { segs, total: round1(list.reduce((sum, [, ms]) => sum + ms, 0)) };
		}

		/**
		 * 包 × 来源的**交叉表**:两个正交维度只有交叉起来才回答"哪个包的哪类回调在烧时间"
		 * (分开看两张榜单永远答不了)。只展开 Top3 × Top3,其余并进"其余"行/列 —— 面板只有 372px,
		 * 格子给毫秒(单位写在角上),占比放 hover。
		 * "其余"那一行/列是**减法**:该行(列)的总量减去已展开的三格。四块拼起来恒等于脚本总耗时
		 * (`js`),因为两个维度各自都是 js 的分区。
		 */
		/** 交叉表折叠起来时的摘要:最重的那一格(它就是这张表存在的理由)。 */
		function crossSummary(cross) {
			if (cross === null) return translate('crossNone');
			if (cross.top.who === null || cross.top.ms === 0) return translate('crossNoOverlap');
			return `${clipName(short(cross.top.who), CROSS_SUMMARY_NAME_MAX)} · ${clipName(short(cross.top.src), CROSS_SUMMARY_SRC_MAX)} ${Math.round(cross.top.ms)}ms`;
		}

		function crossTable(tally) {
			const who = whoRows(tally).filter(([, ms]) => ms > 0);
			const src = (tally.byInvoker ?? []).filter(([, ms]) => ms > 0);
			if (who.length === 0 || src.length === 0) return null;
			const rows = who.slice(0, 3).map(([name]) => name);
			const cols = src.slice(0, 3).map(([name]) => name);
			const byPair = tally.byPair ?? {};
			const at = (w, s) => byPair[`${w}\u0000${s}`] ?? 0;
			const grid = rows.map((w) => cols.map((s) => round1(at(w, s))));
			const restCol = rows.map((w, r) => round1(Math.max(0, who[r][1] - grid[r].reduce((a, b) => a + b, 0))));
			const restRow = cols.map((s, c) => round1(Math.max(0, src[c][1] - grid.reduce((sum, row) => sum + row[c], 0))));
			const js = round1(tally.js ?? 0);
			const corner = round1(Math.max(0,
				js - rows.reduce((sum, w, r) => sum + who[r][1], 0) - cols.reduce((sum, s, c) => sum + src[c][1], 0)
					+ grid.reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0)));
			let best = { who: null, src: null, ms: 0 };
			rows.forEach((w, r) => cols.forEach((s, c) => { if (grid[r][c] > best.ms) best = { who: w, src: s, ms: grid[r][c] }; }));
			// Top3 之间可能**一格交集都没有**(最大的包住在第 4 名的来源里):这时不能把 top 留成 null,
			// 否则摘要那行拿到 null 去格式化。退回"最大的那一行 × 最大的那一列",并让 ms = 0 说明是空的。
			if (best.who === null) best = { who: rows[0], src: cols[0], ms: 0 };
			return { rows, cols, grid, restCol, restRow, corner, js, top: best };
		}

		/**
		 * 60 秒帧条本体(铺满一行的 SVG,只用 theme token)。
		 * 每格:title 给墙钟时间与这一秒最差帧;**能导航过去的格子才可点**(见 sparkPickMap)。
		 */
		/** 帧条(实时 60 秒 / 事故回放)共用的一组 token:两处必须同一套颜色,否则同一档观感不一致。 */
		const SPARK_COLORS = {
			bad: 'var(--dsw-alias-state-error-primary)',
			warn: 'var(--dsw-alias-state-warn-primary)',
			ok: 'var(--dsw-alias-label-secondary)',
			gap: 'var(--dsw-alias-border-l2)',
		};

		function sparkStrip() {
			const now = performance.now();
			const cells = sparkBars(now);
			const picks = sparkPickMap(now);
			const colors = SPARK_COLORS;
			const bars = [];
			for (let i = 0; i < cells.length; i += 1) {
				const level = sparkLevel(cells[i]);
				if (level === 'empty') continue;
				// 间隙画成最矮的一根:它是"这段时间没在测",不是"这段时间没卡"
				const height = level === 'gap' ? 2 : Math.max(2, Math.min(SPARK_HEIGHT, Math.round((cells[i].ms / SPARK_MAX_MS) * SPARK_HEIGHT)));
				const pick = picks.get(i);
				bars.push(h('rect', {
					key: `s${i}`, x: i, y: SPARK_HEIGHT - height, width: 1, height, fill: colors[level],
					title: sparkCellTitle(cells[i], pick),
					// 点得动就给手型 + 真实行为;点不动就明确不给(不做"点了没反应"的假按钮)
					style: pick === undefined ? undefined : { cursor: 'pointer' },
					onClick: pick === undefined ? undefined : () => { state.watch.pickT = pick.t; bump(); },
				}));
			}
			return h('svg', {
				width: '100%', height: SPARK_HEIGHT, viewBox: `0 0 ${SPARK_SECONDS} ${SPARK_HEIGHT}`, preserveAspectRatio: 'none',
				style: { display: 'block' },
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
			// 历史事故上下文里这一组的东西全换了一份数据(窗口统计 / 历史帧 / 帧内分解 / 证据),
			// 摘要也必须换:折叠着的时候,它就是"现在看的是哪一帧"的唯一线索。
			if (diagMode() === 'incident') {
				const row = selectedIncident().row;
				const frame = row === null ? null : selectedIncidentFrame(row);
				if (row === null || frame === null) return translate('watchNone');
				const nav = incidentFrameNav(row, frame);
				return `${translate('ctxHistoryFrame')} ${nav.index}/${nav.count} · ${Math.round(frame.ms ?? 0)}ms`;
			}
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
			const fresh = hostFreshness();
			const link = linkStats();
			// ⚠️ 折叠态与展开态必须同一个粒度,否则读者会把 p99 当成均值:展开那一行写的是
			// `p50 X · p99 Y · 最大 Z`(hostLoopText),这里也照写分位名(RTT 那一行同理)。
			const host = fresh.state === 'unreachable' ? translate('hostDown')
				: fresh.state === 'unsupported' ? translate('hostUnsupported')
					: fresh.state === 'warming' ? translate('hostWarming')
						: fresh.state === 'stale' ? `${translate('hostStale')} ${Math.max(1, Math.round(fresh.ageMs / 1000))}s`
							: `p99 ${fresh.loop.p99}ms`;
			// 判定(`infraVerdict()`)刻意**不进摘要**:它已经是展开后的第一行(标签 `宿主 event-loop · 判定`),
			// 摘要再说一遍就是同一句话说两遍(§5);而且它最长那句(`链路已排除(宿主与隧道均正常)`,16 字)
			// 会把这一行顶到 43 字符,在 396px 里必然折行 —— 摘要 34 字符的预算容不下它。
			return `${translate('hostShort')} ${host} · ${translate('linkShort')} ${link.count === 0 ? translate('notYet') : `p99 ${link.p99}ms`}`;
		}

		/**
		 * 工具箱摘要:这一组现在只装守夜(事故清单 + 备注 + 导出),摘要就照它写。
		 * ⚠️ 写的是**折叠态独有**的信息(检测到的次数,跨刷新 24h);「抓到 N 次 · 最差 Xms」
		 * 由展开后的第一行 `watchPanelText()` 给 —— 两处说同一句话等于白占一行(§5「能不说就不说」)。
		 */
		function toolsSummary() {
			const detected = tallyWindow(TALLY_MINUTES * TALLY_BUCKET_MS).detected;
			if (state.watch.incidents.length === 0) {
				return `${translate('watch')} ${translate('watchNone')} · 24h ${translate('watchDetected')} ${detected}${translate('times')}`;
			}
			return `${translate('watch')} ${state.watch.incidents.length}${translate('times')} · 24h ${translate('watchDetected')} ${detected}${translate('times')}`;
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

		/**
		 * 「最差事件」块底下/悬停的那一句话:这条事故是什么、什么时候、带没带备注。
		 * ⚠️ 它跟的是**选中的那条**(selectedIncident),不是硬编码 incidents[0] —— 用户在清单里
		 * 切了一条之后,面板上三处必须说同一条事故,否则"选中的"和"摘要说的"会打架。
		 */
		function watchSelectedText() {
			const row = selectedIncident().row;
			if (row === null) return null;
			const at = Date.parse(row.at);
			return `${row.id} · ${row.cause} · ${Math.round(row.severity)}ms` +
				(Number.isFinite(at) ? ` · ${clock(at)}` : '') +
				(row.note === null || row.note === undefined ? '' : ` · ${row.note}`);
		}

		/**
		 * 「最差事件」块底下那一行:只在**还有话要说**的时候出现。
		 * 「抓到几次 / 最差多少 / 还没抓到 / 未开录」上面那一行已经说过,再说一遍就是同一句话
		 * 说两遍(§5 那条规矩);真正需要说出口的是三个状态位:读回 / 裁掉 / 落盘失败。
		 */
		function watchFlagText() {
			const watch = state.watch;
			// 上面那行已经写了「未开录」/「还没抓到(≥100ms)」,这里不重复
			if (watch.on === false) return null;
			if (watch.incidents.length === 0) return null;
			const flags = [];
			if (watch.restored > 0) flags.push(`${translate('watchRestored')} ${watch.restored}`);
			if (watch.trimmedByBytes > 0) flags.push(`${translate('watchTrimmed')} ${watch.trimmedByBytes}`);
			if (watch.persistError !== null) flags.push(`⚠️ ${translate('watchPersistFailed')}`);
			return flags.length === 0 ? null : `${translate('watch')} · ${flags.join(' · ')}`;
		}

		/**
		 * 「最差事件」块那一行的**值**:未开录 / 还没抓到(带阈值)/ 严重度(文字 + 数字)。
		 * 阈值写在这里而不是另起一行 —— 「还没抓到」+「还没抓到(≥100ms)」两行是同一句话。
		 */
		function eventValueText(row) {
			if (state.watch.on === false) return translate('watchOff');
			if (row === null || row === undefined) return `${translate('watchNone')}(≥${WATCH_TRIGGER_MS}ms)`;
			return `${severityText(severityLevel(row.severity))} ${Math.round(row.severity)}ms`;
		}

		/**
		 * 工具箱里的一条事故:`1. i7 · frame · 326ms · 14:48 · 读回`。
		 * 被选中的那条前面加 `● ` —— 清单排序是**按严重度**的,不标出来读者会以为"第一条就是最近那条"。
		 */
		function watchRowText(row, index) {
			const at = Date.parse(row.at);
			const marker = state.watch.selId === row.id ? '● ' : '';
			return `${marker}${index + 1}. ${row.id} · ${row.cause} · ${Math.round(row.severity)}ms` +
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
				// 事故选中上下文:选中的那条被更差的新事故挤出留存清单时会**自动退回**,指纹不带它
				// 面板就会一直显示旧的「已选中」(而 selectedIncident 已经换了一条)
				state.watch.incidents.length, state.watch.selId ?? 'x', state.copyNote ?? 'x', state.pickNote ?? 'x',
				state.causeOpen ? 1 : 0, state.packPreviewId ?? 'x',
				// 诊断上下文(实时 / 历史事故 / 事故里的哪一帧):切上下文是用户动作,必须立刻重绘,
				// 所以它也在指纹里(否则切了模式面板可能停在旧的那一支,直到别的数字变化)
				state.watch.mode, state.watch.frameT ?? 'x', state.watch.scope,
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

		/** 折叠选择落盘(尽力而为:记不住就本次会话有效)。 */
		function saveGroups() {
			try { localStorage.setItem(LS_GROUPS, JSON.stringify(state.groups)); } catch (error) { /* 记不住就本次会话有效 */ }
		}

		/** 折叠/展开一个分组,并把选择记住。 */
		function toggleGroup(key) {
			if (Object.hasOwn(state.groups, key) === false) return;
			state.groups[key] = state.groups[key] !== true;
			saveGroups();
			bump();
		}

		/**
		 * 「全部折叠」:把取证/工具那几个组收起来,回到首屏。
		 * 与「恢复默认布局」的区别:它**不动**用户的两个上下文选择(翻帧钉住、事故选中)。
		 */
		function collapseAll() {
			for (const key of Object.keys(state.groups)) state.groups[key] = false;
			saveGroups();
			bump();
		}

		/** 还有组开着吗(没有的话「全部折叠」就是个点了没反应的按钮)。 */
		function anyGroupOpen() {
			for (const key of Object.keys(state.groups)) if (state.groups[key] === true) return true;
			return false;
		}

		/**
		 * 「现在的布局/上下文与默认值不一样吗」—— 界面据此决定要不要露出「恢复默认布局」。
		 * 默认布局下这个按钮本身没有意义,常驻只会让首屏多一个"点了也没变化"的动作。
		 */
		function layoutDirty() {
			if (anyGroupOpen()) return true;
			if (state.watch.mode === 'incident') return true;
			if (state.watch.onlyBad === true) return true;
			if (state.watch.frameT !== null) return true;
			if (state.watch.pickT !== null) return true;
			if (state.watch.selId !== null) return true;
			if (state.watch.scope !== 'worst') return true;
			if (state.copyNote !== null || state.pickNote !== null) return true;
			return false;
		}

		/**
		 * 「恢复默认布局」:回到干净的首屏 —— 组全收起(这是默认值),翻帧回自动,事故选中回自动。
		 * 面板可能被记成"全部展开"(展开状态是落盘的),这一条就是把它拉回来的一键。
		 */
		function resetLayout() {
			for (const key of Object.keys(state.groups)) state.groups[key] = false;
			state.watch.pickT = null;
			state.watch.selId = null;
			state.watch.scope = 'worst';
			// 诊断上下文也是"布局/上下文"的一部分:回到默认=回到实时那一支、历史帧退回自动
			state.watch.mode = 'live';
			state.watch.frameT = null;
			state.watch.onlyBad = false;
			// 两个"一次性说明"也清掉:布局都回到默认了,还挂着一句"帧环里没有…"只会让人以为又出错了
			state.copyNote = null;
			state.pickNote = null;
			saveGroups();
			saveWatchUI();
			bump();
		}

		/**
		 * 一个可折叠分组:收起时头部**必须**带一句话摘要 —— 收起不等于丢信息,
		 * 而是把"过程/取证"这类不常看的行换成一行结论。
		 *
		 * ⚠️ **children 是"先求值再传参"的**:以前写成 `...children` 时,组折叠着,调用方那一串
		 * IIFE(脚本按包 / 交叉表 / 帧条)照样每个渲染 tick 跑一遍 —— 「取证明细」里最贵的那几块
		 * 全是"算了但不显示"。所以现在支持传**一个函数**:折叠时连函数体都不进(见 AGENTS §5
		 * 关于"折叠组默认不做昂贵分析,由 group() 的 thunk 保证"那条)。
		 */
		function group(key, label, summary, ...children) {
			const isOpen = state.groups[key] === true;
			// 惰性:唯一一个 child 且是函数 → 只有展开那一刻才调用它拿子节点
			const build = children.length === 1 && typeof children[0] === 'function' ? children[0] : null;
			return h('div', { style: S.sep },
				h('div', {
					style: { ...S.row, cursor: 'pointer' },
					title: isOpen ? translate('collapse') : translate('expand'),
					onClick: () => toggleGroup(key),
				},
					h('span', { style: S.label }, `${isOpen ? '▾' : '▸'} ${label}`),
					h('span', { style: S.num }, summary)),
				isOpen ? h('div', null, build === null ? children : build()) : null);
		}

		/** 精确归因开关:开启时立刻把已经见过的多包 URL 排队解析。 */
		function setPrecise(on) {
			state.precise = on === true;
			try { localStorage.setItem(LS_PRECISE, state.precise ? '1' : '0'); } catch (error) { /* 记不住就本次会话有效 */ }
			if (state.precise) primeBundleMaps();
			dirty = true;
			// 精确归因开关本身会改变"定名"的结果,窗口聚合的缓存要跟着失效(markResolved 的说明)
			markResolved();
			bump();
		}

		// ───────────────────────────────── 文案 ─────────────────────────────────
		const DICT = {
			zh: {
				title: '性能 HUD', shortcutToggle: '展开或收起性能 HUD', off: '已关', turnOn: '开启', turnOff: '关闭',
				frameWorst: '最差帧', blame: '回调归因(耗时·下界)',
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
				scope60s: '近 60 秒',
				overviewFrame: '帧', overviewBlame: '最差那条', worstSecondShort: '最差秒', hostShort: '宿主',
				deepShort: '深录', deepHint: '深录(= 插桩 + 精确归因):装上调度点与 DOM 写入的包装,并拉那份 12MB 的 sourcemap。默认关着 —— 守夜与现场都不插桩',
				recorder: '记录器自身', recorderHint: '每帧给这个 HUD 自己的 rAF 回调计时:测量工具必须自证没有明显改变被测对象。p99 取最近 600 帧',
				split: '帧里花在哪', splitTotal: '这段长动画帧共', splitWorst: '最差那条',
				framePick: '帧', framePinned: '已钉住(点 ⟲ 回到自动)', framePickAuto: '自动:跟着最差那条走',
				frameAutoHint: '回到自动(跟着最差那条走)',
				framePickHint: '最近 200 条长动画帧里**值得回看的那些**(帧时长 ≥ 100ms,与守夜触发线同一条;排序也按它,blocking 只作补充),最差的在前。◀ ▶ 换一条,⟲ 回到自动;选中的那条被挤出 200 条之后会自动退回。一条都不到线时这里退回显示全部',
				framePickFiltered: '值得回看的帧',
				spark: '60 秒帧条',
				sparkHint: '最近 60 秒,一格一秒:高度 = 那一秒里最差那一帧的间隔,颜色与导出件的 ASCII 帧条带用同一组阈值(≥100ms 红 / ≥50ms 黄 / 其余正常)。整格都是 rAF 挂起的那一秒画成最矮的灰柱 —— 那是间隙,不是卡顿;空白 = 那一秒没采到',
				pkgHint: '**本帧**(上面那张环的同一帧)里脚本耗时按包汇总(与事故包 incident.packages 同一条 resolve 路:单包 URL 直接读出来,合并批按 sourcemap 分段还原)。合并批里没开「精确」就只能给到那个 58 包的批 URL,这是刻意的,不硬猜',
				pkgWindowHint: '最近这段 LoAF **窗口**(不是上面那一帧)的同一份按包汇总:它是**累计**,分母写在小标题上;拿它和「本帧」比之前先看平均每帧',
				pkgStoredHint: '事故包里**这一帧**的脚本耗时按包汇总:包名是**捕获时存下来的**(跨会话读回仍在),不再走当前会话的 sourcemap 缓存 —— 所以刷新之后这里也不会变成"未定名"',
				incidentWindowScopeHint: '下面是这条事故**整份包**里的脚本累计(与 `incident.loaf` 同一份数据,不是某一帧):它是**累计**,分母写在本行;拿它和上面「历史帧」那一行比之前,先看平均每帧',
				pkgIncidentWindowHint: '这条事故**窗口**的脚本按包汇总(整份事故包的累计,不是某一帧);分母同样在本行小标题上',
				barCopyHint: '点这一行 → 复制「名字 + 毫秒」', copyName: '名称',
				forcedLayout: '强制样式布局', forcedShort: '强制',
				forcedHint: 'LoAF 的 forcedStyleAndLayoutDuration:读布局 / 写样式逼出来的同步布局。它**已经算在**脚本耗时里,来源却是样式而不是业务逻辑 —— 分不清"这块是 JS 慢还是样式慢"时看这一行。这一行是**窗口**聚合',
				splitScript: '脚本', splitTask: '任务', splitRender: '渲染', splitTail: '样式+布局+绘制',
				splitJs: '脚本细拆', jsExec: '纯执行', jsPause: '暂停', scopeFrame: '本帧',
				bySource: '按来源', byPkg: '按包', pkgZeroNamed: '0 条定到名', scriptsUnit: '条脚本', needDeep: '要深录', invokerUnknown: '来源未记录',
				srcNoUrl: '无 URL(内联脚本)', srcBatch: '插件批次(未按 sourcemap 拆)',
				crossIncidentHint: '范围:这条事故**整份包**里的脚本(与上面「·窗口」那两行同一份数据)。两个维度分开看是两张榜单,**交叉**起来才回答"哪个包的哪类回调在烧时间";只展开 Top3 × Top3,其余并进"其余"行/列(减法补足),四块拼起来 = 事故窗口的脚本总耗时;格内是毫秒,把鼠标放上去看占比。',
				crossTable: '包 × 来源 · 窗口', crossCorner: '包 \\ 来源', crossNoOverlap: 'Top3 之间没有交集', crossFailed: '交叉表算不出来', splitFailed: '这一帧的脚本拆解算不出来', crossUnit: '格内毫秒', crossBiggest: '最重', crossNone: '没有可交叉的脚本', crossHint: '范围:**窗口**(最近 200 条长动画帧的**累计**,与上面那两行「·窗口」是同一份数据,不是某一帧)。两个维度分开看是两张榜单,**交叉**起来才回答"哪个包的哪类回调在烧时间"。只展开 Top3 × Top3,其余并进"其余"行/列(减法补足),四块拼起来 = 脚本总耗时;格内是毫秒,把鼠标放上去看占比。', barShareHint: '最大那一段占这条的多少',
				windowScope: '窗口', loafRows: '条长动画帧', spanOver: '跨', avgPerFrame: '平均每帧脚本',
				maxLabel: '最大', sparkGap: '整格 rAF 挂起(间隙,不是卡顿)', sparkNoPick: '这一秒没有长动画帧,点不动', sparkPickHint: '点它 → 翻帧切到这一秒的长动画帧',
				pickNone: '这条事故包里没有帧记录(老包或捕获时没采到):只能看窗口统计,不能逐帧回看',
				// ── 诊断上下文(实时 / 历史事故 / 历史帧):两个上下文各自写明自己是哪一个 ──
				ctxLive: '实时监控', ctxFrame: '当前帧', ctxIncident: '历史事故', ctxHistoryFrame: '历史帧',
				backToLive: '回到实时', backToLiveHint: '回到实时帧上下文(实时采集数据与历史那一侧的选中都不动)',
				historyHint: '切到历史事故上下文:取证明细整块换成这条事故的窗口、历史帧、帧内分解与证据',
				frameNavHint: '历史帧按**时间**翻(帧条从左到右就是这个顺序);「只看异常」开着时,步长落在帧间隔 ≥ 守夜触发线的那些帧上',
				frameNavPrev: '上一帧', frameNavNext: '下一帧',
				onlyBad: '只看异常', onlyBadHint: '把「上一帧 / 下一帧」的步长限制在异常帧上(帧间隔 ≥100ms,即守夜触发线);再点一次取消。它只是导航过滤器:不动选中的帧,也不动采集',
				techFrameNone: '这一帧没有长动画帧记录(只存了帧间隔):没有帧内分解,与窗口内的 long task 也不重叠 —— 不拿别的帧顶上',
				techFrameNoneShort: '这一帧没有记录',
				techNoneHint: '为什么没有:长动画帧(LoAF)只上报 ≥50ms 的那些,这一帧没被上报;它的帧间隔仍然留在上面的时间轴上',
				frameEvidenceMissing: '这一帧没有脚本记录:下面给的是事故窗口内的切片,不是这一帧的',
				frameLtTitle: '与这一帧重叠的 Long Task', frameLtNone: '这一帧与窗口内的 long task 都不重叠',
				frameLtWindow: '窗口内 long task',
				replayTimeline: '历史帧时间轴', replayCellPick: '点它 → 选中这一帧', replayCellCount: '这一格',
				replayGapCell: '这段时间没有帧记录(rAF 被挂起或采样缺失)',
				replayTimelineHint: '横轴按**时间**放:一格可能有多帧(取最差的那一帧),点击选中**真实存在的那一帧**;整段 rAF 被挂起的地方留白 —— 那是"没在测",不是"没卡",不补桩。',
				verdictLabel: '归因状态', verdictConfirmed: '已确认', verdictSuspected: '可疑', verdictUnattributed: '未归因',
				verdictConfirmedText: '该帧有直接测量到的 JS 阻塞证据(longtask / LoAF 与它重叠),窗口内主要归属',
				verdictNotRootCause: '这只缩小到"哪个包",不等于已定位根因',
				verdictSuspectedJsNoPkg: '有 JS 阻塞证据,但窗口里的脚本没能定到包名 —— 要深录(精确归因)才能再缩小',
				verdictThrottleText: '没有观察到足以解释该帧的 JS 阻塞,而它又明显长于前后帧:更像 rAF 被挂起或浏览器节流,需结合前后帧与时间间隙确认',
				verdictNeighbours: '前后帧中位',
				verdictUnattributedText: '未观察到足以解释该帧的 JS 阻塞证据;请结合前后帧和时间间隙检查 rAF 挂起或浏览器节流',
				handoffFrameNoEvidence: '这一帧在事故包里没有脚本记录(只有帧间隔)',
				// 证据 → 代码:把「事故 → 帧 → 来源 → 包 → 文件:行」落到个体脚本上。
				// 直接测量 / 归因推断 / 尚无法确认三者在这几句里分开写。
				evidenceLabel: '可疑脚本', evidenceScopeIncident: '事故', evidenceWindowPrefix: '窗口内',
				evidenceHint: '把「事故 → 帧 → 来源 → 包 → 文件:行」落到个体脚本上:上面那几块给的是"时间花在哪个包 / 哪类调用"(排行),这一块给的是"打开哪个文件、哪个函数"(定位)。**历史事故上下文**里优先给选中那一帧自己的脚本(捕获时存下来的,跨会话读回仍在);这一帧没有记录时才退回**事故窗口内**的切片,并在行上写明范围。**实时上下文**里给当前实时帧的脚本。LoAF 只上报 >5ms 的脚本,所以这一层是**下界**。',
				evidenceHoverHint: '悬停看口径与缺口',
				evidenceCopyHint: '点这一行复制「函数 @ 包 · 文件:行 · 耗时 · 来源」',
				evidenceWhere: '位置', evidenceInvoker: '来源', copyScript: '脚本',
				evidenceBundleLine: '合并脚本行',
				replay: '事故回放', replayGaps: 'rAF 挂起',
				replayFailed: '事故回放算不出来',
				replayHint: '这块是**捕获时存下来的窗口**(来自事故包,所以刷新生效),不是实时那条 60 秒帧环:横轴按**时间**放,一格可能有多帧(取最差的那一帧),点击选中的一定是 `incident.frames` 里**真实存在**的那一帧;整段 rAF 被挂起的地方留白(那是“没在测”,不是“没卡”,不补桩)。帧间隔与 LoAF 都是直接测量。⚠️ LoAF 不给每帧内脚本的起止时间,所以这里**不排帧内执行顺序**;要看逐帧明细请「导出事故包」+ tools/inspect-incident.mjs。',
				replayScopeNote: '口径:帧间隔 / 分位 / 最差帧都来自捕获时那 13 秒的切片,不是实时读数,也不代表现在的状况;缺口 = 那段时间 rAF 被挂起。',
				evidenceFailed: '可疑脚本这一段算不出来',
				fnUnknown: '函数名未记录', pkgUnresolvedShort: '包未定名', fileUnresolved: '文件未定名',
				pkgNamed: '定到包',
				viaDirect: '直接读出来', viaInferred: '分段推断', viaNotPlugin: '不是插件脚本', viaFailed: '解析失败', viaNotFetched: '还没预取(只有深录才拉脚本文本)', viaUnavailable: '还没到位/拿不到',
				// 交接件(复制摘要)里那两行:措辞要能让**没看过面板的人**直接用
				handoffInteractions: '窗口内 ≥100ms 的交互', handoffInteractionsScope: '(端到端时长,不是帧内拆分)',
				evidenceCaliberPlain: '口径:函数名与毫秒由 LoAF 直接测量;包 / 文件 / 行号由 URL 与 sourcemap 分段推断(pkg= / line= 是原始 via 码);行号是脚本文件自己的行,不是原始源码行 —— 合并批里它是合并后大文件的行,所以只给文件 + 「合并脚本行 N」,不拼成 文件:行。',
				evidenceMissingPlain: '缺:原始源码行号与调用栈(要解 section 内层 mappings 或录 Chrome trace);交互只有端到端时长,没有输入延迟/处理/呈现的拆分。',
				hourUnit: '小时', minUnit: '分', secUnit: '秒',
				windowScopeHint: '下面三行是**累计**:最近 200 条**长动画帧**(LoAF 只报 >50ms 的帧)的脚本耗时加总,不是某一帧的时长 —— 200 条各百来毫秒,累计就是二十几秒。**只有"平均每条脚本"那一栏和上面那张饼可比**(饼是单帧);条数与跨度顺带回答"这段时间卡了多少次"。跨度越久,累计越大,别拿它当"越来越慢"',
				invokerHint: 'LoAF 的 scripts[].invoker:这条脚本是**谁调起来的** —— setTimeout / rAF、某个事件处理器(实测最多的是 `DOMWebSocket.onmessage`,即会话事件流)、Promise 回调、脚本加载。它与「按包」是同一份脚本耗时的两种切法:按来源覆盖全部脚本,按包只覆盖定得到包名的那部分(所以合计不相等是正常的,总数看上面的脚本耗时)。⚠️ 它只回答"哪一类调用",不回答"函数里面慢在哪" —— 函数级要 Chrome trace,页面内没有采样器',
				splitJsHint: '脚本自身的三分:纯执行 / 强制样式布局(读布局、写样式逼出来的同步布局)/ 暂停(同步 XHR、对话框把它卡住的时间)。三者都是 scripts[].duration 的分区内,**相加 = 脚本耗时**,不是另加的。这一行是上面那张饼的**同一帧**',
				splitNoLoaf: '暂时没有(要等到一条 >50ms 的长动画帧;LoAF 只报 50ms 以上的)',
				splitHint: 'LoAF 的三个时间点能拆出来的极限。环上最多 7 段:脚本那一段再按**调用来源**(invoker,与下面「本帧按来源」同一个顺序)切成最多 4 块 —— 同一族的红、由深到浅;任务里没归到脚本的那部分是**灰的**;再往后是渲染(rAF 回调)与样式+布局+绘制。段与段之间留了 1.4px 缝(同一族的红靠缝才看得出是几块),小段扣不起缝就不扣。**绘制与合成分不开**,所以最后一段是"剩下的都在这儿",别读成"样式布局占了多少";要分开只能录 Chrome trace',
				worstOne: '最差那条',
				unexplained: '该帧几乎无 JS 解释', unexplainedHint: '样式/布局/绘制/vsync;可用 Rendering 面板的 Paint flashing 交叉验证',
				verdict: '判定', linkShort: 'RTT', suspectSuffix: ' 存疑', cleared: '链路已排除(宿主与隧道均正常)',
				groupDetail: '取证明细', groupTech: '技术细节', groupDom: 'DOM 与堆', groupHost: '宿主与链路', groupTools: '工具箱', nodesSuffix: ' 节点',
				stream: '状态', running: '流式', idle: '空闲', idleBase: '空闲基线(60s)', idleWriter: '空闲也在加节点的是',
				notYet: '未采集', hostLoop: '宿主 event-loop',
				hostDown: '宿主不可用', hostUnsupported: '宿主未采到', hostWarming: '等宿主样本', hostUnknown: '宿主数据不足', hostStale: '已过期', link: '链路 RTT',
				hostEvents: '宿主事件到达', hostEventsHint: '宿主半用公开接口 ctx.on(\'session/event\') 记每条事件「提交(event.time)→到达监听器」的延迟;第一版想包 Context.emit,线上实测根本抓不到(该事件走带作用域过滤的派发),故改口径且写明',
				notInstalled: '未安装', waiting: '已装,等事件',
				sampling: '吞吐采样中', failed: '吞吐失败',
				renderError: '面板渲染出错', retry: '重试',
				renderErrorHint: '采集没停:上面是错误原文;点「重试」恢复面板,或直接导出(errors 段里也有)',
				linkHint: '每 10 秒一次 1KB 同源探测(带 cache-buster)算 RTT,n 是最近 60 秒的样本数;吞吐每 60 秒一次 64KB(启动后 3 秒先补一次)。p99 > 300ms 且 FPS 正常且 n≥2 才判「疑似链路」',
				suspect: '疑似链路',
				stressFromDom: 'DOM 写入',
				via: '通道', viaRemote: 'ctx.remote(客户端 remote)', viaRoute: '宿主路由 /api/dsh-perf-hud/host',
				unattrShort: '未归因', markPlaceholder: '备注(可选)',
				// 守夜层(默认常开、不插桩):面板上只露一行状态 + 工具箱里的清单与两个按钮
				watch: '守夜', watchCaught: '抓到', watchWorst: '最差', watchRestored: '读回',
				watchDetected: '检测', watchKept: '已保存现场', watchLost: '丢失', tallyUnit: ' 份',
				tallyCoalesced: '同串触发', tallyCoalescedHint: '同一串卡顿里被并掉的触发数(密度,不是次数)',
				// 可能原因(候选假设)与诊断包:线索强度 / 出处三档 / 包的固定形态
				causeScriptLead: '脚本耗时最高的包', causeLongTaskLead: '长任务归属', causeHostLead: '宿主事件循环', causeNoEvidenceLead: '缺少 JS 阻塞证据',
				causeUnresolvedSuffix: '没定到包名', causeHostBasis: '事故前后的宿主事件循环', causeLongTaskLimit: '四条腿只覆盖三次调度的回调与 DOM 写入,事件处理器 / Promise / 微任务不在内(所以这是下界)',
				hostSnapshotNotInstant: '这份宿主快照每 10 秒采一次,未必覆盖卡顿瞬间',
				strengthStrong: '线索较强', strengthMedium: '线索中等', strengthWeak: '线索较弱', strengthNone: '证据不足',
				provenanceMeasured: '直接测量', provenanceInferred: '归因推断', provenanceUnknown: '无法确认',
				packSummaryTitle: '# 性能事故诊断摘要', packSecSummary: '## 1. 摘要', integrityIncomplete: '现场不完整',
				packSecCandidates: '## 2. 最可能的假设(最多 3 条,每条都带支持与限制)', packSecMissing: '## 3. 缺失的证据',
				packSecNext: '## 4. 下一步验证', packSecMeta: '## 5. 元信息',
				packCauseLabel: '假设', packSupport: '支持', packLimits: '限制', packProvenance: '出处', packTier: '采集档位',
				packNoCandidate: '没有足够证据给出候选原因 —— 见下面的缺失与下一步。',
				packPreviewNote: '导出前先看这份清单:包在本机生成,不上传任何内容;要交给 AI 请你自己主动发出去。',
				packReadmeTitle: '# 这份诊断包里有什么',
				packReadmeWhat: 'manifest.json 是入口(格式版本、平台、采集档位、能力矩阵、脱敏说明);summary.md 是给人读的摘要;incident.json 是结构化原始证据;README.md 就是你正在读的这份。',
				packReadmeHow: '先读 summary.md 的「最可能的假设」:每一条都带支持证据与限制,以及出处(直接测量 / 归因推断 / 无法确认)。「缺失的证据」说明这一层为什么没采到 —— 不要把「没有证据」读成「没有发生」。',
				packReadmePrivacy: '包内不含聊天正文、提示词、Cookie、Token 与请求头(不是筛掉了,是本来就没采);页面地址只保留 origin + path,用户目录降级成 ~,UA 只留主版本与系统。这是减法,不是匿名化。',
				packReadmeNotes: '在别的工具里读 incident.json 时:帧的 t 是页面时间轴毫秒,要靠 incident.env.perfOrigin 换成墙钟;loaf 与 frames 是同一信号的两个视图,别相加;blocking 可以是 0 而这一帧仍然很重。',
				// ── 视图模型(方案 1:主界面 / 卡顿详情 / 开发者详情 / 设置)──
				viewDev: '开发者详情', viewSettings: '设置', back: '←',
				// ⚠️ 这一组是补上来的:上一轮它们**只被引用、没进词典**,面板上直接印出了 key 名
				// (viewIncident / packFilesLabel / storageKeys …)。新加的"引用的键必须在词典里"那条断言
				// 专门挡这一类 —— 死键断言管不到它。
				viewIncident: '卡顿详情', backHint: '回到主界面(那一屏只回答五个问题)',
				packFilesLabel: '诊断包内容', packFilesHint: '给 AI 的那条:格式说明 + 摘要 + 原始证据 + 怎么读',
				packFilesValue: 'manifest.json · summary.md · incident.json · README.md',
				storageKeys: 'localStorage:dsh-perf-hud:ring / tally / incidents / watchui / view / sessions / marks / groups / on / collapsed / deep / precise / map / map:index',
				storageKeysHint: '清状态时按需删;on / deep / precise 就是采集档位(守夜 / 深录 / 精确归因),这三个会改变面板贵不贵;map 是那份 12MB sourcemap 的分段表缓存(按 rev 存)',
				// 本轮:原因说人话(包名收进展开区)、两条导出路径、分享前预览
				causePlainScript: '某个脚本模块的耗时偏高', causePlainLongTask: '这一段时间里有较重的渲染任务',
				causePlainHost: '宿主进程那侧偏忙', causePlainUnknown: '缺少能解释这次停顿的 JS 证据',
				causeWhy: '为什么这样判断?', causeWhyHide: '收起',
				causeWhyHint: '展开看原始包名、毫秒与支持 / 限制;也可以去「开发者详情」',
				causeRawNote: '以下是原始证据(包名 / 毫秒 / 出处),平时不用看',
				exportAiBtn: '导出诊断包(给 AI:脱敏、不含备注)', exportFullBtn: '完整技术导出(保留备注)',
				exportAiHint: '给 AI 的那条:自由文本置空并标 noteDropped、页面地址只留 origin+path、用户目录换成 ~、UA 只留主版本',
				exportFullHint: '本机调试件:与上面同源,但保留你手敲的备注 —— 它不是脱敏件,别直接交出去',
				previewTitle: '导出预览(还没生成文件)', previewFiles: '文件',
				previewNotesDropped: '备注:已置空(标 noteDropped)', previewNotesKept: '备注:保留(本机调试件)',
				previewExcludes: '本包不含', previewZip: '一个 zip 一次下载:', previewZipHint: '(含上面四个文件)',
				previewGo: '生成并导出', previewCancel: '取消', exportPreviewCopy: '复制导出预览',
				hudOff: 'HUD 已关闭', loafOff: 'LoAF 未装上',
				healthOk: '运行流畅', healthStall: '刚才有卡顿', healthLimited: '监测受限',
				healthHint: '看的是最近 60 秒:帧间隔与长动画帧的档位(与面板判色同一套阈值)',
				mainStatus: '当前状态', mainLast: '最近一次卡顿', mainCause: '可能原因',
				mainTrend1: '最近 1 小时', mainTrend24: '最近 24 小时',
				trendSwitchHint: '在这两个窗口之间切换(计数跨刷新保存)', trendHint: '检测到几次 / 最长一次 / 重复线索 —— 三个数各有各的口径',
				trendScope: '计数是"检测到几次卡顿"(同一串算一次);重复线索只数留存下来的现场,所以它不会比实际更严重',
				noStallYet: '暂未记录到明显卡顿,仍在后台观察。', noCauseYet: '还没有抓到事故,先让它继续观察。',
				trendNone: '这段时间没有检测到卡顿', trendRepeat: '重复线索', stallSuffix: '卡顿',
				trendRepeatPlain: '同一个脚本模块',
				viewThisStall: '查看这次卡顿', exportReport: '导出诊断报告',
				devEntry: '开发者详情(技术数据)', devEntryHint: '帧 / 脚本 / DOM / 宿主 / 链路 / 原始数据 —— 现有能力一个都没删,只是收进这里',
				settingsHint: '记录模式、数据保留、隐私与脱敏',
				stallSaved: '现场已自动保存', stallNotSaved: '现场未完整保存', secondsUnit: ' 秒',
				devTabFrames: '帧与归因', devTabDom: 'DOM 与堆', devTabHost: '宿主与链路', devTabTools: '工具箱', devTabRaw: '原始数据',
				devTabFramesHint: '概览 / 最差事件 / 回调归因 / 取证明细(帧条、时间轴、脚本拆解、交叉表)',
				devTabDomHint: 'DOM 节点、容器增长、JS 堆、写入者(深录时)',
				devTabHostHint: '宿主 event-loop、宿主事件到达、空闲基线、链路 RTT 与吞吐',
				devTabToolsHint: '事故清单 / 手动标记 / 隔离实验与清空读数',
				devTabRawHint: '整机 JSON、事故包、诊断包预览与存储键位',
				settingsMode: '记录模式', settingsRetain: '数据保留', settingsPrivacy: '隐私与脱敏',
				modeWatch: '守夜(默认常开、零插桩)', modeDeep: '深录(装插桩 + 精确归因,有代价)',
				modeHint: '守夜与现场是同一档采集,只差面板收放;深录才会包装 setTimeout / DOM 写入并拉那份 sourcemap',
				modeHintShort: '守夜默认常开且不插桩;深录要你显式打开,面板会跟着变贵',
				retainText: '留存取两档并集:全局最差 10 次 + 每天最差 1 条(最多最近 7 天),另有 2MB 落盘上限 —— 超了就裁最弱的,并在"裁掉"里照实计数',
				clearIncidentsBtn: '清空事故现场', clearIncidentsHint: '只清事故(证据),不动发生频次:清掉的是证据,不是事实',
				clearHint: '清空当前读数(帧环、长表、归因表);事故现场与发生频次都不动',
				privacyText: '所有数据都在本机采集与保存,默认不上传任何内容。导出件在你本机生成,交给谁是你的动作。',
				privacyRedaction: '导出前会先做减法:页面地址只留 origin + path(查询串整段丢弃)、用户目录换成 ~、UA 只留主版本;包内写明脱了什么、留了什么、本来就没采什么。这是减法,不是匿名化。',
				privacyRedactionHint: '还有两处默认不导出:你手敲的备注(AI 诊断包里置空并标 noteDropped);聊天正文 / 提示词 / Cookie / Token / 请求头 —— 那些本插件从不读取',
				tallyScopeSuffix: '内,同一串卡顿算一次', tallyKeepHint: '受容量限制,不等于检测到', tallyWorst: '最长一次',
				watchDaily: '当天最差',
				watchNone: '还没抓到', watchOff: '未开录', watchPersistFailed: '落盘失败', watchTrimmed: '裁掉',
				watchHint: '默认常开、不插桩:一个 rAF 循环 + 一个 LoAF 观察器。帧间隔(或 LoAF 的 blockingDuration)超过 100ms 就自动抓「前 10 秒 + 后 3 秒」原样切片,留存取**两档并集**:全局最差 10 次 + 每天最差 1 条(最多最近 7 天,清单里标「当天最差」),刷新后还在;落盘另有 2MB 上限,超了就裁掉最弱的并在这一行标出「裁掉 N」。要抓偶发卡顿就让它一直开着 —— 出事后用「导出最近一次」把证据包交给分析者。',
				watchMark: '标记刚才', watchMarkHint: '手动记一次「刚刚卡了一下」:自动回退 3 秒(人的反应时间),立刻切片,并把上面输入框的备注原样写进证据包',
				watchExport: '导出最近一次', watchExportHint: '下载**时刻最新**那一条的完整证据包(帧序列 + LoAF + 窗口内 longtask + 环境与缺失声明;不是最差那条)。要别的:__perfHud.exportIncident(\'i55\') 按 id、或 exportIncident(0) 取最差的',
				watchManualNote: '手动标记',
				// 最差事件入口(P0/P1):严重度用**文字 + token 颜色**两样一起给,不只靠颜色
				worstEvent: '最差事件', worstEventHint: '守夜留下的最差那条(按严重度排,不是按时间)。默认自动跟它;在工具箱的清单里点一条就切过去,「恢复默认布局」可回到自动。',
				sevLabel: '严重度', sevBad: '严重', sevWarn: '警告', sevOk: '低于线',
				sevBadHint: '≥200ms 记为「严重」:与面板判色的红档同一条线;≥100ms(守夜触发线)记为「警告」',
				jsEvidence: 'JS 证据', jsYes: '有(longtask/LoAF 与它重叠)', jsNo: '无(longtask/LoAF 都不与它重叠)',
				evOwner: '主要归属', evWindow: '窗口', framesUnit: ' 帧', evAutoWorst: '自动·最差', evAutoLatest: '自动·最近', evPinned: '已选中',
				evWorst: '最差', evLatest: '最近',
				evScopeHint: '「自动」跟哪一条:最差(严重度最高,默认)或最近(时刻最新)。点具体某一条会变成手选,这个按钮再点一下就回到自动。',
				viewEvidence: '看这一帧', viewEvidenceHint: '切到**历史事故**这个诊断上下文:选中的那条事故 + 展开「取证明细」+ 选中这条事故里**最差的那一帧**。帧、耗时分解与证据全部来自事故包(所以跨会话读回的事故也能逐帧回看),实时那一侧的选中不动。包里没有帧记录时会如实说。',
				exportIncidentBtn: '导出事故包', exportIncidentBtnHint: '下载这条事故的完整证据包(帧序列 + LoAF + 窗口内 longtask + 环境与缺失声明),不是整机快照。',
				copySummary: '复制摘要', copySummaryHint: '把这条事故的结论与口径(严重度 / JS 证据 / 主要归属 / 窗口)作为纯文本复制走。',
				copied: '已复制', copyFailed: '复制失败', copyNoApi: '这个环境没有剪贴板 API',
				collapseAll: '全部折叠', collapseAllHint: '收起取证与工具那几组(不动翻帧与事故选中)',
				resetLayout: '恢复默认布局', resetLayoutHint: '回到干净首屏:组全收起 + 翻帧回自动 + 事故选中回自动',
				exportJsonHint: '整机快照:当前全部读数 + 记录器自身 + 错误账本 + 全部留存事故的清单 —— 不是某一次事故包(单次事故走「导出事故包」)。',
				envPickHint: '点一条事故就切过去;当前选中的那条前面有 ●',
			},
			en: {
				title: 'Perf HUD', shortcutToggle: 'Toggle the performance HUD', off: 'off', turnOn: 'on', turnOff: 'off',
				frameWorst: 'worst frame', blame: 'attribution (time · lower bound)',
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
				scope60s: 'last 60s',
				overviewFrame: 'frame', overviewBlame: 'worst one', worstSecondShort: 'worst sec', hostShort: 'host',
				deepShort: 'deep', deepHint: 'Deep = instrumentation + precise attribution: wraps scheduling points and DOM writes and fetches the 12MB sourcemap. Off by default',
				recorder: 'HUD itself', recorderHint: 'Times this HUD own rAF callback: a measuring tool must prove it does not change what it measures. p99 over the last 600 frames',
				split: 'where the frame went', splitTotal: 'long frame total', splitWorst: 'worst',
				framePick: 'frame', framePinned: 'pinned (⟲ returns to auto)', framePickAuto: 'auto: follows the worst',
				frameAutoHint: 'back to auto (follow the worst)',
				framePickHint: 'Out of the last 200 long animation frames, only the ones **worth reviewing** (frame duration >= 100ms, the same line the night watch triggers on; the ranking uses it too, blocking is only a supplement), worst first. ◀ ▶ flips through them, ⟲ returns to auto; a pinned frame falls back once it leaves the 200-frame ring. When nothing reaches the line this falls back to showing all of them',
				framePickFiltered: 'frames above the line',
				spark: '60s frame strip',
				sparkHint: 'Last 60 seconds, one bar per second: height = the worst frame interval in that second, and the colours use the same thresholds as the ASCII frame strip in the export (>=100ms red / >=50ms yellow / otherwise normal). A second that was all rAF suspension is the shortest grey bar — a gap, not a stall; blank = nothing sampled in that second',
				pkgHint: 'Script time in **this frame** (the same frame as the donut above), summed per package (the same resolve path as incident.packages: read straight off single-package URLs, restored from sourcemap sections for combo batches). Without precise attribution a combo batch can only be named as its 58-package batch URL — that is deliberate, nothing is guessed',
				pkgWindowHint: 'The same per-package sum for the recent LoAF **window** (not the frame above): this is a **cumulative** figure, its denominator is on the section heading; check avg script per frame before comparing it with "this frame"',
				pkgStoredHint: 'Script time in **this frame** of the incident, summed per package: the package names were **stored at capture time** (they survive a reload) instead of going through this session\'s sourcemap cache, so they do not turn into "unnamed" after a reload',
				incidentWindowScopeHint: 'Below is the script total of the incident\'s **whole pack** (the same data as `incident.loaf`, not a single frame): a **cumulative** figure whose denominator is on this line; check avg script per frame before comparing it with the "history frame" row above',
				pkgIncidentWindowHint: 'Per-package script sum for the incident\'s **window** (the whole pack, cumulative, not a single frame); its denominator is on this line as well',
				barCopyHint: 'Click a row to copy "name + ms"', copyName: 'name',
				forcedLayout: 'forced style+layout', forcedShort: 'forced',
				forcedHint: 'LoAF forcedStyleAndLayoutDuration: synchronous layout forced by reading layout or writing style. It is **already inside** script time, but it comes from styling rather than business logic — read this row when you cannot tell whether the script side is slow because of JS or because of style. This row is the **window** aggregate',
				splitScript: 'script', splitTask: 'task', splitRender: 'render', splitTail: 'style+layout+paint',
				splitJs: 'script split', jsExec: 'exec', jsPause: 'paused', scopeFrame: 'this frame',
				bySource: 'by source', byPkg: 'by package', pkgZeroNamed: '0 resolved', scriptsUnit: 'scripts', needDeep: 'needs deep', invokerUnknown: 'source not recorded',
				srcNoUrl: 'no URL (inline)', srcBatch: 'plugin batch (not split)',
				crossIncidentHint: 'Scope: the scripts of the incident\'s **whole pack** (the same data as the two "· window" rows above). The two dimensions are two separate leaderboards on their own; only **crossed** do they answer "which of this package\'s callbacks is burning the time"; Top3 × Top3 is expanded and the rest is folded into the "rest" row/column (by subtraction), the four blocks adding up to the incident window\'s script total. Cells are milliseconds; hover for the share.',
				crossTable: 'pkg × source · window', crossCorner: 'pkg \\ src', crossNoOverlap: 'no overlap between the top 3', crossFailed: 'cross table failed', splitFailed: 'script breakdown failed for this frame', crossUnit: 'ms per cell', crossBiggest: 'heaviest', crossNone: 'nothing to cross-tabulate', crossHint: 'Scope: the **window** (the **cumulative** total of the last 200 long animation frames, the same data as the two "· window" rows above — not a single frame). The two dimensions are two separate leaderboards on their own; only **crossed** do they answer "which of this package\'s callbacks is burning the time". Top3 × Top3 is expanded, the rest is folded into the "rest" row/column (by subtraction) and the four blocks add up to the script total. Cells are milliseconds; hover for the share.', barShareHint: 'share of the largest segment in this bar',
				windowScope: 'window', loafRows: 'long frames', spanOver: 'over', avgPerFrame: 'avg script per frame',
				maxLabel: 'max', sparkGap: 'whole second was rAF suspension (a gap, not a stall)', sparkNoPick: 'no long animation frame in this second, not clickable', sparkPickHint: 'click it to move the frame picker to this second\'s long animation frame',
				pickNone: 'this incident pack has no frame records (an old pack, or nothing was captured): only window statistics are available, no frame-by-frame replay',
				ctxLive: 'live', ctxFrame: 'current frame', ctxIncident: 'incident', ctxHistoryFrame: 'history frame',
				backToLive: 'back to live', backToLiveHint: 'return to the live frame context (live capture data and the incident-side selection are untouched)',
				historyHint: 'switch to the incident context: the forensics block becomes this incident\'s window, history frame, frame breakdown and evidence',
				frameNavHint: 'history frames step in **time** order (the same order as the strip, left to right); with "only bad" on, steps land on frames whose interval is at or over the night-watch trigger',
				frameNavPrev: 'prev frame', frameNavNext: 'next frame',
				onlyBad: 'only bad', onlyBadHint: 'Restricts prev / next to anomalous frames (interval >=100ms, the night-watch trigger); click again to clear. It is a navigation filter only: it does not move the selection or the capture',
				techFrameNone: 'no long animation frame was recorded for this frame (only the interval was stored): no breakdown here, and it overlaps none of the window\'s long tasks — no other frame is substituted',
				techFrameNoneShort: 'no record for this frame',
				techNoneHint: 'Why: long animation frames (LoAF) are only reported at or above 50ms and this frame was not reported; its interval is still on the timeline above',
				frameEvidenceMissing: 'this frame has no script records: what follows is the in-window slice of the incident, not this frame\'s',
				frameLtTitle: 'long tasks overlapping this frame', frameLtNone: 'this frame overlaps none of the window\'s long tasks',
				frameLtWindow: 'long tasks in window',
				replayTimeline: 'history frame timeline', replayCellPick: 'click to select this frame', replayCellCount: 'this column',
				replayGapCell: 'no frames recorded during this stretch (rAF suspended or sampling gap)',
				replayTimelineHint: 'The x axis is **time**: a column may hold several frames (the worst one is kept) and clicking selects a **frame that really exists**; stretches where rAF was suspended stay blank — that is "not measured", not "no stall", and nothing is fabricated.',
				verdictLabel: 'attribution', verdictConfirmed: 'confirmed', verdictSuspected: 'suspected', verdictUnattributed: 'unattributed',
				verdictConfirmedText: 'this frame has directly measured JS blocking evidence (a longtask / LoAF overlaps it); main owner in the window',
				verdictNotRootCause: 'this narrows it to a package, not to a root cause',
				verdictSuspectedJsNoPkg: 'there is JS blocking evidence, but no script in the window resolved to a package — deep mode (precise attribution) is needed to narrow it further',
				verdictThrottleText: 'no JS blocking that would explain this frame was observed, and it is clearly longer than its neighbours: more like rAF suspension or browser throttling, to be confirmed against the neighbouring frames and the time gaps',
				verdictNeighbours: 'neighbours median',
				verdictUnattributedText: 'no JS blocking evidence sufficient to explain this frame was observed; check rAF suspension or browser throttling against the neighbouring frames and the time gaps',
				handoffFrameNoEvidence: 'this frame has no script records in the incident pack (interval only)',
				evidenceLabel: 'suspect scripts', evidenceScopeIncident: 'incident', evidenceWindowPrefix: 'in window',
				evidenceHint: 'Lands the chain "incident -> frame -> invoker -> package -> file:line" on individual scripts: the blocks above say where the time went (ranking), this one says which file and function to open (locating). In the **incident context** it prefers the selected history frame\'s own scripts (stored at capture time, still there after a reload); when that frame has no records it falls back to the **in-window** slice of the incident and says so. In the **live context** it shows the current live frame\'s scripts. LoAF only reports scripts over 5ms, so this layer is a **lower bound**.',
				evidenceHoverHint: 'hover for scope & gaps',
				evidenceCopyHint: 'Click to copy "function @ package · file:line · cost · invoker"',
				evidenceWhere: 'where', evidenceInvoker: 'invoked by', copyScript: 'script',
				evidenceBundleLine: 'line in merged script',
				replay: 'incident replay', replayGaps: 'rAF suspended',
				replayFailed: 'incident replay could not be computed',
				replayHint: 'This is the **captured window** (it comes from the incident pack, so it survives a reload), not the live 60-second strip: the x axis is **time**, a column may hold several frames (the worst one is kept) and a click always selects a frame that **really exists** in `incident.frames`; stretches where rAF was suspended stay blank (that is "not measured", not "no stall" — nothing is fabricated). Frame intervals and LoAF entries are directly measured. ⚠️ LoAF gives no per-script start/end inside a frame, so this **does not order execution within a frame**; for per-frame detail use "Export incident" + tools/inspect-incident.mjs.',
				replayScopeNote: 'Scope: frame intervals / quantiles / worst frame all come from the captured 13 seconds, not from live readings, and do not describe right now; a gap means rAF was suspended during that stretch.',
				evidenceFailed: 'the suspect-scripts block could not be computed',
				fnUnknown: 'no function name', pkgUnresolvedShort: 'package unknown', fileUnresolved: 'file unknown',
				pkgNamed: 'named',
				viaDirect: 'read directly', viaInferred: 'inferred from sections', viaNotPlugin: 'not a plugin script', viaFailed: 'resolution failed', viaNotFetched: 'not fetched yet (only deep mode pulls script text)', viaUnavailable: 'not ready / unavailable',
				handoffInteractions: 'interactions >=100ms in the window', handoffInteractionsScope: ' (end-to-end duration, not a frame breakdown)',
				evidenceCaliberPlain: 'Scope: the function name and milliseconds are measured by LoAF; the package / file / line are inferred from the URL and sourcemap sections (pkg= / line= are the raw via codes); the line is a line in the script file itself, not an original-source line — in a combo batch it is a line in the merged big file, so only the file plus "line in merged script N" is shown, never joined into file:line.',
				evidenceMissingPlain: 'Missing: original source line and call stack (needs the inner section mappings or a Chrome trace); interactions only give an end-to-end duration, with no input-delay/processing/presentation split.',
				hourUnit: 'h', minUnit: 'm', secUnit: 's',
				windowScopeHint: 'The three rows below are a **cumulative** sum: script time across the last 200 **long animation frames** (LoAF only reports frames >50ms), not the duration of any single frame — 200 frames of ~100ms each add up to tens of seconds. **Only "avg script per frame" is comparable to the donut above** (that is a single frame); the count and span answer "how often did it stall in that period". A longer span means a bigger total, so do not read it as "it is getting slower"',
				invokerHint: 'LoAF\'s scripts[].invoker: what invoked this script — setTimeout / rAF, an event handler (the most common one here is `DOMWebSocket.onmessage`, the session event stream), a promise callback, a script load. It and "by package" are two slicings of the same script time: "by source" covers every script, "by package" only those whose package could be resolved (so the two totals differ; the total is the script time above). ⚠️ It answers "which kind of call", not "which function inside is slow" — function level needs a Chrome trace, there is no in-page sampler',
				splitJsHint: 'The script slice split three ways: exec / forced style+layout (sync layout forced by reading layout or writing style) / paused (time blocked in sync XHR or dialogs). All three are partitions of scripts[].duration and **sum to it** — they are not additional. This row is **the same frame as the pie above**',
				splitNoLoaf: 'not yet (needs a long animation frame >50ms; LoAF only reports those)',
				splitHint: 'As far as LoAF can decompose it. Up to 7 arcs: the script slice is split again by **invoker** (same order as the "by source" row below) into up to 4 pieces — one red family, dark to light; the unattributed part of the task is **grey**; then render (rAF callbacks) and style+layout+paint. Arcs are separated by a 1.4px gap (that is the only way same-family reds read as separate pieces); slices too small to afford the gap keep their full length. Paint and compositing **cannot** be separated in-page, so the last slice is "everything else" — do not read it as "style and layout only"; separating them needs a Chrome trace',
				worstOne: 'worst one',
				unexplained: 'no JS explanation for that frame', unexplainedHint: 'style/layout/paint/vsync; cross-check with Paint flashing in the Rendering panel',
				verdict: 'verdict', linkShort: 'RTT', suspectSuffix: ' suspect', cleared: 'link cleared (host and tunnel both normal)',
				groupDetail: 'forensics', groupTech: 'technical details', groupDom: 'DOM & heap', groupHost: 'host & link', groupTools: 'toolbox', nodesSuffix: ' nodes',
				stream: 'state', running: 'streaming', idle: 'idle', idleBase: 'idle baseline (60s)', idleWriter: 'still adding nodes while idle',
				notYet: 'n/a', hostLoop: 'host event-loop',
				hostDown: 'host n/a', hostUnsupported: 'host not sampled', hostWarming: 'waiting for host sample', hostUnknown: 'not enough host data', hostStale: 'stale', link: 'link RTT',
				hostEvents: 'host event arrival', hostEventsHint: 'The host half uses the public ctx.on(\'session/event\') and records commit(event.time)→listener arrival lag; the earlier attempt to wrap Context.emit never fired (that event uses scope-filtered dispatch)',
				notInstalled: 'not installed', waiting: 'installed, waiting for events',
				sampling: 'throughput sampling', failed: 'throughput failed',
				renderError: 'panel render error', retry: 'Retry',
				renderErrorHint: 'Collection keeps running: the raw error is above. Retry to restore, or export (also in the errors section)',
				linkHint: 'A 1KB same-origin probe (cache-busted) every 10s gives RTT; n is the sample count over the last 60s. Throughput is a 64KB fetch every 60s (one extra 3s after start). \"Link suspected\" needs p99 > 300ms, normal FPS, and n >= 2',
				suspect: 'link suspected',
				stressFromDom: 'DOM write',
				via: 'channel', viaRemote: 'ctx.remote (client remote)', viaRoute: 'host route /api/dsh-perf-hud/host',
				unattrShort: 'unattr', markPlaceholder: 'note (optional)',
				watch: 'Night watch', watchCaught: 'caught', watchWorst: 'worst', watchRestored: 'restored',
				watchDetected: 'seen', watchKept: 'evidence kept', watchLost: 'lost', tallyUnit: '',
				tallyCoalesced: 'merged triggers', tallyCoalescedHint: 'triggers merged into the same burst (a density, not a count)',
				// candidate causes / diagnostic pack: lead strength, provenance, fixed pack shape
				causeScriptLead: 'package with the most script time', causeLongTaskLead: 'long-task attribution', causeHostLead: 'host event loop', causeNoEvidenceLead: 'no JS blocking evidence',
				causeUnresolvedSuffix: ' not attributed to a package', causeHostBasis: 'host event-loop p99 around the incident', causeLongTaskLimit: 'the four legs only cover the three scheduler callbacks plus DOM writes — event handlers, promises and microtasks are not in them (so this is a lower bound)',
				hostSnapshotNotInstant: 'the host snapshot is taken every 10s and may not cover the stall itself',
				strengthStrong: 'strong lead', strengthMedium: 'moderate lead', strengthWeak: 'weak lead', strengthNone: 'not enough evidence',
				provenanceMeasured: 'measured', provenanceInferred: 'inferred', provenanceUnknown: 'unknown',
				packSummaryTitle: '# Performance incident summary', packSecSummary: '## 1. Summary', integrityIncomplete: 'incomplete capture',
				packSecCandidates: '## 2. Most likely hypotheses (up to 3, each with support and limits)', packSecMissing: '## 3. Missing evidence',
				packSecNext: '## 4. How to verify next', packSecMeta: '## 5. Meta',
				packCauseLabel: 'hypothesis', packSupport: 'support', packLimits: 'limits', packProvenance: 'provenance', packTier: 'capture tier',
				packNoCandidate: 'Not enough evidence to name a candidate cause — see the missing evidence and next steps below.',
				packPreviewNote: 'Read this list before exporting: the pack is built locally and uploads nothing; sharing it with an AI is your own action.',
				packReadmeTitle: '# What is in this diagnostic pack',
				packReadmeWhat: 'manifest.json is the entry point (format version, platform, capture tier, capability matrix, redaction note); summary.md is the human-readable digest; incident.json is the structured raw evidence; README.md is what you are reading.',
				packReadmeHow: 'Start with the hypotheses in summary.md: each carries its supporting evidence, its limits, and its provenance (measured / inferred / unknown). The missing-evidence section says WHY a layer was not captured — do not read "no evidence" as "it did not happen".',
				packReadmePrivacy: 'The pack contains no chat text, prompts, cookies, tokens or request headers (never collected, not filtered out); page URLs keep origin + path only, home directories become ~, and the UA keeps just the major version and OS. This is subtraction, not anonymisation.',
				packReadmeNotes: 'When reading incident.json elsewhere: frame t is page-timeline milliseconds and needs incident.env.perfOrigin to become wall clock; loaf and frames are two views of one signal, never add them; blocking can be 0 while the frame is still heavy.',
				// view model (scheme 1: main / incident detail / developer details / settings)
				viewDev: 'Developer details', viewSettings: 'Settings', back: '←',
				viewIncident: 'Stall detail', backHint: 'Back to the overview (that screen only answers five questions)',
				packFilesLabel: 'diagnostic pack', packFilesHint: 'the AI path: format note + summary + raw evidence + how to read it',
				packFilesValue: 'manifest.json · summary.md · incident.json · README.md',
				storageKeys: 'localStorage:dsh-perf-hud:ring / tally / incidents / watchui / view / sessions / marks / groups / on / collapsed / deep / precise / map / map:index',
				storageKeysHint: 'delete as needed when clearing state; on / deep / precise are the capture tier (night watch / deep / precise attribution) and change how expensive the panel is; map is the section-table cache for that 12MB sourcemap (keyed by rev)',
				// this round: plain-language causes (package names behind a disclosure), two export paths, pre-share preview
				causePlainScript: 'one script module is spending an unusual amount of time', causePlainLongTask: 'a heavy render task happened in this window',
				causePlainHost: 'the host process side looks busy', causePlainUnknown: 'no JS evidence that explains this stall',
				causeWhy: 'Why this conclusion?', causeWhyHide: 'Collapse',
				causeWhyHint: 'Expand for raw package names, milliseconds and support / limits; or open developer details',
				causeRawNote: 'Raw evidence below (package names / ms / provenance) — you rarely need this',
				exportAiBtn: 'Export diagnostic pack (for AI: redacted, no notes)', exportFullBtn: 'Full technical export (keeps notes)',
				exportAiHint: 'The AI path: free text blanked and marked noteDropped, page URL keeps origin+path only, home dirs become ~, UA keeps the major version',
				exportFullHint: 'Local debugging artifact: same source, but it KEEPS the notes you typed — it is not redacted, do not hand it out as-is',
				previewTitle: 'Export preview (nothing generated yet)', previewFiles: 'files',
				previewNotesDropped: 'notes: blanked (marked noteDropped)', previewNotesKept: 'notes: kept (local debugging artifact)',
				previewExcludes: 'not included', previewZip: 'one zip, one download:', previewZipHint: ' (the four files above) ',
				previewGo: 'Generate and export', previewCancel: 'Cancel', exportPreviewCopy: 'Copy export preview',
				hudOff: 'HUD is off', loafOff: 'LoAF not available',
				healthOk: 'Running smoothly', healthStall: 'A stall just happened', healthLimited: 'Monitoring limited',
				healthHint: 'Last 60 seconds: frame interval and long animation frame levels (same thresholds as the panel colours)',
				mainStatus: 'Current status', mainLast: 'Most recent stall', mainCause: 'Possible cause',
				mainTrend1: 'Last hour', mainTrend24: 'Last 24 hours',
				trendSwitchHint: 'Switch between the two windows (counts survive a reload)', trendHint: 'How many / the longest / a repeating lead — three numbers with three different calibers',
				trendScope: 'The count is "stalls detected" (one burst counts once); the repeating lead only counts evidence that was kept, so it never overstates',
				noStallYet: 'No noticeable stall recorded yet — still watching in the background.', noCauseYet: 'Nothing captured yet; let it keep watching.',
				trendNone: 'No stall detected in this window', trendRepeat: 'Repeating lead', stallSuffix: ' stalls',
				trendRepeatPlain: 'the same script module',
				viewThisStall: 'View this stall', exportReport: 'Export diagnostic report',
				devEntry: 'Developer details (technical data)', devEntryHint: 'Frames / scripts / DOM / host / link / raw data — nothing was removed, it just moved in here',
				settingsHint: 'Capture mode, retention, privacy and redaction',
				stallSaved: 'scene saved automatically', stallNotSaved: 'scene not fully saved', secondsUnit: 's',
				devTabFrames: 'Frames & blame', devTabDom: 'DOM & heap', devTabHost: 'Host & link', devTabTools: 'Toolbox', devTabRaw: 'Raw data',
				devTabFramesHint: 'Overview / worst event / attribution / forensics (frame strip, timeline, script split, cross table)',
				devTabDomHint: 'DOM nodes, container growth, JS heap, writers (when deep recording is on)',
				devTabHostHint: 'Host event loop, host event arrival, idle baseline, link RTT and throughput',
				devTabToolsHint: 'Incident list / manual mark / isolation experiment and clearing readings',
				devTabRawHint: 'Whole-machine JSON, incident pack, diagnostic pack preview and storage keys',
				settingsMode: 'Capture mode', settingsRetain: 'Retention', settingsPrivacy: 'Privacy and redaction',
				modeWatch: 'Night watch (always on, zero instrumentation)', modeDeep: 'Deep recording (instrumentation + precise attribution, has a cost)',
				modeHint: 'Night watch and live view are the same capture tier, differing only in whether the panel is unfolded; deep recording is what wraps setTimeout / DOM writes and pulls that sourcemap',
				modeHintShort: 'Night watch is on by default and installs nothing; deep recording is yours to switch on and makes the panel itself more expensive',
				retainText: 'Retention is the union of two tiers: the worst 10 overall + one per day (last 7 days), plus a 2MB persistence cap — over it the weakest are dropped and counted honestly',
				clearIncidentsBtn: 'Clear saved scenes', clearIncidentsHint: 'Clears evidence only, never the frequency counts: what is removed is evidence, not the fact that it happened',
				clearHint: 'Clears current readings (frame ring, long tasks, attribution); saved scenes and frequency counts are untouched',
				privacyText: 'Everything is collected and stored locally; nothing is uploaded by default. Exports are built on your machine — sharing them is your action.',
				privacyRedaction: 'Exports are redacted first: page URLs keep origin + path only (the query string is dropped), home directories become ~, the UA keeps just the major version; the pack states what was removed, kept and never collected. Subtraction, not anonymisation.',
				privacyRedactionHint: 'Two more things are excluded by default: free text you typed (blanked and marked noteDropped in the AI pack) and chat text / prompts / cookies / tokens / request headers — this plugin never reads those',
				tallyScopeSuffix: ' — one stall counts once', tallyKeepHint: 'capacity-limited, not the number of stalls', tallyWorst: 'longest',
				watchDaily: 'daily worst',
				watchNone: 'nothing caught yet', watchOff: 'not recording', watchPersistFailed: 'persist failed', watchTrimmed: 'trimmed',
				watchHint: 'On by default and it patches nothing: one rAF loop plus one LoAF observer. When a frame interval (or LoAF blockingDuration) crosses 100ms it captures the 10s before and 3s after verbatim and keeps the **union of two tiers**: the worst 10 overall plus one worst-per-day (at most the last 7 days, marked "daily worst" in the list); they survive a reload. Persistence has a 2MB byte cap; when it trims, the count shows up as "trimmed N". Leave it running to catch intermittent stalls; after one, hand the evidence pack to an analyst with "Export latest".',
				watchMark: 'Mark just now', watchMarkHint: 'Manually record "it just stuttered": rewinds 3s (human reaction time), slices immediately, and copies the note from the input above into the pack',
				watchExport: 'Export latest', watchExportHint: 'Download the **newest by time** incident (frames + LoAF + long tasks in the window + environment and missing-data notes; not the worst one). For others: __perfHud.exportIncident(\'i55\') by id, or exportIncident(0) for the worst',
				watchManualNote: 'manual mark',
				worstEvent: 'worst event', worstEventHint: 'The worst incident the night watch kept (ranked by severity, not by time). It follows this one automatically; click an entry in the toolbox list to switch, or Reset layout to go back to auto.',
				sevLabel: 'severity', sevBad: 'severe', sevWarn: 'warn', sevOk: 'below line',
				sevBadHint: '>=200ms reads as severe: the same line as the red level of the panel verdict; >=100ms (the night-watch trigger) reads as warn',
				jsEvidence: 'JS evidence', jsYes: 'yes (a longtask/LoAF overlaps it)', jsNo: 'none (neither a longtask nor a LoAF overlaps it)',
				evOwner: 'main owner', evWindow: 'window', framesUnit: ' frames', evAutoWorst: 'auto · worst', evAutoLatest: 'auto · latest', evPinned: 'selected',
				evWorst: 'worst', evLatest: 'latest',
				evScopeHint: 'Which incident "auto" follows: worst (highest severity, default) or latest (newest by time). Clicking a specific entry makes it a manual pick; clicking this button returns to auto.',
				viewEvidence: 'Show frame', viewEvidenceHint: 'Switches to the **incident** context: selects this incident, opens the forensics block and selects the **worst frame** of the incident. Frames, breakdown and evidence all come from the incident pack (so an incident restored from a previous session is still replayable frame by frame), and the live-side selection is untouched. It says so when the pack holds no frame records.',
				exportIncidentBtn: 'Export incident', exportIncidentBtnHint: 'Download this incident\'s full evidence pack (frame series + LoAF + long tasks in the window + environment and missing-data notes) — not the whole-machine snapshot.',
				copySummary: 'Copy summary', copySummaryHint: 'Copy this incident\'s conclusions and scope (severity / JS evidence / main owner / window) as plain text.',
				copied: 'copied', copyFailed: 'copy failed', copyNoApi: 'no clipboard API in this environment',
				collapseAll: 'Collapse all', collapseAllHint: 'Collapse the forensics and toolbox groups (keeps the frame pin and the incident selection)',
				resetLayout: 'Reset layout', resetLayoutHint: 'Back to the clean first screen: all groups collapsed + frame picker to auto + incident selection to auto',
				exportJsonHint: 'Whole-machine snapshot: every current reading + the recorder itself + the error ledger + the list of all kept incidents — not a single incident pack (use Export incident for that).',
				envPickHint: 'Click an incident to switch to it; the selected one is marked with ●',
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
			// ⚠️ **头部一行永不换行**(以前是 flexWrap: 'wrap'):那一行里每个元素都是 `flex: 0 0 auto`
			// (见下面 label / btn 那两条"不收缩"规则),一旦总宽超了就按 DOM 顺序把**尾部的控件整组**
			// 丢到第二行、还左对齐 —— 看上去像下面那一块的按钮。现在分成显式两组:左组可压缩
			// (标题 ellipsis 先让位),右组是不可让步的控件。分组也不再靠某个元素上的 margin-left:auto
			// (那个技巧只在它所在的那一行生效,一换行就散)。
			head: { display: 'flex', alignItems: 'center', gap: 6 },
			headLeft: { display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 auto', minWidth: 0, overflow: 'hidden' },
			headRight: { display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' },
			// 工具条的按钮比正文里的按钮窄一点(padding 8→6):这一行是不可换行的,省下的 4px × 3
			// 就是"标题还能不能完整显示"的差价(实测:不收紧时 zh 详情页差 14px,标题被裁到 48px)
			headBtn: { padding: '2px 6px' },
			// 标题是这一行里唯一可以让步的元素:窄了出省略号,而不是把控件挤到第二行。
			brand: { fontWeight: 700, fontSize: 14, color: 'var(--dsw-alias-label-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
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
			// 上下文标题栏(实时 / 历史事故):标题 + 核心耗时 + 右侧动作。它下面压一条低对比度分隔线,
			// 让"我现在看的是哪一支"从第一行就能读出来。
			ctxBar: {
				display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
				marginTop: 2, paddingBottom: 5, borderBottom: '1px solid var(--dsw-alias-border-l2)',
			},
			ctxTitle: { color: 'var(--dsw-alias-label-primary)', fontWeight: 700, fontSize: 13, minWidth: 0, overflowWrap: 'break-word' },
			// 核心耗时:18px / 600 等宽数字(选中的那一帧的耗时,panel 上最大的那个数)
			hero: { fontFamily: MONO_FONT, fontWeight: 600, fontSize: 18, fontVariantNumeric: 'tabular-nums', lineHeight: 1.25, color: 'var(--dsw-alias-label-primary)' },
			// 卡片:紧凑、8px 圆角、细边框、次级背景(事故回放这类"自成一块"的内容用它)
			card: {
				marginTop: 8, padding: '8px 8px 6px', border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)',
			},
			cardTitle: { color: 'var(--dsw-alias-label-primary)', fontWeight: 700, fontSize: 13, marginBottom: 2 },
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
				id: ROOT_ID,
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

		/** 折叠组的标题:历史事故上下文里带上事故 id —— 折叠着也能看出正在看哪一条。 */
		/** 只清事故(证据),**不动计数桶**:清掉的是证据,不是事实。要清频次用 clearTally()。 */
		function clearIncidentsNow() {
			const watch = state.watch;
			watch.incidents.length = 0;
			watch.captured = 0;
			watch.coalesced = 0;
			watch.dropped = 0;
			watch.restored = 0;
			watch.trimmedByBytes = 0;
			watch.deduped = 0;
			saveIncidents();   // 落盘的那份也要清掉,否则刷新又"复活"
			bump();
			return true;
		}

		// ───────────────────── 视图模型(方案 1:整屏切换,不是把摘要贴在旧面板顶上)─────────────────────
		/**
		 * 四个视图,一次只渲染一个:`main` 回答问题 / `incident` 看一条事故 / `dev` 技术数据 /
		 * `settings` 设置与隐私。落盘只存"在看哪个视图"(`LS_VIEW`),不存任何读数 ——
		 * 所以刷新之后视图回来了,数据该是什么还是什么。
		 * `dev` 内部再分标签页:标签页**按现有分组照实映射**(不硬套概念图的名字):
		 * 帧与归因 / DOM 与堆 / 宿主与链路 / 工具箱 / 原始数据 —— 一个能力都没删,只是从
		 * "一屏铺开 + 五个折叠组"变成"选一个标签页看一组"。
		 */
		const VIEWS = ['main', 'incident', 'dev', 'settings'];
		const DEV_TABS = ['frames', 'dom', 'host', 'tools', 'raw'];

		function setView(name) {
			state.view = VIEWS.indexOf(name) === -1 ? 'main' : name;
			saveView();
			bump();
		}

		function setDevTab(name) {
			state.devTab = DEV_TABS.indexOf(name) === -1 ? 'frames' : name;
			saveView();
			bump();
		}

		function setTrendMs(ms) {
			state.trendMs = ms === TALLY_TREND_LONG_MS ? TALLY_TREND_LONG_MS : TALLY_TREND_SHORT_MS;
			saveView();
			bump();
		}

		/** 只存视图名 / 标签页 / 趋势窗口 —— **不存读数**(读数有自己的键位与自己的一致性)。 */
		function saveView() {
			try {
				localStorage.setItem(LS_VIEW, JSON.stringify({ v: 1, view: state.view, devTab: state.devTab, trendMs: state.trendMs }));
			} catch (error) { /* 记不住视图不影响任何读数 */ }
		}

		function restoreView() {
			try {
				const saved = JSON.parse(localStorage.getItem(LS_VIEW) ?? 'null');
				if (saved === null || typeof saved !== 'object') return;
				if (VIEWS.indexOf(saved.view) !== -1) state.view = saved.view;
				if (DEV_TABS.indexOf(saved.devTab) !== -1) state.devTab = saved.devTab;
				if (typeof saved.trendMs === 'number') state.trendMs = saved.trendMs === TALLY_TREND_LONG_MS ? TALLY_TREND_LONG_MS : TALLY_TREND_SHORT_MS;
			} catch (error) { /* 坏了就用默认视图 */ }
		}

		/**
		 * "现在到底卡不卡" —— 主界面第一块,三档。
		 * ⚠️ **监测不可用不许伪装成正常**:HUD 关着 / LoAF 没装上时给的是"监测受限" + 原因,
		 * 而不是绿色的"运行流畅"。阈值与判色**同一个函数**(`frameLevel`),所以主界面与面板
		 * 不会各说各的。
		 */
		function healthVerdict() {
			const worst = worstLongTask();
			const worstMs = round1(Math.max(state.frameWorst, worst === null ? 0 : worst.ms));
			if (state.on === false) return { level: 'limited', fps: state.fps, worstMs, reason: translate('hudOff') };
			if (state.watch.loafState !== 'on') return { level: 'limited', fps: state.fps, worstMs, reason: `${translate('loafOff')}:${state.watch.loafState}` };
			const level = frameLevel(state.fps, state.frameWorst);
			return { level: level === 'ok' ? 'ok' : 'stall', fps: state.fps, worstMs, reason: '' };
		}

		function healthText(level) {
			if (level === 'ok') return translate('healthOk');
			if (level === 'stall') return translate('healthStall');
			return translate('healthLimited');
		}

		/**
		 * 留存清单里、**趋势窗口内**最常见的那个包名(≥2 次才算"重复")。
		 * 口径照实写:只数**留存下来**的事故(留存受容量限制),所以它是"重复线索"而不是"总次数"。
		 */
		function repeatedLead(ms, atMs) {
			const at = typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : Date.now();
			const from = at - ms;
			const tally = new Map();
			for (const row of state.watch.incidents) {
				const when = Date.parse(row.at);
				if (Number.isFinite(when) === false || when < from || when > at) continue;
				const pkg = Array.isArray(row.packages) && row.packages.length > 0 ? row.packages[0].pkg : null;
				if (pkg === null || pkg === undefined) continue;
				tally.set(pkg, (tally.get(pkg) ?? 0) + 1);
			}
			const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
			return ranked.length === 0 || ranked[0][1] < 2 ? null : { name: ranked[0][0], count: ranked[0][1] };
		}

		function trendSummary(ms, atMs) {
			const row = tallyWindow(ms, atMs);
			return { detected: row.detected, kept: row.kept, lost: row.lost, worstMs: round1(row.worstMs), repeated: repeatedLead(ms, atMs) };
		}

		/** 主界面「最近趋势」那一行:次数 / 最长一次 / 重复线索 —— 三个数各有各的名字。
		 * `atMs` 只为可测:离线断言要固定基准时刻,不然窗口会跟着真实时钟飘。 */
		function trendText(ms, atMs) {
			const trend = trendSummary(ms, atMs);
			if (trend.detected === 0) return translate('trendNone');
			const parts = [`${trend.detected}${translate('times')}${translate('stallSuffix')}`];
			if (trend.worstMs > 0) parts.push(`${translate('tallyWorst')} ${Math.round(trend.worstMs)}ms`);
			// 「重复线索」也**不给包名**:它是普通用户那屏,包名属于展开区与开发者详情
			if (trend.repeated !== null) parts.push(`${translate('trendRepeat')}:${translate('trendRepeatPlain')}(${trend.repeated.count}${translate('times')})`);
			return parts.join(' · ');
		}

		/** 趋势那一行的**原始线索**(具体包名)—— 只在主界面的展开区里出。 */
		function trendRawText(ms, atMs) {
			const trend = trendSummary(ms, atMs);
			if (trend.repeated === null) return null;
			return `${translate('trendRepeat')}:${short(trend.repeated.name)}(${trend.repeated.count}${translate('times')}) · ${translate('provenanceInferred')}`;
		}

		/** 秒数写法(主界面的 hero):0.98 秒 —— 毫秒对普通用户读不出量级。 */
		function secondsText(ms) {
			return `${(Math.round(ms / 10) / 100).toFixed(2)}${translate('secondsUnit')}`;
		}

		/** 最近一次卡顿那一块的正文行(时间 + 现场是否保存) —— 一行说清,不摆原始字段。 */
		function lastStallSubText(row) {
			const at = Date.parse(row.at);
			const when = Number.isFinite(at) ? clock(at) : row.at;
			const saved = row.kept === 'kept' || row.kept === 'replaced';
			return `${when} · ${saved ? translate('stallSaved') : translate('stallNotSaved')}`;
		}

		/**
		 * 「最近一次卡顿」用的是**时间语义**(时刻最新那一条)。
		 * 开发者详情的「最差事件」用的是**严重度语义**(`selectedIncident()`,默认最差)。
		 * 两个视图复用同一批数据,但**语义不许混** —— 把最差那条显示成"最近一次"就是错的
		 * (最差常常是几小时前那次,而用户问的是"刚才卡的是哪一下")。
		 */
		function latestIncident() {
			return pickIncident('latest');
		}

		/**
		 * 候选原因给**普通用户**的那一行。刻意**不出现包名**:包名是内部实现细节,
		 * 对用户来说"某个脚本模块"才是他能理解、也能行动的信息;真实包名 / 毫秒 / 支持证据
		 * 放在「为什么这样判断?」展开区与开发者详情里(要查的时候够得着,平时不糊在脸上)。
		 * ⚠️ 只说**线索类别**,不编模块功能、也不暗示根因(那是 limits 那句的职责)。
		 */
		function causePlainLead(item) {
			if (item.kind === 'script') return translate('causePlainScript');
			if (item.kind === 'longtask') return translate('causePlainLongTask');
			if (item.kind === 'host') return translate('causePlainHost');
			return translate('causePlainUnknown');
		}

		/** 「为什么这样判断?」展开 / 收起:一次性披露,不落盘(刷新回到默认收起的形态)。 */
		function setCauseOpen(open) {
			state.causeOpen = open === true;
			bump();
		}

		/** 分享前预览:构建一次存进 state(别每次渲染都重新序列化整份事故包)。 */
		function openPackPreview(id, options) {
			if (id === null || id === undefined) return null;
			const opts = options ?? { dropFreeText: true };
			state.packPreview = packPreview(id, opts);
			state.packPreviewId = id;
			state.packPreviewOptions = opts;
			bump();
			return state.packPreview;
		}

		function closePackPreview() {
			state.packPreview = null;
			state.packPreviewId = null;
			state.packPreviewOptions = null;
			bump();
		}

		/** 状态图标(图形,不走词典 —— 它不是文案,是记号;颜色与文字两样一起给,见 docs/reading-panel.md)。 */
		function healthIcon(level) {
			if (level === 'ok') return '✓';
			if (level === 'stall') return '!';
			return '—';
		}

		/**
		 * 主界面:普通用户的那一屏,只回答五个问题。
		 * 它**只排版**——四个读数(`healthVerdict` / `selectedIncident` / `causeCandidates` /
		 * `trendSummary`)全是已经算好的纯函数,界面自己不推断(与"口径只在纯函数里"同一条规矩)。
		 * ⚠️ 这里**不出现** LoAF / p99 / RTT / 包名排行 / 帧编号 —— 那些在「开发者详情」。
		 */
		function mainView(props) {
			const t = translate;
			const health = props.health;
			// ⚠️ 这里是**时间语义**(最近一次);严重度语义(最差那条)只属于开发者详情。
			const row = props.latest ?? null;
			const causes = row === null ? [] : causeCandidates(row);
			// ⚠️ 必须是**局部名字**:这个函数在模块作用域,直接写 `trendMs` 会去解析全局标识符 ——
			// 浏览器里当场 ReferenceError(面板整块被外壳停用),而 node --check 与三套件都看不出来。
			const trendMs = props.trendMs;
			const trendRaw = trendRawText(trendMs);
			const kids = [
				h('div', { style: S.block, title: health.reason === '' ? t('healthHint') : health.reason },
					h('div', { style: S.blockLabel }, t('mainStatus')),
					h('div', {
						style: {
							...S.blockValue,
							color: health.level === 'ok' ? 'var(--dsw-alias-state-success-primary)'
								: health.level === 'stall' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)',
						},
					}, `${healthIcon(health.level)} ${healthText(health.level)} · ${health.fps.toFixed(0)} fps${health.reason === '' ? '' : ` · ${health.reason}`}`)),
			];
			// 最近一次卡顿:持续时间 / 何时 / 现场留没留住
			if (row === null) {
				kids.push(h('div', { style: S.sep },
					h('div', { style: S.blockLabel }, t('mainLast')),
					h('div', { style: { ...S.blockValue, color: 'var(--dsw-alias-label-secondary)' } }, t('noStallYet'))));
			} else {
				const level = severityLevel(row.severity);
				kids.push(h('div', { style: S.sep },
					h('div', { style: S.blockLabel }, t('mainLast')),
					h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
						h('span', { style: { ...S.hero, color: severityColor(level) } }, secondsText(row.severity)),
						h('span', { style: { ...S.label, color: severityColor(level) } }, severityText(level))),
					h('div', { style: S.sub }, lastStallSubText(row)),
					h('div', { style: S.buttons },
						h('button', { type: 'button', style: S.btn, onClick: () => props.onOpen(row.id) }, t('viewThisStall')),
						// 这是**给 AI 的那条路**:先出预览(写明脱了什么),再生成
						h('button', { type: 'button', style: S.btn, title: t('exportAiHint'), onClick: () => props.onExportPreview(row.id) }, t('exportReport')))));
			}
			// 可能原因:最多 3 条。**普通用户看到的只有"线索类别 + 强度"** ——
			// 原始包名 / 毫秒 / 支持证据收进「为什么这样判断?」展开区(要查的时候够得着)。
			// 展开区里那句限制一直在:不编模块功能,也不把相关写成根因。
			kids.push(h('div', { style: S.sep },
				h('div', { style: S.blockLabel }, t('mainCause')),
				causes.length === 0
					? h('div', { style: { ...S.blockValue, color: 'var(--dsw-alias-label-secondary)' } }, row === null ? t('noCauseYet') : t('packNoCandidate'))
					: h('div', null, causes.map((item, index) => h('div', { key: `${index}-${item.kind}`, style: S.block },
						h('div', { style: S.blockLabel }, `${index + 1}. ${causePlainLead(item)} · ${strengthText(item.strength)}`),
						props.why !== true ? null : h('div', null,
							h('div', { style: { ...S.sub, color: 'var(--dsw-alias-label-secondary)' } }, t('causeRawNote')),
							h('div', { style: { ...S.sub, fontFamily: MONO_FONT } }, `${item.lead}${item.name === null ? '' : ` · ${short(item.name)}`} · ${t('packProvenance')}:${provenanceText(item.provenance)}`),
							// 支持 / 限制各占一行:塞进一行会被折在词中间(§5「长文本用块式」)
							h('div', { style: S.sub }, `${t('packSupport')}:${item.basis.join(' / ')}`),
							h('div', { style: S.sub }, `${t('packLimits')}:${item.limits.join(' / ')}`))))),
				causes.length === 0 ? null : h('div', { style: S.buttons },
					h('button', { type: 'button', style: S.btn, title: t('causeWhyHint'), onClick: () => props.onWhy(props.why !== true) },
						props.why === true ? t('causeWhyHide') : t('causeWhy')))));
			// 分享前预览:还没生成文件,先把"包含什么 / 脱了什么 / 少了什么"摊出来
			if (props.preview !== null && props.preview !== undefined) {
				const preview = props.preview;
				kids.push(h('div', { style: S.card },
					h('div', { style: S.cardTitle }, t('previewTitle')),
					h('div', { style: S.sub }, `${t('previewFiles')}:${preview.files.map((file) => `${file.name}(${Math.max(1, Math.round(file.bytes / 1024))}KB)`).join(' · ')}`),
					h('div', { style: S.sub }, preview.notes === 'dropped' ? t('previewNotesDropped') : t('previewNotesKept')),
					h('div', { style: S.sub }, `${t('previewExcludes')}:${preview.excludes.length}${t('tallyUnit')}`),
					h('div', { style: { ...S.sub, color: 'var(--dsw-alias-label-secondary)' } }, `${t('previewZip')}${Math.max(1, Math.round(preview.zipBytes / 1024))}KB${t('previewZipHint')}`),
					h('div', { style: S.buttons },
						h('button', { type: 'button', style: S.btn, onClick: () => props.onExportGo() }, t('previewGo')),
						h('button', { type: 'button', style: S.btn, onClick: () => props.onExportCancel() }, t('previewCancel')))));
			}
			// 最近趋势:次数 / 最长一次 / 重复线索 —— 窗口可切(1 小时 / 24 小时)
			kids.push(h('div', { style: S.sep },
				h('div', { style: { ...S.row, marginTop: 0 } },
					h('span', { style: S.label }, trendMs === TALLY_TREND_LONG_MS ? t('mainTrend24') : t('mainTrend1')),
					h('button', { type: 'button', style: S.btn, title: t('trendSwitchHint'), onClick: () => props.onRange(trendMs === TALLY_TREND_LONG_MS ? TALLY_TREND_SHORT_MS : TALLY_TREND_LONG_MS) },
						`→ ${trendMs === TALLY_TREND_LONG_MS ? t('mainTrend1') : t('mainTrend24')}`)),
				h('div', { style: S.blockValue, title: t('trendHint') }, trendText(trendMs)),
				props.why !== true ? null : (trendRaw === null ? null : h('div', { style: { ...S.sub, fontFamily: MONO_FONT } }, trendRaw)),
				h('div', { style: S.sub }, t('trendScope'))));
			// 入口:只留一个 —— 「设置」在标题栏里常驻(每个视图都在),主界面再放一个就是同一个动作
			// 在同屏出现两次。
			kids.push(h('div', { style: { ...S.sep, display: 'flex', gap: 8, flexWrap: 'wrap' } },
				h('button', { type: 'button', style: S.btn, title: t('devEntryHint'), onClick: () => props.onDev() }, t('devEntry'))));
			return kids;
		}

		/**
		 * 开发者详情的标签页行:一次看一组,不把技术数据全铺在一屏(能力一个都没删)。
		 * 尾部跟着「深录」—— 它是插桩开关(有代价、默认关),只属于这一屏与设置页。**它不放在
		 * 标题栏里**:那一行是不可换行的工具条(见 S.head 的说明),而它是唯一"只在某一屏出现"的
		 * 控件 —— 实测把这一屏的标题挤到 21px(≈1.5 字)。这一行本来就换行(五个标签页本来就两行),
		 * 多它一个不增高。
		 */
		function devTabRow(props) {
			const t = translate;
			const tab = props.tab;
			const row = (key, label, hint) => h('button', {
				type: 'button',
				style: { ...S.btn, color: tab === key ? 'var(--dsw-alias-state-business-primary)' : undefined, fontWeight: tab === key ? 700 : 400 },
				title: hint,
				onClick: () => props.onTab(key),
			}, label);
			return h('div', { style: { ...S.sep, display: 'flex', gap: 6, flexWrap: 'wrap' } },
				row('frames', t('devTabFrames'), t('devTabFramesHint')),
				row('dom', t('devTabDom'), t('devTabDomHint')),
				row('host', t('devTabHost'), t('devTabHostHint')),
				row('tools', t('devTabTools'), t('devTabToolsHint')),
				row('raw', t('devTabRaw'), t('devTabRawHint')),
				h('button', {
					type: 'button',
					style: { ...S.btn, color: state.deep ? 'var(--dsw-alias-brand-primary)' : undefined },
					title: t('deepHint'),
					onClick: () => setDeep(state.deep === false),
				}, `${t('deepShort')}${state.deep ? '✓' : ''}`));
		}

		/**
		 * 设置:记录模式 / 数据保留 / 隐私与脱敏。
		 * 三个开关都是**已有**的(`state.deep` / `state.on` / `clearIncidents()`),这里不新增任何
		 * 采集行为 —— 尤其是深录:**不许默认自动开**(概念图里那格"异常时自动加深"刻意没做)。
		 */
		function settingsView(props) {
			const t = translate;
			const kept = state.watch.incidents.length;
			return [
				h('div', { style: S.block },
					h('div', { style: S.blockLabel }, t('settingsMode')),
					h('div', { style: { ...S.blockValue, color: state.deep === true ? 'var(--dsw-alias-brand-primary)' : undefined } },
						state.deep === true ? t('modeDeep') : t('modeWatch')),
					h('div', { style: S.sub, title: t('modeHint') }, t('modeHintShort')),
					h('div', { style: S.buttons },
						h('button', { type: 'button', style: S.btn, title: t('deepHint'), onClick: () => setDeep(state.deep === false) }, `${t('deepShort')}${state.deep ? '✓' : ''}`),
						h('button', { type: 'button', style: S.btn, onClick: () => setEnabled(state.on === false) }, state.on === true ? t('turnOff') : t('turnOn')))),
				h('div', { style: S.sep },
					h('div', { style: S.blockLabel }, t('settingsRetain')),
					h('div', { style: S.blockValue }, t('retainText')),
					h('div', { style: S.sub }, `${t('watchKept')} ${kept}${t('tallyUnit')} · ${t('watchLost')} ${props.trend.lost}${t('tallyUnit')} · ${t('watchTrimmed')} ${state.watch.trimmedByBytes}${t('tallyUnit')}`),
					h('div', { style: S.buttons },
						h('button', { type: 'button', style: S.btn, disabled: kept === 0, title: t('clearIncidentsHint'), onClick: () => props.onClearIncidents() }, t('clearIncidentsBtn')),
						h('button', { type: 'button', style: S.btn, title: t('clearHint'), onClick: () => props.onClearAll() }, t('clear')))),
				h('div', { style: S.sep },
					h('div', { style: S.blockLabel }, t('settingsPrivacy')),
					h('div', { style: S.blockValue }, t('privacyText')),
					h('div', { style: S.sub, title: t('privacyRedactionHint') }, t('privacyRedaction'))),
			];
		}

		function detailGroupLabel() {
			const row = diagMode() === 'incident' ? selectedIncident().row : null;
			return row === null ? translate('groupDetail') : `${translate('groupDetail')} · ${row.id}`;
		}

		/**
		 * 上下文标题栏:左边"这是哪个上下文",中间**核心耗时**(18px/600 等宽数字),右边一个动作。
		 * 实时与历史事故两支都从它开头 —— 两种模式一眼可辨(`实时监控 · 当前帧` / `历史事故 i12 · 历史帧`),
		 * 这是"不许把两种上下文混起来"这条要求在界面上的第一道锚。
		 */
		function contextBar(title, hero, action) {
			// data-ctx-bar:真页面验收器(tools/check-incident.mjs)靠它读"现在是哪个上下文"
			return h('div', { 'data-ctx-bar': '1', style: S.ctxBar },
				h('span', { style: S.ctxTitle }, title),
				hero === null ? null : h('span', { style: S.hero }, hero),
				action === null ? null : h('span', { style: { marginLeft: 'auto' } }, action));
		}

		/**
		 * 那个环:只画**一个维度**(四段:脚本 / 任务里没归到的 / 渲染 / 尾部),相加 = 这一帧。
		 * 尺寸是量出来的:48px 环的周长只有 126px(1% ≈ 1.3px),段一多就分不出来 → 84px,
		 * 段间留 1.4px 缝(小段扣不起缝就不扣)。
		 * 实时与历史事故**共用这一个函数**,只是喂进来的 `split` 不同:同一个口径、同一套颜色。
		 */
		function ringBlock(split) {
			const t = translate;
			if (split === null) return h('div', { style: S.row },
				h('span', { style: S.label, title: t('splitHint') }, t('split')),
				h('span', { style: S.num }, t('splitNoLoaf')));
			const R = 34;
			const C = 2 * Math.PI * R;
			const GAP = 1.4;
			const COLORS = {
				error: 'var(--dsw-alias-state-error-primary)',
				warn: 'var(--dsw-alias-state-warn-primary)',
				brand: 'var(--dsw-alias-brand-primary)',
				neutral: 'var(--dsw-alias-label-secondary)',
			};
			const slices = frameArcs(split);
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
			// 来源明细不在这一层(它在下面那条堆叠条里),tooltip 只讲环自己的四段
			const title = `${t('splitTotal')} ${split.total}ms(${t('splitWorst')} blocking ${split.blocking}ms)\n`
				+ `${t('splitScript')} ${split.js}ms(${t('jsExec')} ${split.exec} · ${t('forcedLayout')} ${split.forced} · ${t('jsPause')} ${split.pause})\n`
				+ `${t('splitTask')} ${split.taskOther}ms\n${t('splitRender')} ${split.render}ms\n${t('splitTail')} ${split.tail}ms`;
			return h('div', { style: { ...S.row, alignItems: 'center', gap: 8 } },
				h('svg', { width: 84, height: 84, viewBox: '0 0 84 84', style: { flex: '0 0 auto' } }, arcs),
				h('div', { style: { flex: '1 1 auto', textAlign: 'right', lineHeight: 1.5, minWidth: 0 } },
					h('div', { style: S.num, title }, `${t('split')} ${split.total}ms`),
					splitLegend(split).map((line, index) => h('div', { key: `legend-${index}`, title, style: S.sub }, line))));
		}

		/**
		 * 脚本侧往下拆的几行:**本帧那组 + 窗口那组**。实时与历史事故共用这一个函数
		 * (只是喂进来的 tally 与三个范围标签不同)—— 两边各写一份渲染,口径迟早会漂。
		 * 按包那几行只在真定到包名 / 真有「其余来源」时才出现。
		 */
		function scriptBreakdownRows(tallyFrame, tallyWindow, frameLabel, framePkgHint, windowHeadHint, windowPkgHint) {
			const t = translate;
			try {
			const rows = [];
			const line = (key, label, hint, value) => h('div', { key, style: S.block },
				h('span', { style: S.blockLabel, title: hint }, label),
				h('div', { style: S.blockValue }, value));
			const head = (key, text, hint) => h('div', { key, style: { ...S.blockLabel, marginTop: 8 }, title: hint }, text);
			// 一条 100% 堆叠横条:上面是"谁 + 毫秒"的文字(绝对值),下面是占比(段宽)。
			// 段宽按这一维度的总量算,所以条恒满格;名次靠由深到浅(与环同一套读法)。
			// ⚠️ 三处按**实测**调过(2026-10-08):① 填充不再从满不透明起步(顶段 0.5,逐级 .38/.28/.2)
			// —— 这个主题里 `brand-primary` 是近白 `rgb(249,250,251)`、`state-success-primary` 是纯绿
			// `rgb(34,197,94)`,满不透明就是一块发光色块,"占比"读不出来;
			// ② 段用 `flexGrow: 毫秒` + `flexBasis: 3px`:小段也占得住 3px(以前 6% 只有 21px × 0.28);
			// ③ 顶段 ≥ 80% 时在条右边内联一个占比 —— 比例严重偏斜时,"几乎全在一桶"要用数字说出来。
			// 每项一行的小表:名字左(超长省略,title 给全名)、毫秒右(等宽)。
			// 原来是"一整块右对齐长文本",折行会折在名字中间(实测 `ResizeObserverCallback` /
			// `index-5SrrfWpU.js` 都被劈成两半),读起来要先把断行拼回去。
			const bar = (key, label, hint, list, token) => {
				const { segs, total } = barSegments(list);
				if (segs.length === 0 || total <= 0) return null;
				const topShare = segs[0].ms / total;
				const restCount = Math.max(0, (list ?? []).length - 3);
				return h('div', { key, style: { marginTop: 6 } },
					h('span', { style: S.blockLabel, title: hint }, label),
					h('div', { style: { marginTop: 2 } },
						segs.map((seg, index) => {
							// 「其余」那一项是合计数,没有单个名字可复制 —— 只有具名行才给动作
							const named = seg.name !== null;
							const text = named ? `${seg.name} ${Math.round(seg.ms)}ms` : translate('rest');
							return h('div', {
								key: `row-${index}`,
								title: named ? `${t('barCopyHint')}\n${text}` : translate('restHint'),
								style: { display: 'flex', gap: 8, alignItems: 'baseline', lineHeight: 1.45, cursor: named ? 'pointer' : 'default' },
								// 点一行复制「名字 + 毫秒」:这是真动作(剪贴板),不是装饰
								onClick: named ? () => copyText(text, t('copyName')) : undefined,
							},
								h('span', {
									style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' },
								}, named
									? short(seg.name)
									: `${translate('rest')}${restCount > 1 ? ` ${restCount}${translate('times')}` : ''}`),
								h('span', {
									style: { flex: '0 0 auto', fontFamily: MONO_FONT, fontVariantNumeric: 'tabular-nums' },
								}, `${Math.round(seg.ms)}ms`));
						})),
					h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 } },
						h('div', { style: { flex: '1 1 auto', display: 'flex', height: 8, borderRadius: 3, overflow: 'hidden', background: 'var(--dsw-alias-border-l2)' } },
							segs.map((seg, index) => {
								return h('div', {
									key: `seg-${index}`,
									title: `${seg.name === null ? translate('rest') : seg.name} ${Math.round(seg.ms)}ms · ${Math.round((seg.ms / total) * 100)}%`,
									style: {
										flexGrow: seg.ms, flexShrink: 1, flexBasis: 3,
										background: `var(${token})`,
										backgroundImage: `linear-gradient(rgba(0, 0, 0, ${[0.32, 0.46, 0.58, 0.68][index] ?? 0.68}), rgba(0, 0, 0, ${[0.32, 0.46, 0.58, 0.68][index] ?? 0.68}))`,
										boxShadow: index === 0 ? undefined : 'inset 1px 0 0 0 rgba(0, 0, 0, 0.6)',
										// ⚠️ 段本身**不给手型**:它是同一份数据的比例视图,点了没有别的去处。
										cursor: 'default',
									},
								});
							})),
						topShare >= 0.8
							? h('span', {
								key: 'share', title: t('barShareHint'),
								style: { ...S.label, flex: '0 0 auto', fontSize: 11, fontWeight: 400 },
							}, `${Math.round(topShare * 100)}%`)
							: null));
			};
			if (tallyFrame !== null && tallyFrame.js > 0) {
				rows.push(head('frame-head', frameLabel, t('splitJsHint')));
				rows.push(line('frame-js', t('splitJs'), t('splitJsHint'), jsBreakdownText(tallyFrame)));
				rows.push(bar('frame-src', t('bySource'), t('invokerHint'), tallyFrame.byInvoker, '--dsw-alias-brand-primary'));
				rows.push(bar('frame-pkg', t('byPkg'), framePkgHint, whoRows(tallyFrame), '--dsw-alias-state-success-primary'));
			}
			if (tallyWindow !== null && tallyWindow.js > 0) {
				rows.push(head('win-head', windowScopeText(tallyWindow), windowHeadHint));
				rows.push(bar('win-src', t('bySource'), t('invokerHint'), tallyWindow.byInvoker, '--dsw-alias-brand-primary'));
				// 全是纯执行时这一行只是把"脚本总耗时"重复一遍(条上已经看得到),不显示
				if (tallyWindow.forced + tallyWindow.pause > 0) rows.push(line('win-js', t('splitJs'), t('forcedHint'), jsBreakdownText(tallyWindow)));
				rows.push(bar('win-pkg', t('byPkg'), windowPkgHint, whoRows(tallyWindow), '--dsw-alias-state-success-primary'));
				// (这里原来有一条"一个包名都没定到 → 收敛成一行带分母的说明"的分支。它**永远不可达**:
				//  外层已经要求 window.js > 0,而 js > 0 就必然有脚本,那条脚本要么定到包(top 非空)、
				//  要么进 byOther —— 两个条件互斥,所以面板从来没渲染过它,套件却因为直接测那个函数而
				//  一直是绿的。现在真正的兜底在渲染路径上:whoRows(window) 把 top 与 byOther 一起喂给
				//  堆叠条,所以"一个包名都没定到"时看到的是**按原因命名的「其余来源」段(带毫秒)**。)
			}
			return rows.length === 0 ? null : h('div', null, rows);
			} catch (error) {
				// 这一块全是**派生统计**(细拆 / 两条条):任何一处算炸都只降级成一行可见的错误原文,
				// 并把原文记进导出件 —— 绝不再让整块取证面板被外壳停用。
				recordError(error);
				return h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-error-primary)' } },
					`${t('splitFailed')}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
			}
		}

		/**
		 * 「可疑脚本」那一块:把「事故/帧 → 来源 → 包 → 文件:行」落到**个体脚本**上。
		 * 上面那几块回答"时间花在哪个包 / 哪类调用"(排行),这一块回答"打开哪个文件、哪个函数"
		 * (定位)。它是**证据**,不是又一个排行榜 —— 只列 Top EVIDENCE_MAX,并把口径与缺口写在同一块里。
		 * 实时与历史事故共用它,`scope` 由 `evidenceScope()` 按上下文给出。
		 */
		function evidenceBlock(scope) {
			const t = translate;
			if (scope === null) return null;
			try {
				// 一条**能定位的**都没有(没开深录 / 脚本被压掉函数名)→ 换一行带分母的说明,
				// 不摆一列 `函数名未记录 @ 包未定名 + 毫秒`(那既没缩小范围又翻了几倍行数)
				if (scope.rows.length === 0) {
					return h('div', { style: { ...S.sub, marginTop: 8 }, title: `${t('evidenceHint')}\n${evidenceFooterTitle()}` },
						evidenceZeroText(scope));
				}
				return h('div', { style: { marginTop: 8 } },
					// 这一帧没有脚本记录、下面给的是窗口切片时,先把范围说出来(不含糊过去)
					scope.missing === true ? h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-warn-primary)' } }, t('frameEvidenceMissing')) : null,
					h('div', { style: { ...S.blockLabel, marginTop: 8 }, title: t('evidenceHint') }, scope.label),
					h('div', { style: { marginTop: 2 } }, scope.rows.map((ev, index) => h('div', {
						key: `ev-${index}`,
						title: `${evidenceLine(ev)}\n${t('evidenceCopyHint')}`,
						style: { display: 'flex', gap: 8, alignItems: 'baseline', lineHeight: 1.45, cursor: 'pointer' },
						onClick: () => copyText(evidenceLine(ev), t('copyScript')),
					},
						h('span', {
							style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' },
						}, evidenceName(ev)),
						h('span', {
							title: `${translate('evidenceWhere')} ${evidenceWhereText(ev)}`,
							style: { flex: '0 0 auto', fontFamily: MONO_FONT, fontVariantNumeric: 'tabular-nums' },
						}, `${Math.round(ev.ms)}ms`)))),
					h('div', { style: S.sub, title: evidenceFooterTitle() }, evidenceFooter(scope)));
			} catch (error) {
				// 派生统计算炸只降级成一行可见原文,不许带走整块面板(与其它几块同一条安全线)
				recordError(error);
				return h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-error-primary)' } },
					`${t('evidenceFailed')}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
			}
		}

		/**
		 * 包 × 来源**交叉表**(默认收起)。两个正交维度分开看是两张榜单,交叉起来才回答
		 * "哪个包的哪类回调在烧时间";只展开 Top3 × Top3,其余并进"其余"行/列(减法补足),
		 * 四块拼起来恒等于脚本总耗时。格子给毫秒(单位写在末尾),占比放 hover。
		 * 实时吃最近 200 条窗口的 tally,历史事故吃**整份事故包**的 tally —— 同一个函数。
		 */
		function crossBlock(tally, hint) {
			const t = translate;
			try {
				const cross = crossTable(tally);
				if (cross === null) return null;
				const pct = (ms) => `${Math.round((ms / (cross.js || 1)) * 100)}%`;
				const cellStyle = { flex: '1 1 0', textAlign: 'right', fontFamily: MONO_FONT, fontVariantNumeric: 'tabular-nums', fontSize: 12 };
				const nameStyle = { flex: '0 0 84px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
				const row = (key, label, cells) => h('div', { key, style: { display: 'flex', gap: 4, marginTop: 2 } },
					h('span', { style: nameStyle, title: label }, label), cells);
				const num = (key, ms, who, src) => h('span', {
					key, title: `${who} · ${src} ${Math.round(ms)}ms · ${pct(ms)}`,
					style: { ...cellStyle, color: ms > 0 ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)' },
				}, ms > 0 ? String(Math.round(ms)) : '·');
				const kids = [
					row('cross-head', t('crossCorner'), cross.cols.map((src) => h('span', {
						key: `h-${src}`, title: src, style: { ...nameStyle, flex: '1 1 0', textAlign: 'right' },
					}, short(src))).concat([
						h('span', { key: 'h-rest', style: { ...nameStyle, flex: '1 1 0', textAlign: 'right' } }, translate('rest')),
					])),
				];
				cross.rows.forEach((who, r) => kids.push(row(`cross-${who}`, short(who),
					cross.cols.map((src, c) => num(`c-${r}-${c}`, cross.grid[r][c], who, src))
						.concat([num(`c-${r}-rest`, cross.restCol[r], who, translate('rest'))]))));
				kids.push(row('cross-rest', translate('rest'),
					cross.cols.map((src, c) => num(`r-rest-${c}`, cross.restRow[c], translate('rest'), src))
						.concat([num('cross-corner-cell', cross.corner, translate('rest'), translate('rest'))])));
				kids.push(h('div', { key: 'cross-unit', title: hint ?? t('crossHint'), style: { ...S.sub, textAlign: 'right' } },
					`${translate('crossUnit')} · ${translate('crossBiggest')} ${short(cross.top.who)} · ${short(cross.top.src)} ${Math.round(cross.top.ms)}ms`));
				return group('cross', t('crossTable'), crossSummary(cross), () => kids);
			} catch (error) {
				// 交叉表是**派生统计**:它自己算炸了不该把整块取证面板带走(实测被报"点开就闪退":
				// `short(null)` 抛错 → 面板渲染抛错 → 外壳停用条目,面板整块消失)。降级成一行**可见**的
				// 错误原文,并把错误记进导出件 —— 不静默吞(§1「不许假装成功」)。
				recordError(error);
				return h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-error-primary)' } },
					`${t('crossFailed')}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
			}
		}

		/**
		 * 实时帧的翻帧行(最近 200 条长动画帧按严重度降序;◀ ▶ 换一条、⟲ 回到自动)。
		 * 它**只在实时上下文里出现** —— 历史事故用的是帧条 + 事故内的帧导航,两者不是同一份数据。
		 */
		function liveFramePickRow() {
			const t = translate;
			const list = pickList();
			if (list.rows.length === 0) return null;
			const current = pickedLoaf();
			const at = list.rows.findIndex((row) => row.t === current.t) + 1;
			const auto = state.watch.pickT === null;
			const shown = list.filtered ? list.rows.length : 0;
			const title = `${t('framePick')} ${at}/${list.rows.length}${list.filtered ? `(≥${PICK_MIN_MS}ms)` : ''}`
				+ ` · ${t('splitTotal')} ${Math.round(current.dur ?? 0)}ms · blocking ${Math.round(current.blocking ?? 0)}ms · ${clock(current.t)}`
				+ `\n${auto ? t('framePickAuto') : t('framePinned')}`
				+ (shown === 0 ? '' : `\n${translate('framePickFiltered')} ${shown}${translate('times')}`)
				+ `\n${t('framePickHint')}`;
			return h('div', { style: { ...S.row, alignItems: 'center' }, title },
				h('span', { style: S.label }, `${t('framePick')} ${at}/${list.rows.length} · ${Math.round(current.dur ?? 0)}ms${list.filtered ? ` · ≥${PICK_MIN_MS}ms` : ''}`),
				h('span', { style: { flex: '0 0 auto', display: 'flex', gap: 6 } },
					h('button', { type: 'button', style: S.btn, title: t('framePickHint'), onClick: () => pickStep(-1) }, '◀'),
					h('button', { type: 'button', style: S.btn, title: t('framePickHint'), onClick: () => pickStep(1) }, '▶'),
					h('button', { type: 'button', style: S.btn, title: t('frameAutoHint'), onClick: pickAuto }, '⟲')));
		}

		/**
		 * **历史帧时间轴 + 逐帧导航**。它不是一个装饰性的柱状图:
		 *   · 每一列都指向 `incident.frames` 里**真实存在**的那一帧(点击选中它);
		 *   · 整段 rAF 被挂起 / 采样缺失的地方**留白**,不补桩(那是"没在测",不是"没卡");
		 *   · 选中帧用一条蓝色竖线标出来,并给序号(窗口内第几帧)与耗时。
		 * 四个方向各一个按钮,没有下一条就**禁用**(不留一个点了没反应的动作)。
		 */
		function timelineBlock(row, frame, nav) {
			const t = translate;
			try {
			const timeline = replayColumns(row);
			if (timeline === null) return h('div', { style: S.sub }, t('pickNone'));
			const bars = [];
			for (const cell of timeline.cols) {
				if (cell === null) continue;
				const isGap = cell.frame === null;
				const height = isGap ? 2 : Math.max(2, Math.min(SPARK_REPLAY_HEIGHT, Math.round((cell.ms / SPARK_MAX_MS) * SPARK_REPLAY_HEIGHT)));
				bars.push(h('rect', {
					key: `c${cell.index}`, x: cell.index, y: SPARK_REPLAY_HEIGHT - height, width: 1, height,
					fill: SPARK_COLORS[cell.level],
					// 悬停给的是**这一格那一帧**的真实信息(编号 / 耗时 / 墙钟),不是这一格的平均
					title: replayCellTitle(row, cell, nav),
					style: isGap ? undefined : { cursor: 'pointer' },
					onClick: isGap ? undefined : () => selectIncidentFrame(cell.frame.t),
				}));
			}
			// 选中帧的标记:一条从顶到底的蓝线(盖在柱子上;柱子自己的颜色仍然表达它的档位)
			const selX = Math.min(REPLAY_COLS - 1.5, Math.max(0, replayX(frame.t, timeline.from, timeline.span, REPLAY_COLS)));
			bars.push(h('rect', { key: 'sel', x: selX, y: 0, width: 1.5, height: SPARK_REPLAY_HEIGHT, fill: 'var(--dsw-alias-state-business-primary)' }));
			const startAt = incidentWallClock(row, timeline.from);
			const endAt = incidentWallClock(row, timeline.to);
			const level = severityLevel(frame.ms ?? 0);
			const btn = (label, enabled, onClick) => h('button', {
				type: 'button', disabled: enabled === false, title: t('frameNavHint'),
				style: enabled === false ? { ...S.btn, opacity: 0.45, cursor: 'default' } : S.btn,
				onClick: enabled === false ? undefined : onClick,
			}, label);
			return h('div', { style: S.card },
				h('div', { style: S.cardTitle, title: t('replayTimelineHint') }, t('replayTimeline')),
				h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 2 } },
					h('span', { style: { ...S.sub, marginTop: 0 } }, startAt === null ? t('notYet') : clock(startAt)),
					h('span', { style: { ...S.sub, marginTop: 0 } }, endAt === null ? '' : clock(endAt))),
				h('svg', {
					width: '100%', height: SPARK_REPLAY_HEIGHT, viewBox: `0 0 ${REPLAY_COLS} ${SPARK_REPLAY_HEIGHT}`,
					preserveAspectRatio: 'none', style: { display: 'block', marginTop: 2 },
				}, bars),
				// 帧号与毫秒**只在上面那行上下文标题里给一次**(这里曾把同一句话说第二遍);
				// 三个导航控件并成一行:两对箭头做的是同一件事、只是步长不同,读的人得先弄清
				// "异常帧"是什么才敢按 —— 现在「只看异常」是一个过滤器,箭头还是那两个箭头。
				h('div', { style: { display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap', alignItems: 'center' } },
					h('span', { style: { ...S.sub, marginTop: 0, color: severityColor(level) }, title: t('sevBadHint') }, severityText(level)),
					h('span', { style: { flex: '1 1 auto' } }),
					btn(`◀ ${t('frameNavPrev')}`, nav.hasPrev, () => incidentFrameStep(-1)),
					btn(`${t('frameNavNext')} ▶`, nav.hasNext, () => incidentFrameStep(1)),
					h('button', {
						type: 'button',
						title: t('onlyBadHint'),
						style: { ...S.btn, color: state.watch.onlyBad === true ? 'var(--dsw-alias-state-business-primary)' : undefined },
						onClick: () => setOnlyBad(state.watch.onlyBad !== true),
					}, `${t('onlyBad')}${state.watch.onlyBad === true ? '✓' : ''}`)));
			} catch (error) {
				// 与其它派生块同一条安全线:算炸只降级成一行可见原文,不许带走整块面板
				recordError(error);
				return h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-error-primary)' } },
					`${t('replayFailed')}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
			}
		}

		/** 与这一帧**时间上重叠**的 long task(捕获时存下来的四条腿归因明细;没有就说没有)。 */
		function longTaskBlock(row, frame) {
			const t = translate;
			const tasks = incidentLongTasksAt(row, frame);
			const total = Array.isArray(row.longTasks) ? row.longTasks.length : 0;
			if (tasks.length === 0) {
				return h('div', { style: S.row },
					h('span', { style: S.label, title: t('frameLtTitle') }, t('frameLtTitle')),
					h('span', { style: S.num }, `${t('frameLtNone')} · ${t('frameLtWindow')} ${total}`));
			}
			return h('div', { style: S.block, title: t('frameLtTitle') },
				h('div', { style: S.blockLabel }, `${t('frameLtTitle')} · ${t('frameLtWindow')} ${total}`),
				h('div', { style: { marginTop: 2 } }, tasks.slice(0, EVIDENCE_MAX).map((task, index) => h('div', {
					key: `lt-${index}`,
					title: `${short(task.owner ?? '?')} · ${task.component ?? t('none')} · ${task.source ?? ''}`,
					style: { display: 'flex', gap: 8, alignItems: 'baseline', lineHeight: 1.45 },
				},
					h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' } },
						`${short(task.owner ?? '?')} · ${task.component ?? t('none')}`),
					h('span', { style: { flex: '0 0 auto', fontFamily: MONO_FONT, fontVariantNumeric: 'tabular-nums' } }, `${Math.round(task.ms ?? 0)}ms`)))),
				tasks.length <= EVIDENCE_MAX ? null : h('div', { style: S.sub }, `${t('rest')} ${tasks.length - EVIDENCE_MAX}`));
		}

		/** 归因状态那一行:文字 + 档位色,并把"凭什么"摊在下一行(不留一句"未归因"就跑)。 */
		function verdictBlock(row) {
			const t = translate;
			const verdict = incidentVerdict(row);
			if (verdict === null) return null;
			return h('div', { style: S.block },
				h('div', { style: S.row },
					h('span', { style: S.label, title: t('verdictLabel') }, t('verdictLabel')),
					h('span', { style: { ...S.num, color: verdictColor(verdict.level) } }, verdict.label)),
				h('div', { style: S.sub }, verdict.detail));
		}

		/**
		 * 「技术细节」收起时的那一行摘要。
		 * **只从已经算好的 detail 里读**(不重新采、不重新解析):折叠组的摘要即使收起也会被求值
		 * (见 group() 的说明),所以它必须是常数级代价。真实量级下长度有预算(`tests/logic.mjs`)。
		 */
		function techSummary(detail) {
			const t = translate;
			if (detail === null || detail === undefined) return t('notYet');
			if (detail.split === null || detail.split === undefined) return t('techFrameNoneShort');
			const lt = Array.isArray(detail.longTasks) ? detail.longTasks.length : 0;
			return `${detail.split.total}ms · ${t('splitScript')} ${detail.split.js}ms · LT ${lt}`;
		}

		/**
		 * 「技术细节」:环 / 脚本拆解 / 重叠 long task / 可疑脚本 / 包×来源 / 口径。
		 *
		 * 为什么要有它:**这一屏普通用户也会看到**(主界面「看这一次」的落点),而上面这些是给
		 * 开发者的读数。以前它们在卡顿详情里是**平铺**的 —— 同一份内容在开发者详情里反而收在
		 * 「取证明细」折叠里,于是"开发者的屏比普通用户的屏还简洁"。现在两边共用这一个组:
		 * 收起只留一行摘要,展开就是全部技术读数(能力一个都没删)。
		 */
		function techGroup(detail) {
			const t = translate;
			return group('tech', t('groupTech'), techSummary(detail), () => {
				// 这一帧没有 LoAF(只存了帧间隔)时,帧内分解与"重叠的 long task"都无从谈起 ——
				// 合成**一行**,而不是两个块各说一遍自己那份缺失(以前这里连着四行都在说"没有")。
				const noLoaf = detail.split === null || detail.split === undefined;
				const kids = [];
				if (noLoaf) {
					kids.push(h('div', { style: { ...S.sub, marginTop: 4 }, title: t('techNoneHint') }, t('techFrameNone')));
				} else {
					kids.push(ringBlock(detail.split));
				}
				// 脚本侧:本帧 + 事故窗口。窗口那一份即使这一帧没有记录也照给(它来自整份事故包)。
				kids.push(h('div', null, scriptBreakdownRows(detail.tallyFrame, detail.tallyWindow,
					t('ctxHistoryFrame'), t('pkgStoredHint'), t('incidentWindowScopeHint'), t('pkgIncidentWindowHint'))));
				if (noLoaf === false) kids.push(longTaskBlock(detail.row, detail.frame));
				kids.push(evidenceBlock(detail.evidence));
				kids.push(crossBlock(detail.tallyWindow, t('crossIncidentHint')));
				kids.push(h('div', { style: { ...S.sub, marginTop: 8 }, title: t('replayHint') }, t('replayScopeNote')));
				return kids;
			});
		}

		/**
		 * **历史事故上下文**的取证明细。数据全部来自 `detailContext()`(只吃事故包:
		 * `incident.frames` / `incident.loaf` / `summary` / `longTasks` / `urls`),所以:
		 *   · 刷新生效(事故落盘 + 上下文落盘),零新增采集;
		 *   · 实时帧环里别的帧、实时窗口聚合、记录器自身 / 最差那秒 / 帧内未归因 —— **一个都不进来**;
		 *   · 某一帧缺东西时写明缺什么,不回退去拿别的帧或实时数据顶上。
		 *
		 * 屏幕上分两层:**结论层**(上下文标题 / 这条事故的两个动作 / 回放范围 / 归因状态 /
		 * 时间轴)普通用户就够用;技术读数全在 `techGroup` 里,默认收起。
		 */
		function incidentDetail(detail) {
			const t = translate;
			const row = detail.row;
			if (row === null) return [h('div', { style: S.sub }, t('watchNone'))];
			const frame = detail.frame;
			const nav = detail.nav;
			const kids = [];
			kids.push(contextBar(
				incidentFrameHeadingText(row, frame, nav),
				frame === null ? null : `${Math.round(frame.ms ?? 0)}ms`,
				h('button', { type: 'button', style: S.btn, title: t('backToLiveHint'), onClick: showLiveMode }, t('backToLive'))));
			// 这一屏**唯一**的动作条:返回在标题栏(每个视图都有),这里只回答"这条事故怎么办"。
			// 以前它在视图外面又写了一份返回 + 这两个动作 —— 同屏两个「←」返回,位置还不一样。
			kids.push(h('div', { style: S.buttons },
				h('button', { type: 'button', style: S.btn, title: t('copySummaryHint'), onClick: () => copyText(incidentSummaryText(row), t('copySummary')) }, t('copySummary')),
				h('button', { type: 'button', style: S.btn, title: t('exportIncidentBtnHint'), onClick: () => exportIncident(row.id) }, t('exportIncidentBtn'))));
			// 采集本身丢过记录时,这一屏必须自己说出来 —— 否则"没看到证据"会被读成"没有证据"。
			if (row.integrity?.captureComplete === false) {
				const drop = row.integrity;
				kids.push(h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-warn-primary)' } },
					`${t('integrityIncomplete')} · LoAF ${drop.loafDropped} · LT ${drop.longTaskDropped}${drop.reasons.length === 0 ? '' : ` · ${drop.reasons.join(' · ')}`}`));
			}
			const scope = replayScope();
			if (scope !== null) {
				// 事故 id 只在上面那行上下文标题里出现一次(这里曾重复印一遍)
				kids.push(h('div', { style: S.block, title: t('replayHint') },
					h('div', { style: S.blockLabel }, t('replay')),
					h('div', { style: S.blockValue }, replaySummaryText(scope))));
			}
			kids.push(verdictBlock(row));
			if (frame === null) {
				// 老包 / 捕获失败:包里一条帧记录都没有 → 如实说,不摆空条,更不借实时帧
				kids.push(h('div', { style: { ...S.sub, color: 'var(--dsw-alias-state-warn-primary)' } }, state.pickNote ?? t('pickNone')));
				kids.push(h('div', { style: S.sub, title: t('replayHint') }, t('replayScopeNote')));
				return kids;
			}
			// 时间轴是**导航器**:帧号与耗时在上面的上下文标题里,这里只留档位与翻帧控件
			kids.push(timelineBlock(row, frame, nav));
			// 往下全是技术读数,默认收起(展开就是原来那一整套,一个都没删)
			kids.push(techGroup(detail));
			return kids;
		}

		/**
		 * **实时上下文**的取证明细。只吃实时帧环 / 实时窗口聚合 / 插桩读数 ——
		 * 与历史事故那一支完全分开(切模式就是切数据源,不是把两边的数字拼在一起)。
		 */
		function liveDetail(detail) {
			const t = translate;
			const tally = longTaskTally();
			const unexplained = unexplainedFrame();
			const selected = selectedIncident();
			return [
				contextBar(
					liveFrameHeadingText(detail.frame),
					detail.frame === null ? null : `${Math.round(detail.frame.dur ?? 0)}ms`,
					selected.row === null ? null : h('button', {
						type: 'button', style: S.btn, title: t('historyHint'),
						onClick: () => revealIncident(selected.row.id),
					}, `${t('ctxIncident')} ${selected.row.id}`)),
				// ① 60 秒帧条(趋势导航)
				h('div', { style: S.block },
					h('div', { style: S.blockLabel, title: t('sparkHint') }, t('spark')),
					h('div', { style: { marginTop: 2 } }, frameRing.size === 0 ? t('notYet') : sparkStrip())),
				// ② 实时翻帧(最近 200 条长动画帧)
				liveFramePickRow(),
				// ③ 这一帧的时间去向
				ringBlock(detail.split),
				// ④ 脚本侧(本帧 / 窗口)
				h('div', null, scriptBreakdownRows(detail.tallyFrame, detail.tallyWindow,
					t('scopeFrame'), t('pkgHint'), t('windowScopeHint'), t('pkgWindowHint'))),
				// ⑤ 可疑脚本(当前实时帧)
				evidenceBlock(detail.evidence),
				// ⑥ 窗口交叉表
				crossBlock(detail.tallyWindow),
				// ⑦ 时间分解之后:帧里"JS 之外"的残差 —— 唯一能反映 CSS/绘制卡顿的数字
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
			];
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
		 * 只看 fps 会让 54.2fps 显示成绿的、而同期最差帧 130ms —— 绿点掩盖了卡顿。
		 */
		function frameLevel(fps, frameWorst) {
			if (fps <= 30 || frameWorst >= 200) return 'bad';
			if (fps <= 50 || frameWorst >= 120) return 'warn';
			return 'ok';
		}

		function levelFrame(fps, frameWorst) {
			const level = frameLevel(fps, frameWorst);
			if (level === 'bad') return 'var(--dsw-alias-state-error-primary)';
			if (level === 'warn') return 'var(--dsw-alias-state-warn-primary)';
			return 'var(--dsw-alias-state-success-primary)';
		}

		/**
		 * 只去掉 @scope/ 前缀,不截断 —— 截断过的包名根本认不出来("dsh-better-sideb…"),
		 * 放不下就换行(面板宽度 + overflowWrap 已经接得住)。
		 */
		function short(id) {
			// ⚠️ 必须防 null/undefined:id 来自"谁是最大那一格"这类推导,可能一个都没有 ——
			// 老写法 `id.replace(...)` 在这种情况下直接抛,把整块面板打成错误边界(实测被报"闪退")。
			return typeof id === 'string' ? id.replace(/^@[^/]+\//, '') : '';
		}

		/**
		 * 折叠**摘要**里的名字:超过 `max` 就省略号截断。
		 * 摘要是 group 那一行(`label` 不收缩 + `value` 右对齐),长名字会把值那一侧折成参差的两行;
		 * 完整名字在展开后的交叉表 / 堆叠条里都有,所以这里截断不丢信息。
		 */
		function clipName(name, max) {
			const text = typeof name === 'string' ? name : '';
			return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
			// ⚠️ 三处悬停联动(环 ↔ 按来源/按包堆叠条 ↔ 交叉表)**整体停用,而且把它那套
			// 辅助代码删掉了**(`hot` / `setHot` / `hotProps` / `hotStyle` 与各处的 `hot === …`)。
			// 为什么停用:2026-10-08 实测「鼠标指到交叉表的行标签」会让外壳把**整个条目停用** ——
			// 面板整块消失,而同期 `errors` 为空、`window.onerror` 不响、`__perfHud.enabled` 仍是 true;
			// 也就是说**它不经过我们自己的 HudBoundary**(抛点更可能在 `PerfHud()` 的函数体里,
			// 而 HudBoundary 是它返回的树的一部分),我们连错误原文都拿不到。
			// 2026-10-11 复核:**在当前代码上复现不出来** —— 真实鼠标依次扫过交叉表内 163 个元素
			// (外加用 JS 派发 153 次 `mouseover`)全程存活、`errors: 0`、ring 数不变,所以既
			// 不能证明根因、也不能证明已修好。按"稳定优先于观感"这条,**保持停用**。
			// 要重新尝试:先按上面那两种走法搭一个可复现的探针(遍历 DOM 顺序 + 装 console.error 钩子,
			// 注意钩子必须在 reload **之后**装),同时盯外壳日志里有没有 `slot entry crashed in …`;
			// 复现出来之前不要再往渲染里加 per-element 的鼠标状态。
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
					state.toggleHud = null;
				};
			}, []);

			const t = translate;
			const toggle = () => {
				const next = open === false;
				setOpen(next);
				// 展开药丸 = 回到"日常那一屏"(主界面);开发者详情 / 设置是显式入口,
				// 不因为上次停在那就一直停在那 —— 否则普通用户点开看到的是一屏技术数据。
				if (next === true) setView('main');
				state.collapsed = next === false;
				try { localStorage.setItem(LS_UI, next ? '0' : '1'); } catch (error) { /* 折叠状态记不住无所谓 */ }
			};
			// 快捷键走同一个 toggle(不另写一份展开状态,否则两处会不同步)。
			state.toggleHud = toggle;
			// 收起/展开不抢焦点:外壳在键盘命令之后会把焦点还给输入框;与它抢只会让用户丢焦点。
			if (state.on === false) {
				return h('div', { ref: setRoot, id: ROOT_ID, style: S.root(false) },
					h('div', { style: S.head },
						h('span', { style: S.label }, `${t('title')} · ${t('off')}`),
						h('button', { type: 'button', style: S.btn, onClick: () => setEnabled(true) }, t('turnOn'))));
			}

			const worst = worstLongTask();
			const link = linkStats();
			const linkSuspect = suspectLink();
			const idleBase = state.idleBaseline;
			const infra = infraVerdict();
			const hostFresh = hostFreshness();
			const rows = pluginTable();
			const top = rows.slice(0, TOP_N);
			const rest = rows.slice(TOP_N);
			// 首屏「最差事件」块吃的这一份上下文:默认自动跟严重度最差那条;用户在清单里点过就跟
			// 他选的那条(选中的被挤出留存清单时 selectedIncident 自己退回自动)。
			const selected = selectedIncident();
			const selectedRow = selected.row;
			const selectedLevel = severityLevel(selectedRow === null ? null : selectedRow.severity);

			const scene = sceneChip();
			// 落盘的是"上次在看哪个视图",而事故可能已经被挤出留存清单 —— 那时退回主界面,
			// 不去渲染一个空的历史上下文(与 selectedIncident 的退回自动是同一条规矩)。
			const view = state.view === 'incident' && state.watch.mode !== 'incident' ? 'main' : state.view;
			const viewTitle = view === 'dev' ? t('viewDev') : view === 'settings' ? t('viewSettings') : t('viewIncident');
			const head = h('div', { style: S.head },
				h('div', { style: S.headLeft },
					// 子页只写视图名:「性能 HUD ·」那一段与下面第一行的上下文标题(`历史事故 i35xx · 历史帧 …`)
					// 说的是同一件事(我在哪),而它是这一行里唯一能让位的文字。品牌名进悬停。
					h('span', { style: S.brand, title: t('title') }, view === 'main' ? t('title') : viewTitle),
					view === 'main' ? null : h('button', { type: 'button', style: { ...S.btn, ...S.headBtn }, title: t('backHint'), onClick: () => setView('main') }, t('back')),
					// 场景标签与标题一样是**文字**,一样可以让位(先出省略号):不变的是控件。
					// 少了这一条,开发者详情那一屏(返回 + 深录 + 设置 + 收起 + 关闭)在 zh 下仍会超 ~16px。
					h('span', { style: { ...S.label, color: scene.color, flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, scene.text),
					h('span', { style: { ...S.num, flex: '0 0 auto', color: levelFrame(state.fps, state.frameWorst) } }, `${state.fps.toFixed(1)} fps`)),
				h('div', { style: S.headRight },
					h('button', { type: 'button', style: { ...S.btn, ...S.headBtn }, title: t('settingsHint'), onClick: () => setView(view === 'settings' ? 'main' : 'settings') }, t('viewSettings')),
					h('button', { type: 'button', style: { ...S.btn, ...S.headBtn }, title: open ? t('collapse') : t('expand'), onClick: toggle }, open ? '–' : '+'),
					h('button', { type: 'button', style: { ...S.btn, ...S.headBtn }, title: t('turnOff'), onClick: () => setEnabled(false) }, t('turnOff'))));

			if (open === false) {
				// 折叠不是"看不见":至少留下 fps / 最差帧 / 最差 longtask 三个读数。
				//
				// 「抓到 N 次」这一格原来写的是 `state.watch.incidents.length` —— 那是**留存了几份
				// 详细现场**,受容量限制(最差 10 次 + 每天 1 条)。把它当"发生了多少次卡顿"会系统性
				// 少报:被挤掉的卡顿不是没发生。现在这一格给的是**跨刷新的 24 小时检测次数**
				// (`tallyWindow`),留存数 / 丢失数放进悬停(`tallyTitle`)—— 三个数各有各的名字。
				const pillTally = tallyWindow(TALLY_MINUTES * TALLY_BUCKET_MS);
				return h('div', { ref: setRoot, id: ROOT_ID, style: S.root(false) },
					h('div', { style: S.head },
						h('span', { style: S.brand }, t('title')),
						h('span', { style: { ...S.label, color: sceneChip().color } }, sceneChip().text),
						h('span', { style: { ...S.num, flex: '0 0 auto', marginLeft: 'auto', color: levelFrame(state.fps, state.frameWorst) } }, `${state.fps.toFixed(0)} fps`),
						h('span', { style: S.label }, `${t('frameWorst')} ${state.frameWorst.toFixed(0)}ms`),
						worst === null ? null : h('span', { style: S.label }, `LT ${worst.ms.toFixed(0)}ms`),
						pillTally.detected === 0 ? null : h('span', { style: S.label, title: tallyTitle(TALLY_MINUTES * TALLY_BUCKET_MS) }, `${t('watchDetected')} ${pillTally.detected}${t('times')}`),
						h('button', { type: 'button', style: S.btn, title: t('expand'), onClick: toggle }, '+'),
						h('button', { type: 'button', style: S.btn, title: t('turnOff'), onClick: () => setEnabled(false) }, t('turnOff'))));
			}

			// ── 开发者详情:原来那一整套技术数据(一个都没删),按标签页分组,一次看一组 ──
			const devFrames = [
				// ── 常显 1:当前状况(卡不卡 + 谁的锅)──
				// 块式而不是 flex 行:这一行长文本换行在右对齐下会参差得像段落(实测被吐槽)。
				// 标题里带「近 60 秒」:帧 / 长任务 / 命中三个数都是这个窗口的口径,不写出来只能猜。
				h('div', { style: S.block, title: overviewTitle() },
					h('div', { style: S.blockLabel }, `${t('overview')} · ${t('scope60s')}`),
					h('div', { style: { ...S.blockValue, color: levelFrame(state.fps, state.frameWorst) } }, `${overviewLine1()}\n${overviewLine2()}`)),

				// ── 常显 2:事故诊断入口(守夜留下的事故;严重度用**文字 + token 颜色**两样给)──
				// 这是"事故 → 帧 → 证据 → 来源/包"那条链的起点:三个按钮都是真动作(进历史事故上下文 /
				// 下载这条事故包 / 复制结论),不是装饰。默认跟最差那条 —— 「最差」不是「最近」,
				// 所以时间和"自动/已选中"都写在上面。
				h('div', { style: S.sep },
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('worstEventHint') }, t('worstEvent')),
						h('span', { style: { flex: '1 1 auto', display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 6, minWidth: 0 } },
							h('span', { style: { ...S.num, flex: '0 0 auto', color: selectedRow === null || state.watch.on === false ? 'var(--dsw-alias-label-secondary)' : severityColor(selectedLevel) }, title: t('sevBadHint') },
								eventValueText(selectedRow)),
							// 一键在「最差 / 最近」之间切"自动跟着谁":默认最差(事后回看的重点),但
							// "刚刚那一下卡在哪"同样常问 —— 两个都要够得着,又不要多一张清单。
							h('button', {
								type: 'button', style: S.btn, title: t('evScopeHint'), disabled: selectedRow === null,
								onClick: () => setIncidentScope(state.watch.scope === 'latest' ? 'worst' : 'latest'),
							}, state.watch.scope === 'latest' ? t('evWorst') : t('evLatest')))),
					selectedRow === null ? null : h('div', { style: S.sub, title: t('envPickHint') },
						`${watchSelectedText()} · ${selected.auto ? (state.watch.scope === 'latest' ? t('evAutoLatest') : t('evAutoWorst')) : t('evPinned')}`),
					// 归因状态:已确认 / 可疑 / 未归因 —— 文字与档位色两样一起给,"凭什么"单独一行
					selectedRow === null ? null : h('div', { style: S.sub, title: t('verdictLabel') }, eventEvidenceText(selectedRow)),
					selectedRow === null ? null : h('div', { style: { ...S.sub, color: verdictColor(incidentVerdict(selectedRow).level) } }, eventVerdictText(selectedRow)),
					selectedRow === null ? null : h('div', { style: S.sub }, eventWindowText(selectedRow)),
					selectedRow === null ? null : h('div', { style: S.buttons },
						// 上下文切换:**实时 ⇄ 历史事故**。两种模式各有一个"去另一边"的动作,
						// 当前在哪一边由取证明细第一行的上下文标题与这里一起说清。
						// 「复制摘要 / 导出事故包」**不在这里** —— 它们是"对这条事故做什么",属于
						// 卡顿详情那一屏自己的动作条(同一屏出现两份只会让人猜哪一份是真的)。
						diagMode() === 'incident'
							? h('button', { type: 'button', style: S.btn, title: t('backToLiveHint'), onClick: showLiveMode }, t('backToLive'))
							: h('button', { type: 'button', style: S.btn, title: t('viewEvidenceHint'), onClick: () => revealIncident(selectedRow.id) }, t('viewEvidence'))),
					state.copyNote === null ? null : h('div', { style: S.sub }, state.copyNote),
					watchFlagText() === null ? null : h('div', { style: { ...S.sub, title: t('watchHint') } }, watchFlagText())),

				// ── 常显 3:回调归因 Top3(每插件一行,hover 补 msps 与累计)──
				// 这一块**总有**:以前没插桩时整段不渲染,于是首屏根本没有"回调归因"这一层,
				// 读者分不清"没采"还是"采了是空的"。现在未插桩时降级成一行「要深录」——
				// 绝不写 `0ms/s`(那会被读成"没有开销");插桩之后 `0ms/s` 才是真的(确实没有回调跑过)。
				// 帧内未归因不在这里,它在「取证明细」(它是"解释",不是"现在卡不卡 / 谁的锅")。
				h('div', { style: S.sep },
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('blameHint') }, t('blame')),
						h('span', { style: S.num }, state.deep !== true ? t('needDeep') : msPerSecText(state.attributedPerSec))),
					state.deep !== true || top.length === 0 ? null : h('div', null, top.map((row, index) => h('div', { key: row.id, style: S.row },
						h('span', {
							style: S.label,
							title: `${row.id}\n` +
								`${t('cnExec')} ${row.cps}${t('perSec')}(${t('peak')} ${row.cpsPeak}${t('perSec')},EMA)\n` +
								`${t('cnCost')} ${row.msps}ms${t('perSec')}\n` +
								`${t('cumulative')} ${row.count}${t('times')} / ${row.ms.toFixed(0)}ms\n` +
								t('cnScope'),
						}, `${index + 1}. ${short(row.id)}`),
						h('span', { style: S.num }, attrText(row))))),
					state.deep !== true || rest.length === 0 ? null : h('div', { style: S.row },
						h('span', { style: S.label, title: restTitleText(rest) }, `${t('rest')} (${rest.length})`),
						h('span', { style: S.num }, restValueText(rest)))),

				// ── 布局工具:**按需出现**。默认布局下「全部折叠」已经没什么可收、「恢复默认布局」
				// 点了也不会变 —— 常驻两个"点了没反应"的按钮比不显示更糟,所以各自只在有意义时出现;
				// 两者都没意义时整行不渲染(首屏也就少一行)。
				(anyGroupOpen() || layoutDirty()) ? h('div', { style: { ...S.sep, display: 'flex', gap: 6 } },
					anyGroupOpen() ? h('button', { type: 'button', style: S.btn, title: t('collapseAllHint'), onClick: collapseAll }, t('collapseAll')) : null,
					layoutDirty() ? h('button', { type: 'button', style: S.btn, title: t('resetLayoutHint'), onClick: resetLayout }, t('resetLayout')) : null) : null,

				// ── 折叠 1:取证明细(最差那秒 + DOM 写入者)──
				// ⚠️ 子节点走**惰性回调**:这一组里全是"算了但不显示"的派生统计(脚本按包 /
				// 交叉表 / 帧条),折叠时连函数体都不该进(见 group() 的说明)。
				// ── 折叠 1:取证明细(实时 / 历史事故两支,**同一时间只显示一支**)──
				// 上下文只在这里分流一次:`detailContext()` 决定全部读数来自实时帧环还是事故包;
				// 渲染那侧只读它的结果 —— 所以"上面是历史事故、下面是另一条实时帧"在结构上无处发生。
				group('detail', detailGroupLabel(), detailSummary(), () => {
					const detail = detailContext();
					return detail.kind === 'incident' ? incidentDetail(detail) : liveDetail(detail);
				}),

			];
			const devDom = [
				// ── 折叠 2:DOM 与堆 ──
				group('dom', t('groupDom'), domSummary(), () => [
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
						h('span', { style: S.num }, `${mb(state.heap)}MB · ${heapRateText()}`)),
					// DOM 写入属于「DOM 与堆」,不属于「取证明细」—— 那组回答的是"这一帧的时间去哪了"。
					// 这两行只有插桩了才有意义(不插桩时计数恒为 0,那时它们只会被读成"没有开销")
					state.deep !== true ? null : h('div', { style: S.row },
						h('span', { style: S.label, title: t('domWritesHint') }, t('domWrites')),
						h('span', { style: S.num }, String(state.mutations))),
					state.deep !== true ? null : writeRows(),
				]),

			];
			const devHost = [
				// ── 折叠 3:宿主与链路(排查"是页面卡还是链路卡"才看)──
				group('host', t('groupHost'), hostSummary(), () => [
					h('div', { style: S.row },
						h('span', { style: S.label }, t('stream')),
						h('span', { style: S.num }, `${state.streaming ? t('running') : t('idle')}${state.streaming || state.idleSince === 0 ? '' : ` ${Math.round((performance.now() - state.idleSince) / 1000)}s`}${state.baselineRunning ? ` · ${t('idleBase')}…` : ''}`)),
					h('div', { style: S.row },
						h('span', { style: S.label }, `${t('hostLoop')} · ${t('verdict')}`),
						h('span', { style: { ...S.num, color: infra.color } }, infra.text)),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('hostLoop')),
						h('span', { style: { ...S.num, color: hostFresh.state === 'live' ? levelUp(hostFresh.loop.p99, 50, 200) : hostFresh.state === 'stale' || hostFresh.state === 'unreachable' ? 'var(--dsw-alias-state-warn-primary)' : undefined } },
							hostLoopStateText())),
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
						`${t('idleWriter')}: ${(idleBase.domTop ?? []).map((row) => `${short(row?.id ?? '?')}${row?.component === null || row?.component === undefined ? '' : `(${row.component})`}`).join(' / ') || t('none')}`),
				]),

			];
			const devTools = [
				// ── 折叠 4:工具箱(事故清单 / 场景标记 / 整机导出)──
				group('tools', t('groupTools'), toolsSummary(), () => [
					// 守夜层:最差几次的清单 + 手动补记 + 导出最近一次
					h('div', { style: S.row },
						h('span', { style: S.label, title: t('watchHint') }, t('watch')),
						h('span', { style: S.num }, watchPanelText())),
					// 清单按**严重度**排(不是时间序):点一条就选中它 —— 首屏「最差事件」块与
					// 「取证明细」的翻帧都跟着走。它真能导航到同一条事故,所以才做成可点的行。
					state.watch.incidents.length === 0 ? null : h('div', { title: t('envPickHint') },
						state.watch.incidents.map((row, index) => h('div', {
							key: row.id,
							style: { ...S.sub, cursor: 'pointer', fontWeight: state.watch.selId === row.id ? 700 : 400 },
							title: t('envPickHint'),
							onClick: () => selectIncident(row.id),
						}, watchRowText(row, index)))),
					h('div', { style: S.buttons },
						// 备注输入框留着:它就是「标记刚才」写进事故包的 note
						h('input', {
							type: 'text',
							value: draft,
							placeholder: t('markPlaceholder'),
							onChange: (event) => setDraft(event.target.value),
							style: S.input,
						}),
						h('button', { type: 'button', style: S.btn, disabled: state.watch.on === false, title: t('watchMarkHint'), onClick: () => { W.__perfHud.capture(draft === '' ? t('watchManualNote') : draft); setDraft(''); } }, t('watchMark'))),
					// 导出 / 清空**只在「原始数据」那一页**(见 devRaw):同四个按钮在相邻两个标签页
					// 各摆一份,点错地方只是白点一次,读的人还要先弄清两页有什么区别。
				]),
			];

			// ── 原始数据(标签页 5):导出与交接件的入口 ──
			const devRaw = [
				h('div', { style: S.row },
					h('span', { style: S.label, title: t('packFilesHint') }, t('packFilesLabel')),
					h('span', { style: S.num }, t('packFilesValue'))),
				h('div', { style: S.buttons },
					// 两条路**只差自由文本**:给 AI 的那条置空并标 noteDropped,本机调试件保留。
					// 所以标题必须自己说清是哪一条(免得"以为导出的是同一份")。
					h('button', { type: 'button', style: S.btn, title: t('exportAiHint'), disabled: selectedRow === null, onClick: () => exportPack(selectedRow === null ? 'latest' : selectedRow.id, { dropFreeText: true }) }, t('exportAiBtn')),
					h('button', { type: 'button', style: S.btn, title: t('exportFullHint'), disabled: selectedRow === null, onClick: () => exportPack(selectedRow === null ? 'latest' : selectedRow.id, { dropFreeText: false }) }, t('exportFullBtn')),
					h('button', { type: 'button', style: S.btn, disabled: selectedRow === null, onClick: () => copyText(JSON.stringify(packPreview(selectedRow === null ? 'latest' : selectedRow.id, {}), null, 2), t('exportPreviewCopy')) }, t('exportPreviewCopy'))),
				h('div', { style: S.buttons },
					h('button', { type: 'button', style: S.btn, title: t('watchExportHint'), disabled: state.watch.incidents.length === 0, onClick: () => exportIncident('latest') }, t('watchExport')),
					h('button', { type: 'button', style: S.btn, title: t('exportJsonHint'), onClick: exportJson }, t('exportJson')),
					h('button', { type: 'button', style: S.btn, title: t('clearHint'), onClick: () => W.__perfHud.clear() }, t('clear'))),
				h('div', { style: S.sub, title: t('storageKeysHint') }, t('storageKeys')),
			];

			// ── 一次只渲染一个视图 ──
			const trend = trendSummary(state.trendMs);
			const devKids = state.devTab === 'dom' ? devDom
				: state.devTab === 'host' ? devHost
					: state.devTab === 'tools' ? devTools
						: state.devTab === 'raw' ? devRaw : devFrames;
			// ⚠️ 三个视图**只在被选中时才构造**:`incidentDetail(detailContext())` 要求"现在真的在
			// 历史上下文里",无条件先算一遍会在实时上下文中拿不到 row 直接抛错(实测过:面板整块不渲染,
			// 离线三套件全绿,只有 check-panel 抓得到)。这里的写法本身也是"没用到的视图不做工"。
			// 两个语义在这里就分开:`latestRow` 给主界面(时间最新),`selectedRow` 给开发者详情
			// (默认最差 / 用户手选)。刻意不共用一个变量 —— 共用就会有人把最差显示成"最近一次"。
			const latestRow = latestIncident();
			const body = h('div', null,
				view === 'main' ? mainView({
					health: healthVerdict(),
					latest: latestRow,
					trendMs: state.trendMs,
					why: state.causeOpen,
					preview: state.packPreview !== null && latestRow !== null && state.packPreview.incident.id === latestRow.id ? state.packPreview : null,
					onOpen: (id) => { setView('incident'); revealIncident(id); },
					onExportPreview: (id) => { openPackPreview(id, { dropFreeText: true }); },
					onExportGo: () => {
						const id = state.packPreviewId;
						closePackPreview();
						exportPack(id, { dropFreeText: true });
					},
					onExportCancel: closePackPreview,
					onWhy: setCauseOpen,
					onRange: setTrendMs,
					onDev: () => setView('dev'),
				}) : null,
				view === 'incident' ? incidentDetail(detailContext()) : null,
				view === 'dev' ? h('div', null, devTabRow({ tab: state.devTab, onTab: setDevTab }), devKids) : null,
				view === 'settings' ? settingsView({
					trend,
					onClearIncidents: () => { clearIncidentsNow(); },
					onClearAll: () => { W.__perfHud.clear(); },
				}) : null);

			// 自带边界:渲染抛错时只降级成一块小面板,不让外壳把整个条目停用。
			return h(HudBoundary, { renderError: renderErrorView },
				h('div', { ref: setRoot, id: ROOT_ID, style: S.root(true) }, head, body,
					state.stressNodes > 0 ? h(PerfHudStress, { count: Math.min(state.stressNodes, 6000) }) : null));
		}

		/**
		 * 面板自己的控件态样式(hover / focus-visible / disabled)。
		 *
		 * 只用一条**纯 CSS** 规则,不挂任何 React 鼠标事件 —— 2026-10-08 那次"鼠标指到交叉表
		 * 行标签,外壳就把整个条目停用"的根因至今没查出来,所以在复现之前**不加 per-element
		 * 鼠标状态**(渲染区里一个 per-element 鼠标事件处理都没有,有静态断言钉着)。CSS 的 :hover 不执行
		 * 任何 JS,与那次的事故形态不是一回事;它只给点击控件一个可见的反馈。
		 */
		function installStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			try {
				const style = document.createElement('style');
				style.id = STYLE_ID;
				// ⚠️ 面板的控件样式**全在行内**(S.btn),行内样式优先于样式表 —— 所以这三条
				// 要覆盖它必须 `!important`。这是有意为之的例外,不是懒得改行内。
				style.textContent = [
					`#${ROOT_ID} button { transition: border-color .12s ease, color .12s ease; }`,
					`#${ROOT_ID} button:hover:not(:disabled) { border-color: var(--dsw-alias-state-business-primary) !important; color: var(--dsw-alias-state-business-primary) !important; }`,
					`#${ROOT_ID} button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }`,
					`#${ROOT_ID} button:disabled { opacity: .45 !important; cursor: default !important; }`,
				].join('\n');
				document.head.appendChild(style);
			} catch (error) { /* 样式装不上不影响功能,面板照旧可用 */ }
		}

		// ───────────────────────────────── 装配 ─────────────────────────────────
		function apply(ctx) {
			state.since = Date.now();
			installStyle();
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

			// 快捷键:可选注入 —— shortcuts 服务不在时插件照常工作,只是没有这个键。
			// 走平台命令仲裁(而不是裸 keydown),这样输入框 / 终端 / 其它插件的绑定不会被抢。
			ctx.inject(['shortcuts'], (shortcutCtx) => {
				const shortcuts = shortcutCtx.shortcuts;
				if (shortcuts === null || shortcuts === undefined || typeof shortcuts.register !== 'function') return;
				shortcutCtx.effect(() => shortcuts.register({
					id: 'perf-hud.toggle',
					label: () => translate('shortcutToggle'),
					aliases: ['perf', 'hud', 'fps'],
					// Linux Web 的快捷键只允许极少数组合,不硬塞一个不可用的绑定;
					// macOS / Windows 用 Cmd/Ctrl+Shift+U(KeyH 等被平台保留,不能占用)。
					defaults: {
						'web:macos': { code: 'KeyU', modifiers: ['primary', 'shift'] },
						'web:windows': { code: 'KeyU', modifiers: ['primary', 'shift'] },
					},
					regions: ['page', 'editable', 'terminal'],
					modals: [],
					resolve: () => ({
						status: 'handled',
						run: () => {
							if (typeof state.toggleHud !== 'function') return;
							state.toggleHud();
						},
					}),
				}), 'perf-hud: shortcut');
			});

			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: PKG,
				order: 100,
			}, PerfHud));
		}

		return { inject: ['slots'], apply };
	},
});
