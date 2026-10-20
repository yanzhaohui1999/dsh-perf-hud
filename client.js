/**
 * dsh-perf-hud — 浏览器端性能 HUD(纯客户端)。
 *
 * 浏览器半由五个文件组成(DSH 的包内分片,零构建):
 *   client.js        采集 / 归因 / 守夜捕获 / 宿主探针 / apply(+ 模型层同步包装)
 *   client.model.js  证据链 / 能力矩阵 / 可能原因 / 诊断包 / 视图模型(159 个函数)
 *   client.ui.js     渲染层(四视图 + 各 block)
 *   client.pack.js   zip(store 模式)
 *   client.tools.js  隔离实验(首次调用才加载)
 * 分片用 require.async 装载、factory(require) 注册;依赖一律显式传入
 * (createModel / createUi / createToolsApi),不做反向 import。
 *
 * Host 侧(index.js)是可选的:它只提供 perf_hooks 事件循环采样与一个
 * /api/dsh-perf-hud/host 路由(事件循环读数、session/event 到达延迟、bundle
 * 读写代理)。宿主半没加载时面板照常工作,只是那三处显示不可用并写明原因。
 * 仪表固定在右下角(实时 fps + 插桩状态药丸),展开后是完整面板。
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

		// ───────────────────────── 归因:script URL → 插件 id ─────────────────────────
		// 默认栈深 10 帧,插件把调度藏在几层包装后面时会丢归属;抬到 30 帧。
		// 只影响错误对象的栈深度,不影响性能测量本身。
		if (typeof Error.stackTraceLimit === 'number' && Error.stackTraceLimit < 30) Error.stackTraceLimit = 30;

		const PLUGIN_URL = /(?:^|\/)plugins\/(?:\?\?([^&]+)|((?:@[^/?#]+\/)?[^/?#]+)\/[^?#]*)/;

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

		// ──────── A2. LoAF 脚本 → 包名:字符位置 → 行号 → 分段表 ────────
		// LoAF 的 scripts[] 给的是「合并批 URL + 字符位置」,而包名藏在合并批里(见 docs/mechanisms.md)。
		// 单包 URL 直接从 URL 读得出包名;多包 URL 必须把字符位置换算成行号,再查分段表。
		// 换算要那段脚本文本(同源 fetch,浏览器内存缓存命中),所以后台预取一次、按 URL 缓存。
		const scriptLines = new Map();   // url -> { state, starts, reason }
		const SCRIPT_LINES_MAX = 8;      // 有界:实测一个会话里真正出现的合并批只有一两个

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
		// ───────────────────── 诊断 / 视图模型:在 client.model.js 分片里 ─────────────────────
		let modelFactory = null;
		let modelApi = null;
		let modelPromise = null;
		function modelDeps() {
			return {
				BUNDLE_PREFIX,
				CAUSE_MAX,
				CROSS_SUMMARY_NAME_MAX,
				CROSS_SUMMARY_SRC_MAX,
				EVIDENCE_MAX,
				EXPERIMENT_LOAD_BURN_MS,
				MIN_PANEL_WIDTH,
				PANEL_WIDTH,
				PILL_COMPACT_BELOW,
				EXPERIMENT_LOAD_PERIOD_MS,
				FETCH_TIMEOUT_MS,
				FREE_TEXT_KEYS,
				HOME_PATH,
				HOST_ROUTE,
				LS_MAP,
				LS_MAP_INDEX,
				MAP_CACHE_MAX,
				MUT_SAMPLE,
				PACK_SCHEMA_VERSION,
				PAGE_KEYS,
				PICK_MIN_MS,
				PKG,
				PLUGIN_URL,
				REPLAY_COLS,
				SCRIPT_LINES_MAX,
				SCRIPT_URL_KEYS,
				SECRET_PARAM,
				SECRET_PARAM_NAMES,
				SPARK_COLORS,
				SPARK_HEIGHT,
				SPARK_MAX_MS,
				SPARK_SECONDS,
				TALLY_BUCKET_MS,
				TALLY_MINUTES,
				TARGETS,
				TOP_N,
				W,
				WATCH_DAILY_DAYS,
				WATCH_EVENT_MS,
				WATCH_GAP_MS,
				WATCH_INCIDENT_MAX,
				WATCH_KEEP_MAX,
				WATCH_POST_MS,
				WATCH_PRE_MS,
				WATCH_REACTION_MS,
				WATCH_TRIGGER_MS,
				WIN_HOME_PATH,
				blame,
				blameText,
				bundleMaps,
				bundleMeta,
				clipName,
				clock,
				docLang,
				domWriteTable,
				experiment,
				fallback,
				flush,
				frame,
				frameRing,
				h,
				hostFreshness,
				hostLoopText,
				incidentTallyCache,
				linkRowText,
				linkStats,
				loafScripts,
				longTaskTally,
				markResolved,
				natives,
				noiseFloor,
				perfOrigin,
				pluginTable,
				primaryBlame,
				push,
				rate,
				rateText,
				ring,
				round1,
				scriptLines,
				scriptTallyCache,
				selectIncidentFrame,
				selfStats,
				sessionBaselines,
				setPrecise,
				short,
				start,
				state,
				stop,
				suspectLink,
				tallyReport,
				tallyWindow,
				translate: (key) => translate(key),
				verification,
				viaLabel,
				wallClock,
				watchStatus,
				worstLongTask,
				zipStore,
				resolveStamp: () => resolveSeq,
			};
		}
		function model() {
			if (modelApi !== null) return modelApi;
			if (modelFactory === null) throw new Error('perf-hud: client.model.js 还没加载完');
			modelApi = modelFactory.createModel(modelDeps());
			return modelApi;
		}
		function loadModel() {
			if (modelApi !== null) return Promise.resolve(modelApi);
			if (modelPromise === null) {
				modelPromise = require.async('./client.model.js').then((module) => {
					modelFactory = module;
					return model();
				}, (error) => {
					modelPromise = null;
					state.errors.push({ at: Date.now(), where: 'model-chunk', message: String(error) });
					throw error;
				});
			}
			return modelPromise;
		}
		// ───────────── 守夜层:在 client.watch.js 分片里 ─────────────
		let watchFactory = null;
		let watchApi = null;
		let watchPromise = null;
		function watchDeps() {
			return {
				BUNDLE_PREFIX,
				LS_INCIDENTS,
				W,
				WATCH_DAILY_DAYS,
				WATCH_EVENT_MAX,
				WATCH_EVENT_MS,
				WATCH_FRAMES,
				WATCH_GAP_MS,
				WATCH_INCIDENT_MAX,
				WATCH_KEEP_MAX,
				WATCH_LOAF_MAX,
				WATCH_PERSIST_MAX_BYTES,
				WATCH_POST_MS,
				WATCH_PRE_MS,
				WATCH_REACTION_MS,
				WATCH_SCRIPT_MAX,
				WATCH_TRIGGER_MS,
				bumpTally,
				bundleMap,
				ensureScriptLines,
				frame,
				frameRing,
				natives,
				noteTallySeverity,
				ownerOfUrl,
				push,
				ring,
				round1,
				scriptEvidence,
				start,
				state,
			};
		}
		function watch() {
			if (watchApi !== null) return watchApi;
			if (watchFactory === null) throw new Error('perf-hud: client.watch.js 还没加载完');
			watchApi = watchFactory.createWatch(watchDeps());
			return watchApi;
		}
		function loadWatch() {
			if (watchApi !== null) return Promise.resolve(watchApi);
			if (watchPromise === null) {
				watchPromise = require.async('./client.watch.js').then((module) => {
					watchFactory = module;
					return watch();
				}, (error) => {
					watchPromise = null;
					state.errors.push({ at: Date.now(), where: 'watch-chunk', message: String(error) });
					throw error;
				});
			}
			return watchPromise;
		}
		function watchTrigger(...args) { return watch().watchTrigger(...args); }
		function perfOrigin(...args) { return watch().perfOrigin(...args); }
		function wallClock(...args) { return watch().wallClock(...args); }
		function loafScripts(...args) { return watch().loafScripts(...args); }
		function watchLoaf(...args) { return watch().watchLoaf(...args); }
		function startLoaf(...args) { return watch().startLoaf(...args); }
		function watchInteraction(...args) { return watch().watchInteraction(...args); }
		function startInteractions(...args) { return watch().startInteractions(...args); }
		function watchFrame(...args) { return watch().watchFrame(...args); }
		function triggerCapture(...args) { return watch().triggerCapture(...args); }
		function keepIncident(...args) { return watch().keepIncident(...args); }
		function dayKeyOf(...args) { return watch().dayKeyOf(...args); }
		function pruneIncidents(...args) { return watch().pruneIncidents(...args); }
		function windowIntegrity(...args) { return watch().windowIntegrity(...args); }
		function assembleIncident(...args) { return watch().assembleIncident(...args); }
		function settleCapture(...args) { return watch().settleCapture(...args); }
		function saveIncidents(...args) { return watch().saveIncidents(...args); }
		function restoreIncidents(...args) { return watch().restoreIncidents(...args); }
		function captureNow(...args) { return watch().captureNow(...args); }
		function watchStatus(...args) { return watch().watchStatus(...args); }

		function timeoutError(...args) { return model().timeoutError(...args); }
		function cancelledError(...args) { return model().cancelledError(...args); }
		function isAbortError(...args) { return model().isAbortError(...args); }
		function fetchFailureText(...args) { return model().fetchFailureText(...args); }
		function fetchTextWithin(...args) { return model().fetchTextWithin(...args); }
		function fetchJsonWithin(...args) { return model().fetchJsonWithin(...args); }
		function ownerOfUrl(...args) { return model().ownerOfUrl(...args); }
		function absolutePluginUrl(...args) { return model().absolutePluginUrl(...args); }
		function mapUrlOf(...args) { return model().mapUrlOf(...args); }
		function sectionName(...args) { return model().sectionName(...args); }
		function bundleMetaOf(...args) { return model().bundleMetaOf(...args); }
		function bundleLabel(...args) { return model().bundleLabel(...args); }
		function bundleMap(...args) { return model().bundleMap(...args); }
		function readMapIndex(...args) { return model().readMapIndex(...args); }
		function writeMapIndex(...args) { return model().writeMapIndex(...args); }
		function pruneMapIndex(...args) { return model().pruneMapIndex(...args); }
		function evictMapEntries(...args) { return model().evictMapEntries(...args); }
		function touchMapCache(...args) { return model().touchMapCache(...args); }
		function saveMapCache(...args) { return model().saveMapCache(...args); }
		function pruneMapCache(...args) { return model().pruneMapCache(...args); }
		function loadBundleMap(...args) { return model().loadBundleMap(...args); }
		function loadBundleMapByProbe(...args) { return model().loadBundleMapByProbe(...args); }
		function sectionSource(...args) { return model().sectionSource(...args); }
		function sectionIndex(...args) { return model().sectionIndex(...args); }
		function sectionOwner(...args) { return model().sectionOwner(...args); }
		function sectionPath(...args) { return model().sectionPath(...args); }
		function resolveOwner(...args) { return model().resolveOwner(...args); }
		function primeBundleMaps(...args) { return model().primeBundleMaps(...args); }
		function loadScriptLines(...args) { return model().loadScriptLines(...args); }
		function ensureScriptLines(...args) { return model().ensureScriptLines(...args); }
		function scriptLineOf(...args) { return model().scriptLineOf(...args); }
		function packageOfScript(...args) { return model().packageOfScript(...args); }
		function scriptPosition(...args) { return model().scriptPosition(...args); }
		function viaText(...args) { return model().viaText(...args); }
		function scriptEvidence(...args) { return model().scriptEvidence(...args); }
		function evidenceName(...args) { return model().evidenceName(...args); }
		function evidencePlace(...args) { return model().evidencePlace(...args); }
		function evidenceWhereText(...args) { return model().evidenceWhereText(...args); }
		function evidenceLine(...args) { return model().evidenceLine(...args); }
		function incidentScriptEvidence(...args) { return model().incidentScriptEvidence(...args); }
		function incidentEvidenceAt(...args) { return model().incidentEvidenceAt(...args); }
		function incidentEvidenceLines(...args) { return model().incidentEvidenceLines(...args); }
		function evidenceScope(...args) { return model().evidenceScope(...args); }
		function evidenceZeroText(...args) { return model().evidenceZeroText(...args); }
		function locatable(...args) { return model().locatable(...args); }
		function evidenceFooter(...args) { return model().evidenceFooter(...args); }
		function evidenceFooterTitle(...args) { return model().evidenceFooterTitle(...args); }
		function significance(...args) { return model().significance(...args); }
		function worstSecond(...args) { return model().worstSecond(...args); }
		function provenanceOf(...args) { return model().provenanceOf(...args); }
		function capabilities(...args) { return model().capabilities(...args); }
		function capabilityMissing(...args) { return model().capabilityMissing(...args); }
		function provenanceText(...args) { return model().provenanceText(...args); }
		function strengthText(...args) { return model().strengthText(...args); }
		function causeCandidates(...args) { return model().causeCandidates(...args); }
		function manifestFor(...args) { return model().manifestFor(...args); }
		function diagnosticSummary(...args) { return model().diagnosticSummary(...args); }
		function packReadme(...args) { return model().packReadme(...args); }
		function buildPack(...args) { return model().buildPack(...args); }
		function packPreview(...args) { return model().packPreview(...args); }
		function exportPack(...args) { return model().exportPack(...args); }
		function scrubParams(...args) { return model().scrubParams(...args); }
		function redactPageUrl(...args) { return model().redactPageUrl(...args); }
		function redactScriptUrl(...args) { return model().redactScriptUrl(...args); }
		function redactPath(...args) { return model().redactPath(...args); }
		function redactUserAgent(...args) { return model().redactUserAgent(...args); }
		function redactExport(...args) { return model().redactExport(...args); }
		function redactionReport(...args) { return model().redactionReport(...args); }
		function snapshot(...args) { return model().snapshot(...args); }
		function exportJson(...args) { return model().exportJson(...args); }
		function pickIncident(...args) { return model().pickIncident(...args); }
		function incidentReport(...args) { return model().incidentReport(...args); }
		function incidentFileName(...args) { return model().incidentFileName(...args); }
		function exportIncident(...args) { return model().exportIncident(...args); }
		function severityLevel(...args) { return model().severityLevel(...args); }
		function severityText(...args) { return model().severityText(...args); }
		function severityColor(...args) { return model().severityColor(...args); }
		function incidentOwner(...args) { return model().incidentOwner(...args); }
		function selectedIncident(...args) { return model().selectedIncident(...args); }
		function diagMode(...args) { return model().diagMode(...args); }
		function incidentFrameRows(...args) { return model().incidentFrameRows(...args); }
		function incidentLoafAt(...args) { return model().incidentLoafAt(...args); }
		function incidentWorstFrame(...args) { return model().incidentWorstFrame(...args); }
		function selectedIncidentFrame(...args) { return model().selectedIncidentFrame(...args); }
		function incidentFrameLevel(...args) { return model().incidentFrameLevel(...args); }
		function incidentFrameHot(...args) { return model().incidentFrameHot(...args); }
		function incidentFrameNav(...args) { return model().incidentFrameNav(...args); }
		function incidentFrameStep(...args) { return model().incidentFrameStep(...args); }
		function incidentVerdict(...args) { return model().incidentVerdict(...args); }
		function verdictColor(...args) { return model().verdictColor(...args); }
		function eventEvidenceText(...args) { return model().eventEvidenceText(...args); }
		function eventVerdictText(...args) { return model().eventVerdictText(...args); }
		function eventWindowText(...args) { return model().eventWindowText(...args); }
		function incidentSummaryText(...args) { return model().incidentSummaryText(...args); }
		function attrText(...args) { return model().attrText(...args); }
		function restValueText(...args) { return model().restValueText(...args); }
		function restTitleText(...args) { return model().restTitleText(...args); }
		function msPerSecText(...args) { return model().msPerSecText(...args); }
		function sceneChip(...args) { return model().sceneChip(...args); }
		function unexplainedFrame(...args) { return model().unexplainedFrame(...args); }
		function infraVerdict(...args) { return model().infraVerdict(...args); }
		function overviewLine1(...args) { return model().overviewLine1(...args); }
		function overviewLine2(...args) { return model().overviewLine2(...args); }
		function frameSplit(...args) { return model().frameSplit(...args); }
		function splitLegend(...args) { return model().splitLegend(...args); }
		function frameArcs(...args) { return model().frameArcs(...args); }
		function frameMixNow(...args) { return model().frameMixNow(...args); }
		function frameMixCountText(...args) { return model().frameMixCountText(...args); }
		function frameMixRows(...args) { return model().frameMixRows(...args); }
		function hudDodge(...args) { return model().hudDodge(...args); }
		function panelWidthFor(...args) { return model().panelWidthFor(...args); }
		function pillCompact(...args) { return model().pillCompact(...args); }
		function frameSeverity(...args) { return model().frameSeverity(...args); }
		function worstLoaf(...args) { return model().worstLoaf(...args); }
		function loafRanks(...args) { return model().loafRanks(...args); }
		function pickList(...args) { return model().pickList(...args); }
		function pickedLoaf(...args) { return model().pickedLoaf(...args); }
		function sparkBars(...args) { return model().sparkBars(...args); }
		function sparkPickMap(...args) { return model().sparkPickMap(...args); }
		function sparkCellTitle(...args) { return model().sparkCellTitle(...args); }
		function replayScope(...args) { return model().replayScope(...args); }
		function replayX(...args) { return model().replayX(...args); }
		function replaySummaryText(...args) { return model().replaySummaryText(...args); }
		function incidentWallClock(...args) { return model().incidentWallClock(...args); }
		function replayColumns(...args) { return model().replayColumns(...args); }
		function replayCellTitle(...args) { return model().replayCellTitle(...args); }
		function incidentScriptOf(...args) { return model().incidentScriptOf(...args); }
		function incidentFrameTally(...args) { return model().incidentFrameTally(...args); }
		function incidentWindowTally(...args) { return model().incidentWindowTally(...args); }
		function incidentFrameEvidenceRows(...args) { return model().incidentFrameEvidenceRows(...args); }
		function incidentLongTasksAt(...args) { return model().incidentLongTasksAt(...args); }
		function incidentFrameHeadingText(...args) { return model().incidentFrameHeadingText(...args); }
		function liveFrameHeadingText(...args) { return model().liveFrameHeadingText(...args); }
		function detailContext(...args) { return model().detailContext(...args); }
		function sparkLevel(...args) { return model().sparkLevel(...args); }
		function invokerLabel(...args) { return model().invokerLabel(...args); }
		function tallyScripts(...args) { return model().tallyScripts(...args); }
		function jsBreakdownText(...args) { return model().jsBreakdownText(...args); }
		function spanText(...args) { return model().spanText(...args); }
		function windowScopeText(...args) { return model().windowScopeText(...args); }
		function scriptPkgTally(...args) { return model().scriptPkgTally(...args); }
		function framePkgTally(...args) { return model().framePkgTally(...args); }
		function unresolvedLabel(...args) { return model().unresolvedLabel(...args); }
		function isShellScript(...args) { return model().isShellScript(...args); }
		function shellSummary(...args) { return model().shellSummary(...args); }
		function longTaskLabel(...args) { return model().longTaskLabel(...args); }
		function evidenceLocatable(...args) { return model().evidenceLocatable(...args); }
		function whoRows(...args) { return model().whoRows(...args); }
		function barSegments(...args) { return model().barSegments(...args); }
		function crossSummary(...args) { return model().crossSummary(...args); }
		function crossTable(...args) { return model().crossTable(...args); }
		function crossSingleText(...args) { return model().crossSingleText(...args); }
		function sparkStrip(...args) { return model().sparkStrip(...args); }
		function unattrText(...args) { return model().unattrText(...args); }
		function hitText(...args) { return model().hitText(...args); }
		function detailSummary(...args) { return model().detailSummary(...args); }
		function domSummary(...args) { return model().domSummary(...args); }
		function hostSummary(...args) { return model().hostSummary(...args); }
		function toolsSummary(...args) { return model().toolsSummary(...args); }
		function watchPanelText(...args) { return model().watchPanelText(...args); }
		function watchSelectedText(...args) { return model().watchSelectedText(...args); }
		function watchFlagText(...args) { return model().watchFlagText(...args); }
		function eventValueText(...args) { return model().eventValueText(...args); }
		function watchRowText(...args) { return model().watchRowText(...args); }
		function overviewTitle(...args) { return model().overviewTitle(...args); }
		function containerNodes(...args) { return model().containerNodes(...args); }
		function displayKey(...args) { return model().displayKey(...args); }
		function bump(...args) { return model().bump(...args); }
		function anyGroupOpen(...args) { return model().anyGroupOpen(...args); }
		function layoutDirty(...args) { return model().layoutDirty(...args); }

		// 包内分片 `client.pack.js` 的 exports(诊断包 / zip / 导出),由 PerfHudGate 加载。
		let packApi = null;
		// 渲染层分片 `client.ui.js` 的 exports(由 PerfHudGate 加载)。
		let uiApi = null;
		// 包内分片 `client.tools.js` 的 exports(隔离实验等控制台工具),首次调用时懒加载。
		let toolsApi = null;
		let toolsLoading = null;
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

		// 守夜层的实现在 client.watch.js 分片里;下面只留同名同步包装。
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

		const pad = (value) => String(value).padStart(2, '0');
		const clock = (ms) => {
			const date = new Date(ms);
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		};
		const mb = (bytes) => (bytes / 1048576).toFixed(1);

		// ───────── 可能原因 / 诊断包 / 导出脱敏:实现在 client.model.js 分片里 ─────────
		const CAUSE_MAX = 3;

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
		// ───────────── zip 包装 / 面板状态 / 选择上下文 / 启停 ─────────────
		// 这里只留同步包装:PerfHudGate 保证面板渲染前分片已到位,所以按钮 / 导出路径调用时
		// packApi 一定非 null;控制台在分片到位前调用会拿到明确的错误,不静默失败。
		function packGuard() {
			if (packApi === null) throw new Error('perf-hud: client.pack.js 还没加载完');
			return packApi;
		}
		function zipStore(files, atMs) { return packGuard().zipStore(files, atMs); }
		function zipBase64(bytes) { return packGuard().zipBase64(bytes); }

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

		// 按键分派:页面地址与脚本地址的规则不同(前者丢查询串,后者要留 rev)
		const PAGE_KEYS = new Set(['page', 'href']);
		const SCRIPT_URL_KEYS = new Set(['url', 'urls', 'sourceURL', 'scriptUrl']);
		const FREE_TEXT_KEYS = new Set(['note']);

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

		/** 选中一条历史帧(点帧条 / 翻帧共用)。 */
		function selectIncidentFrame(t) {
			state.watch.frameT = typeof t === 'number' && Number.isFinite(t) ? t : null;
			state.copyNote = null;
			saveWatchUI();
			bump();
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

		/**
		 * 懒加载控制台工具分片。只有 `__perfHud.experiment()` 会走到这里 —— 不跑实验就
		 * 永远不下载 `client.tools.js`,也不占主文件。失败记进 `state.errors` 并原样抛回,
		 * 让控制台看到原因,不静默变成"实验没反应"。
		 */
		function loadTools() {
			if (toolsApi !== null) return Promise.resolve(toolsApi);
			if (toolsLoading === null) {
				toolsLoading = require.async('./client.tools.js').then((module) => {
					toolsApi = module.createToolsApi({
						state, experiment, translate, PKG, bundleOp, measureWindow, sleep,
						pickExperimentCandidates, experimentDelta, noiseFloor, significance, natives,
						STEP_MS, BRACKET_MS, EXPERIMENT_IDLE_WAIT_MS, EXPERIMENT_LOAD_BURN_MS,
						EXPERIMENT_LOAD_PERIOD_MS, IDLE_GAP_MS,
					});
					return toolsApi;
				}, (error) => {
					toolsLoading = null;
					state.errors.push({ at: Date.now(), where: 'tools-chunk', message: String(error) });
					throw error;
				});
			}
			return toolsLoading;
		}

		/** 中止实验:分片没加载过 ⇒ 没有在跑的实验,直接返回 false。 */
		function abortExperiment() {
			return toolsApi === null ? false : toolsApi.abortExperiment();
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
			experiment: (...args) => loadTools().then((tools) => tools.runExperiment(...args)),
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
		 * 事故**窗口**的脚本聚合(整份事故包里的脚本累计)。按事故 id 缓存 —— 每 tick 重算
		 * 几百条脚本会让面板自己变成新的开销(与实时窗口聚合同一个理由)。
		 */
		const incidentTallyCache = { id: null, value: null };
		/**
		 * 窗口聚合(最近 WATCH_LOAF_MAX 条 LoAF):按窗口指纹缓存 —— 每 tick 重算
		 * 200×12 条脚本,会让面板自己变成新的开销。
		 */
		const scriptTallyCache = { stamp: null, value: null };
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
		// 词典在 client.i18n.js 分片里(纯数据);`translate` 保持晚绑定,注册后再指向真实现。
		let DICT = null;
		let translate = (key) => key;
		function loadI18n() {
			if (DICT !== null) return Promise.resolve(DICT);
			if (i18nPromise === null) {
				i18nPromise = require.async('./client.i18n.js').then((module) => {
					DICT = module.DICT;
					translate = fallback;
					return DICT;
				}, (error) => {
					i18nPromise = null;
					state.errors.push({ at: Date.now(), where: 'i18n-chunk', message: String(error) });
					throw error;
				});
			}
			return i18nPromise;
		}
		let i18nPromise = null;
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

		// ─────────────────────────────── 面板(React) ───────────────────────────────
		// 面板排版:文案走 UI 字体、数字走等宽字体;关键字加粗,数值一律 600+ 权重;
		// 分割线用更实的 border-l2(原来的 l1 太淡);所有文字都允许换行,不做省略号截断。
		const UI_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
		const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

		// 面板宽度**只有一个来源**(展开态与错误降级态都用它 —— 以前是 396 / 380 两个字面量),
		// 而且**随视口收**:真宽度走 `panelWidthFor(innerWidth)`(手机上 396 会溢出去)。
		const PANEL_WIDTH = 396;
		// 窄屏分界(< 这个宽度药丸转紧凑档、丢掉「检测 N 次」):整条读数实测要 ~425px,
		// 加两边各 12 的边距 → 放不下就得让一格。
		const PILL_COMPACT_BELOW = 480;
		// 面板再窄也得放得下标题与两个按钮。
		const MIN_PANEL_WIDTH = 240;

		const S = {
			root: (open, width) => ({
				position: 'fixed', right: 12, bottom: 12, zIndex: 60, pointerEvents: 'auto',
				// 整数 px + 整数权重:11.5px / 650 这种分数值在 125%~150% 显示缩放下会被
				// 浏览器合成加粗并重新栅格化,观感发糊 —— "糊糊的"最常见的来源。
				font: `13px/1.5 ${UI_FONT}`,
				background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-primary)',
				border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
				boxShadow: '0 10px 30px rgba(0,0,0,.28)', boxSizing: 'border-box',
				...(open
					? {
						width, maxHeight: '82vh', padding: '10px 12px',
						// **头部常驻**:面板自己**不滚**,只有正文那一块滚(见 S.scroll)。以前
						// `overflowY: auto` 挂在根节点上,滚轮滚走的是整块 —— 卡顿详情展开
						// 「技术细节」之后必然要滚,于是「收起 / 关闭」跟着标题栏一起滚没了。
						display: 'flex', flexDirection: 'column', overflow: 'hidden',
					}
					// 收起态/已关态**不设宽度**:内容多宽就多宽(chip 才是它该有的样子),
					// 只封顶 —— 药丸那一长条读数在宽屏上会比展开态还宽(实测 425),窄屏上不能溢出去。
					: { maxWidth: width, padding: '6px 10px' }),
			}),
			// 正文滚动区:展开态唯一的滚动容器(`minHeight: 0` 是 flex 子项能滚起来的前提)。
			scroll: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden' },
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
				style: S.root(true, panelWidthFor(W.innerWidth)),
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

		/** 状态图标(图形,不走词典 —— 它不是文案,是记号;颜色与文字两样一起给,见 docs/reading-panel.md)。 */
		function healthIcon(level) {
			if (level === 'ok') return '✓';
			if (level === 'stall') return '!';
			return '—';
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

		/**
		 * 分片闸门:**先把 `client.pack.js` 拉到位,再渲染面板**。
		 *
		 * 为什么不"先渲染、后台补 API":pack / zip / 导出是一批**同步**函数,面板上的按钮
		 * 点了就该有结果;先渲染再异步补 API,会在分片没到位时造出一排点了没反应的按钮。
		 * 加载失败不阻塞面板:错误记进 `state.errors`(导出件里能读到),照常渲染主界面。
		 */
		function detailGroupLabel() {
			const row = diagMode() === 'incident' ? selectedIncident().row : null;
			return row === null ? translate('groupDetail') : `${translate('groupDetail')} · ${row.id}`;
		}

		function PerfHudGate() {
			const [ready, setReady] = React.useState(false);
			React.useEffect(() => {
				let alive = true;
				Promise.all([
					loadI18n(),
					loadModel(),
					loadWatch(),
					require.async('./client.pack.js'),
					require.async('./client.ui.js'),
				]).then(([, , modelApiReady, pack, ui]) => {
					packApi = pack;
					uiApi = ui.createUi({
						translate: (key) => translate(key),
						detailGroupLabel,
						EVIDENCE_MAX,
				LS_UI,
				MONO_FONT,
				panelWidthFor,
				pillCompact,
				PICK_MIN_MS,
				REPLAY_COLS,
				ROOT_ID,
				React,
				S,
				SPARK_COLORS,
				SPARK_MAX_MS,
				SPARK_REPLAY_HEIGHT,
				TALLY_BUCKET_MS,
				TALLY_MINUTES,
				TALLY_TREND_LONG_MS,
				TALLY_TREND_SHORT_MS,
				TARGETS,
				TOP_N,
				W,
				anyGroupOpen,
				attrText,
				barSegments,
				blame,
				bump,
				causeCandidates,
				causePlainLead,
				clearIncidentsNow,
				clock,
				collapseAll,
				copyText,
				crossSummary,
				crossTable,
				detailContext,
				detailSummary,
				diagMode,
				displayKey,
				domSummary,
				eventEvidenceText,
				eventValueText,
				eventVerdictText,
				eventWindowText,
				evidenceFooter,
				evidenceFooterTitle,
				evidenceLine,
				evidenceName,
				evidenceScope,
				evidenceWhereText,
				evidenceZeroText,
				exportIncident,
				exportJson,
				exportPack,
				frame,
				frameArcs,
				frameMixNow,
				frameMixCountText,
				frameMixRows,
				frameRing,
				group,
				h,
				healthIcon,
				healthText,
				healthVerdict,
				heapRateText,
				hitText,
				hostEventsText,
				hostFreshness,
				hostLoopStateText,
				hostSummary,
				hudDodge,
				incidentFrameHeadingText,
				incidentFrameStep,
				incidentLongTasksAt,
				incidentSummaryText,
				incidentVerdict,
				incidentWallClock,
				infraVerdict,
				jsBreakdownText,
				lastStallSubText,
				latestIncident,
				layoutDirty,
				levelFrame,
				levelUp,
				linkRowText,
				linkStats,
				liveFrameHeadingText,
				longTaskTally,
				mb,
				msPerSecText,
				natives,
				overviewLine1,
				overviewLine2,
				overviewTitle,
				packPreview,
				pickAuto,
				pickList,
				pickStep,
				pickedLoaf,
				pluginTable,
				provenanceText,
				push,
				rateText,
				recordError,
				recorderText,
				renderErrorView,
				HudBoundary,
				replayCellTitle,
				replayColumns,
				replayScope,
				replaySummaryText,
				replayX,
				resetLayout,
				restTitleText,
				restValueText,
				revealIncident,
				ring,
				sceneChip,
				secondsText,
				selectIncident,
				selectIncidentFrame,
				selectedIncident,
				setCauseOpen,
				setDeep,
				setDevTab,
				setEnabled,
				setIncidentScope,
				setOnlyBad,
				shellSummary,
				longTaskLabel,
				evidenceLocatable,
				crossSingleText,
				setTrendMs,
				setView,
				severityColor,
				severityLevel,
				severityText,
				short,
				showLiveMode,
				sparkStrip,
				splitLegend,
				state,
				strengthText,
				suspectLink,
				tallyTitle,
				tallyWindow,
				techSummary,
				toolsSummary,
				trendRawText,
				trendSummary,
				trendText,
				unattrText,
				unexplainedFrame,
				verdictColor,
				watchFlagText,
				watchPanelText,
				watchRowText,
				watchSelectedText,
				whoRows,
				windowScopeText,
				worstLongTask,
				worstSecond,
				worstSecondText,
				writeRows,
			});
				}, (error) => {
					state.errors.push({ at: Date.now(), where: 'ui-chunk', message: String(error) });
				}).catch((error) => {
					// createUi / deps 对象里的错误也要落账:否则面板空白、errors 却是空的。
					state.errors.push({ at: Date.now(), where: 'ui-create', message: String(error) });
				}).then(() => {
					if (alive) setReady(true);
				});
				return () => { alive = false; };
			}, []);
			return ready && uiApi !== null ? h(uiApi.PerfHud) : null;
		}

		// ───────────────────────────────── 装配 ─────────────────────────────────
		function apply(ctx) {
			state.since = Date.now();
			installStyle();
			// remote face 只用于 bundle 读写(插件管理器同一条路);拿不到就退宿主路由。
			try {
				remoteFace = ctx.remote ?? ctx.get('remote') ?? null;
			} catch (error) {
				remoteFace = null;
			}

			// 字典在分片里:先把它拉到位,再注册 locale(服务不在就退回内置词典)。
			const locale = ctx.get('locale');
			const useLocale = locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function';

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

			// 顺序有依赖:词典要先注册(translate 晚绑定)、模型层在采集路径上、restore 会碰两者。
			Promise.all([loadI18n(), loadModel(), loadWatch()]).then(() => {
				if (useLocale) {
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
				restore();
				if (state.want) start();
			}, () => {});
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
			}, PerfHudGate));
		}

		return { inject: ['slots'], apply };
	},
});
