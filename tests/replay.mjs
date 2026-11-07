/**
 * 回放站离线断言(1.0 附录 A1):
 *
 *   node tests/replay.mjs
 *
 * 验的是"同一份包,回放器算出来的数与插件面板读到的数一致" ——
 * 面板读包里 `summary`(那是采集当时算的),回放器从 `frames` / `loaf` **现算**;
 * 两边不一致就直接把差异列出来,不靠肉眼看。
 *
 * 另外验 zip 读方与插件的 zip 写方互通(用 client.pack.js 的真 `zipStore` 打一份包再读回来)。
 */
import { readFileSync } from 'node:fs'

const coreSource = readFileSync(new URL('../preview/replay-core.js', import.meta.url), 'utf8')
const packSource = readFileSync(new URL('../client.pack.js', import.meta.url), 'utf8')
const realFixture = JSON.parse(readFileSync(new URL('./fixtures/incident-real.json', import.meta.url), 'utf8'))

// 回放核心是给浏览器写的 classic script:喂一个假的 window 就能在 node 里用(与主检出同源)
const core = (() => {
	const fakeWindow = {}
	new Function('window', coreSource)(fakeWindow)
	if (fakeWindow.ReplayCore === undefined) throw new Error('preview/replay-core.js 没有挂到 window.ReplayCore')
	return fakeWindow.ReplayCore
})()

// 真发货的 zip 写方(store 模式):拿它打包,再让回放器读回来
const packChunk = (() => {
	let definition = null
	new Function('window', packSource)({ __ModuleLoader__: { load: (value) => { definition = value } } })
	if (definition === null) throw new Error('client.pack.js 没有注册分片')
	return definition.factory(() => { throw new Error('client.pack.js 不需要 require') })
})()

let failed = 0
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (!ok) failed += 1
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`)
}

// ① 真事故切片:现算摘要 == 包里 summary(逐项)
const fixture = core.compareSummary(realFixture.incident)
check('真事故 fixture:回放器现算的摘要与包里 summary 逐项一致', [fixture.matches, fixture.diffs, fixture.compared.length >= 10], [true, [], true])
check('真事故 fixture:关键读数对得上(帧数 / p99 / 最差帧)',
	[fixture.computed.frames, fixture.computed.p99, fixture.computed.worstFrameMs],
	[realFixture.incident.summary.frames, realFixture.incident.summary.p99, realFixture.incident.summary.worstFrameMs])

// ② 帧档位与面板同一组阈值
check('帧档位:≥100 红 / ≥50 黄 / 其余正常 / gap 单独一档',
	[core.frameLevel(100), core.frameLevel(99.9), core.frameLevel(50), core.frameLevel(16.7), core.frameLevel(null), core.frameLevel(400, true)],
	['bad', 'warn', 'warn', 'ok', 'none', 'gap'])

// ③ zip 互通:用插件自己的 zipStore 打一份四文件包,回放器读回来
const incidentText = JSON.stringify({ kind: 'perf-hud-incident', schema: 3, context: {}, incident: realFixture.incident })
const manifestText = JSON.stringify({ schemaVersion: 2, kind: 'dsh-perf-hud-diagnostic-pack', plugin: 'dsh-perf-hud', pluginVersion: '0.9.0', captureTier: 'watch', instrumented: false, complete: true, capabilities: { schema: 1, renderer: { frames: { state: 'on' } }, host: {}, link: {} } })
const files = [
	{ name: 'manifest.json', text: manifestText },
	{ name: 'incident.json', text: incidentText },
]
const zipped = packChunk.zipStore(files)
const unzipped = core.unzipStore(zipped)
check('zip:插件 zipStore 写出的包,回放器的读方逐文件读得回来', [unzipped.size, [...unzipped.keys()], unzipped.get('incident.json') === incidentText], [2, ['manifest.json', 'incident.json'], true])
const fromZip = core.parsePack(unzipped)
check('zip:从 zip 解析出的包与原始 incident 同源,摘要照样逐项一致',
	[fromZip.manifest.schemaVersion, fromZip.incident.id, core.compareSummary(fromZip.incident).matches],
	[2, realFixture.incident.id, true])

// ④ 三种输入形状都能认
check('输入形状:单份 incident.json / 事故切片 / 完整包都能认',
	[
		core.parsePack(incidentText).incident.id,
		core.parsePack(JSON.stringify(realFixture)).incident.id,
		core.parsePack(new Map([['incident.json', incidentText]])).incident.id,
	], [realFixture.incident.id, realFixture.incident.id, realFixture.incident.id])

// ⑤ 认不出的输入必须报错(不静默成功)
const errors = []
for (const bad of ['not a zip', '{}', JSON.stringify({ hello: 1 })]) {
	try { core.parsePack(bad) } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
}
check('认不出的输入会报错(不静默成功)', [errors.length, /认不出|没有 incident/.test(errors.join(' / '))], [3, true])

// ⑥ 归因只摊包里已有的三份,不另算
const attribution = core.attribution(realFixture.incident)
check('归因:按包 / 可疑脚本 / longtask 三份都来自包内容,排序稳定',
	[attribution.packages.length > 0, attribution.suspects.length > 0,
		attribution.packages[0].ms >= attribution.packages[attribution.packages.length - 1].ms],
	[true, true, true])

console.log(failed === 0 ? 'ALL PASS(回放站)' : `FAILURES=${failed}`)
process.exitCode = failed === 0 ? 0 : 1
