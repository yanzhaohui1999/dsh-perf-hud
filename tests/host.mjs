/**
 * 宿主半的离线验证(真跑,不 mock monitorEventLoopDelay):
 *
 *   node tests/host.mjs
 *
 * 用一个最小 ctx 装上 index.js 的 apply(),拿到它注册的 /api/dsh-perf-hud/host 路由,
 * 直接以 Request/Response 驱动它,断言:GET 探针、事件循环读数、bundle 读写代理、
 * 以及"没有一次性票据绝不写配置"这道门(票据只反盲 CSRF / 重放,不是授权边界)。
 * 顺带打印真实测到的事件循环延迟。
 *
 * CPU profile 那一段**不真的去采**(那是进程级的重活),用假的 inspector 桩注入 ——
 * 与客户端半 logic.mjs 的做法一致:测的是 index.js 那份代码,不是另写一份等价实现。
 */
import { readFileSync } from 'node:fs';
import { apply } from '../index.js';

let failed = 0;
const check = (name, ok, detail = '') => {
	if (!ok) failed += 1;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  ${detail}`}`);
};

/** 轮询等待:每 10ms 检查一次,最多 2 秒。慢 CI 上不靠"睡固定毫秒"赌采样已经收尾。 */
const waitUntil = async (predicate, timeoutMs = 2000) => {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return (await predicate()) === true;
};

const dispatched = [];
const proto = {
	emit(name, ...args) {
		dispatched.push([name, args.length]);
		return `emitted:${name}`;
	},
};
const root = Object.create(proto);

const bundles = [
	{ name: 'dsh-status-rotator', version: '0.35.0', enabled: true, installed: true, removable: true },
	{ name: 'dsh-notify-me', version: '1.5.3', enabled: true, installed: true, removable: true },
];
const writes = [];
const manager = {
	async listBundles() { return bundles; },
	async setBundleEnabled(name, enabled) {
		writes.push([name, enabled]);
		const bundle = bundles.find((item) => item.name === name);
		if (bundle !== undefined) bundle.enabled = enabled;
		return { changed: true, application: 'applied', stage: 'enable', target: name, enabled };
	},
};

// ── 假的 inspector 桩:离线套件不真的去采(进程级的重活) ────────────
// 只记录被调用的方法名 + 回一份最小但**结构合法**的 .cpuprofile,用来断言状态机与拒绝路径。
const inspectorCalls = [];
const fakeProfile = {
	nodes: [
		{ id: 1, callFrame: { functionName: 'fakeHostLoop', url: '/w/index.js', lineNumber: 1, columnNumber: 1 }, hitCount: 3, children: [] },
		{ id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: 0, columnNumber: 0 }, hitCount: 1, children: [] },
	],
	startTime: 1000,
	endTime: 61000,
	samples: [1, 1, 2],
	timeDeltas: [100, 200, 300],
};
const fakeInspector = {
	Session: class {
		connect() { inspectorCalls.push('connect'); }
		disconnect() { inspectorCalls.push('disconnect'); }
		post(method, _params, callback) {
			inspectorCalls.push(method);
			if (method === 'Profiler.stop') callback(null, { profile: fakeProfile });
			else callback(null, {});
		}
	},
};

const routes = new Map();
const disposers = [];
const listeners = new Map();          // 宿主 ctx.on 注册的监听器(公开接口)
const unsubscribed = [];
const pluginContext = {
	root,
	get() { return undefined; },
	on(name, listener) {
		listeners.set(name, listener);
		return () => {
			listeners.delete(name);
			unsubscribed.push(name);
		};
	},
	effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {}; },
	inject(_names, callback) {
		callback({
			get: (name) => (name === 'connection'
				? { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } }
				: name === 'pluginManager' ? manager : undefined),
			effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {}; },
		});
	},
};

// 票据 TTL 在测试里压到 150ms:过期路径不用真等 30 秒,正常路径的 arm→setBundle 仍是毫秒级。
apply(pluginContext, { inspector: fakeInspector, armTtlMs: 150 });

const route = routes.get('/api/dsh-perf-hud/host');
check('注册了 /api/dsh-perf-hud/host', route !== undefined);
check('接受 GET 与 POST', JSON.stringify(route?.methods) === JSON.stringify(['GET', 'POST']));

const get = (query) => route.fetch(new Request(`http://dsh.invalid/api/dsh-perf-hud/host${query}`));
const post = (body) => route.fetch(new Request('http://dsh.invalid/api/dsh-perf-hud/host', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
}));

// ── GET 探针:同时是 RTT/吞吐端点 ───────────────────────────────────
// RTT 探针:请求带 1KB cache-buster(响应本身很小);吞吐探针:?bytes=N 让宿主回 N 字节
const probe = await (await get('?pad=' + 'x'.repeat(1024))).json();
check('RTT 探针(1KB cache-buster)拿到正常响应', probe.ok === true && probe.pad === undefined);
check('GET 报出宿主身份', typeof probe.host?.nodeVersion === 'string', probe.host?.nodeVersion);
const load = await (await get('?bytes=65536')).json();
check('吞吐探针返回 64KB', load.pad?.length === 65536);
check('事件循环监控已启用', probe.host?.eventLoopLive === true);

// ── 事件循环延迟:真等 1.2 秒,让直方图出一个采样 ──────────────────
await new Promise((resolve) => setTimeout(resolve, 1200));
// 制造一点阻塞,确保 p99/max 有非零读数
const spinUntil = Date.now() + 60;
while (Date.now() < spinUntil) { /* 主动阻塞一次,给 max 留证据 */ }
await new Promise((resolve) => setTimeout(resolve, 1200));
const after = await (await get('')).json();
const ring = after.host?.eventRing ?? [];
check('事件循环环形采样 ≥ 1 条', ring.length >= 1, `seconds=${ring.length}`);
check('p50/p99 是数字', Number.isFinite(after.host?.eventLoop?.p50) && Number.isFinite(after.host?.eventLoop?.p99),
	`p50=${after.host?.eventLoop?.p50}ms p99=${after.host?.eventLoop?.p99}ms max=${after.host?.eventLoop?.max}ms`);
check('主动阻塞被 max 抓到', (after.host?.eventLoop?.max ?? 0) > 0, `max=${after.host?.eventLoop?.max}ms`);

// ── session/event 到达延迟 ────────────────────────────────────────
// 第一版包 Context.emit,线上实测 120 秒 + 一整个子代理回合都没抓到任何事件
// (DSH 的 session/event 走带作用域过滤的派发,绕过公开 emit),所以改成 ctx.on。
const watchOn = await (await post({ op: 'watchEvents', enable: true })).json();
check('到达延迟测量安装成功', watchOn.eventWatch?.installed === true, watchOn.eventWatch?.reason ?? '');
check('口径标成 listener(不冒充派发耗时)', watchOn.eventWatch?.mode === 'listener');
check('监听的是 session/event', typeof listeners.get('session/event') === 'function');
check('没有改动宿主原型的 emit', proto.emit !== undefined && root.emit('turn/start') === 'emitted:turn/start');

const fire = listeners.get('session/event');
fire({}, { type: 'assistant/message', time: Date.now() - 7 });
fire({}, { type: 'tool/call', time: Date.now() - 3 });
fire({}, { type: 'assistant/message', time: Date.now() - 11 });
const watched = await (await post({ op: 'status' })).json();
const eventStats = watched.host?.eventWatch?.stats ?? {};
check('按事件类型分别计数',
	eventStats['assistant/message']?.count === 2 && eventStats['tool/call']?.count === 1, JSON.stringify(eventStats));
check('记的是提交→到达延迟(两次 ≥18ms 累计)', eventStats['assistant/message']?.ms >= 18, `ms=${eventStats['assistant/message']?.ms}`);
check('单次最大延迟有记录', eventStats['assistant/message']?.max >= 11, `max=${eventStats['assistant/message']?.max}`);

// 版本号必须真的读到**本包**的 package.json:曾经写成 '../package.json',解析到包外
// (实测 ENOENT)→ 回执里恒为 null,而且当时没有任何断言看得见。
const ownVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
check('宿主回执里的 pluginVersion = 本包版本', watched.host?.pluginVersion === ownVersion,
	`got ${JSON.stringify(watched.host?.pluginVersion)} want ${JSON.stringify(ownVersion)}`);

const watchOff = await (await post({ op: 'watchEvents', enable: false })).json();
check('能卸载监听器', watchOff.eventWatch?.installed === false && listeners.has('session/event') === false,
	`unsubscribed=${JSON.stringify(unsubscribed)}`);

// ── bundle 读写代理:一次性票据优先 ────────────────────────────────
// 旧实现只校验调用方自带的 confirm:true。现在必须先 arm 领票据,30 秒有效、单次使用
// (测试里压到 150ms,过期路径不用真等 30 秒)。注意:这是反盲 CSRF / 重放的门,不是
// 授权边界 —— 同源脚本可以自己 POST {op:'arm'} 取票,所以这里不测"脚本拿不到票"。
const listed = await (await post({ op: 'listBundles' })).json();
check('listBundles 代理可用', listed.bundles?.length === 2, listed.bundles?.map((b) => b.name).join(','));

const noTicket = await post({ op: 'setBundle', name: 'dsh-status-rotator', enabled: false, confirm: true });
check('没有票据时拒绝(confirm:true 不再是授权)', noTicket.status === 403, `status=${noTicket.status}`);
check('没有票据时一次都没写', writes.length === 0);

const forged = await post({ op: 'setBundle', name: 'dsh-status-rotator', enabled: false, ticket: 'forged-ticket' });
check('伪造票据被拒(403)', forged.status === 403, `status=${forged.status}`);
check('伪造票据也没有写', writes.length === 0);

const armed1 = await (await post({ op: 'arm' })).json();
check('arm 签发一张不可猜的票据', armed1.ok === true && typeof armed1.ticket === 'string' && armed1.ticket.length >= 16,
	`len=${armed1.ticket?.length} ttl=${armed1.ttlMs}`);
const armed2 = await (await post({ op: 'arm' })).json();
check('每次 arm 的票据都不同(不可猜、不可复用)', armed1.ticket !== armed2.ticket);

const guard = await post({ op: 'setBundle', name: 'dsh-perf-hud', enabled: false, ticket: armed1.ticket });
check('拒绝动自己(400)', guard.status === 400);

// 拒绝路径有**两条** deny 名单,只测一条等于另一条没人钉(改坏了照样全绿)
const guardSession = await post({ op: 'setBundle', name: '@deepseek-ai/dsh-session-persistence-jsonl', enabled: false, ticket: armed2.ticket });
check('拒绝动 session-persistence-jsonl(400)', guardSession.status === 400);
check('两条 deny 名单都拒绝时一次都没写', writes.length === 0);

const armed3 = await (await post({ op: 'arm' })).json();
const ok = await (await post({ op: 'setBundle', name: 'dsh-status-rotator', enabled: false, ticket: armed3.ticket })).json();
check('有效票据写入并把 ChangeResult 原样带回', ok.result?.application === 'applied' && writes.length === 1,
	JSON.stringify(writes));

const replay = await post({ op: 'setBundle', name: 'dsh-status-rotator', enabled: true, ticket: armed3.ticket });
check('同一张票据第二次使用被拒(单次使用)', replay.status === 403, `status=${replay.status}`);
check('重放被拒后没有再写', writes.length === 1);

const armedExpiring = await (await post({ op: 'arm' })).json();
await new Promise((resolve) => setTimeout(resolve, 220));
const expired = await post({ op: 'setBundle', name: 'dsh-status-rotator', enabled: true, ticket: armedExpiring.ticket });
check('过期票据被拒(150ms 测试 TTL)', expired.status === 403, `status=${expired.status}`);
check('过期票据也没有写', writes.length === 1);

const unknown = await post({ op: 'nope' });
check('未知 op 返回 400', unknown.status === 400);

// ── 宿主 CPU profile:显式按需、单飞、不假装成功 ────────────────────
// 采样有开销,所以先钉住"没触发就是没采过" —— 回的是状态而不是空对象,
// 否则调用方会把"从没采过"读成"采到了但宿主是空的"。
const idleProfile = await (await get('')).json();
check('未触发时状态是没采过(不常开)',
	idleProfile.host?.cpuProfile?.collected === false && idleProfile.host?.cpuProfile?.collections === 0
	&& idleProfile.host?.cpuProfile?.running === false, JSON.stringify(idleProfile.host?.cpuProfile));
const noProfileYet = await post({ op: 'profileGet' });
const noProfileBody = await noProfileYet.json();
check('没采过就照实说"还没采过"', noProfileBody.ok === false && noProfileBody.error === '还没采过',
	JSON.stringify(noProfileBody).slice(0, 120));
check('没采过取回是 404(不是 200 空对象)', noProfileYet.status === 404, `status=${noProfileYet.status}`);

const started = await (await post({ op: 'profileStart', seconds: 0.1 })).json();
check('显式触发后进入采集中', started.ok === true && started.running === true && started.seconds === 0.1,
	JSON.stringify(started).slice(0, 120));
check('走的是 Profiler.enable → Profiler.start', JSON.stringify(inspectorCalls) === JSON.stringify(['connect', 'Profiler.enable', 'Profiler.start']),
	JSON.stringify(inspectorCalls));

const second = await post({ op: 'profileStart', seconds: 0.1 });
const secondBody = await second.json();
check('同一时间只允许一个采样(重入被拒)', secondBody.ok === false && second.status === 500, secondBody.error);
check('重入被拒时没有再开一次采样', inspectorCalls.filter((m) => m === 'Profiler.start').length === 1);

await waitUntil(async () => (await (await get('')).json()).host?.cpuProfile?.collected === true);
const collected = await (await post({ op: 'profileGet' })).json();
check('采完能取回标准 .cpuprofile 结构',
	collected.ok === true && Array.isArray(collected.profile?.nodes) && Array.isArray(collected.profile?.samples)
	&& typeof collected.profile?.startTime === 'number', JSON.stringify(collected.meta));
check('profile 原样返回(不被加工)', collected.profile?.nodes?.[0]?.callFrame?.functionName === 'fakeHostLoop');
check('带回自描述元信息(时长/节点/采样/字节/pid)',
	collected.meta?.bytes > 0 && collected.meta?.nodes === 2 && collected.meta?.samples === 3
	&& collected.meta?.pid === process.pid && collected.running === false && collected.collections === 1,
	JSON.stringify(collected.meta));
check('采完断开 inspector 会话(不留常开句柄)',
	inspectorCalls.filter((m) => m === 'Profiler.stop').length === 1 && inspectorCalls.at(-1) === 'disconnect',
	JSON.stringify(inspectorCalls));

// ── 武装窗口:分段滚动采样(方向 2 的按需版)────────────────────────────
// 与手动采样共用同一台 profiler:窗口里手动 profileStart 会被单飞挡住;窗口到点自己停。
const beforeArmed = inspectorCalls.filter((m) => m === 'Profiler.start').length;
const armedIdle = await (await get('')).json();
check('武装:没开窗口时宿主不采(不常开)',
	armedIdle.host?.armed?.active === false && armedIdle.host?.armed?.kept === 0
	&& armedIdle.host?.armed?.samplingStarted === false, JSON.stringify(armedIdle.host?.armed));
check('武装:GET 只回状态,不回段本体(段里有原始 .cpuprofile)',
	armedIdle.host?.armed?.segments === undefined, true);

const armedStartRes = await post({ op: 'armedStart', windowSeconds: 0.1, segmentSeconds: 0.2 });
const armedStarted = await armedStartRes.json();
check('武装:窗口时长夹到下限 0.5 秒,段长按请求值',
	armedStarted.ok === true && armedStarted.armed?.windowSeconds === 0.5 && armedStarted.armed?.segmentSeconds === 0.2,
	JSON.stringify({ w: armedStarted.armed?.windowSeconds, s: armedStarted.armed?.segmentSeconds }));
check('武装:开窗口立刻起第一段采样(共用那台 profiler)',
	armedStarted.armed?.samplingStarted === true
	&& inspectorCalls.filter((m) => m === 'Profiler.start').length === beforeArmed + 1,
	JSON.stringify(inspectorCalls.slice(-3)));

const armedBusyRes = await post({ op: 'profileStart', seconds: 0.1 });
const armedBusy = await armedBusyRes.json();
check('武装:窗口期间手动 profileStart 被单飞挡住(不叠采;running:true 说的是武装那段在跑)',
	armedBusyRes.status === 500 && armedBusy.ok === false && armedBusy.running === true, JSON.stringify(armedBusy.error));

const armedSecondRes = await post({ op: 'armedStart', windowSeconds: 2, segmentSeconds: 1 });
const armedSecond = await armedSecondRes.json();
check('武装:已有窗口在跑时重入被拒(409)',
	armedSecondRes.status === 409 && armedSecond.ok === false, `${armedSecondRes.status} ${armedSecond.error}`);

await new Promise((resolve) => setTimeout(resolve, 1400));
const armedGot = await (await post({ op: 'armedGet' })).json();
const armedSegments = Array.isArray(armedGot.segments) ? armedGot.segments : [];
check('武装:窗口里采到至少一段,每段带 meta 与原始 profile',
	armedSegments.length >= 1
	&& armedSegments.every((row) => Array.isArray(row.profile?.nodes) && typeof row.meta?.startedAt === 'number' && typeof row.meta?.endedAt === 'number'),
	`segments=${armedSegments.length}`);
check('武装:段序号从 0 起、连续递增(客户端按 since 增量取)',
	armedSegments.every((row, i) => i === 0 ? row.index === 0 : row.index === armedSegments[i - 1].index + 1),
	armedSegments.map((row) => row.index).join(','));
const armedAfter = await (await get('')).json();
check('武装:到点自己停(窗口结束不留在宿主里常开)',
	armedAfter.host?.armed?.active === false && armedAfter.host?.armed?.stopReason === 'timeout'
	&& armedAfter.host?.armed?.kept === armedSegments.length,
	JSON.stringify({ active: armedAfter.host?.armed?.active, reason: armedAfter.host?.armed?.stopReason, kept: armedAfter.host?.armed?.kept }));
const armedIncremental = await (await post({ op: 'armedGet', since: armedSegments[armedSegments.length - 1].index })).json();
check('武装:since 之后没有新段就回空数组(增量取不每次背全部)',
	Array.isArray(armedIncremental.segments) && armedIncremental.segments.length === 0, armedIncremental.segments?.length);

// 主动停:正在飞的那一段仍然收完并留下(证据不因窗口结束消失)
await (await post({ op: 'armedStart', windowSeconds: 5, segmentSeconds: 1 })).json();
const armedStopRes = await (await post({ op: 'armedStop', reason: 'test-stop' })).json();
check('武装:armedStop 立刻停(active=false,reason 照抄,在飞的那段标 windingDown)',
	armedStopRes.ok === true && armedStopRes.armed?.active === false
	&& armedStopRes.armed?.stopReason === 'test-stop' && armedStopRes.windingDown === true,
	JSON.stringify({ active: armedStopRes.armed?.active, reason: armedStopRes.armed?.stopReason, windingDown: armedStopRes.windingDown }));
await new Promise((resolve) => setTimeout(resolve, 1500));
const armedAfterStop = await (await post({ op: 'armedGet' })).json();
check('武装:主动停之后,在飞的那一段仍然留下',
	Array.isArray(armedAfterStop.segments) && armedAfterStop.segments.length >= 1 && armedAfterStop.armed?.active === false,
	`segments=${armedAfterStop.segments?.length}`);
check('武装:停之后不会再起新段(段数在窗口结束后保持稳定)', (() => {
	const kept = armedAfterStop.armed?.kept ?? 0;
	return kept >= 1 && armedAfterStop.armed?.samplingStarted === true;
})(), true);

// 失败路径:宿主已经开着别的 profiler / inspector 被占 —— 必须回错误原文,绝不假装成功。
const routes2 = new Map();
const CONNECT_ERROR = 'inspector 会话不可用:已被占用';
const ctx2 = {
	root: Object.create(proto),
	get() { return undefined; },
	on() { return () => {}; },
	effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {}; },
	inject(_names, callback) {
		callback({
			get: (name) => (name === 'connection'
				? { fetch: { register: (route) => { routes2.set(route.path, route); return () => {}; } } }
				: undefined),
			effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {}; },
		});
	},
};
apply(ctx2, {
	inspector: { Session: class { connect() { throw new Error(CONNECT_ERROR); } disconnect() {} post() {} } },
});
const route2 = routes2.get('/api/dsh-perf-hud/host');

// 默认 TTL 单独钉:上面主实例注入 armTtlMs:150 只验证"过期会拒",默认值本身没人管。
// 这里用不注入 armTtlMs 的 route2 —— 把 ARM_TTL_MS 改成 600000,这条必须红。
const defaultArm = await (await route2.fetch(new Request('http://dsh.invalid/api/dsh-perf-hud/host', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ op: 'arm' }),
}))).json();
const defaultTtlLeft = (defaultArm.expiresAt ?? 0) - Date.now();
check('默认票据 TTL 是 30 秒(未注入 armTtlMs)', defaultArm.ok === true && defaultArm.ttlMs === 30000
	&& defaultTtlLeft > 25000 && defaultTtlLeft <= 30000,
	`ttlMs=${defaultArm.ttlMs} left=${defaultTtlLeft}ms`);

const failedRes = await route2.fetch(new Request('http://dsh.invalid/api/dsh-perf-hud/host', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ op: 'profileStart' }),
}));
const failedBody = await failedRes.json();
check('会话建不起来时回错误原文', failedBody.ok === false && failedBody.error === CONNECT_ERROR,
	JSON.stringify(failedBody.error));
check('失败如实回 5xx,且没进入采集中', failedRes.status === 500 && failedBody.running === false,
	`status=${failedRes.status}`);
check('失败时也照实报默认时长(5 秒)', failedBody.seconds === 5, `seconds=${failedBody.seconds}`);
const failedGet = await route2.fetch(new Request('http://dsh.invalid/api/dsh-perf-hud/host', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ op: 'profileGet' }),
}));
const failedGetBody = await failedGet.json();
check('失败之后仍然是"没采过"', failedGetBody.ok === false && failedGetBody.collected === false,
	JSON.stringify(failedGetBody).slice(0, 120));

// 武装窗口同样不假装成功:窗口被接受,但 samplingStarted=false + 错误原文,段数为 0。
const armedFailRes = await route2.fetch(new Request('http://dsh.invalid/api/dsh-perf-hud/host', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ op: 'armedStart', windowSeconds: 1, segmentSeconds: 0.2 }),
}));
const armedFailBody = await armedFailRes.json();
check('武装:inspector 起不来时窗口不假装采起来(samplingStarted=false + 错误原文)',
	armedFailBody.ok === true && armedFailBody.armed?.active === true
	&& armedFailBody.armed?.samplingStarted === false && armedFailBody.armed?.error === CONNECT_ERROR
	&& armedFailBody.armed?.kept === 0,
	JSON.stringify({ started: armedFailBody.armed?.samplingStarted, error: armedFailBody.armed?.error }));
const armedFailStop = await (await route2.fetch(new Request('http://dsh.invalid/api/dsh-perf-hud/host', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ op: 'armedStop', reason: 'test-cleanup' }),
}))).json();
check('武装:失败窗口也能被主动停掉(不留重试循环)', armedFailStop.ok === true && armedFailStop.armed?.active === false,
	JSON.stringify(armedFailStop.armed?.stopReason));

// ── 宿主 stop → start:同一台 profiler 停下之后能重新采,不留两代状态 ──
// REVIEW §5-3:stop() 原来只清 session/timer,不把 running 放回 false(变异体存活)。
// 那样「关掉 HUD 再打开」会永远卡在"已有一个采样在进行中"。这里不 mock monitorEventLoopDelay,
// 真停真起(仍用上面的假 inspector,离线不采真 profile),走的是 apply() 注册的卸载句柄。
const hostDispose = disposers[0];
check('宿主:拿到宿主卸载句柄(前置条件)', typeof hostDispose === 'function');
const collectionsBefore = (await (await get('')).json()).host?.cpuProfile?.collections ?? 0;
const runningBefore = await (await post({ op: 'profileStart', seconds: 5 })).json();
check('宿主:停之前先开一段 5 秒采样(前置条件)',
	runningBefore.ok === true && runningBefore.running === true, JSON.stringify(runningBefore).slice(0, 100));
const startsBeforeRestart = inspectorCalls.filter((m) => m === 'Profiler.start').length;
const connectsBeforeRestart = inspectorCalls.filter((m) => m === 'connect').length;
const stopsBeforeRestart = inspectorCalls.filter((m) => m === 'Profiler.stop').length;
hostDispose();
const afterStop = await (await get('')).json();
const stopState = afterStop.host?.cpuProfile ?? {};
check('宿主:stop() 后 running === false,旧 profile 不丢',
	stopState.running === false && stopState.collected === true && stopState.collections === collectionsBefore,
	JSON.stringify({ running: stopState.running, collected: stopState.collected, collections: stopState.collections }));
const restarted = await (await post({ op: 'profileStart', seconds: 0.1 })).json();
check('宿主:stop() 后再次 start() 成功(不报"已有一个采样在进行中")',
	restarted.ok === true && restarted.running === true, JSON.stringify(restarted).slice(0, 120));
await waitUntil(async () => {
	const state = (await (await get('')).json()).host?.cpuProfile ?? {};
	return state.collections === collectionsBefore + 1 && state.running === false;
});
const restartedDone = await (await get('')).json();
const restartedState = restartedDone.host?.cpuProfile ?? {};
const connectDelta = inspectorCalls.filter((m) => m === 'connect').length - connectsBeforeRestart;
const startDelta = inspectorCalls.filter((m) => m === 'Profiler.start').length - startsBeforeRestart;
const stopDelta = inspectorCalls.filter((m) => m === 'Profiler.stop').length - stopsBeforeRestart;
check('宿主:重启只产出一代状态(collections +1,connect / start / stop 各 +1)',
	restartedState.running === false && restartedState.collections === collectionsBefore + 1
	&& restartedState.error === '' && connectDelta === 1 && startDelta === 1 && stopDelta === 1,
	JSON.stringify({ running: restartedState.running, collections: restartedState.collections,
		error: restartedState.error, connectDelta, startDelta, stopDelta }));

// ── 采样世代:采样中 stop → start,旧 finish 不得覆盖新一代 ────────────
// 复现窗口:定时器已触发 finish(),`Profiler.stop` 还挂着;这时卸载(dispose)再重新
// profileStart。旧 finish 返回时必须只收掉自己的会话,不能把新一代的 running 打回 false、
// 也不能把旧 profile 写进缓存。用一台新 ctx + 可暂扣 Profiler.stop 的 inspector 隔离状态。
const staleProfile = {
	nodes: [{ id: 9, callFrame: { functionName: 'staleGeneration', url: '/w/old.js', lineNumber: 1, columnNumber: 1 }, hitCount: 1, children: [] }],
	startTime: 1,
	endTime: 2,
	samples: [9],
	timeDeltas: [1],
};
const routes3 = new Map();
const ctx3Disposers = [];
let heldStop = null;
let gateNextStop = true;
const gatedInspector = {
	Session: class {
		connect() {}
		disconnect() {}
		post(method, _params, callback) {
			if (method === 'Profiler.stop' && gateNextStop === true) {
				gateNextStop = false;
				heldStop = callback;
				return;
			}
			callback(null, method === 'Profiler.stop' ? { profile: fakeProfile } : {});
		}
	},
};
const ctx3 = {
	root: Object.create(proto),
	get() { return undefined; },
	on() { return () => {}; },
	effect(fn) { const dispose = fn(); if (typeof dispose === 'function') ctx3Disposers.push(dispose); return () => {}; },
	inject(_names, callback) {
		callback({
			get: (name) => (name === 'connection'
				? { fetch: { register: (route) => { routes3.set(route.path, route); return () => {}; } } }
				: undefined),
			effect(fn) { const dispose = fn(); if (typeof dispose === 'function') ctx3Disposers.push(dispose); return () => {}; },
		});
	},
};
apply(ctx3, { inspector: gatedInspector });
const route3 = routes3.get('/api/dsh-perf-hud/host');
const get3 = () => route3.fetch(new Request('http://dsh.invalid/api/dsh-perf-hud/host'));
const post3 = (body) => route3.fetch(new Request('http://dsh.invalid/api/dsh-perf-hud/host', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
}));

const started3 = await (await post3({ op: 'profileStart', seconds: 0.1 })).json();
check('世代:第一代采样已开始(前置条件)', started3.ok === true && started3.running === true,
	JSON.stringify(started3).slice(0, 100));
await waitUntil(() => heldStop !== null);
check('世代:Profiler.stop 已发出并被暂扣(前置条件)', typeof heldStop === 'function');
const midFinish = await (await get3()).json();
check('世代:收尾挂起时仍报「采集中」', midFinish.host?.cpuProfile?.running === true,
	JSON.stringify(midFinish.host?.cpuProfile));

ctx3Disposers[0]();                       // 关 HUD:停掉 timer / 会话
const stopped3 = await (await get3()).json();
check('世代:卸载后 running=false(前置条件)', stopped3.host?.cpuProfile?.running === false,
	JSON.stringify(stopped3.host?.cpuProfile));

const second3 = await (await post3({ op: 'profileStart', seconds: 0.1 })).json();
check('世代:卸载后立刻重新 start 成功(前置条件)', second3.ok === true && second3.running === true,
	JSON.stringify(second3).slice(0, 100));

// 放行旧一代的 profiler.stop,并把一份可辨认的旧 profile 交回去。
heldStop(null, { profile: staleProfile });
await new Promise((resolve) => setTimeout(resolve, 20));
const afterStale = await (await get3()).json();
const afterStaleState = afterStale.host?.cpuProfile ?? {};
check('世代:旧 finish 不把新一代 running 打回 false', afterStaleState.running === true, JSON.stringify(afterStaleState));
check('世代:旧 finish 不提交旧 profile(collected 仍为 false)',
	afterStaleState.collected === false && afterStaleState.collections === 0, JSON.stringify(afterStaleState));

await waitUntil(async () => (await (await get3()).json()).host?.cpuProfile?.collections === 1);
const final3 = await (await get3()).json();
const got3 = await (await post3({ op: 'profileGet' })).json();
check('世代:新一代正常收尾(collections=1、running=false)',
	final3.host?.cpuProfile?.running === false && final3.host?.cpuProfile?.collections === 1,
	JSON.stringify(final3.host?.cpuProfile));
check('世代:缓存里是新一代 profile,不是旧一代',
	got3.profile?.nodes?.[0]?.callFrame?.functionName === 'fakeHostLoop', got3.profile?.nodes?.[0]?.callFrame?.functionName);

for (const dispose of ctx3Disposers) {
	if (typeof dispose === 'function') dispose();
}

for (const dispose of disposers) {
	if (typeof dispose === 'function') dispose();
}

console.log(`\n实测(本测试进程,Node ${process.version}):eventLoop p50=${after.host?.eventLoop?.p50}ms ` +
	`p99=${after.host?.eventLoop?.p99}ms max=${after.host?.eventLoop?.max}ms`);
console.log(failed === 0 ? 'ALL PASS' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
