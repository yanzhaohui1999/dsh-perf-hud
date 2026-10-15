/**
 * 宿主半的离线验证(真跑,不 mock monitorEventLoopDelay):
 *
 *   node tests/host.mjs
 *
 * 用一个最小 ctx 装上 index.js 的 apply(),拿到它注册的 /api/dsh-perf-hud/host 路由,
 * 直接以 Request/Response 驱动它,断言:GET 探针、事件循环读数、bundle 读写代理、
 * 以及"没有 confirm 绝不写配置"这条安全线。顺带打印真实测到的事件循环延迟。
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
// 只记录被调用的方法名 + 回一份最小但**结构合法**的 .cpuprofile,用来断言状态机与安全线。
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

apply(pluginContext, { inspector: fakeInspector });

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

// ── bundle 读写代理:安全线优先 ────────────────────────────────────
const listed = await (await post({ op: 'listBundles' })).json();
check('listBundles 代理可用', listed.bundles?.length === 2, listed.bundles?.map((b) => b.name).join(','));

const noConfirm = await post({ op: 'setBundle', name: 'dsh-status-rotator', enabled: false });
check('没有 confirm 时拒绝(400)', noConfirm.status === 400, `status=${noConfirm.status}`);
check('没有 confirm 时一次都没写', writes.length === 0);

const guard = await post({ op: 'setBundle', name: 'dsh-perf-hud', enabled: false, confirm: true });
check('拒绝动自己(400)', guard.status === 400);

// 安全线有**两条** deny 名单,只测一条等于另一条没人钉(改坏了照样全绿)
const guardSession = await post({ op: 'setBundle', name: '@deepseek-ai/dsh-session-persistence-jsonl', enabled: false, confirm: true });
check('拒绝动 session-persistence-jsonl(400)', guardSession.status === 400);
check('两条 deny 名单都拒绝时一次都没写', writes.length === 0);

const ok = await (await post({ op: 'setBundle', name: 'dsh-status-rotator', enabled: false, confirm: true })).json();
check('确认后写入并把 ChangeResult 原样带回', ok.result?.application === 'applied' && writes.length === 1,
	JSON.stringify(writes));

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

await new Promise((resolve) => setTimeout(resolve, 250));
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

for (const dispose of disposers) {
	if (typeof dispose === 'function') dispose();
}

console.log(`\n实测(本测试进程,Node ${process.version}):eventLoop p50=${after.host?.eventLoop?.p50}ms ` +
	`p99=${after.host?.eventLoop?.p99}ms max=${after.host?.eventLoop?.max}ms`);
console.log(failed === 0 ? 'ALL PASS' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
