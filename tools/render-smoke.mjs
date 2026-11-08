#!/usr/bin/env node
/**
 * 离线渲染冒烟 —— 真页面验收器的离线替身(1.0 / S2,交付 4)。
 *
 *   node tools/render-smoke.mjs [-v]
 *
 * 它挡的正是 check-panel 当年挡的那一类事故:**三套件全绿、浏览器里一展开就 ReferenceError**。
 * 离线套件只抽纯函数,而渲染层里那些"模块作用域的裸标识符 / 分支里才用的变量"
 * 只有真的跑一遍 `PerfHud()` 才会响。这里不画像素:用最小桩把组件树建出来,再走一遍取文本。
 *
 * 六个屏各渲染一遍:主界面 / 卡顿详情(历史上下文)/ 开发者详情五个页签 / 设置 / 收起态。
 * 每屏断言:① 不抛错;② 关键文案在场(用真词典,不是 key);③ 正文里没有"漏成 key"的文案
 * (translate 退回 key 的表现——真页面上会把 exportPreviewCopy 这种内部键名直接印出来)。
 *
 * ⚠️ 结构桩的边界:数据类 dep 大多是"通用假值"(可调用、可读属性、可当空数组用),所以它**不**验
 * 读数对不对 —— 那是三套件与真页面验收器的事。它只回答一个离线能回答的问题:
 * "这条渲染路径在这个状态下还跑得下去吗"。dep 漏传 / 拼错**不归这里管**(deps 是 Proxy,缺的键会被兜成
 * 可调用假值)—— 那是 tests/logic.mjs 的 createUi 依赖守卫。
 */
import { readFileSync } from 'node:fs'

const VERBOSE = process.argv.includes('-v')

// ───────────────────────── 桩:React / 元素树 / 样式 / 计时器 ─────────────────────────
const fake = (() => {
	const node = function () { return node }
	const proxy = new Proxy(node, {
		get(_, key) {
			if (key === Symbol.toPrimitive) return () => ''
			if (key === 'toString' || key === 'toFixed' || key === 'toUpperCase' || key === 'toLowerCase') return () => ''
			if (key === 'then') return undefined
			if (key === 'length') return 0
			if (['map', 'filter', 'slice', 'concat', 'flat', 'sort', 'keys', 'entries', 'values'].includes(key)) return () => []
			return proxy
		},
		apply() { return proxy },
		has() { return true },
	})
	return proxy
})()
// 样式桩:每个 token 既能当对象展开({...S.head}),也能当函数调用(S.root(false, w))
const styleStub = new Proxy(function () { return {} }, { get: () => '' })
const S = new Proxy({}, { get: () => styleStub })
const h = (type, props, ...children) => ({
	type,
	props: props ?? {},
	children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
})
const React = {
	createElement: h,
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
	useEffect: () => {},
	useLayoutEffect: () => {},
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useRef: (value) => ({ current: value }),
	Fragment: 'fragment',
}

// ───────────────────────── 全局桩:渲染路径会碰到的浏览器对象 ─────────────────────────
// 只在渲染时真的会读的范围内给最小实现:真量 DOM 是 check-panel 的事。
const elementStub = () => ({
	style: {}, dataset: {}, children: [],
	setAttribute() {}, removeAttribute() {}, appendChild() {}, removeChild() {},
	addEventListener() {}, removeEventListener() {}, click() {},
	getBoundingClientRect: () => ({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 }),
	querySelector: () => null, querySelectorAll: () => [],
})
globalThis.document = {
	visibilityState: 'visible',
	body: elementStub(), documentElement: elementStub(),
	querySelector: () => null, querySelectorAll: () => [],
	createElement: () => elementStub(), addEventListener() {}, removeEventListener() {},
}
globalThis.localStorage = {
	_store: new Map(),
	getItem(key) { return this._store.has(key) ? this._store.get(key) : null },
	setItem(key, value) { this._store.set(key, String(value)) },
	removeItem(key) { this._store.delete(key) },
	key(index) { return [...this._store.keys()][index] ?? null },
	get length() { return this._store.size },
}
// Node 26 的 navigator 只有 getter:用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'smoke', hardwareConcurrency: 8, language: 'zh-CN' } })
Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080', pathname: '/', hash: '' } })
// ───────────────────────── 加载真实源码:词典 / 状态字面量 / 渲染层 ─────────────────────────
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const clientSource = read('client.js')
const uiSource = read('client.ui.js')
const i18nSource = read('client.i18n.js')

function loadChunk(source, label) {
	let definition = null
	new Function('window', source)({ __ModuleLoader__: { load: (value) => { definition = value } } })
	if (definition === null) throw new Error(`${label} 没有注册分片`)
	return definition.factory(() => { throw new Error(`${label} 不需要 require`) })
}
const { DICT } = loadChunk(i18nSource, 'client.i18n.js')
const { createUi } = loadChunk(uiSource, 'client.ui.js')
const dict = DICT.zh
const translate = (key) => (Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key)

// 状态字面量直接从 client.js 里抽(与 logic.mjs 同一手法):渲染层读的字段必须与线上同形。
const literal = (() => {
	const start = clientSource.indexOf('const state = {')
	let depth = 0
	const from = clientSource.indexOf('{', start)
	for (let i = from; i < clientSource.length; i += 1) {
		if (clientSource[i] === '{') depth += 1
		else if (clientSource[i] === '}') { depth -= 1; if (depth === 0) return clientSource.slice(from, i + 1) }
	}
	throw new Error('client.js 里找不到 state 字面量')
})()
const freshState = () => new Function('TALLY_TREND_SHORT_MS', 'TALLY_TREND_LONG_MS', `return ${literal}`)(3600000, 604800000)

// ───────────────────────── 语义桩:渲染路径要跨过的最小事实 ─────────────────────────
function makeDeps(state) {
	const overrides = {
		React, h, S, state, translate,
		W: { innerWidth: 1400, innerHeight: 900, devicePixelRatio: 2, __DSH_BOOT__: undefined },
		performance: globalThis.performance,
		natives: { setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: (fn) => setTimeout(fn, 16), cancelAnimationFrame: clearTimeout },
		ROOT_ID: 'dsh-perf-hud-root',
		MONO_FONT: 'ui-monospace',
		LS_UI: 'dsh-perf-hud:collapsed',
		// 武装窗口:按钮上的秒数来自主文件的常量(真值 60;这里只是同一形状的桩)
		ARMED_WINDOW_SECONDS: 60,
		armNow: () => ({ ok: true, state: 'armed' }),
		disarmArmed: () => ({ ok: true, state: 'ended' }),
		Top: 3,
		// 尺寸 / 位置:与真实现同形的最小版本
		PANEL_WIDTH: 396,
		panelWidthFor: () => 396,
		pillCompact: () => false,
		hudPosClamp: () => null,
		hudPosMake: () => null,
		hudPosMaxHeight: () => 600,
		HUD_POS_MIN_ROOM: 200,
		HUD_POS_PILL_ROOM: 160,
		saveHudPos: () => {},
		hudDodge: () => null,
		// 场景 / 健康:主界面第一屏要判断"顺不顺"
		healthVerdict: () => ({ level: 'ok', reason: '' }),
		healthText: () => '流畅',
		healthIcon: () => '●',
		sceneChip: () => ({ text: '空闲', color: 'var(--x)' }),
		infraVerdict: () => ({ level: 'ok', reason: '' }),
		hostFreshness: () => ({ state: 'off', loop: null, ageMs: null }),
		levelFrame: () => 'var(--x)',
		levelUp: () => 'var(--x)',
		severityLevel: () => 'warn',
		severityText: () => '警告',
		severityColor: () => 'var(--x)',
		verdictColor: () => 'var(--x)',
		// 读数:空但是"有形状"的
		pluginTable: () => [],
		selectedIncident: () => ({ row: null, auto: true }),
		diagMode: () => 'live',
		worstLongTask: () => null,
		frameMixRows: () => [],
		frameMixCountText: () => '0',
		tallyWindow: () => ({ detected: 0, kept: 0, lost: 0 }),
		causeCandidates: () => [],
		detailContext: () => ({ row: null, mode: 'live', missing: [] }),
		capabilityMissing: () => ({ missing: [], howToAdd: [] }),
		anyGroupOpen: () => false,
		layoutDirty: () => false,
		collapseAll: () => {},
		bump: () => {},
		copyText: () => true,
		clearIncidentsNow: () => {},
		group: (key, label, summary, ...children) => h('div', { style: {} },
			h('span', null, `${label} ${summary}`),
			state.ui.groups[key] === true ? h('div', null, ...children) : null),
	}
	const deps = new Proxy(overrides, {
		get(target, key) {
			if (key in target) return target[key]
			return fake
		},
		has: () => true,
	})
	return deps
}

// ───────────────────────── 树 → 文本 ─────────────────────────
function textOf(node, out = []) {
	if (node === null || node === undefined || node === false) return out
	if (typeof node === 'string') { out.push(node); return out }
	if (typeof node === 'number') { out.push(String(node)); return out }
	if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
	if (typeof node === 'object') {
		for (const key of ['title', 'aria-label']) if (typeof node.props?.[key] === 'string') out.push(node.props[key])
		for (const child of node.children ?? []) textOf(child, out)
	}
	return out
}

const DICT_KEYS = new Set(Object.keys(dict))
const leakedKeys = (texts) => [...new Set(texts.filter((text) => DICT_KEYS.has(text) && text.length > 3))]

// ───────────────────────── 六个屏 ─────────────────────────
let failed = 0
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (!ok) failed += 1
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`)
}

// 五个页签的标签在每一屏都渲染(标签栏常显)—— 逐屏断言它,等于钉住"五个页签一个都没被删"
const DEV_TABS = ['帧与归因', 'DOM 与堆', '宿主', '工具箱', '原始数据']
const SCREENS = [
	{ name: '主界面', setup: (state) => { state.ui.view = 'main'; state.ui.collapsed = false; state.watch.mode = 'live' }, expect: ['性能 HUD', '导出诊断报告'] },
	// 卡顿详情:这一屏没有事故数据时也要给「武装」入口(它服务的是下一次卡顿,不依赖 row)
	{ name: '卡顿详情(历史上下文)', setup: (state) => { state.ui.view = 'incident'; state.ui.collapsed = false; state.watch.mode = 'incident' }, expect: ['卡顿详情', '还没抓到', '武装 60 秒'] },
	// 武装中:剩余秒数 + 取消(取消是真还原,不是装饰按钮)
	{ name: '卡顿详情 · 武装中', setup: (state) => {
		state.ui.view = 'incident'; state.ui.collapsed = false; state.watch.mode = 'incident';
		state.render.armed = {
			...state.render.armed, phase: 'armed', windowSeconds: 60,
			startedAt: Date.now() - 20000, endsAt: Date.now() + 40000, captured: 1,
			hostReceipt: { ...state.render.armed.hostReceipt, phase: 'active', active: true, segments: 2, kept: 2 }
		};
	}, expect: ['武装中', '还剩', '取消', '宿主段 2'] },
	// 武装已结束:结果一行 + 按钮回来(可以再武装一次)
	{ name: '卡顿详情 · 武装结束', setup: (state) => {
		state.ui.view = 'incident'; state.ui.collapsed = false; state.watch.mode = 'incident';
		state.render.armed = { ...state.render.armed, phase: 'ended', windowSeconds: 60, startedAt: Date.now() - 70000, endsAt: Date.now() - 10000, endedAt: Date.now() - 10000, captured: 2, restored: 1 };
	}, expect: ['武装结束', '已还原', '武装 60 秒'] },
	{ name: '开发者详情 · 帧与归因', setup: (state) => { state.ui.view = 'dev'; state.ui.devTab = 'frames'; state.ui.collapsed = false }, expect: [...DEV_TABS, '深录'] },
	{ name: '开发者详情 · DOM 与堆', setup: (state) => { state.ui.view = 'dev'; state.ui.devTab = 'dom'; state.ui.collapsed = false }, expect: DEV_TABS },
	{ name: '开发者详情 · 宿主与链路', setup: (state) => { state.ui.view = 'dev'; state.ui.devTab = 'host'; state.ui.collapsed = false }, expect: DEV_TABS },
	{ name: '开发者详情 · 工具箱', setup: (state) => { state.ui.view = 'dev'; state.ui.devTab = 'tools'; state.ui.collapsed = false }, expect: DEV_TABS },
	{ name: '开发者详情 · 原始数据', setup: (state) => { state.ui.view = 'dev'; state.ui.devTab = 'raw'; state.ui.collapsed = false }, expect: DEV_TABS },
	{ name: '设置', setup: (state) => { state.ui.view = 'settings'; state.ui.collapsed = false }, expect: ['设置', '记录模式', '数据保留'] },
	{ name: '收起态(药丸)', setup: (state) => { state.ui.collapsed = true }, expect: ['性能 HUD', 'fps'] },
	// HUD 关着也是一条真实路径:主界面会给出"监测受限"而不是一串 0(不许伪装成正常)
	{ name: '关闭态(HUD 没在采)', off: true, setup: (state) => { state.ui.view = 'main'; state.ui.collapsed = false }, expect: ['已关'] },
]

for (const screen of SCREENS) {
	const state = freshState()
	// 默认按"HUD 开着"渲染;`off: true` 的那屏专门走"没在采"的降级分支
	state.render.on = screen.off !== true
	state.render.want = screen.off !== true
	screen.setup(state)
	const ui = createUi(makeDeps(state))
	let tree = null
	let error = null
	try {
		tree = ui.PerfHud()
	} catch (cause) {
		error = cause instanceof Error ? `${cause.message}` : String(cause)
	}
	check(`${screen.name}:渲染不抛错`, error, null)
	if (error !== null) continue
	const texts = textOf(tree)
	if (VERBOSE) console.log(`     ${screen.name} 文本片段:${JSON.stringify(texts.slice(0, 24))}`)
	for (const expect of screen.expect) check(`${screen.name}:关键文案在场(${expect})`, texts.some((text) => text.includes(expect)), true)
	check(`${screen.name}:没有漏成 key 的文案`, leakedKeys(texts), [])
}

console.log(failed === 0 ? 'ALL PASS(离线渲染冒烟)' : `FAILURES=${failed}`)
process.exitCode = failed === 0 ? 0 : 1
