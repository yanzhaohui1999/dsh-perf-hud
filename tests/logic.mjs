/**
 * 新增逻辑的离线验证(无浏览器也能跑):
 *
 *   node tests/logic.mjs
 *
 * 做法:从 client.js 里按名字抽出真实的函数源码(state / rate / updateRates /
 * pluginTable / blame / worstSecond / isCore / ownerOfUrl),喂进一个最小环境里
 * 断言行为。测试与实现同源,不存在"测的是另一份代码"的问题。
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** 按 header 抽出"从 header 起到配对右括号"的源码;识别字符串/模板串与行注释。 */
function extract(text, header) {
	const start = text.indexOf(header);
	if (start === -1) throw new Error(`extract: missing ${header}`);
	let depth = 0;
	let quote = null;
	for (let i = text.indexOf('{', start); i < text.length; i += 1) {
		const c = text[i];
		if (quote !== null) {
			if (c === '\\') i += 1;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
		if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
		if (c === '{') depth += 1;
		else if (c === '}') {
			depth -= 1;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	throw new Error(`extract: unbalanced ${header}`);
}

const pluginUrl = source.slice(
	source.indexOf('const PLUGIN_URL'),
	source.indexOf('\n', source.indexOf('const PLUGIN_URL')),
);

const pieces = [
	pluginUrl,
	'const state = {',
	'function isCore(',
	'function ownerOfUrl(',
	'function rate(',
	'function updateRates(',
	'function pluginTable(',
	'function round1(',
	'function worstSecond(',
	'function blame(',
].map((header) => extract(source, header)).join('\n');

const api = new Function(`${pieces}
	const ring = [];
	let dirty = false;
	return { state, ring, isCore, ownerOfUrl, rate, updateRates, pluginTable, worstSecond, blame };`)();

let failed = 0;
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failed += 1;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
};

// ── 归因:核心包 vs 插件 ───────────────────────────────────────────────
check('isCore(@deepseek-ai/..)', api.isCore('@deepseek-ai/dsh-client-ui-chat'), true);
check('isCore(插件包)', api.isCore('dsh-status-rotator'), false);
check('ownerOfUrl(插件)', api.ownerOfUrl('http://h/plugins/??dsh-status-rotator/client.js&rev=1'), 'dsh-status-rotator');

// ── rate:必须只看最近 12 秒,空闲后读数要归零 ─────────────────────────
// 前 30 秒猛涨、最近 12 秒完全不动 → 窗口化之后应读到 0
const staleSeries = [];
for (let i = 0; i < 20; i += 1) staleSeries.push({ t: i * 2000, n: i < 10 ? i * 500 : 4500 });
check('rate(早已停止增长) = 0', api.rate(staleSeries), 0);
check('rate(正在涨)', api.rate([{ t: 0, n: 0 }, { t: 2000, n: 100 }, { t: 4000, n: 200 }]), 3000);
check('rate(点太少) = 0', api.rate([{ t: 0, n: 5 }]), 0);

// ── updateRates:每秒活桩 + EMA + 峰值 ────────────────────────────────
api.state.plugins.set('p', { count: 0, ms: 0 });
api.updateRates(1000);
api.state.plugins.get('p').count += 6;   // 1 秒里 6 次
api.state.plugins.get('p').ms += 12;
api.updateRates(2000);
const first = api.pluginTable()[0];
check('第一次活桩 cps = 6/s', first.cps, 6);
check('第一次活桩 msps = 12ms/s', first.msps, 12);
check('峰值记录', first.cpsPeak, 6);
api.updateRates(3000);   // 这一秒 0 次
check('EMA 衰减(6 → 3.6)', api.pluginTable()[0].cps, 3.6);
check('峰值保留', api.pluginTable()[0].cpsPeak, 6);

// ── blame:执行中的回调优先,其次看时间重叠 ───────────────────────────
// 时间基准取真实 performance.now():longtask 的 startTime 与它是同一个时钟。
const base = performance.now();
api.state.stack.push({ owner: 'inflight-plugin', from: base - 10, to: base - 10 });
api.state.recent.push({ owner: 'earlier-plugin', from: base - 900, to: base - 800 });
check('blame(仍在执行的那次)', api.blame(base - 5, 60), 'inflight-plugin');
api.state.stack.length = 0;
api.state.recent.length = 0;
api.state.recent.push({ owner: 'a', from: base + 1000, to: base + 1010 });
api.state.recent.push({ owner: 'b', from: base + 1020, to: base + 1080 });
check('blame(重叠最多的那次)', api.blame(base + 1015, 50), 'b');
check('blame(无人重叠) = null', api.blame(base + 5000, 50), null);

// ── worstSecond:只在最近 60 秒里挑 ───────────────────────────────────
api.ring.push({ t: Date.now() - 5 * 60 * 1000, frameMs: 9000, fps: 1 });   // 老数据,必须无视
api.ring.push({ t: Date.now() - 3000, frameMs: 40, fps: 60 });
api.ring.push({ t: Date.now() - 2000, frameMs: 220, fps: 18, ltCount: 3 });
api.ring.push({ t: Date.now() - 1000, frameMs: 55, fps: 58 });
check('worstSecond 取窗口内最差', api.worstSecond().frameMs, 220);

console.log(failed === 0 ? 'ALL PASS' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;

// ═══════════════ A/B/C/D/E 新增逻辑的离线验证 ═══════════════
// 第二个沙箱:把新函数连同它们依赖的最小环境一起装进去。
const sandbox = `
	const location = { origin: 'http://127.0.0.1:3080', href: 'http://127.0.0.1:3080/session/x' };
	const W = { __DSH_BOOT__: undefined, setTimeout: (fn, ms) => setTimeout(fn, ms) };
	const navigator = { userAgent: 'test-agent' };
	const PKG = 'dsh-perf-hud';
	let streamingFlag = false;
	const document = { documentElement: {}, querySelector: () => (streamingFlag ? {} : null) };
	const localStorage = { store: new Map(), getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }, setItem(k, v) { this.store.set(String(k), String(v)); } };
	const natives = { setTimeout: (fn, ms) => setTimeout(fn, ms), setInterval: () => 0, clearInterval: () => {} };
	const sleep = (ms) => new Promise((resolve) => natives.setTimeout(resolve, ms));
	let dirty = false;
	const ring = [];
	const bundleMaps = new Map();
	const bundleMeta = new Map();
	const changedNodes = [];
	const experiment = { phase: 'idle', startedAt: 0, results: [], candidates: [], candidateState: [], restored: null, baseline: null, message: '', via: null };
	const TARGETS = [
		{ id: 'sessions', label: () => '会话列表', find: () => null },
		{ id: 'messages', label: () => '消息区', find: () => null },
	];
`;
const newPieces = [
	'const state = {',
	'function round1(',
	'function pluginTable(',
	'function domWriteTable(',
	'async function measureWindow(',
	'const BUNDLE_PREFIX = ',
	'const MUT_WINDOW_MS = ',
	'const BASELINE_MS = ',
	'const IDLE_GAP_MS = ',
	'const REACT_INTERNAL = ',
	'function absolutePluginUrl(',
	'function mapUrlOf(',
	'function sectionName(',
	'function bundleMetaOf(',
	'function bundleLabel(',
	'function sectionOwner(',
	'const FIBER_SCAN_MAX = ',
	'const LT_WINDOW_MS = ',
	'const MUT_SAMPLE = ',
	'const MUT_TOP = ',
	'function trimChangedNodes(',
	'function fiberOf(',
	'function componentOf(',
	'function fiberOwner(',
	'function percentile(',
	'function linkStats(',
	'function suspectLink(',
	'function applyDeltas(',
	'function isStreaming(',
	'function idleTick(',
	'function rate(',
	'function worstLongTask(',
	'function worstSecond(',
	'const pad = ',
	'const clock = (ms) => {',
	'const mb = ',
	'function verification(',
	'function snapshot(',
].map((header) => {
	if (header.startsWith('const ') && header.endsWith('{') === false) {
		return source.slice(source.indexOf(header), source.indexOf('\n', source.indexOf(header)));
	}
	if (header.startsWith('const ')) return `${extract(source, header)};`;
	return extract(source, header);
}).join('\n');

const box = new Function(`${sandbox}\n${newPieces}
	return { state, changedNodes, bundleMaps, ring, setStreaming: (value) => { streamingFlag = value; },
		EX: { absolutePluginUrl, mapUrlOf, sectionName, sectionOwner, bundleLabel, fiberOwner, componentOf, linkStats, suspectLink, applyDeltas, idleTick, snapshot } };`)();
const EX = box.EX;
box.state.samplesLength = 1;
box.ring.push({ t: Date.now() - 1000, fps: 59, frameMs: 22, ltCount: 0, nodes: 4300, heap: 104857600, top: [] });

// ── A:URL 与分段二分 ────────────────────────────────────────────────
check('mapUrlOf 给每项加 .map 并保留 rev',
	EX.mapUrlOf('http://h/plugins/??a/client.js,b/client.js&rev=77'),
	'http://h/plugins/??a/client.js.map,b/client.js.map&rev=77');
check('mapUrlOf 对单包 URL 同样成立',
	EX.mapUrlOf('http://h/plugins/??dsh-x/client.js&rev=1'),
	'http://h/plugins/??dsh-x/client.js.map&rev=1');
check('absolutePluginUrl 修相对形态',
	EX.absolutePluginUrl('plugins/??a/client.js&rev=1'),
	'http://127.0.0.1:3080/plugins/??a/client.js&rev=1');
check('sectionName 认作用域包',
	EX.sectionName({ map: { sources: ['/plugins/@deepseek-ai/dsh-client-ui-chat/client.js'] } }),
	'@deepseek-ai/dsh-client-ui-chat');
check('sectionName 认包内子路径(map 重定位后)',
	EX.sectionName({ map: { sources: ['/plugins/dsh-x/src/foo.ts'] } }), 'dsh-x');
check('sectionName 无 plugins 前缀 → null', EX.sectionName({ map: { sources: ['webpack:///./src/a.ts'] } }), null);

// 关键:sourcemap offset 是 0-based,V8 行号是 1-based
const entry = { offsets: [[0, 'a'], [10, 'b'], [25, 'c']] };
check('sectionOwner(第 1 行) = a', EX.sectionOwner(entry, 1), 'a');
check('sectionOwner(第 10 行) = a(边界属于上一段)', EX.sectionOwner(entry, 10), 'a');
check('sectionOwner(第 11 行) = b(0-based 10 起)', EX.sectionOwner(entry, 11), 'b');
check('sectionOwner(第 25 行) = b', EX.sectionOwner(entry, 25), 'b');
check('sectionOwner(第 26 行) = c', EX.sectionOwner(entry, 26), 'c');
check('sectionOwner(第 0 行,非法) = null', EX.sectionOwner(entry, 0), null);
check('sectionOwner(表为空) = null', EX.sectionOwner({ offsets: [] }, 5), null);

// ── A:批次标签 —— 绝不展开成多个名字 ───────────────────────────────
const longUrl = `http://127.0.0.1:3080/plugins/??${Array.from({ length: 58 }, (_, i) => `p${i}/client.js`).join(',')}&rev=1`;
const bundleKey = `bundle:${longUrl}`;
box.bundleMaps.set(bundleKey, { state: 'pending' });
check('58 包合并 URL 只给一行', EX.bundleLabel(bundleKey), '合并批次(58 包)·解析中');
box.bundleMaps.set(bundleKey, { state: 'ready' });
check('解析完成后去掉状态后缀', EX.bundleLabel(bundleKey), '合并批次(58 包)');
box.bundleMaps.set(bundleKey, { state: 'failed', reason: 'HTTP 403' });
check('map 失败时如实写原因', EX.bundleLabel(bundleKey), '合并批次(58 包)·map失败(HTTP 403)');

// ── B:fiber 组件名 ─────────────────────────────────────────────────
const named = (name) => {
	const fn = function () {};
	Object.defineProperty(fn, 'name', { value: name });
	return fn;
};
const hostFiber = (parent) => ({ type: 'div', elementType: 'div', return: parent });
const fnFiber = (parent, name) => ({ type: named(name), return: parent });
const rootFiber = { type: 'div', return: null };
const chain = hostFiber(fnFiber(fnFiber(fnFiber(rootFiber, 'AppShell'), 'PerfHud'), 'PerfHudStress'));
check('取最近的具名组件(最深)', EX.componentOf({ __reactFiber$abc123: chain }), 'PerfHudStress');
check('没有 fiber 的节点 → null', EX.componentOf({ className: 'x' }), null);
check('跳过 React 容器型内建名',
	EX.componentOf({ __reactFiber$x: hostFiber(fnFiber(fnFiber(rootFiber, 'AppShell'), 'Fragment')) }), 'AppShell');
check('没有具名函数组件 → null', EX.componentOf({ __reactFiber$x: hostFiber(rootFiber) }), null);
check('displayName 优先于 name',
	EX.componentOf({ __reactFiber$y: { type: Object.assign(named('RealName'), { displayName: 'Shown' }), return: null } }), 'Shown');

const now = performance.now();
box.changedNodes.push({ node: { __reactFiber$old: hostFiber(fnFiber(rootFiber, 'OldComponent')) }, at: now - 5000 });
box.changedNodes.push({ node: { __reactFiber$new: hostFiber(fnFiber(rootFiber, 'NewComponent')) }, at: now });
check('fiberOwner 只用 2 秒窗口内的节点', EX.fiberOwner(), 'NewComponent');
check('窗口外的引用被释放', box.changedNodes.length, 1);

// ── D:链路分位与"疑似链路"判定 ─────────────────────────────────────
box.state.link = [
	{ t: Date.now() - 5000, kind: 'rtt', rtt: 10 },
	{ t: Date.now() - 4000, kind: 'rtt', rtt: 20 },
	{ t: Date.now() - 3000, kind: 'rtt', rtt: 30 },
	{ t: Date.now() - 2000, kind: 'rtt', rtt: 400 },
	{ t: Date.now() - 1000, kind: 'load', rtt: 500, kbps: 600 },
	{ t: Date.now() - 120000, kind: 'rtt', rtt: 9999 },
];
check('linkStats 只算 60s 内的 rtt', EX.linkStats().count, 4);
check('linkStats p50 是 20(nearest-rank,不是第 3 个)', EX.linkStats().p50, 20);
check('linkStats p99 = 最大值', EX.linkStats().p99, 400);
box.state.fps = 60;
check('RTT 尖峰 + FPS 正常 → 疑似链路', EX.suspectLink(), true);
box.state.fps = 12;
check('FPS 也崩了就不甩锅给链路', EX.suspectLink(), false);
box.state.link = [];
check('没有样本时不误报', EX.suspectLink(), false);

// 单样本:分位退化成它自己(顺带把这一组放在最后,避免污染上面的样本)
check('linkStats 单样本 p50 = p99 = 自身', (() => { box.state.link = [{ t: Date.now(), kind: 'rtt', rtt: 7 }]; return [EX.linkStats().p50, EX.linkStats().p99]; })(), [7, 7]);
box.state.link = [];

// ── C:Δ 只对照基线 ────────────────────────────────────────────────
const rows = EX.applyDeltas([
	{ name: 'ok', window: { fps: 55, longTasks: 1, domPerMin: 10 }, applied: true },
	{ name: 'skipped', applied: false, reason: '宿主没有真的关掉' },
], { fps: 60, longTasks: 3, domPerMin: 40 });
check('Δfps 对照基线', rows[0].delta.fps, -5);
check('Δlongtask 对照基线', rows[0].delta.longTasks, -2);
check('ΔDOM 对照基线', rows[0].delta.domPerMin, -30);
check('没关成功的项不产出 Δ', rows[1].delta, undefined);
check('没有基线时一个 Δ 都不编', EX.applyDeltas([{ name: 'x', window: { fps: 1, longTasks: 1, domPerMin: 1 } }], null)[0].delta, undefined);

// ── E:空闲基线门控(含一次真的窗口采集) ─────────────────────────
box.state.baselineMs = 100;    // 只跑一轮,省时间
box.state.baselineAt = 0;
box.state.idleSince = 0;
box.state.fps = 59;
box.state.ltTotal = 0;
box.state.ltPerSec = 0;
box.state.dom = { total: 100, series: [] };
box.state.plugins = new Map();
box.state.targets = new Map();
box.state.domWrites = new Map();
box.setStreaming(false);
EX.idleTick(now);
check('刚进入空闲:先起计时,还不打基线', box.state.idleSince === now && box.state.baselineRunning === false, true);
EX.idleTick(now + 1000);
check('空闲不满 IDLE_GAP_MS:仍不打基线', box.state.baselineRunning, false);
EX.idleTick(now + 4000);
check('空闲够了:开始打基线窗口', box.state.baselineRunning, true);
await new Promise((resolve) => setTimeout(resolve, 1300));
check('基线窗口落地(label=idle)', box.state.idleBaseline !== null && box.state.idleBaseline.label === 'idle', true);
check('刚打过基线:5 分钟内不重复', (() => { box.state.baselineAt = now; box.state.baselineRunning = false; box.state.idleSince = 0; EX.idleTick(now + 5000); return box.state.baselineRunning; })(), false);
box.setStreaming(true);
box.state.baselineAt = 0;
box.state.baselineRunning = false;
box.state.idleSince = 0;
EX.idleTick(now + 9000);
check('流式时不打基线,空闲计时清零', box.state.idleSince, 0);

console.log(failed === 0 ? 'ALL PASS' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;

// ── 验收 4:导出的三段结构 ─────────────────────────────────────────
box.state.ltTotal = 7;
box.state.ltBlamed = 5;
box.state.longTasks = [{ t: Date.now(), at: 1, ms: 120, owner: 'dsh-x', component: 'ChatRow', source: 'scheduler+render' }];
box.state.since = Date.now() - 60000;
box.state.attributedPerSec = 12;
box.state.unattrAvg = 3.4;
box.state.unattrPeak = 22;
box.state.frameWorst = 118;
box.state.dom = { total: 4321, series: [{ t: 0, n: 4000 }, { t: 12000, n: 4321 }] };
box.state.heapSeries = [{ t: 0, n: 1000 }, { t: 12000, n: 2000 }];
box.state.heap = 104857600;
box.state.mutations = 999;
box.state.marks = [{ t: Date.now(), note: '测试标记', fps: 58 }];
box.state.idleBaseline = { label: 'idle', fps: 60, longTasks: 0, domPerMin: 0, domDelta: 0, domTop: [] };
box.state.link = [{ t: Date.now(), kind: 'rtt', rtt: 12 }];
box.state.host = { eventLoop: { p50: 1.2, p99: 9.9, max: 60, seconds: 30 } };
box.state.hostAt = Date.now();
box.state.hostError = null;
box.state.precise = true;
box.bundleMaps.clear();
box.state.hostEvents = { installed: true, reason: '', stats: { 'session/event': { count: 3, ms: 1.2, max: 0.9 } } };
const exported = box.EX.snapshot();


check('导出含 timeline 段', Array.isArray(exported.timeline?.samples), true);
check('timeline 带每秒曲线与 60 秒切片',
	exported.timeline.samples.length === box.state.samplesLength && Array.isArray(exported.timeline.last60s), true);
check('timeline 带场景标记与空闲基线',
	exported.timeline.marks.length === 1 && exported.timeline.idleBaseline.label === 'idle', true);
check('导出含 longTasks 段(明细 + 计数)',
	exported.longTasks.records.length === 1 && exported.longTasks.total === 7 && exported.longTasks.attributed === 5, true);
check('longtask 明细带 owner/component/source',
	exported.longTasks.records[0].owner === 'dsh-x' && exported.longTasks.records[0].component === 'ChatRow'
	&& exported.longTasks.records[0].source === 'scheduler+render', true);
check('导出含 isolation 段', exported.isolation !== undefined && exported.isolation.phase === 'idle', true);
check('isolation 段带候选/基线/结果/恢复字段',
	Array.isArray(exported.isolation.candidates) && Array.isArray(exported.isolation.results)
	&& exported.isolation.restored === null && exported.isolation.baseline === null, true);
check('导出含 host 与链路', exported.host.last.eventLoop.p99 === 9.9 && exported.link.stats60s.count === 1, true);
check('导出带宿主事件计时回执',
	exported.host.eventWatch.installed === true && exported.verification.hostEvents.eventNames[0] === 'session/event', true);
check('verification 段声明了三段导出',
	JSON.stringify(exported.verification.exportSections), JSON.stringify(['timeline', 'longTasks', 'isolation']));
check('verification 段报出独立包名与 longtask 命中',
	exported.verification.ownPackageNames['dsh-status-rotator'] === false
	&& exported.verification.longTask.attributed === 5 && exported.verification.longTask.withComponent === 1, true);

console.log(failed === 0 ? 'ALL PASS' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
