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

// ── 静态检查:引用了但没声明的标识符(2026-10-07 真事故的回归) ──────
// 事故:一次"整段替换样式块"把 PerfHudStress 与 signed 的声明一起吞了,
// 文件里 h(PerfHudStress, …) 还在、定义没了。node --check 完全看不出来(语法合法),
// 结果 React 抛 "Element type is invalid",外壳的 SlotErrorBoundary 直接把整个槽位条目
// 停用 —— 面板凭空消失。所以这里用正则做一层廉价的"未声明引用"检查。
{
	const declared = new Set();
	for (const pattern of [/\bfunction\s+([A-Za-z_$][\w$]*)/g, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, /\bclass\s+([A-Za-z_$][\w$]*)/g]) {
		for (const match of source.matchAll(pattern)) declared.add(match[1]);
	}
	// 解构声明:const [open, setOpen] = / const { a, b } =
	for (const match of source.matchAll(/\b(?:const|let|var)\s*[[{]([^\]}]*)[\]}]/g)) {
		for (const part of match[1].split(',')) {
			const name = part.split(':').pop().trim().replace(/^\s*\.\.\./, '');
			if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
		}
	}
	const GLOBALS = new Set(['Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Error', 'Set', 'Map', 'WeakMap', 'Promise', 'Symbol', 'BigInt', 'Reflect', 'Proxy', 'RegExp', 'Function', 'Intl', 'fetch', 'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'document', 'window', 'location', 'localStorage', 'navigator', 'console', 'URL', 'Blob', 'Response', 'Request', 'Headers', 'Node', 'Element', 'MutationObserver', 'PerformanceObserver', 'parseInt', 'parseFloat', 'isFinite', 'isNaN', 'require', 'super', 'globalThis', 'structuredClone', 'queueMicrotask', 'TextEncoder', 'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await', 'of', 'in', 'function', 'delete', 'void', 'do', 'else', 'case', 'throw', 'yield', 'get', 'set', 'async']);

	// 样式字符串里的 CSS 函数(var(--x)/rgba(...))不是 JS 调用
	const CSS_FUNCS = new Set(['var', 'rgb', 'rgba', 'hsl', 'hsla', 'calc', 'clamp', 'minmax', 'color-mix', 'linear-gradient', 'radial-gradient', 'url']);
	const components = [...new Set([...source.matchAll(/\bh\(\s*([A-Z][\w$]*)/g)].map((m) => m[1]))];
	check('h() 引用的组件都声明了(PerfHudStress 事故回归)',
		components.filter((name) => !declared.has(name)), []);

	const renderRegion = source.slice(source.indexOf('function PerfHud('));
	const bare = [...new Set([...renderRegion.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))];
	check('面板渲染区的函数调用都有声明(signed 事故回归)',
		bare.filter((name) => !declared.has(name) && !GLOBALS.has(name) && !CSS_FUNCS.has(name)), []);

	// 导出里必须有错误账本(下次再抛错,导出件能带出原文)
	check('client.js 带 errors 导出段', /errors:\s*state\.errors/.test(source), true);
}

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
	// 只给这几个键的真实中文:断言要检查"人看到的字",不是 key
	let flushSync = null;   // 沙箱里的 react-dom flushSync(与真实一致:拿不到就是 null)
	const translate = (key) => ({
		sampling: '吞吐采样中', failed: '吞吐失败', suspect: '疑似链路', notYet: '未采集',
		stressHint: 'stressHint', stressRunning: '自测进行中', stressDone: '自测结果', nodes: '节点', unblamed: '未归因',
		stressNoTask: '未观察到长任务', stressCommit: '提交', stressSync: '同步', stressSliced: '切片', stressNoFlush: 'flushSync 不可用', stressFromDom: 'DOM 写入',
		stressBurn: '人为燃烧',
		via: '通道', viaRemote: 'ctx.remote(客户端 remote)', viaRoute: '宿主路由 /api/dsh-perf-hud/host',
		none: '无', notApplicable: '不适用(窗口含流式)',
	})[key] ?? key;
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
	'function domWriteSnapshot(',
	'function domWriteDelta(',
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
	'function short(',
	'function viaLabel(',
	'function stressText(',
	'function linkRowText(',
	'function throughputText(',
	'function suspectLink(',
	'function experimentDelta(',
	'function noiseFloor(',
	'function significance(',
	'function metricList(',
	'function beyondNoiseText(',
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
		setFlushSync: (value) => { flushSync = value; },
		EX: { absolutePluginUrl, mapUrlOf, sectionName, sectionOwner, bundleLabel, fiberOwner, componentOf, linkStats, suspectLink, experimentDelta, noiseFloor, significance, metricList, beyondNoiseText, idleTick, snapshot, domWriteSnapshot, domWriteDelta, linkRowText, throughputText, stressText } };`)();
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
// 关着的时候只给一行批次标签(不写"解析中",因为根本还没去解析)
check('精确归因关着:批次标签不带状态后缀', EX.bundleLabel(bundleKey), '合并批次(58 包)');
box.state.precise = true;
box.bundleMaps.set(bundleKey, { state: 'pending' });
check('精确归因打开 + 未就绪:标成解析中', EX.bundleLabel(bundleKey), '合并批次(58 包)·解析中');
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
// 错误边界是基础设施:它常常套在真正的渲染组件外面,不该被报成"谁在渲染"
const boundaryClass = function HudBoundaryLike() {};
boundaryClass.prototype.componentDidCatch = function () {};
check('跳过错误边界,继续往上找真组件',
	EX.componentOf({ __reactFiber$bd: hostFiber({ type: boundaryClass, return: fnFiber(rootFiber, 'RealThing') }) }), 'RealThing');
check('跳过压缩名 n5,继续往上找真名',
	EX.componentOf({ __reactFiber$m: hostFiber(fnFiber(fnFiber(rootFiber, 'AppShell'), 'n5')) }), 'AppShell');
check('压缩名在整条链上都没有 → null',
	EX.componentOf({ __reactFiber$m: hostFiber(fnFiber(rootFiber, 'n5')) }), null);
check('大写压缩名 Bn 同样跳过',
	EX.componentOf({ __reactFiber$b: hostFiber(fnFiber(fnFiber(rootFiber, 'AppShell'), 'Bn')) }), 'AppShell');
check('displayName 优先于 name',
	EX.componentOf({ __reactFiber$y: { type: Object.assign(named('RealName'), { displayName: 'Shown' }), return: null } }), 'Shown');

const now = performance.now();
box.changedNodes.push({ node: { __reactFiber$old: hostFiber(fnFiber(rootFiber, 'OldComponent')) }, at: now - 5000 });
box.changedNodes.push({ node: { __reactFiber$new: hostFiber(fnFiber(rootFiber, 'NewComponent')) }, at: now });
check('fiberOwner 只用 2 秒窗口内的节点', EX.fiberOwner(), 'NewComponent');
check('窗口外的引用被释放', box.changedNodes.length, 1);

// ── 空闲基线要能指名"谁在加节点":必须是窗口增量,不是累计表 ──────
box.state.domWrites = new Map([
	['early', { count: 100, ops: 10, components: new Map([['EarlyComp', 100]]) }],
]);
const writeSnap = EX.domWriteSnapshot();
box.state.domWrites.get('early').count += 30;
box.state.domWrites.get('early').components.set('EarlyComp', 130);
box.state.domWrites.set('late', { count: 50, ops: 5, components: new Map([['LateComp', 50]]) });
const writeDelta = EX.domWriteDelta(writeSnap);
check('增量只列窗口内真的写过的 owner', writeDelta.map((row) => [row.id, row.estimatedCount]), [['late', 50], ['early', 30]]);
check('组件名也取增量', writeDelta.map((row) => row.component), ['LateComp', 'EarlyComp']);
box.state.domWrites.set('idleOne', { count: 999, ops: 9, components: new Map([['IdleComp', 999]]) });
// 真实空闲窗口的样子:累计表里全是历史数字,窗口内一个都没写 → 增量必须为空
check('空闲窗口:累计表再高,增量也是空', EX.domWriteDelta(EX.domWriteSnapshot()).length, 0);

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

// 自测必须"点了看得见":三种状态都要有明确文案(曾因清理定时器比渲染间隔短而毫无反应)
box.state.stress = null;
check('自测没跑过:显示按钮提示', EX.stressText(), 'stressHint');
box.state.longTasks = [];
box.state.stress = { at: Date.now(), nodes: 12000 };
check('已点、长任务还没到:显示进行中', EX.stressText(), '自测进行中: 12000 节点 …');
box.state.longTasks = [{ t: Date.now(), ms: 128.4, owner: 'dsh-x', component: 'PerfHudStress' }];
check('长任务到了:给出耗时与组件名', EX.stressText(), '自测结果: 128ms · PerfHudStress (dsh-x)');
box.setFlushSync(() => {});   // 真实场景里"同步提交"就意味着 flushSync 可用
box.state.stress = { at: Date.now(), nodes: 12000, sync: true, commitMs: 300 };
check('同步提交 + 长任务:附带提交耗时与模式',
	EX.stressText(), '自测结果: 128ms · PerfHudStress (dsh-x) · 提交 300ms(同步)');
box.setFlushSync(null);
// 真实现场:React 时间切片 → 没有长任务。状态必须收敛并说明原因,不能永远"进行中"
box.state.longTasks = [];
box.state.stress = { at: Date.now(), nodes: 12000, sync: false, commitMs: 420 };
check('切片提交没有长任务:如实说明并给提交耗时',
	EX.stressText(), '自测结果: 未观察到长任务 · 提交 420ms(切片) · flushSync 不可用');
// React 一次 appendChild 把整棵新子树挂上去 → 观察器只看到容器,长任务归属只能到容器;
// DOM 写入插桩看到了每一个节点,于是能把 PerfHudStress 点名。两个来源都写出来。
box.setFlushSync(() => {});   // sync:true 的场景里 flushSync 必然可用
box.state.domWrites = new Map();
const stressWrites = EX.domWriteSnapshot();
box.state.domWrites.set('(PerfHudStress)', { count: 1200, ops: 120, components: new Map([['PerfHudStress', 1200]]) });
box.state.longTasks = [];
box.state.stress = { at: Date.now(), nodes: 12000, sync: true, commitMs: 11.2, writes0: stressWrites };
check('没有长任务但有 DOM 写入:指名写入组件',
	EX.stressText(), '自测结果: 未观察到长任务 · DOM 写入 PerfHudStress · 提交 11.2ms(同步)');
box.state.longTasks = [{ t: Date.now(), ms: 56, owner: null, component: 'PerfHud' }];
check('长任务归属与 DOM 写入不一致:两个都写出来',
	EX.stressText(), '自测结果: 56ms · PerfHud / PerfHudStress(DOM 写入) · 提交 11.2ms(同步)');

// 仪器自检:节点数凑不稳 >50ms,所以明着烧一段,并且必须把"人为燃烧"写在面板上
box.state.longTasks = [];
box.state.stress = { at: Date.now(), nodes: 8000, burnMs: 80, sync: true, commitMs: 94 };
check('没长任务时也要写明人为燃烧', EX.stressText(),
	'自测结果: 未观察到长任务 · 提交 94ms(同步 · 人为燃烧 80ms)');
box.state.longTasks = [{ t: Date.now(), ms: 92, owner: null, component: 'PerfHud' }];
check('有长任务时同样标注人为燃烧', EX.stressText(),
	'自测结果: 92ms · PerfHud · 提交 94ms(同步 · 人为燃烧 80ms)');

box.setFlushSync(null);
box.state.stress = { at: Date.now() - 9000, nodes: 12000, sync: false };
check('8 秒还没有任何结果:超时收敛,不再卡在"进行中"',
	EX.stressText(), '自测结果: 未观察到长任务(8s) · flushSync 不可用');
box.state.longTasks = [{ t: Date.now() - 60000, ms: 999, owner: null, component: null }];
box.state.stress = { at: Date.now(), nodes: 12000, sync: false };
check('窗口外的老长任务不算这次自测的结果', EX.stressText(), '自测进行中: 12000 节点 …');

// 链路那一行必须自证完整:n= 露出来,吞吐三态都说清楚
box.state.fps = 60;
box.state.link = [{ t: Date.now(), kind: 'rtt', rtt: 10 }, { t: Date.now(), kind: 'rtt', rtt: 20 }];
box.state.loadState = 'pending';
check('吞吐还没跑:写"吞吐采样中"而不是留空', EX.linkRowText(), 'p50 10ms · p99 20ms (n=2) · 吞吐采样中');
box.state.loadState = 'ok';
box.state.linkText = '1200.8KB/s';
box.state.loadKbps = 1200.8;
check('吞吐就绪:>=1024KB/s 折成 MB/s', EX.linkRowText(), 'p50 10ms · p99 20ms (n=2) · 1.2MB/s');
box.state.loadKbps = 880;
check('低于 1024 仍用 KB/s', EX.linkRowText(), 'p50 10ms · p99 20ms (n=2) · 880KB/s');
box.state.loadKbps = 1344.5;
check('吞吐 >=1024KB/s 折成 MB/s(省一行宽度)', EX.linkRowText(), 'p50 10ms · p99 20ms (n=2) · 1.3MB/s');
box.state.loadState = 'failed';
check('吞吐失败:如实写失败', EX.linkRowText(), 'p50 10ms · p99 20ms (n=2) · 吞吐失败');
box.state.link = [{ t: Date.now(), kind: 'rtt', rtt: 400 }];
box.state.loadState = 'ok';
box.state.loadKbps = 1344.5;
check('只有 1 个样本时不下结论(n=1 分不清抖动与常态)',
	EX.linkRowText(), 'p50 400ms · p99 400ms (n=1) · 1.3MB/s');
box.state.link = [{ t: Date.now(), kind: 'rtt', rtt: 12 }, { t: Date.now(), kind: 'rtt', rtt: 400 }];
check('n>=2 且 RTT 尖峰 + FPS 正常:追加疑似链路',
	EX.linkRowText(), 'p50 12ms · p99 400ms (n=2) · 1.3MB/s · 疑似链路');

// 单样本:分位退化成它自己(顺带把这一组放在最后,避免污染上面的样本)
check('linkStats 单样本 p50 = p99 = 自身', (() => { box.state.link = [{ t: Date.now(), kind: 'rtt', rtt: 7 }]; return [EX.linkStats().p50, EX.linkStats().p99]; })(), [7, 7]);
box.state.link = [];

// ── C:Δ 对照"紧邻基线" + 噪声底(第一版把漂移当成了结论,这条是那次事故的回归) ──
check('experimentDelta 对照紧邻基线',
	EX.experimentDelta({ fps: 60, longTasks: 3, domPerMin: 40 }, { fps: 55, longTasks: 1, domPerMin: 10 }),
	{ fps: -5, longTasks: -2, domPerMin: -30 });
check('缺任一侧就不写 Δ', EX.experimentDelta(null, { fps: 1, longTasks: 0, domPerMin: 0 }), null);
check('noiseFloor 取基线间漂移的最大绝对值',
	EX.noiseFloor([{ fps: -1, longTasks: 2, domPerMin: -5 }, { fps: 3, longTasks: -1, domPerMin: 9 }]),
	{ fps: 3, longTasks: 2, domPerMin: 9 });
check('significance 逐指标判断是否超出噪声',
	EX.significance({ fps: -1, longTasks: 14, domPerMin: 4219 }, { fps: 3, longTasks: 2, domPerMin: 9 }),
	{ fps: false, longTasks: true, domPerMin: true });
check('metricList 列出超标指标', EX.metricList({ fps: false, longTasks: true, domPerMin: true }), 'LT/DOM');
check('全部落在噪声内:明确写「无」,不把漂移说成效果',
	EX.metricList({ fps: false, longTasks: false, domPerMin: false }), '无');
// 自己声明"该对照不可比"却又列「超出噪声 fps」,等于引诱读者挑数字当结论
check('窗口含流式:不给超出噪声的结论',
	EX.beyondNoiseText({ confounded: true, delta: { fps: -1.5 }, significant: { fps: true, longTasks: false, domPerMin: false } }),
	'不适用(窗口含流式)');
check('窗口可比:正常给出超标指标',
	EX.beyondNoiseText({ confounded: false, significant: { fps: false, longTasks: true, domPerMin: true } }), 'LT/DOM');
check('没有结果时不写结论', EX.beyondNoiseText(null), '未采集');

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
