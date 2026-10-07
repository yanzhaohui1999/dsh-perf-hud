/**
 * 宿主半(D)的线上验证 —— 重启之后跑这一个脚本就够了。
 *
 *   COOKIE=$(...)   # 见 ~/.dsh/dsh-api.md 的 token→cookie 三步
 *   DSH_COOKIE="$COOKIE" node tests/live-host.mjs
 *
 * 退出码:0 = 全过;1 = 有断言失败(实现问题);3 = 宿主半还没加载(需要重启 ai.dsh.web)。
 * 它验证:GET 探针(1KB cache-buster 与 64KB 吞吐)、事件循环 p50/p99 是真的在长、
 * session/event 派发计时能装上并记到数、以及"没有 confirm 绝不写 bundle"这条安全线。
 */
const cookie = process.env.DSH_COOKIE ?? '';
if (cookie === '') {
	console.error('缺少 DSH_COOKIE');
	process.exitCode = 2;
	process.exit();
}
const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3080';
const ROUTE = `${BASE}/api/dsh-perf-hud/host`;
const headers = { Host: '127.0.0.1:3080', Cookie: cookie };

let failed = 0;
const check = (name, ok, detail = '') => {
	if (!ok) failed += 1;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  ${detail}`}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = (query = '') => fetch(`${ROUTE}${query}`, { headers, cache: 'no-store' });
const post = (body) => fetch(ROUTE, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ── 先探活:没加载就直接说清楚 ▸ 需要重启
const first = await get(`?t=${Date.now()}&pad=${'x'.repeat(1024)}`);
if (first.status === 404) {
	console.log('宿主半未加载(路由 404):client.js 与 tests 都已就绪,缺一次 `launchctl kickstart -k gui/$(id -u)/ai.dsh.web`。');
	process.exitCode = 3;
	process.exit();
}
check('GET 探针 200', first.status === 200, `HTTP ${first.status}`);

const startedAt = performance.now();
const probeOne = await (await get(`?t=${Date.now()}&pad=${'x'.repeat(1024)}`)).json();
const rtt = Math.round((performance.now() - startedAt) * 10) / 10;
check('探针返回宿主身份', typeof probeOne.host?.nodeVersion === 'string', probeOne.host?.nodeVersion);
check('事件循环监控已启用', probeOne.host?.eventLoopLive === true);
check('RTT 探针不返回 pad(1KB 只在请求里)', probeOne.pad === undefined, `本机 RTT ≈ ${rtt}ms`);

const loadStarted = performance.now();
const load = await (await get(`?t=${Date.now()}&bytes=65536`)).json();
const loadMs = performance.now() - loadStarted;
check('吞吐探针返回 64KB', load.pad?.length === 65536);
console.log(`   本机 64KB 回环 ≈ ${Math.round(loadMs * 10) / 10}ms(≈ ${Math.round(64 / (loadMs / 1000))}KB/s)`);

// ── 事件循环读数必须真的在动
await sleep(2200);
const second = await (await get('')).json();
const ring = second.host?.eventRing ?? [];
check('事件循环环形采样在增长', ring.length >= 2, `seconds=${ring.length}`);
check('p50/p99 是有限数字',
	Number.isFinite(second.host?.eventLoop?.p50) && Number.isFinite(second.host?.eventLoop?.p99),
	`p50=${second.host?.eventLoop?.p50}ms p99=${second.host?.eventLoop?.p99}ms max=${second.host?.eventLoop?.max}ms`);

// ── session/event 到达延迟(空闲会话不产生事件,所以轮询;有回合在跑时立刻有数)
const watch = await (await post({ op: 'watchEvents', enable: true })).json();
check('session/event 到达延迟测量安装成功', watch.eventWatch?.installed === true, watch.eventWatch?.reason ?? '');
// 空闲会话不产生 session/event,所以这里轮询最多 20 秒:
// 有事件就报数字,确实没有就如实说明"窗口内无事件",不把"没数据"判成"没装上"。
let watched = await (await get('')).json();
let stats = watched.host?.eventWatch?.stats ?? {};
let names = Object.keys(stats);
for (let wait = 0; wait < 10 && names.length === 0 && watch.eventWatch?.installed === true; wait += 1) {
	await sleep(2000);
	watched = await (await get('')).json();
	stats = watched.host?.eventWatch?.stats ?? {};
	names = Object.keys(stats);
}
if (watch.eventWatch?.installed === true && names.length === 0) {
	console.log('   注意:窗口内没有 session/event(会话空闲),到达延迟要等有回合在跑时才有');
}
if (names.length > 0) {
	const [name, stat] = Object.entries(stats).sort((a, b) => b[1].ms - a[1].ms)[0];
	console.log(`   派发 Top:${name} ${stat.count} 次 · 合计 ${stat.ms}ms · 单次峰 ${stat.max}ms`);
}

// ── 安全线:没有 confirm 绝不写 bundle
const listed = await (await post({ op: 'listBundles' })).json();
check('listBundles 可用', Array.isArray(listed.bundles) && listed.bundles.length > 0, `${listed.bundles?.length} 个`);
const before = new Map((listed.bundles ?? []).map((bundle) => [bundle.name, bundle.enabled]));
for (const name of ['dsh-status-rotator', 'dsh-notify-me', 'dsh-better-sidebar', 'dsh-context']) {
	check(`候选 ${name} 在列表里`, before.has(name), `enabled=${before.get(name)}`);
}
const refused = await post({ op: 'setBundle', name: 'dsh-status-rotator', enabled: false });
check('没有 confirm 被拒(400)', refused.status === 400, `HTTP ${refused.status}`);
const after = await (await post({ op: 'listBundles' })).json();
const now = new Map((after.bundles ?? []).map((bundle) => [bundle.name, bundle.enabled]));
check('被拒之后 bundle 状态一个字节都没动',
	[...before].every(([name, enabled]) => now.get(name) === enabled), '对照 listBundles 前后快照');

console.log(failed === 0 ? 'ALL PASS' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
