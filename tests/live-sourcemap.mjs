/**
 * A(精确归因)的线上验证:不用浏览器,直接对运行中的 DSH 拿真实 sourcemap 分段表。
 *
 *   COOKIE=$(...)  # 见 ~/.dsh/dsh-api.md 的 token→cookie 三步
 *   DSH_COOKIE="dsh-auth-...=..." node tests/live-sourcemap.mjs
 *
 * 它做四件事:
 *   1. 取首页 HTML 里的 window.__DSH_BOOT__,找到 application 批次的合并 URL 与 rev;
 *   2. 按 client.js 里同一套规则(mapUrlOf)推出 sourcemap URL 并拉取;
 *   3. 断言 sections 数与批次包数一致,且 partition 出的包名与批次 entries 一致;
 *   4. 用每个 section 的 offset.line(0-based)喂进 client.js 真实的 sectionOwner
 *      (V8 行号 1-based),断言能还原出该 section 的包名 —— 这就是面板上
 *      "单包名"的来源,端到端跑通。
 */
import { readFileSync } from 'node:fs';

const cookie = process.env.DSH_COOKIE ?? '';
if (cookie === '') {
	console.error('缺少 DSH_COOKIE(或先用 ~/.dsh/dsh-api.md 的步骤换 cookie)');
	process.exitCode = 2;
	process.exit();
}
const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3080';
const headers = { Host: '127.0.0.1:3080', Cookie: cookie };

let failed = 0;
const check = (name, ok, detail = '') => {
	if (!ok) failed += 1;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  ${detail}`}`);
};

// 从 client.js 抽真实实现,保证验证的就是插件里跑的那份
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
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
		else if (c === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1); }
	}
	throw new Error(`extract: unbalanced ${header}`);
}
const impl = new Function(`
	${extract(source, 'function mapUrlOf(')}
	${extract(source, 'function sectionName(')}
	${extract(source, 'function sectionOwner(')}
	return { mapUrlOf, sectionName, sectionOwner };
`)();

const html = await (await fetch(`${BASE}/`, { headers })).text();
/** 从 `globalThis["__DSH_BOOT__"] = {…}` 里按括号配对取出 JSON(字符串/转义安全)。 */
function readBoot(text) {
	const at = text.indexOf('__DSH_BOOT__');
	if (at === -1) return null;
	const start = text.indexOf('{', at);
	if (start === -1) return null;
	let depth = 0;
	let quote = null;
	for (let i = start; i < text.length; i += 1) {
		const c = text[i];
		if (quote !== null) {
			if (c === '\\') i += 1;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"') { quote = c; continue; }
		if (c === '{') depth += 1;
		else if (c === '}') {
			depth -= 1;
			if (depth === 0) return JSON.parse(text.slice(start, i + 1));
		}
	}
	return null;
}

const graph = readBoot(html);
check('首页里有 __DSH_BOOT__', graph !== null);
check('boot payload 带 batches', Array.isArray(graph?.batches), Object.keys(graph ?? {}).join(','));
const batches = (graph.batches ?? []).filter((batch) => batch.phase === 'application');
check('有 application 批次', batches.length > 0, `共 ${batches.length} 个`);
const batch = batches.reduce((top, item) => (item.entries.length > top.entries.length ? item : top), batches[0]);
console.log(`   批次 ${batch.phase}: ${batch.entries.length} 包,rev=${batch.rev}`);

const scriptUrl = new URL(batch.url, `${BASE}/`).href;
const mapUrl = impl.mapUrlOf(scriptUrl);
check('mapUrlOf 能从批次 URL 推出 map URL', mapUrl !== null && mapUrl.includes('.map'));
const response = await fetch(mapUrl, { headers });
check('sourcemap 取到了', response.ok, `HTTP ${response.status}`);
const mapText = await response.text();
console.log(`   map 体积 ${(mapText.length / 1048576).toFixed(2)} MB`);
const map = JSON.parse(mapText);
check('是 indexed sourcemap', Array.isArray(map.sections) && map.sections.length > 0, `sections=${map.sections?.length}`);
check('sections 数 = 批次包数', map.sections.length === batch.entries.length, `${map.sections.length} vs ${batch.entries.length}`);

const offsets = [];
const names = [];
for (const section of map.sections) {
	const name = impl.sectionName(section);
	if (name === null || typeof section.offset?.line !== 'number') continue;
	offsets.push([section.offset.line, name]);
	names.push(name);
}
offsets.sort((a, b) => a[0] - b[0]);
check('每个 section 都能解析出包名', names.length === map.sections.length, `${names.length}/${map.sections.length}`);
check('包名与批次 entries 一致(顺序也一致)',
	JSON.stringify(names) === JSON.stringify(batch.entries),
	names.slice(0, 3).join(',') + ` … vs ${batch.entries.slice(0, 3).join(',')} …`);
check('offset 严格递增', offsets.every((row, index) => index === 0 || row[0] > offsets[index - 1][0]));

// 端到端:offset.line(0-based)→ V8 行号(1-based)喂进真实 sectionOwner
let bad = 0;
for (let index = 0; index < offsets.length; index += 1) {
	const [line0, name] = offsets[index];
	if (impl.sectionOwner({ offsets }, line0 + 1) !== name) bad += 1;
	if (index > 0 && impl.sectionOwner({ offsets }, line0) !== offsets[index - 1][1]) bad += 1;   // 上一行仍属于上一段
}
check('sectionOwner 在每个 section 起止行都还原正确', bad === 0, `错 ${bad} 处`);

for (const target of ['dsh-status-rotator', 'dsh-notify-me']) {
	const index = names.indexOf(target);
	check(`${target} 作为独立包名出现`, index !== -1, index === -1 ? '' : `section #${index},offset.line=${offsets[index][0]}`);
}

console.log(failed === 0 ? 'ALL PASS' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
