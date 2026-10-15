/**
 * 死代码报告(人工看的,不是门禁):
 *
 *   node tools/dead-code.mjs            # 列出 client.js / index.js 里"只有声明、没有引用"的函数
 *   node tools/dead-code.mjs --strict   # 有死函数就退出码 1(给"清完再合"这类场景用)
 *
 * 为什么需要它:本仓库有**一个持续的生产死代码的模式** —— 某一轮把功能的**面板入口**撤掉(例:
 * 4393ea8 撤掉隔离实验 / 验收 / 场景标记三块),纯函数与词典键留在文件里,而 `tests/logic.mjs`
 * 仍然抽出那些函数来断言。于是三套件**全绿**,可它们永远不会在界面上出现 —— 改坏了也没有
 * 任何用户可见的变化,绿是假的。REVIEW §3.4 记的 `pkgZeroText` 债就是同一形态(不可达分支 +
 * 直接测那个函数的断言),已经坑过一次。
 *
 * 判据刻意保守:**整个文件里 `\b名字\b` 只出现一次**(就是它自己的声明)才算死。
 * 这样"被当回调传出去"(`onClick: exportJson`)、"挂进 __perfHud"(对象简写 `mark: addMark`)
 * 都会被算成引用 —— 不会把"只在控制台可达"的 API 误报成死代码。
 * 代价是**局部变量遮蔽**会漏报(同名局部变量用了几次就算活了);这类漏报交给人工复核。
 *
 * 它不是 `npm test` 的一部分:会报出"控制台专用但确实还被文档承诺着"的函数,需要人判。
 */
import { readFileSync } from 'node:fs';

const strict = process.argv.includes('--strict');
const FILES = ['client.js', 'index.js'];

/** `\b名字\b` 在全文里的出现次数。 */
const countRefs = (text, name) => {
	const safe = name.replace(/\$/g, '\\$');
	return [...text.matchAll(new RegExp(`\\b${safe}\\b`, 'g'))].length;
};

/**
 * 去掉**整行注释**再数引用。
 *
 * 为什么必须去:注释里提到一个函数名会让它"看起来被引用"—— 实测 `levelDown()` 当时只被一句
 * `原来只看 fps(levelDown)` 的注释提到,定义在 7740 却没有任何调用点,不去注释就漏报
 * (它已随死代码层一起删;这条判据留着,因为同一形态还会再出现)。
 * 只丢"整行都是注释"的行(`//` / `*` / `/*` 开头),不碰行尾注释、不动字符串 —— 宁可漏,
 * 不能因为一个正则把代码切坏(切坏了会把真函数报成死的,那更糟)。
 */
const stripCommentLines = (text) => text.split('\n').filter((line) => {
	const t = line.trim();
	return t.startsWith('//') === false && t.startsWith('*') === false && t.startsWith('/*') === false;
}).join('\n');

/** 按缩进收集函数声明:返回 [{ name, line }](同名只留第一处)。 */
const declarations = (text, indent) => {
	const out = new Map();
	const re = new RegExp(`^\\t{${indent}}(?:async )?function ([A-Za-z_$][\\w$]*)\\s*\\(`, 'gm');
	for (const match of text.matchAll(re)) {
		if (out.has(match[1])) continue;
		out.set(match[1], text.slice(0, match.index).split('\n').length);
	}
	return out;
};

let total = 0;
for (const file of FILES) {
	const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
	// client.js 的函数都在 factory 里(2 个 tab),index.js 的是模块顶层(0 个 tab)
	const indent = file === 'client.js' ? 2 : 0;
	const code = stripCommentLines(text);
	const dead = [];
	for (const [name, line] of declarations(text, indent)) {
		if (countRefs(code, name) <= 1) dead.push({ name, line });
	}
	dead.sort((a, b) => a.line - b.line);
	total += dead.length;
	console.log(`\n${file}:${dead.length === 0 ? ' 没有只有声明没有引用的函数' : ''}`);
	for (const row of dead) console.log(`  ${file}:${row.line}  ${row.name}`);
}

console.log(`\n合计 ${total} 个候选。⚠️ 它们**不一定**都该删:`);
console.log('  · 真死代码 → 删(同时删 tests/logic.mjs 里对应的断言,否则留下假的绿灯)');
console.log('  · 只在控制台可达、且 README/AGENTS 承诺过的 → 保留,但检查文档里那一条是不是真的存在');
console.log('  · 局部变量遮蔽导致的漏报 → 本工具不报,人工复核');
if (strict === true && total > 0) process.exitCode = 1;
