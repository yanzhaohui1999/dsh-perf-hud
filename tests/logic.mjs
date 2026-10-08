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
	// 单/双引号字符串里的内容不是 JS 调用(SVG/CSS 的 `transform: 'rotate(-90 24 24)'` 就是典型);
	// 模板字符串**要留着** —— `${t('x')}` 里的调用是真调用,不能一起丢掉。
	const renderCode = renderRegion
		.replace(/'(?:[^'\\]|\\.)*'/g, "''")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""');
	const bare = [...new Set([...renderCode.matchAll(/(?<![.\w$])([a-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))];
	check('面板渲染区的函数调用都有声明(signed 事故回归)',
		bare.filter((name) => !declared.has(name) && !GLOBALS.has(name) && !CSS_FUNCS.has(name)), []);


	// HUD 自己的 DOM 写入必须不记账(实测摘要里出现过 (PerfHud) 顶在第一名)
	check('DOM 写入插桩排除本 HUD 自身', /if \(owner === PKG\)/.test(source), true);

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
	// LoAF 脚本 → 包名那条路要吃脚本文本:给一个 3 行的假脚本(第 1 行 aaa、第 2 行 bbb、第 3 行 ccc)
	// 用 fromCharCode 拼换行:这段桩写在模板字符串里,直接写反斜杠 n 会被模板先转义掉
	const LF = String.fromCharCode(10);
	const SCRIPT_TEXT = ['aaa', 'bbb', 'ccc', ''].join(LF);
	const fetch = async () => ({ ok: true, status: 200, text: async () => SCRIPT_TEXT, json: async () => ({}) });
	// 只给这几个键的真实中文:断言要检查"人看到的字",不是 key
	let flushSync = null;   // 沙箱里的 react-dom flushSync(与真实一致:拿不到就是 null)
	const translate = (key) => ({
		sampling: '吞吐采样中', failed: '吞吐失败', suspect: '疑似链路', notYet: '未采集',
		stressHint: 'stressHint', stressRunning: '自测进行中', stressDone: '自测结果', nodes: '节点', unblamed: '未归因',
		stressNoTask: '未观察到长任务', stressCommit: '提交', stressSync: '同步', stressSliced: '切片', stressNoFlush: 'flushSync 不可用', stressFromDom: 'DOM 写入',
		stressBurn: '人为燃烧',
		via: '通道', viaRemote: 'ctx.remote(客户端 remote)', viaRoute: '宿主路由 /api/dsh-perf-hud/host',
		watch: '守夜', watchCaught: '抓到', watchWorst: '最差', watchRestored: '读回', watchOff: '未开录', watchNone: '还没抓到', watchPersistFailed: '落盘失败', watchManualNote: '手动标记', domWritesShort: 'DOM 写入',
		none: '无', notApplicable: '不适用(窗口含流式)', unattrShort: '未归因', perSec: '/s', peak: '峰', legSubtree: '子树', legDom: 'DOM写入', perMin: '/分', nodesSuffix: ' 节点', messages: '消息区', hostShort: '宿主', hostDown: '宿主不可用', isolation: '隔离实验', marks: '场景标记', domWrites: 'DOM 写入(按插件)', worstSecondShort: '最差秒', overviewFrame: '帧', overviewBlame: '归属', maxBlame: '最多', hit: '命中', times: ' 次', cumulative: '累计', restHint: '其余 = 除 Top3 之外的归属方合计', linkShort: 'RTT', suspectSuffix: ' 存疑', cleared: '链路已排除(宿主与隧道均正常)', streaming: '流式', running: '流式', idle: '空闲',
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
	'const PLUGIN_URL = ',
	'function ownerOfUrl(',
	'function sectionOwner(',
	'function bundleMap(',
	'const SELF_RING = ',
	'function recordSelf(',
	'function selfStats(',
	'function recorderText(',
	'const LS_MAP = ',
	'const scriptLines = ',
	'const SCRIPT_LINES_MAX = ',
	'async function loadScriptLines(',
	'function ensureScriptLines(',
	'function scriptLineOf(',
	'function packageOfScript(',
	'const FIBER_SCAN_MAX = ',
	'const DESCEND_MAX = ',
	'function usableComponentName(',
	'function descendantComponentOf(',
	'function subtreeOwner(',
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
	'const LS_GROUPS = ',
	'const HOST_ROUTE = ',
	'const TOP_N = ',
	'const EXPERIMENT_LOAD_BURN_MS = ',
	'const EXPERIMENT_LOAD_PERIOD_MS = ',
	'const EXPERIMENT_MAX_CANDIDATES = ',
	'function pickExperimentCandidates(',
	'function containerNodes(',
	'function toggleGroup(',
	'function attrText(',
	'function restValueText(',
	'function restTitleText(',
	'function msPerSecText(',
	'function looksLikeInfrastructure(',
	'function primaryBlame(',
	'function legOf(',
	'function applyLongTaskStats(',
	'function longTaskTally(',
	'function blameText(',
	'function overviewLine1(',
	'function overviewLine2(',
	'function detailSummary(',
	'function domSummary(',
	'function displayKey(',
	'function bump(',
	'function infraVerdict(',
	'function sceneChip(',
	'function unexplainedFrame(',
	'function levelFrame(',
	'function hostSummary(',
	'function toolsSummary(',
	'const rateText = (series) => {',
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
	return { state, changedNodes, bundleMaps, ring, storage: localStorage, setStreaming: (value) => { streamingFlag = value; },
		setFlushSync: (value) => { flushSync = value; },
		SELF_RING, recordSelf, selfStats, recorderText,
		EX: { absolutePluginUrl, mapUrlOf, sectionName, sectionOwner, bundleLabel, scriptLineOf, packageOfScript, loadScriptLines, fiberOwner, componentOf, linkStats, suspectLink, experimentDelta, noiseFloor, pickExperimentCandidates, significance, metricList, beyondNoiseText, blameText, primaryBlame, longTaskTally, legOf, applyLongTaskStats, descendantComponentOf, subtreeOwner, usableComponentName, overviewLine1, overviewLine2, detailSummary, domSummary, hostSummary, toolsSummary, rateText, displayKey, bump, infraVerdict, sceneChip, unexplainedFrame, levelFrame, looksLikeInfrastructure, msPerSecText, attrText, restValueText, restTitleText, toggleGroup, containerNodes, idleTick, snapshot, domWriteSnapshot, domWriteDelta, linkRowText, throughputText, stressText } };`)();
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
check('B2:$ 开头的压缩名被挡掉,括号形态留下(它是兜底桶标记,有语义)', [
	EX.usableComponentName({ name: '$c' }), EX.usableComponentName({ name: '$w' }),
	EX.usableComponentName({ name: '(ChatView)' }), EX.usableComponentName({ name: 'ChatView' }),
], [null, null, '(ChatView)', 'ChatView']);

// ── A2:LoAF 脚本 → 包名(charPos → 行号 → 分段表)────────────────────
const comboUrl = 'http://h/plugins/??dsh-a/client.js,dsh-b/client.js&rev=9';
await EX.loadScriptLines(comboUrl);          // 假脚本 3 行:aaa / bbb / ccc
check('scriptLineOf:charPos 0 在第 1 行', EX.scriptLineOf(comboUrl, 0), 1);
check('scriptLineOf:换行符本身算下一行起点', [EX.scriptLineOf(comboUrl, 3), EX.scriptLineOf(comboUrl, 4), EX.scriptLineOf(comboUrl, 8)], [1, 2, 3]);
check('scriptLineOf:文本没到位就是 null(不猜)', EX.scriptLineOf('http://h/plugins/??x,y/client.js', 5), null);
check('scriptLineOf:字符位置超出文本 → -1', EX.scriptLineOf(comboUrl, 999), -1);
check('packageOfScript:非插件脚本 → not-plugin', EX.packageOfScript('http://h/assets/index.js', 10), { pkg: null, via: 'not-plugin' });
check('packageOfScript:单包 URL 直接读出包名', EX.packageOfScript('http://h/plugins/??dsh-x/client.js&rev=1', 10), { pkg: 'dsh-x', via: 'url' });
check('packageOfScript:没有 URL → no-url', EX.packageOfScript('', 10), { pkg: null, via: 'no-url' });
box.state.precise = false;
check('packageOfScript:精确归因关着 → 说清楚', EX.packageOfScript(comboUrl, 10), { pkg: null, via: 'precise-off' });
box.state.precise = true;
check('packageOfScript:脚本文本没备好 → text-pending', EX.packageOfScript('http://h/plugins/??p,q/client.js&rev=2', 10), { pkg: null, via: 'text-pending' });
const comboKey = `bundle:${comboUrl}`;
box.bundleMaps.set(comboKey, { state: 'pending' });
check('packageOfScript:分段表还在解析 → map-pending', EX.packageOfScript(comboUrl, 10), { pkg: null, via: 'map-pending' });
box.bundleMaps.set(comboKey, { state: 'ready', offsets: [[0, 'dsh-a'], [2, 'dsh-b']], names: ['dsh-a', 'dsh-b'], count: 2 });
check('packageOfScript:charPos 落在第二段 → dsh-b', EX.packageOfScript(comboUrl, 9), { pkg: 'dsh-b', via: 'section' });
check('packageOfScript:字符位置越界 → out-of-range', EX.packageOfScript(comboUrl, 999), { pkg: null, via: 'out-of-range' });
check('packageOfScript:没有字符位置 → no-charpos', EX.packageOfScript(comboUrl, null), { pkg: null, via: 'no-charpos' });
box.state.precise = false;   // 还原:后面的用例假设它是关着的
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

// 子树腿:切视图那种"整棵新子树一次性挂载",答案在**子树里**,不在祖先上
// (实测:切 dsh-context 的上下文视图,祖先方向只能得到宿主容器 DefaultConversationViews)
const leafFiber = (name) => ({ type: name === null ? 'span' : named(name), child: null, sibling: null, alternate: null });
const tabContainer = {
	__reactFiber$tab: {
		type: 'div', alternate: {},
		child: { type: 'div', child: leafFiber('ContextPane'), sibling: null, alternate: null },
		sibling: null,
	},
};
check('子树腿:新挂载子树里的第一个具名组件',
	EX.descendantComponentOf(tabContainer), 'ContextPane');
const layered = {
	__reactFiber$lay: {
		type: 'div', alternate: {},
		child: { type: 'div', child: { type: named('SlotOutlet'), child: leafFiber('RealPane'), sibling: null, alternate: null }, sibling: null, alternate: null },
		sibling: null,
	},
};
check('子树腿:子树里的外壳名同样跳过', EX.descendantComponentOf(layered), 'RealPane');
check('子树腿:没有 fiber 就没有', EX.descendantComponentOf({ className: 'x' }), null);
check('切视图场景的展示:祖先容器 + 子树里的真组件',
	EX.blameText({ component: 'DefaultConversationViews', subtreeComponent: 'ContextPane', domComponent: null, owner: null }),
	'DefaultConversationViews / ContextPane(子树)');
check('只有子树腿时它就是答案(而不是未归因)',
	EX.blameText({ component: null, subtreeComponent: 'ContextPane', domComponent: null, owner: null }), 'ContextPane(子树)');
check('腿判定:子树腿单列', EX.legOf({ component: null, subtreeComponent: 'X', domComponent: null, owner: null }), 'subtree');
check('主名字优先级:fiber > 子树 > DOM > 包名',
	[
		EX.primaryBlame({ component: 'A', subtreeComponent: 'B', domComponent: 'C', owner: 'D' }),
		EX.primaryBlame({ component: null, subtreeComponent: 'B', domComponent: 'C', owner: 'D' }),
		EX.primaryBlame({ component: null, subtreeComponent: null, domComponent: 'C', owner: 'D' }),
		EX.primaryBlame({ component: null, subtreeComponent: null, domComponent: null, owner: 'D' }),
	], ['A', 'B', 'C', 'D']);
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

	// 宿主外壳组件不该被当成"谁在渲染"(实测命中报成 SlotOutlet)
	check('looksLikeInfrastructure 认外壳:SlotOutlet', EX.looksLikeInfrastructure('SlotOutlet'), true);
	check('looksLikeInfrastructure 认外壳:ConfigProvider', EX.looksLikeInfrastructure('ConfigProvider'), true);
	check('looksLikeInfrastructure 认外壳:CenterColumn(布局列)', EX.looksLikeInfrastructure('CenterColumn'), true);
	check('合计耗时:极小值不写成 0', [EX.msPerSecText(0), EX.msPerSecText(0.02), EX.msPerSecText(1.25)], ['0ms/s', '<0.1ms/s', '1.3ms/s']);
	// 渲染预算:显示值没变就不重渲染(折叠不动时 HUD 自身开销应接近零)
	box.state.idleSince = 0;
	box.state.errors = [];
	box.state.stressNodes = 0;
	const stableKey = EX.displayKey();
	check('指纹:同一状态两次一致', EX.displayKey() === stableKey, true);
	box.state.fps += 5;
	check('指纹:显示的数值变了就变', EX.displayKey() !== stableKey, true);
	box.state.groups.detail = true;
	check('指纹:折叠状态变化也算变', EX.displayKey() !== stableKey, true);
	box.state.groups.detail = false;

	// 判定而不是只摆数字:两者都正常时必须给出结论
	box.state.hostError = null;
	box.state.host = { eventLoop: { p50: 1.2, p99: 4.3 }, nodeVersion: 'v24' };
	box.state.link = [{ t: Date.now(), kind: 'rtt', rtt: 13 }];
	check('宿主与链路都正常 → 直接说链路已排除', EX.infraVerdict().text, '链路已排除(宿主与隧道均正常)');
	box.state.link = [{ t: Date.now(), kind: 'rtt', rtt: 400 }, { t: Date.now(), kind: 'rtt', rtt: 400 }];
	check('RTT p99 超阈值 → 判为链路存疑', EX.infraVerdict().bad, true);
	box.state.host = { eventLoop: { p50: 1.2, p99: 120 } };
	box.state.link = [];
	check('宿主 p99 超阈值 → 判为宿主存疑', EX.infraVerdict().bad, true);
	// 未解释帧:最差帧 130ms 而帧内未归因峰值也是 130ms → 那一帧完全没有 JS 解释
	box.state.frameWorst = 130;
	box.state.unattrPeak = 130;
	check('未解释帧自动触发(峰值≈最差帧)', EX.unexplainedFrame().percent, 100);
	box.state.unattrPeak = 30;
	check('有 JS 解释时不该触发', EX.unexplainedFrame(), null);
	// 合并判色:FPS 绿不能掩盖最差帧
	check('FPS 好但最差帧 130ms → 至少黄', EX.levelFrame(54.2, 130).includes('warn'), true);
	check('FPS 54 且最差帧 18ms → 绿', EX.levelFrame(54.2, 18).includes('success'), true);

	// 「其余」行原来给累计值、上面几行给每秒速率 —— 同一张表两套单位,必须统一
	const restRows = [
		{ cps: 0.5, msps: 0.1, count: 60, ms: 3 },
		{ cps: 0.2, msps: 0.05, count: 30, ms: 1 },
	];
	check('其余行用与上面同一套单位(本秒速率)', EX.restValueText(restRows), '0.7/s · 0.2ms/s');
	check('其余行的累计值收进悬停,并解释"其余"是什么',
		EX.restTitleText(restRows).includes('累计 90 次 / 4ms') && EX.restTitleText(restRows).includes('其余 ='),
		true);

	// 峰值不带单位会被读成毫秒(实测截图里 "0.5/s · 峰 17.8" 就是这个歧义)
	check('归因行:两个速率都带单位',
		EX.attrText({ cps: 0.5, cpsPeak: 17.8 }), '0.5/s · 峰 17.8/s');
	check('looksLikeInfrastructure 不误伤真组件',
		[EX.looksLikeInfrastructure('ChatView'), EX.looksLikeInfrastructure('PerfHudStress'), EX.looksLikeInfrastructure('dsh-perf-hud')],
		[false, false, false]);
	check('长任务:fiber 给到外壳 → 退到 DOM 写入那条腿',
		EX.blameText({ component: 'SlotOutlet', domComponent: 'AssistantMarkdown', owner: null }), 'AssistantMarkdown(DOM 写入)');
	check('长任务:两条腿不同就都念出来',
		EX.blameText({ component: 'ChatView', domComponent: 'ChatNodeSeat', owner: null }), 'ChatView / ChatNodeSeat(DOM 写入)');
	check('长任务:只有调度方归属时念包名',
		EX.blameText({ component: null, domComponent: null, owner: '@deepseek-ai/dsh-client-ui-chat' }), 'dsh-client-ui-chat');
	check('长任务:只剩外壳名时最后才用它',
		EX.blameText({ component: 'SlotOutlet', domComponent: null, owner: null }), 'SlotOutlet');
	check('长任务:什么都没有 → 未归因',
		EX.blameText({ component: null, domComponent: null, owner: null }), '未归因');
	// 命中率说明不了问题(DOM 腿在流式时几乎必然命中)——要看名字分布。
	// 并且钉住"命中"与"分布"是同一套判定(旧版 ltBlamed 漏了 dom 腿,两者对不上)。
	box.state.ltNames.clear();
	box.state.ltLegs = { fiber: 0, subtree: 0, dom: 0, owner: 0, none: 0 };
	box.state.ltTotal = 5;
	const longRows = [
		{ t: 1, component: 'ChatView', domComponent: 'X', owner: null },
		{ t: 2, component: 'SlotOutlet', domComponent: 'StartedBashRow', owner: null },
		{ t: 3, component: null, domComponent: null, owner: '@deepseek-ai/dsh-x' },
		{ t: 4, component: null, domComponent: null, owner: null },
		{ t: 5, component: 'ChatView', domComponent: 'ChatView', owner: null },
	];
	check('腿判定:fiber(非外壳)/dom/owner/none',
		longRows.map((row) => EX.legOf(row)), ['fiber', 'dom', 'owner', 'none', 'fiber']);
	for (const row of longRows) EX.applyLongTaskStats(row);
	const tally = EX.longTaskTally();
	check('归属分布:三条腿累计计数', [tally.fiber, tally.dom, tally.owner, tally.none], [2, 1, 1, 1]);
	check('归属分布:总数取自累计计数器(不受 200 条明细上限影响)', tally.total, 5);
	check('归属分布:按主名字聚合(展示串不拆散统计)',
		tally.topNames.map((row) => [row[0], row[1]]), [['ChatView', 2], ['StartedBashRow', 1], ['dsh-x', 1]]);
	check('归属分布:Top 截断到 3', [tally.top.length, tally.topNames.length], [3, 3]);
	// HUD 自己的 DOM 写入必须不记账(实测摘要里出现过 (PerfHud) 顶在第一名)

// ── 排版预算:概览与折叠摘要必须一行放得下(实测被吐槽过参差换行) ──
box.state.frameWorst = 17;
box.state.ltTotal = 16;
box.state.ltBlamed = 15;
box.state.dom = { total: 5408, series: [{ t: 0, n: 5600 }, { t: 12000, n: 5408 }] };
box.state.mutations = 98121;
box.state.targets = new Map([['messages', { nodes: 3285, series: [] }]]);
box.state.longTasks = [{ t: Date.now(), at: performance.now() - 100, ms: 285, owner: null, component: 'FileTree', subtreeComponent: 'ConfirmDialog', domComponent: null }];
box.state.ltNames.clear();
box.state.ltLegs = { fiber: 0, subtree: 0, dom: 0, owner: 0, none: 0 };
EX.applyLongTaskStats(box.state.longTasks[0]);
box.state.ltNames.set('ChatView', 5);
check('概览第一行的长度预算', EX.overviewLine1().length <= 36, true);
check('概览第二行的长度预算(允许左对齐换行一次)', EX.overviewLine2().length <= 60, true);
check('概览第二行给出归属(含子树那条腿)',
	EX.overviewLine2().includes('ConfirmDialog') && EX.overviewLine2().includes('子树'), true);
check('最多与主名字相同时不重复显示(避免为一行废话再换一行)',
	(() => {
		box.state.longTasks = [{ t: Date.now(), at: performance.now() - 100, ms: 285, owner: null, component: 'ChatView', subtreeComponent: null, domComponent: null }];
		box.state.ltNames.clear();
		box.state.ltNames.set('ChatView', 22);
		return EX.overviewLine2().includes('最差');
	})(), false);
check('最多与主名字不同时才追加一行(主动断行,不靠宽度)',
	(() => {
		box.state.longTasks = [{ t: Date.now(), at: performance.now() - 100, ms: 285, owner: null, component: 'ConfirmDialog', subtreeComponent: null, domComponent: null }];
		box.state.ltNames.clear();
		box.state.ltNames.set('ChatView', 22);
		box.state.ltNames.set('ConfirmDialog', 1);
		const text = EX.overviewLine2();
		return text.split('\n').length === 2 && text.split('\n')[1].includes('ChatView 22×');
	})(), true);
// 真实量级(五位数)也要能一行放下 —— 桩里的小数字曾经把这条断言喂成了"通过"
box.state.mutations = 36250;
box.state.unattrAvg = 17.3;
check('四个折叠组摘要的长度预算(按真实量级:五位数 + 小数)', [EX.detailSummary().length <= 26, EX.domSummary().length <= 30, EX.hostSummary().length <= 34, EX.toolsSummary().length <= 24],
	[true, true, true, true]);
box.state.mutations = 0;
box.state.unattrAvg = 0;

// ── 面板分层:折叠状态与摘要 ───────────────────────────────────────
check('默认全部收起(过程/取证/工具不占常显篇幅)',
	JSON.stringify(box.state.groups), JSON.stringify({ detail: false, dom: false, host: false, tools: false }));
EX.toggleGroup('dom');
check('toggle 展开', box.state.groups.dom, true);
check('折叠选择被记住', JSON.parse(box.storage.getItem('dsh-perf-hud:groups')).dom, true);
EX.toggleGroup('dom');
check('再 toggle 收起', box.state.groups.dom, false);
EX.toggleGroup('不存在的分组');
check('未知分组名不产生新键', Object.hasOwn(box.state.groups, '不存在的分组'), false);
box.state.targets = new Map();
check('摘要取不到容器:如实写未采集', EX.containerNodes('messages'), '未采集');
box.state.targets.set('messages', { nodes: 3571, series: [] });
check('摘要给出一句话节点数', EX.containerNodes('messages'), '3571');

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
check('自测没跑过:只写未采集,不铺说明(说明在按钮 title 里)', EX.stressText(), '自测结果: 未采集');
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
// 候选必须来自宿主真实列表,不能写死插件名 —— 否则换台机器/换个 profile,实验默认测
// 的全是"没装的东西"。这里用一份混着内核包、未启用包、不可移除包与本插件自己的列表钉住判据。
const liveBundles = [
	{ name: '@deepseek-ai/dsh-base', enabled: true, installed: false, removable: false },
	{ name: '@deepseek-ai/dsh-web-app', enabled: true, installed: false, removable: false },
	{ name: 'dsh-perf-hud', enabled: true, installed: true, removable: true },
	{ name: 'dsh-zzz', enabled: false, installed: true, removable: true },
	{ name: 'dsh-bbb', enabled: true, installed: true, removable: true },
	{ name: 'dsh-aaa', enabled: true, installed: true, removable: true },
	{ name: 'dsh-yyy', enabled: true, installed: true, removable: false },
	{ name: 'dsh-ccc', enabled: true, installed: true, removable: true },
];
check('候选只取已启用且可移除的社区包(排掉内核 / 未启用 / 不可移除 / 自己)',
	EX.pickExperimentCandidates(liveBundles, 'dsh-perf-hud'), ['dsh-aaa', 'dsh-bbb', 'dsh-ccc']);
check('候选按名字排序并截到上限(每个候选 90 秒,不能无上限)',
	EX.pickExperimentCandidates([
		{ name: 'p5', enabled: true, removable: true }, { name: 'p3', enabled: true, removable: true },
		{ name: 'p1', enabled: true, removable: true }, { name: 'p4', enabled: true, removable: true },
		{ name: 'p2', enabled: true, removable: true },
	], 'self'), ['p1', 'p2', 'p3', 'p4']);
check('列表为空/形状不对时返回空数组(实验据此报"没有可对照的插件")',
	EX.pickExperimentCandidates([], 'self'), []);
// off - base:关掉插件后每帧残差从 16ms 掉到 12ms → -4(这正是我们要的方向)
check('experimentDelta 对照紧邻基线(含每帧未归因残差)',
	EX.experimentDelta({ fps: 60, longTasks: 3, domPerMin: 40, unattrAvg: 16 }, { fps: 55, longTasks: 1, domPerMin: 10, unattrAvg: 12 }),
	{ fps: -5, longTasks: -2, domPerMin: -30, unattrAvg: -4 });
check('缺任一侧就不写 Δ', EX.experimentDelta(null, { fps: 1, longTasks: 0, domPerMin: 0 }), null);
check('noiseFloor 取基线间漂移的最大绝对值',
	EX.noiseFloor([{ fps: -1, longTasks: 2, domPerMin: -5, unattrAvg: -1.5 }, { fps: 3, longTasks: -1, domPerMin: 9, unattrAvg: 0.4 }]),
	{ fps: 3, longTasks: 2, domPerMin: 9, unattrAvg: 1.5 });
check('significance 逐指标判断是否超出噪声',
	EX.significance({ fps: -1, longTasks: 14, domPerMin: 4219, unattrAvg: 8 }, { fps: 3, longTasks: 2, domPerMin: 9, unattrAvg: 2 }),
	{ fps: false, longTasks: true, domPerMin: true, unattrAvg: true });
check('metricList 列出超标指标(未归因残差优先,fps 之后)',
	EX.metricList({ fps: false, longTasks: true, domPerMin: true, unattrAvg: true }), '未归因/LT/DOM');
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
// 独立包名 vs 合并包 key:精确归因要能给出前者。两种键都塞进去,断言只看前者。
box.state.plugins.set('dsh-x', { count: 3, ms: 1.5 });
box.state.plugins.set('bundle:http://h/plugins/??a/client.js,b/client.js', { count: 5, ms: 2 });
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
check('verification 段报出独立包名(不含合并包 key)与 longtask 命中',
	exported.verification.independentPackages.sample.includes('dsh-x')
	&& exported.verification.independentPackages.sample.every((id) => id.startsWith('bundle:') === false)
	&& exported.verification.longTask.attributed === 5 && exported.verification.longTask.withComponent === 1, true);

// ── G:守夜层(帧环 / 触发 / 留存 / 时间对齐 / 窗口切片)──────────────────
// 抽的是 client.js 里的真函数与真常量(连阈值一起抽,免得测试自己抄一份默认值)。
const watchSource = (() => {
	const from = source.indexOf('const WATCH_FRAMES');
	const to = source.indexOf('\n', source.indexOf('const WATCH_PERSIST_MAX_BYTES'));
	return source.slice(from, to);
})();
const watchPieces = [
	watchSource,
	`${extract(source, 'const frameRing = {')};`,
	extract(source, 'function watchTrigger('),
	extract(source, 'function loafScripts('),
	extract(source, 'function wallClock('),
	extract(source, 'function watchFrame('),
	extract(source, 'function triggerCapture('),
	extract(source, 'function settleCapture('),
	extract(source, 'function keepIncident('),
	extract(source, 'function assembleIncident('),
	extract(source, 'function captureNow('),
	extract(source, 'function watchStatus('),
	extract(source, 'function watchPanelText('),
	extract(source, 'function watchLatestText('),
	extract(source, 'function watchRowText('),
	extract(source, 'function perfOrigin('),
	extract(source, 'function saveIncidents('),
	extract(source, 'function restoreIncidents('),
	extract(source, 'function frameSplit('),
	extract(source, 'function worstLoaf('),
	extract(source, 'function pickIncident('),
	extract(source, 'function incidentFileName('),
	extract(source, 'function incidentReport('),
	extract(source, 'function round1('),
].join('\n');
const watchBox = new Function(`
	${watchPieces}
	let nowMs = 100000;
	const timers = [];
	const natives = {
		setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
		clearTimeout: () => {},
	};
	const performance = { now: () => nowMs, timeOrigin: 1700000000000 };
	const document = { visibilityState: 'visible' };
	const PKG = 'dsh-perf-hud';
	// assembleIncident 会调用 packageOfScript:这里用桩把它隔离掉(真函数在上一个盒子里
	// 有 11 条断言),只验证"切片时确实记了 pkg / pkgVia 两个字段"这个契约。
	const packageOfScript = () => ({ pkg: null, via: 'stub' });
	const location = { href: 'http://127.0.0.1:3080/' };
	const navigator = { userAgent: 'test-agent', hardwareConcurrency: 10 };
	const W = { innerWidth: 1600, innerHeight: 900, devicePixelRatio: 2 };
	// 面板文案用的两个桩:断言只检查"人看到的字",key 兜底返回 key 本身
	const translate = (key) => ({
		watch: '守夜', watchCaught: '抓到', watchWorst: '最差', watchRestored: '读回', watchOff: '未开录', watchNone: '还没抓到', watchPersistFailed: '落盘失败', watchTrimmed: '裁掉', times: ' 次',
	})[key] ?? key;
	const clock = (ms) => { const d = new Date(ms); const pad = (n) => (String(n).length < 2 ? '0' + n : String(n)); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
	const LS_INCIDENTS = 'test:incidents';
	const store = new Map();
	let failWrites = false;
	const localStorage = {
		getItem: (key) => (store.has(key) ? store.get(key) : null),
		setItem: (key, value) => { if (failWrites) throw new Error('QuotaExceededError'); store.set(key, value); },
		removeItem: (key) => store.delete(key),
	};
	const state = {
		samplesLength: 1,
		on: true, precise: false, streaming: true, heap: 1048576, host: null, hostAt: 0,
		dom: { total: 1234 },
		longTasks: [],
		watch: { on: true, loaf: [], loafObserver: null, loafState: 'on', incidents: [], pending: null, pendingTimer: 0, seq: 0, captured: 0, coalesced: 0, dropped: 0, restored: 0, trimmedByBytes: 0, deduped: 0, coveredUntil: 0, persistError: null },
	};
	return {
		state, frameRing, watchTrigger, loafScripts, wallClock, watchFrame, triggerCapture, settleCapture,
		keepIncident, assembleIncident, captureNow, watchStatus, incidentReport, pickIncident, incidentFileName, frameSplit, worstLoaf, timers, store,
		watchPanelText, watchLatestText, watchRowText,
		saveIncidents, restoreIncidents, perfOrigin, setFail: (value) => { failWrites = value; }, WATCH_MAX_BYTES: WATCH_PERSIST_MAX_BYTES,
		WATCH: { frames: WATCH_FRAMES, loaf: WATCH_LOAF_MAX, script: WATCH_SCRIPT_MAX, keep: WATCH_INCIDENT_MAX, pre: WATCH_PRE_MS, post: WATCH_POST_MS, trigger: WATCH_TRIGGER_MS, gap: WATCH_GAP_MS, reaction: WATCH_REACTION_MS },
		setNow: (value) => { nowMs = value; },
		runTimer: (index) => timers[index].fn(),
	};
`)();
const watch = watchBox;

// 触发判据:低于线不触发,返回严重度便于留存排序
check('watchTrigger(99) 不触发', watch.watchTrigger(99), null);
check('watchTrigger(100) 触发并回报 100', watch.watchTrigger(100), 100);
check('watchTrigger(150.44) 四舍五入到 0.1', watch.watchTrigger(150.44), 150.4);
check('watchTrigger 非数字不触发', [watch.watchTrigger(undefined), watch.watchTrigger('100')], [null, null]);

// 帧环:区间截取 + gap 标记 + 升序
watch.frameRing.push(5000, 16.66, false);
watch.frameRing.push(9900, 150, false);
watch.frameRing.push(10000, 20, false);
watch.frameRing.push(10020, 8000, true);     // rAF 挂起:是间隙不是卡顿
watch.frameRing.push(20000, 17, false);      // 窗口之外
const ringSlice = watch.frameRing.slice(0, 13000);
check('frameRing.slice 只取窗口内、按时间升序', ringSlice.map((row) => row.t), [5000, 9900, 10000, 10020]);
check('frameRing.slice 保留 gap 标记', ringSlice.map((row) => row.gap), [false, false, false, true]);
check('frameRing.slice 毫秒保留一位', ringSlice[0].ms, 16.7);

// 帧环:满了覆盖最早的,size 不超上限
for (let i = 0; i < watch.WATCH.frames + 5; i += 1) watch.frameRing.push(30000 + i, 16, false);
check('帧环满了之后 size 保持上限', watch.frameRing.size, watch.WATCH.frames);
check('帧环覆盖最老的:窗口起点是第 6 条', watch.frameRing.slice(30000, 40000)[0].t, 30005);

// LoAF 脚本映射:字段取全、invoker 截断、条数封顶、脏数据不抛
const manyScripts = Array.from({ length: 20 }, (_, i) => ({ sourceURL: `u${i}`, duration: i, forcedStyleAndLayoutDuration: 1, pauseDuration: 2, invoker: 'x'.repeat(200), invokerType: 'user-callback', sourceFunctionName: '', sourceCharPosition: i }));
const mapped = watch.loafScripts({ scripts: manyScripts });
check('loafScripts 封顶到 WATCH_SCRIPT_MAX', mapped.length, watch.WATCH.script);
check('loafScripts invoker 截到 80 字符', mapped[0].invoker.length, 80);
check('loafScripts 空函数名归一成 null', mapped[0].fn, null);
check('loafScripts 容忍 scripts 缺失', watch.loafScripts({}), []);

// 时间对齐:perf → 墙上时间
check('wallClock 用 timeOrigin 对齐', watch.wallClock(10000), new Date(1700000000000 + 10000).toISOString());

// 留存:满了以后"不够差"的丢掉、"更差"的顶掉最弱的一条
for (const severity of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) watch.keepIncident({ id: `k${severity}`, severity });
check('留存满了:按严重度降序、只留最差 N 次', watch.state.watch.incidents.map((row) => row.severity), [100, 90, 80, 70, 60, 50, 40, 30, 20, 10]);
check('比现有最弱的还弱 → 丢掉,不进列表', watch.keepIncident({ id: 'weak', severity: 5 }), 'dropped');
check('丢掉之后列表不变', watch.state.watch.incidents.map((row) => row.severity), [100, 90, 80, 70, 60, 50, 40, 30, 20, 10]);
check('更差的顶掉最弱那条', watch.keepIncident({ id: 'strong', severity: 99 }), 'replaced');
check('顶掉之后仍降序且最弱的已出局', watch.state.watch.incidents.map((row) => row.severity), [100, 99, 90, 80, 70, 60, 50, 40, 30, 20]);
watch.state.watch.incidents.length = 0;
watch.state.watch.dropped = 0;
watch.state.watch.coalesced = 0;

// 自动捕获(整条链):一帧超线 → 切片 → 留存
// 上面"满环覆盖"那条用例已经把环灌满了,这里按需要重建窗口内的帧。
watch.frameRing.reset();
watch.frameRing.push(5000, 16.66, false);
watch.frameRing.push(9900, 150, false);
watch.frameRing.push(10000, 20, false);
watch.frameRing.push(10020, 8000, true);
watch.frameRing.push(20000, 17, false);
watch.state.longTasks.push({ t: Date.now(), at: 9900, ms: 150, owner: 'dsh-x', component: 'ChatRow', source: 'scheduler+render' });
watch.setNow(100000);            // 远在 until 之后:立即结算
watch.watchFrame(10000, 150, false);
const firstIncident = watch.state.watch.incidents[0];
check('超线的一帧自动抓成一次事故', watch.state.watch.incidents.length, 1);
check('事故带上触发原因与严重度', [firstIncident.cause, firstIncident.severity, firstIncident.kept], ['frame', 150, 'kept']);
check('事故窗口 = 前摇 + 后摇', [firstIncident.window.fromMs, firstIncident.window.toMs, firstIncident.window.preMs, firstIncident.window.postMs], [0, 13000, 10000, 3000]);
check('窗口里最差帧与计数(gap 不算帧、不算最差)',
	[firstIncident.summary.worstFrameMs, firstIncident.summary.frames, firstIncident.summary.framesOver50Ms, firstIncident.summary.framesOver100Ms, firstIncident.summary.hiddenGaps],
	[150, 3, 1, 1, 1]);
check('窗口带上了同时段的 longtask 明细', [firstIncident.summary.longTasksInWindow, firstIncident.longTasks[0].owner], [1, 'dsh-x']);
check('事故带环境读数与墙上时间', [firstIncident.env.domNodes, firstIncident.at], [1234, new Date(1700000000000 + 10000).toISOString()]);
check('事故带会话基线,而且**排除了本窗口**(含自己就永远"比不上")', [firstIncident.baseline.frames, firstIncident.baseline.p50, firstIncident.baseline.worstMs], [1, 17, 17]);
watch.state.watch.coveredUntil = 0;
watch.state.longTasks.length = 0;
watch.state.watch.loaf.length = 0;
watch.frameRing.reset();
for (let i = 0; i < 8; i += 1) watch.frameRing.push(70000 + i * 16.7, 16.7, false);
watch.frameRing.push(70200, 983.7, false);
for (let i = 0; i < 8; i += 1) watch.frameRing.push(70300 + i * 16.7, 16.7, false);
watch.setNow(80000);
const throttle = watch.triggerCapture('frame', 70200, 983.7);
check('疑似节流:最差帧没有 JS 证据、前后都是健康帧 → 标出来(真实数据里的那一帧)',
	[throttle.summary.worstFrameMs, throttle.summary.worstFrameJs, throttle.summary.worstFrameNeighboursMs, throttle.summary.suspectedThrottle],
	[983.7, 'none', 16.7, true]);
check('有 JS 重叠时不算节流', (() => {
	watch.frameRing.reset();
	for (let i = 0; i < 8; i += 1) watch.frameRing.push(90000 + i * 16.7, 16.7, false);
	watch.frameRing.push(90200, 983.7, false);
	watch.state.longTasks.push({ t: Date.now(), at: 89400, ms: 800, owner: 'dsh-x', component: 'ChatView', source: 'render' });
	watch.state.watch.coveredUntil = 0;
	watch.setNow(95000);
	const withJs = watch.triggerCapture('frame', 90200, 983.7);
	return [withJs.summary.worstFrameJs, withJs.summary.suspectedThrottle];
})(), ['js', false]);
// 上面两条是探针(严重度最高,排在队首):去掉它们,把状态还原成后面的用例期望的样子
watch.state.watch.incidents.splice(0, 2);
watch.state.watch.captured = 1;
watch.state.watch.coalesced = 0;
watch.state.watch.dropped = 0;
watch.state.watch.trimmedByBytes = 0;
watch.state.watch.coveredUntil = 0;
check('会话基线:ms 数组里的间隙不算帧', watch.frameRing.reset() === undefined && (watch.frameRing.push(1, 16, false), watch.frameRing.push(2, 300, true), watch.frameRing.push(3, 20, false), watch.frameRing.stats().frames), 2);

// 归并:后摇没到就再来一次,算同一串(记 coalesced,不当成第二次事故)
watch.setNow(50000);
watch.watchFrame(49000, 150, false);
check('后摇未到:先挂起,不出事故', [watch.state.watch.pending.cause, watch.state.watch.incidents.length], ['frame', 1]);
watch.watchFrame(49500, 300, false);
check('同一串里的第二次触发被归并', watch.state.watch.coalesced, 1);
check('归并不新增事故', watch.state.watch.incidents.length, 1);
watch.runTimer(watch.timers.length - 1);
check('后摇到点才切片,严重度由触发那次决定', [watch.state.watch.captured, watch.state.watch.incidents.length], [2, 2]);
check('窗口结束时刻被记为已覆盖', watch.state.watch.coveredUntil, 52000);

// 去重:已经落在这份窗口里的时刻不再另立一份(实测过一次卡顿裂成两份)
watch.setNow(52500);
watch.watchFrame(51500, 300, false);
check('落在已覆盖窗口里的触发不再另立事故', [watch.state.watch.incidents.length, watch.state.watch.pending], [2, null]);
check('去重也算归并(不假装它没发生)', watch.state.watch.coalesced, 2);

// 手动标记:回退反应时间、立刻结算;落在窗口里也照样收(明确意图)
watch.setNow(60000);
const manual = watch.captureNow('刚切了视图');
check('手动标记立刻出事故', [manual.ok, manual.incident.cause, manual.incident.note], [true, 'manual', '刚切了视图']);
check('手动标记回退' + watch.WATCH.reaction + 'ms', Math.round(manual.incident.atPerfMs), 57000);
watch.state.watch.on = false;
check('HUD 关着时手动标记如实说没在录', watch.captureNow().ok, false);

// 状态:照实报
watch.state.watch.on = true;
const status = watch.watchStatus();
check('watchStatus 报出录制状态与阈值', [status.recording, status.loaf, status.triggers.frameMs, status.triggers.keep], [true, 'on', 100, 10]);
check('watchStatus 报出帧样本数与留存清单', [status.frameSamples > 0, Array.isArray(status.kept), status.kept.length], [true, true, 3]);

// 面板上那一行:抓到几次 / 最差多少 / 备注 / 没抓到 / 没开录
check('守夜行:抓到次数 + 最差严重度', watch.watchPanelText().startsWith('抓到 3 次 · 最差 300ms'), true);
check('守夜行:带备注时列出最近一条', (() => {
	watch.state.watch.incidents.unshift({ id: 'x1', severity: 12, cause: 'manual', at: '2026-10-07T00:00:00.000Z', note: '刚切了视图' });
	const text = watch.watchLatestText();
	watch.state.watch.incidents.shift();     // 验完挪走:后面的 incidentReport(0) 还要靠真事故
	return text.includes('刚切了视图');
})(), true);
check('工具清单行:带序号与 id', watch.watchRowText({ id: 'x1', severity: 12, cause: 'manual', at: '2026-10-07T00:00:00.000Z', note: null }, 4).startsWith('5. x1 · manual · 12ms'), true);
check('守夜行:关掉时说未开录', (() => { watch.state.watch.on = false; const text = watch.watchPanelText(); watch.state.watch.on = true; return text; })(), '未开录');
check('守夜行:没抓到也照实说,并把阈值写出来', (() => {
	const keptRows = watch.state.watch.incidents.splice(0, watch.state.watch.incidents.length);
	const emptyText = watch.watchPanelText();
	const emptyLatest = watch.watchLatestText();
	watch.state.watch.incidents.push(...keptRows);
	return emptyText.startsWith('还没抓到(≥100ms)') && emptyLatest === null;
})(), true);

// 事故包:自描述头 + 缺失声明(缺什么、怎么补)
check('事故包:不存在的 id 返回 null(不静默成功)', watch.incidentReport('nope'), null);
const report = watch.incidentReport(0);
check('summary 带窗口自己的分位(否则"和 baseline 比"在文件内做不了)', [typeof report.incident.summary.p50, report.incident.summary.p50 <= report.incident.summary.worstFrameMs, report.incident.summary.p99 === report.incident.summary.worstFrameMs], ['number', true, true]);
check('会话基线:用"真的在跑的时间"算 fps,不被挂起拉低', (() => {
	watch.frameRing.reset();
	watch.frameRing.push(1000, 16.7, false);
	watch.frameRing.push(2000, 16.7, false);
	watch.frameRing.push(40000, 38000, true);      // 一次 38 秒的挂起
	watch.frameRing.push(40016, 16.7, false);
	const stats = watch.frameRing.stats();
	return [stats.frames, stats.spanMs, stats.busyMs, stats.fps];
})(), [3, 39016, 50.1, 59.9]);
check('切片时给每条脚本记了 pkg 与 pkgVia(这里 packageOfScript 是桩)', (() => {
	watch.state.watch.loaf.push({
		t: 195000, dur: 20, blocking: 0, renderStart: 0, styleAndLayoutStart: 0,
		scripts: [{ url: 'http://h/plugins/??a/client.js', fn: null, invoker: null, invokerType: 'user-callback', charPos: 1, ms: 5, forcedMs: 0, pauseMs: 0 }],
	});
	watch.setNow(250000);            // 让它立刻结算(不等后摇)
	watch.state.watch.coveredUntil = 0;
	const probe = watch.triggerCapture('frame', 195000, 150);
	const script = probe.loaf.flatMap((row) => row.scripts)[0];
	return [probe.summary.pkgCoverage, 'pkg' in script, script.pkgVia];
})(), [{ resolved: 0, total: 1 }, true, 'stub']);
watch.state.watch.coveredUntil = 0;
check('帧拆分:LoAF 三个时间点 → 脚本侧 / 渲染 / 样式+布局+绘制的占比', watch.frameSplit({
	t: 1000, dur: 200, renderStart: 1120, styleAndLayoutStart: 1140, blocking: 90,
	scripts: [{ ms: 60 }, { ms: 40 }],
}), { at: 1000, total: 200, head: 120, js: 100, render: 20, tail: 60, blocking: 90 });
check('帧拆分:缺 renderStart 时全部算"脚本侧",不猜', watch.frameSplit({ t: 0, dur: 60, blocking: 1, scripts: [] }), { at: 0, total: 60, head: 60, js: 0, render: 0, tail: 0, blocking: 1 });
check('帧拆分:脏数据返回 null', [watch.frameSplit(null), watch.frameSplit({ t: 0, dur: 0 })], [null, null]);
check('worstLoaf 取 blocking 最大的那条', (() => {
	const saved = watch.state.watch.loaf.slice();
	watch.state.watch.loaf.length = 0;
	watch.state.watch.loaf.push({ t: 1, dur: 60, blocking: 10, scripts: [] }, { t: 2, dur: 300, blocking: 200, scripts: [] });
	const got = watch.worstLoaf().t;
	watch.state.watch.loaf.length = 0;
	for (const row of saved) watch.state.watch.loaf.push(row);
	return got;
})(), 2);
check('导出文件名:本地时间、可排序、无冒号(Windows 合法)', (() => {
	const name = watch.incidentFileName({ id: 'i84' }, '2026-10-08T14:03:58.490Z');
	return [/^perf-hud-\d{8}-\d{6}-i84\.json$/.test(name), name.includes(':'), name.includes('T'), name.includes('Z')];
})(), [true, false, false, false]);
check('A1 记录器自身开销:环形缓冲 + p99/峰/样本数', (() => {
	box.state.selfRing.length = 0;
	box.state.selfCount = 0;
	box.state.selfMax = 0;
	for (let i = 1; i <= 100; i += 1) box.recordSelf(i / 100);
	const stats = box.selfStats();
	return [stats.samples, stats.max, stats.p99 > 0 && stats.p99 <= 1];
})(), [100, 1, true]);
check('A1 自身开销:环形缓冲有上限(不会无限长)', (() => {
	box.state.selfRing.length = 0;
	for (let i = 0; i < box.SELF_RING + 50; i += 1) box.recordSelf(0.1);
	const length = box.state.selfRing.length;
	box.state.selfRing.length = 0;
	return length;
})(), 600);
check('取件:下标 0 是最差,latest 是时刻最新 —— 面板那个按钮以前导的是最差', (() => {
	const saved = watch.state.watch.incidents.slice();
	watch.state.watch.incidents.length = 0;
	watch.state.watch.incidents.push(
		{ id: 'i-old-worst', severity: 900, at: '2026-10-07T10:00:00.000Z', summary: {}, frames: [], loaf: [], longTasks: [], urls: [], env: {} },
		{ id: 'i-new-mild', severity: 120, at: '2026-10-07T18:00:00.000Z', summary: {}, frames: [], loaf: [], longTasks: [], urls: [], env: {} },
	);
	const picked = [watch.pickIncident(0).id, watch.pickIncident('latest').id, watch.pickIncident('i-new-mild').id, watch.pickIncident('不存在')];
	watch.state.watch.incidents.length = 0;
	for (const row of saved) watch.state.watch.incidents.push(row);
	return [picked[0], picked[1], picked[2], picked[3]];
})(), ['i-old-worst', 'i-new-mild', 'i-new-mild', undefined]);
check('事故包:URL 抽表后脚本里不再内联 url', watch.incidentReport(0).incident.loaf.every((row) => row.scripts.every((script) => script.url === undefined && typeof script.u === 'number')), true);
check('事故包:topScripts 也只留下标', watch.incidentReport(0).incident.summary.topScripts.every((script) => script.url === undefined), true);
// 身材回归:同一个长 URL 重复 20 次,抽表之后事故包不该被它撑大
const hugeUrl = `http://h/plugins/??${'p'.repeat(2000)}/client.js`;
watch.state.watch.loaf.length = 0;
for (let i = 0; i < 20; i += 1) {
	watch.state.watch.loaf.push({ t: 60000 + i, dur: 10, blocking: 10, renderStart: 0, styleAndLayoutStart: 0, scripts: [{ url: hugeUrl, fn: null, invoker: null, invokerType: 'event-listener', charPos: 1, ms: 5, forcedMs: 0, pauseMs: 0 }] });
}
watch.setNow(75000);
const big = watch.triggerCapture('frame', 70000, 200);
const inlineSize = JSON.stringify({ ...big, urls: undefined, loaf: big.loaf.map((row) => ({ ...row, scripts: row.scripts.map((script) => ({ ...script, url: big.urls[script.u] })) })) }).length;
check('事故:长 URL 重复 20 次只存一份', [big.urls.length, big.urls[0] === hugeUrl], [1, true]);
check('事故:抽表后体积不到内联的一半', JSON.stringify(big).length < inlineSize / 2, true);
check('事故包:kind 与 incident 对得上', [report.kind, report.plugin, report.incident.id === watch.state.watch.incidents[0].id], ['perf-hud-incident', 'dsh-perf-hud', true]);
check('事故包:带阈值与读取说明', [
	report.context.thresholds.triggerMs,
	report.context.howToRead.some((line) => line.includes('pkgVia')) && report.context.howToRead.length >= 9,
	report.context.page,
], [100, true, 'http://127.0.0.1:3080/']);
check('事故包:如实列出没拿到的东西',
	['precise:', 'devtools-trace:'].map((prefix) => report.context.missing.some((line) => line.startsWith(prefix))),
	[true, true]);
check('事故包:宿主只有陈旧快照时说清楚"别当宿主没问题的证据"', (() => {
	// 快照年龄 = perfOrigin + at - hostAt,所以把 hostAt 反推成"事故前 6224ms"
	watch.state.host = { eventLoop: { p99: 1.28 } };
	watch.state.hostAt = 1700000000000 + 110000 - 6224;
	watch.state.watch.coveredUntil = 0;
	watch.setNow(120000);
	const probe = watch.triggerCapture('frame', 110000, 200);
	const line = watch.incidentReport(probe.id).context.missing.find((text) => text.startsWith('host-cpuprofile:'));
	// 清掉这条探针,别影响后面的断言
	const index = watch.state.watch.incidents.findIndex((row) => row.id === probe.id);
	if (index !== -1) watch.state.watch.incidents.splice(index, 1);
	watch.state.watch.captured -= 1;
	watch.state.watch.coveredUntil = 0;
	watch.state.host = null;
	watch.state.hostAt = 0;
	return line !== undefined && line.includes('事故前 6224ms') && line.includes('未必覆盖');
})(), true);
check('事故包:宿主快照比事故更晚(负年龄)时说"事故后",不冒充"事故前"', (() => {
	watch.state.host = { eventLoop: { p99: 1 } };
	watch.state.hostAt = 1700000000000 + 110000 + 362;   // 事故之后 362ms 才采的快照
	watch.state.watch.coveredUntil = 0;
	watch.setNow(120000);
	const probe = watch.triggerCapture('frame', 110000, 200);
	const line = watch.incidentReport(probe.id).context.missing.find((text) => text.startsWith('host-cpuprofile:'));
	const index = watch.state.watch.incidents.findIndex((row) => row.id === probe.id);
	if (index !== -1) watch.state.watch.incidents.splice(index, 1);
	watch.state.watch.captured -= 1;
	watch.state.watch.coveredUntil = 0;
	watch.state.host = null;
	watch.state.hostAt = 0;
	return line.includes('事故**后** 362ms');
})(), true);
check('事故包:LoAF 装着但这帧没有脚本时,点明 scripts 为空', report.context.missing.some((line) => line.startsWith('loaf-scripts:')), true);
watch.state.watch.loafState = 'unsupported:no-long-animation-frame';
check('事故包:LoAF 没装时改成报 loaf 本身', watch.incidentReport(0).context.missing.some((line) => line.startsWith('loaf:')), true);
watch.state.watch.loafState = 'on';
watch.state.on = false;
check('事故包:没插桩时点明四条腿归因缺失', watch.incidentReport(0).context.missing.some((line) => line.startsWith('instrumentation:')), true);
check('事故包:缺失项都给了补齐办法', watch.incidentReport(0).context.howToAdd.length >= 2, true);
check('事故包:独立读者点出的三条缺口也列进 missing',
	['compositor:', 'recorder-cost:', 'baseline:'].map((prefix) => watch.incidentReport(0).context.missing.some((line) => line.startsWith(prefix))),
	[true, true, true]);
check('事故包:带上渲染环境(视口 / DPR / 核数)',
	[watch.incidentReport(0).incident.env.viewport, watch.incidentReport(0).incident.env.devicePixelRatio, watch.incidentReport(0).incident.env.hardwareConcurrency],
	['1600×900', 2, 10]);
check('事故包:宿主快照用一个有定义的口径(年龄,正数=更早)',
	typeof watch.incidentReport(0).incident.host === 'object', true);
check('会话基线:帧环为空时是 null,不编数字', watch.frameRing.reset() === undefined && watch.frameRing.stats(), null);
watch.state.on = true;

// 落盘:事故要活过刷新
check('落盘:写入后 localStorage 里有那份事故', [watch.saveIncidents(), watch.store.has('test:incidents')], [true, true]);
const persisted = JSON.parse(watch.store.get('test:incidents'));
check('落盘:带版本号与保存时间', [persisted.v, typeof persisted.savedAt], [1, 'number']);
const beforeClear = watch.state.watch.incidents.map((row) => ({ id: row.id, severity: row.severity }));
check('落盘:写的顺序与内存里一致', persisted.incidents.map((row) => row.id), beforeClear.map((row) => row.id));
watch.state.watch.incidents.length = 0;
watch.restoreIncidents();
check('读回:三份回来且顺序不变', watch.state.watch.incidents.map((row) => row.id), beforeClear.map((row) => row.id));
check('读回:严重度一字不差', watch.state.watch.incidents.map((row) => row.severity), beforeClear.map((row) => row.severity));
check('读回:标记 restored=true(跨会话的 perf 毫秒要按 env.perfOrigin 对齐)', watch.state.watch.incidents[0].restored, true);
check('读回:计数如实', watch.state.watch.restored, beforeClear.length);
watch.store.set('test:incidents', JSON.stringify({ v: 1, incidents: [{ id: 'bad', severity: 1 }, { id: 'ok', severity: 5, frames: [], loaf: [] }] }));
watch.state.watch.incidents.length = 0;
watch.restoreIncidents();
check('读回:形状不对的条目丢掉,合法的留下', watch.state.watch.incidents.map((row) => row.id), ['ok']);
watch.setFail(true);
check('落盘失败:不抛、返回 false、并记下原因', [watch.saveIncidents(), typeof watch.state.watch.persistError === 'string'], [false, true]);
watch.setFail(false);
watch.state.watch.persistError = null;
// 字节上限:两条里最弱的那条太大 → 丢掉它再写
watch.state.watch.incidents = [
	{ id: 'small', severity: 100, at: '2026-10-07T00:00:01.000Z', cause: 'frame', frames: [], loaf: [] },
	{ id: 'huge', severity: 50, at: '2026-10-07T00:00:02.000Z', cause: 'frame', frames: new Array(120000).fill({ t: 0, ms: 16, gap: false }), loaf: [] },   // ~3.2MB,真能超 2MB 上限
];
check('落盘:超过字节上限时丢掉最弱的再写', [watch.saveIncidents(), JSON.parse(watch.store.get('test:incidents')).incidents.map((row) => row.id)], [true, ['small']]);
check('落盘:内存里也按同一份裁掉(看到的 = 刷新后还在的)', watch.state.watch.incidents.map((row) => row.id), ['small']);
check('落盘:同一时刻同一原因的两条被去重(不占两个留存位)', (() => {
	watch.state.watch.deduped = 0;
	watch.state.watch.incidents = [
		{ id: 'a', severity: 10, at: '2026-10-07T00:00:09.000Z', cause: 'loaf', frames: [], loaf: [] },
		{ id: 'b', severity: 9, at: '2026-10-07T00:00:09.000Z', cause: 'loaf', frames: [], loaf: [] },
	];
	return [watch.saveIncidents(), watch.state.watch.incidents.map((row) => row.id), watch.state.watch.deduped];
})(), [true, ['a'], 1]);
check('落盘:缺少 at/cause 的条目不被当成重复吃掉', (() => {
	watch.state.watch.incidents = [{ id: 'x', severity: 5, frames: [], loaf: [] }, { id: 'y', severity: 4, frames: [], loaf: [] }];
	return [watch.saveIncidents(), JSON.parse(watch.store.get('test:incidents')).incidents.map((row) => row.id)];
})(), [true, ['x', 'y']]);
check('落盘:裁掉几条单独计数,不混进 dropped', [watch.state.watch.trimmedByBytes, watch.state.watch.dropped], [1, 0]);
check('守夜行:裁过就写出来', watch.watchPanelText().includes('裁掉 1'), true);
watch.state.watch.trimmedByBytes = 0;
watch.state.watch.incidents.length = 0;
check('落盘:清空后落盘的那份也是空的', [watch.saveIncidents(), JSON.parse(watch.store.get('test:incidents')).incidents.length], [true, 0]);

console.log(failed === 0 ? 'ALL PASS' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
