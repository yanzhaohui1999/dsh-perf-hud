#!/usr/bin/env node
/**
 * 从 `client.model.js` 生成诊断 Skill §2.6 的 `missing:` 前缀表(1.0 / S5,交付 7)。
 *
 *   node tools/gen-prefix-table.mjs           # 重写 SKILL.md 里的表
 *   node tools/gen-prefix-table.mjs --check   # 只核:文件与生成结果不一致就退出 1(CI 用这条)
 *
 * 为什么要有它:这张表以前是手抄的。抄过就会漂 —— 2026-11-07 第一次加"代码 vs 表"的双向断言时
 * 就抓到 `host-snapshot:` 与 `loaf-pkg:` 从进代码起就没进过表(中间还发过两个版本)。
 * 手工维护的"单一来源"只是在两边之间加了一条绳子;生成器才是真的只有一个来源。
 *
 * 两类东西是分开的:
 *   - **前缀集合**由代码决定(`missing.push('前缀:…')`),加前缀不跑生成器 → 红;
 *   - **分类与读法**是编辑判断,写在下面 CATEGORIES 里(不是从代码里猜出来的)。
 *     所以"这个前缀该归哪一类"仍然要人想;生成器保证的是"表里一个不多、一个不少"。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const START = '<!-- prefix-table:start(由 tools/gen-prefix-table.mjs 生成,别手改) -->'
const END = '<!-- prefix-table:end -->'
const MODEL = new URL('../client.model.js', import.meta.url)
const SKILL = new URL('../skills/dsh-perf-diagnosis/SKILL.md', import.meta.url)

/**
 * 五类。每行 `[前缀, 括号里的说明(可空)]` —— 同一个前缀可以出现在多类里
 * (例:`interaction-timing:` 可能是浏览器不支持、没开,或只是这个窗口里没到阈值)。
 */
const CATEGORIES = [
	{
		label: '平台 / 浏览器不支持',
		how: '这一层本来就没有,换数据源(longtask / DevTools)',
		rows: [['loaf', 'unsupported'], ['interaction-timing', 'unsupported']],
	},
	{
		label: '没开',
		how: '下一次按 `howToAdd` 开对应档位再抓;**这一条补不了**',
		rows: [['precise', ''], ['instrumentation', ''], ['interaction-timing', 'off']],
	},
	{
		label: '这个窗口没发生 / 没到阈值',
		how: '不是故障,也不等于"没有 JS / 用户没操作"',
		rows: [['loaf-scripts', '这一帧没有脚本'], ['interaction-timing', '窗口内 0 条']],
	},
	{
		label: '结构上不采',
		how: '要这些只能走 DevTools / Chrome trace / 别的机器;别假装包里有',
		rows: [
			['devtools-trace', ''],
			['compositor', ''],
			['interaction-breakdown', ''],
			['element-timing', 'DSH DOM 上没有 elementtiming,恒 0'],
			['baseline', '跨机器 / 跨浏览器基线'],
		],
	},
	{
		label: '采集丢了 / 还没采到',
		how: '这一条的证据不完整;`recorder-cost` 的 0 是"空",不是"零成本"',
		rows: [
			['window-integrity', ''],
			['recorder-cost', '`samples = 0`'],
			['host', '没有宿主快照'],
			['host-snapshot', '有快照,但采在事故之前 / 之后,未必覆盖卡顿瞬间'],
			['loaf-pkg', '这几条脚本没定到包名,冒号后是没定到的原因分布'],
			['host-cpuprofile', '没自动采'],
		],
	},
]

/** 代码里的前缀集合(与 tests/logic.mjs 的同一条口径:每个 push 都以 `前缀:` 开头)。 */
function codePrefixes() {
	const source = readFileSync(MODEL, 'utf8')
	const pushRe = /missing\.push\(\s*[`'"]([a-z][a-z0-9-]*):/g
	const prefixes = [...source.matchAll(pushRe)].map((match) => match[1])
	const pushes = (source.match(/missing\.push\(/g) ?? []).length
	const unprefixed = pushes - prefixes.length
	if (unprefixed !== 0) throw new Error(`client.model.js 里有 ${unprefixed} 处 missing.push( 没有以 \`前缀:\` 开头 —— 先修代码,生成器不猜`)
	return [...new Set(prefixes)].sort()
}

function table() {
	const rows = CATEGORIES.map((category) => {
		const examples = category.rows
			.map(([prefix, note]) => (note === '' ? `\`${prefix}:\`` : `\`${prefix}:\`(${note})`))
			.join('、')
		return `| ${category.label} | ${examples} | ${category.how} |`
	})
	return [
		'| 类别 | 例子 | 读法 |',
		'|---|---|---|',
		...rows,
	]
}

/** 表里出现的前缀集合(用于与代码双向核对)。 */
function tablePrefixes() {
	return [...new Set(CATEGORIES.flatMap((category) => category.rows.map(([prefix]) => prefix)))].sort()
}

function render(skill) {
	const start = skill.indexOf(START)
	const end = skill.indexOf(END)
	if (start === -1 || end === -1 || end < start) throw new Error(`SKILL.md 里找不到 ${START} / ${END} 标记`)
	return `${skill.slice(0, start + START.length)}\n${table().join('\n')}\n${skill.slice(end)}`
}

// 双向核对:代码有而表里没有 / 表里有而代码已不生成 —— 两种都直接失败(不写半张表)
const code = codePrefixes()
const listed = tablePrefixes()
const codeNotListed = code.filter((prefix) => listed.includes(prefix) === false)
const listedNotCode = listed.filter((prefix) => code.includes(prefix) === false)
if (codeNotListed.length > 0) {
	console.error(`❌ 代码里有、CATEGORIES 里没有(先想清它归哪一类,再补进生成器):${codeNotListed.join(' / ')}`)
	process.exit(1)
}
if (listedNotCode.length > 0) {
	console.error(`❌ CATEGORIES 里还写着、代码已经不再生成(删掉它):${listedNotCode.join(' / ')}`)
	process.exit(1)
}

const before = readFileSync(SKILL, 'utf8')
const after = render(before)
const CHECK = process.argv.includes('--check')

if (CHECK) {
	if (after === before) {
		console.log(`✅ 前缀表与 capabilityMissing() 一致(${code.length} 个前缀)`)
		process.exit(0)
	}
	console.error('❌ §2.6 的前缀表与生成结果不一致 —— 跑 `node tools/gen-prefix-table.mjs` 重写它')
	const a = before.split('\n')
	const b = after.split('\n')
	for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
		if (a[i] === b[i]) continue
		console.error(`   ${i + 1}: - ${a[i] ?? '(缺行)'}`)
		console.error(`        + ${b[i] ?? '(缺行)'}`)
		if (i > 0 && a.slice(0, i).filter((line, index) => line !== b[index]).length > 4) break
	}
	process.exit(1)
}

if (after === before) {
	console.log(`前缀表已是最新(${code.length} 个前缀)`)
	process.exit(0)
}
writeFileSync(SKILL, after)
console.log(`✅ 已重写 §2.6 前缀表(${code.length} 个前缀)`)
