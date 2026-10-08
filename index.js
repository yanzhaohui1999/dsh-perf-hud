/**
 * dsh-perf-hud 的 Host 半边。
 *
 * 只做四件事,全部经 `connection.fetch.register` 挂在 `/api/dsh-perf-hud/host`:
 *   1. GET  —— 事件循环延迟(perf_hooks.monitorEventLoopDelay 的每秒 p50/p99/max);
 *              同时兼作客户端的 RTT 探测端点(?pad=1KB 禁缓存)与吞吐探测(?bytes=N)。
 *   2. POST {op:'watchEvents'}  —— 可选:包住 session/event 的同步派发,累计每条事件的
 *              派发耗时与次数。装不上就如实回 installed:false + reason,不假装成功。
 *   3. POST {op:'listBundles'|'setBundle'} —— 代理 pluginManager 的 bundle 读写,供
 *              「隔离实验」用。setBundle 必须显式带 confirm:true 才执行,绝不隐式写配置。
 *   4. POST {op:'profileStart', seconds?} / {op:'profileGet'} —— 按需采一段宿主进程的
 *              CPU profile(node:inspector 的 Profiler,产出标准 .cpuprofile);**不常开**,
 *              同时只允许一个采样在跑,profile 只在内存里、不落盘。
 *
 * 不注册服务、不监听事件(除非显式开启 watchEvents)、不写任何插件自己的持久化状态。
 * 特别注意:本文件不碰 cordis.patch.yml,也不碰 profile 的持久化配置行。
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Session as InspectorSession } from 'node:inspector';
import { readFileSync } from 'node:fs';

/** 本插件自己的版本(导出件要自描述;不要去猜,直接读自己的 package.json)。 */
const PLUGIN_VERSION = (() => {
	try {
		return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? null;
	} catch (error) {
		return null;
	}
})();

const ROUTE = '/api/dsh-perf-hud/host';
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
 * `start` 只等在"真的开起来"这一步(毫秒级)就返回,`stop` 由定时器异步收尾 —— 一次 HTTP
 * 请求不该挂 5 秒;调用方按 `running` 轮询,采完再 `get()` 取回。
 */
function createCpuProfiler(inspector) {
	let session = null;
	let timer = null;
	let running = false;
	let startedAt = 0;
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
		collected: profile !== null,
		collections,
		lastSeconds: meta === null ? null : meta.seconds,
		bytes: meta === null ? 0 : meta.bytes,
		samples: meta === null ? 0 : meta.samples,
		meta,
		error,
	});

	/** 收尾:`Profiler.stop` 拿 profile,成功才换掉缓存,失败只更新 error。 */
	async function finish() {
		const sess = session;
		timer = null;
		let failure = '';
		try {
			const result = await post(sess, 'Profiler.stop');
			const next = result === null || result === undefined ? null : result.profile;
			if (next === null || typeof next !== 'object' || !Array.isArray(next.nodes)) {
				throw new Error('Profiler.stop 没有返回 profile');
			}
			profile = next;
			collections += 1;
			meta = {
				startedAt,
				endedAt: Date.now(),
				seconds: round2((Date.now() - startedAt) / 1000),
				nodes: next.nodes.length,
				samples: Array.isArray(next.samples) ? next.samples.length : 0,
				bytes: JSON.stringify(next).length,
				pid: process.pid,
				nodeVersion: process.version,
			};
		} catch (err) {
			failure = reason(err);
		} finally {
			running = false;
			session = null;
			try { sess?.disconnect(); } catch (ignored) { /* 断开失败不影响读数 */ }
		}
		error = failure;
		return failure === '' ? { ...state(), ok: true } : { ...state(), ok: false, error: failure };
	}

	return {
		/** 触发一次采样;只在"真的开起来了"之后才返回 ok。 */
		async start(rawSeconds) {
			const seconds = clampSeconds(rawSeconds);
			// 先展开 state、再放本次请求专用的字段:同名字段以本次为准(否则 seconds 会被 null 盖掉)。
			if (running) return { ...state(), ok: false, error: '已有一个采样在进行中', seconds };
			if (typeof inspector?.Session !== 'function') {
				error = 'node:inspector 不可用';
				return { ...state(), ok: false, error, seconds };
			}
			let sess = null;
			try {
				sess = new inspector.Session();
				sess.connect();
				await post(sess, 'Profiler.enable');
				await post(sess, 'Profiler.start');
			} catch (err) {
				try { sess?.disconnect(); } catch (ignored) { /* 半开的会话也要收掉 */ }
				error = reason(err);
				return { ...state(), ok: false, error, seconds };
			}
			session = sess;
			running = true;
			error = '';
			startedAt = Date.now();
			timer = setTimeout(() => { void finish(); }, seconds * 1000);
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

	ctx.effect(() => () => {
		loop.stop();
		watch.uninstall();
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

		const status = (url) => {
			const bytes = Math.min(Number(url.searchParams.get('bytes') ?? 0) || 0, MAX_LOAD_BYTES);
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
				// 明确同意才会真的写:隔离实验必须逐次带 confirm。
				if (body.confirm !== true) return reply({ ok: false, error: '需要 confirm:true' }, 400);
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
