/**
 * dsh-perf-hud 的 Host 半边。
 *
 * 只做六件事,全部经 `connection.fetch.register` 挂在 `/api/dsh-perf-hud/host`:
 *   1. GET  —— 事件循环延迟(perf_hooks.monitorEventLoopDelay 的每秒 p50/p99/max);
 *              同时兼作客户端的 RTT 探测端点(?pad=1KB 禁缓存)与吞吐探测(?bytes=N)。
 *   2. POST {op:'watchEvents'}  —— 可选:包住 session/event 的同步派发,累计每条事件的
 *              派发耗时与次数。装不上就如实回 installed:false + reason,不假装成功。
 *   3. POST {op:'listBundles'|'arm'|'setBundle'} —— 代理 pluginManager 的 bundle 读写,
 *              供「隔离实验」用。写之前必须先 `arm` 领一张 30 秒有效、单次使用的票据。
 *              票据**不是授权边界**:同源脚本可以自己 POST {op:'arm'} 取票;它只挡住
 *              读不到响应的盲 CSRF 与重放,把可写窗口压到 30 秒且不可复用。confirm:true
 *              同样只是调用方自己的标志,宿主不认。
 *   4. POST {op:'profileStart', seconds?} / {op:'profileGet'} —— 按需采一段宿主进程的
 *              CPU profile(node:inspector 的 Profiler,产出标准 .cpuprofile);**不常开**,
 *              同时只允许一个采样在跑,profile 只在内存里、不落盘。
 *   5. POST {op:'armedStart'|'armedGet'|'armedStop'} —— 「武装窗口」的宿主那一半:在客户端
 *              指定的窗口里**分段滚动**采 CPU profile(默认 10 秒一段、只留本次窗口内的段),
 *              客户端在卡顿发生时取回与事故窗口重叠的段,填进已有的 `incident.timeline[]`。
 *              窗口由客户端在 armedStart 里给定,到点自己停(即使页面被关掉也不会留在宿主里
 *              常开);仍然共用上面那台 profiler 的单飞,手动 profileStart 在武装期间会被拒。
 *   6. POST {op:'ambientStart'|'ambientGet'|'ambientStop'} —— 「后台低占空比滚动采样」:客户端
 *              显式打开后,每 `AMBIENT_INTERVAL_SECONDS` 采 `AMBIENT_SEGMENT_SECONDS` 一段,
 *              内存里只留最近 `AMBIENT_SEGMENTS_MAX` 段(默认 5 分钟 / 1 秒 / 3 段)。**默认关**
 *              (采样本身有开销,只有打开之后才会有数据);与手动 / 武装共用同一台 profiler 的
 *              单飞,优先级 手动 / 武装 > 后台 —— 后台那一段会被前两者顶掉、丢弃,不会反过来
 *              拖慢或打断它们。客户端每 10 秒一次的 GET 顺带续租约(`?ambient=1`):租约
 *              (`AMBIENT_LEASE_*`)过期就自己停,所以页面关掉 / 插件卸载之后不会留下常开的采样。
 *
 * 不注册服务、不监听事件(除非显式开启 watchEvents)、不写任何插件自己的持久化状态。
 * 特别注意:本文件不碰 cordis.patch.yml,也不碰 profile 的持久化配置行。
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Session as InspectorSession } from 'node:inspector';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** 本插件自己的版本(导出件要自描述;不要去猜,直接读自己的 package.json)。 */
const PLUGIN_VERSION = (() => {
	try {
		return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? null;
	} catch (error) {
		return null;
	}
})();

const ROUTE = '/api/dsh-perf-hud/host';
// setBundle 一次性票据的有效期:面板先 arm,30 秒内带票据写一次,之后作废。
// 这只是反盲 CSRF / 重放的时间窗,不是"谁有权写"的边界 —— 同源脚本自己也能 arm。
const ARM_TTL_MS = 30000;
const WINDOW = 300;          // 每秒一个采样,保留 300 秒
const MAX_LOAD_BYTES = 262144;
// 直方图分辨率(ms)。默认 10 会把 p50 直接顶到 ~10ms 的地板上,看不出真实抖动,
// 所以收到 1ms:代价只是每秒多几次内部定时器唤醒,p50 才有意义。
const RESOLUTION_MS = 1;

const round2 = (value) => Math.round(value * 100) / 100;
/** nearest-rank 分位(输入需升序);空数组返回 null。 */
function percentile(sorted, p) {
	if (sorted.length === 0) return null;
	const rank = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

/** 纳秒(直方图单位)→ 毫秒。 */
const toMs = (value) => (Number.isFinite(value) ? value / 1e6 : 0);
/** 纯 HTML/文本响应,避免任何缓存干扰探测。 */
function reply(value, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	});
}

/** 事件循环延迟:每秒采一次 p50/p99/max,环形保留 WINDOW 条。 */
function createEventLoop() {
	const ring = [];
	let histogram = null;
	let timer = null;
	const sample = () => {
		if (histogram === null) return;
		ring.push({
			t: Date.now(),
			p50: round2(toMs(histogram.percentile(50))),
			p99: round2(toMs(histogram.percentile(99))),
			max: round2(toMs(histogram.max)),
			mean: round2(toMs(histogram.mean)),
		});
		if (ring.length > WINDOW) ring.shift();
		histogram.reset();
	};
	return {
		ring,
		start() {
			if (histogram !== null || typeof monitorEventLoopDelay !== 'function') return false;
			try {
				histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
				histogram.enable();
			} catch (error) {
				histogram = null;
				return false;
			}
			timer = setInterval(sample, 1000);
			if (typeof timer.unref === 'function') timer.unref();
			return true;
		},
		stop() {
			if (timer !== null) clearInterval(timer);
			timer = null;
			if (histogram !== null) {
				histogram.disable();
				histogram = null;
			}
		},
		get live() {
			return histogram !== null;
		},
	};
}

/**
 * session/event 的到达延迟测量。
 *
 * 第一版想包住 Context.emit —— 实测证明不行:DSH 的 session/event 走的是带作用域过滤的
 * 派发路径(见 @deepseek-ai/dsh-scope),不经过公开的 ctx.emit。装了 120 秒、期间还有子代理
 * 跑完了一整个回合(stats 依然为空),才确认补丁根本没被调用。
 *
 * 所以改用组件自己的公开接口 `ctx.on('session/event', …)` —— 与 session-persistence-jsonl
 * 监听同一个事件,一定挂在真实路径上。记的是「事件被提交(event.time)到我这个监听器
 * 被调用」的延迟,不是监听器的 CPU 耗时;字段名(mode: 'listener'、ms = 累计到达延迟)
 * 与面板文案都照这个口径写,不冒充派发耗时。
 */
function createEventWatch(ctx) {
	const stats = new Map();
	let dispose = null;
	let reason = '';
	return {
		install() {
			if (dispose !== null) return true;
			try {
				if (typeof ctx.on !== 'function') {
					reason = 'ctx.on 不可用';
					return false;
				}
				dispose = ctx.on('session/event', (session, event) => {
					const recorded = event !== null && typeof event === 'object' && typeof event.time === 'number' ? event.time : Date.now();
					const lag = Date.now() - recorded;
					const type = event !== null && typeof event === 'object' && typeof event.type === 'string' ? event.type : 'unknown';
					let entry = stats.get(type);
					if (entry === undefined) {
						entry = { count: 0, ms: 0, max: 0 };
						stats.set(type, entry);
					}
					entry.count += 1;
					entry.ms += lag;
					if (lag > entry.max) entry.max = lag;
				});
				return true;
			} catch (error) {
				reason = error instanceof Error ? error.message : String(error);
				dispose = null;
				return false;
			}
		},
		uninstall() {
			if (dispose !== null) {
				try {
					dispose();
				} catch (error) { /* 取消失败无需处理 */ }
				dispose = null;
			}
		},
		snapshot() {
			const out = {};
			for (const [type, entry] of stats) out[type] = { count: entry.count, ms: round2(entry.ms), max: round2(entry.max) };
			return out;
		},
		get installed() {
			return dispose !== null;
		},
		get reason() {
			return reason;
		},
	};
}

const DEFAULT_PROFILE_SECONDS = 5;   // 默认采 5 秒:够覆盖一次卡顿,又不至于把宿主压得太久
const MAX_PROFILE_SECONDS = 30;
const MIN_PROFILE_SECONDS = 0.1;

/** 采样时长(秒):非数字/非正数一律回默认值,再夹到 [0.1, 30]。 */
function clampSeconds(raw) {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_PROFILE_SECONDS;
	return Math.min(Math.max(value, MIN_PROFILE_SECONDS), MAX_PROFILE_SECONDS);
}

// 武装窗口的宿主采样(方向 2 的按需版):窗口由客户端给定,到点自己停。
const ARMED_WINDOW_SECONDS = 60;     // 默认窗口:够"等下一次卡顿",又不至于长期占着采样
const ARMED_SEGMENT_SECONDS = 10;    // 默认段长:一段盖住一次典型事故窗口(前摇 10s + 后摇 3s)
const ARMED_MIN_WINDOW = 0.5;        // 下限放到 0.5 秒只为一件事:离线套件能在毫秒级复跑状态机
const ARMED_MAX_WINDOW = 120;
const ARMED_MIN_SEGMENT = 0.1;       // 与 clampSeconds 的下限同一条(再短就不是采样了)
const ARMED_MAX_SEGMENT = 30;
const ARMED_SEGMENTS_MAX = 12;       // 窗口内最多留几段(60s / 10s = 6;留一倍余量)
const ARMED_TICK_MS = 250;           // 段收尾的轮询间隔(只是问一次状态,不采样)
const ARMED_BUSY = '已有一个武装窗口在进行中';

// 后台低占空比滚动采样(方向 2 的常开版):默认关,打开后由客户端续租约。
// 四个数只写在这一处:客户端不复制一份(它读回执里的 intervalSeconds / segmentSeconds / keep),
// 面板 / 文档 / 事故包都从宿主回执取 —— 两边各写一份迟早会漂成"文档说 5 分钟、宿主采 5 秒"。
const AMBIENT_INTERVAL_SECONDS = 300;   // 每 5 分钟一段
const AMBIENT_SEGMENT_SECONDS = 1;      // 每段 1 秒(≈200 个样本、~2–3KB)
const AMBIENT_SEGMENTS_MAX = 3;         // 内存里留最近 3 段(覆盖最近 ~15 分钟)
const AMBIENT_MIN_INTERVAL = 0.5;       // 下限只为离线套件能在毫秒级复跑状态机(与武装同一条理由)
const AMBIENT_MAX_INTERVAL = 3600;
const AMBIENT_MIN_SEGMENT = 0.1;
const AMBIENT_MAX_SEGMENT = 10;
const AMBIENT_KEEP_MAX = 12;            // 段数上限:与 kill 判据②同一条(>12 段就没法证明重叠选择)
const AMBIENT_TICK_MS = 250;            // 段收尾的轮询间隔(只是问一次状态,不采样)
const AMBIENT_BUSY_RETRY_MS = 1000;     // 手动 / 武装在跑时,后台让路后隔多久再看一眼
// 租约:客户端每次 GET 带 `?ambient=1` 续期(那条 GET 本来就有,不额外加心跳)。租约到期
// 就自己停 —— 页面关掉 / 插件卸载之后不会有"留在宿主里常开"的采样。上限 2 分钟(≈12 次续期),
// 生产间隔是 5 分钟,所以最多白采一次;下限只为离线套件能在 2 秒内复跑"到点自己停"。
const AMBIENT_LEASE_INTERVALS = 4;
const AMBIENT_LEASE_MIN_MS = 2000;
const AMBIENT_LEASE_MAX_MS = 120000;

/** 后台采样的间隔(秒):非数字/非正数回默认 300,再夹到 [0.5, 3600]。 */
function clampAmbientInterval(raw) {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return AMBIENT_INTERVAL_SECONDS;
	return Math.round(Math.min(Math.max(value, AMBIENT_MIN_INTERVAL), AMBIENT_MAX_INTERVAL) * 10) / 10;
}

/** 后台采样每段多长(秒):非数字/非正数回默认 1,再夹到 [0.1, 10]。 */
function clampAmbientSegment(raw) {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return AMBIENT_SEGMENT_SECONDS;
	return Math.round(Math.min(Math.max(value, AMBIENT_MIN_SEGMENT), AMBIENT_MAX_SEGMENT) * 10) / 10;
}

/** 后台采样留几段:非数字/非正数回默认 3,再夹到 [1, 12]。 */
function clampAmbientKeep(raw) {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return AMBIENT_SEGMENTS_MAX;
	return Math.min(Math.max(Math.round(value), 1), AMBIENT_KEEP_MAX);
}

/** 租约时长(毫秒):按间隔的 4 倍给,夹到 [2s, 120s](见上面那条说明)。 */
function ambientLeaseMs(intervalSeconds) {
	const computed = Math.round(intervalSeconds * 1000 * AMBIENT_LEASE_INTERVALS);
	return Math.min(Math.max(computed, AMBIENT_LEASE_MIN_MS), AMBIENT_LEASE_MAX_MS);
}

/** 武装窗口时长(秒):非数字/非正数回默认 60,再夹到 [0.5, 120]。 */
function clampArmedWindow(raw) {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return ARMED_WINDOW_SECONDS;
	return Math.round(Math.min(Math.max(value, ARMED_MIN_WINDOW), ARMED_MAX_WINDOW) * 10) / 10;
}

/** 武装窗口内每段多长(秒):非数字/非正数回默认 10,再夹到 [0.1, 30]。 */
function clampArmedSegment(raw) {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return ARMED_SEGMENT_SECONDS;
	return Math.round(Math.min(Math.max(value, ARMED_MIN_SEGMENT), ARMED_MAX_SEGMENT) * 10) / 10;
}

/**
 * 武装窗口的宿主滚动采样器:在 `windowSeconds` 内反复"起一段 → 等它收尾 → 记进段表",
 * 段长 `segmentSeconds`(最后一段按剩余时间截短)。窗口到点自己停 —— **不在宿主里常开**。
 *
 * 三条刻意的取舍:
 *   ① **共用同一台 profiler**(单飞):V8 允许多会话并存,后来的 `Profiler.start` 会"接手"
 *      采样,两段并行会把彼此的样本切碎。所以武装期间手动 `profileStart` 会被拒,武装结束
 *      立刻恢复(A5 的手动路径一点没改)。
 *   ② **段是证据,不因窗口结束而丢**:stop 只停止再起新段;正在飞的那一段会收完并留下,
 *      客户端还能取回(事故窗口常常正好落在窗口末尾那一两段里)。
 *   ③ **不假装采到**:起不来 / 收尾失败 / 段数超上限都写进 `errors`(带原因原文),`kept`
 *      是真实留下来的段数,不回一个看起来成功的空集。
 */
function createArmedProfiler(profiler) {
	let timer = null;
	let active = false;
	let inFlight = false;
	let busy = false;
	let startedAt = 0;
	let endsAt = 0;
	let stoppedAt = 0;
	let stopReason = '';
	let windowSeconds = ARMED_WINDOW_SECONDS;
	let segmentSeconds = ARMED_SEGMENT_SECONDS;
	let segments = [];
	let errors = [];
	let collectionsAtStart = 0;
	let inFlightSeconds = 0;
	let inFlightStartedAt = 0;     // 这一段是什么时候起的(用来自证"取回来的就是这一段")
	let samplingStarted = false;   // 这个窗口里有没有真的起过一段(失败重试时仍可能变 true)

	const state = () => ({
		mode: 'rolling',
		active,
		collecting: inFlight,
		windowSeconds,
		segmentSeconds,
		startedAt: startedAt > 0 ? startedAt : null,
		endsAt: endsAt > 0 ? endsAt : null,
		stoppedAt: stoppedAt > 0 ? stoppedAt : null,
		stopReason,
		segmentCount: segments.length,
		kept: segments.length,
		samplingStarted,
		bytes: segments.reduce((sum, row) => sum + (Number.isFinite(row.meta.bytes) ? row.meta.bytes : 0), 0),
		error: errors.length === 0 ? '' : errors[errors.length - 1].error,
		errors: errors.slice(-5),
	});
	const noteError = (text) => {
		const error = String(text);
		if (errors.length > 0 && errors[errors.length - 1].error === error) return;
		errors.push({ at: Date.now(), error });
		if (errors.length > 20) errors.splice(0, errors.length - 20);
	};
	const schedule = (ms) => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => { void tick(); }, Math.max(0, ms));
		if (typeof timer.unref === 'function') timer.unref();
	};

	/** 收下一段:成功后写进段表;失败只记原因(不拿上一次的 profile 冒充这一段)。 */
	function takeFinishedSegment() {
		const snapshot = profiler.state();
		if (snapshot.collections <= collectionsAtStart) {
			noteError(snapshot.error === '' ? '这一段没有采到(宿主单飞被占用或 Profiler.stop 失败)' : snapshot.error);
			return false;
		}
		if (segments.length >= ARMED_SEGMENTS_MAX) {
			noteError(`段数已到上限 ${ARMED_SEGMENTS_MAX},这一段的 profile 不再保留`);
			return false;
		}
		const got = profiler.get();
		if (got.ok !== true || got.profile === null || typeof got.profile !== 'object') {
			noteError(got.error === undefined || got.error === '' ? '取回这一段失败' : got.error);
			return false;
		}
		const meta = got.meta === null || typeof got.meta !== 'object' ? {} : got.meta;
		// 自证"取回来的就是这一段":手动采样在两次轮询之间(250ms)跑完的话,collections 也会 +1,
		// 直接 get() 会把**手动那一段**冒充成武装段。时长对不上 / 时间锚早于本段起点 → 不认。
		const actualSeconds = Number(meta.seconds);
		const tolerance = Math.max(0.5, inFlightSeconds * 0.5);
		if (!Number.isFinite(actualSeconds) || Math.abs(actualSeconds - inFlightSeconds) > tolerance
			|| !Number.isFinite(Number(meta.startedAt)) || Number(meta.startedAt) < inFlightStartedAt - 1000) {
			noteError('取回的 profile 与本段对不上(时长 / 时间锚不符),不拿它冒充这一段');
			return false;
		}
		segments.push({
			index: segments.length,
			requestedSeconds: inFlightSeconds,
			meta,
			profile: got.profile,
		});
		return true;
	}

	async function tick() {
		timer = null;
		if (busy === true) { schedule(ARMED_TICK_MS); return; }
		busy = true;
		try {
			// ① 上一段还在采:只是问一句状态;采完就收进来。
			if (inFlight === true) {
				if (profiler.state().running === true) { schedule(ARMED_TICK_MS); return; }
				inFlight = false;
				takeFinishedSegment();
				if (active === false) return;   // 已停:不再起新段,但上面那一段已经留下
				schedule(ARMED_TICK_MS);
				return;
			}
			// ② 没在采:窗口到点就停,否则起下一段。
			if (active === false) return;
			const now = Date.now();
			if (now >= endsAt) { stop('timeout'); return; }
			const remainMs = endsAt - now;
			// 剩余不足一段的就直接等到窗口结束:开一段 <100ms 的采样没有信息量,
			// 只会把 Profiler.enable/start 的往返记进段里。
			if (remainMs < Math.max(ARMED_MIN_SEGMENT, segmentSeconds * 0.2) * 1000) {
				schedule(remainMs);
				return;
			}
			const seconds = Math.round(Math.min(segmentSeconds, remainMs / 1000) * 10) / 10;
			collectionsAtStart = profiler.state().collections;
			const startedAtBefore = Date.now();
			// 'armed' 是来源标签:后台采样比它低,后台那一段会被它顶掉;手动在窗口里仍被拒(W2 规则)。
			const started = await profiler.start(seconds, 'armed');
			if (started.ok !== true) {
				noteError(started.error === undefined || started.error === '' ? '宿主没能开始这一段采样' : started.error);
				schedule(ARMED_TICK_MS);
				return;
			}
			inFlightSeconds = seconds;
			inFlightStartedAt = startedAtBefore;
			inFlight = true;
			samplingStarted = true;
			schedule(ARMED_TICK_MS);
		} finally {
			busy = false;
		}
	}

	/** 停:不再起新段;**正在飞的那一段会收完并留下**(它是证据,不是要清掉的状态)。 */
	function stop(reason) {
		if (timer !== null) { clearTimeout(timer); timer = null; }
		if (active === true) {
			active = false;
			stoppedAt = Date.now();
			stopReason = typeof reason === 'string' && reason !== '' ? reason : 'stopped';
		}
		if (inFlight === true) schedule(ARMED_TICK_MS);
		return { ok: true, armed: state(), windingDown: inFlight };
	}

	return {
		/** 开一个武装窗口。已经有一个在跑就拒绝(409),不重入、不叠采。 */
		async start(rawWindow, rawSegment) {
			if (active === true || inFlight === true) return { ok: false, armed: state(), error: ARMED_BUSY };
			windowSeconds = clampArmedWindow(rawWindow);
			segmentSeconds = clampArmedSegment(rawSegment);
			startedAt = Date.now();
			endsAt = startedAt + Math.round(windowSeconds * 1000);
			stoppedAt = 0;
			stopReason = '';
			segments = [];
			errors = [];
			samplingStarted = false;
			active = true;
			// 第一段不能比窗口本身还长:否则窗口结束之后采样还在跑(与"到点自己停"矛盾)。
			const firstSeconds = Math.round(Math.min(segmentSeconds, windowSeconds) * 10) / 10;
			collectionsAtStart = profiler.state().collections;
			const started = await profiler.start(firstSeconds, 'armed');
			if (started.ok !== true) {
				// 开不起来不算"成功开了个空窗口":active 仍然为真,下一拍会重试;
				// 但错误原文要立刻记下来,客户端照着显示。
				noteError(started.error === undefined || started.error === '' ? '宿主没能开始第一段采样' : started.error);
			} else {
				inFlightSeconds = firstSeconds;
				inFlightStartedAt = startedAt;
				inFlight = true;
				samplingStarted = true;
			}
			schedule(ARMED_TICK_MS);
			return { ok: true, armed: state() };
		},
		/** 取回段:`since` 之前的段不带(客户端按 index 增量取)。没有段不是错误,回空数组。 */
		get(rawSince) {
			const since = Number(rawSince);
			const from = Number.isFinite(since) ? Math.floor(since) : -1;
			return {
				ok: true,
				armed: state(),
				segments: segments
					.filter((row) => row.index > from)
					.map((row) => ({ index: row.index, requestedSeconds: row.requestedSeconds, meta: row.meta, profile: row.profile })),
			};
		},
		stop,
		state,
		/** 宿主卸载:清定时器(**不清段**:调用方马上要断开 inspector,拿不到的就拿不到了)。 */
		dispose() {
			if (timer !== null) clearTimeout(timer);
			timer = null;
			active = false;
			inFlight = false;
		},
	};
}

/**
 * 后台低占空比滚动采样器(方向 2 的常开版,默认关)。
 *
 * 与武装窗口的区别只有一条:**它不等用户开窗口**,而是按固定节奏一直采(默认每 5 分钟 1 秒),
 * 内存里只留最近几段。这样"偶发卡顿发生时,宿主那段 profile 已经存在"—— 用户不用先点
 * 「采 5 秒」再复现。
 *
 * 四条刻意的取舍:
 *   ① **默认关 + 租约**:采样本身有开销(见 createCpuProfiler 的说明),所以只有客户端显式
 *      ambientStart 之后才采;客户端每次 GET 带 `?ambient=1` 续租,`leaseMs` 内没续上就自己停
 *      —— 页面关掉 / 插件卸载之后不会留下常开的采样,也不需要"卸载时一定发得出请求"这种假设。
 *   ② **最低优先级**:手动 / 武装在跑时后台让路(记一次 `skipped`,不排队、不抢);正在飞的
 *      后台段被它们顶掉时直接丢弃(记一次 `yielded`),**不冒充成采到的一段**。
 *   ③ **不假装采到**:起不来 / 收尾失败 / 段与本段对不上(`collections` 没涨、时长或时间锚不符)
 *      都写进 `errors`,不回一个看起来成功的空段。
 *   ④ **段是证据**:只淘汰最老的段(`keep`),`total` 是累计采到过几段(不因淘汰回退)。
 */
function createAmbientProfiler(profiler) {
	let timer = null;
	let enabled = false;
	let busy = false;             // tick 正在跑(异步重入保护)
	let inFlight = false;         // 当前 profiler 里那一段是这里起的
	let startedAt = 0;
	let stoppedAt = 0;
	let stopReason = '';
	let intervalSeconds = AMBIENT_INTERVAL_SECONDS;
	let segmentSeconds = AMBIENT_SEGMENT_SECONDS;
	let keep = AMBIENT_SEGMENTS_MAX;
	let nextAt = 0;               // 下一段该开始的时刻(墙钟)
	let leaseUntil = 0;
	let leaseMs = ambientLeaseMs(AMBIENT_INTERVAL_SECONDS);
	let segments = [];            // 最近 keep 段
	let nextIndex = 0;            // 段序只增不减(客户端按 since 增量取)
	let total = 0;                // 累计采到段数
	let skipped = 0;              // 因为手动 / 武装在跑而让路的次数
	let yielded = 0;              // 在飞那一段被更高优先级顶掉(丢弃)的次数
	let aborted = 0;              // 关闭时丢弃在飞段的次数
	let collectionsAtStart = 0;
	let preemptedAtStart = 0;
	let inFlightSeconds = 0;
	let inFlightStartedAt = 0;
	let errors = [];

	const state = () => ({
		mode: 'ambient',
		enabled,
		collecting: inFlight,
		intervalSeconds,
		segmentSeconds,
		keep,
		startedAt: startedAt > 0 ? startedAt : null,
		stoppedAt: stoppedAt > 0 ? stoppedAt : null,
		stopReason,
		nextAt: enabled === true && nextAt > 0 ? nextAt : null,
		leaseMs,
		leaseUntil: leaseUntil > 0 ? leaseUntil : null,
		collected: segments.length,
		total,
		lastAt: segments.length === 0 ? null : (Number.isFinite(Number(segments[segments.length - 1].meta.endedAt))
			? Number(segments[segments.length - 1].meta.endedAt) : null),
		lastIndex: segments.length === 0 ? -1 : segments[segments.length - 1].index,
		bytes: segments.reduce((sum, row) => sum + (Number.isFinite(row.meta.bytes) ? row.meta.bytes : 0), 0),
		skipped,
		yielded,
		aborted,
		error: errors.length === 0 ? '' : errors[errors.length - 1].error,
		errors: errors.slice(-5),
	});
	const noteError = (text) => {
		const error = String(text);
		if (errors.length > 0 && errors[errors.length - 1].error === error) return;
		errors.push({ at: Date.now(), error });
		if (errors.length > 20) errors.splice(0, errors.length - 20);
	};
	const schedule = (ms) => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => { void tick(); }, Math.max(0, ms));
		if (typeof timer.unref === 'function') timer.unref();
	};
	/** 空闲时该睡多久:下一段 / 租约到期,谁先到就谁(租约到期必须有话事权,不能睡满 5 分钟)。 */
	const idleWaitMs = (now) => {
		const due = nextAt > 0 ? Math.max(0, nextAt - now) : 0;
		if (leaseUntil <= 0) return due;
		return Math.max(0, Math.min(due, leaseUntil - now + 1));
	};

	/** 收下一段:成功后进段表并按 keep 淘汰最老的;失败只记原因。 */
	function takeFinishedSegment() {
		const snapshot = profiler.state();
		if (snapshot.preempted !== preemptedAtStart) {
			// 被手动 / 武装顶掉了:这一段压根没采完,不能算"采到了"
			yielded += 1;
			return false;
		}
		if (snapshot.collections <= collectionsAtStart) {
			noteError(snapshot.error === '' ? '这一段没有采到(宿主单飞被占用或 Profiler.stop 失败)' : snapshot.error);
			return false;
		}
		const got = profiler.get();
		if (got.ok !== true || got.profile === null || typeof got.profile !== 'object') {
			noteError(got.error === undefined || got.error === '' ? '取回这一段失败' : got.error);
			return false;
		}
		const meta = got.meta === null || typeof got.meta !== 'object' ? {} : got.meta;
		// 自证"取回来的就是这一段"(与武装同一条纪律):手动采样在两次轮询之间跑完的话,
		// collections 也会 +1,直接 get() 会把**手动那一段**冒充成后台段。
		const actualSeconds = Number(meta.seconds);
		const tolerance = Math.max(0.5, inFlightSeconds * 0.5);
		if (!Number.isFinite(actualSeconds) || Math.abs(actualSeconds - inFlightSeconds) > tolerance
			|| !Number.isFinite(Number(meta.startedAt)) || Number(meta.startedAt) < inFlightStartedAt - 1000) {
			noteError('取回的 profile 与本段对不上(时长 / 时间锚不符),不拿它冒充这一段');
			return false;
		}
		segments.push({ index: nextIndex, requestedSeconds: inFlightSeconds, meta, profile: got.profile });
		nextIndex += 1;
		total += 1;
		while (segments.length > keep) segments.shift();
		return true;
	}

	/** 起一段。返回 false = 没起来(原因已记下,调用方隔一会儿再看)。 */
	async function beginSegment() {
		const snapshot = profiler.state();
		// 手动 / 武装在跑:后台让路(**不排队、不抢**,也不打断它们)
		if (snapshot.running === true || snapshot.pending === true) {
			skipped += 1;
			schedule(AMBIENT_BUSY_RETRY_MS);
			return false;
		}
		collectionsAtStart = snapshot.collections;
		preemptedAtStart = snapshot.preempted;
		const startedAtBefore = Date.now();
		const started = await profiler.start(segmentSeconds, 'ambient');
		if (started.ok !== true) {
			noteError(started.error === undefined || started.error === '' ? '宿主没能开始这一段采样' : started.error);
			schedule(AMBIENT_BUSY_RETRY_MS);
			return false;
		}
		inFlight = true;
		inFlightSeconds = segmentSeconds;
		inFlightStartedAt = startedAtBefore;
		nextAt = Date.now() + Math.round(intervalSeconds * 1000);
		return true;
	}

	async function tick() {
		timer = null;
		if (busy === true) return;      // 上一拍还在等 inspector 的往返:不叠第二个
		busy = true;
		try {
			if (enabled !== true) return;
			const now = Date.now();
			if (leaseUntil > 0 && now > leaseUntil) { stop('lease-expired'); return; }
			if (inFlight === true) {
				const snapshot = profiler.state();
				if (snapshot.running === true) {
					// 被手动 / 武装顶掉:立刻放弃等待,别占着"后台在采"这个假象
					if (snapshot.owner !== 'ambient' || snapshot.preempted !== preemptedAtStart) {
						inFlight = false;
						yielded += 1;
						if (enabled === true) schedule(idleWaitMs(Date.now()));
						return;
					}
					schedule(AMBIENT_TICK_MS);
					return;
				}
				inFlight = false;
				takeFinishedSegment();
				if (enabled === true) schedule(idleWaitMs(Date.now()));
				return;
			}
			if (now < nextAt) { schedule(idleWaitMs(now)); return; }
			const started = await beginSegment();
			if (enabled !== true) {
				// 起段期间被关掉:把刚好起来的那一段丢掉(关闭之后不该还有采样在跑)
				inFlight = false;
				if (profiler.state().owner === 'ambient') {
					profiler.stop();
					aborted += 1;
				}
				return;
			}
			if (started === true) schedule(AMBIENT_TICK_MS);
		} finally {
			busy = false;
		}
	}

	/** 停:清定时器、丢在飞段(证据只有"已收完的段",在飞那一段还没成形)。 */
	function stop(reason) {
		if (timer !== null) { clearTimeout(timer); timer = null; }
		if (enabled === true) {
			enabled = false;
			stoppedAt = Date.now();
			stopReason = typeof reason === 'string' && reason !== '' ? reason : 'stopped';
		}
		nextAt = 0;
		leaseUntil = 0;
		if (inFlight === true) {
			inFlight = false;
			// owner 已经换人时别乱停别人的采样(手动 / 武装可能刚接手)
			if (profiler.state().owner === 'ambient') {
				profiler.stop();
				aborted += 1;
			} else {
				yielded += 1;
			}
		}
		return { ok: true, ambient: state() };
	}

	return {
		/**
		 * 开启(幂等):已经在采就只续租约。参数只在**这次调用**生效,面板读的是回执里的值;
		 * 不传就用上面那四个常量(客户端从不传 —— 常量只有这一处)。
		 */
		async start(options) {
			const opts = options === null || typeof options !== 'object' ? {} : options;
			if (enabled === true) {
				renew();
				return { ok: true, ambient: state(), already: true };
			}
			intervalSeconds = clampAmbientInterval(opts.intervalSeconds);
			segmentSeconds = clampAmbientSegment(opts.segmentSeconds);
			keep = clampAmbientKeep(opts.keep);
			leaseMs = ambientLeaseMs(intervalSeconds);
			startedAt = Date.now();
			stoppedAt = 0;
			stopReason = '';
			errors = [];
			enabled = true;
			nextAt = startedAt;      // 第一段立刻采:打开开关之后马上就能看到"上次采到段的时间"
			leaseUntil = startedAt + leaseMs;
			while (segments.length > keep) segments.shift();
			const started = await beginSegment();
			if (enabled !== true) {
				// 起段期间被关掉(或者被卸载):把刚好起来的那一段丢掉
				inFlight = false;
				if (profiler.state().owner === 'ambient') {
					profiler.stop();
					aborted += 1;
				}
				return { ok: true, ambient: state() };
			}
			if (started === true) schedule(AMBIENT_TICK_MS);
			return { ok: true, ambient: state() };
		},
		/** 续租约(客户端每次 GET 带 ?ambient=1 时调):只有开着才有意义。 */
		renew() {
			if (enabled !== true) return false;
			leaseUntil = Date.now() + leaseMs;
			return true;
		},
		/** 取回段:`since` 之前的段不带(客户端按 index 增量取)。没有段不是错误,回空数组。 */
		get(rawSince) {
			const since = Number(rawSince);
			const from = Number.isFinite(since) ? Math.floor(since) : -1;
			return {
				ok: true,
				ambient: state(),
				segments: segments
					.filter((row) => row.index > from)
					.map((row) => ({ index: row.index, requestedSeconds: row.requestedSeconds, meta: row.meta, profile: row.profile })),
			};
		},
		stop,
		state,
		/** 宿主卸载:清定时器(**不清段**:调用方马上要断开 inspector,拿不到的就拿不到了)。 */
		dispose() {
			if (timer !== null) clearTimeout(timer);
			timer = null;
			enabled = false;
			nextAt = 0;
			leaseUntil = 0;
			inFlight = false;
		},
	};
}

/**
 * 宿主进程的 CPU profile(按需,单飞)。
 *
 * 事故包里宿主侧原来只有一个 event-loop p99 数字,而那个数字常常是事故**之后**才采的,
 * 读不出"宿主那一秒在干什么"。这里用 `node:inspector` 在同进程里采一段 V8 CPU profile:
 * `Profiler.enable → Profiler.start → N 秒 → Profiler.stop`,`stop` 回的就是标准 .cpuprofile
 * 对象(speedscope 可直接打开),原样缓存,不加工、不落盘。
 *
 * 三条刻意的取舍:
 *   1. **不常开**:profile 本身有采样开销(每次采样都要走 V8 的 TickSample),只由显式 op 触发;
 *      `running` 单飞,重入直接拒绝,不会出现两段采样互相踩。
 *   2. **不假装成功**:`Session.connect` / `Profiler.enable` / `Profiler.start` 任一失败一律把
 *      **错误原文**回给调用方,并保持"没在采"。⚠️ 实测(Node 25.9.0):"宿主已经开着别的
 *      inspector"**不会**让这里失败 —— 同进程 `new Session().connect()` 总能成功,另一个会话
 *      正在采时再 `Profiler.start` 也不报错(V8 允许多会话并存,后来的 start 直接接手采样)。
 *      所以这条分支实际挡的是 `node:inspector` 不可用、会话未连接/已断开、`Profiler.*` 自身
 *      报错;真正防止"两段采样互相踩"的是下面那条单飞,不是 V8。
 *   3. **不改宿主原型**:只用 `new Session()` 这个公开句柄,不 patch 任何全局/原型。
 *
 * 优先级(④):这台 profiler 有三个使用者 —— 手动 `profileStart` / 武装窗口 / 后台滚动采样。
 * `start(seconds, owner)` 带一个来源标签,只有**更低优先级**的采样会被顶掉丢弃:
 *
 *   手动(manual) > 武装(armed) > 后台(ambient)
 *
 * 后台那一段被顶掉时只丢那一段(`preempted` +1,调用方按 owner / preempted 认出"这段不是我的"),
 * 绝不会出现两段并行 —— V8 的"后者接手"会把彼此的样本切碎。手动与武装之间**保持原有规则**
 * (武装期间手动仍被拒,见 W2 与 host 套件的断言):那两条都是用户在等的一次性采样,后台不参与
 * 它们的先后。防重入还有一道 `pending`:从 `start()` 进来到 `running=true` 之间有几个 await,
 * 不做保留就会出现"两个请求同时通过 running 检查"。
 *
 * `start` 只等在"真的开起来"这一步(毫秒级)就返回,`stop` 由定时器异步收尾 —— 一次 HTTP
 * 请求不该挂 5 秒;调用方按 `running` 轮询,采完再 `get()` 取回。
 */
const OWNERS = new Set(['ambient', 'armed', 'manual']);
/** 来源标签归一:不认识的(含老调用方不传)一律按手动 —— 手动不会被任何东西顶掉。 */
function ownerOf(raw) {
	return typeof raw === 'string' && OWNERS.has(raw) ? raw : 'manual';
}

function createCpuProfiler(inspector) {
	let session = null;
	let timer = null;
	let running = false;
	let pending = false;         // start() 正在等 inspector 的往返(还没到 running=true)
	let owner = '';              // 当前 / 最近一次采样的来源:manual / armed / ambient
	let preempted = 0;           // 被更高优先级顶掉的次数(被顶掉的那一段**不产出证据**)
	let startedAt = 0;
	let generation = 0;          // 每次 start() 递增:旧 finish 只认自己那一代
	let profile = null;          // 最近一次采到的 .cpuprofile(只在内存里)
	let meta = null;             // 上面那份的元信息(不含 profile 本体)
	let error = '';              // 最近一次失败的错误原文
	let collections = 0;         // 成功采到过几次

	const post = (sess, method) => new Promise((resolve, reject) => {
		try {
			sess.post(method, {}, (err, result) => (err ? reject(err) : resolve(result)));
		} catch (err) {
			reject(err);
		}
	});
	const reason = (err) => (err instanceof Error ? err.message : String(err));

	const state = () => ({
		running,
		pending,
		owner,
		preempted,
		collected: profile !== null,
		collections,
		lastSeconds: meta === null ? null : meta.seconds,
		bytes: meta === null ? 0 : meta.bytes,
		samples: meta === null ? 0 : meta.samples,
		meta,
		error,
	});

	/**
	 * 收尾:`Profiler.stop` 拿 profile。**只有 token 仍是当前代才提交状态** —— 采样进行中
	 * 关掉 HUD 再立刻打开时,旧一代的 `Profiler.stop` 可能晚于新 `start()` 返回;那一代
	 * 只配收掉自己的 inspector 会话,不能把新一代的 `profile/meta/running/session` 打回旧值。
	 */
	async function finish(token) {
		const sess = session;
		const anchor = startedAt;
		timer = null;
		let failure = '';
		let nextProfile = null;
		let nextMeta = null;
		try {
			const result = await post(sess, 'Profiler.stop');
			const next = result === null || result === undefined ? null : result.profile;
			if (next === null || typeof next !== 'object' || !Array.isArray(next.nodes)) {
				throw new Error('Profiler.stop 没有返回 profile');
			}
			nextProfile = next;
			nextMeta = {
				startedAt: anchor,
				endedAt: Date.now(),
				seconds: round2((Date.now() - anchor) / 1000),
				nodes: next.nodes.length,
				samples: Array.isArray(next.samples) ? next.samples.length : 0,
				bytes: JSON.stringify(next).length,
				pid: process.pid,
				nodeVersion: process.version,
			};
		} catch (err) {
			failure = reason(err);
		}
		try { sess?.disconnect(); } catch (ignored) { /* 断开失败不影响读数 */ }
		if (token !== generation) {
			// 旧一代:新一代可能已经在采,什么都不提交(连 error 也不覆盖)。
			return { ...state(), ok: false, stale: true };
		}
		if (nextProfile !== null) {
			profile = nextProfile;
			collections += 1;
			meta = nextMeta;
		}
		running = false;
		session = null;
		error = failure;
		return failure === '' ? { ...state(), ok: true } : { ...state(), ok: false, error: failure };
	}

	/**
	 * 立刻丢掉正在飞的那一段(**不产出证据**):只给"更高优先级要这台 profiler"用。
	 * 被顶掉的调用方(武装 / 后台)靠 `preempted` 的增量认出"这一段不是我的",不会把别人的
	 * profile 冒充成自己的段;它们各自的自证检查(时长 / 时间锚 / collections)也还在。
	 */
	function forceStop() {
		if (timer !== null) clearTimeout(timer);
		timer = null;
		running = false;
		pending = false;
		const sess = session;
		session = null;
		preempted += 1;
		try { sess?.disconnect(); } catch (ignored) { /* 已断开就无所谓 */ }
	}

	return {
		/** 触发一次采样;只在"真的开起来了"之后才返回 ok。`owner` 决定谁能让谁(见优先级)。 */
		async start(rawSeconds, rawOwner) {
			const seconds = clampSeconds(rawSeconds);
			const who = ownerOf(rawOwner);
			// 先展开 state、再放本次请求专用的字段:同名字段以本次为准(否则 seconds 会被 null 盖掉)。
			if (pending === true) return { ...state(), ok: false, error: '另一个采样正在启动中', seconds };
			if (running === true) {
				// 优先级:手动 / 武装 > 后台。**只有后台那一段可以被顶掉**(丢弃,不叠采);
				// 手动与武装之间保持 W2 的既有规则 —— 武装期间手动 profileStart 仍被拒(host 套件
				// 钉着它):那两条都是用户在等的一次性采样,互相顶掉只会把两边的证据一起作废。
				if (ownerOf(owner) !== 'ambient' || who === 'ambient') {
					return { ...state(), ok: false, error: '已有一个采样在进行中', seconds };
				}
				forceStop();
			}
			if (typeof inspector?.Session !== 'function') {
				error = 'node:inspector 不可用';
				return { ...state(), ok: false, error, seconds };
			}
			// 新的一代:从这个 token 起,之前所有在飞的 finish 都算旧代。
			generation += 1;
			const token = generation;
			let sess = null;
			pending = true;
			try {
				sess = new inspector.Session();
				sess.connect();
				await post(sess, 'Profiler.enable');
				await post(sess, 'Profiler.start');
			} catch (err) {
				pending = false;
				try { sess?.disconnect(); } catch (ignored) { /* 半开的会话也要收掉 */ }
				error = reason(err);
				return { ...state(), ok: false, error, seconds };
			}
			pending = false;
			session = sess;
			running = true;
			owner = who;
			error = '';
			startedAt = Date.now();
			timer = setTimeout(() => { void finish(token); }, seconds * 1000);
			return { ...state(), ok: true, seconds };
		},
		/** 取回最近一次采到的 profile;没采过就照实说没采过,不回空对象。 */
		get() {
			if (profile === null) return { ...state(), ok: false, error: '还没采过' };
			return { ...state(), ok: true, profile };
		},
		state,
		/** 宿主卸载:停掉未完成的采样,断开 inspector 会话。 */
		stop() {
			if (timer !== null) clearTimeout(timer);
			timer = null;
			running = false;
			pending = false;
			const sess = session;
			session = null;
			try { sess?.disconnect(); } catch (ignored) { /* 已断开就无所谓 */ }
		},
	};
}

export function apply(ctx, options = {}) {
	const loop = createEventLoop();
	loop.start();
	const watch = createEventWatch(ctx);
	// 只在测试里替换(离线套件不真的去采:那是进程级的重活);宿主里永远是 node:inspector。
	const inspector = options !== null && typeof options === 'object' && options.inspector !== undefined
		? options.inspector
		: { Session: InspectorSession };
	const profiler = createCpuProfiler(inspector);
	// 武装窗口的滚动采样器与手动采样**共用**上面那台 profiler:V8 允许多会话并存,
	// 两个 Profiler.start 并行会互相"接手"采样,所以这里靠同一份单飞挡住叠采。
	const armed = createArmedProfiler(profiler);
	// 后台低占空比滚动采样(默认关)也是同一台 profiler 的第三个使用者,优先级最低。
	const ambient = createAmbientProfiler(profiler);

	ctx.effect(() => () => {
		loop.stop();
		watch.uninstall();
		armed.dispose();
		ambient.dispose();
		profiler.stop();
	}, 'perf-hud: host instrumentation');

	ctx.inject(['connection'], (c) => {
		const connection = c.get('connection');
		const register = typeof connection?.fetch?.register === 'function' ? connection.fetch.register.bind(connection.fetch) : void 0;
		if (register === undefined) return;

		const manager = () => {
			const service = c.get('pluginManager');
			return service === undefined ? null : service;
		};

		// setBundle 的一次性票据:面板先 POST {op:'arm'} 领一张,30 秒内有效、用一次就废。
		// 它**不是授权边界**:同源脚本本来就能自己 POST {op:'arm'} 拿票,也能伪造 confirm:true。
		// 票据真正挡住的是"读不到响应"的盲 CSRF(攻击页发得出请求、读不回响应)和重放 ——
		// 把无票写入与重复提交压成 403,而不是区分谁有权写。票据只在宿主内存里,不落盘,
		// 插件卸载即失效;arm 本身没有速率限制或数量上限(同源循环 arm 仍会让 Map 增长)。
		const tickets = new Map();
		const armTtlMs = Number.isFinite(options?.armTtlMs) && options.armTtlMs > 0 ? options.armTtlMs : ARM_TTL_MS;
		const issueTicket = () => {
			const now = Date.now();
			for (const [key, expiresAt] of tickets) {
				if (expiresAt <= now) tickets.delete(key);
			}
			const ticket = randomBytes(24).toString('base64url');
			const expiresAt = now + armTtlMs;
			tickets.set(ticket, expiresAt);
			return { ok: true, ticket, expiresAt, ttlMs: armTtlMs };
		};
		/** 校验并消费票据:返回 '' 表示有效,否则是拒绝原因。无论后续成败,用过即废。 */
		const consumeTicket = (raw) => {
			if (typeof raw !== 'string' || raw === '') return 'missing';
			const expiresAt = tickets.get(raw);
			if (expiresAt === undefined) return 'invalid';
			tickets.delete(raw);
			return expiresAt <= Date.now() ? 'expired' : '';
		};

		const status = (url) => {
			const bytes = Math.min(Number(url.searchParams.get('bytes') ?? 0) || 0, MAX_LOAD_BYTES);
			// 后台采样的租约**借这条已经在跑的 GET 续期**(客户端每 10 秒就 GET 一次,不另加心跳):
			// 客户端停下(页面关掉 / 插件卸载 / 关了开关)之后,租约到点宿主自己停。
			if (url.searchParams.get('ambient') === '1') ambient.renew();
			const window = loop.ring.slice(-60);
			// 每秒一个采样:窗口 p50 取"每秒 p50 的中位",窗口 p99 取"每秒 p99 的最大"。
			const p50s = window.map((row) => row.p50).sort((a, b) => a - b);
			const payload = {
				ok: true,
				host: {
					pluginVersion: PLUGIN_VERSION,
					profile: process.env.DSH_PROFILE ?? null,
					pid: process.pid,
					uptimeMs: Math.round(process.uptime() * 1000),
					nodeVersion: process.version,
					eventLoopLive: loop.live,
					eventLoop: {
						p50: percentile(p50s, 50),
						p99: window.length === 0 ? null : window.reduce((top, row) => Math.max(top, row.p99), 0),
						max: window.reduce((top, row) => Math.max(top, row.max), 0),
						seconds: window.length,
					},
					eventRing: loop.ring.slice(-30),
					eventWatch: { installed: watch.installed, reason: watch.reason, mode: 'listener', stats: watch.snapshot() },
					// 只回状态,不回 profile 本体(实测 5 秒约 10~13KB,但没必要每个 GET 都背它)。
					cpuProfile: profiler.state(),
					// 武装窗口的宿主滚动采样:**只回状态与段数**,段本体走 armedGet 增量取
					// (段里带原始 .cpuprofile,每个 GET 都背它没有意义)。
					armed: armed.state(),
					// 后台低占空比滚动采样:同样只回状态;段本体走 ambientGet。
					ambient: ambient.state(),
				},
			};
			if (bytes > 0) payload.pad = 'x'.repeat(bytes);
			return reply(payload);
		};

		const handler = async (request) => {
			let url;
			try {
				url = new URL(request.url, 'http://dsh.invalid');
			} catch (error) {
				return reply({ ok: false, error: 'bad url' }, 400);
			}
			if (request.method === 'GET') return status(url);

			let body = null;
			try {
				body = await request.json();
			} catch (error) {
				body = null;
			}
			if (body === null || typeof body !== 'object') return reply({ ok: false, error: 'body is not JSON' }, 400);
			const op = body.op;

			if (op === 'status') return status(url);

			if (op === 'watchEvents') {
				const enabled = body.enable !== false;
				if (enabled) {
					const ok = watch.install();
					return reply({ ok: true, eventWatch: { installed: ok, reason: watch.reason, mode: 'listener' } });
				}
				watch.uninstall();
				return reply({ ok: true, eventWatch: { installed: false, reason: '', mode: 'listener' } });
			}

			if (op === 'profileStart') {
				// 显式按需:不常开、单飞。开不起来(会话未连接 / Profiler.* 报错)照实回原文。
				const result = await profiler.start(body.seconds);
				return reply(result, result.ok ? 200 : 500);
			}

			if (op === 'profileGet') {
				const result = profiler.get();
				return reply(result, result.ok ? 200 : 404);
			}

			// ── 武装窗口:分段滚动采样(方向 2 的按需版)──
			// 窗口时长由客户端给,宿主到点自己停:页面关掉/崩掉都不会留下常开的采样。
			if (op === 'armedStart') {
				const result = await armed.start(body.windowSeconds, body.segmentSeconds);
				// 409 = 已有一个窗口在跑(重入被拒),500 = inspector / Profiler.* 起不来。
				const status = result.ok === true ? 200 : (result.error === ARMED_BUSY ? 409 : 500);
				return reply(result, status);
			}

			if (op === 'armedGet') {
				return reply(armed.get(body.since));
			}

			if (op === 'armedStop') {
				return reply(armed.stop(typeof body.reason === 'string' ? body.reason : 'client-stop'));
			}

			// ── 后台低占空比滚动采样(方向 2 的常开版)──
			// 默认是关的:不调 ambientStart 就一段都不采。手动 / 武装随时可以顶掉它的在飞段。
			if (op === 'ambientStart') {
				return reply(await ambient.start({
					intervalSeconds: body.intervalSeconds,
					segmentSeconds: body.segmentSeconds,
					keep: body.keep,
				}));
			}

			if (op === 'ambientGet') {
				return reply(ambient.get(body.since));
			}

			if (op === 'ambientStop') {
				return reply(ambient.stop(typeof body.reason === 'string' ? body.reason : 'client-stop'));
			}

			if (op === 'arm') {
				// 面板/实验工具在 setBundle 之前先领一张票据;GET 不签发,避免被缓存或预取消耗。
				// 同源脚本也能调这个 op —— 所以票据是反盲 CSRF / 重放,不是授权边界。
				return reply(issueTicket());
			}

			if (op === 'listBundles') {
				const service = manager();
				if (service === null) return reply({ ok: false, error: 'pluginManager 不可用' }, 503);
				try {
					const bundles = await service.listBundles();
					return reply({
						ok: true,
						bundles: bundles.map((bundle) => ({
							name: bundle.name,
							version: bundle.version,
							enabled: bundle.enabled,
							installed: bundle.installed,
							removable: bundle.removable,
						})),
					});
				} catch (error) {
					return reply({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
				}
			}

			if (op === 'setBundle') {
				// 只认一次性票据:confirm:true 是调用方自称,不构成授权边界。
				// 票据同样只反盲 CSRF / 重放,不区分调用者身份(同源脚本可以自己 arm)。
				const ticketState = consumeTicket(body.ticket);
				if (ticketState !== '') {
					const error = ticketState === 'missing'
						? '需要先 POST {op:"arm"} 领一张一次性票据'
						: ticketState === 'expired'
							? '票据已过期(有效期 30 秒),请重新 arm'
							: '票据无效或已被使用';
					return reply({ ok: false, error }, 403);
				}
				const name = body.name;
				const enabled = body.enabled === true;
				if (typeof name !== 'string' || name === '') return reply({ ok: false, error: '缺少 bundle 名' }, 400);
				if (name === 'dsh-perf-hud' || name === '@deepseek-ai/dsh-session-persistence-jsonl') {
					return reply({ ok: false, error: `拒绝改动 ${name}` }, 400);
				}
				const service = manager();
				if (service === null) return reply({ ok: false, error: 'pluginManager 不可用' }, 503);
				try {
					const result = await service.setBundleEnabled(name, enabled);
					return reply({ ok: true, result: JSON.parse(JSON.stringify(result ?? null)) });
				} catch (error) {
					return reply({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
				}
			}

			return reply({ ok: false, error: `未知 op:${String(op)}` }, 400);
		};

		try {
			c.effect(() => register({ path: ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handler }), 'perf-hud: host route');
		} catch (error) {
			// 路由冲突或 carrier 未就绪:宿主半静默退化,客户端会看到 host 不可用。
		}
	});
}
