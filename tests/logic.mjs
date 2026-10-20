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
// 诊断 / 视图模型的实现在包内分片里(主文件只剩同名同步包装):extract 先找分片,
// 找不到再回主文件 —— 这样箱子测的仍然是线上那份实现,而不是包装器。
const modelSource = readFileSync(new URL('../client.model.js', import.meta.url), 'utf8');
// 词典在 client.i18n.js 分片里(纯数据)。
const i18nSource = readFileSync(new URL('../client.i18n.js', import.meta.url), 'utf8');
// 守夜层实现在 client.watch.js 分片里(与下面那个 watchSource 常量片段区分开)。
const watchChunkSource = readFileSync(new URL('../client.watch.js', import.meta.url), 'utf8');
// 渲染层在包内分片 client.ui.js 里;静态检查与渲染区断言要扫两份源码。
const uiSource = readFileSync(new URL('../client.ui.js', import.meta.url), 'utf8');
const renderSource = source + '\n' + uiSource;
// 主文件 + 分片:静态检查要能看见搬家之后的实现
const allSource = source + '\n' + uiSource + '\n' + modelSource + '\n' + i18nSource + '\n' + watchChunkSource;
// 包内分片:zip 在 client.pack.js 里。测试也读线上那份源码,不另写一份实现。
const packSource = readFileSync(new URL('../client.pack.js', import.meta.url), 'utf8');
function loadPackChunk() {
	let definition = null;
	const fakeWindow = { __ModuleLoader__: { load: (value) => { definition = value; } } };
	new Function('window', packSource)(fakeWindow);
	if (definition === null) throw new Error('client.pack.js 没有注册分片');
	return definition.factory(() => { throw new Error('client.pack.js 不需要 require'); });
}
const packChunk = loadPackChunk();
// 一份**真的**事故切片(真页面手动 capture → report() → 脱敏后落盘),不是合成的形状;
// 用来钉住"文件格式与真实数据对得上",而不是只测我们想象出来的字段。
const realFixture = JSON.parse(readFileSync(new URL('./fixtures/incident-real.json', import.meta.url), 'utf8'));

/**
 * 按 header 抽出"从 header 起到配对右括号"的源码;识别字符串/模板串与行注释。
 * ⚠️ 诊断 / 视图模型搬进 client.model.js 之后,主文件里同名的是同步包装器 ——
 * 所以**分片优先**:同一个 header 在分片里能找到就抽分片那份,否则回主文件。
 */
function extract(text, header) {
	const inModel = text === source && modelSource.indexOf(header) !== -1;
	const inI18n = text === source && !inModel && i18nSource.indexOf(header) !== -1;
	const inWatch = text === source && !inModel && !inI18n && watchChunkSource.indexOf(header) !== -1;
	const body = inModel ? modelSource : (inI18n ? i18nSource : (inWatch ? watchChunkSource : text));
	const start = inModel ? modelSource.indexOf(header) : (inI18n ? i18nSource.indexOf(header) : (inWatch ? watchChunkSource.indexOf(header) : text.indexOf(header)));
	if (start === -1) throw new Error(`extract: missing ${header}`);
	let depth = 0;
	let quote = null;
	for (let i = body.indexOf('{', start); i < body.length; i += 1) {
		const c = body[i];
		if (quote !== null) {
			if (c === '\\') i += 1;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
		if (c === '/' && body[i + 1] === '/') { while (i < body.length && body[i] !== '\n') i += 1; continue; }
		if (c === '{') depth += 1;
		else if (c === '}') {
			depth -= 1;
			if (depth === 0) return body.slice(start, i + 1);
		}
	}
	throw new Error(`extract: unbalanced ${header}`);
}

/**
 * 按 header 取**整行**(单行常量用)。
 * 为什么需要它:`extract()` 找的是 header 之后的第一个 `{` 并做括号配对,对
 * `const SECRET_PARAM_NAMES = [...];` 这种没有块的常量会一路找到文件后面某个 `{`,
 * 抽出一大段无关代码(不报错,只是沙箱里多了一堆垃圾)。
 */
const line = (header) => {
	const at = source.indexOf(header);
	if (at === -1) throw new Error(`line: missing ${header}`);
	return source.slice(at, source.indexOf('\n', at));
};

const pluginUrl = source.slice(source.indexOf('const PLUGIN_URL'),
	source.indexOf('\n', source.indexOf('const PLUGIN_URL')),
);

const pieces = [
	pluginUrl,
	// 单行常量(没有块)走 line():extract 会一路找到文件后面某个 '{'。
	// 视图模型的两条窗口常量排在 state 之前 —— state 里就用到它们(TDZ)。
	'const TALLY_TREND_SHORT_MS = ',
	'const TALLY_TREND_LONG_MS = ',
	'const state = {',
	'function isCore(',
	'function ownerOfUrl(',
	'function rate(',
	'function updateRates(',
	'function pluginTable(',
	'function round1(',
	'function worstSecond(',
	'function blame(',
].map((header) => (header.startsWith('const ') && header.endsWith('{') === false
	? line(header)
	: extract(source, header))).join('\n');

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
	for (const text of [source, uiSource]) for (const pattern of [/\bfunction\s+([A-Za-z_$][\w$]*)/g, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, /\bclass\s+([A-Za-z_$][\w$]*)/g]) {
		for (const match of text.matchAll(pattern)) declared.add(match[1]);
	}
	// 解构声明:const [open, setOpen] = / const { a, b } =
	for (const match of renderSource.matchAll(/\b(?:const|let|var)\s*[[{]([^\]}]*)[\]}]/g)) {
		for (const part of match[1].split(',')) {
			const name = part.split(':').pop().trim().replace(/^\s*\.\.\./, '');
			if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
		}
	}
	const GLOBALS = new Set(['Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Error', 'Set', 'Map', 'WeakMap', 'Promise', 'Symbol', 'BigInt', 'Reflect', 'Proxy', 'RegExp', 'Function', 'Intl', 'fetch', 'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'document', 'window', 'location', 'localStorage', 'navigator', 'console', 'URL', 'Blob', 'Response', 'Request', 'Headers', 'Node', 'Element', 'MutationObserver', 'PerformanceObserver', 'parseInt', 'parseFloat', 'isFinite', 'isNaN', 'require', 'super', 'globalThis', 'structuredClone', 'queueMicrotask', 'TextEncoder', 'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await', 'of', 'in', 'function', 'delete', 'void', 'do', 'else', 'case', 'throw', 'yield', 'get', 'set', 'async']);

	// 样式字符串里的 CSS 函数(var(--x)/rgba(...))不是 JS 调用。`not` 也是 CSS 伪类函数:
	// 面板的 `installStyle()` 里有一条 `button:hover:not(:disabled)`。
	const CSS_FUNCS = new Set(['var', 'rgb', 'rgba', 'hsl', 'hsla', 'calc', 'clamp', 'minmax', 'color-mix', 'linear-gradient', 'radial-gradient', 'url', 'not']);
	const components = [...new Set([...renderSource.matchAll(/\bh\(\s*([A-Z][\w$]*)/g)].map((m) => m[1]))];
	check('h() 引用的组件都声明了(PerfHudStress 事故回归)',
		components.filter((name) => !declared.has(name)), []);

	// clear() 漏清帧环的回归:清了之后「窗口:… 跨 …」纹丝不动(实测被问"我清了怎么还是跨 3 分")
	check('clear() 也要清帧环(它也是读数)',
		/clear\(\) \{[\s\S]{0,600}?watch\.loaf\.length = 0/.test(source), true);
	const renderRegion = renderSource.slice(renderSource.indexOf('function PerfHud('));
	// 单/双引号字符串里的内容不是 JS 调用(SVG/CSS 的 `transform: 'rotate(-90 24 24)'` 就是典型);
	// 模板字符串**要留着** —— `${t('x')}` 里的调用是真调用,不能一起丢掉。
	const renderCode = renderRegion
		.replace(/'(?:[^'\\]|\\.)*'/g, "''")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""');
	// ⚠️ 前瞻里要排掉 `-`:否则 `linear-gradient(` 会被当成裸调用 `gradient(`(CSS 函数名带连字符,
	// 而它不是 JS 调用)。CSS_FUNCS 白名单只管前缀,补上连字符才算真的对齐意图。
	const bare = [...new Set([...renderCode.matchAll(/(?<![.\w$-])([a-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))];
	check('面板渲染区的函数调用都有声明(signed 事故回归)',
		bare.filter((name) => !declared.has(name) && !GLOBALS.has(name) && !CSS_FUNCS.has(name)), []);

	// 「技术细节」整块被降级成一行红字的事故回归(2026-10-19):shellNote 曾被定义在**模块
	// 作用域**,却用了 `scriptBreakdownRows` 的局部别名 `t(...)` —— 三套件全绿(测的是纯函数)、
	// 静态检查也不响(它是个变量引用,不是未声明的函数),真页面一展开那一组就 ReferenceError,
	// 整块脚本拆解被降级成一行红字。修法:把它改成 `scriptBreakdownRows` 里的内嵌闭包。
	// 这条断言钉住那个结构 —— 一旦有人再把它挪回模块作用域,先响的就是它。
	check('shellNote 是 scriptBreakdownRows 的内嵌闭包(拿得到局部 t;shellNote 事故回归)', (() => {
		const at = renderSource.indexOf('const shellNote = (tally, key) =>');
		const owner = renderSource.lastIndexOf('function scriptBreakdownRows(', at);
		const ownEnd = renderSource.indexOf('\n\t\t}', owner);
		return [at > 0, owner > 0 && owner < at, at < ownEnd];
	})(), [true, true, true]);


	// HUD 自己的 DOM 写入必须不记账(实测摘要里出现过 (PerfHud) 顶在第一名)
	check('DOM 写入插桩排除本 HUD 自身', /if \(owner === PKG\)/.test(source), true);

	// 导出里必须有错误账本(下次再抛错,导出件能带出原文)
	check('client.js 带 errors 导出段', /errors:\s*state\.errors/.test(allSource), true);

	// 导出件的审计属性:文件离开现场后,读的人要能判断"这份证据被裁过没有"
	const storeBlock = /store:\s*\{([\s\S]{0,500}?)\n\t{5}\}/.exec(allSource);
	check('client.js 导出件带 store 段(restored/trimmedByBytes/deduped/captured/dropped)',
		storeBlock !== null && ['restored', 'trimmedByBytes', 'deduped', 'captured', 'dropped'].every((key) => storeBlock[1].includes(`${key}:`)),
		true);

	// D2:面板的 60 秒帧条与导出件的 ASCII 条带**必须**用同一组阈值 —— 两处读数打架比没有还糟
	const inspector = readFileSync(new URL('../tools/inspect-incident.mjs', import.meta.url), 'utf8');
	check('D2:帧条与导出件 ASCII 条带同一组阈值(>=100ms / >=50ms)',
		[/ms >= 100\) return '█'/, /ms >= 50\) return '▒'/].every((re) => re.test(inspector))
		&& [/ms >= 100\) return 'bad'/, /ms >= 50\) return 'warn'/, /if \(cell\.seen === true\)/].every((re) => re.test(allSource)), true);

	// A2:跨会话基线是"只进导出件"的 —— 两个导出件都要带,面板一个字都不显示
	check('A2:整机导出件与事故包都带跨会话基线',
		(allSource.match(/sessionBaselines: sessionBaselines\(\)/g) ?? []).length, 2);
	// README 承诺过 `__perfHud.marks()`(撤面板入口时给标记清单留的出口);没有它那句文档就是假的
	check('控制台 API 暴露 marks 只读 getter(与 README「控制台 API」那一行对齐)',
		/marks: \(\) => state\.marks/.test(source), true);
	// 快捷键:可选注入(服务不在也不影响加载);Linux Web 不支持这个组合,不硬塞默认绑定
	check('快捷键走 ctx.shortcuts 可选注入,只声明 macOS / Windows 的默认绑定',
		/ctx\.inject\(\['shortcuts'\]/.test(source) && /state\.toggleHud = toggle/.test(renderSource)
		&& /'web:macos': \{ code: 'KeyU'/.test(source) && /'web:linux'/.test(source) === false, true);

	// P0-1:任何 fetch 都必须带 signal(或经 fetchTextWithin / fetchJsonWithin)。
	// 只对代码行做检查:注释里的 `fetch()` 不是调用;helper 自己那一处带 signal: controller.signal。
	{
		const codeOnly = source.split('\n').filter((line) => {
			const text = line.trim();
			return text.startsWith('//') === false && text.startsWith('*') === false && text.startsWith('/*') === false;
		}).join('\n');
		const missing = [];
		for (const match of codeOnly.matchAll(/(?<![.\w$])fetch\s*\(/g)) {
			if (/\bsignal\s*:/.test(codeOnly.slice(match.index, match.index + 320)) === false) missing.push(match.index);
		}
		check('所有 fetch 都带 signal 或经有 deadline 的 helper', missing, []);
	}
	// P1:map 缓存写入必须走 saveMapCache(配额失败会先淘汰最旧 rev),不许直接 setItem
	check('map 缓存写入走 saveMapCache(配额淘汰有入口)',
		/saveMapCache\(entry\.storageKey/.test(allSource) && /localStorage\.setItem\(entry\.storageKey/.test(allSource) === false, true);
	// D5:面板的二级拆分与导出件必须吃同一份字段(否则"按包"两边会算出不同答案)
	check('D5:面板二级与导出件用同一份字段(packageOfScript(url,charPos) 与 forcedMs)',
		/packageOfScript\(script\.url, script\.charPos\)/.test(allSource)
		&& /forcedMs: script\.forcedMs/.test(allSource)
		&& /forced \+= script\.forcedMs \?\? 0/.test(allSource), true);

	// REVIEW §3.4 的债已还:那条"永远渲染不到"的分支连同它的函数一起删了(别只删文档)
	check('REVIEW §3.4:不可达的 pkgZeroText 分支已删除(不留死代码)', /\bpkgZeroText\b/.test(source), false);

	// P1:三处悬停联动**整体停用**,而且辅助代码已删 —— 这条钉住"没有人悄悄把 per-element
	// 鼠标状态加回渲染里"。历史:2026-10-08 指到交叉表行标签会让外壳停用整个条目(面板消失、
	// `errors` 为空),2026-10-11 在当前代码上**复现不出来**(163 个元素真实鼠标 + 153 次 JS
	// 派发 mouseover 全程存活),所以保持停用 + 清理,而不是赌它能用。
	{
		const render = renderSource.slice(renderSource.indexOf('function PerfHud('));
		check('P1:渲染区没有 per-element 鼠标状态(onMouseEnter/Leave)', /onMouse(?:Enter|Leave)/.test(render), false);
		check('P1:悬停联动那套辅助代码已删除(hotProps / hotStyle / setHot 不再有定义或调用)',
			[/\bhotProps\s*\(/, /\bhotStyle\s*\(/, /\bsetHot\s*\(/].some((re) => re.test(source)), false);
		check('P1:停用理由写在渲染区里,并点明去外壳日志里 grep 什么(它不经过我们的 HudBoundary)',
			render.includes('slot entry crashed'), true);
	}

	// ── 本轮:取证明细的**双上下文隔离**(结构性的,不是靠人记性)──────────────────
	// 诊断上下文只在 detailContext() 一处分流,渲染那侧只读它的返回值 —— 这条断言钉住"没有第二处
	// 偷偷去拿实时帧"的可能(那正是这次要修的病:上面历史事故、下面另一条实时帧的编号与饼图)。
	check('取证明细:上下文只在 detailContext 一处分流(渲染只读 detail.kind)',
		/const detail = detailContext\(\);/.test(renderSource) && /detail\.kind === 'incident'/.test(renderSource), true);
	{
		const incidentDetailText = extract(renderSource, 'function incidentDetail(');
		const leaks = ['pickedLoaf(', 'scriptPkgTally(', 'framePkgTally(', 'worstSecond(', 'recorderText(', 'unexplainedFrame(', 'frameRing']
			.filter((needle) => incidentDetailText.includes(needle));
		check('取证明细:历史事故那一支不出现任何实时读数(pickedLoaf / 窗口聚合 / 记录器 / 帧环)', leaks, []);
	}
	{
		// 新加的那几个渲染辅助函数定义在 `function PerfHud(` **之前**,所以旧的"渲染区裸调用"静态检查
		// 盖不到它们 —— 这里对它们单独跑同一条分析(docs/dead-ends.md 第 7 条那类事故的回归)。
		const helpers = ['function contextBar(', 'function ringBlock(', 'function scriptBreakdownRows(', 'function evidenceBlock(',
			'function crossBlock(', 'function liveFramePickRow(', 'function timelineBlock(', 'function longTaskBlock(',
			'function verdictBlock(', 'function techGroup(', 'function techSummary(', 'function incidentDetail(', 'function liveDetail(',
			// 方案 1 的视图函数(同样定义在 `function PerfHud(` 之前)
			'function mainView(', 'function settingsView(', 'function devTabRow('];
		const text = helpers.map((header) => extract(renderSource, header)).join('\n');
		const code = text.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
		const bare = [...new Set([...code.matchAll(/(?<![.\w$-])([a-z_$][\w$]*)\s*\(/g)].map((match) => match[1]))];
		check('取证明细的渲染辅助函数里没有未声明的裸调用(与渲染区同一条规矩)',
			bare.filter((name) => !declared.has(name) && !GLOBALS.has(name) && !CSS_FUNCS.has(name)), []);
	}

	// ── 头部工具条:一行永不换行、显式分组、只有标题可以让位 ─────────────────────
	// 回归的是这个 bug:工具条里每个元素都是 `flex: 0 0 auto`(§5「标签不收缩」原本是给**数据行**
	// 写的规则),宽度一超,浏览器就按 DOM 顺序把尾部三个控件丢到第二行、还左对齐 —— 于是它们看着
	// 像下面那一块的按钮。主界面一行放得下、卡顿详情放不下,所以"两个头部的按钮位置关系不一样",
	// 而它们本来是同一类全局控件。
	{
		const headLine = line('head: {');
		const brandLine = line('brand: {');
		const headAt = renderSource.indexOf("const head = h('div'");
		const headEnd = renderSource.indexOf('if (open === false) {', headAt);
		const headBlock = headAt === -1 || headEnd === -1 ? '' : renderSource.slice(headAt, headEnd);
		check('头部一行永不换行,且显式分成左右两组(不再靠某个元素上的 margin-left:auto 假装分组)',
			[/wrap/.test(headLine), /S\.headLeft/.test(headBlock), /S\.headRight/.test(headBlock), /marginLeft: 'auto'/.test(headBlock)],
			[false, true, true, false]);
		check('头部只有标题可以让位(min-width:0 + ellipsis + nowrap),控件永远留在第一行',
			[/minWidth: 0/.test(brandLine), /textOverflow: 'ellipsis'/.test(brandLine), /whiteSpace: 'nowrap'/.test(brandLine)],
			[true, true, true]);
		check('头部按钮预算 ≤4 个(返回 / 设置 / 收起 / 关闭 —— 任何视图都一样)',
			(headBlock.match(/h\('button'/g) ?? []).length <= 4, true);
		check('「深录」不进标题栏(它在开发者详情的标签页行与设置页;标题栏是不可换行的那一行)',
			[/deepShort/.test(headBlock), /deepShort/.test(extract(renderSource, 'function devTabRow('))], [false, true]);
		check('头部"文字让位、控件不让位":标题与场景标签都可省略(场景那一格 flex 从 0 0 auto 改成可收缩)',
			[/(?:\.\.\.S\.label)[^)]*flex: '0 1 auto'/.test(headBlock), /textOverflow: 'ellipsis'/.test(headBlock)], [true, true]);
		check('子页标题不再拼品牌名(品牌名进悬停;标题与下面那行上下文标题不再重复说"我在哪")',
			[/t\('title'\)\} · /.test(headBlock)], [false]);
	}

	// A4:交互延迟这一层"只进导出件",而且必须两个导出件都带(事故包只带窗口内的)
	check('A4:交互延迟进两个导出件(事故包按窗口过滤)',
		[/interactionsInWindow: interactions\.length/, /const interactions = \(state\.watch\.interactions \?\? \[\]\)\.filter/, /records: state\.watch\.interactions,/].every((re) => re.test(allSource)), true);
	check('A4:交互延迟不进面板渲染区(只进导出件)',
		renderSource.slice(renderSource.indexOf('function PerfHud(')).includes('interactions'), false);
}

// ═══════════════ A/B/C/D/E 新增逻辑的离线验证 ═══════════════
// 第二个沙箱:把新函数连同它们依赖的最小环境一起装进去。
const sandbox = `
	const location = { origin: 'http://127.0.0.1:3080', href: 'http://127.0.0.1:3080/session/x' };
	const W = { __DSH_BOOT__: undefined, setTimeout: (fn, ms) => setTimeout(fn, ms) };
	const navigator = { userAgent: 'test-agent' };
	const PKG = 'dsh-perf-hud';
	let streamingFlag = false;
	// 解析推进计数(sourcemap/脚本文本异步到位):窗口聚合的缓存指纹带它,沙箱里给个可推进的桩
	let resolveSeq = 0;
	const resolveStamp = () => resolveSeq;
	const markResolved = () => { resolveSeq += 1; };
	const document = { documentElement: {}, querySelector: () => (streamingFlag ? {} : null) };
	const localStorage = { store: new Map(), getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }, setItem(k, v) { this.store.set(String(k), String(v)); } };
	const natives = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id), setInterval: () => 0, clearInterval: () => {} };
	// A2 的跨会话基线要吃帧环:这个盒子里不测帧环(有专门的盒子),给个"一帧都没有"的桩
	const frameRing = { size: 0, stats: () => null };
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
		recorder: '记录器自身',
		via: '通道', viaRemote: 'ctx.remote(客户端 remote)', viaRoute: '宿主路由 /api/dsh-perf-hud/host',
		watch: '守夜', watchCaught: '抓到', watchWorst: '最差', watchRestored: '读回', watchOff: '未开录', watchNone: '还没抓到', watchPersistFailed: '落盘失败', watchManualNote: '手动标记', domWritesShort: 'DOM 写入',
		watchDetected: '检测', watchKept: '已保存现场', watchLost: '丢失', tallyUnit: ' 份',
		// P0/P1:严重度必须是**文字**(不能只靠颜色)+ 「最差事件」块那三行的口径词
		sevBad: '严重', sevWarn: '警告', sevOk: '低于线', sevLabel: '严重度',
		ctxLive: '实时监控', ctxFrame: '当前帧', ctxIncident: '历史事故', ctxHistoryFrame: '历史帧',
		groupDetail: '取证明细', groupTech: '技术细节',
		// 摘要那几条断言量的是**人看到的字**:这里给真串,长度才对得上(不然量的是 key)
		splitScript: '脚本', techFrameNoneShort: '这一帧没有记录',
		jsEvidence: 'JS 证据', jsYes: '有(longtask/LoAF 与它重叠)', jsNo: '无(longtask/LoAF 都不与它重叠)',
		// 归因状态三档(§五):文字 + 档位色两样一起给
		verdictLabel: '归因状态', verdictConfirmed: '已确认', verdictSuspected: '可疑', verdictUnattributed: '未归因',
		verdictConfirmedText: '该帧有直接测量到的 JS 阻塞证据(longtask / LoAF 与它重叠),窗口内主要归属',
		verdictNotRootCause: '这只缩小到"哪个包",不等于已定位根因',
		verdictSuspectedJsNoPkg: '有 JS 阻塞证据,但窗口里的脚本没能定到包名',
		verdictThrottleText: '没有观察到足以解释该帧的 JS 阻塞,而它又明显长于前后帧:更像 rAF 被挂起或浏览器节流,需结合前后帧与时间间隙确认',
		verdictNeighbours: '前后帧中位', verdictGap: '这一帧', verdictGapJs: '与它重叠的 JS 观测为 0ms',
		verdictUnattributedText: '未观察到足以解释该帧的 JS 阻塞证据;请结合前后帧和时间间隙检查 rAF 挂起或浏览器节流',
		handoffFrameNoEvidence: '这一帧在事故包里没有脚本记录(只有帧间隔)',
		evOwner: '主要归属', evWindow: '窗口', framesUnit: ' 帧', byPkg: '按包',
		copied: '已复制', copyFailed: '复制失败', copyNoApi: '这个环境没有剪贴板 API',
		// 证据 → 代码(面板与交接件共用):这几个词条要给人看,不能只回 key
		evidenceLabel: '可疑脚本', evidenceInvoker: '来源', fnUnknown: '函数名未记录',
		pkgUnresolvedShort: '包未定名', fileUnresolved: '文件未定名',
		viaDirect: '直接读出来', viaInferred: '分段推断', viaNotPlugin: '不是插件脚本', viaFailed: '解析失败', viaUnavailable: '还没到位/拿不到',
		evidenceCaliberPlain: '口径:函数名与毫秒由 LoAF 直接测量;包 / 文件 / 行号由 URL 与 sourcemap 分段推断。',
		evidenceMissingPlain: '缺:原始源码行号与调用栈。',
		handoffInteractions: '窗口内 ≥100ms 的交互', handoffInteractionsScope: '(端到端时长,不是帧内拆分)',
		maxLabel: '最大', pickNone: '这条事故包里没有帧记录(老包或捕获时没采到):只能看窗口统计,不能逐帧回看',
		viaNotFetched: '还没预取(只有深录才拉脚本文本)', evidenceBundleLine: '合并脚本行',
		evidenceUnlocatable: '未定位', evidenceUnlocatableHint: '没有定位字段:函数名与包名都没有,别把它当线索',
		shellNote: '最大一块来自应用外壳(不是插件)', shellNoteHint: '外壳 bundle 不属于任何插件',
		watchTrimmed: '裁掉',
		// 视图模型 / 主界面
		healthOk: '运行流畅', healthStall: '刚才有卡顿', healthLimited: '监测受限', hudOff: 'HUD 已关闭', loafOff: 'LoAF 未装上',
		causePlainScript: '某个脚本模块的耗时偏高', causePlainLongTask: '这一段时间里有较重的渲染任务', causePlainHost: '宿主进程那侧偏忙', causePlainUnknown: '缺少能解释这次停顿的 JS 证据',
		causeWhy: '为什么这样判断?', causeWhyHide: '收起', causeRawNote: '以下是原始证据',
		exportAiBtn: '导出诊断包(给 AI)', exportFullBtn: '完整技术导出(保留备注)',
		previewTitle: '导出预览(还没生成文件)', previewFiles: '文件', previewNotesDropped: '备注:已置空', previewNotesKept: '备注:保留', previewZip: '分别下载', previewGo: '生成并导出', previewCancel: '取消', previewExcludes: '本包不含',
		stallSaved: '现场已自动保存', stallNotSaved: '现场未完整保存', secondsUnit: ' 秒',
		stallSuffix: '卡顿', trendNone: '这段时间没有检测到卡顿', trendRepeat: '重复线索', tallyWorst: '最长一次',
		trendRepeatPlain: '同一个脚本模块',
		times: ' 次', watchKept: '已保存现场', watchLost: '丢失', tallyUnit: ' 份',
		// 可能原因 / 能力矩阵 / 诊断包:断言要看真词
		causeScriptLead: '脚本耗时最高的包', causeLongTaskLead: '长任务归属', causeHostLead: '宿主事件循环', causeNoEvidenceLead: '缺少 JS 阻塞证据',
		causePlainScript: '某个脚本模块的耗时偏高', causePlainLongTask: '这一段时间里有较重的渲染任务', causePlainHost: '宿主进程那侧偏忙', causePlainUnknown: '缺少能解释这次停顿的 JS 证据',
		causeWhy: '为什么这样判断?', causeWhyHide: '收起', causeRawNote: '以下是原始证据',
		exportAiBtn: '导出诊断包(给 AI)', exportFullBtn: '完整技术导出(保留备注)',
		previewTitle: '导出预览(还没生成文件)', previewFiles: '文件', previewNotesDropped: '备注:已置空', previewNotesKept: '备注:保留', previewZip: '分别下载', previewGo: '生成并导出', previewCancel: '取消', previewExcludes: '本包不含',
		causeUnresolvedSuffix: '没定到包名', causeHostBasis: '事故前后的宿主事件循环', hostSnapshotNotInstant: '这份宿主快照每 10 秒采一次',
		causeLongTaskLimit: '四条腿只覆盖三次调度的回调与 DOM 写入,事件处理器 / Promise / 微任务不在内(所以这是下界)',
		causeWindowOnly: '这是窗口内累计,与这一帧没有时间重叠 —— 解释不了这一帧',
		strengthStrong: '线索较强', strengthMedium: '线索中等', strengthWeak: '线索较弱', strengthNone: '证据不足',
		provenanceMeasured: '直接测量', provenanceInferred: '归因推断', provenanceUnknown: '无法确认',
		pkgNamed: '定到包', scriptsUnit: '条脚本', maxLabel: '最大', hostShort: '宿主', cumulative: '累计', blame: '回调归因(耗时·下界)',
		packSummaryTitle: '# 性能事故诊断摘要', packSecSummary: '## 1. 摘要', integrityIncomplete: '现场不完整',
		packSecCandidates: '## 2. 最可能的假设(最多 3 条,每条都带支持与限制)', packSecMissing: '## 3. 缺失的证据',
		packSecNext: '## 4. 下一步验证', packSecMeta: '## 5. 元信息',
		packCauseLabel: '假设', packSupport: '支持', packLimits: '限制', packProvenance: '出处', packTier: '采集档位',
		packNoCandidate: '没有足够证据给出候选原因。', packPreviewNote: '导出前先看这份清单。',
		none: '无', notApplicable: '不适用(窗口含流式)', unattrShort: '未归因', needDeep: '要深录', perSec: '/s', peak: '峰', legSubtree: '子树', legDom: 'DOM写入', perMin: '/分', nodesSuffix: ' 节点', messages: '消息区', hostShort: '宿主', hostDown: '宿主不可用', hostUnsupported: '宿主未采到', hostWarming: '等宿主样本', hostUnknown: '宿主数据不足', hostStale: '已过期', isolation: '隔离实验', marks: '场景标记', domWrites: 'DOM 写入(按插件)', worstSecondShort: '最差秒', overviewFrame: '帧', overviewBlame: '归属', maxBlame: '最多', hit: '命中', times: ' 次', cumulative: '累计', restHint: '其余 = 除 Top3 之外的归属方合计', linkShort: 'RTT', suspectSuffix: ' 存疑', cleared: '链路已排除(宿主与隧道均正常)', streaming: '流式', running: '流式', idle: '空闲',
	})[key] ?? key;
	const experiment = { phase: 'idle', startedAt: 0, results: [], candidates: [], candidateState: [], restored: null, baseline: null, message: '', via: null };
	const TARGETS = [
		{ id: 'sessions', label: () => '会话列表', find: () => null },
		{ id: 'messages', label: () => '消息区', find: () => null },
	];
`;
const newPieces = [
	// 视图模型的三条常量:state 里就用到,必须排在 state 之前(否则运行到 state 就 TDZ)
	'const LS_VIEW = ',
	'const TALLY_TREND_SHORT_MS = ',
	'const TALLY_TREND_LONG_MS = ',
	'const state = {',
	'function round1(',
	'function pluginTable(',
	'const PANEL_WIDTH = ',
	'const MIN_PANEL_WIDTH = ',
	'const PILL_COMPACT_BELOW = ',
	'function hudDodge(',
	'function panelWidthFor(',
	'function pillCompact(',
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
	'function sectionSource(',
	'function sectionIndex(',
	'function sectionPath(',
	'function scriptPosition(',
	'function viaText(',
	'function scriptEvidence(',
	'function evidenceName(',
	'function evidenceLocatable(',
	'function evidencePlace(',
	'function evidenceLine(',
	'function incidentScriptEvidence(',
	'function incidentEvidenceAt(',
	'function evidenceWhereText(',
	'function incidentEvidenceLines(',
	'const EVIDENCE_MAX = ',
	'function bundleMetaOf(',
	'function bundleLabel(',
	'const WATCH_INCIDENT_MAX = ',
	'const WATCH_TRIGGER_MS = ',
	'const PICK_MIN_MS = ',
	'const WATCH_PRE_MS = ',
	'const WATCH_POST_MS = ',
	'const WATCH_DAILY_DAYS = ',
	'const WATCH_KEEP_MAX = ',
	'function keepIncident(',
	'function dayKeyOf(',
	'function pruneIncidents(',
	'const PLUGIN_URL = ',
	'function ownerOfUrl(',
	'function sectionOwner(',
	'function bundleMap(',
	'const SELF_RING = ',
	'function recordSelf(',
	'function selfStats(',
	'function recorderText(',
	'const LS_MAP = ',
	'const LS_MAP_INDEX = ',
	'const MAP_CACHE_MAX = ',
	'function readMapIndex(',
	'function writeMapIndex(',
	'function pruneMapIndex(',
	'function evictMapEntries(',
	'function touchMapCache(',
	'function saveMapCache(',
	'function pruneMapCache(',
	'const FETCH_TIMEOUT_MS = ',
	'function timeoutError(',
	'function cancelledError(',
	'function isAbortError(',
	'function fetchFailureText(',
	'async function fetchTextWithin(',
	'async function fetchJsonWithin(',
	'const LS_SESSIONS = ',
	'const SESSION_KEEP = ',
	'const DICT = {',
	'function docLang(',
	'function fallback(',
	'const WATCH_EVENT_MS = ',
	'function sessionRecord(',
	'function readSessionBaselines(',
	'function mergeSessionBaseline(',
	'function saveSessionBaseline(',
	'function sessionBaselines(',
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
	'function linkRowText(',
	'function throughputText(',
	'function suspectLink(',
	'function experimentDelta(',
	'function noiseFloor(',
	'function significance(',
	'const LS_GROUPS = ',
	'const HOST_ROUTE = ',
	'const RTT_INTERVAL_MS = ',
	'const HOST_STALE_MS = ',
	'const TOP_N = ',
	'const CROSS_SUMMARY_NAME_MAX = ',
	'const CROSS_SUMMARY_SRC_MAX ',
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
	'const SELF_NAMES = ',
	'function isRecorderName(',
	'function blameName(',
	'function primaryBlame(',
	'function legOf(',
	'function applyLongTaskStats(',
	'function longTaskTally(',
	'function blameText(',
	'function overviewLine1(',
	'function overviewLine2(',
	'function unattrText(',
	'function detailSummary(',
	'function techSummary(',
	'function domSummary(',
	'function displayKey(',
	'function bump(',
	'function infraVerdict(',
	'function sceneChip(',
	'function unexplainedFrame(',
	'function frameLevel(',
	'function levelFrame(',
	'function hostFreshness(',
	'function hostSummary(',
	'function hostLoopText(',
	'function hostLoopStateText(',
	'function toolsSummary(',
	// P0/P1:事故选中上下文 + 「最差事件」入口 + 布局动作(严重度必须文字与颜色两样都给)
	'function pickIncident(',
	'function saveGroups(',
	'function collapseAll(',
	'function resetLayout(',
	'function anyGroupOpen(',
	'function layoutDirty(',
	'function severityLevel(',
	'function severityText(',
	'function severityColor(',
	'function incidentOwner(',
	'function selectedIncident(',
	'function selectIncident(',
	'function setIncidentScope(',
	'const LS_WATCHUI = ',
	'function saveWatchUI(',
	'function restoreWatchUI(',
	'function diagMode(',
	'function incidentFrameRows(',
	'function incidentLoafAt(',
	'function incidentWorstFrame(',
	'function selectedIncidentFrame(',
	'function incidentFrameLevel(',
	'function incidentFrameHot(',
	'function incidentFrameNav(',
	'function selectIncidentFrame(',
	'function incidentFrameStep(',
	'function setOnlyBad(',
	'function showLiveMode(',
	'function incidentVerdict(',
	'function verdictColor(',
	'function eventVerdictText(',
	'function incidentWallClock(',
	'function replayColumns(',
	'function replayCellTitle(',
	'function incidentScriptOf(',
	'function incidentFrameTally(',
	'const incidentTallyCache = ',
	'function incidentWindowTally(',
	'function incidentFrameEvidenceRows(',
	'function incidentLongTasksAt(',
	'function incidentFrameHeadingText(',
	'function liveFrameHeadingText(',
	'function detailContext(',
	'function detailGroupLabel(',
	'function revealIncident(',
	'function eventEvidenceText(',
	'function eventWindowText(',
	'function incidentSummaryText(',
	'function copyText(',
	'function watchFlagText(',
	'const rateText = (series) => {',
	'function isStreaming(',
	'function idleTick(',
	'function rate(',
	'function worstLongTask(',
	'function worstSecond(',
	'function frameMixBuckets(',
	'function frameBucketOf(',
	'function frameMix(',
	'function frameMixCountText(',
	'function frameMixPctText(',
	'function frameMixRows(',
	'const pad = ',
	'const clock = (ms) => {',
	'const mb = ',
	'function verification(',
	'function snapshot(',
	// 导出脱敏:导出件只有这一个出口,两个盒子都要有(否则 snapshot / incidentReport 一跑就 ReferenceError)
	'const SECRET_PARAM_NAMES = ',
	'const SECRET_PARAM = ',
	'const HOME_PATH = ',
	'const WIN_HOME_PATH = ',
	'function scrubParams(',
	'function redactPageUrl(',
	'function redactScriptUrl(',
	'function redactPath(',
	'function redactUserAgent(',
	'const PAGE_KEYS = ',
	'const SCRIPT_URL_KEYS = ',
	'const FREE_TEXT_KEYS = ',
	'function redactExport(',
	'function redactionReport(',
	// 捕获计数:snapshot() 会调 tallyReport()(导出件里的 24h 滚动窗口)
	'const TALLY_FIELDS = {',
	'const TALLY_BUCKET_MS = ',
	'const TALLY_MINUTES = ',
	'const TALLY_DAYS = ',
	'const TALLY_SAVE_DELAY_MS = ',
	'const LS_TALLY = ',
	'function tallyDayKey(',
	'function tallyBlank(',
	'function tallyBucketOf(',
	'function tallySum(',
	'function pruneTally(',
	'function bumpTally(',
	'function noteTallySeverity(',
	'function tallyWindow(',
	'function tallyOfDay(',
	// 能力矩阵 + 可能原因 + 诊断包(整机导出件 snapshot 会调 capabilities)
	'const CAUSE_MAX = ',
	'const PACK_SCHEMA_VERSION = ',
	'function packGuard(',
	'function zipStore(',
	'function latestIncident(',
	'function causePlainLead(',
	'function healthIcon(',
	'function healthText(',
	'function healthVerdict(',
	'function repeatedLead(',
	'function trendSummary(',
	'function trendText(',
	'function trendRawText(',
	'function secondsText(',
	'function lastStallSubText(',
	'function provenanceOf(',
	'function capabilities(',
	'function capabilityMissing(',
	'function provenanceText(',
	'function strengthText(',
	'function causeCandidates(',
	'function manifestFor(',
	'function diagnosticSummary(',
	'function packReadme(',
	'function buildPack(',
	'function packPreview(',
	'function exportPack(',
	'function tallyReport(',
	'function markTallyDirty(',
	'function saveTally(',
	'function restoreTally(',
	'function clearTally(',
].map((header) => {
	if (header.startsWith('const ') && header.endsWith('{') === false) {
		return source.slice(source.indexOf(header), source.indexOf('\n', source.indexOf(header)));
	}
	if (header.startsWith('const ')) return `${extract(source, header)};`;
	return extract(source, header);
}).join('\n');

const box = new Function(`${sandbox}
	let packApi = null;
	${newPieces}
	return { state, changedNodes, bundleMaps, scriptLines, ring, storage: localStorage, location, setStreaming: (value) => { streamingFlag = value; },
		setFlushSync: (value) => { flushSync = value; },
		SELF_RING, recordSelf, selfStats, recorderText,
		DICT, docLang, fallback, document, navigator,
		WATCH_INCIDENT_MAX, WATCH_DAILY_DAYS, WATCH_KEEP_MAX,
		EX: { absolutePluginUrl, mapUrlOf, sectionName, sectionOwner, bundleLabel, scriptLineOf, packageOfScript, loadScriptLines, fiberOwner, componentOf, linkStats, suspectLink, experimentDelta, noiseFloor, pickExperimentCandidates, significance, blameText, primaryBlame, longTaskTally, legOf, applyLongTaskStats, descendantComponentOf, subtreeOwner, usableComponentName, isRecorderName, blameName, keepIncident, dayKeyOf, pruneIncidents, overviewLine1, overviewLine2, detailSummary, techSummary, domSummary, hostSummary, hostFreshness, hostLoopText, hostLoopStateText, toolsSummary, rateText, displayKey, bump, infraVerdict, sceneChip, unexplainedFrame, levelFrame, frameLevel, frameMixBuckets, frameBucketOf, frameMix, frameMixCountText, frameMixPctText, frameMixRows, looksLikeInfrastructure, msPerSecText, attrText, restValueText, restTitleText, toggleGroup, containerNodes, idleTick, snapshot, domWriteSnapshot, domWriteDelta, linkRowText, throughputText, fetchFailureText, timeoutError, cancelledError, isAbortError, pruneMapIndex, hudDodge, panelWidthFor, pillCompact,
		// P0/P1 新增:事故选中上下文 / 严重度文字档位 / 布局动作
		pickIncident, saveGroups, collapseAll, resetLayout, anyGroupOpen, layoutDirty, setIncidentScope, severityLevel, severityText, severityColor, incidentOwner, selectedIncident, selectIncident, revealIncident, showLiveMode, saveWatchUI, restoreWatchUI, diagMode, incidentFrameHeadingText, liveFrameHeadingText, detailSummary, detailGroupLabel, incidentFrameRows, incidentLoafAt, incidentWorstFrame, selectedIncidentFrame, incidentFrameNav, incidentFrameHot, selectIncidentFrame, incidentFrameStep, incidentVerdict, verdictColor, eventVerdictText, eventEvidenceText, eventWindowText, incidentSummaryText, copyText, watchFlagText, hostLoopText,
		// 证据 → 代码:位置解析 + 证据行(面板与事故包共用同一份)
		sectionSource, sectionIndex, sectionPath, scriptPosition, viaText, scriptEvidence, evidenceName, evidencePlace, evidenceWhereText, evidenceLine, incidentScriptEvidence, incidentEvidenceAt, incidentEvidenceLines, EVIDENCE_MAX,
		// 导出脱敏:整机 snapshot 的出口
		redactExport, redactPageUrl, redactScriptUrl, redactPath, redactUserAgent, scrubParams, redactionReport, SECRET_PARAM, SECRET_PARAM_NAMES,
		// 能力矩阵 / 可能原因 / 诊断包
		capabilities, capabilityMissing, provenanceOf, provenanceText, strengthText, causeCandidates,
		healthIcon, healthText, healthVerdict, repeatedLead, trendSummary, trendText, secondsText, lastStallSubText, trendRawText,
		latestIncident, causePlainLead,
		zipStore,
		// 视图模型断言要用计数桶:直接测纯函数,不走 snapshot
		clearTally, bumpTally, tallyWindow, noteTallySeverity,
		manifestFor, diagnosticSummary, packReadme, buildPack, packPreview, exportPack, CAUSE_MAX, PACK_SCHEMA_VERSION, setPackApi: (api) => { packApi = api; } } };`)();
const EX = box.EX;
box.EX.setPackApi(packChunk);
EX.crc32 = packChunk.crc32;
EX.utf8Bytes = packChunk.utf8Bytes;
EX.dosStamp = packChunk.dosStamp;
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
// 文件路径:与包名看**同一张分段表、同一个二分** —— 两者必须指向同一段,否则会出现"包是 A、
// 文件却是 B 的"这种自相矛盾的证据(这也正是上一版 names 没跟着 offsets 排序留下的隐患)。
const entryWithPaths = { offsets: [[0, 'a'], [10, 'b'], [25, 'c']], paths: ['/plugins/a/client.js', '/plugins/b/client.js', '/plugins/c/client.js'] };
check('sectionPath 与 sectionOwner 同段(包 b → b 的文件)',
	[EX.sectionOwner(entryWithPaths, 11), EX.sectionPath(entryWithPaths, 11)],
	['b', '/plugins/b/client.js']);
check('sectionPath:老缓存(v1)没有 paths → null(不猜,也不为它重下那份 12MB 的 map)', EX.sectionPath(entry, 11), null);
check('sectionPath:越界行号 → null', EX.sectionPath(entryWithPaths, 0), null);
check('sectionSource:取 plugins 下那个源(作用域包 / 包内子路径都认),没有就 null',
	[
		EX.sectionSource({ map: { sources: ['webpack:///./src/a.ts', '/plugins/@deepseek-ai/dsh-x/src/foo.ts'] } }),
		EX.sectionSource({ map: { sources: ['/plugins/dsh-x/client.js'] } }),
		EX.sectionSource({ map: { sources: [] } }),
		EX.sectionSource(undefined),
	],
	['/plugins/@deepseek-ai/dsh-x/src/foo.ts', '/plugins/dsh-x/client.js', null, null]);
// 断言必须传**类/函数**:usableComponentName 第一行是 `typeof type !== 'function'`,传
// `{ name: 'ChatView' }` 会全返回 null(上一轮就是这么把一个假绿的提交写出来的)。
check('B2:$ 开头的压缩名被挡掉;具名组件照旧通过,匿名仍是 null', [
	EX.usableComponentName(class $c {}),
	EX.usableComponentName(class $w {}),
	EX.usableComponentName(class {}),
	EX.usableComponentName(class ChatView {}),
], [null, null, null, 'ChatView']);
// 防"理由写错":括号名**不是**被 looksLikeInfrastructure 挡掉的(提交说明里这么写过,是错的)。
// 真正的原因是 usableComponentName 只收 React 的 type,而 `(Name)` 是渲染层加的显示标记。
check('B2:括号名并不是被 looksLikeInfrastructure 挡掉的(实测那条判据返回 false)',
	[EX.looksLikeInfrastructure('(ChatView)'), EX.looksLikeInfrastructure('ChatView')], [false, false]);

// ── C2:i18n(兜底跟文档语言 + 词典同源)──────────────────────────────
check('C2:两本字典键集合完全一致(成对改的机器检查)',
	JSON.stringify(Object.keys(box.DICT.zh).sort()) === JSON.stringify(Object.keys(box.DICT.en).sort()), true);
check('C2:词典里没有"没人引用"的死键(面板撤下后遗留的串)', (() => {
	const dictBlock = extract(source, 'const DICT = {');
	const outside = source.replace(dictBlock, '') + '\n' + uiSource + '\n' + modelSource;
	// 只认字面量调用:本项目没有 `translate(变量)` 这种动态取键 —— 真要加动态键,这条断言得先放宽
	const referenced = new Set([...outside.matchAll(/\b(?:t|translate)\(\s*(['"])([A-Za-z_$][\w$]*)\1\s*\)/g)].map((row) => row[2]));
	return Object.keys(box.DICT.zh).filter((key) => referenced.has(key) === false);
})(), []);
// 反向的那一条:**引用了但词典里没有**同样要报 —— 这时 `translate` 会退回 key 本身,
// 面板 / 导出件上就**直接印出** `exportPreviewCopy` 这种内部键名(实测踩到过:按钮文案少了
// 词典条目,三套件全绿、死键断言也不响,只有真页面才看得出来)。死键断言管不到它,所以必须有这一条。
check('C2:引用的键必须真的在词典里(否则界面上会印出 key 名)', (() => {
	const dictBlock = extract(source, 'const DICT = {');
	const outside = source.replace(dictBlock, '') + '\n' + uiSource;
	const referenced = new Set([...outside.matchAll(/\b(?:t|translate)\(\s*(['"])([A-Za-z_$][\w$]*)\1\s*\)/g)].map((row) => row[2]));
	const zh = new Set(Object.keys(box.DICT.zh));
	const en = new Set(Object.keys(box.DICT.en));
	return [...referenced].filter((key) => zh.has(key) === false || en.has(key) === false);
})(), []);

// 面板是**纯文本**渲染,不是 markdown:凡是显示在**正文**里的词典值都不许带 `**` 或反引号,
// 否则它们会原样出现在面板上(实测被吐槽)。带记号的只允许是"只做悬停 title"的那几个键 ——
// 白名单里的键也不许是死键(下面那条核它)。新加正文文案时:要么去掉记号,要么确认它只进 title。
const MARKDOWN_TITLE_ONLY = new Set([
	'framePickHint', 'pkgHint', 'pkgWindowHint', 'pkgStoredHint', 'incidentWindowScopeHint', 'pkgIncidentWindowHint',
	'forcedHint', 'crossHint', 'crossIncidentHint', 'frameNavHint', 'replayHint', 'replayTimelineHint', 'evidenceHint',
	'splitHint', 'splitJsHint', 'invokerHint', 'windowScopeHint', 'watchHint', 'watchExportHint', 'viewEvidenceHint',
	'shellNoteHint', 'evidenceUnlocatableHint',
	'shellNoteHint', 'evidenceUnlocatableHint',
]);
check('正文文案不含 markdown 记号(`**` / 反引号),带记号的一律是白名单里的"只进悬停"键',
	Object.keys(box.DICT.zh).filter((key) => /\*\*|`/.test(box.DICT.zh[key]) || /\*\*|`/.test(box.DICT.en[key]))
		.filter((key) => MARKDOWN_TITLE_ONLY.has(key) === false), []);
check('上面那份黑白名单没有过期条目(键都还在词典里)',
	[...MARKDOWN_TITLE_ONLY].filter((key) => Object.hasOwn(box.DICT.zh, key) === false), []);
// 头部标题(= 视图名)的长度预算:它是那一行里唯一**可以让位**的文字,所以它超预算时界面会
// 悄悄出省略号而不是报错 —— 这条断言把"又写长了"变成红灯。en 那一档按最长的 `Developer details` 定。
check('头部视图名的长度预算(zh ≤5 字 / en ≤17 字符;品牌名不再拼进标题)',
	[['viewDev', 'viewIncident', 'viewSettings'].every((key) => box.DICT.zh[key].length <= 5),
		['viewDev', 'viewIncident', 'viewSettings'].every((key) => box.DICT.en[key].length <= 17)],
	[true, true]);
check('C2:兜底跟文档语言走(zh → 中文,其余含认不出来 → 英文),不是写死中文', (() => {
	const read = (lang, navLang) => {
		box.document.documentElement.lang = lang;
		box.navigator.language = navLang;
		return box.fallback('title');
	};
	const values = [read('zh-CN', undefined), read('en-GB', undefined), read('ja', undefined), read('', 'zh-TW'), read('', undefined)];
	box.document.documentElement.lang = '';
	box.navigator.language = undefined;
	return values;
})(), ['性能 HUD', 'Perf HUD', 'Perf HUD', '性能 HUD', 'Perf HUD']);
check('C2:两本都没这个键就原样返回(不编造)', (() => {
	box.document.documentElement.lang = 'zh-CN';
	const value = box.fallback('definitely-not-a-key');
	box.document.documentElement.lang = '';
	return value;
})(), 'definitely-not-a-key');

// ── A2:LoAF 脚本 → 包名(charPos → 行号 → 分段表)────────────────────
const comboUrl = 'http://h/plugins/??dsh-a/client.js,dsh-b/client.js&rev=9';
await EX.loadScriptLines(comboUrl);          // 假脚本 3 行:aaa / bbb / ccc
check('scriptLineOf:charPos 0 在第 1 行', EX.scriptLineOf(comboUrl, 0), 1);
check('scriptLineOf:换行符本身算下一行起点', [EX.scriptLineOf(comboUrl, 3), EX.scriptLineOf(comboUrl, 4), EX.scriptLineOf(comboUrl, 8)], [1, 2, 3]);
check('scriptLineOf:文本没到位就是 null(不猜)', EX.scriptLineOf('http://h/plugins/??x,y/client.js', 5), null);
check('scriptLineOf:字符位置超出文本 → -1', EX.scriptLineOf(comboUrl, 999), -1);
check('fetch 失败文案:timeout / cancelled 分开报(不把主动关闭写成错误)',
	[EX.fetchFailureText(EX.timeoutError(5000), 5000), EX.fetchFailureText(EX.cancelledError(), 5000), EX.isAbortError(EX.cancelledError()), EX.isAbortError(new Error('boom'))],
	['timeout 5000ms', 'cancelled', true, false]);
check('map 缓存 LRU:只留最近 8 个 rev,淘汰最旧的',
	(() => {
		const keys = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, at: i }));
		const pruned = EX.pruneMapIndex(keys, 8);
		return [pruned.keep.map((row) => row.key), pruned.evicted.map((row) => row.key)];
	})(),
	[['k9', 'k8', 'k7', 'k6', 'k5', 'k4', 'k3', 'k2'], ['k1', 'k0']]);
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

	// 判定而不是只摆数字:两者都正常时必须给出结论(快照要新鲜、有样本,才是 live)
	box.state.hostError = null;
	box.state.host = { eventLoop: { p50: 1.2, p99: 4.3, seconds: 30 }, nodeVersion: 'v24', eventLoopLive: true };
	box.state.hostAt = Date.now();
	box.state.link = [{ t: Date.now(), kind: 'rtt', rtt: 13 }];
	check('宿主与链路都正常 → 直接说链路已排除', EX.infraVerdict().text, '链路已排除(宿主与隧道均正常)');
	box.state.link = [{ t: Date.now(), kind: 'rtt', rtt: 400 }, { t: Date.now(), kind: 'rtt', rtt: 400 }];
	check('RTT p99 超阈值 → 判为链路存疑', EX.infraVerdict().bad, true);
	box.state.host = { eventLoop: { p50: 1.2, p99: 120, seconds: 30 }, eventLoopLive: true };
	box.state.link = [];
	check('宿主 p99 超阈值 → 判为宿主存疑', EX.infraVerdict().bad, true);
	// 零样本 / 过期 / 未采到:不许给「链路已排除」
	box.state.host = { eventLoop: { p50: null, p99: null, max: 0, seconds: 0 }, eventLoopLive: true };
	box.state.hostAt = Date.now();
	check('宿主还没有样本 → 不能说链路已排除', EX.infraVerdict().text, '宿主数据不足');
	check('宿主还没有样本 → 四态是 warming', EX.hostFreshness().state, 'warming');
	box.state.host = { eventLoop: { p50: 1.2, p99: 4.3, seconds: 30 }, eventLoopLive: true };
	box.state.hostAt = Date.now() - 60000;
	check('宿主快照过期 → 四态是 stale', EX.hostFreshness().state, 'stale');
	check('宿主快照过期 → 判定不能说正常', EX.infraVerdict().bad, true);
	box.state.host = { eventLoop: { p50: 1.2, p99: 4.3, seconds: 30 }, eventLoopLive: false };
	box.state.hostAt = Date.now();
	check('宿主探针没跑起来 → 四态是 unsupported', EX.hostFreshness().state, 'unsupported');
	check('宿主探针没跑起来 → 文案是"宿主未采到"', EX.hostLoopStateText(), '宿主未采到');
	box.state.host = { eventLoop: { p50: 1.2, p99: 4.3, seconds: 30 }, eventLoopLive: true };
	box.state.hostAt = Date.now();
	// 未解释帧:最差帧 130ms 而帧内未归因峰值也是 130ms → 那一帧完全没有 JS 解释
	// (这一条只在插桩下成立:没插桩时 unattr 恒等于帧间隔,那会得出"每条长帧都无 JS 解释")
	box.state.deep = true;
	box.state.frameWorst = 130;
	box.state.unattrPeak = 130;
	check('未解释帧自动触发(峰值≈最差帧)', EX.unexplainedFrame().percent, 100);
	box.state.unattrPeak = 30;
	check('有 JS 解释时不该触发', EX.unexplainedFrame(), null);
	box.state.unattrPeak = 130;
	box.state.deep = false;
	check('没插桩时不报"无 JS 解释"(那时它一定成立,等于恒报)', EX.unexplainedFrame(), null);
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
	// B1:记录器自己在归因里被**标注**,不是静默剔除(每帧都在跑,静默丢掉会读成"没人干活")
	check('B1:命中记录器自己时加后缀(三条腿都会标)',
		[
			EX.blameText({ component: 'PerfHud', subtreeComponent: null, domComponent: null, owner: null }),
			EX.blameText({ component: null, subtreeComponent: null, domComponent: 'PerfHudStress', owner: null }),
			EX.blameText({ component: null, subtreeComponent: null, domComponent: null, owner: 'dsh-perf-hud' }),
			EX.blameText({ component: 'ChatView', subtreeComponent: null, domComponent: null, owner: null }),
		],
		['PerfHud[记录器自身]', 'PerfHudStress[记录器自身](DOM 写入)', 'dsh-perf-hud[记录器自身]', 'ChatView']);
	check('B1:有别的候选时 primaryBlame 跳过记录器自己,一个都没有时照实返回它',
		[
			EX.primaryBlame({ component: 'PerfHud', subtreeComponent: 'ChatView', domComponent: null, owner: null }),
			EX.primaryBlame({ component: 'PerfHud', subtreeComponent: null, domComponent: null, owner: null }),
		],
		['ChatView', 'PerfHud']);
	check('B1:归属汇总把记录器自己从 Top 里分出来单列',
		(() => {
			box.state.ltNames.clear();
			box.state.ltTotal = 3;
			for (const row of [
				{ t: 1, component: 'ChatView', subtreeComponent: null, domComponent: null, owner: null },
				{ t: 2, component: 'PerfHud', subtreeComponent: null, domComponent: null, owner: null },
				{ t: 3, component: 'PerfHud', subtreeComponent: null, domComponent: null, owner: null },
			]) EX.applyLongTaskStats(row);
			const split = EX.longTaskTally();
			return [split.topNames.map((row) => row[0]), split.self.map((row) => [row[0], row[1]]), split.selfTotal];
		})(), [['ChatView'], [['PerfHud', 2]], 2]);

// ── D3:留存策略 = 全局最差 10 条 + 每天最差 1 条(最多 7 天)────────────
{
	const mk = (id, severity, day) => ({
		id, severity, cause: 'frame', note: null, kept: null,
		at: new Date(2026, 9, day, 12, 0, 0).toISOString(),
	});
	const reset = () => {
		box.state.watch.incidents.length = 0;
		box.state.watch.dropped = 0;
		box.state.watch.captured = 0;
	};
	reset();
	// 严重度递减:后来者挤不进最差档,也不可能是"当天最差" → 才谈得上 dropped
	for (let i = 1; i <= 12; i += 1) { box.state.watch.captured += 1; EX.keepIncident(mk(`a${i}`, 100 - i, 8)); }
	check('D3:同一天抓 12 次只留最差 10 条,其余记 dropped',
		[box.state.watch.incidents.length, box.state.watch.dropped, box.state.watch.incidents[0].id], [10, 2, 'a1']);
	check('D3:第二天最差的一条即使更轻也留下(靠"每天最差"档),并标出 tier',
		(() => {
			const verdict = EX.keepIncident(mk('b1', 50, 9));
			const row = box.state.watch.incidents.find((item) => item.id === 'b1');
			return [verdict, box.state.watch.incidents.length, row.tier];
		})(), ['kept', 11, 'daily']);
	check('D3:同一天再来一条更轻的不留(当天最差只有一条)',
		(() => { box.state.watch.dropped = 0; return [EX.keepIncident(mk('b2', 40, 9)), box.state.watch.dropped]; })(),
		['dropped', 1]);
	check('D3:更重的一条仍按全局最差档进,并顶掉最弱的(当天最差也随之换人)',
		(() => {
			const verdict = EX.keepIncident(mk('c1', 999, 9));
			return [verdict, box.state.watch.incidents.length, box.state.watch.incidents[0].id, box.state.watch.incidents.some((row) => row.id === 'b1')];
		})(), ['replaced', 10, 'c1', false]);
	reset();
	EX.keepIncident(mk('early', 10, 1));                                  // 最早那天,轻得不值一提
	for (let day = 2; day <= 8; day += 1) EX.keepIncident(mk(`d${day}`, 900 + day, day));
	for (let i = 0; i < 10; i += 1) EX.keepIncident(mk(`f${i}`, 100 + i, 8));   // 把最差档灌满
	const keptIds = box.state.watch.incidents.map((row) => row.id);
	check('D3:"每天最差"档只保留最近 7 天 —— 更早那天的即使更轻也不再单独留',
		[keptIds.includes('early'), keptIds.includes('d8'), keptIds.length], [false, true, 10]);
	check('D3:上限常量 = 两档之和;每条都带 day 与 tier',
		[box.WATCH_KEEP_MAX, box.WATCH_KEEP_MAX === box.WATCH_INCIDENT_MAX + box.WATCH_DAILY_DAYS,
			box.state.watch.incidents.every((row) => typeof row.tier === 'string' && typeof row.day === 'string')],
		[17, true, true]);
}
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
// 相邻两行不许说同一句话:第一行不重复"最差那条:未归因",那件事由第二行自己的标签承担
// (两者的触发条件完全相同 —— primaryBlame(worst) === null,所以第一行挂后缀必然是重复)
check('概览第一行不重复第二行要说的话(能不说就不说)',
	(() => {
		box.state.longTasks = [{ t: Date.now(), at: performance.now() - 100, ms: 285, owner: null, component: null, subtreeComponent: null, domComponent: null }];
		box.state.ltTotal = 1;
		box.state.ltBlamed = 0;
		const first = EX.overviewLine1();
		const second = EX.overviewLine2();
		box.state.frameWorst = 17;
		box.state.ltTotal = 16;
		box.state.ltBlamed = 15;
		box.state.longTasks = [{ t: Date.now(), at: performance.now() - 100, ms: 285, owner: null, component: 'FileTree', subtreeComponent: 'ConfirmDialog', domComponent: null }];
		return [first.split('\n').length, first.includes('未归因'), second.includes('未归因')];
	})(), [1, false, true]);
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
// 「技术细节」是卡顿详情那一屏唯一的技术读数入口(普通用户也会经过它),摘要不收缩就会把那行折成两行:
// 按真实量级喂它 —— 分位数级的帧(1234.5ms)+ 两位数条数。
check('「技术细节」摘要的长度预算(真实量级:四位数 + 小数 + 两位数 LT)',
	(() => {
		const text = EX.techSummary({ split: { total: 1234.5, js: 1234.5, taskOther: 0, render: 0, tail: 0 }, longTasks: new Array(12).fill({}) });
		const none = EX.techSummary({ split: null });
		return [text.length <= 30, text.includes('1234.5ms'), text.includes('12'), none.length <= 12];
	})(), [true, true, true, true]);
// ⚠️ 上面那条用的是桩里的小数字,**挡不住真实量级** —— 实测过一次:折叠摘要按 p99 标的长度
// 是紧的(桩喂 120ms / `未采集` 时 30 字符,真实数据 1234.5ms 时能顶到 34)。这里专门喂真实量级。
check('宿主摘要的长度预算(真实量级:四位数 + 小数;判定不进摘要,它是展开后的第一行)', (() => {
	const host0 = box.state.host;
	const hostAt0 = box.state.hostAt;
	const link0 = box.state.link;
	box.state.host = { eventLoop: { p50: 12.3, p99: 1234.5, max: 2000, seconds: 30 }, eventLoopLive: true };
	box.state.hostAt = Date.now();
	box.state.link = [{ t: Date.now(), kind: 'rtt', rtt: 1234.5 }, { t: Date.now(), kind: 'rtt', rtt: 1200 }];
	const text = EX.hostSummary();
	box.state.host = host0;
	box.state.hostAt = hostAt0;
	box.state.link = link0;
	return [text.length <= 34, text.includes('p99'), text.includes('1234.5ms'), text.includes('判定' ) === false];
})(), [true, true, true, true]);
box.state.mutations = 0;
box.state.unattrAvg = 0;

// ── 面板分层:折叠状态与摘要 ───────────────────────────────────────
check('默认全部收起(过程/取证/工具不占常显篇幅)',
	JSON.stringify(box.state.groups), JSON.stringify({ detail: false, cross: false, dom: false, host: false, tools: false, tech: false }));
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

// ── P0/P1:事故选中上下文 + 「最差事件」入口 ────────────────────────────
// 严重度必须**文字与颜色两样都给**(不能只靠颜色):先钉档位阈值,再钉映射。
// 红档 200ms 与面板判色同一条线;黄档用守夜触发线 100ms —— 它已经是一条事故了。
check('严重度档位:100/200 两条线(与判色、守夜触发线同一套)',
	[99, 100, 199, 200, 1000].map((ms) => EX.severityLevel(ms)), ['ok', 'warn', 'warn', 'bad', 'bad']);
check('严重度档位:非数字给 none(不猜)', [EX.severityLevel(null), EX.severityLevel(undefined), EX.severityLevel(NaN)], ['none', 'none', 'none']);
check('严重度:文字与 token 颜色两样一起给(只给颜色等于丢信息)',
	['bad', 'warn', 'ok', 'none'].map((level) => [EX.severityText(level), EX.severityColor(level)]),
	[['严重', 'var(--dsw-alias-state-error-primary)'], ['警告', 'var(--dsw-alias-state-warn-primary)'], ['低于线', 'var(--dsw-alias-state-success-primary)'], ['无', 'var(--dsw-alias-label-secondary)']]);

// ⚠️ 用**本地时间**造时间戳:clock() 走的是 Date 的本地取值,直接写 ISO 串会让断言跟着 TZ 变
// (本机 UTC+8 实测把它变成 22:48:03)。
const incidentAt = new Date(2026, 9, 11, 14, 48, 3);
const incidentRow = {
	id: 'i84', cause: 'frame', note: null, severity: 326.4, atPerfMs: 880, at: incidentAt.toISOString(),
	packages: [{ pkg: 'dsh-status-rotator', ms: 210, count: 3 }],
	summary: {
		worstFrameMs: 326, worstFrameJs: 'js', frames: 12, loafEntries: 3, blockingMs: 40,
		pkgCoverage: { resolved: 4, total: 6 }, topScripts: [],
	},
};
check('事故归属:优先取按包汇总(packages[0],已去重聚合)',
	EX.incidentOwner(incidentRow), { name: 'dsh-status-rotator', ms: 210, count: 3 });
check('事故归属:没有 packages 时退到 topScripts[0].pkg',
	EX.incidentOwner({ ...incidentRow, packages: [], summary: { ...incidentRow.summary, topScripts: [{ pkg: 'dsh-x', ms: 9 }] } }), { name: 'dsh-x', ms: 9, count: 1 });
check('事故归属:一个包名都没定到就是 null(面板照实写未归因,不猜)',
	EX.incidentOwner({ ...incidentRow, packages: [], summary: { ...incidentRow.summary, topScripts: [{ pkg: null, ms: 9 }] } }), null);
check('事故归属:空行不抛错', [EX.incidentOwner(null), EX.incidentOwner(undefined)], [null, null]);

check('最差事件证据行:归因状态(文字档位)+ 主要归属(带毫秒)',
	EX.eventEvidenceText(incidentRow), '归因状态 已确认 · 主要归属 dsh-status-rotator 210ms');
// §五:没有 JS 证据**不许**说成"浏览器节流" —— 那只是其中一种可能,要挂条件(下面三条钉住)
check('归因状态:有 JS 证据 + 定到包 → 已确认,而且写明"这只缩小到包、不等于根因"',
	(() => { const v = EX.incidentVerdict(incidentRow); return [v.level, v.label, v.detail.includes('dsh-status-rotator 210ms'), v.detail.includes('不等于已定位根因')]; })(),
	['confirmed', '已确认', true, true]);
check('归因状态:有 JS 证据但没定到包 → 可疑(要深录才能再缩小)',
	(() => {
		const row = { ...incidentRow, packages: [], summary: { ...incidentRow.summary, topScripts: [], worstFrameJs: 'js' } };
		const v = EX.incidentVerdict(row);
		return [v.level, v.detail.includes('没能定到包名')];
	})(), ['suspected', true]);
check('归因状态:没有 JS 证据 + 满足节流判据 → 可疑,并写成"更像…"而不是结论',
	(() => {
		const row = { ...incidentRow, packages: [], summary: { ...incidentRow.summary, worstFrameJs: 'none', suspectedThrottle: true, worstFrameNeighboursMs: 16.7 } };
		const v = EX.incidentVerdict(row);
		return [v.level, v.detail.includes('更像 rAF 被挂起或浏览器节流'), v.detail.includes('未观察到足以解释')];
	})(), ['suspected', true, false]);
check('归因状态:没有 JS 证据、也不满足节流判据 → 未归因,给的是那句"请结合前后帧与时间间隙检查"',
	(() => {
		const row = { ...incidentRow, packages: [], summary: { ...incidentRow.summary, worstFrameJs: 'none', suspectedThrottle: false } };
		const v = EX.incidentVerdict(row);
		return [v.level, v.label, v.detail];
	})(), ['unattributed', '未归因', '未观察到足以解释该帧的 JS 阻塞证据;请结合前后帧和时间间隙检查 rAF 挂起或浏览器节流(这一帧 326ms,与它重叠的 JS 观测为 0ms)']);
check('未归因那把"没观测到"量化:帧间隔给出来,并说明与它重叠的 JS 观测为 0(不拿窗口总量减帧间隔)',
	(() => {
		const withMs = EX.incidentVerdict({ ...incidentRow, packages: [], summary: { ...incidentRow.summary, worstFrameMs: 498, worstFrameJs: 'none' } }).detail;
		const noMs = EX.incidentVerdict({ ...incidentRow, packages: [], summary: { ...incidentRow.summary, worstFrameMs: null, worstFrameJs: 'none' } }).detail;
		return [withMs.includes('这一帧 498ms'), withMs.includes('JS 观测为 0ms'), withMs.includes('blockingMs') === false, noMs.endsWith('器节流')];
	})(), [true, true, true, true]);
check('归因状态:档位色也一起给(文字永远在,不只靠颜色)',
	['confirmed', 'suspected', 'unattributed'].map((level) => EX.verdictColor(level)),
	['var(--dsw-alias-state-success-primary)', 'var(--dsw-alias-state-warn-primary)', 'var(--dsw-alias-label-secondary)']);
check('最差事件说明行:把"凭什么"摊开(未归因时就是那句校准过的说明)',
	EX.eventVerdictText({ ...incidentRow, packages: [], summary: { ...incidentRow.summary, worstFrameJs: 'none' } }).startsWith('未归因:未观察到足以解释该帧的 JS 阻塞证据'),
	true);
check('jsNo 文案里不再出现"更像 rAF 被节流"这种把可能性写成结论的说法',
	/无\(longtask\/LoAF 都不与它重叠\)/.test(allSource) && allSource.includes("jsNo: '无(更像 rAF 被节流)'") === false, true);
check('最差事件窗口行:单帧 / 累计的分母都写出来(帧数 · LoAF 条数 · 按包覆盖率)',
	EX.eventWindowText(incidentRow), '窗口 12 帧 · LoAF 3 · 按包 4/6');
// 这两行是 S.sub(允许换行),所以上限只是"防跑飞"。
check('最差事件证据/窗口行长度上限(可换行,防跑飞)',
	[EX.eventEvidenceText(incidentRow).length <= 60, EX.eventVerdictText(incidentRow).length <= 130, EX.eventWindowText(incidentRow).length <= 40], [true, true, true]);
check('最差事件两行:没有事故时证据/窗口行给空串(不摆 0)',
	[EX.eventEvidenceText(null), EX.eventWindowText(null)], ['', '']);

check('复制摘要:带结论与口径(严重度文字 / JS 证据 / 归属 / 窗口分母)+ 口径与缺口两行',
	(() => {
		const text = EX.incidentSummaryText(incidentRow);
		return [text.split('\n').length, text.includes('dsh-status-rotator 210ms'), text.includes('严重'), text.includes('按包 4/6'), text.includes('口径:'), text.includes('缺:'), text.includes('归因状态 已确认')];
	})(), [7, true, true, true, true, true, true]);
check('复制摘要:事故里有脚本时带上「可疑脚本」证据行(交给别的 AI 能接着查,而不只是一句结论)',
	(() => {
		const row = {
			...incidentRow,
			summary: {
				...incidentRow.summary,
				topScripts: [{
					u: 0, ms: 210, fn: 'renderChat', charPos: 100, pkg: 'dsh-status-rotator', pkgVia: 'section',
					file: '/plugins/dsh-status-rotator/client.js', line: 7, lineVia: 'text', invoker: 'TimerHandler:setTimeout',
				}],
			},
		};
		const text = EX.incidentSummaryText(row);
		// ⚠️ 合并批的行号是**合并后大文件**里的行,不许拼成 `文件:行` —— 文件与行号分列,
		// 行号明写「合并脚本行」
		return [
			text.includes('可疑脚本:'), text.includes('renderChat @ dsh-status-rotator'),
			text.includes('· /plugins/dsh-status-rotator/client.js · 合并脚本行 7 · 210ms'),
			text.includes('client.js:7') === false, text.includes('210ms'),
			text.includes('来源 TimerHandler:setTimeout'), text.includes('pkg=section line=text'),
		];
	})(), [true, true, true, true, true, true, true]);
check('复制摘要:窗口里有 ≥100ms 交互时写出事件来源(并标明是端到端、不是帧内拆分)',
	(() => {
		const row = { ...incidentRow, interactions: [{ type: 'event', name: 'click', ms: 168, waitMs: 7, handlerMs: 160 }] };
		const text = EX.incidentSummaryText(row);
		return [text.includes('click 168ms'), text.includes('端到端')];
	})(), [true, true]);
check('复制摘要:一次交互都没有时那一行整段不出现(不摆 0)',
	EX.incidentSummaryText({ ...incidentRow, interactions: [] }).includes('交互'), false);

// ── 证据 → 代码:位置解析与证据行 ─────────────────────────────────────
// 「行号」是**脚本文本自己的行号**,不是原始源码行 —— 这几条断言把这个口径钉死。
check('scriptPosition:没预取 / 没字符位置 → null 且写明原因(不猜行号)',
	(() => {
		box.state.precise = false;
		return [EX.scriptPosition('', 10), EX.scriptPosition('http://h/plugins/x/client.js', -1), EX.scriptPosition('http://h/plugins/x/client.js', 10)];
	})(),
	[{ line: null, via: 'no-url' }, { line: null, via: 'no-charpos' }, { line: null, via: 'text-not-fetched' }]);
// 关键成本边界:scriptPosition **不许**自己拉脚本文本 —— 否则"看一眼面板"会去下整份合并批脚本
// (几 MB),而且会在没有包名时给出一个合并大文件里的行号(虚假精度)。
check('scriptPosition 不预取脚本文本(预取只属于深录档)', (() => {
	const before = box.scriptLines.size;
	EX.scriptPosition('http://h/plugins/never-fetched/client.js', 10);
	return box.scriptLines.size === before;
})(), true);
check('scriptPosition:字符位置 → 行号(1-based),越界给 null + out-of-range',
	(() => {
		// 一段三行脚本('aaa','bbb','ccc'):字符 0 在第 1 行、第 5 个字符(0-based 4)在第 2 行
		box.scriptLines.set('http://h/plugins/x/client.js', { state: 'ready', starts: [0, 4, 8], length: 12 });
		const hit = EX.scriptPosition('http://h/plugins/x/client.js', 4);
		const out = EX.scriptPosition('http://h/plugins/x/client.js', 99);
		box.scriptLines.delete('http://h/plugins/x/client.js');
		return [hit, out, EX.scriptPosition('http://h/plugins/x/client.js', 4)];
	})(),
	[{ line: 2, via: 'text' }, { line: null, via: 'out-of-range' }, { line: null, via: 'text-not-fetched' }]);
check('viaText:人话分档(直接读 / 分段推断 / 不是插件 / 解析失败 / 没预取 / 还没到位)',
	['url', 'section', 'not-plugin', 'text-failed(HTTP 500)', 'map-pending', 'text-not-fetched', 'text-pending', 'no-charpos'].map((via) => EX.viaText(via)),
	['直接读出来', '分段推断', '不是插件脚本', '解析失败', '解析失败', '还没预取(只有深录才拉脚本文本)', '还没到位/拿不到', '还没到位/拿不到']);
check('scriptEvidence:单包 URL → 包直接读出来、文件就是 URL 的路径、行号来自脚本文本',
	(() => {
		const url = 'http://127.0.0.1:3080/plugins/dsh-x/client.js';
		box.scriptLines.set(url, { state: 'ready', starts: [0, 4, 8], length: 12 });
		box.state.precise = true;
		const ev = EX.scriptEvidence({ url, fn: 'render', invoker: 'TimerHandler:setTimeout', charPos: 4, ms: 12.3 }, url);
		box.scriptLines.delete(url);
		return [ev.pkg, ev.pkgVia, ev.file, ev.line, ev.lineVia, ev.lineScope, ev.fn, ev.ms, ev.invoker];
	})(),
	['dsh-x', 'url', '/plugins/dsh-x/client.js', 2, 'text', 'file', 'render', 12.3, 'TimerHandler:setTimeout']);
check('scriptEvidence:合并批 → 包名靠分段表推出来,文件也在同一段(有 paths 时)',
	(() => {
		const url = 'http://127.0.0.1:3080/plugins/??a/client.js,b/client.js&rev=1';
		const starts = [];
		for (let i = 0; i < 20; i += 1) starts.push(i * 4);   // 每行 4 字符:第 12 行从字符 44 起
		box.scriptLines.set(url, { state: 'ready', starts, length: 200 });
		box.bundleMaps.set(`bundle:${url}`, { state: 'ready', offsets: [[0, 'a'], [10, 'b']], paths: ['/plugins/a/client.js', '/plugins/b/client.js'], count: 2 });
		box.state.precise = true;
		const ev = EX.scriptEvidence({ url, fn: 'run', charPos: 44, ms: 5 }, url);
		box.scriptLines.delete(url);
		box.bundleMaps.delete(`bundle:${url}`);
		return [ev.pkg, ev.pkgVia, ev.file, ev.line, ev.lineVia, ev.lineScope];
	})(),
	['b', 'section', '/plugins/b/client.js', 12, 'text', 'bundle']);
check('scriptEvidence:合并批 + 老缓存(没有 paths)→ 包名有、文件为 null —— 不拿包名冒充文件名',
	(() => {
		const url = 'http://127.0.0.1:3080/plugins/??a/client.js,b/client.js&rev=1';
		const starts = [];
		for (let i = 0; i < 20; i += 1) starts.push(i * 4);
		box.scriptLines.set(url, { state: 'ready', starts, length: 200 });
		box.bundleMaps.set(`bundle:${url}`, { state: 'ready', offsets: [[0, 'a'], [10, 'b']], paths: null, count: 2 });
		box.state.precise = true;
		const ev = EX.scriptEvidence({ url, fn: 'run', charPos: 44, ms: 5 }, url);
		box.scriptLines.delete(url);
		box.bundleMaps.delete(`bundle:${url}`);
		return [ev.pkg, ev.pkgVia, ev.file, ev.line, ev.lineScope];
	})(),
	['b', 'section', null, 12, 'bundle']);
// ⚠️ 单包组合(`plugins/??<一个包>/client.js`)是个坑:`??` 的第一个 `?` 会被 `new URL` 当成
// 查询串开始,pathname 只剩 `/plugins/` —— 于是"文件路径"会显示成 `/plugins/`(实测踩到)。
check('scriptEvidence:单包组合 URL → 文件由正则自己拼(不能交给 new URL().pathname)',
	(() => {
		box.state.precise = true;
		const url = 'http://127.0.0.1:3080/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=03c3';
		const ev = EX.scriptEvidence({ url, fn: 'run', charPos: 0, ms: 7 }, url);
		return [ev.pkg, ev.pkgVia, ev.file, new URL(url).pathname];
	})(),
	['@deepseek-ai/dsh-client-modules', 'url', '/plugins/@deepseek-ai/dsh-client-modules/client.js', '/plugins/']);
check('scriptEvidence:非插件脚本(应用自己的外壳 bundle)→ 包名 null + 「不是插件脚本」,文件仍是它自己',
	(() => {
		box.state.precise = true;
		const url = 'http://127.0.0.1:3080/assets/index-abc.js';
		const ev = EX.scriptEvidence({ url, ms: 3 }, url);
		return [ev.pkg, ev.pkgVia, ev.file, EX.viaText(ev.pkgVia)];
	})(),
	[null, 'not-plugin', '/assets/index-abc.js', '不是插件脚本']);
// ── 口径:合并批的行号不是 file 里的行 —— 不许拼成 file:line ─────────────
check('合并批:文件与行号**分列**(行号是合并大文件里的行,不是包内文件的第 N 行)',
	(() => {
		const ev = { fn: 'run', ms: 1, pkg: 'dsh-b', pkgVia: 'section', file: '/plugins/dsh-b/client.js', line: 25580, lineVia: 'text', lineScope: 'bundle' };
		return [EX.evidencePlace(ev), EX.evidenceLine(ev), EX.evidenceWhereText(ev)];
	})(),
	['/plugins/dsh-b/client.js', 'run @ dsh-b · /plugins/dsh-b/client.js · 合并脚本行 25580 · 1ms · pkg=section line=text', '/plugins/dsh-b/client.js · 合并脚本行 25580 · 分段推断 / 直接读出来']);
check('单包 URL:行号就属于那个文件,照旧拼成 file:line(同一个坐标系)',
	EX.evidencePlace({ fn: 'x', ms: 1, pkg: 'dsh-a', pkgVia: 'url', file: '/plugins/dsh-a/client.js', line: 42, lineVia: 'text', lineScope: 'file' }),
	'/plugins/dsh-a/client.js:42');
// 老事故包没有 lineScope:由 incidentScriptEvidence 按 pkgVia 现推(分段表算出来的包 ⇒ bundle)
check('老包缺 lineScope:按 pkgVia 现推 —— section ⇒ bundle(不拼冒号),url ⇒ file(拼冒号)',
	(() => {
		const stored = { u: 0, ms: 7, fn: 'run', pkg: 'dsh-b', pkgVia: 'section', file: '/plugins/dsh-b/client.js', line: 7, lineVia: 'text' };
		const bundle = EX.incidentScriptEvidence(stored, 'http://h/plugins/??a/client.js,b/client.js&rev=1', null);
		const single = EX.incidentScriptEvidence({ ...stored, pkg: 'dsh-a', pkgVia: 'url', file: '/plugins/dsh-a/client.js' }, 'http://h/plugins/dsh-a/client.js', null);
		return [bundle.lineScope, EX.evidencePlace(bundle), single.lineScope, EX.evidencePlace(single)];
	})(),
	['bundle', '/plugins/dsh-b/client.js', 'file', '/plugins/dsh-a/client.js:7']);
check('证据行:自描述、可粘给别人(名字 @ 包 · 文件:行 · 耗时 · 来源 · 两个 via 码)',
	EX.evidenceLine({ fn: 'renderChat', ms: 210, pkg: 'dsh-status-rotator', pkgVia: 'section', file: '/plugins/dsh-status-rotator/client.js', line: 7, lineVia: 'text', invoker: 'TimerHandler:setTimeout' }),
	'renderChat @ dsh-status-rotator · /plugins/dsh-status-rotator/client.js:7 · 210ms · 来源 TimerHandler:setTimeout · pkg=section line=text');
check('证据行:字段缺失不抛错也不渲染 undefined(事故包可能是加这几个字段之前存的)',
	(() => {
		const line = EX.evidenceLine({ ms: 12, pkg: 'dsh-x' });
		return [typeof line, line.includes('undefined'), line.includes('函数名未记录'), line.includes('12ms'), line.includes('pkg=- line=-')];
	})(), ['string', false, true, true, true]);
check('证据行:有行号但拿不到文件时,写明「文件未定名」而不是留空(留空会被读成"没有位置")',
	EX.evidencePlace({ file: null, url: null, line: 5 }), '文件未定名:5');
check('证据行:<函数> @ <包> 缺哪一半就写哪一半', [
	EX.evidenceName({ fn: 'render', pkg: 'dsh-x' }), EX.evidenceName({ fn: null, pkg: 'dsh-x' }), EX.evidenceName({ fn: 'render', pkg: null }),
], ['render @ dsh-x', '函数名未记录 @ dsh-x', 'render @ 包未定名 · 未定位']);
check('证据行:一条定位字段都没有的行就地标「未定位」(压缩脚本里很常见,别让它冒充线索)', [
	EX.evidenceName({ fn: null, pkg: null }),
	EX.evidenceName({ fn: null, pkg: null, file: null }),
	EX.evidenceName({ fn: 'Rx', pkg: null }),
	EX.evidenceName({ fn: 'Rx', pkg: null, file: '/plugins/x/client.js' }),
], ['函数名未记录 @ 包未定名 · 未定位', '函数名未记录 @ 包未定名 · 未定位', 'Rx @ 包未定名 · 未定位', 'Rx @ 包未定名']);
check('证据行:位置拿不到文件就退回脚本名,两个都没有才 null',
	[EX.evidencePlace({ file: null, url: 'http://h/a.js', line: null }), EX.evidencePlace({ file: null, url: null, line: null }), EX.evidencePlace({ file: '/p/a.js', line: 3 })],
	['http://h/a.js', null, '/p/a.js:3']);
check('事故的证据行只取前 EVIDENCE_MAX 条(面板与交接件同一份口径)',
	(() => {
		const top = [];
		for (let i = 0; i < 9; i += 1) top.push({ ms: i, fn: `f${i}`, pkg: 'dsh-x', file: '/p/a.js', line: i });
		const lines = EX.incidentEvidenceLines({ summary: { topScripts: top } });
		return [lines.length, EX.EVIDENCE_MAX, lines[0].includes('f0'), lines[lines.length - 1].includes(`f${EX.EVIDENCE_MAX - 1}`)];
	})(), [4, 4, true, true]);
check('复制摘要:不在留存清单里的 id → 选不中,返回 false(不静默成功)',
	(() => { box.state.watch.incidents.length = 0; const ok = EX.selectIncident('i84'); return ok; })(), false);
check('复制失败要如实说:环境没有剪贴板 API 时 copyNote 写的是失败原文(不是"已复制")',
	(() => {
		box.state.copyNote = null;
		EX.copyText('x', '复制摘要');
		const note = box.state.copyNote;
		box.state.copyNote = null;
		return [typeof note, note.includes('复制失败'), note.includes('已复制')];
	})(), ['string', true, false]);

// 布局动作:两条都要有真实行为,而且「恢复默认布局」比「全部折叠」多清两个上下文选择
check('全部折叠:组全收起并落盘,但**不动**翻帧与事故选中',
	(() => {
		for (const key of Object.keys(box.state.groups)) box.state.groups[key] = true;
		box.state.watch.pickT = 123;
		box.state.watch.selId = 'i84';
		EX.collapseAll();
		const result = [JSON.stringify(box.state.groups), box.state.watch.pickT, box.state.watch.selId, JSON.parse(box.storage.getItem('dsh-perf-hud:groups')).detail];
		box.state.watch.pickT = null;
		box.state.watch.selId = null;
		return result;
	})(), ['{"detail":false,"cross":false,"dom":false,"host":false,"tools":false,"tech":false}', 123, 'i84', false]);
check('恢复默认布局:再清掉翻帧钉住与事故选中(真正回到干净首屏)',
	(() => {
		for (const key of Object.keys(box.state.groups)) box.state.groups[key] = true;
		box.state.watch.pickT = 123;
		box.state.watch.selId = 'i84';
		box.state.copyNote = '已复制 · 名称';
		box.state.pickNote = '帧环里没有这条事故附近的帧';
		EX.resetLayout();
		return [JSON.stringify(box.state.groups), box.state.watch.pickT, box.state.watch.selId, box.state.copyNote, box.state.pickNote];
	})(), ['{"detail":false,"cross":false,"dom":false,"host":false,"tools":false,"tech":false}', null, null, null, null]);

// ── 事故 ⇒ 历史帧:切到历史事故上下文,选中这条事故里最差的那一帧 ──────────────
// 以前这里走的是"在当前帧环里找一条离事故最近、且落在窗口内的帧"(就近定位)—— 那条路
// 在跨会话读回时只能给 null,而且会把实时帧环里的另一条帧当成这条事故的证据。现在帧来自
// 事故包自己(`incident.frames`),所以不再需要那个距离启发式(函数已删,有断言钉着)。
check('就近定位那条老路已经删掉(事故包自带的帧才是证据,不再从帧环里猜)',
	/frameNearestIncident/.test(source), false);
check('宿主 event-loop:p50/p99/**max** 三个都给(max 才看得出偶发的秒级停顿)',
	[EX.hostLoopText({ p50: 1.28, p99: 1.79, max: 610.5 }), EX.hostLoopText({ p50: 1.28, p99: 1.79 }), EX.hostLoopText(null)],
	['p50 1.28ms · p99 1.79ms · 最大 610.5ms', 'p50 1.28ms · p99 1.79ms', '未采集']);
const revealRow = {
	id: 'i84', cause: 'frame', severity: 326, at: incidentAt.toISOString(),
	window: { fromMs: 0, toMs: 13000 },
	frames: [{ t: 1000, ms: 16.7, gap: false }, { t: 1100, ms: 320, gap: false }, { t: 1200, ms: 21, gap: false }],
	loaf: [], summary: { topScripts: [], pkgCoverage: { resolved: 0, total: 0 } },
};
check('「看这一帧」:切到历史事故上下文 + 展开取证明细 + 选中事故里最差的那一帧;实时那一侧的选中**不动**',
	(() => {
		box.state.watch.incidents.length = 0;
		box.state.watch.incidents.push(revealRow);
		box.state.watch.mode = 'live';
		box.state.watch.frameT = null;
		box.state.watch.pickT = 999;
		box.state.watch.selId = null;
		box.state.groups.detail = false;
		box.state.pickNote = 'stale';
		const ok = EX.revealIncident('i84');
		const result = [ok, box.state.watch.mode, box.state.watch.selId, box.state.groups.detail,
			box.state.watch.frameT, box.state.watch.pickT, EX.selectedIncidentFrame(box.state.watch.incidents[0]).t, box.state.pickNote];
		box.state.watch.incidents.length = 0;
		box.state.groups.detail = false;
		box.state.watch.mode = 'live';
		box.state.watch.pickT = null;
		box.state.watch.selId = null;
		box.state.pickNote = null;
		return result;
	})(), [true, 'incident', 'i84', true, null, 999, 1100, null]);
check('「看这一帧」:包里一条帧记录都没有(老包)时留一句**如实说明**,不假装有帧可看',
	(() => {
		box.state.watch.incidents.length = 0;
		box.state.watch.incidents.push({ ...incidentRow, frames: [], loaf: [] });
		box.state.pickNote = null;
		box.state.groups.detail = false;
		const ok = EX.revealIncident('i84');
		const note = box.state.pickNote;
		const result = [ok, typeof note, note.includes('没有帧记录'), EX.selectedIncidentFrame({ ...incidentRow, frames: [] })];
		box.state.watch.incidents.length = 0;
		box.state.pickNote = null;
		box.state.groups.detail = false;
		return result;
	})(), [true, 'string', true, null]);
check('回到实时:只切模式,实时采集与历史那一侧的选中都不动',
	(() => {
		box.state.watch.mode = 'incident';
		box.state.watch.frameT = 1100;
		box.state.copyNote = '已复制';
		box.state.pickNote = 'x';
		EX.showLiveMode();
		const result = [box.state.watch.mode, box.state.watch.frameT, box.state.copyNote, box.state.pickNote];
		box.state.watch.frameT = null;
		return result;
	})(), ['live', 1100, null, null]);
check('「看这一帧」:事故不在留存清单里时什么都不改,返回 false',
	(() => {
		box.state.watch.selId = null;
		box.state.watch.mode = 'live';
		box.state.groups.detail = false;
		const ok = EX.revealIncident('nope');
		const result = [ok, box.state.watch.selId, box.state.groups.detail, box.state.watch.mode];
		box.state.groups.detail = false;
		return result;
	})(), [false, null, false, 'live']);
check('详情区的上下文标题:历史事故与实时两种模式**各自写明自己是哪一个**(不许有歧义)',
	[
		EX.incidentFrameHeadingText({ id: 'i12' }, { t: 3000, ms: 984 }, { index: 3, count: 305 }),
		EX.incidentFrameHeadingText({ id: 'i12' }, null, { index: 0, count: 0 }),
		EX.liveFrameHeadingText({ t: 1, dur: 21 }),
	],
	['历史事故 i12 · 历史帧 3/305', '历史事故 i12 · 历史帧', '实时监控 · 当前帧']);
check('折叠摘要也带上下文:历史事故模式下给的是历史帧的序号与耗时',
	(() => {
		const saved = box.state.watch.incidents.slice();
		const savedMode = box.state.watch.mode;
		const savedSel = box.state.watch.selId;
		box.state.watch.incidents.length = 0;
		box.state.watch.incidents.push(revealRow);
		box.state.watch.mode = 'incident';
		box.state.watch.selId = 'i84';
		box.state.watch.frameT = 1100;
		const text = EX.detailSummary();
		box.state.watch.incidents.length = 0;
		for (const row of saved) box.state.watch.incidents.push(row);
		box.state.watch.mode = savedMode;
		box.state.watch.selId = savedSel;
		box.state.watch.frameT = null;
		return text;
	})(), '历史帧 2/3 · 320ms');
check('折叠组标题:历史事故模式下带上事故 id(折叠着也能看出在看哪一条)',
	(() => {
		const saved = box.state.watch.incidents.slice();
		const savedMode = box.state.watch.mode;
		const savedSel = box.state.watch.selId;
		box.state.watch.incidents.length = 0;
		box.state.watch.incidents.push(revealRow);
		box.state.watch.mode = 'incident';
		box.state.watch.selId = 'i84';
		const text = EX.detailGroupLabel();
		box.state.watch.incidents.length = 0;
		for (const row of saved) box.state.watch.incidents.push(row);
		box.state.watch.mode = savedMode;
		box.state.watch.selId = savedSel;
		return text;
	})(), '取证明细 · i84');

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

// 仪器自检:节点数凑不稳 >50ms,所以明着烧一段,并且必须把"人为燃烧"写在面板上
box.setFlushSync(null);

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
// A2:跨会话基线的口径必须写在文件里 —— 它是粗参照,不是回归判定
check('A2:导出件带跨会话基线(这个盒子里没有帧环 → 空数组,note 写明口径)',
	[Array.isArray(exported.context.sessionBaselines.sessions), exported.context.sessionBaselines.sessions.length,
		exported.context.sessionBaselines.keep, /不是回归判定/.test(exported.context.sessionBaselines.note)],
	[true, 0, 20, true]);
check('timeline 带每秒曲线(60 秒切片已删:它是 samples 的子集,没有读者)',
	exported.timeline.samples.length === box.state.samplesLength && exported.timeline.last60s === undefined, true);
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
check('导出带 mapCache 上限与淘汰计数(不让缓存无声膨胀)',
	[exported.context.mapCache.max, exported.context.mapCache.evicted, exported.context.mapCache.failed], [8, 0, 0]);
check('导出带宿主事件计时回执',
	exported.host.eventWatch.installed === true && exported.verification.hostEvents.eventNames[0] === 'session/event', true);
check('verification 段声明了三段导出',
	JSON.stringify(exported.verification.exportSections), JSON.stringify(['timeline', 'longTasks', 'isolation']));
check('verification 段报出独立包名(不含合并包 key)与 longtask 命中',
	exported.verification.independentPackages.sample.includes('dsh-x')
	&& exported.verification.independentPackages.sample.every((id) => id.startsWith('bundle:') === false)
	&& exported.verification.longTask.attributed === 5 && exported.verification.longTask.withComponent === 1, true);

// ═══════════════ 导出脱敏(交给外部 AI 之前必须成立)═══════════════
// 这一组挡的是真事故:DSH 首屏是 `http://127.0.0.1:3080/?token=…` 进来的,
// 而 `location.href` 以前被原样写进 `page`。凭据、用户目录、自由文本三条都要有牙齿。
check('脱敏:页面地址丢查询串(DSH 首屏的 ?token=… 就藏在这里)',
	EX.redactPageUrl('http://127.0.0.1:3080/session/x?token=SECRET&a=1#/y'),
	'http://127.0.0.1:3080/session/x#/y');
check('脱敏:相对地址按当前页面补全,同样丢查询串',
	EX.redactPageUrl('/a/b?code=SECRET'), 'http://127.0.0.1:3080/a/b');
check('脱敏:脚本 URL 保留路径与 rev(rev 是证据,不能顺手删掉)',
	EX.redactScriptUrl('http://127.0.0.1:3080/plugins/??dsh-x/client.js&rev=abc'),
	'/plugins/??dsh-x/client.js&rev=abc');
check('脱敏:敏感参数只换值、保留键名(读的人才知道这里本来有什么)',
	EX.scrubParams('/p?token=abc&keep=1&api_key=zzz'),
	'/p?token=<redacted>&keep=1&api_key=<redacted>');
check('脱敏:键名清单里每一个都被正则认下(清单与正则不许漂移)',
	EX.SECRET_PARAM_NAMES.filter((name) => EX.SECRET_PARAM.test(name) === false), []);
check('脱敏:大小写不敏感(TOKEN / ApiKey 也算)',
	[EX.SECRET_PARAM.test('TOKEN'), EX.SECRET_PARAM.test('ApiKey'), EX.SECRET_PARAM.test('ok')], [true, true, false]);
check('脱敏:用户目录换成 ~(unix 与 windows 两种写法)',
	[EX.redactPath('/Users/tester/x/y.js'), EX.redactPath('C:\\Users\\tester\\x.js'), EX.redactPath('见 /home/tester/a.js 与无关文本')],
	['~/x/y.js', '~\\x.js', '见 ~/a.js 与无关文本']);
check('脱敏:UA 只留浏览器主版本 + 系统(完整 UA 能指纹到具体机器)',
	EX.redactUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36'),
	'Chrome/131 · Mac OS X 10_15_7');
check('脱敏:认不出来的 UA 如实说 unknown,不假装识别成功',
	EX.redactUserAgent('curl/8.7.1'), 'unknown-browser · unknown-os');
check('脱敏:数组里的脚本 URL 走脚本规则(不是页面规则)',
	EX.redactExport({ urls: ['http://h/plugins/??a/client.js&rev=1'] }).urls,
	['/plugins/??a/client.js&rev=1']);

// 端到端:把"带凭据的页面地址 + 用户目录 + 敏感参数"塞进真实状态,断言导出件里一个都不剩
box.location.href = 'http://127.0.0.1:3080/?token=SECRET_TOKEN_VALUE';
box.state.errors.push({ t: 1, iso: 'x', name: 'Error', message: 'boom at /Users/tester/app.js?api_key=SECRET_KEY_VALUE', stack: 'at /Users/tester/app.js:1:1', where: '' });
const leaky = JSON.stringify(box.EX.snapshot());
check('端到端:整机导出件里没有 token / 用户目录 / 敏感参数值',
	[/SECRET_TOKEN_VALUE/, /SECRET_KEY_VALUE/, /tester/].filter((re) => re.test(leaky)), []);
check('端到端:页面地址按当时的页面脱敏(路径保留、查询串丢弃)',
	[exported.page, JSON.parse(leaky).page],
	['http://127.0.0.1:3080/session/x', 'http://127.0.0.1:3080/']);
check('端到端:导出件自带 redaction 三问三答(applied / kept / neverCollected)',
	[exported.context.redaction.applied.length > 0, exported.context.redaction.kept.length > 0,
		exported.context.redaction.neverCollected.length > 0, Array.isArray(exported.context.redaction.freeText)],
	[true, true, true, true]);
check('端到端:不许把"做减法"说成"已匿名化"(口径要照实)',
	[/匿名化/.test(exported.context.redaction.rule), /做减法/.test(exported.context.redaction.rule)], [true, true]);

// ═══════════ 视图模型与主界面(方案 1 的第一屏)═══════════════
// 主界面只回答五个问题,所以这一组断言盯三件事:
//   ① 监测不可用时**不许**说"运行流畅"(必须给"监测受限" + 原因);
//   ② 主界面文案有长度预算(它是最挤的一屏,而且看不到浏览器渲染);
//   ③ 趋势那一行的三个数各有各的口径(次数不是留存数,重复线索只数留存下来的)。
box.state.on = false;
check('主界面:关掉 HUD 时说"监测受限"并给出原因,不许报"运行流畅"',
	(() => { const v = EX.healthVerdict(); return [v.level, EX.healthText(v.level), /关闭/.test(v.reason)]; })(),
	['limited', '监测受限', true]);
box.state.on = true;
box.state.watch.loafState = 'unsupported:no-loaf';
check('主界面:LoAF 装不上时也是"监测受限",理由带上原始状态',
	(() => { const v = EX.healthVerdict(); return [v.level, /未装上/.test(v.reason), /unsupported/.test(v.reason)]; })(),
	['limited', true, true]);
box.state.watch.loafState = 'on';
box.state.fps = 59;
box.state.frameWorst = 17;
check('主界面:采到了而且没到线 = 运行流畅', [EX.healthVerdict().level, EX.healthText('ok')], ['ok', '运行流畅']);
box.state.fps = 20;
check('主界面:帧档位与判色同源(fps 20 就是不流畅)',
	[EX.healthVerdict().level, EX.frameLevel(20, 17), EX.levelFrame(20, 17).includes('error')], ['stall', 'bad', true]);
box.state.fps = 59;
box.state.frameWorst = 130;
check('主界面:最差帧越过 120ms 也算"刚才有卡顿"(只看 fps 会漏)',
	[EX.healthVerdict().level, EX.frameLevel(59, 130)], ['stall', 'warn']);
box.state.frameWorst = 17;

check('主界面:三个档位的图标不一样(不能只靠颜色)',
	[EX.healthIcon('ok'), EX.healthIcon('stall'), EX.healthIcon('limited')], ['✓', '!', '—']);
check('主界面:秒数写法(毫秒读不出量级)', [EX.secondsText(326.5), EX.secondsText(980), EX.secondsText(0)], ['0.33 秒', '0.98 秒', '0.00 秒']);
check('主界面:最近一次卡顿的副行 ≤ 40 字(时间 + 现场有没有留住)',
	(() => {
		const text = EX.lastStallSubText({ at: '2026-10-12T12:30:39.000Z', kept: 'kept' });
		return [text.length <= 40, /已自动保存/.test(text)];
	})(), [true, true]);
check('主界面:现场没留住时照实说(不许默认"已保存")',
	/未完整保存/.test(EX.lastStallSubText({ at: '2026-10-12T12:30:39.000Z', kept: 'dropped' })), true);

// ── 趋势:三个数各有各的口径 ──
watchless: {
	const savedIncidents = box.state.watch.incidents.slice();
	box.state.watch.incidents.length = 0;
	EX.clearTally();
	const base = 1700000040000;
	EX.bumpTally('triggered', base - 60000);
	EX.bumpTally('triggered', base - 60000);
	EX.bumpTally('coalesced', base - 60000);
	// "最长一次"走的是严重度通道(不是 triggered 的累计),所以这里单独记一笔
	EX.noteTallySeverity(base - 60000, 300);
	box.state.watch.incidents.push(
		{ id: 'a', severity: 300, at: new Date(base - 120000).toISOString(), packages: [{ pkg: 'dsh-x', ms: 200, count: 2 }] },
		{ id: 'b', severity: 150, at: new Date(base - 240000).toISOString(), packages: [{ pkg: 'dsh-x', ms: 90, count: 1 }] });
	const trend = EX.trendSummary(3600000, base);
	check('趋势:检测到 2 次(triggered)· 最长一次取 max · 重复线索按留存清单数',
		[trend.detected, trend.kept, trend.repeated === null ? null : trend.repeated.name, trend.repeated === null ? null : trend.repeated.count],
		[2, 2, 'dsh-x', 2]);
	check('趋势:「重复线索」默认只说是同一个脚本模块,包名只在原始线索那一行(展开区才出)',
		[EX.trendText(3600000, base).includes('dsh-x'), /同一个脚本模块/.test(EX.trendText(3600000, base)),
			/重复线索:dsh-x/.test(EX.trendRawText(3600000, base))],
		[false, true, true]);
	check('趋势:没有重复线索时原始线索给 null(不编一行空的)', EX.trendRawText(60000, base), null);
	check('趋势:那一行的三个数各有各的名字,而且 ≤ 60 字(主界面最挤的一行)',
		(() => { const text = EX.trendText(3600000, base); return [text.length <= 60, /2 次卡顿/.test(text), /最长一次/.test(text), /重复线索/.test(text)]; })(),
		[true, true, true, true]);
	check('趋势:没有卡顿时给一句人话,不是"0 次"(不显示零值)',
		[EX.trendText(3600000, base + 7200000), EX.trendText(60000, base)], ['这段时间没有检测到卡顿', '这段时间没有检测到卡顿']);
	check('趋势:只出现一次不算"重复线索"', (() => {
		box.state.watch.incidents.length = 1;
		return EX.repeatedLead(3600000, base);
	})(), null);
	box.state.watch.incidents.length = 0;
	for (const row of savedIncidents) box.state.watch.incidents.push(row);
	EX.clearTally();
}

// ═══════════ P1:诊断包 ZIP(store 模式,零依赖)═══════════════
// 这一组盯四件事:CRC32 是不是标准那个、zip 的三个结构在不在、目录里的长度/CRC 与内容对得上、
// 以及"一个 zip 一次下载"这条真的接上了(不是只写了个函数没接线)。
check('ZIP:CRC32 是标准的那个(空串 0 / "123456789" = 0xCBF43926 / "a" = 0xE8B7BE43)',
	[EX.crc32(EX.utf8Bytes('')), EX.crc32(EX.utf8Bytes('123456789')), EX.crc32(EX.utf8Bytes('a'))],
	[0, 0xCBF43926, 0xE8B7BE43]);
check('ZIP:中文内容按 UTF-8 字节算长度(不是字符数)',
	[EX.utf8Bytes('中文').length, EX.utf8Bytes('a').length], [6, 1]);
check('ZIP:DOS 时间戳落在年份 >= 1980 的合法范围里(1980 之前会被截到 1980)',
	(() => {
		const early = EX.dosStamp(Date.parse('1970-01-02T03:04:05Z'));
		const later = EX.dosStamp(Date.parse('2026-10-13T10:20:30Z'));
		return [((early.date >> 9) & 0x7F) + 1980, ((later.date >> 9) & 0x7F) + 1980, later.time !== early.time];
	})(), [1980, 2026, true]);

// ── zip 结构的字节级断言 ──
const zipFiles = [{ name: 'a.txt', text: 'hello' }, { name: 'b.md', text: '# 中文内容\n第二行\n' }];
const zipBytes = EX.zipStore(zipFiles, Date.parse('2026-10-13T10:20:30Z'));
const zipView = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
const readName = (at, len) => new TextDecoder().decode(zipBytes.subarray(at, at + len));
check('ZIP:开头是本地文件头签名(0x04034B50),结尾是 EOCD(0x06054B50)',
	[zipView.getUint32(0, true), zipView.getUint32(zipBytes.length - 22, true)], [0x04034B50, 0x06054B50]);
check('ZIP:EOCD 里的条目数与中央目录偏移都对得上',
	(() => {
		const eocdAt = zipBytes.length - 22;
		const count = zipView.getUint16(eocdAt + 10, true);
		const centralAt = zipView.getUint32(eocdAt + 16, true);
		return [count, zipView.getUint32(centralAt, true), readName(centralAt + 46, zipView.getUint16(centralAt + 28, true))];
	})(), [2, 0x02014B50, 'a.txt']);
check('ZIP:本地头的 CRC 就是内容字节的 CRC32(解压器据它判 bad CRC)',
	(() => {
		const crc = zipView.getUint32(14, true);
		const size = zipView.getUint32(18, true);
		const nameLen = zipView.getUint16(26, true);
		const data = zipBytes.subarray(30 + nameLen, 30 + nameLen + size);
		return [crc, EX.crc32(data), new TextDecoder().decode(data)];
	})(), [EX.crc32(EX.utf8Bytes('hello')), EX.crc32(EX.utf8Bytes('hello')), 'hello']);
check('ZIP:压缩方式必须是 store(0) —— 本实现不压缩,声明成 8 就会解压失败',
	[zipView.getUint16(8, true), zipView.getUint16(6, true) & 0x0800], [0, 0x0800]);
check('ZIP:体积 = 各份内容之和 + 目录开销(store 模式不会变小,但也不会离谱)',
	(() => {
		const raw = zipFiles.reduce((sum, file) => sum + EX.utf8Bytes(file.text).length, 0);
		return [zipBytes.length > raw, zipBytes.length < raw + 2 * 100];
	})(), [true, true]);
check('ZIP:空文件清单也能打包(不抛错,给一个只有 EOCD 的合法 zip)',
	(() => { const empty = EX.zipStore([], 0); return [empty.length, new DataView(empty.buffer).getUint32(0, true)]; })(),
	[22, 0x06054B50]);

// ── 接线:两条路径都要 zip,而且文件名分得清 ──
check('ZIP:导出走的是一个 zip 一次下载(不再逐个下载文件),两条路径的文件名带 -ai / -full',
	(() => {
		return [/const bytes = zipStore\(pack\.files\);/, /link\.download = `\$\{base\}\$\{opts\.dropFreeText === true \? '-ai' : '-full'\}\.zip`;/,
			/'application\/zip'/.test(allSource), /exportPack\(id, opts\)/.test(allSource) === false]
			.map(Boolean);
	})(), [true, true, true, true]);
check('ZIP:预览里给的是压缩包总大小(zipBytes),而且"zip 是下一步"那句过渡文案已删',
	[/(\s)zipBytes,/.test(allSource), /zipStore\(list\)\.length/.test(allSource), /一次打包成一个 zip 是下一步/.test(allSource), /bundling them into one zip is the next step/.test(allSource)],
	[true, true, false, false]);
check('ZIP:验收口子给的是 zip 的 base64(验收器拿它去 unzip -t)',
	[/function zipBase64\(/, /zip: \(id, options\) => \{/, /zipBase64\(zipStore\(pack\.files\)\)/].map((re) => re.test(source)),
	[true, true, true]);

// ═══════════ 能力矩阵 / 可能原因 / 诊断包(P0.2 + P0.3)═══════════════
// 这一组挡的是:① "哪一层没采到"被写成一句没人能核的话;② 把"耗时最高的包"说成根因;
// ③ 诊断包与面板各说各话(所以两边读的是同一批纯函数)。
const causeRow = {
	id: 'i9', at: '2026-10-11T15:00:00.000Z', cause: 'frame', severity: 326.5, note: null, kept: 'kept',
	window: { fromMs: 1000, toMs: 14000, preMs: 10000, postMs: 3000, from: '2026-10-11T14:59:57.000Z', to: '2026-10-11T15:00:10.000Z' },
	summary: {
		worstFrameMs: 326.5, worstFrameAt: '2026-10-11T15:00:00.000Z', frames: 300, framesOver50Ms: 20, framesOver100Ms: 12,
		hiddenGaps: 0, loafEntries: 5, blockingMs: 0, pkgCoverage: { resolved: 3, total: 4 },
		pkgVia: { section: 3, 'text-pending': 1 }, longTasksInWindow: 1, interactionsInWindow: 0,
		topScripts: [{ at: 1200, u: 0, ms: 180, fn: null, invoker: 'setTimeout', pkg: 'dsh-x', pkgVia: 'section', file: '/plugins/dsh-x/client.js', line: 40, lineScope: 'bundle' }],
		p50: 16.7, p90: 40, p99: 326.5, worstFrameJs: 'js', worstFrameNeighboursMs: 16.7, suspectedThrottle: false,
		streaming: false, visibility: 'visible',
	},
	urls: ['http://127.0.0.1:3080/plugins/??dsh-x/client.js&rev=1'],
	packages: [{ pkg: 'dsh-x', ms: 180, count: 3 }],
	frames: [{ t: 1200, ms: 326.5, gap: false }],
	loaf: [{ t: 1200, dur: 300, blocking: 0, scripts: [{ u: 0, ms: 180, fn: null, invoker: 'setTimeout' }] }],
	longTasks: [{ at: 1200, ms: 180, owner: 'dsh-x', component: 'ChatView', source: 'scheduler+render' }],
	interactions: [],
	host: { at: '2026-10-11T14:59:56.000Z', snapshotAgeMs: -4000, eventLoop: { p50: 1.2, p99: 9.9, max: 60 } },
	env: { precise: true, perfOrigin: '2026-10-11T14:59:00.000Z', utcOffsetMin: 480, viewport: '1600×900' },
};
const caps = EX.capabilities();
const capLeaves = [];
for (const group of ['renderer', 'host', 'link']) for (const [name, leaf] of Object.entries(caps[group])) capLeaves.push([`${group}.${name}`, leaf]);
check('能力矩阵:每个叶子都有 state / provenance / reason,且取值都在枚举里',
	capLeaves.every(([, leaf]) => ['on', 'degraded', 'off', 'unsupported'].includes(leaf.state)
		&& ['measured', 'inferred', 'unknown'].includes(leaf.provenance)
		&& typeof leaf.reason === 'string' && leaf.reason !== ''), true);
check('能力矩阵:renderer / host / link 三组齐全,且不观测的那一层单列(不假装有)', (() => {
	const ids = caps.unobserved.map((item) => item.id);
	return [capLeaves.length >= 8, ids.includes('electron-main'), ids.includes('gpu-compositor'), caps.schema];
})(), [true, true, true, 1]);
check('能力矩阵:没插桩时 DOM 写入是 off 且理由写明"深录没开"',
	[caps.renderer.domWrites.state, /深录/.test(caps.renderer.domWrites.reason)], ['off', true]);
check('能力矩阵:element timing 恒 unsupported(DSH 的 DOM 上没有那个属性)',
	[caps.renderer.elementTiming.state, caps.renderer.elementTiming.provenance], ['unsupported', 'unknown']);
check('能力矩阵:缺失声明由它推,而且保留了线上断言认的前缀', (() => {
	const gaps = EX.capabilityMissing(causeRow);
	const prefixes = ['devtools-trace:', 'interaction-breakdown:', 'compositor:', 'recorder-cost:', 'baseline:'];
	return [prefixes.every((p) => gaps.missing.some((line) => line.startsWith(p))), gaps.howToAdd.length >= 3,
		gaps.capabilities.schema === 1];
})(), [true, true, true]);

// ── 可能原因:候选假设 ──
const causes = EX.causeCandidates(causeRow);
check('可能原因:最多 3 条,每条都带非空的支持 / 限制 / 出处三档',
	[causes.length <= 3, causes.every((item) => item.basis.length > 0 && item.limits.length > 0
		&& ['measured', 'inferred', 'unknown'].includes(item.provenance))], [true, true]);
check('可能原因:每条限制里都有"不等于已定位根因"那句(不许把相关写成根因)',
	causes.every((item) => item.limits.some((line) => line.includes('不等于已定位根因'))), true);
check('可能原因:耗时最高的包只是"线索",名字与出处照实给;覆盖率高才升到"较强"', (() => {
	const full = EX.causeCandidates({ ...causeRow, summary: { ...causeRow.summary, pkgCoverage: { resolved: 4, total: 4 } } });
	return [causes[0].kind, causes[0].name, causes[0].strength, causes[0].provenance, full[0].strength];
})(), ['script', 'dsh-x', 'medium', 'inferred', 'strong']);
check('可能原因:覆盖率不到 100% 时把"还有几条没定名"写进限制里',
	causes[0].limits.some((line) => line.includes('1条脚本没定到包名')), true);
check('可能原因:宿主事件循环只在真的有快照且 p99 偏高时出现', (() => {
	const hot = EX.causeCandidates({ ...causeRow, host: { eventLoop: { p50: 3, p99: 180, max: 400 }, snapshotAgeMs: -2000 } });
	const cool = EX.causeCandidates({ ...causeRow, host: { eventLoop: { p50: 1, p99: 9, max: 30 }, snapshotAgeMs: -2000 } });
	return [hot.some((item) => item.kind === 'host'), cool.some((item) => item.kind === 'host'),
		cool.every((item) => item.provenance !== 'unknown')];
})(), [true, false, true]);
check('可能原因:没有 JS 证据时给"证据不足",而且**不**顺手写节流结论', (() => {
	const quiet = { ...causeRow, summary: { ...causeRow.summary, worstFrameJs: 'none', suspectedThrottle: false } };
	const list = EX.causeCandidates(quiet);
	const unknown = list.find((item) => item.kind === 'unknown');
	// "更像…节流"是**结论**的措辞,只有 suspectedThrottle 那一支才允许出现(:非这一支只能说"未观察到")
	return [unknown.strength, unknown.provenance, /更像/.test(unknown.basis.join('')), /未观察到/.test(unknown.basis.join(''))];
})(), ['none', 'unknown', false, true]);
check('可能原因:只有 suspectedThrottle 成立时才提"更像 rAF 挂起或浏览器节流"', (() => {
	const throttled = { ...causeRow, summary: { ...causeRow.summary, worstFrameJs: 'none', suspectedThrottle: true } };
	const list = EX.causeCandidates(throttled);
	const unknown = list.find((item) => item.kind === 'unknown');
	return [unknown.strength, /更像/.test(unknown.basis.join(''))];
})(), ['weak', true]);
check('可能原因:没有事故就返回空数组(不造候选)', [EX.causeCandidates(null), EX.causeCandidates(undefined)], [[], []]);

// ── 60 秒帧分布:分档边界 / 间隙不进分母 / 占比文本 ──
check('帧分布:分档边界落在 16.7 / 33.3 / 50 / 100(满帧 / 30–60 / 20–30 / 10–20fps / ≤10fps)',
	[16.7, 16.8, 33.3, 33.4, 50, 50.1, 100, 100.1, 619.5].map((ms) => EX.frameBucketOf(ms)),
	[0, 1, 1, 2, 2, 3, 3, 4, 4]);
check('帧分布:间隙不是帧、不进分母;没有帧时返回 null',
	(() => {
		const mix = EX.frameMix([
			{ t: 1, ms: 16.7, gap: false }, { t: 2, ms: 16.7, gap: false },
			{ t: 3, ms: 50, gap: false }, { t: 4, ms: 640, gap: true },
		]);
		return [mix.total, mix.counts.join(','),
			Math.round(mix.shares.reduce((sum, share) => sum + share, 0) * 1e9) / 1e9,
			EX.frameMix([]), EX.frameMix([{ t: 9, ms: 900, gap: true }])];
	})(), [3, '2,0,1,0,0', 1, null, null]);
check('帧分布:占比两位小数(3600 帧里 1 条 = 0.03%)、整数不带 .00、条数带千分位',
	[EX.frameMixPctText(1 / 3580), EX.frameMixPctText(0.9944), EX.frameMixPctText(0), EX.frameMixCountText(3580)],
	['0.03%', '99.44%', '0%', '3,580']);
check('帧分布:五档成表(标签 / 条数 / 占比),空窗口返回空数组',
	(() => {
		const rows = EX.frameMixRows(EX.frameMix([
			{ t: 1, ms: 16.7, gap: false }, { t: 2, ms: 60, gap: false },
		]));
		return [rows.length, rows[0].label, rows[0].pctText, rows[3].countText, rows[4].pctText, EX.frameMixRows(null)];
	})(), [5, '≤16.7', '50%', '1', '0%', []]);
check('可能原因:宿主那行的「最大」是事件循环 max,不再拿快照年龄冒充(曾印成「最大 -2248ms」)', (() => {
	const hot = EX.causeCandidates({ ...causeRow, host: { eventLoop: { p50: 3, p99: 180, max: 400 }, snapshotAgeMs: -2000 } });
	const host = hot.find((item) => item.kind === 'host');
	return [host.basis.join(' · ').includes('最大 400ms'), host.basis.join(' · ').includes('-2000') === false];
})(), [true, true]);
check('可能原因:同一组件命中多条 long task 时,累计数的是条数(曾把 5 条印成 1 次)', (() => {
	const row = { ...causeRow, longTasks: [
		{ at: 10, ms: 70, component: 'Sidebar', source: 'render' },
		{ at: 20, ms: 50, component: 'Sidebar', source: 'render' },
		{ at: 30, ms: 40, component: 'Other', source: 'render' },
	] };
	const item = EX.causeCandidates(row).find((entry) => entry.kind === 'longtask');
	return [item.name, item.basis[1]];
})(), ['Sidebar', '累计 2 次']);
check('可能原因:没有 JS 证据时「缺少证据」排第一,窗口级候选降为弱线索并写明范围', (() => {
	const row = {
		...causeRow,
		summary: { ...causeRow.summary, worstFrameJs: 'none', suspectedThrottle: true },
		host: { eventLoop: { p50: 1, p99: 88, max: 414 }, snapshotAgeMs: 2248 },
	};
	const list = EX.causeCandidates(row);
	const script = list.find((item) => item.kind === 'script');
	const lt = list.find((item) => item.kind === 'longtask');
	return [list[0].kind, list.length, script.strength, lt.strength,
		script.limits.some((line) => line.includes('没有时间重叠'))];
})(), ['unknown', 3, 'weak', 'weak', true]);

// ═══════════ 收尾:最近 vs 最差的语义分离 / 人话原因 / 两条导出路径 ═══════════
// 这一组盯三件事(都来自真实使用里"两个语义被混在一起"的教训):
//   ① 主界面说"最近一次"就必须是**时间最新**那条,不能是 `selectedIncident()` 的默认(最差);
//   ② 给普通用户的原因行里**不许出现包名 / 毫秒**(原始证据收进展开区);
//   ③ 两条导出路径只差自由文本,而且这件事要能被断言(不是靠文档说)。

// ── ① 最近 ≠ 最差 ──
{
	const saved = box.state.watch.incidents.slice();
	box.state.watch.incidents.length = 0;
	// 一条"很久以前的最差" + 一条"刚刚的小卡" —— 顺序也故意反着放,防止"取 list[0] 也算对"
	box.state.watch.incidents.push(
		{ id: 'old-worst', severity: 900, at: '2026-10-12T10:00:00.000Z', cause: 'frame' },
		{ id: 'new-small', severity: 120, at: '2026-10-12T12:00:00.000Z', cause: 'frame' });
	check('主界面「最近一次」取时间最新那条,而不是最差那条(两条语义不许混)',
		[EX.latestIncident().id, EX.selectedIncident().row.id], ['new-small', 'old-worst']);
	check('空留存清单时最近一次给 null(不伪造一条)',
		(() => { box.state.watch.incidents.length = 0; return EX.latestIncident(); })(), null);
	box.state.watch.incidents.length = 0;
	for (const row of saved) box.state.watch.incidents.push(row);
}
check('主界面只吃时间语义(结构上不碰 selectedIncident / 手选那套)', (() => {
	const seg = extract(renderSource, 'function mainView(');
	return [seg.includes('selectedIncident') === false, seg.includes('props.latest'), /const latestRow = latestIncident\(\);/.test(renderSource)];
})(), [true, true, true]);
check('主界面的人话行里没有 item.name(包名只在展开区出现)', (() => {
	const seg = extract(renderSource, 'function mainView(');
	const plainLine = /h\('div', \{ style: S\.blockLabel \}, `\$\{index \+ 1\}\. \$\{causePlainLead\(item\)\} · \$\{strengthText\(item\.strength\)\}`\)/.test(seg);
	const whyBranch = /props\.why !== true \? null : h\('div', null,[\s\S]{0,400}?short\(item\.name\)/.test(seg);
	return [plainLine, whyBranch];
})(), [true, true]);

// ── ② 人话原因:不出现包名 / 文件名 / 数字 ──
check('每一种候选都有对应的"人话"分类(四种都非空且不相同)', (() => {
	const kinds = ['script', 'longtask', 'host', 'unknown'];
	const texts = kinds.map((kind) => EX.causePlainLead({ kind }));
	return [texts.every((text) => typeof text === 'string' && text.length > 0), new Set(texts).size];
})(), [true, 4]);
check('人话行里不出现包名 / 文件名 / 毫秒(原始证据只在展开区与开发者详情)',
	['script', 'longtask', 'host', 'unknown']
		.map((kind) => EX.causePlainLead({ kind }))
		.filter((text) => /@|dsh-|\.js|[0-9]/.test(text)), []);
check('未知那一支说的是"缺少 JS 证据",不是"浏览器节流"(不越界下结论)',
	[/缺少/.test(EX.causePlainLead({ kind: 'unknown' })), /节流/.test(EX.causePlainLead({ kind: 'unknown' }))], [true, false]);

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
	// 时间条的常量是三条独立 const:按行取(extract 会去找 '{',对它们不适用)
	source.slice(source.indexOf('const SPARK_SECONDS'), source.indexOf('\n', source.indexOf('const SPARK_SECONDS'))),
	source.slice(source.indexOf('const SPARK_HEIGHT'), source.indexOf('\n', source.indexOf('const SPARK_HEIGHT'))),
	source.slice(source.indexOf('const SPARK_MAX_MS'), source.indexOf('\n', source.indexOf('const SPARK_MAX_MS'))),
	extract(source, 'function sparkBars('),
	extract(source, 'function sparkLevel('),
	extract(source, 'function sparkPickMap('),
	extract(source, 'function sparkCellTitle('),
	// A2 跨会话基线:常量按行取,函数照 extract
	source.slice(source.indexOf('const LS_SESSIONS'), source.indexOf('\n', source.indexOf('const LS_SESSIONS'))),
	source.slice(source.indexOf('const SESSION_KEEP'), source.indexOf('\n', source.indexOf('const SESSION_KEEP'))),
	extract(source, 'function sessionRecord('),
	extract(source, 'function readSessionBaselines('),
	extract(source, 'function mergeSessionBaseline('),
	extract(source, 'function saveSessionBaseline('),
	extract(source, 'function sessionBaselines('),
	extract(source, 'function watchInteraction('),
	extract(source, 'function startInteractions('),
	`${extract(source, 'const scriptTallyCache = ')};`,
	// 可疑脚本那一块最多列几条 —— 守夜盒的 evidenceScope 要用
	source.slice(source.indexOf('const EVIDENCE_MAX'), source.indexOf('\n', source.indexOf('const EVIDENCE_MAX'))),
	// 「包 × 来源」摘要的名字上限(折叠态那一行不许折成参差的两行)
	source.slice(source.indexOf('const CROSS_SUMMARY_NAME_MAX'), source.indexOf('\n', source.indexOf('const CROSS_SUMMARY_NAME_MAX'))),
	source.slice(source.indexOf('const CROSS_SUMMARY_SRC_MAX'), source.indexOf('\n', source.indexOf('const CROSS_SUMMARY_SRC_MAX'))),
	extract(source, 'function invokerLabel('),
	extract(source, 'function isShellScript('),
	extract(source, 'function tallyScripts('),
	extract(source, 'function scriptPkgTally('),
	extract(source, 'function framePkgTally('),
		source.slice(source.indexOf('const BUNDLE_PREFIX'), source.indexOf('\n', source.indexOf('const BUNDLE_PREFIX'))),
		source.slice(source.indexOf('const PLUGIN_URL'), source.indexOf('\n', source.indexOf('const PLUGIN_URL'))),
	extract(source, 'function ownerOfUrl('),
	extract(source, 'function unresolvedLabel('),
	extract(source, 'function shellSummary('),
	extract(source, 'function jsBreakdownText('),
	extract(source, 'function unattrText('),
	extract(source, 'function hitText('),
	extract(source, 'function unexplainedFrame('),
	extract(source, 'function spanText('),
	extract(source, 'function windowScopeText('),
	extract(source, 'function watchTrigger('),
	extract(source, 'function loafScripts('),
	extract(source, 'function wallClock('),
	extract(source, 'function watchFrame('),
	extract(source, 'function triggerCapture('),
	extract(source, 'function settleCapture('),
	extract(source, 'function keepIncident('),
	extract(source, 'function pruneIncidents('),
	extract(source, 'function dayKeyOf('),
	extract(source, 'function windowIntegrity('),
	extract(source, 'function assembleIncident('),
	extract(source, 'function captureNow('),
	extract(source, 'function watchStatus('),
	extract(source, 'function selectIncident('),
	extract(source, 'function setIncidentScope('),
	extract(source, 'function incidentScriptEvidence('),
	extract(source, 'function viaText('),
	extract(source, 'function evidenceName('),
	extract(source, 'function evidenceLocatable('),
	extract(source, 'function evidencePlace('),
	extract(source, 'function evidenceLine('),
	extract(source, 'function replayScope('),
	extract(source, 'function replayX('),
	extract(source, 'function replaySummaryText('),
	extract(source, 'function incidentEvidenceAt('),
	extract(source, 'function evidenceWhereText('),
	extract(source, 'function locatable('),
	extract(source, 'function evidenceScope('),
	extract(source, 'function evidenceZeroText('),
	extract(source, 'function evidenceFooter('),
	extract(source, 'function evidenceFooterTitle('),
	extract(source, 'function watchPanelText('),
	// 事故"选中的那条"这条上下文:文本函数跟的是 selectedIncident(),不是硬编码 incidents[0]
	extract(source, 'function incidentOwner('),
	extract(source, 'function selectedIncident('),
	extract(source, 'function watchSelectedText('),
	extract(source, 'function watchFlagText('),
	extract(source, 'function watchRowText('),
	extract(source, 'function perfOrigin('),
	extract(source, 'function saveIncidents('),
	extract(source, 'function restoreIncidents('),
	extract(source, 'function frameSplit('),
	extract(source, 'function splitLegend('),
	extract(source, 'function frameArcs('),
	extract(source, 'function whoRows('),
	extract(source, 'function crossTable('),
	extract(source, 'function crossSummary('),
	extract(source, 'function clipName('),
	extract(source, 'function barSegments('),
	extract(source, 'function worstLoaf('),
	extract(source, 'function frameSeverity('),
	extract(source, 'function loafRanks('),
	extract(source, 'function pickList('),
	extract(source, 'function pickedLoaf('),
	extract(source, 'function pickStep('),
	extract(source, 'function pickAuto('),
	extract(source, 'function pickIncident('),
	extract(source, 'function incidentFileName('),
	extract(source, 'function incidentReport('),
	extract(source, 'function round1('),
	// 诊断上下文 + 历史帧数据层(实时 / 历史两支的分流点)
	source.slice(source.indexOf('const LS_WATCHUI'), source.indexOf('\n', source.indexOf('const LS_WATCHUI'))),
	extract(source, 'function saveWatchUI('),
	extract(source, 'function restoreWatchUI('),
	extract(source, 'function diagMode('),
	extract(source, 'function incidentFrameRows('),
	extract(source, 'function incidentLoafAt('),
	extract(source, 'function incidentWorstFrame('),
	extract(source, 'function selectedIncidentFrame('),
	extract(source, 'function incidentFrameLevel('),
	extract(source, 'function incidentFrameHot('),
	extract(source, 'function incidentFrameNav('),
	extract(source, 'function selectIncidentFrame('),
	extract(source, 'function incidentFrameStep('),
	extract(source, 'function setOnlyBad('),
	extract(source, 'function showLiveMode('),
	extract(source, 'function incidentWallClock('),
	extract(source, 'function replayColumns('),
	extract(source, 'function replayCellTitle('),
	extract(source, 'function incidentScriptOf('),
	extract(source, 'function incidentFrameTally('),
	`${extract(source, 'const incidentTallyCache = ')};`,
	extract(source, 'function incidentWindowTally('),
	extract(source, 'function incidentFrameEvidenceRows('),
	extract(source, 'function blameText('),
	extract(source, 'function blameName('),
	extract(source, 'function looksLikeInfrastructure('),
	extract(source, 'function isRecorderName('),
	extract(source, 'function longTaskLabel('),
	extract(source, 'function incidentLongTasksAt('),
	extract(source, 'function incidentFrameHeadingText('),
	extract(source, 'function liveFrameHeadingText('),
	extract(source, 'function incidentVerdict('),
	extract(source, 'function verdictColor('),
	extract(source, 'function eventVerdictText('),
	extract(source, 'function detailContext('),
	// 导出脱敏:incidentReport 在守夜盒里被反复调用,这些函数少一个都会 ReferenceError
	line('const SECRET_PARAM_NAMES'),
	line('const SECRET_PARAM '),
	line('const HOME_PATH'),
	line('const WIN_HOME_PATH'),
	line('const PAGE_KEYS'),
	line('const SCRIPT_URL_KEYS'),
	line('const FREE_TEXT_KEYS'),
	// 捕获计数:triggerCapture / settleCapture / keepIncident / saveIncidents 都会调它
	// (桶常量 TALLY_* / LS_TALLY 在 watchSource 那一段里,随 slice 一起进来)
	extract(source, 'function tallyDayKey('),
	extract(source, 'function tallyBlank('),
	extract(source, 'function tallyBucketOf('),
	extract(source, 'function tallySum('),
	extract(source, 'function pruneTally('),
	extract(source, 'function bumpTally('),
	extract(source, 'function noteTallySeverity('),
	extract(source, 'function tallyWindow('),
	extract(source, 'function tallyOfDay('),
	extract(source, 'function tallyTitle('),
	extract(source, 'function tallyReport('),
	extract(source, 'function markTallyDirty('),
	extract(source, 'function saveTally('),
	extract(source, 'function restoreTally('),
	extract(source, 'function clearTally('),
	// 能力矩阵(事故包的缺失声明由它推)
	line('const MUT_SAMPLE'),
	line('const LS_VIEW'),
	line('const TALLY_TREND_SHORT_MS'),
	line('const TALLY_TREND_LONG_MS'),
	extract(source, 'function packGuard('),
	extract(source, 'function zipStore('),
	line('const CAUSE_MAX'),
	line('const PACK_SCHEMA_VERSION'),
	extract(source, 'function severityLevel('),
	extract(source, 'function severityText('),
	extract(source, 'function docLang('),
	extract(source, 'function provenanceText('),
	extract(source, 'function strengthText('),
	extract(source, 'function causeCandidates('),
	extract(source, 'function manifestFor('),
	extract(source, 'function diagnosticSummary('),
	extract(source, 'function packReadme('),
	extract(source, 'function buildPack('),
	extract(source, 'function packPreview('),
	// capabilities() 会遍历 bundleMaps(导出盒的 sandbox 里已经有这个桩)
	'const bundleMaps = new Map();',
	extract(source, 'function provenanceOf('),
	extract(source, 'function capabilities('),
	extract(source, 'function capabilityMissing('),
	extract(source, 'function scrubParams('),
	extract(source, 'function redactPageUrl('),
	extract(source, 'function redactScriptUrl('),
	extract(source, 'function redactPath('),
	extract(source, 'function redactUserAgent('),
	extract(source, 'function redactExport('),
	extract(source, 'function redactionReport('),
].join('\n');
const watchBox = new Function(`
	${watchPieces}
	let nowMs = 100000;
	let packApi = null;
	// 解析推进计数:client.js 里 scriptPkgTally 的缓存指纹带它(markResolved 在每个 entry.state 后推)
	let resolveSeq = 0;
	const resolveStamp = () => resolveSeq;
	const markResolved = () => { resolveSeq += 1; };
	const timers = [];
	const natives = {
		setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
		clearTimeout: () => {},
	};
	const performance = { now: () => nowMs, timeOrigin: 1700000000000 };
	const document = { visibilityState: 'visible' };
	const PKG = 'dsh-perf-hud';
	const REACT_INTERNAL = new Set(['react.element', 'react.internal']);
	const SELF_NAMES = new Set(['PerfHud', 'PerfHudStress', PKG]);
	// assembleIncident 会调用 packageOfScript:这里用桩把它隔离掉(真函数在上一个盒子里
	// 有 11 条断言),只验证"切片时确实记了 pkg / pkgVia 两个字段"这个契约。
	// 按 URL 查表 —— D5 的"脚本按包"要能给出不同的包名
	const pkgByUrl = new Map();
	const packageOfScript = (url) => pkgByUrl.get(url) ?? { pkg: null, via: 'stub' };
	// assembleIncident 现在用 scriptEvidence 算「文件 / 行号」;真函数(以及它依赖的 scriptPosition /
	// sectionPath / bundleMap)在导出盒里有断言,这里按同一条约定给个**桩** —— 只验证
	// "切片时会调用它,并把 file / line / lineVia 三个字段落到 summary.topScripts 上"这个契约。
	let evidenceCalls = 0;
	const scriptEvidence = (script, url) => {
		evidenceCalls += 1;
		const resolved = pkgByUrl.get(url) ?? { pkg: null, via: 'stub' };
		return {
			fn: script?.fn ?? null, ms: script?.ms ?? 0,
			pkg: resolved.pkg, pkgVia: resolved.via,
			file: url === '' ? null : '/plugins/stub/client.js', line: 7, lineVia: 'stub-text', lineScope: url === '' ? null : 'file',
			invoker: script?.invoker ?? null, invokerType: script?.invokerType ?? null,
			url: url === '' ? null : url,
		};
	};
	const location = { href: 'http://127.0.0.1:3080/' };
	const navigator = { userAgent: 'test-agent', hardwareConcurrency: 10 };
	const W = { innerWidth: 1600, innerHeight: 900, devicePixelRatio: 2 };
	// A4 的假 PerformanceObserver:能换 supportedEntryTypes、记账 observe() 的选项、按需投喂条目
	const observeCalls = [];
	const observers = [];
	function FakeObserver(callback) { this.callback = callback; observers.push(this); }
	FakeObserver.prototype.observe = function (options) { observeCalls.push(options); };
	FakeObserver.prototype.disconnect = function () { this.disconnected = true; };
	FakeObserver.supportedEntryTypes = ['event', 'element'];
	W.PerformanceObserver = FakeObserver;
	// 翻帧那两个函数会请求重绘:盒子里给一个不会抛的桩
	let dirty = false;
	const bump = () => {};
	// 面板文案用的两个桩:断言只检查"人看到的字",key 兜底返回 key 本身
	const translate = (key) => ({
		watch: '守夜', watchCaught: '抓到', watchWorst: '最差', watchRestored: '读回', watchOff: '未开录', watchNone: '还没抓到', watchPersistFailed: '落盘失败', watchTrimmed: '裁掉', times: ' 次',
		// 捕获计数(与留存分离)的文案:断言要看到真词,而不是 key
		watchDetected: '检测', watchKept: '已保存现场', watchLost: '丢失', tallyUnit: ' 份',
		causeScriptLead: '脚本耗时最高的包', causeLongTaskLead: '长任务归属', causeHostLead: '宿主事件循环', causeNoEvidenceLead: '缺少 JS 阻塞证据',
		causePlainScript: '某个脚本模块的耗时偏高', causePlainLongTask: '这一段时间里有较重的渲染任务', causePlainHost: '宿主进程那侧偏忙', causePlainUnknown: '缺少能解释这次停顿的 JS 证据',
		causeWhy: '为什么这样判断?', causeWhyHide: '收起', causeRawNote: '以下是原始证据',
		exportAiBtn: '导出诊断包(给 AI)', exportFullBtn: '完整技术导出(保留备注)',
		previewTitle: '导出预览(还没生成文件)', previewFiles: '文件', previewNotesDropped: '备注:已置空', previewNotesKept: '备注:保留', previewZip: '分别下载', previewGo: '生成并导出', previewCancel: '取消', previewExcludes: '本包不含',
		causeUnresolvedSuffix: '条脚本没定到包名', causeHostBasis: '事故前后的宿主事件循环', hostSnapshotNotInstant: '这份宿主快照每 10 秒采一次',
		strengthStrong: '线索较强', strengthMedium: '线索中等', strengthWeak: '线索较弱', strengthNone: '证据不足',
		provenanceMeasured: '直接测量', provenanceInferred: '归因推断', provenanceUnknown: '无法确认',
		pkgNamed: '定到包', scriptsUnit: '条脚本', maxLabel: '最大', hostShort: '宿主', cumulative: '累计', blame: '回调归因(耗时·下界)',
		tallyCoalesced: '同串触发', tallyCoalescedHint: '同一串卡顿里被并掉的触发数(密度,不是次数)',
		tallyScopeSuffix: '内,同一串卡顿算一次', tallyKeepHint: '受容量限制,不等于检测到', tallyWorst: '最长一次',
		evidenceLabel: '可疑脚本', evidenceScopeIncident: '事故', evidenceWindowPrefix: '窗口内', pkgNamed: '定到包', evidenceBundleLine: '合并脚本行',
		evidenceUnlocatable: '未定位', evidenceUnlocatableHint: '没有定位字段:函数名与包名都没有,别把它当线索',
		shellNote: '最大一块来自应用外壳(不是插件)', shellNoteHint: '外壳 bundle 不属于任何插件',
		legScope: '出处', fnUnknown: '函数名未记录', pkgUnresolvedShort: '包未定名', unblamed: '未归因',
		legSubtree: '子树', stressFromDom: 'DOM 写入', legFiber: 'fiber', legDom: 'DOM写入', legOwner: '包名', none: '无',
		evidenceInvoker: '来源', evidenceWhere: '位置', fnUnknown: '函数名未记录', pkgUnresolvedShort: '包未定名', fileUnresolved: '文件未定名',
		viaDirect: '直接读出来', viaInferred: '分段推断', viaNotPlugin: '不是插件脚本', viaFailed: '解析失败', viaUnavailable: '还没到位/拿不到', viaNotFetched: '还没预取(只有深录才拉脚本文本)',
		worstOne: '最差那条', sparkGap: '整格 rAF 挂起(间隙,不是卡顿)', sparkNoPick: '这一秒没有长动画帧,点不动', sparkPickHint: '点它 → 翻帧切到这一秒的长动画帧',
		pkgNone: '未定名', unblamed: '未归因', rest: '其余', none: '无', invokerUnknown: '来源未记录', notYet: '未采集',
		splitScript: '脚本', splitTask: '任务', splitRender: '渲染', splitTail: '样式+布局+绘制',
		jsExec: '纯执行', forcedShort: '强制', jsPause: '暂停',
		windowScope: '窗口', loafRows: '条长动画帧', spanOver: '跨', avgPerFrame: '平均每条脚本',
		needDeep: '要深录', scopeFrame: '本帧', bySource: '按来源', byPkg: '按包', pkgZeroNamed: '0 条定到名', scriptsUnit: '条脚本', pkgNamed: '定到包',
		hit: '命中', legFiber: 'fiber', legSubtree: '子树', legDom: 'DOM写入', legOwner: '包名', peak: '峰', framePickFiltered: '值得回看的帧',
		otherSources: '其余来源', srcNoUrl: '无 URL(内联脚本)', srcBatch: '插件批次(未按 sourcemap 拆)',
		crossNone: '没有可交叉的脚本', crossNoOverlap: 'Top3 之间没有交集', crossFailed: '交叉表算不出来', splitFailed: '这一帧的脚本拆解算不出来', rest: '其余',
		hourUnit: '小时', minUnit: '分', secUnit: '秒', framesUnit: ' 帧',
		replayGaps: 'rAF 挂起', replayNoLoaf: '这一帧附近没有长动画帧记录(窗口里没有 LoAF)',
		// 诊断包那一段用到的词条(缺了会退回 key,断言就看不到真词)
		packSummaryTitle: '# 性能事故诊断摘要', packSecSummary: '## 1. 摘要', integrityIncomplete: '现场不完整',
		packSecCandidates: '## 2. 最可能的假设(最多 3 条,每条都带支持与限制)', packSecMissing: '## 3. 缺失的证据',
		packSecNext: '## 4. 下一步验证', packSecMeta: '## 5. 元信息',
		packCauseLabel: '假设', packSupport: '支持', packLimits: '限制', packProvenance: '出处', packTier: '采集档位',
		packNoCandidate: '没有足够证据给出候选原因。', packPreviewNote: '导出前先看这份清单。',
		packReadmeTitle: '# 这份诊断包里有什么', packReadmeWhat: 'w', packReadmeHow: 'h', packReadmePrivacy: 'p', packReadmeNotes: 'n',
		sevLabel: '严重度', worstEvent: '最差事件', evWindow: '窗口', evOwner: '主要归属', deepShort: '深录', watch: '守夜', none: '无',
		verdictLabel: '归因状态', verdictConfirmed: '已确认', verdictSuspected: '可疑', verdictUnattributed: '未归因',
		ctxLive: '实时监控', ctxFrame: '当前帧', ctxIncident: '历史事故', ctxHistoryFrame: '历史帧', notYet: '未采集',
		sevBad: '严重', sevWarn: '警告', sevOk: '低于线', verdictLabel: '归因状态',
		verdictConfirmed: '已确认', verdictSuspected: '可疑', verdictUnattributed: '未归因',
		verdictConfirmedText: '该帧有直接测量到的 JS 阻塞证据,窗口内主要归属', verdictNotRootCause: '这只缩小到哪个包,不等于已定位根因',
		verdictSuspectedJsNoPkg: '有 JS 阻塞证据但没定到包名', verdictThrottleText: '更像 rAF 被挂起或浏览器节流', verdictNeighbours: '前后帧中位',
		verdictUnattributedText: '未观察到足以解释该帧的 JS 阻塞证据;请结合前后帧和时间间隙检查 rAF 挂起或浏览器节流',
		replayGapCell: '这段时间没有帧记录', replayCellPick: '点它 → 选中这一帧', replayCellCount: '这一格',
		pkgStoredHint: '存下来的包名', incidentWindowScopeHint: '事故窗口累计', pkgIncidentWindowHint: '事故窗口按包',
		evidenceHoverHint: '悬停看口径与缺口', frameEvidenceMissing: '这一帧没有脚本记录',
		evidenceCaliberPlain: '口径:函数名与毫秒由 LoAF 直接测量;合并批只给文件 + 「合并脚本行 N」。', evidenceMissingPlain: '缺:原始源码行号与调用栈。',
		splitScript: '脚本', splitTask: '任务', splitRender: '渲染', splitTail: '样式+布局+绘制',
	})[key] ?? key;
	// 面板渲染区那两个文案函数用到的短名(真实实现里是 short():去掉 scope 前缀)
	// 这里不用正则:盒子源码写在模板串里,反斜杠会被模板先吃掉
	const short = (id) => (id.startsWith('@') ? id.slice(id.indexOf('/') + 1) : id);
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
		bundleKeys: new Set(),
		longTasks: [],
		ltSeq: 0, ltDropped: 0,
		// 捕获计数的时间桶(与 client.js 的 state.tally 同形;手写桩,加字段要同步)
		tally: { minute: new Map(), day: new Map(), expiredBuckets: 0, expiredDays: 0, prunedMinute: -1, loadError: null, savedAt: 0, dirty: false, timer: 0 },
		view: 'main', devTab: 'frames', trendMs: TALLY_TREND_SHORT_MS,
		watch: { on: true, loaf: [], loafSeq: 0, loafDropped: 0, loafObserver: null, loafState: 'on', pickT: null, selId: null, mode: 'live', frameT: null, scope: 'worst', incidents: [], pending: null, pendingTimer: 0, seq: 0, captured: 0, coalesced: 0, dropped: 0, restored: 0, trimmedByBytes: 0, deduped: 0, coveredUntil: 0, persistError: null,
			// A4:交互计时的状态位(eventObserver 由 startInteractions 自己写)
			eventObserver: null, eventState: 'not-started', eventSupported: [], interactions: [], eventCount: 0, elementCount: 0 },
	};
	return {
		state, frameRing, watchTrigger, loafScripts, wallClock, watchFrame, triggerCapture, settleCapture,
		location,
		keepIncident, windowIntegrity, assembleIncident, captureNow, watchStatus, incidentReport, pickIncident, incidentFileName, frameSplit, worstLoaf, timers, store,
		loafRanks, pickList, pickedLoaf, pickStep, pickAuto, frameSeverity, PICK_MIN_MS, unresolvedLabel, crossTable, crossSummary, clipName,
		sparkBars, sparkLevel, SPARK_SECONDS, SPARK_HEIGHT, sparkPickMap, sparkCellTitle, markResolved,
		sessionRecord, readSessionBaselines, mergeSessionBaseline, saveSessionBaseline, sessionBaselines, scriptPkgTally, pkgByUrl,
		tallyScripts, framePkgTally, isShellScript, shellSummary, ownerOfUrl, whoRows, barSegments, jsBreakdownText, unattrText, hitText, unexplainedFrame, spanText, windowScopeText, splitLegend, frameArcs, invokerLabel,
		watchPanelText, watchSelectedText, watchRowText, watchFlagText, selectedIncident, selectIncident, setIncidentScope, evidenceScope, evidenceFooter, evidenceFooterTitle, evidenceZeroText, incidentScriptEvidence, incidentEvidenceAt, evidenceWhereText, evidenceLine, evidenceName, evidencePlace, replayScope, replayX, replaySummaryText, evidenceCalls: () => evidenceCalls,
		// 诊断上下文 + 历史帧数据层(逐帧回放)
		diagMode, incidentFrameRows, incidentLoafAt, incidentWorstFrame, selectedIncidentFrame, incidentFrameNav, incidentFrameHot, incidentFrameLevel, selectIncidentFrame, incidentFrameStep, setOnlyBad, showLiveMode, replayColumns, replayCellTitle, incidentWallClock, incidentFrameTally, incidentWindowTally, incidentFrameEvidenceRows, incidentLongTasksAt, longTaskLabel, incidentVerdict, verdictColor, incidentScriptOf, detailContext, incidentFrameHeadingText, liveFrameHeadingText, saveWatchUI, restoreWatchUI, LS_WATCHUI,
		saveIncidents, restoreIncidents, perfOrigin, setFail: (value) => { failWrites = value; }, WATCH_MAX_BYTES: WATCH_PERSIST_MAX_BYTES,
		WATCH: { frames: WATCH_FRAMES, loaf: WATCH_LOAF_MAX, script: WATCH_SCRIPT_MAX, keep: WATCH_INCIDENT_MAX, pre: WATCH_PRE_MS, post: WATCH_POST_MS, trigger: WATCH_TRIGGER_MS, gap: WATCH_GAP_MS, reaction: WATCH_REACTION_MS },
		replayCols: REPLAY_COLS,
		setNow: (value) => { nowMs = value; },
		startInteractions, watchInteraction, WATCH_EVENT_MAX,
		setEntryTypes: (types) => { FakeObserver.supportedEntryTypes = types; },
		observedOptions: () => observeCalls.map((options) => (options.type === 'event' ? 'event:' + options.durationThreshold : options.type)),
		emit: (rows) => { for (const entry of observers) entry.callback({ getEntries: () => rows }); },
		runTimer: (index) => timers[index].fn(),
		// 导出脱敏(直接测这几个纯函数,而不是绕过它们去测 snapshot)
		redactExport, redactPageUrl, redactScriptUrl, redactPath, redactUserAgent, scrubParams, redactionReport,
		SECRET_PARAM, SECRET_PARAM_NAMES,
		// 能力矩阵(事故包的缺失声明由它推)
		capabilities, capabilityMissing, causeCandidates,
		zipStore,
		manifestFor, diagnosticSummary, packReadme, buildPack, packPreview,
		setPackApi: (api) => { packApi = api; },
		// 捕获计数(与留存分离):桶 / 窗口 / 落盘
		tallyWindow, tallyOfDay, tallyTitle, tallyReport, bumpTally, noteTallySeverity, pruneTally,
		saveTally, restoreTally, clearTally, tallyDayKey, tallySum, TALLY_FIELDS, TALLY_MINUTES, TALLY_BUCKET_MS, TALLY_DAYS, LS_TALLY,
	};
`)();
const watch = watchBox;
watch.setPackApi(packChunk);

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
// ⚠️ 帧环必须保持"按时间升序"这条不变式(生产里每帧只经 rAF 循环 push 一次):这里用
// `triggerCapture` 直接起捕获(它不 push),而不是塞一个比最新帧更早的时刻进环 ——
// 构造出乱序的环会让 slice 的倒扫与正扫给出不同结果,那是假状态,不是真实回归。
watch.frameRing.reset();
watch.frameRing.push(5000, 16.66, false);
watch.frameRing.push(9900, 150, false);
watch.frameRing.push(10000, 20, false);
watch.frameRing.push(10020, 8000, true);
watch.frameRing.push(20000, 17, false);
watch.state.longTasks.push({ t: Date.now(), at: 9900, ms: 150, owner: 'dsh-x', component: 'ChatRow', source: 'scheduler+render' });
watch.setNow(100000);            // 远在 until 之后:立即结算
const firstIncident = watch.triggerCapture('frame', 10000, 150);
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
check('守夜行:带备注时列出最近一条(跟的是选中的那条事故)', (() => {
	watch.state.watch.incidents.unshift({ id: 'x1', severity: 12, cause: 'manual', at: '2026-10-07T00:00:00.000Z', note: '刚切了视图' });
	const text = watch.watchSelectedText();
	watch.state.watch.incidents.shift();     // 验完挪走:后面的 incidentReport(0) 还要靠真事故
	return text.includes('刚切了视图');
})(), true);
check('工具清单行:带序号与 id', watch.watchRowText({ id: 'x1', severity: 12, cause: 'manual', at: '2026-10-07T00:00:00.000Z', note: null }, 4).startsWith('5. x1 · manual · 12ms'), true);
check('工具清单行:选中的那条前面加 ●(清单按严重度排,不标出来会被读成时间序)', (() => {
	const row = { id: 'x1', severity: 12, cause: 'manual', at: '2026-10-07T00:00:00.000Z', note: null };
	watch.state.watch.selId = 'x1';
	const marked = watch.watchRowText(row, 4);
	watch.state.watch.selId = null;
	return marked.startsWith('● 5. x1 · manual');
})(), true);
check('守夜行:关掉时说未开录', (() => { watch.state.watch.on = false; const text = watch.watchPanelText(); watch.state.watch.on = true; return text; })(), '未开录');
check('守夜行:没抓到也照实说,并把阈值写出来', (() => {
	const keptRows = watch.state.watch.incidents.splice(0, watch.state.watch.incidents.length);
	const emptyText = watch.watchPanelText();
	const emptyLatest = watch.watchSelectedText();
	watch.state.watch.incidents.push(...keptRows);
	return emptyText.startsWith('还没抓到(≥100ms)') && emptyLatest === null;
})(), true);
// 事故选择:null = 自动跟最差那条;选的被挤出留存清单 → **退回自动**,不指着不存在的条目
check('事故选择:默认自动跟严重度最差那条(incidents 由 keepIncident 维持降序)',
	(() => { const pick = watch.selectedIncident(); return [pick.auto, pick.row.id]; })(), [true, watch.state.watch.incidents[0].id]);
check('事故选择:选中之后跟的是那一条,auto=false',
	(() => { watch.state.watch.selId = watch.state.watch.incidents[1].id; const pick = watch.selectedIncident(); watch.state.watch.selId = null; return [pick.auto, pick.row.id === watch.state.watch.incidents[1].id]; })(), [false, true]);
// ── 事故回放:只用事故包里存下来的东西(刷新生效),不新增采集 ─────────────
check('事故回放:没有事故 / 事故里没有帧 → null(不摆空条)',
	(() => {
		const saved = watch.state.watch.incidents.slice();
		watch.state.watch.incidents.length = 0;
		const none = watch.replayScope();
		watch.state.watch.incidents.push({ id: 'i0', severity: 200, at: '2026-10-12T09:00:00.000Z', cause: 'frame', summary: {} });
		const noFrames = watch.replayScope();
		watch.state.watch.incidents.length = 0;
		for (const r of saved) watch.state.watch.incidents.push(r);
		return [none, noFrames];
	})(),
	[null, null]);
check('事故回放:live 帧环为空(模拟刷新)也照样能回放 —— 数据全部来自事故包',
	(() => {
		const savedIncidents = watch.state.watch.incidents.slice();
		const savedLoaf = watch.state.watch.loaf.slice();
		watch.state.watch.incidents.length = 0;
		watch.state.watch.loaf.length = 0;      // 刷新后实时帧环是空的
		watch.state.watch.incidents.push({
			id: 'i80', severity: 320, at: '2026-10-12T12:00:00.000Z', cause: 'frame',
			window: { fromMs: 1000, toMs: 14000 },
			summary: { frames: 3, p50: 20, p99: 320, worstFrameMs: 320, hiddenGaps: 1 },
			frames: [
				{ t: 1000, ms: 20, gap: false },
				{ t: 6000, ms: 320, gap: false },
				{ t: 9000, ms: 0, gap: true },
			],
			loaf: [{ t: 6000, dur: 320, blocking: 40, renderStart: 6100, styleAndLayoutStart: 6200, scripts: [{ ms: 120, forcedMs: 10, pauseMs: 0 }] }],
		});
		const scope = watch.replayScope();
		const result = [
			scope === null ? null : scope.frames.length, scope.span, scope.gaps,
			scope.worst.ms, scope.split === null ? null : scope.split.total,
			watch.replaySummaryText(scope),
		];
		watch.state.watch.incidents.length = 0;
		for (const r of savedIncidents) watch.state.watch.incidents.push(r);
		watch.state.watch.loaf.length = 0;
		for (const r of savedLoaf) watch.state.watch.loaf.push(r);
		return result;
	})(),
	[3, 13000, 1, 320, 320,
		'窗口 13秒 · 3 帧 · p50 20ms · p99 320ms · 最差 320ms · rAF 挂起 1']);
check('事故回放横轴按**时间**放:起点 0、终点满宽、中间按比例、越界夹住(不是按序号)',
	[watch.replayX(1000, 1000, 13000, 1000), watch.replayX(14000, 1000, 13000, 1000), watch.replayX(7500, 1000, 13000, 1000), watch.replayX(0, 1000, 13000, 1000), watch.replayX(999999, 1000, 13000, 1000), watch.replayX(5, 0, 0, 1000)],
	[0, 1000, 500, 0, 1000, 0]);

// ── 历史事故的**逐帧**上下文:上下文隔离 / 帧条映射 / 四个方向的翻帧 ─────────────
// 这份 fixture 就是"事故包"该有的样子:frames(含一个 gap)、loaf(带存下来的 pkg/file/line)、
// longTasks、urls、env.perfOrigin(墙钟要靠它,不能用当前页面的 timeOrigin)。
const frameRow = {
	id: 'i12', cause: 'frame', severity: 984, at: '2026-10-12T15:33:35.000Z',
	env: { perfOrigin: new Date(1700000000000).toISOString() },
	window: { fromMs: 1000, toMs: 14000, from: 'x', to: 'y' },
	urls: ['http://h/plugins/dsh-a/client.js', 'http://h/plugins/dsh-b/client.js'],
	summary: {
		worstFrameMs: 984, frames: 5, loafEntries: 2, p50: 20, p99: 984, blockingMs: 130,
		worstFrameJs: 'js', worstFrameNeighboursMs: 21, pkgCoverage: { resolved: 2, total: 3 },
		topScripts: [{ u: 0, ms: 40, fn: 'run', pkg: 'dsh-a', pkgVia: 'url', file: '/plugins/dsh-a/client.js', line: 3, lineVia: 'text', lineScope: 'file' }],
	},
	frames: [
		{ t: 1000, ms: 16.7, gap: false },
		{ t: 2000, ms: 21, gap: false },
		{ t: 3000, ms: 984, gap: false },
		{ t: 4000, ms: 9000, gap: true },
		{ t: 13000, ms: 150, gap: false },
		{ t: 13500, ms: 60, gap: false },
	],
	loaf: [
		{
			t: 3000, dur: 984, blocking: 120, renderStart: 3100, styleAndLayoutStart: 3200,
			scripts: [{
				u: 1, ms: 300, forcedMs: 0, pauseMs: 0, fn: 'onmessage', charPos: 10,
				invoker: 'DOMWebSocket.onmessage', invokerType: 'user-callback',
				pkg: 'dsh-b', pkgVia: 'url', file: '/plugins/dsh-b/client.js', line: 12, lineVia: 'text', lineScope: 'file',
			}],
		},
		{ t: 13000, dur: 150, blocking: 10, renderStart: 13100, styleAndLayoutStart: 13150, scripts: [] },
	],
	longTasks: [{ at: 2500, t: Date.now(), ms: 600, owner: 'dsh-a', component: 'ChatView', source: 'scheduler+render' }],
};

const withIncident = (fn) => {
	const saved = watch.state.watch.incidents.slice();
	const savedLoaf = watch.state.watch.loaf.slice();
	const savedMode = watch.state.watch.mode;
	const savedFrameT = watch.state.watch.frameT;
	const savedSel = watch.state.watch.selId;
	watch.state.watch.incidents.length = 0;
	watch.state.watch.incidents.push(frameRow);
	watch.state.watch.mode = 'incident';
	watch.state.watch.selId = frameRow.id;
	watch.state.watch.frameT = null;
	const result = fn();
	watch.state.watch.incidents.length = 0;
	for (const row of saved) watch.state.watch.incidents.push(row);
	watch.state.watch.loaf.length = 0;
	for (const row of savedLoaf) watch.state.watch.loaf.push(row);
	watch.state.watch.mode = savedMode;
	watch.state.watch.frameT = savedFrameT;
	watch.state.watch.selId = savedSel;
	return result;
};

check('历史帧:gap(整段 rAF 被挂起)不算帧 —— 不参与序号、选中与翻帧',
	watch.incidentFrameRows(frameRow).map((frame) => frame.t), [1000, 2000, 3000, 13000, 13500]);
check('历史帧:默认选中最差那一帧(帧间隔口径,与事故严重度同一条)', watch.incidentWorstFrame(frameRow).t, 3000);
check('历史帧:选中的 t 在包内找不到 → 退回自动,不指着一个不存在的帧',
	(() => {
		watch.state.watch.frameT = 999999;
		const hit = watch.selectedIncidentFrame(frameRow);
		const cleared = watch.state.watch.frameT;
		watch.state.watch.frameT = null;
		return [hit.t, cleared];
	})(), [3000, null]);
check('历史帧:钉住之后就是那一帧(存 t 不存下标)', (() => {
	watch.state.watch.frameT = 2000;
	const hit = watch.selectedIncidentFrame(frameRow);
	watch.state.watch.frameT = null;
	return hit.t;
})(), 2000);
check('历史帧 ↔ LoAF:按**时间重叠**取那一条(这一帧没有重叠就是 null,不借别帧的)',
	[watch.incidentLoafAt(frameRow, { t: 3000, ms: 984 }).dur, watch.incidentLoafAt(frameRow, { t: 2000, ms: 21 }), watch.incidentLoafAt(frameRow, { t: 13500, ms: 60 })],
	[984, null, null]);
check('历史帧导航:序号 / 总数 / 上下一条有没有(没有就禁用,不留假按钮)',
	(() => {
		const nav = watch.incidentFrameNav(frameRow, { t: 3000, ms: 984 }, false);
		const last = watch.incidentFrameNav(frameRow, { t: 13500, ms: 60 }, false);
		return [nav.index, nav.count, nav.hasPrev, nav.hasNext, last.hasNext, last.hasPrev];
	})(),
	[3, 5, true, true, false, true]);
// 「只看异常」不是一个装饰开关:nav 的可用性判据与 step 的落点必须是同一件事,
// 否则会出现"按钮亮着、按下去不动"(那正是四个箭头并存时最容易出的错)。
check('历史帧导航:「只看异常」开着时,可用性按**异常帧**判(不是按"还有没有下一帧")',
	(() => {
		const hot = watch.incidentFrameNav(frameRow, { t: 3000, ms: 984 }, true);
		const tail = watch.incidentFrameNav(frameRow, { t: 13500, ms: 60 }, true);
		const mid = watch.incidentFrameNav(frameRow, { t: 2000, ms: 21 }, true);
		return [hot.hasPrev, hot.hasNext, tail.hasNext, tail.hasPrev, mid.hasPrev, mid.hasNext];
	})(),
	[false, true, false, true, false, true]);
check('历史帧翻帧:按**时间序**走一步(与帧条从左到右同一个方向),到头停住',
	withIncident(() => {
		const seq = [];
		watch.state.watch.frameT = 3000;
		watch.incidentFrameStep(1); seq.push(watch.state.watch.frameT);
		watch.incidentFrameStep(1); seq.push(watch.state.watch.frameT);
		watch.incidentFrameStep(1); seq.push(watch.state.watch.frameT);   // 已是最后一帧:不动
		watch.incidentFrameStep(-1); seq.push(watch.state.watch.frameT);
		return seq;
	}), [13000, 13500, 13500, 13000]);
check('「只看异常」:过滤器开着时 ◀ ▶ 只落在帧间隔 ≥ 守夜触发线的那些帧上(到不了就不动),关掉即恢复逐帧',
	withIncident(() => {
		watch.state.watch.frameT = 2000;
		watch.setOnlyBad(true);
		watch.incidentFrameStep(1); const next = watch.state.watch.frameT;        // 2000 → 3000(异常)
		watch.incidentFrameStep(1); const second = watch.state.watch.frameT;      // 3000 → 13000(异常)
		watch.incidentFrameStep(1); const none = watch.state.watch.frameT;        // 已是最后一条异常帧:不动
		watch.incidentFrameStep(-1); const back = watch.state.watch.frameT;       // 回 3000
		watch.state.watch.frameT = 13000;
		watch.incidentFrameStep(1); const blocked = watch.state.watch.frameT;     // 后面只剩不达线的帧:不动
		watch.setOnlyBad(false);
		watch.incidentFrameStep(1); const all = watch.state.watch.frameT;         // 关掉之后又是逐帧走
		return [next, second, none, back, blocked, all, watch.state.watch.onlyBad];
	}), [3000, 13000, 13000, 3000, 13000, 13500, false]);
check('事件横轴的墙钟:用**事故包自带的 perfOrigin**,不是当前页面的 timeOrigin(跨会话读回才算得对)',
	watch.incidentWallClock(frameRow, 3000), 1700000000000 + 3000);

// ── 上下文隔离:两个上下文各自吃自己那份数据(这次改版的核心)────────────────
check('诊断上下文:实时模式下即使选着一条事故,取证明细也只吃实时帧(不许"上面历史、下面实时"反过来)',
	(() => {
		watch.state.watch.mode = 'live';
		watch.state.watch.loaf.length = 0;
		watch.state.watch.loaf.push({ t: 9999, dur: 500, blocking: 50, scripts: [{ url: 'http://h/plugins/dsh-live/client.js', ms: 400, charPos: 0, fn: 'liveFn' }] });
		const saved = watch.state.watch.incidents.slice();
		watch.state.watch.incidents.length = 0;
		watch.state.watch.incidents.push(frameRow);
		const detail = watch.detailContext();
		watch.state.watch.incidents.length = 0;
		for (const row of saved) watch.state.watch.incidents.push(row);
		watch.state.watch.loaf.length = 0;
		return [detail.kind, detail.frame.t, detail.split.total];
	})(), ['live', 9999, 500]);
check('诊断上下文:历史事故模式下的帧 / 分解 / 证据全部来自事故包 —— 实时帧环里更大的那一帧一个字段都不进来',
	withIncident(() => {
		watch.state.watch.loaf.length = 0;
		watch.state.watch.loaf.push({ t: 9999, dur: 500, blocking: 50, scripts: [{ url: 'http://h/plugins/dsh-live/client.js', ms: 400, charPos: 0, fn: 'liveFn' }] });
		watch.state.watch.frameT = 3000;
		const detail = watch.detailContext();
		watch.state.watch.loaf.length = 0;
		return [
			detail.kind, detail.row.id, detail.frame.t, detail.nav.index, detail.nav.count,
			detail.split.total, detail.split.js,
			detail.evidence.label.includes('i12'), detail.evidence.label.includes('历史帧'),
			detail.evidence.rows.map((row) => row.fn),
			detail.evidence.rows.some((row) => row.fn === 'liveFn'),
		];
	}),
	['incident', 'i12', 3000, 3, 5, 984, 100, true, true, ['onmessage'], false]);
check('诊断上下文:没有可看的事故时不进历史模式(那样只会是一片缺失状态)',
	(() => {
		const saved = watch.state.watch.incidents.slice();
		watch.state.watch.incidents.length = 0;
		watch.state.watch.mode = 'incident';
		watch.state.watch.selId = 'i12';
		const mode = watch.diagMode();
		watch.state.watch.incidents.length = 0;
		for (const row of saved) watch.state.watch.incidents.push(row);
		watch.state.watch.mode = 'live';
		watch.state.watch.selId = null;
		return mode;
	})(), 'live');

// ── 历史帧条:按时间放、缺口留白、点击映射回**真实记录** ──────────────────────
check('帧条:几何按**时间**算(不是序号)—— 同一列里有多帧时留最差的那一帧,而且它一定是原数组里真实的帧',
	(() => {
		const columns = watch.replayColumns(frameRow);
		const withFrame = columns.cols.filter((cell) => cell !== null && cell.frame !== null);
		const gapOnly = columns.cols.filter((cell) => cell !== null && cell.frame === null);
		return [
			columns.liveCount, columns.gapCount,
			withFrame.every((cell) => frameRow.frames.includes(cell.frame)),
			// 那一格里面不是"合成"的一帧,而是 t=3000 那条(984ms)
			columns.cols.map((cell) => (cell === null || cell.frame === null ? null : cell.frame.t)).filter((t) => t !== null).slice(0, 3),
			gapOnly.length > 0,
			gapOnly.every((cell) => cell.level === 'gap'),
		];
	})(),
	[5, 1, true, [1000, 2000, 3000], true, true]);
check('帧条:rAF 挂起那一段**留白**(那一列没有可点的帧),不补桩成一根柱子',
	(() => {
		const columns = watch.replayColumns(frameRow);
		const index = watch.replayX(4000, columns.from, columns.span, watch.replayCols);
		const cell = columns.cols[index];
		return [cell === null || cell.frame === null, cell === null ? null : cell.level];
	})(), [true, 'gap']);
check('帧条:点得动的格子都能映射回真实帧;悬停给这一格那一帧的编号与耗时',
	(() => {
		const columns = watch.replayColumns(frameRow);
		const nav = watch.incidentFrameNav(frameRow, { t: 3000, ms: 984 });
		const cell = columns.cols.find((item) => item !== null && item.frame !== null && item.frame.t === 3000);
		return [cell.frame.t === 3000, watch.replayCellTitle(frameRow, cell, nav).includes('984ms'), watch.replayCellTitle(frameRow, cell, nav).includes('3/5')];
	})(), [true, true, true]);
check('帧条:绘制量有上限(一列最多一个 DOM 节点),真实帧数再多也不会把面板压垮',
	(() => {
		const many = { ...frameRow, frames: Array.from({ length: 900 }, (_, i) => ({ t: 1000 + i * 14, ms: 16.7, gap: false })) };
		const columns = watch.replayColumns(many);
		return [columns.cols.length <= watch.replayCols, columns.liveCount, columns.cols.filter((cell) => cell !== null).length <= watch.replayCols];
	})(), [true, 900, true]);

// ── 事故包的脚本聚合:用**存下来的** pkg(刷新之后仍然定得到名) ────────────────
check('历史帧的脚本聚合:按来源 / 按包都覆盖这一帧自己的脚本(与实时同一套 tallyScripts)',
	(() => {
		const frame = watch.incidentFrameTally(frameRow, { t: 3000, ms: 984 });
		const window = watch.incidentWindowTally(frameRow);
		return [frame.js, frame.byInvoker[0][0], frame.top[0][0], window.js, window.count];
	})(),
	[300, 'DOMWebSocket.onmessage', 'dsh-b', 300, 2]);
check('刷新(当前会话的 sourcemap 解析缓存全空)之后:历史事故的包名仍然是捕获时存下来的那个',
	withIncident(() => {
		watch.pkgByUrl.clear();
		watch.state.precise = false;
		const window = watch.incidentWindowTally(frameRow);
		const scope = watch.evidenceScope();
		return [window.top.map(([name]) => name), scope.rows[0].pkg, scope.rows[0].file, scope.rows[0].line];
	}),
	[['dsh-b'], 'dsh-b', '/plugins/dsh-b/client.js', 12]);
check('历史帧的证据:这一帧没有 LoAF 记录时退回**事故窗口内**的切片,并标明"不是这一帧的"(混入实时数据是不允许的)',
	withIncident(() => {
		watch.state.watch.frameT = 1000;      // 这一帧没有 LoAF
		watch.state.watch.loaf.length = 0;
		watch.state.watch.loaf.push({ t: 9999, dur: 500, scripts: [{ url: 'http://h/plugins/dsh-live/client.js', ms: 400, fn: 'liveFn' }] });
		const scope = watch.evidenceScope();
		const result = [scope.label.includes('窗口内'), scope.missing, scope.rows.map((row) => row.fn), scope.total];
		watch.state.watch.loaf.length = 0;
		return result;
	}),
	[true, true, ['run'], 3]);
check('long task 那一行:四条腿一条都没咬住时写「未归因」,不再显示 `? · TextPreview` 这种没信息的两截', [
	watch.longTaskLabel({ owner: null, component: null, subtreeComponent: null, domComponent: null, ms: 271 }),
	watch.longTaskLabel({ owner: null, component: 'ChatRow', subtreeComponent: null, domComponent: null, ms: 271 }),
	watch.longTaskLabel({ owner: 'dsh-x', component: null, subtreeComponent: null, domComponent: null, ms: 271 }),
	watch.longTaskLabel(null),
], ['未归因', 'ChatRow', 'dsh-x', '未归因']);
check('与这一帧重叠的 long task:只给时间上真的重叠的那几条(窗口里有、但不重叠的要排除)',
	(() => {
		const hit = watch.incidentLongTasksAt(frameRow, { t: 3000, ms: 984 });
		const miss = watch.incidentLongTasksAt(frameRow, { t: 13500, ms: 60 });
		return [hit.map((task) => task.owner), miss.length];
	})(), [['dsh-a'], 0]);
check('归因状态:事故包里的字段直接决定档位(有 JS 重叠 + 定到包 → 已确认)',
	(() => { const v = watch.incidentVerdict(frameRow); return [v.level, v.label]; })(), ['confirmed', '已确认']);

// ── 零证据那一行的分母范围:三种上下文各说各的,不许一律写成"窗口内" ────────────
check('零证据那一行的分母范围:历史帧说"历史帧"、实时帧说"本帧"、事故窗口切片说"窗口内"',
	(() => {
		const bare = {
			id: 'i9', frames: [{ t: 100, ms: 150, gap: false }],
			loaf: [{ t: 100, dur: 150, blocking: 0, scripts: [{ u: -1, ms: 20, charPos: null }] }],
			urls: [], summary: { topScripts: [], pkgCoverage: { resolved: 0, total: 1 } },
		};
		const saved = watch.state.watch.incidents.slice();
		watch.state.watch.incidents.length = 0;
		watch.state.watch.incidents.push(bare);
		watch.state.watch.mode = 'incident';
		watch.state.watch.selId = 'i9';
		watch.state.watch.frameT = null;
		const history = watch.evidenceZeroText(watch.evidenceScope());
		watch.state.watch.incidents.length = 0;
		for (const row of saved) watch.state.watch.incidents.push(row);
		watch.state.watch.mode = 'live';
		watch.state.watch.selId = null;
		return [
			history,
			watch.evidenceZeroText({ scopeKind: 'frame', frame: true, total: 3 }),
			watch.evidenceZeroText({ scopeKind: 'window', frame: false, total: 3 }),
		];
	})(),
	[
		'可疑脚本:0 条定到名(历史帧 1条脚本)· 要深录',
		'可疑脚本:0 条定到名(本帧 3条脚本)· 要深录',
		'可疑脚本:0 条定到名(窗口内 3条脚本)· 要深录',
	]);

// ── 诊断上下文落盘:刷新之后还能打开同一条事故的同一帧 ────────────────────────
check('上下文落盘/读回:模式 + 事故 id + 历史帧 t 原样回来(刷新后仍能逐帧回看)',
	(() => {
		watch.store.clear();
		watch.state.watch.mode = 'incident';
		watch.state.watch.selId = 'i12';
		watch.state.watch.frameT = 3000;
		watch.state.watch.scope = 'latest';
		watch.saveWatchUI();
		watch.state.watch.mode = 'live';
		watch.state.watch.selId = null;
		watch.state.watch.frameT = null;
		watch.state.watch.scope = 'worst';
		const saved = watch.state.watch.incidents.slice();
		watch.state.watch.incidents.length = 0;
		watch.state.watch.incidents.push(frameRow);
		watch.restoreWatchUI();
		const result = [watch.state.watch.mode, watch.state.watch.selId, watch.state.watch.frameT, watch.state.watch.scope];
		watch.state.watch.incidents.length = 0;
		for (const row of saved) watch.state.watch.incidents.push(row);
		watch.state.watch.mode = 'live';
		watch.state.watch.selId = null;
		watch.state.watch.frameT = null;
		watch.state.watch.scope = 'worst';
		watch.store.clear();
		return result;
	})(), ['incident', 'i12', 3000, 'latest']);
check('上下文落盘/读回:落盘的那条事故已经不在留存清单里 → 退回实时,不指着一个不存在的事故',
	(() => {
		watch.store.clear();
		watch.store.set(watch.LS_WATCHUI, JSON.stringify({ v: 1, mode: 'incident', selId: 'i-gone', frameT: 3000, scope: 'worst' }));
		watch.state.watch.mode = 'live';
		watch.state.watch.selId = null;
		watch.state.watch.frameT = null;
		const saved = watch.state.watch.incidents.slice();
		watch.state.watch.incidents.length = 0;
		watch.state.watch.incidents.push(frameRow);
		watch.restoreWatchUI();
		const result = [watch.state.watch.mode, watch.state.watch.selId, watch.state.watch.frameT];
		watch.state.watch.incidents.length = 0;
		for (const row of saved) watch.state.watch.incidents.push(row);
		watch.store.clear();
		return result;
	})(), ['live', null, null]);
check('选中事故 = 进入历史事故上下文;切「最差/最近」时历史帧的选择退回收起',
	(() => {
		const saved = watch.state.watch.incidents.slice();
		watch.state.watch.incidents.length = 0;
		watch.state.watch.incidents.push(frameRow);
		watch.state.watch.mode = 'live';
		watch.state.watch.selId = null;
		watch.state.watch.frameT = 3000;
		const ok = watch.selectIncident('i12');
		const afterSelect = [ok, watch.state.watch.mode, watch.state.watch.frameT];
		watch.state.watch.frameT = 3000;
		watch.setIncidentScope('latest');
		const afterScope = [watch.state.watch.mode, watch.state.watch.frameT, watch.state.watch.selId];
		watch.state.watch.incidents.length = 0;
		for (const row of saved) watch.state.watch.incidents.push(row);
		watch.state.watch.mode = 'live';
		watch.state.watch.selId = null;
		watch.state.watch.frameT = null;
		watch.state.watch.scope = 'worst';
		return [afterSelect, afterScope];
	})(), [[true, 'incident', null], ['incident', null, null]]);

// ── 可疑脚本那一块吃什么 + 底下的分母 ─────────────────────────────
// ── 历史事故的证据:存下来的优先(刷新生效),面板与复制摘要同一份 ─────────────
check('历史事故:live 缓存全空(模拟刷新)时,仍然用捕获时存下来的 pkg/file/line',
	(() => {
		const savedIncidents = watch.state.watch.incidents.slice();
		const savedLoaf = watch.state.watch.loaf.slice();
		const savedPrecise = watch.state.precise;
		watch.state.watch.incidents.length = 0;
		watch.state.watch.loaf.length = 0;      // 刷新后 live 帧环是空的
		watch.state.precise = false;            // 刷新后精确归因没开
		watch.pkgByUrl.clear();                 // 解析缓存也空了
		watch.state.watch.mode = 'incident';    // 这条断言说的是**历史事故上下文**那一支
		watch.state.watch.selId = 'i77';
		watch.state.watch.incidents.push({
			id: 'i77', severity: 300, at: '2026-10-12T10:00:00.000Z', cause: 'frame',
			urls: ['http://h/plugins/??a/client.js,b/client.js&rev=1'],
			summary: {
				topScripts: [{
					u: 0, ms: 120, fn: 'run', charPos: 44, pkg: 'dsh-b', pkgVia: 'section',
					file: '/plugins/dsh-b/client.js', line: 25580, lineVia: 'text', lineScope: 'bundle',
					invoker: 'Response.json.then', invokerType: 'user-callback',
				}],
				pkgCoverage: { resolved: 1, total: 1 },
			},
		});
		const scope = watch.evidenceScope();
		const row = scope.rows[0];
		const panelLine = watch.evidenceLine(row);
		const incident = watch.state.watch.incidents[0];
		const copyLine = watch.evidenceLine(watch.incidentEvidenceAt(incident, incident.summary.topScripts[0]));
		const result = [scope.rows.length, row.pkg, row.file, row.line, row.lineScope, row.fn, panelLine === copyLine, panelLine];
		watch.state.watch.incidents.length = 0;
		for (const r of savedIncidents) watch.state.watch.incidents.push(r);
		watch.state.watch.loaf.length = 0;
		for (const r of savedLoaf) watch.state.watch.loaf.push(r);
		watch.state.precise = savedPrecise;
		watch.state.watch.mode = 'live';
		watch.state.watch.selId = null;
		return result;
	})(),
	[1, 'dsh-b', '/plugins/dsh-b/client.js', 25580, 'bundle', 'run', true,
		'run @ dsh-b · /plugins/dsh-b/client.js · 合并脚本行 25580 · 120ms · 来源 Response.json.then · pkg=section line=text']);
check('老事故包(没有 file/line 字段):才回退现算 —— 就算现算,也不把结果写成"存下来的"',
	(() => {
		const savedIncidents = watch.state.watch.incidents.slice();
		watch.state.watch.incidents.length = 0;
		watch.pkgByUrl.clear();
		watch.pkgByUrl.set('http://h/plugins/dsh-old/client.js', { pkg: 'dsh-old', via: 'url' });
		watch.state.watch.mode = 'incident';
		watch.state.watch.selId = 'i78';
		watch.state.watch.incidents.push({
			id: 'i78', severity: 200, at: '2026-10-12T11:00:00.000Z', cause: 'frame',
			urls: ['http://h/plugins/dsh-old/client.js'],
			summary: { topScripts: [{ u: 0, ms: 30, fn: 'old' }], pkgCoverage: { resolved: 0, total: 1 } },
		});
		const scope = watch.evidenceScope();
		const row = scope.rows[0];
		const result = [row.fn, row.pkg, row.file, row.line, row.lineVia, row.lineScope];
		watch.state.watch.incidents.length = 0;
		for (const r of savedIncidents) watch.state.watch.incidents.push(r);
		watch.pkgByUrl.clear();
		watch.state.watch.mode = 'live';
		watch.state.watch.selId = null;
		return result;
	})(),
	['old', 'dsh-old', '/plugins/stub/client.js', 7, 'stub-text', 'file']);
check('可疑脚本:事故优先(窗口内切片,跨会话读回仍在),范围写在标题上',
	(() => {
		const savedIncident = watch.state.watch.incidents.slice();
		const savedLoaf = watch.state.watch.loaf.slice();
		watch.state.watch.incidents.length = 0;
		watch.pkgByUrl.clear();
		watch.pkgByUrl.set('http://h/plugins/dsh-x/client.js', { pkg: 'dsh-x', via: 'url' });
		watch.state.watch.mode = 'incident';
		watch.state.watch.selId = 'i9';
		watch.state.watch.incidents.push({
			id: 'i9', severity: 300, at: '2026-10-11T10:00:00.000Z', cause: 'frame', urls: ['http://h/plugins/dsh-x/client.js'],
			summary: { topScripts: [{ u: 0, ms: 40, fn: 'run', charPos: 0 }], pkgCoverage: { resolved: 1, total: 3 } },
		});
		watch.state.watch.loaf.push({ t: 1, dur: 200, blocking: 10, scripts: [{ url: 'http://h/plugins/dsh-y/client.js', ms: 9, charPos: 0 }] });
		const scope = watch.evidenceScope();
		const footer = watch.evidenceFooter(scope);
		watch.state.watch.incidents.length = 0;
		for (const row of savedIncident) watch.state.watch.incidents.push(row);
		watch.state.watch.loaf.length = 0;
		for (const row of savedLoaf) watch.state.watch.loaf.push(row);
		watch.pkgByUrl.clear();
		watch.state.watch.mode = 'live';
		watch.state.watch.selId = null;
		return [scope.label.includes('i9'), scope.label.includes('窗口内'), scope.rows.length, scope.total, scope.named, footer.includes('1/3'), footer.includes('定到包 1/3'), watch.evidenceZeroText(scope)];
	})(),
	[true, true, 1, 3, 1, true, true, '可疑脚本:0 条定到名(窗口内 3条脚本)· 要深录']);
// 底下一行是**正文**:以前它把「口径」与「缺口」两整段(各两三百字、带 `**` 与反引号)摊在这里,
// 面板是纯文本渲染,于是那些记号原样显示出来 —— 实测被吐槽"这段文字很丑陋"。现在正文只留分母与
// 一句悬停提示,全文进 title(与「复制摘要」共用同一份纯文本措辞)。
check('证据块底下那一行:正文只有分母 + 悬停提示(单行、不含 markdown 记号),全文在悬停里',
	(() => {
		const footer = watch.evidenceFooter({ total: 2, named: 2 });
		const title = watch.evidenceFooterTitle();
		return [
			footer,
			/\*\*|`/.test(footer),
			footer.includes('\n'),
			title.includes('口径:'), title.includes('缺:'), title.includes('合并脚本行'),
		];
	})(),
	['2条脚本 · 定到包 2/2 · 悬停看口径与缺口', false, false, true, true, true]);

// 这一帧有 2 条脚本,但只有 1 条能定位(另一条 URL 为空、也没有函数名)→ **列 1 条,分母仍是 2**
check('可疑脚本:没有事故时退回「当前选中那一帧」;不能定位的行不占名额但算进分母',
	(() => {
		const savedIncident = watch.state.watch.incidents.slice();
		const savedLoaf = watch.state.watch.loaf.slice();
		watch.state.watch.incidents.length = 0;
		watch.state.watch.loaf.length = 0;
		watch.state.watch.pickT = null;
		watch.pkgByUrl.clear();
		watch.pkgByUrl.set('http://h/plugins/dsh-y/client.js', { pkg: 'dsh-y', via: 'url' });
		watch.state.watch.loaf.push({ t: 1, dur: 200, blocking: 10, scripts: [{ url: 'http://h/plugins/dsh-y/client.js', ms: 9, charPos: 0 }, { url: '', ms: 3, charPos: null }] });
		const scope = watch.evidenceScope();
		watch.state.watch.incidents.length = 0;
		for (const row of savedIncident) watch.state.watch.incidents.push(row);
		watch.state.watch.loaf.length = 0;
		for (const row of savedLoaf) watch.state.watch.loaf.push(row);
		watch.pkgByUrl.clear();
		return [scope.label.includes('本帧'), scope.rows.length, scope.total, scope.named];
	})(),
	[true, 1, 2, 1]);
check('可疑脚本:既没有事故的脚本、帧里也没有脚本 → 整块不渲染(null,不摆空表)',
	(() => {
		const savedIncident = watch.state.watch.incidents.slice();
		const savedLoaf = watch.state.watch.loaf.slice();
		watch.state.watch.incidents.length = 0;
		watch.state.watch.loaf.length = 0;
		const scope = watch.evidenceScope();
		watch.state.watch.incidents.length = 0;
		for (const row of savedIncident) watch.state.watch.incidents.push(row);
		watch.state.watch.loaf.length = 0;
		for (const row of savedLoaf) watch.state.watch.loaf.push(row);
		return scope;
	})(),
	null);
// 切片时必须真的把 file / line / lineVia 落到 topScripts 上(契约:面板与事故包同一份依据)
check('事故切片:topScripts 带上 file / line / lineVia(证据链落到包内文件与行号)',
	(() => {
		const saved = watch.state.watch.incidents.slice();
		const savedLoaf = watch.state.watch.loaf.slice();
		watch.state.watch.incidents.length = 0;
		watch.state.watch.loaf.length = 0;
		watch.pkgByUrl.clear();
		watch.pkgByUrl.set('http://h/plugins/dsh-x/client.js', { pkg: 'dsh-x', via: 'url' });
		watch.state.watch.loaf.push({ t: 1, dur: 200, blocking: 10, lo: null, scripts: [{ url: 'http://h/plugins/dsh-x/client.js', ms: 9, charPos: 0, fn: 'run' }] });
		const before = watch.evidenceCalls();
		const incident = watch.assembleIncident({ at: 1, until: 2000, cause: 'manual', note: null, severity: 200 });
		const script = incident.summary.topScripts[0];
		watch.state.watch.incidents.length = 0;
		for (const row of saved) watch.state.watch.incidents.push(row);
		watch.state.watch.loaf.length = 0;
		for (const row of savedLoaf) watch.state.watch.loaf.push(row);
		watch.pkgByUrl.clear();
		return [watch.evidenceCalls() > before, script.file, script.line, script.lineVia, script.lineScope];
	})(),
	[true, '/plugins/stub/client.js', 7, 'stub-text', 'file']);
// 窗口完整性:序号断档 = 环挤掉了记录,必须写进 incident.integrity(不许静默)
check('windowIntegrity:序号连续 = 没丢;断档 = 精确算出差了几条',
	[
		watch.windowIntegrity([{ seq: 1 }, { seq: 2 }, { seq: 3 }], null, false, 0, 0),
		watch.windowIntegrity([{ seq: 1 }, { seq: 3 }, { seq: 4 }], null, false, 0, 0),
		watch.windowIntegrity([], 5, true, 1, 0),
		watch.windowIntegrity([], 5, true, 0, 0),
	],
	[{ dropped: 0, preOverflow: false }, { dropped: 1, preOverflow: false }, { dropped: 0, preOverflow: true }, { dropped: 0, preOverflow: false }]);
check('事故切片:环挤掉记录时 integrity.captureComplete=false,并把原因与条数写进包', (() => {
	const saved = watch.state.watch.incidents.slice();
	const savedLoaf = watch.state.watch.loaf.slice();
	const savedTasks = watch.state.longTasks.slice();
	watch.state.watch.incidents.length = 0;
	watch.state.watch.loaf.length = 0;
	watch.state.longTasks.length = 0;
	for (const row of [
		{ seq: 1, t: 100, dur: 200, blocking: 10, renderStart: 0, styleAndLayoutStart: 0, scripts: [] },
		{ seq: 2, t: 200, dur: 200, blocking: 10, renderStart: 0, styleAndLayoutStart: 0, scripts: [] },
		{ seq: 4, t: 400, dur: 200, blocking: 10, renderStart: 0, styleAndLayoutStart: 0, scripts: [] },
	]) watch.state.watch.loaf.push(row);
	watch.state.longTasks.push({ seq: 1, at: 100, ms: 60, owner: null, component: null });
	watch.state.longTasks.push({ seq: 3, at: 300, ms: 60, owner: null, component: null });
	const incident = watch.assembleIncident({ at: 1000, until: 2000, cause: 'manual', note: null, severity: 200, loafFull: false, loafOldestAt: 100, longTaskFull: false, longTaskOldestAt: 100 });
	watch.state.watch.incidents.length = 0;
	for (const row of saved) watch.state.watch.incidents.push(row);
	watch.state.watch.loaf.length = 0;
	for (const row of savedLoaf) watch.state.watch.loaf.push(row);
	watch.state.longTasks.length = 0;
	for (const row of savedTasks) watch.state.longTasks.push(row);
	return [incident.integrity.captureComplete, incident.integrity.loafDropped, incident.integrity.longTaskDropped, incident.integrity.reasons];
})(), [false, 1, 1, ['loaf-ring-overflow', 'longtask-ring-overflow']]);
// 「自动」跟哪一条:最差(默认)还是最近 —— 两个都要够得着,又不许多一张清单
check('事故 scope:默认跟最差;切到「最近」之后跟时刻最新那条,并且清掉手选',
	(() => {
		const saved = watch.state.watch.incidents.slice();
		watch.state.watch.incidents.length = 0;
		watch.state.watch.incidents.push(
			{ id: 'a', severity: 300, at: '2026-10-11T10:00:00.000Z', cause: 'frame', summary: { topScripts: [] } },
			{ id: 'b', severity: 120, at: '2026-10-11T12:00:00.000Z', cause: 'frame', summary: { topScripts: [] } });
		watch.state.watch.selId = null;
		watch.state.watch.scope = 'worst';
		const worst = watch.selectedIncident().row.id;
		watch.setIncidentScope('latest');
		const latest = watch.selectedIncident().row.id;
		const cleared = watch.state.watch.selId;
		const auto = watch.selectedIncident().auto;
		watch.setIncidentScope('worst');
		watch.state.watch.incidents.length = 0;
		for (const row of saved) watch.state.watch.incidents.push(row);
		return [worst, latest, cleared, auto];
	})(),
	['a', 'b', null, true]);
check('事故 scope:手选压过 scope;切 scope 时手选让位(同一个字段不许两个人抢)',
	(() => {
		const saved = watch.state.watch.incidents.slice();
		watch.state.watch.incidents.length = 0;
		watch.state.watch.incidents.push(
			{ id: 'a', severity: 300, at: '2026-10-11T10:00:00.000Z', cause: 'frame', summary: { topScripts: [] } },
			{ id: 'b', severity: 120, at: '2026-10-11T12:00:00.000Z', cause: 'frame', summary: { topScripts: [] } });
		watch.state.watch.scope = 'worst';
		watch.state.watch.selId = null;
		watch.selectIncident('b');
		const manual = [watch.selectedIncident().row.id, watch.selectedIncident().auto];
		watch.setIncidentScope('latest');
		const after = [watch.selectedIncident().row.id, watch.selectedIncident().auto];
		watch.setIncidentScope('worst');
		watch.state.watch.incidents.length = 0;
		for (const row of saved) watch.state.watch.incidents.push(row);
		return [manual, after];
	})(),
	[['b', false], ['b', true]]);
check('事故选择:选中的那条被挤出清单 → 退回自动,不返回 null/不指空条目',
	(() => { watch.state.watch.selId = 'gone'; const pick = watch.selectedIncident(); watch.state.watch.selId = null; return [pick.auto, pick.row === null]; })(), [true, false]);
// 「最差事件」块底下那行:只在还有话要说时才出现(抓到几次/最差多少上面已经说过)
check('最差事件状态行:没有读回/裁掉/落盘失败时不出现(同一句话不说两遍)', watch.watchFlagText(), null);
check('最差事件状态行:读回/裁掉照实报出来', (() => {
	watch.state.watch.restored = 2;
	watch.state.watch.trimmedByBytes = 3;
	const text = watch.watchFlagText();
	watch.state.watch.restored = 0;
	watch.state.watch.trimmedByBytes = 0;
	return text;
})(), '守夜 · 读回 2 · 裁掉 3');
check('最差事件状态行:落盘失败带 ⚠️', (() => {
	watch.state.watch.persistError = 'QuotaExceededError';
	const text = watch.watchFlagText();
	watch.state.watch.persistError = null;
	return text;
})(), '守夜 · ⚠️ 落盘失败');

// 事故包:自描述头 + 缺失声明(缺什么、怎么补)
check('事故包:不存在的 id 返回 null(不静默成功)', watch.incidentReport('nope'), null);
// 导出脱敏:自由文本默认保留(本机调试件要靠它知道当时在干什么),AI 诊断包走 dropFreeText
check('脱敏:默认保留自由文本(本机调试件)',
	watch.redactExport({ note: 'a', marks: [{ note: 'b', t: 1 }] }),
	{ note: 'a', marks: [{ note: 'b', t: 1 }] });
check('脱敏:dropFreeText 把 note 置空并留 noteDropped(不许静默删掉,也不许假装没这段)',
	watch.redactExport({ note: 'a', marks: [{ note: 'b', t: 1 }] }, { dropFreeText: true }),
	{ note: null, noteDropped: true, marks: [{ note: null, noteDropped: true, t: 1 }] });
check('脱敏:事故包的 page 与 redaction 声明一起给出来(凭据进不去,减法说得清)', (() => {
	watch.location.href = 'http://127.0.0.1:3080/?token=SECRET_PACK';
	const pack = watch.incidentReport(0);
	const text = JSON.stringify(pack);
	return [/SECRET_PACK/.test(text), pack.context.page, pack.context.redaction.rule.includes('做减法'),
		pack.context.redaction.freeText.length];
})(), [false, 'http://127.0.0.1:3080/', true, 2]);
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
check('帧拆分:LoAF 三个时间点 → 脚本 / 任务(没归到脚本的)/ 渲染 / 样式+布局+绘制的占比', watch.frameSplit({
	t: 1000, dur: 200, renderStart: 1120, styleAndLayoutStart: 1140, blocking: 90,
	scripts: [{ ms: 60 }, { ms: 40 }],
}), { at: 1000, total: 200, head: 120, js: 100, taskOther: 20, exec: 100, forced: 0, pause: 0, render: 20, tail: 60, blocking: 90 });
check('帧拆分:脚本再拆三层(纯执行 / 强制样式布局 / 暂停)',
	(() => {
		const split = watch.frameSplit({
			t: 10, dur: 100, renderStart: 70, styleAndLayoutStart: 80, blocking: 60,
			scripts: [{ ms: 40, forcedMs: 12, pauseMs: 8 }, { ms: 5, forcedMs: 0, pauseMs: 0 }],
		});
		return [split.js, split.exec, split.forced, split.pause, split.taskOther, split.render, split.tail];
	})(),
	[45, 25, 12, 8, 15, 10, 30]);
check('帧拆分:四段相加 = 整帧(分区,不是各算各的)',
	(() => {
		const split = watch.frameSplit({
			t: 10, dur: 100, renderStart: 70, styleAndLayoutStart: 80, blocking: 60,
			scripts: [{ ms: 40, forcedMs: 12, pauseMs: 8 }, { ms: 5, forcedMs: 0, pauseMs: 0 }],
		});
		return [split.js + split.taskOther, split.head, split.exec + split.forced + split.pause, split.js,
			split.js + split.taskOther + split.render + split.tail, split.total];
	})(),
	[60, 60, 45, 45, 100, 100]);
// 每条脚本的毫秒各自 round1,脚本多而每条约 0.05ms 时求和会超过父区间 —— 子项不许大过父项
check('帧拆分:脚本耗时超过"任务"时向下 clamp(否则弧长是负的)',
	(() => {
		const split = watch.frameSplit({ t: 0, dur: 100, renderStart: 10.04, styleAndLayoutStart: 10.04, blocking: 5, scripts: [{ ms: 3.4 }, { ms: 3.4 }, { ms: 3.4 }] });
		return [split.head, split.js, split.taskOther, split.exec];
	})(),
	[10, 10, 0, 10]);
check('帧拆分:强制布局 + 暂停超过脚本耗时时也 clamp',
	(() => {
		const split = watch.frameSplit({ t: 0, dur: 50, renderStart: 50, blocking: 5, scripts: [{ ms: 10, forcedMs: 8, pauseMs: 5 }] });
		return [split.js, split.forced, split.pause, split.exec];
	})(),
	[10, 8, 2, 0]);
check('帧拆分:缺 renderStart 时全部算"任务",不猜', watch.frameSplit({ t: 0, dur: 60, blocking: 1, scripts: [] }), { at: 0, total: 60, head: 60, js: 0, taskOther: 60, exec: 0, forced: 0, pause: 0, render: 0, tail: 0, blocking: 1 });
check('帧拆分:脏数据返回 null', [watch.frameSplit(null), watch.frameSplit({ t: 0, dur: 0 })], [null, null]);
check('圆环图例:两行、每行两段(四个百分比挤一行会折行);顺序与圆环一致',
	watch.splitLegend({ total: 200, js: 100, taskOther: 20, render: 20, tail: 60 }),
	['脚本 50% · 任务 10%', '渲染 10% · 样式+布局+绘制 30%']);
check('翻帧:默认看最差那条;钉住后看钉住的那条;选中的被挤出环外自动退回',
	(() => {
		const saved = watch.state.watch.loaf.slice();
		watch.state.watch.loaf.length = 0;
		watch.state.watch.loaf.push(
			{ t: 100, dur: 50, blocking: 10, scripts: [] },
			{ t: 200, dur: 50, blocking: 300, scripts: [] },
			{ t: 300, dur: 50, blocking: 90, scripts: [] });
		const auto = watch.pickedLoaf().t;
		watch.state.watch.pickT = 100;
		const pinned = watch.pickedLoaf().t;
		watch.state.watch.pickT = 999;                    // 已经不在环里了
		const evicted = [watch.pickedLoaf().t, watch.state.watch.pickT];
		watch.state.watch.loaf.length = 0;
		for (const row of saved) watch.state.watch.loaf.push(row);
		return [auto, pinned, evicted];
	})(),
	[200, 100, [200, null]]);
check('翻帧清单:只收 max(blocking, 帧时长) ≥ 100ms 的,其余不进榜',
	(() => {
		const saved = watch.state.watch.loaf.slice();
		watch.state.watch.loaf.length = 0;
		watch.state.watch.loaf.push(
			{ t: 1, blocking: 10, dur: 60 }, { t: 2, blocking: 300, dur: 320 },
			{ t: 3, blocking: 250, dur: 260 }, { t: 4, blocking: 90, dur: 95 });
		const list = watch.pickList();
		const hot = [list.filtered, list.rows.map((row) => row.t)];
		// 一条都不到线:退回全部,并说明"没过滤"
		watch.state.watch.loaf.forEach((row) => { row.blocking = 40; row.dur = 70; });
		const cold = watch.pickList();
		const fallback = [cold.filtered, cold.rows.length];
		watch.state.watch.loaf.length = 0;
		for (const row of saved) watch.state.watch.loaf.push(row);
		return [hot, fallback, watch.PICK_MIN_MS];
	})(),
	[[true, [2, 3]], [false, 4], 100]);
check('翻帧:◀ ▶ 按 blocking 降序走(只看上榜的帧),到头停住,⟲ 回到自动',
	(() => {
		const saved = watch.state.watch.loaf.slice();
		watch.state.watch.loaf.length = 0;
		watch.state.watch.loaf.push(
			{ t: 1, blocking: 10, dur: 60 }, { t: 2, blocking: 300, dur: 320 },
			{ t: 3, blocking: 250, dur: 260 }, { t: 4, blocking: 90, dur: 95 });
		const ranks = watch.pickList().rows.map((row) => row.t);
		watch.pickStep(1);                                 // 自动(t2 = 最差)→ 下一条 t3
		const step1 = watch.state.watch.pickT;
		watch.pickStep(1);                                 // 到头(只上榜两条):停在 t3
		const step2 = watch.state.watch.pickT;
		watch.pickStep(-1);                                // 往回 = t2
		const back = watch.state.watch.pickT;
		watch.pickAuto();
		const auto = watch.state.watch.pickT;
		watch.state.watch.loaf.length = 0;
		for (const row of saved) watch.state.watch.loaf.push(row);
		return [ranks, step1, step2, back, auto];
	})(),
	[[2, 3], 3, 3, 2, null]);
check('圆环只画一个维度(四段:脚本 / 任务 / 渲染 / 尾部),不再按来源切',
	(() => {
		const arcs = watch.frameArcs({ total: 200, js: 120, taskOther: 30, render: 20, tail: 30, exec: 120, forced: 0, pause: 0 });
		return [arcs.map((arc) => [arc.ms, arc.color]), arcs.reduce((acc, arc) => acc + arc.ms, 0)];
	})(),
	[[[120, 'error'], [30, 'neutral'], [20, 'warn'], [30, 'brand']], 200]);
check('堆叠条:Top3 + 其余,段宽按这一维度的总量算(恒满格)',
	(() => {
		const { segs, total } = watch.barSegments([['a', 60], ['b', 30], ['c', 10], ['d', 10], ['e', 5]]);
		return [segs.map((seg) => [seg.name, seg.ms]), total, segs.reduce((acc, seg) => acc + seg.ms, 0)];
	})(),
	[[['a', 60], ['b', 30], ['c', 10], [null, 15]], 115, 115]);
check('堆叠条:没有其它来源时不留"其余"段;毫秒为 0 的不上榜',
	(() => {
		const one = watch.barSegments([['only', 40], ['zero', 0]]);
		const empty = watch.barSegments([]);
		return [one.segs.map((seg) => seg.name), one.total, empty.segs.length, empty.total];
	})(),
	[['only'], 40, 0, 0]);
check('交叉表:Top3×Top3 + 其余行/列,四块之和 = 脚本总耗时(口径自洽的 tally)',
	(() => {
		const tally = {
			js: 100,
			top: [['A', 50], ['B', 30], ['C', 15]], byOther: [['D', 5]],
			byInvoker: [['s1', 60], ['s2', 30], ['s3', 8], ['s4', 2]],
			byPair: {
				'A\u0000s1': 40, 'A\u0000s2': 10,
				'B\u0000s1': 15, 'B\u0000s2': 10, 'B\u0000s3': 5,
				'C\u0000s1': 5, 'C\u0000s2': 10,
				'D\u0000s3': 3, 'D\u0000s4': 2,
			},
		};
		const cross = watch.crossTable(tally);
		const sum = cross.grid.reduce((acc, row) => acc + row.reduce((a, b) => a + b, 0), 0)
			+ cross.restCol.reduce((a, b) => a + b, 0) + cross.restRow.reduce((a, b) => a + b, 0) + cross.corner;
		return [cross.rows, cross.cols, cross.grid, cross.restCol, cross.restRow, cross.corner, sum, cross.top];
	})(),
	[['A', 'B', 'C'], ['s1', 's2', 's3'], [[40, 10, 0], [15, 10, 5], [5, 10, 0]], [0, 0, 0], [0, 0, 3], 2, 100, { who: 'A', src: 's1', ms: 40 }]);
check('交叉表:没有可交叉的数据时返回 null(不画空表)',
	[watch.crossTable({ js: 0, top: [], byOther: [], byInvoker: [], byPair: {} }),
		watch.crossSummary(null), watch.crossSummary({ top: { who: '@a/dsh-x', src: 'setTimeout', ms: 240 } })],
	[null, '没有可交叉的脚本', 'dsh-x · setTimeout 240ms']);
check('交叉表:Top3 之间一格交集都没有时不留 null(摘要不能抛,要写"没有交集")',
	(() => {
		// 行/列都有量,但两两组合全是 0:最大的包住在第 4 名来源里 —— 曾经的写法在这里 `null.replace` 抛错
		const cross = watch.crossTable({
			js: 100, top: [['A', 60], ['B', 40]], byOther: [], byInvoker: [['s1', 55], ['s2', 45]], byPair: {},
		});
		return [cross.top.who, cross.top.src, cross.top.ms, watch.crossSummary(cross)];
	})(),
	['A', 's1', 0, 'Top3 之间没有交集']);
// 这条是补上来的债(REVIEW §3.4 / AGENTS §5):第五组摘要一直**没有**长度预算断言。
// ⚠️ 必须拿**真实量级**的名字喂它:`dsh-client-ui-renderer · DOMWebSocket.onmessage 1234ms`
// 不截断是 53 字符,而摘要那一行是 label(不收缩)+ value(右对齐),53 字符必然折成参差两行。
check('「包 × 来源」摘要的长度预算(用真实量级的长包名与长来源名:不截断 = 53 字符)',
	(() => {
		const text = watch.crossSummary({ top: { who: 'dsh-client-ui-renderer', src: 'DOMWebSocket.onmessage', ms: 1234 } });
		return [text.length <= 40, text.includes('…'), text.endsWith('1234ms')];
	})(), [true, true, true]);
check('"谁"的两类标签合起来排序(插件包 + 其余来源),堆叠条与交叉表共用',
	watch.whoRows({ top: [['pkg', 10]], byOther: [['index-abc.js', 90], ['无 URL(内联脚本)', 5]] }),
	[['index-abc.js', 90], ['pkg', 10], ['无 URL(内联脚本)', 5]]);
check('圆环图例两行的长度预算(zh;396px 面板)', watch.splitLegend({ total: 200, js: 100, taskOther: 20, render: 20, tail: 60 }).every((line) => line.length <= 26), true);

// ── 审批卡让位(hudDodge)──────────────────────────────────────────────
// 背景:审批面板是 composer takeover,「拒绝 / 允许一次」两个真按钮在卡片右下角 —— 正好压在
// HUD 停的那一列上(真页面实测:挡住的就是批准按钮)。判定是纯函数,这里用造出来的几何断言;
// 真页面那一侧由 `tools/check-panel.mjs` 插一张假审批卡来验。
const dodgeIn = ({ card: over, viewport } = {}) => EX.hudDodge({
	card: { top: 526, right: 1400, width: 1400, height: 231, ...over },
	viewport: viewport ?? { w: 1400, h: 757 },
	width: 396,
});
check('审批卡压在我们这一列 → 抬到卡片上方,高度跟着收到剩下的空间',
	dodgeIn(), { bottom: 243, maxHeight: 502, left: false });
check('窗口够宽(卡片右边界在面板左边)→ 一动不动', dodgeIn({ card: { right: 900 } }), null);
check('卡片把上方挤没了 → 退到左下角(动作按钮右对齐,挡不到)', dodgeIn({ card: { top: 40 } }),
	{ bottom: 12, maxHeight: 621, left: true });
check('卡片不可见 / 在视口下方 / 占满整屏 / 根本没有卡片 → 一律不动', [
	dodgeIn({ card: { width: 0, height: 0 } }),
	dodgeIn({ card: { top: 800 } }),
	dodgeIn({ card: { top: 0 } }),
	EX.hudDodge({ card: null, viewport: { w: 1400, h: 757 }, width: 396 }),
], [null, null, null, null]);
// 面板宽度只允许一个来源,而且**随视口收**:S.root 收一个算好的宽度(以前展开 396 / 错误降级
// 视图 380 / 收起态 min-width 396 —— 三个字面量,改一个忘一个,而且在手机上会溢出去)。
check('面板宽度只有一个来源,而且由 S.root 收参', [
	(source.match(/const PANEL_WIDTH = 396;/g) ?? []).length,
	/root: \(open, width\)/.test(source),
	/\bwidth: 380\b/.test(source) || /\bwidth: 396\b/.test(source),
], [1, true, false]);
// 手机上 396 定宽会直接溢出(实测 393px 视口:left = −15,标题被切掉一截)。
check('窄屏宽度:396 → 视口 − 24,下限 240',
	[EX.panelWidthFor(1400), EX.panelWidthFor(393), EX.panelWidthFor(260), EX.panelWidthFor(2000)],
	[396, 369, 240, 396]);
check('药丸窄屏档(< 480 才丢「检测 N 次」,三个基本读数一个不丢)',
	[EX.pillCompact(1400), EX.pillCompact(480), EX.pillCompact(479), EX.pillCompact(393)],
	[false, false, true, true]);
check('worstLoaf:按 frameSeverity = max(blocking, 帧时长) 取最差(只看 blocking 会挑错那条)', (() => {
	const saved = watch.state.watch.loaf.slice();
	watch.state.watch.loaf.length = 0;
	// t1:帧时长 300ms 但 blocking 只有 10ms(LoAF 的 blocking 实测常年偏小)
	// t2:帧时长 120ms、blocking 200ms —— 只看 blocking 会挑到它
	watch.state.watch.loaf.push({ t: 1, dur: 300, blocking: 10, scripts: [] }, { t: 2, dur: 120, blocking: 200, scripts: [] });
	const got = [watch.worstLoaf().t, watch.loafRanks().map((row) => row.t)];
	watch.state.watch.loaf.length = 0;
	for (const row of saved) watch.state.watch.loaf.push(row);
	return got;
})(), [1, [1, 2]]);
check('口径统一:自动选中的那条**一定**出现在翻帧清单里(以前会显示"帧 0/N")', (() => {
	const saved = watch.state.watch.loaf.slice();
	watch.state.watch.loaf.length = 0;
	watch.state.watch.loaf.push({ t: 1, dur: 300, blocking: 10, scripts: [] }, { t: 2, dur: 120, blocking: 200, scripts: [] });
	watch.state.watch.pickT = null;
	const current = watch.pickedLoaf();
	const at = watch.pickList().rows.findIndex((row) => row.t === current.t);
	watch.state.watch.loaf.length = 0;
	for (const row of saved) watch.state.watch.loaf.push(row);
	return at >= 0;
})(), true);
check('frameSeverity:blocking 与帧时长取大者(非数字/空行不抛错)',
	[watch.frameSeverity({ dur: 300, blocking: 10 }), watch.frameSeverity({ dur: 80, blocking: 200 }), watch.frameSeverity(null), watch.frameSeverity({})],
	[300, 200, 0, 0]);
// 帧条的可点格:只有"能真的导航过去"的格子才给 onClick(否则就是个点了没反应的假按钮)
check('帧条可点格:一格 → 那一格里 dur 最大的那条长动画帧', (() => {
	const saved = watch.state.watch.loaf.slice();
	watch.state.watch.loaf.length = 0;
	watch.state.watch.loaf.push({ t: 45100, dur: 120 }, { t: 45500, dur: 200 }, { t: 99900, dur: 90 });
	const map = [...watch.sparkPickMap(100000).entries()].map(([index, frame]) => [index, frame.t]);
	watch.state.watch.loaf.length = 0;
	for (const row of saved) watch.state.watch.loaf.push(row);
	return map;
})(), [[5, 45500], [59, 99900]]);
check('帧条每格 title:墙钟时间 + 这一秒最差帧 + 点得动', (() => {
	const text = watch.sparkCellTitle({ ms: 120, t: 40000, seen: true, gap: false }, { t: 40000 });
	return [text.includes('最差那条 120ms'), text.includes('点它 → 翻帧切到这一秒的长动画帧')];
})(), [true, true]);
check('帧条每格 title:点不动也要写出来(否则只会被读成"点了没反应")',
	watch.sparkCellTitle({ ms: 120, t: 40000, seen: true, gap: false }, undefined).includes('这一秒没有长动画帧,点不动'), true);
check('帧条每格 title:整格 rAF 挂起说成间隙(不是卡顿)',
	watch.sparkCellTitle({ ms: 0, t: null, seen: false, gap: true }, undefined), '整格 rAF 挂起(间隙,不是卡顿)');
check('窗口聚合的缓存指纹带 resolveSeq:sourcemap/脚本文本异步到位后会重算(不会冻在旧结论)',
	(() => {
		const saved = watch.state.watch.loaf.slice();
		watch.state.watch.loaf.length = 0;
		watch.pkgByUrl.clear();
		const url = 'http://h/plugins/??a/client.js,b/client.js&rev=1';
		watch.pkgByUrl.set(url, { pkg: null, via: 'text-pending' });
		watch.state.watch.loaf.push({ t: 1, dur: 300, blocking: 10, scripts: [{ url, charPos: 0, ms: 120 }] });
		const before = watch.scriptPkgTally().top.length;       // 解析还没到位 → 一个名字都没有
		watch.pkgByUrl.set(url, { pkg: 'dsh-x', via: 'section' });
		const cached = watch.scriptPkgTally().top.length;       // 指纹没变 → 仍走缓存(证明缓存是为了省算)
		watch.markResolved();                                   // 解析推进一次
		const fresh = watch.scriptPkgTally().top.map(([name]) => name);
		watch.pkgByUrl.clear();
		watch.state.watch.loaf.length = 0;
		for (const row of saved) watch.state.watch.loaf.push(row);
		return [before, cached, fresh];
	})(),
	[0, 0, ['dsh-x']]);
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
check('事故包:A2 落地后那条"没有对照基线"改成"跨机器 / 跨浏览器"',
	watch.incidentReport(0).context.missing.some((line) => line.startsWith('baseline:') && line.includes('跨机器')), true);
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

// ── D2:60 秒迷你时间条(面板)与 ASCII 条带同一口径 ──────────────────
check('D2:分档与 ASCII 条带逐条对应(≥100 红 / ≥50 黄 / 其余正常 / 整格间隙 / 没采到)',
	[
		watch.sparkLevel({ ms: 100, seen: true, gap: false }),
		watch.sparkLevel({ ms: 50, seen: true, gap: false }),
		watch.sparkLevel({ ms: 49, seen: true, gap: false }),
		watch.sparkLevel({ ms: 0, seen: false, gap: true }),
		watch.sparkLevel({ ms: 0, seen: false, gap: false }),
	],
	['bad', 'warn', 'ok', 'gap', 'empty']);
check('D2:一格一秒共 60 格,格值取格里最差那一帧',
	(() => {
		const base = 100000;
		watch.frameRing.reset();
		watch.frameRing.push(base - 60000, 16.66, false);
		watch.frameRing.push(base - 59000, 30, false);
		watch.frameRing.push(base - 30000, 55, false);
		watch.frameRing.push(base - 29500, 120, false);    // 同一格里更差的一帧
		watch.frameRing.push(base - 1000, 900, true);      // rAF 挂起
		const cells = watch.sparkBars(base);
		return [cells.length, cells.length === watch.SPARK_SECONDS, cells[0].ms, cells[1].ms, cells[30].ms, watch.SPARK_HEIGHT];
	})(),
	[60, true, 16.7, 30, 120, 18]);
check('D2:整格 rAF 间隙 → gap(矮柱,不是卡顿),那一秒没采到 → empty',
	(() => {
		const cells = watch.sparkBars(100000);
		return [watch.sparkLevel(cells[59]), cells[59].seen, cells[10].seen, cells[10].ms];
	})(),
	['gap', false, false, 0]);

// ── A2:跨会话基线(每个会话一条,只进导出件)────────────────────────
// 前面的用例里,事故包的 context 已经往这份落盘写了若干条(那是真实现的行为),先清干净
watch.store.set('dsh-perf-hud:sessions:v1', JSON.stringify({ v: 1, sessions: [] }));
watch.state.since = 1700000000000;
check('A2:一帧都没采到时不编数字', (() => {
	watch.frameRing.reset();
	return [watch.sessionRecord(), watch.saveSessionBaseline()];
})(), [null, []]);
watch.frameRing.reset();
for (let i = 0; i < 10; i += 1) watch.frameRing.push(1000 + i * 16.7, 16.7, false);
check('A2:导出的基线写明"粗参照,不是回归判定",并带全分布字段', (() => {
	const box0 = watch.sessionBaselines();
	const keys = Object.keys(box0.sessions[0] ?? {});
	return [box0.sessions.length, box0.keep, box0.sessions[0].frames, /不是回归判定/.test(box0.note),
		['p50', 'p90', 'p99', 'worstMs', 'frames', 'at', 'since'].every((key) => keys.indexOf(key) !== -1)];
})(), [1, 20, 10, true, true]);
check('A2:同一个会话反复取只占一条(按 since 认人)',
	[watch.sessionBaselines().sessions.length, watch.sessionBaselines().sessions[0].since === watch.sessionBaselines().sessions[0].since], [1, true]);
check('A2:sessionBaselines() 是纯读 —— 不写 localStorage(snapshot() 是文档承诺的只读 API)', (() => {
	watch.store.set('dsh-perf-hud:sessions:v1', JSON.stringify({ v: 1, sessions: [{ since: 'old-session', frames: 1 }] }));
	const before = watch.store.get('dsh-perf-hud:sessions:v1');
	const view = watch.sessionBaselines();
	return [watch.store.get('dsh-perf-hud:sessions:v1') === before, view.sessions.length, view.sessions[view.sessions.length - 1].since !== 'old-session'];
})(), [true, 2, true]);
check('A2:最多留最近 20 个会话,更早的被挤出去', (() => {
	watch.store.set('dsh-perf-hud:sessions:v1', JSON.stringify({ v: 1, sessions: [] }));
	for (let i = 0; i < 25; i += 1) {
		watch.state.since = 1700000000000 + i * 1000;
		watch.saveSessionBaseline();
	}
	const list = JSON.parse(watch.store.get('dsh-perf-hud:sessions:v1')).sessions;
	watch.state.since = 0;
	return [list.length, list[0].since, list[list.length - 1].since];
})(), [20, new Date(1700000000000 + 5000).toISOString(), new Date(1700000000000 + 24000).toISOString()]);

// ── D5:脚本侧二级(按包 + 纯执行 / 强制样式布局 / 暂停;窗口与本帧两个分母)──
watch.state.watch.loaf = [
	{ t: 1000, dur: 200, blocking: 0, scripts: [
		{ url: 'u-a', ms: 60, forcedMs: 5, pauseMs: 7, invoker: 'TimerHandler:setTimeout' },
		{ url: 'u-b', ms: 30, forcedMs: 0, pauseMs: 0, invoker: 'DOMWebSocket.onmessage' },
		{ url: 'u-x', ms: 10, forcedMs: 1, pauseMs: 0, invoker: 'Response.json.then' },   // 定不到包:算 unresolved,不进任何包
	] },
	{ t: 1500, dur: 90, blocking: 40, scripts: [
		{ url: 'u-b', ms: 40, forcedMs: 2, pauseMs: 3, invoker: 'DOMWebSocket.onmessage' },
	] },
];
watch.pkgByUrl.set('u-a', { pkg: 'dsh-a', via: 'url' });
watch.pkgByUrl.set('u-b', { pkg: 'dsh-b', via: 'url' });
check('D5:窗口聚合:按包降序;纯执行 / 强制样式布局 / 暂停三分;定不到包的单独计数',
	(() => {
		const tally = watch.scriptPkgTally();
		return [tally.top, tally.js, tally.exec, tally.forced, tally.pause, tally.unresolved, tally.unresolvedMs];
	})(),
	[[['dsh-b', 70], ['dsh-a', 60]], 140, 122, 8, 10, 1, 10]);
check('D5:LoAF 窗口没变就复用上一次的结果(不让面板每 tick 重算 200×12 条脚本)',
	watch.scriptPkgTally() === watch.scriptPkgTally(), true);
check('D5:窗口变了才重算',
	(() => {
		const before = watch.scriptPkgTally();
		watch.state.watch.loaf = watch.state.watch.loaf.concat([{ t: 2000, dur: 80, blocking: 0, scripts: [{ url: 'u-b', ms: 20, forcedMs: 0, pauseMs: 0 }] }]);
		const after = watch.scriptPkgTally();
		return [after !== before, after.js, after.top];
	})(),
	[true, 160, [['dsh-b', 90], ['dsh-a', 60]]]);
// 本帧与窗口是同一份口径、**不同分母** —— 面板上两行分别标了"本帧"与"窗口",
// 就是为了不让读者拿两种分母的数字互相印证(这正是原来那两行的问题)。
check('D5:本帧聚合只吃那一条 LoAF(与窗口分母不同)',
	(() => {
		const frame = watch.framePkgTally(watch.state.watch.loaf[1]);
		return [frame.top, frame.js, frame.pause, watch.scriptPkgTally().js];
	})(),
	[[['dsh-b', 40]], 40, 3, 160]);
check('D5:本帧没有脚本时给 0(而不是 null);"没有这一帧"才给 null',
	[watch.framePkgTally({ t: 1, dur: 10, scripts: [] }).js, watch.framePkgTally(null)],
	[0, null]);
// REVIEW §3.4 记过这条债:旧版这里收敛成一行 `按包:0 条定到名(本帧 1 · 窗口 461 条脚本)· 要深录`
// —— 但那个分支**永远渲染不到**(外层要求 window.js > 0,而 js > 0 必然有脚本,脚本不是进 top
// 就是进 byOther,两个条件互斥),套件却因为**直接测那个函数**而一直绿。
// 现在死分支已删,断言改成**实际渲染的那份数据**:面板喂给按包那条堆叠条的就是 whoRows(tally)。
check('一个包名都没定到时:按包那一条渲染的是「其余来源」段(带名字与毫秒),不是一行"0 条定到名"',
	(() => {
		const tally = { top: [], byOther: [['index-abc.js', 266], ['无 URL(内联脚本)', 12]], unresolved: 2, unresolvedMs: 278, byInvoker: [], byPair: {} };
		const rows = watch.whoRows(tally);            // ← 渲染层 bar('win-pkg', …, whoRows(window), …) 吃的就是它
		const segs = watch.barSegments(rows).segs;    // ← 条上的段由它算
		return [rows.length, segs.map((seg) => [seg.name, Math.round(seg.ms)])];
	})(),
	[2, [['index-abc.js', 266], ['无 URL(内联脚本)', 12]]]);
check('外壳 bundle(应用自己那一层)被认出来:按包第一名是它时,面板能就地说明"这不是插件"', [
	watch.isShellScript({ url: 'http://h/assets/index-CN7NIWNw.js' }),
	watch.isShellScript({ url: 'http://h/plugins/??a/client.js,b/client.js&rev=1' }),
	watch.isShellScript({ url: 'http://h/plugins/dsh-x/client.js?rev=1' }),
	watch.isShellScript({ url: '' }),
	watch.isShellScript(null),
], [true, false, false, false, false]);
check('外壳判据与 ownerOfUrl 严格一致(只认 null):合并批的 owner 是 bundle: key,不是外壳', [
	watch.ownerOfUrl('http://h/plugins/??a/client.js,b/client.js&rev=1').startsWith('bundle:'),
	watch.isShellScript({ url: 'http://h/plugins/??a/client.js,b/client.js&rev=1' }),
	watch.isShellScript({ url: 'http://h/plugins/??dsh-status-rotator/client.js&rev=1' }),
], [true, false, false]);
check('shellSummary:第一名是外壳才给结论,否则 null(不抢别的归属方的位置)', [
	watch.shellSummary({ js: 300, top: [], byOther: [['index-CN7NIWNw.js', 281], ['插件批次(未按 sourcemap 拆)', 13]], shellMs: 281, shellName: 'index-CN7NIWNw.js' }),
	watch.shellSummary({ js: 300, top: [['dsh-x', 281]], byOther: [['index-CN7NIWNw.js', 13]], shellMs: 13, shellName: 'index-CN7NIWNw.js' }),
	watch.shellSummary(null),
], [{ name: 'index-CN7NIWNw.js', ms: 281, share: 281 / 300 }, null, null]);
check('定不到插件包名的脚本按原因给名字(而不是笼统的"未定名")',
	[
		watch.unresolvedLabel({ url: '' }),
		watch.unresolvedLabel({ url: 'http://h/plugins/??a/client.js,b/client.js&rev=1' }),
		watch.unresolvedLabel({ url: 'http://h/assets/index-5SrrfWpU.js' }),
		watch.unresolvedLabel({ url: 'http://h/x/' + 'y'.repeat(40) + '.js' }),
	],
	['无 URL(内联脚本)', '插件批次(未按 sourcemap 拆)', 'index-5SrrfWpU.js', 'y'.repeat(27) + '…']);
check('"命中"只列非零的腿(没插桩时子树 / DOM写入 / 包名恒为 0,列出来只是噪声)',
	(() => {
		watch.state.ltBlamed = 245;
		watch.state.ltTotal = 348;
		return [
			watch.hitText({ fiber: 245, subtree: 0, dom: 0, owner: 0, none: 103 }),
			watch.hitText({ fiber: 0, subtree: 0, dom: 0, owner: 0, none: 348 }),
			watch.hitText({ fiber: 10, subtree: 5, dom: 0, owner: 2, none: 1 }),
		];
	})(),
	['命中 245/348 · fiber 245 · 未归因 103', '命中 245/348 · 未归因 348', '命中 245/348 · fiber 10/子树 5/包名 2 · 未归因 1']);
check('未插桩时不报「该帧几乎无 JS 解释」(没插桩就没测有没有 JS)',
	(() => {
		watch.state.deep = false;
		watch.state.frameWorst = 342.4;
		watch.state.unattrPeak = 342.4;
		const off = watch.unexplainedFrame();
		watch.state.deep = true;
		const on = watch.unexplainedFrame();
		watch.state.deep = false;
		return [off, on];
	})(),
	[null, { ms: 342.4, percent: 100 }]);
check('未插桩时「帧内未归因」不给数(那时它退化成平均帧间隔,给数就是误导)',
	(() => {
		watch.state.unattrAvg = 16.7;
		watch.state.unattrPeak = 21;
		watch.state.deep = false;
		const off = watch.unattrText();
		watch.state.deep = true;
		const on = watch.unattrText();
		watch.state.deep = false;
		return [off, on];
	})(),
	['要深录', '16.7ms · 峰 21ms']);
check('D5:跨度写成人读得懂的(秒级以下不写;分/时各自带单位)',
	[watch.spanText(0), watch.spanText(47000), watch.spanText(2592000), watch.spanText(3780000)],
	['0秒', '47秒', '43分12秒', '1小时3分']);
check('D5:窗口那三行必须带分母(条数 + 跨度 + 平均每条)—— 累计数不写分母会被读成"一次执行"',
	(() => {
		const tally = watch.scriptPkgTally();
		return [tally.count, tally.spanMs, watch.windowScopeText(tally), watch.windowScopeText({ count: 0, js: 0, spanMs: 0 })];
	})(),
	[3, 1000, '窗口:3 条长动画帧 · 跨 1秒 · 平均每条脚本 53.3ms', '未采集']);
check('D5:invoker 归一到可读名字(SCRIPT[…] → script;带冒号取最后一段;缺失退到 invokerType)',
	[
		watch.invokerLabel({ invoker: 'TimerHandler:setTimeout' }),
		watch.invokerLabel({ invoker: 'DOMWebSocket.onmessage' }),
		watch.invokerLabel({ invoker: 'SCRIPT[src="plugins/??a/client.js,@deepseek"]', invokerType: 'event-listener' }),
		watch.invokerLabel({ invoker: '', invokerType: 'resolve-promise' }),
		watch.invokerLabel({ invoker: null, invokerType: null }),
		watch.invokerLabel({ invoker: 'x'.repeat(60) }),
	],
	['setTimeout', 'DOMWebSocket.onmessage', 'script', 'resolve-promise', '来源未记录', `${'x'.repeat(27)}…`]);
check('D5:按来源与按包是同一份脚本耗时的两种切法:按来源合计 = js,按包只覆盖定到名的',
	(() => {
		const tally = watch.scriptPkgTally();
		const sum = (rows) => Math.round(rows.reduce((acc, [, ms]) => acc + ms, 0) * 10) / 10;
		return [tally.byInvoker, sum(tally.byInvoker), tally.js, sum(tally.top)];
	})(),
	[[['DOMWebSocket.onmessage', 70], ['setTimeout', 60], ['来源未记录', 20], ['Response.json.then', 10]], 160, 160, 150]);
check('D5:脚本三分的文案(本帧与窗口共用同一份);为 0 的那两项不显示',
	[
		watch.jsBreakdownText({ exec: 122, forced: 8, pause: 10 }),
		watch.jsBreakdownText({ exec: 260, forced: 0, pause: 0 }),
		watch.jsBreakdownText({ exec: 1116.8, forced: 10.7, pause: 0 }),
	],
	['纯执行 122ms · 强制 8ms · 暂停 10ms', '纯执行 260ms', '纯执行 1116.8ms · 强制 10.7ms']);

// ── A4:交互延迟(event / element timing,只进导出件)──────────────────
check('A4:浏览器不支持 event timing 时照实报,不假装装上', (() => {
	watch.state.watch.eventObserver = null;
	watch.state.watch.eventState = 'not-started';
	watch.setEntryTypes([]);
	return watch.startInteractions();
})(), 'unsupported:no-event-timing');
check('A4:event 带 durationThreshold、element 单独注册;两者分开计数', (() => {
	watch.setEntryTypes(['event', 'element']);
	watch.state.watch.eventObserver = null;
	watch.state.watch.eventState = 'not-started';
	watch.state.watch.interactions.length = 0;
	watch.state.watch.eventCount = 0;
	watch.state.watch.elementCount = 0;
	const state0 = watch.startInteractions();
	const options = watch.observedOptions();
	watch.emit([
		{ entryType: 'event', name: 'click', startTime: 123.44, duration: 180.26, processingStart: 130, processingEnd: 175, interactionId: 7 },
		{ entryType: 'element', element: 'div#x', startTime: 200, duration: 0, renderTime: 210 },
	]);
	const rows = watch.state.watch.interactions;
	return [state0, options, rows.length, rows[0].name, rows[0].ms, rows[0].waitMs, rows[0].handlerMs, rows[0].isInteraction, rows[0].interactionId, rows[1].type, rows[1].name, rows[1].isInteraction, watch.state.watch.eventCount, watch.state.watch.elementCount];
})(), ['on', ['event:100', 'element'], 2, 'click', 180.3, 6.6, 45, true, 7, 'element', 'div#x', false, 1, 1]);
check('A4:环形上限到了丢最早的(留最近 200 条)', (() => {
	const many = [];
	for (let i = 0; i < watch.WATCH_EVENT_MAX + 5; i += 1) {
		many.push({ entryType: 'event', name: 'input', startTime: 500 + i, duration: 120, processingStart: 501, processingEnd: 505, interactionId: i });
	}
	watch.emit(many);
	const rows = watch.state.watch.interactions;
	return [rows.length, rows[0].at, rows[rows.length - 1].at];
})(), [200, 505, 704]);

// ── 诊断包 ──
watch.state.watch.incidents.length = 0;
watch.state.watch.incidents.push(causeRow);
const pack = watch.buildPack('i9');
check('诊断包:四个文件按固定顺序给出来(manifest 在最前,它是入口)',
	[watch.buildPack('nope'), pack.files.map((file) => file.name)],
	[null, ['manifest.json', 'summary.md', 'incident.json', 'README.md']]);
check('诊断包:manifest 带 schemaVersion / 能力矩阵 / 缺口清单 / 脱敏声明 / 范围', (() => {
	const manifest = JSON.parse(pack.files[0].text);
	return [manifest.schemaVersion, manifest.kind, manifest.capabilities.schema,
		manifest.notIncluded.length, manifest.redaction.applied.length > 0,
		manifest.range.fromMs === undefined ? manifest.range.from !== undefined : true,
		manifest.captureTier, manifest.complete];
})(), [2, 'dsh-perf-hud-diagnostic-pack', 1, 3, true, true, 'watch', null]);
check('诊断包:manifest 里描述的 files 顺序 == 包里真实的顺序(它是入口,指错等于骗人)',
	[JSON.parse(pack.files[0].text).files, pack.files.map((file) => file.name)],
	[['manifest.json', 'summary.md', 'incident.json', 'README.md'], ['manifest.json', 'summary.md', 'incident.json', 'README.md']]);
// ── P2:真事故 fixture(真页面 capture → report → 脱敏落盘)──
check('golden fixture:真事故切片的形状完整(frames / loaf / longTasks / summary / urls)',
	(() => {
		const row = realFixture.incident;
		return [Array.isArray(row.frames) && row.frames.length > 0,
			Array.isArray(row.loaf) && row.loaf.length > 0,
			Array.isArray(row.longTasks),
			Array.isArray(row.urls), Array.isArray(row.summary.topScripts),
			typeof row.window.fromMs === 'number' && typeof row.window.toMs === 'number',
			typeof row.env.perfOrigin === 'string'];
	})(),
	[true, true, true, true, true, true, true]);
check('golden fixture:integrity 是真采集写进来的(不是测试补的),且字段齐全',
	(() => {
		const i = realFixture.incident.integrity;
		return [i !== undefined, typeof i.captureComplete === 'boolean', typeof i.loafDropped === 'number', typeof i.longTaskDropped === 'number', Array.isArray(i.reasons)];
	})(),
	[true, true, true, true, true]);
check('golden fixture:完整现场 → manifest.complete=true,摘要五段齐全、不写"现场不完整"',
	(() => {
		const manifest = EX.manifestFor(realFixture.incident);
		const summary = EX.diagnosticSummary(realFixture.incident);
		return [manifest.complete, manifest.incident.integrity.captureComplete,
			['## 1. 摘要', '## 2. 最可能的假设', '## 3. 缺失的证据', '## 4. 下一步验证', '## 5. 元信息'].every((head) => summary.includes(head)),
			summary.includes('现场不完整')];
	})(),
	[true, true, true, false]);
check('不完整现场:manifest.complete=false,摘要与 missing 都点名,不把缺口藏起来',
	(() => {
		const row = {
			...realFixture.incident,
			integrity: { captureComplete: false, loafDropped: 2, longTaskDropped: 1, loafKept: 19, longTaskKept: 1, reasons: ['loaf-ring-overflow', 'longtask-ring-overflow'] },
		};
		const manifest = EX.manifestFor(row);
		const summary = EX.diagnosticSummary(row);
		return [manifest.complete, summary.includes('现场不完整'), summary.includes('window-integrity:')];
	})(),
	[false, true, true]);
check('诊断包:manifest 与事故包**都不含**凭据(端到端:真 location 里塞过 token)',
	[/SECRET_TOKEN_VALUE/.test(pack.files[0].text), /SECRET_KEY_VALUE/.test(pack.files[2].text), /tester/.test(pack.files[2].text)],
	[false, false, false]);
check('诊断包:摘要按固定形态给五段(摘要 / 假设 / 缺失 / 下一步 / 元信息)',
	['## 1. 摘要', '## 2. 最可能的假设', '## 3. 缺失的证据', '## 4. 下一步验证', '## 5. 元信息']
		.every((head) => pack.files[1].text.includes(head)), true);
check('诊断包:摘要里每条假设都给支持 / 限制 / 出处三行',
	[pack.files[1].text.includes('- 支持:'), pack.files[1].text.includes('- 限制:'), pack.files[1].text.includes('- 出处:')],
	[true, true, true]);
check('诊断包:摘要每条假设的出处只能是三档之一(直接测量 / 归因推断 / 无法确认)',
	(() => {
		const found = pack.files[1].text.split(String.fromCharCode(10)).filter((line) => line.startsWith('- 出处:'));
		// 这份桩只有脚本 + 长任务两支候选(宿主 p99=9.9 不高、worstFrameJs='js' 不走"证据不足"那一支)
		return [found.length, found.every((line) => /直接测量|归因推断|无法确认/.test(line))];
	})(), [2, true]);
check('诊断包:预览把文件体积 / 包含什么 / 排除了什么 / 脱敏都摊出来', (() => {
	const preview = pack.preview;
	return [preview.files.length, preview.files.every((file) => file.bytes > 0), preview.includes.length,
		preview.excludes.length >= 3, preview.redaction.applied.length > 0, preview.missingCount >= 3, preview.note.length > 0];
})(), [4, true, 3, true, true, true, true]);
check('诊断包:自由文本走 dropFreeText 时 manifest 里也留标记', (() => {
	const dropped = watch.buildPack('i9', { dropFreeText: true });
	const manifest = JSON.parse(dropped.files[0].text);
	const incident = JSON.parse(dropped.files[2].text);
	return [manifest.redaction.freeText.length, incident.incident.noteDropped];
})(), [0, true]);
check('诊断包:不存在的 id 返回 null(不静默成功)', [watch.buildPack('nope'), watch.packPreview('nope')], [null, null]);
watch.state.watch.incidents.length = 0;

// ── ③ 两条导出路径:只差自由文本 ──
{
	const saved = watch.state.watch.incidents.slice();
	const noteRow = { ...causeRow, note: '我贴了一段敏感内容 token=SECRET_NOTE' };
	watch.state.watch.incidents.length = 0;
	watch.state.watch.incidents.push(noteRow);
	const ai = watch.buildPack('i9', { dropFreeText: true });
	const full = watch.buildPack('i9', { dropFreeText: false });
	const aiText = ai.files.map((file) => file.text).join(String.fromCharCode(10));
	const fullText = full.files.map((file) => file.text).join(String.fromCharCode(10));
	const aiIncident = JSON.parse(ai.files.find((file) => file.name === 'incident.json').text);
	const fullIncident = JSON.parse(full.files.find((file) => file.name === 'incident.json').text);
	check('AI 包:备注被置空并留标记(连 summary.md 都不能带);完整导出:保留备注但照样脱掉粘贴的凭据',
		[aiIncident.incident.note, aiIncident.incident.noteDropped, /SECRET_NOTE/.test(aiText), /备注:已置空/.test(aiText),
			fullIncident.incident.note, /SECRET_NOTE/.test(fullText)],
		[null, true, false, true, '我贴了一段敏感内容 token=<redacted>', false]);
	check('预览里写明这一份是"丢了备注"还是"留着备注"(两条路不许长得一样)',
		[ai.preview.notes, full.preview.notes], ['dropped', 'kept']);
	check('两条路**只有**自由文本不同:文件清单与脱敏声明其余部分一致',
		[JSON.stringify(ai.files.map((file) => file.name)), JSON.stringify(full.files.map((file) => file.name)),
			ai.preview.files.length, full.preview.files.length], [JSON.stringify(full.files.map((file) => file.name)), JSON.stringify(full.files.map((file) => file.name)), 4, 4]);
	check('包内一直没有凭据:两条路都不出现原样的 token(完整导出把裸 token= 也换成占位符)', [/SECRET_NOTE/.test(aiText), /SECRET_NOTE/.test(fullText), /token=<redacted>/.test(fullText)], [false, false, true]);
	watch.state.watch.incidents.length = 0;
	for (const row of saved) watch.state.watch.incidents.push(row);
}
check('两条导出路径在代码里就是分开的(主界面/AI = dropFreeText:true,完整导出 = false)', (() => {
	return [/onExportGo: \(\) => \{[\s\S]{0,200}?dropFreeText: true/, /onExportPreview: \(id\) => \{ openPackPreview\(id, \{ dropFreeText: true \}\);/,
		/exportPack\(selectedRow === null \? 'latest' : selectedRow\.id, \{ dropFreeText: false \}\)/, /exportPack\(selectedRow === null \? 'latest' : selectedRow\.id, \{ dropFreeText: true \}\)/]
		.map((re) => re.test(renderSource));
})(), [true, true, true, true]);
check('分享前预览是"先看再生成":预览态不落盘,生成之后自动收起', (() => {
	return [/function openPackPreview\(/, /state\.packPreview = packPreview\(id, opts\);/, /onExportGo: \(\) => \{[\s\S]{0,160}?closePackPreview\(\);[\s\S]{0,80}?exportPack/]
		.map((re) => re.test(renderSource));
})(), [true, true, true]);
check('本地预览态不进 localStorage(它不是读数,也没有新键位)',
	/state\.packPreviewId = id;[\s\S]{0,80}?bump\(\);/.test(renderSource) && /LS_VIEW/.test(source), true);

// ═══════════ 捕获计数:与"留存了几份详细现场"彻底分开 ═══════════
// 挡的是这一类事故:留存清单受容量限制(最差 10 + 每天 1),却拿它的条数回答"发生了多少次卡顿"
// —— 被挤掉的卡顿不是没发生,那样回答会系统性少报。所以:计数进时间桶、跨刷新、口径写成断言。
// ⚠️ 另一头也踩过:把"检测到"写成 `captured + coalesced`,真页面上一次卡顿在后摇窗口里
// 每帧都会触发一次,于是一次停顿被记成 18 次 —— 所以**检测到 = triggered**,coalesced 是密度。
const savedTallyIncidents = watch.state.watch.incidents.slice();
watch.state.watch.incidents.length = 0;
watch.clearTally();
// 固定基准时刻,而且**能被 60000 整除** —— 窗口边界落在分钟桶上,用真实时钟会让断言飘
const tallyBase = 1700000040000;

// ── 口径 ──
watch.bumpTally('triggered', tallyBase);
watch.bumpTally('captured', tallyBase + 500);
for (let i = 0; i < 5; i += 1) watch.bumpTally('coalesced', tallyBase + 1000);
watch.bumpTally('dropped', tallyBase + 2000);
watch.noteTallySeverity(tallyBase + 1000, 120);
watch.noteTallySeverity(tallyBase + 20000, 326.5);
watch.noteTallySeverity(tallyBase + 30000, 210);
const tallyA = watch.tallyWindow(3600000, tallyBase + 40000);
check('计数:检测到 = triggered(一次卡顿一串触发只算一次)',
	[tallyA.triggered, tallyA.detected, tallyA.coalesced, tallyA.buckets], [1, 1, 5, 1]);
check('计数:coalesced 不是次数 —— 把两者相加会把**一次**停顿记成 6 次',
	[tallyA.detected === tallyA.triggered, tallyA.detected === tallyA.captured + tallyA.coalesced], [true, false]);
check('计数:最长一次取 max 不是求和(累计和 656.5 不许出现在这里)', tallyA.worstMs, 326.5);
check('计数:抓到了但没留存下来是另一个数(丢失 ▸ dropped),不混进检测到',
	[tallyA.dropped, tallyA.lost, tallyA.detected], [1, 1, 1]);
check('计数:留存份数单独给出来,而且这里就该是 0(证据数与发生数不是一个东西)',
	[tallyA.kept, watch.state.tally.minute.size], [0, 1]);
check('计数:一次 coalesce 连加 N 次只落在一个分钟桶里(不是 N 个桶)',
	watch.tallySum(watch.state.tally.minute.get(Math.floor(tallyBase / 60000))).coalesced, 5);
check('计数:起过捕获却没切成现场的那部分单列(unsettled),并计入丢失', (() => {
	watch.clearTally();
	watch.bumpTally('triggered', tallyBase);
	watch.bumpTally('triggered', tallyBase);
	watch.bumpTally('triggered', tallyBase);
	watch.bumpTally('captured', tallyBase);
	const row = watch.tallyWindow(3600000, tallyBase);
	return [row.triggered, row.captured, row.detected, row.unsettled, row.lost];
})(), [3, 1, 3, 2, 2]);

// ── 窗口按分钟桶切,而且实际范围照实给出来 ──
watch.clearTally();
watch.bumpTally('triggered', tallyBase - 2 * 3600000);
watch.bumpTally('triggered', tallyBase - 30 * 60000);
const tallyH1 = watch.tallyWindow(3600000, tallyBase);
const tallyH24 = watch.tallyWindow(24 * 3600000, tallyBase);
check('计数:1 小时窗口只收 30 分钟前那次,24 小时窗口两次都在',
	[tallyH1.detected, tallyH24.detected], [1, 2]);
check('计数:窗口的实际覆盖范围照实给出来(不吹成"正好 24 小时")',
	[tallyH24.coveredFromMs <= tallyBase - 24 * 3600000 + 60000, tallyH24.coveredToMs >= tallyBase + 1,
		tallyH24.windowMs], [true, true, 24 * 3600000]);

// ── 裁剪与日汇总 ──
watch.clearTally();
watch.bumpTally('triggered', tallyBase - 25 * 3600000);   // 先记 25 小时前的
watch.bumpTally('triggered', tallyBase - 60000);
watch.bumpTally('triggered', tallyBase - 60000);
watch.bumpTally('coalesced', tallyBase - 60000);
const tallyDay = watch.tallyOfDay(watch.tallyDayKey(tallyBase - 60000));
check('计数:日汇总与分钟桶同一口径(2 次检测到 + 1 次同串归并)',
	[tallyDay.triggered, tallyDay.coalesced, tallyDay.detected, tallyDay.exists], [2, 1, 2, true]);
check('计数:24 小时之外的分钟桶被丢掉,而且被丢掉这件事有计数(不静默)',
	[watch.state.tally.expiredBuckets >= 1,
		watch.state.tally.minute.has(Math.floor((tallyBase - 25 * 3600000) / 60000))],
	[true, false]);
check('计数:不存在的日期如实说 exists:false 且全 0,不补造数字',
	(() => { const row = watch.tallyOfDay('1999-01-01'); return [row.exists, row.detected, row.captured, row.worstMs]; })(),
	[false, 0, 0, 0]);
const tallyKeyA = watch.tallyDayKey(tallyBase - 60000);
const tallyKeyB = watch.tallyDayKey(tallyBase - 120000);
watch.bumpTally('triggered', tallyBase - 120000);
check('计数:跨分钟的同一天会合并到同一条日汇总(键相同则两读都是 3)',
	[watch.tallyOfDay(tallyKeyA).triggered, watch.tallyOfDay(tallyKeyB).triggered],
	tallyKeyA === tallyKeyB ? [3, 3] : [2, 1]);

// ── 落盘 / 读回 / 坏数据 ──
watch.clearTally();
watch.bumpTally('triggered', tallyBase - 60000);
watch.bumpTally('captured', tallyBase - 60000);
watch.bumpTally('coalesced', tallyBase - 60000);
watch.noteTallySeverity(tallyBase - 60000, 250);
const tallyBefore = watch.tallyWindow(24 * 3600000, tallyBase);
check('计数:落盘成功,而且体积很小(稀疏桶 —— 空转近乎 0 字节)', (() => {
	const ok = watch.saveTally();
	return [ok, String(watch.store.get(watch.LS_TALLY)).length < 512];
})(), [true, true]);
// 模拟"刷新":只清内存,不动落盘那份
watch.state.tally.minute.clear();
watch.state.tally.day.clear();
watch.state.tally.prunedMinute = -1;
watch.state.tally.loadError = null;
watch.restoreTally();
const tallyAfter = watch.tallyWindow(24 * 3600000, tallyBase);
check('计数:读回之后窗口读数与落盘前一致(刷新后"最近一小时几次"还答得出来)',
	[tallyAfter.detected, tallyAfter.captured, tallyAfter.coalesced, tallyAfter.worstMs],
	[tallyBefore.detected, tallyBefore.captured, tallyBefore.coalesced, tallyBefore.worstMs]);
watch.store.set(watch.LS_TALLY, '{not json');
watch.state.tally.minute.clear();
check('计数:落盘坏了照实记原因,不伪装成"读回 0 条"',
	(() => { watch.restoreTally(); return [/^parse:/.test(watch.state.tally.loadError ?? ''), watch.state.tally.minute.size]; })(),
	[true, 0]);
check('计数:形状不对的桶整桶丢掉并记原因,好桶照常读回(不静默变 0,也不静默吞掉)',
	(() => {
		// 合法桶是 7 元(triggered/captured/coalesced/dropped/failed/worstMs/trimmed);第 2 条少了一个字段
		watch.store.set(watch.LS_TALLY, JSON.stringify({ v: 1, savedAt: 5, minute: { 100: [1, 1, 0, 0, 0, 50, 0], 101: [1, 2] }, day: {} }));
		watch.state.tally.minute.clear();
		watch.state.tally.loadError = null;
		watch.restoreTally();
		return [watch.state.tally.minute.size, watch.state.tally.loadError, watch.state.tally.savedAt];
	})(), [1, 'shape:1', 5]);
check('计数:认不出的 kind 不静默记到别的地方去', watch.bumpTally('nope', tallyBase), null);
check('计数:清频次是单独一条路(要清得明说)', typeof watch.clearTally, 'function');

// ── 真路径接线:触发 / 归并 / 结算都真写进桶 ──
watch.clearTally();
watch.state.watch.pending = null;
watch.state.watch.pendingTimer = 0;
watch.state.watch.coveredUntil = 0;
watch.state.watch.on = true;
watch.setNow(0);
watch.triggerCapture('frame', 100000, 150);        // 起一次 pending(后摇 3 秒还没到)
watch.triggerCapture('frame', 101000, 150);        // 被并进 pending → coalesced
const tallyTriggered = watch.tallyWindow(24 * 3600000);
const tallySettleIndex = watch.timers.length - 1;
const tallySettled = (() => {
	watch.runTimer(tallySettleIndex);              // 后摇到点 → settleCapture → captured
	return watch.tallyWindow(24 * 3600000);
})();
check('计数:触发(检测到 1 · 同串归并 1)与结算(切成 1 份现场)都真进了桶',
	[tallyTriggered.detected, tallyTriggered.coalesced, tallyTriggered.captured,
		tallySettled.detected, tallySettled.coalesced, tallySettled.captured],
	[1, 1, 0, 1, 1, 1]);

// ── 文案与静态约束 ──
watch.clearTally();
watch.bumpTally('triggered', tallyBase - 120000);
watch.bumpTally('coalesced', tallyBase - 120000);
watch.noteTallySeverity(tallyBase - 120000, 326.5);
check('计数:悬停把四个数各自的名字与口径都写出来(同串触发不是次数 / 留存受容量限制 / 最长一次)',
	(() => {
		const lines = watch.tallyTitle(24 * 3600000, tallyBase).split(String.fromCharCode(10));
		return [lines.length, lines[0].includes('检测 1 次'), lines[0].includes('同一串卡顿算一次'),
			lines[1].includes('同串触发 1'), lines[1].includes('密度,不是次数'),
			lines[2].includes('已保存现场'), lines[2].includes('不等于检测到'), lines[3].includes('丢失'), lines[4].includes('327')];
	})(), [5, true, true, true, true, true, true, true, true]);
check('计数:导出件里那一份带窗口范围与两句口径(不是事故窗口 / 别和会话计数相加)',
	(() => {
		const row = watch.tallyReport(tallyBase);
		return [row.detected, row.coalesced, typeof row.coveredFrom, /不是同一个窗口/.test(row.sessionCounters),
			/detected = triggered/.test(row.scope), /密度,不是次数/.test(row.scope), row.worstMs];
	})(), [1, 1, 'string', true, true, true, 326.5]);
check('计数:折叠药丸不再拿留存份数当发生次数(静态)', (() => {
	const at = renderSource.indexOf('const pillTally = tallyWindow(');
	if (at === -1) return [false, false];
	const seg = renderSource.slice(at, renderSource.indexOf("h('button'", at));
	return [true, seg.includes('incidents.length') === false];
})(), [true, true]);
check('计数:清事故不动计数桶(清掉的是证据,不是事实);而且设置页与 API 共用这一条实现', (() => {
	const body = extract(source, 'function clearIncidentsNow(');
	return [body.includes('tally') === false, body.includes('watch.incidents.length = 0'), /clearIncidents: clearIncidentsNow,/.test(source)];
})(), [true, true, true]);

// 这一段动过真事故数组,收尾还原,别影响别的断言
watch.state.watch.incidents.length = 0;
for (const row of savedTallyIncidents) watch.state.watch.incidents.push(row);
watch.clearTally();

console.log(failed === 0 ? 'ALL PASS' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
