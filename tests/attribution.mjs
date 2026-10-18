/**
 * 归因 URL 解析的离线回归:
 *
 *   node tests/attribution.mjs
 *
 * 从 client.js 抽出真实的 PLUGIN_URL / ownerOfUrl 来测,避免测试与实现漂移。
 * URL 形状来自 dsh-client-modules@0.2.0-rc.2:
 *   单包/合并脚本  plugins/??<包名>/client.js&rev=<hash>     ← 一个包
 *   合并批次       plugins/??a/client.js,b/client.js&rev=<..> ← 多包同 URL
 *   包内分片       plugins/<包名>/<分片>.js?rev=<hash>
 * 多包时不再拼成一串包名(没有边界标记,猜不出来),返回 bundle key 交给
 * sourcemap 分段解析(见 tests/logic.mjs 的 sectionOwner 用例)。
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
// 归因 URL 解析已搬进 client.model.js 分片:抽实现要抽分片那份(主文件里只剩包装)。
const modelSource = readFileSync(new URL('../client.model.js', import.meta.url), 'utf8');
const lib = (header) => (modelSource.includes(header) ? modelSource : source);

/** 按 header 抽出"从 header 起到配对右括号"的源码;识别字符串与行注释。 */
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

const line = (header) => source.slice(source.indexOf(header), source.indexOf('\n', source.indexOf(header)));
const libLine = (header) => lib(header).slice(lib(header).indexOf(header), lib(header).indexOf('\n', lib(header).indexOf(header)));
const chunk = [
	line('const BUNDLE_PREFIX = '),
	libLine('const PLUGIN_URL = '),
	// state 里用到视图模型的两条窗口常量 —— 排在 state 之前(否则 TDZ)
	line('const TALLY_TREND_SHORT_MS = '),
	line('const TALLY_TREND_LONG_MS = '),
	`${extract(source, 'const state = {')};`,
	extract(lib('function isCore('), 'function isCore('),
	extract(lib('function ownerOfUrl('), 'function ownerOfUrl('),
	'const bundleMaps = new Map();',
	'const bundleMeta = new Map();',
].join('\n');

const ownerOfUrl = new Function(`${chunk}\nreturn ownerOfUrl;`)();

let failed = 0;
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failed += 1;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
};

const single = 'http://127.0.0.1:3080/plugins/??dsh-status-rotator/client.js&rev=ab12';
const scoped = 'http://127.0.0.1:3080/plugins/??@deepseek-ai/dsh-client-ui-layout/client.js&rev=ab12';
const batch = 'http://127.0.0.1:3080/plugins/??a/client.js,b/client.js&rev=1';

check('单包 combo → 包名', ownerOfUrl(single), 'dsh-status-rotator');
check('作用域包 → 全名', ownerOfUrl(scoped), '@deepseek-ai/dsh-client-ui-layout');
check('无前导斜杠的相对形态', ownerOfUrl('plugins/??dsh-notch/main.js&rev=1'), 'dsh-notch');
check('栈行(带冒号与括号)', ownerOfUrl(`at foo (${single}:120:3)`), 'dsh-status-rotator');
check('包内分片(作用域)', ownerOfUrl('http://127.0.0.1:3080/plugins/@deepseek-ai/dsh-client-ui-chat/client.chunk-3.js?rev=9'), '@deepseek-ai/dsh-client-ui-chat');
check('包内分片(无作用域)', ownerOfUrl('http://127.0.0.1:3080/plugins/dsh-better-sidebar/client.js?rev=7'), 'dsh-better-sidebar');
check('多包同 URL → bundle key(不再拼包名)', ownerOfUrl(batch), `bundle:${batch}`);
check('多包 key 可反查原 URL', ownerOfUrl(batch).slice('bundle:'.length), batch);
check('非插件脚本 → null', ownerOfUrl('http://127.0.0.1:3080/assets/index-abc.js'), null);
check('页面根 → null', ownerOfUrl('http://127.0.0.1:3080/'), null);
check('扩展注入脚本 → null', ownerOfUrl('chrome-extension://abc/inject.js'), null);

console.log(failed === 0 ? `ALL PASS (${11})` : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
