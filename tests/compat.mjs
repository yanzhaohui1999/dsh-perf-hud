/**
 * 兼容套件:用**上一版 schemaVersion** 的包喂当前读方,断言它还读得出来。
 *
 *   node tests/compat.mjs
 *
 * 为什么单独一套:三套件测的是"当前代码产出的东西对不对";**没有一个盒子测过"上一版的包
 * 现在还能不能读"**。而 1.0 的全部承诺就是这个(见 docs/pack-schema.md §7)。0.x 里改形状
 * 是自由的,也确实一直在改;冻结之后就只剩这套件挡着 —— 它红,说明这次改动把老包弄坏了。
 *
 * 两条读方都跑,别只跑一条:
 *   ① `readPack()` —— 本文下面这份实现,是 docs/pack-schema.md §7.2「旧包怎么读」的可执行版本
 *      (按名字取文件 / 核必需键 / 可选键缺了按不知道 / 未知字段忽略 / 未知版本说差异);
 *   ② `tools/inspect-incident.mjs` —— 仓库里**真发货**的那个读方,读 `incident.json` 渲染成
 *      人读的样子。它的输出里没有"摘要"这两个字,但帧数 / 分位 / 缺失声明就是摘要。
 *
 * 夹具是**真事故**(`tests/fixtures/incident-real.json`)按上一版契约降级出来的:
 *   - manifest:schemaVersion 1 —— 没有 `complete`、带着 0.9.0 已删的 `dshVersion`、
 *     `files` 把 `manifest.json` 写在**第二位**(v1 就是这样);
 *   - incident.json:schema 2 —— 没有 `incident.integrity`;context 里没有 0.9.x 才加的
 *     `hostCpuProfile` / `recorder`。
 * 字段集合由 `git show c970042:client.js` 校准(那是 manifest v1 与 incident v2 一起的提交);
 * `git show c970042:client.js | grep -n "function manifestFor"` 可以复核。
 *
 * ⚠️ 夹具是**手写**的,不是从老版本真导出:数值取自真事故切片,契约形状取自上面那次提交。
 * 所以它证明的是"reads 按这份契约写的包",不是"某个 0.x 版本导出的字节流"。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPackSchema } from './schema.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const realFixture = JSON.parse(readFileSync(new URL('./fixtures/incident-real.json', import.meta.url), 'utf8'))
const packSchema = loadPackSchema()
const row = realFixture.incident

let failed = 0
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (!ok) failed += 1
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`)
}

// ───────────────────────── 上一版(manifest v1 / incident v2)──────────��──────────────
const EXPORTED_AT = '2026-10-17T09:16:02.000Z'
const leaf = (state, provenance, reason) => ({ state, provenance, reason })

// v1 的能力矩阵:叶子与现在**一样**(schema 仍是 1),只是 cpuProfile 那一格还是"没接线"的
// 措辞 —— 这一格是故意的:读方**不许**按 reason 的措辞判断,只能读 state / provenance。
const previousCapabilities = {
	schema: 1,
	renderer: {
		frames: leaf('on', 'measured', '帧环 2089 帧'),
		loaf: leaf('on', 'measured', 'LoAF 观察器:on'),
		longTasks: leaf('on', 'measured', 'longtask 明细 2 条 / 累计 2 条'),
		scriptAttribution: leaf('degraded', 'inferred', '精确归因没开:合并批次只能给整批,拿不到单包名'),
		domWrites: leaf('off', 'inferred', '深录没开:DOM 写入者没有记账'),
		interactions: leaf('on', 'measured', '交互计时:on(窗口内保留 0 条)'),
		elementTiming: leaf('unsupported', 'unknown', 'DSH 的 DOM 上没有 elementtiming 属性,这一路恒为 0'),
	},
	host: {
		eventLoop: leaf('on', 'measured', 'p50/p99/max 已采(2026-10-17T09:15:18.094Z)'),
		events: leaf('on', 'measured', 'session/event 到达延迟:已装'),
		cpuProfile: leaf('off', 'unknown', '宿主路由能采 Node CPU profile,客户端还没接线(要动宿主半,排在后面)'),
	},
	link: {
		rtt: leaf('off', 'measured', '链路样本 0 条(环形缓冲里全部)'),
		throughput: leaf('off', 'measured', '吞吐采样:pending'),
	},
	unobserved: [
		{ id: 'gpu-compositor', reason: '帧时间花在合成 / 光栅 / GPU 的哪一段,页面内没有 API' },
		{ id: 'electron-main', reason: 'Electron 主进程 / GPU 进程这一层本插件没有采' },
		{ id: 'raw-source-lines', reason: '原始源码(TS/TSX)行号要解 section 内层 mappings 的 VLQ,本项目没做' },
		{ id: 'frame-inner-order', reason: '帧内脚本的起止顺序 LoAF 不给(只给每条脚本的时长)' },
		{ id: 'devtools-trace', reason: '完整 Chrome trace 需要 DevTools 录制,页面内录不了' },
	],
}

const previousTally = {
	at: EXPORTED_AT,
	windowMs: 86400000,
	coveredFrom: '2026-10-16T09:16:02.000Z',
	coveredTo: EXPORTED_AT,
	detected: 3, triggered: 3, captured: 2, coalesced: 29, unsettled: 0,
	kept: 2, lost: 1, dropped: 0, trimmed: 0, failed: 0,
	worstMs: 137.1, buckets: 3, expiredBuckets: 0, expiredDays: 0,
	loadError: null, savedAt: EXPORTED_AT,
	scope: 'detected = triggered:一次卡顿一串触发只算一次;coalesced 是同串里被并掉的触发数(密度,不是次数)',
	sessionCounters: '这是导出时刻的滚动 24h 计数;本次会话的计数在 watch.captured 等字段里',
}

const previousManifest = {
	schemaVersion: 1,
	kind: 'dsh-perf-hud-diagnostic-pack',
	plugin: 'dsh-perf-hud',
	pluginVersion: '0.8.0',
	// v1 才有、0.9.0 删掉的字段。它在夹具里是**故意**留着的:读方必须忽略未知键。
	dshVersion: null,
	platform: {
		page: 'http://127.0.0.1:3080/',
		userAgent: 'Chrome/141 · macOS',
		viewport: '1440×900',
		devicePixelRatio: 2,
		hardwareConcurrency: 8,
		utcOffsetMin: 480,
	},
	captureTier: 'watch',
	instrumented: false,
	language: 'zh',
	exportedAt: EXPORTED_AT,
	range: { from: row.window.from, to: row.window.to, preMs: row.window.preMs, postMs: row.window.postMs },
	// v1 的 manifest.incident **没有** integrity(那是 v2 加的)
	incident: {
		id: row.id, at: row.at, cause: row.cause, severity: row.severity,
		frames: row.frames.length, loafEntries: row.loaf.length,
		longTasks: row.longTasks.length, interactions: row.interactions.length,
	},
	tally: previousTally,
	capabilities: previousCapabilities,
	notIncluded: [
		'聊天正文与提示词(本插件从不读取被测量的 DOM 内容)',
		'Cookie / Token / 请求头(只读 performance 观察器与自己的宿主路由回执)',
		'宿主进程的 CPU profile(路由能采,但这份包没有自动采)',
	],
	// v1 就是这样:manifest 写在第二位(实际 zip 里它在最前)。读方按名字找,不按下标。
	files: ['summary.md', 'manifest.json', 'incident.json', 'README.md'],
	redaction: {
		rule: '导出时做减法,不做匿名化;applied / kept / neverCollected 三个数组说明做了什么、没做什么',
		applied: ['page / href:只保留 origin + path,查询串整段丢弃', 'userAgent:只保留浏览器主版本 + 操作系统'],
		kept: ['性能数值本身(毫秒、计数、分位、帧序列)'],
		neverCollected: ['聊天正文与提示词', 'Cookie / Token / 请求头'],
		freeText: ['incident.note', 'timeline.marks[].note'],
	},
}

// 事故行:上一版(incident schema 2)没有 integrity —— 摘掉它,别的都取自真采集。
const { integrity: _droppedIntegrity, ...previousRow } = row
const previousIncident = {
	plugin: 'dsh-perf-hud',
	kind: 'perf-hud-incident',
	schema: 2,
	exportedAt: EXPORTED_AT,
	context: {
		page: 'http://127.0.0.1:3080/',
		userAgent: 'Chrome/141 · macOS',
		scenario: 'idle',
		// v2 的 watch / tally 段(没有交互延迟之外的新字段也没关系:这两段不冻内部键)
		watch: {
			recording: true, loaf: 'on',
			interactions: { state: 'on', supported: true, thresholdMs: 100, events: 0, elements: 0, kept: 0 },
			frameSamples: 2089, frameBudget: 3600, coveredMs: 34800,
			loafEntries: 21, pending: null, captured: 2, coalesced: 29, dropped: 0,
			restored: 0, trimmedByBytes: 0, deduped: 0,
			kept: [{ id: row.id, severity: row.severity, cause: row.cause, at: row.at, note: row.note, tier: row.tier ?? null, day: row.day ?? null }],
		},
		tally: previousTally,
		sessionBaselines: [],
		thresholds: realFixture.thresholds,
		missing: [
			'precise:合并批次里的单包名 —— 也包含 LoAF 脚本的 scripts[].pkg(需要精确归因,会拉那份 12MB 的 map)',
			'devtools-trace:完整的 Chrome trace(页面内录不了)',
		],
		howToAdd: ['面板「深录」(它同时打开精确归因)或 __perfHud.setPrecise(true) —— 只能改善之后抓到的事故,这一条不会重放'],
		howToRead: [
			'incident.frames:窗口内每一帧(t 是 perf 毫秒,要靠 incident.env.perfOrigin 换成墙钟;ms 是帧间隔;gap:true 表示 rAF 被挂起,不是卡顿)',
			'incident.summary 是上面几块的汇总(含窗口自己的 p50/p90/p99),这一层不做推断,结论请自己下',
		],
		redaction: previousManifest.redaction,
	},
	incident: previousRow,
}

const previousSummary = `# 诊断包摘要

## 1. 摘要
- 严重度:${row.severity}ms
- 最差事件:${row.at}

## 2. 最可能的假设
- 某个脚本模块的耗时偏高

## 3. 缺失的证据
- precise:合并批次里的单包名

## 4. 下一步验证
- 打开深录复现一次

## 5. 元信息
- schemaVersion:1
`
const previousReadme = '# 这份包是什么\n\n上一版契约的夹具(manifest v1 / incident v2)。\n'

/** 四份文件:一份按「声明顺序」排,一份按「实际 zip 顺序」排 —— 读方两种都得读得出来。 */
const asDeclared = {
	'manifest.json': JSON.stringify(previousManifest, null, 2),
	'summary.md': previousSummary,
	'incident.json': JSON.stringify(previousIncident, null, 2),
	'README.md': previousReadme,
}
const declaredFiles = previousManifest.files.map((name) => ({ name, text: asDeclared[name] }))
const zipFiles = ['manifest.json', 'summary.md', 'incident.json', 'README.md'].map((name) => ({ name, text: asDeclared[name] }))

// ───────────────────────── 读方(契约 §7.2 的可执行版本)─────────────────────────
const has = (object, key) => object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key)
const isObject = (value) => value !== null && typeof value === 'object' && Array.isArray(value) === false

/**
 * 读一份包。**严格核必需键**(缺一个就抛,点名缺的是哪个),对可选键与未知键一律宽容 ——
 * 这正是 docs/pack-schema.md §7.2 的四步。返回读出来的摘要与能力矩阵。
 */
function readPack(files) {
	const byName = new Map(files.map((file) => [file.name, file.text]))
	const need = (name) => {
		if (byName.has(name) === false) throw new Error(`包里缺 ${name}`)
		return byName.get(name)
	}
	const manifest = JSON.parse(need('manifest.json'))
	const report = JSON.parse(need('incident.json'))

	const missing = []
	for (const key of packSchema.required('manifest.json')) if (has(manifest, key) === false) missing.push(`manifest.json.${key}`)
	if (isObject(manifest.incident) === false) missing.push('manifest.json.incident(不是对象)')
	else for (const key of packSchema.required('manifest.incident')) if (has(manifest.incident, key) === false) missing.push(`manifest.json.incident.${key}`)
	for (const key of packSchema.required('incident.json')) if (has(report, key) === false) missing.push(`incident.json.${key}`)
	if (isObject(report.incident) === false) missing.push('incident.json.incident(不是对象)')
	else for (const key of packSchema.required('incident')) if (has(report.incident, key) === false) missing.push(`incident.json.incident.${key}`)
	if (missing.length > 0) throw new Error(`不是一份完整的包,缺必需键:${missing.join(', ')}`)
	if (manifest.kind !== 'dsh-perf-hud-diagnostic-pack') throw new Error(`manifest.kind 不是本插件的包:${JSON.stringify(manifest.kind)}`)
	if (report.kind !== 'perf-hud-incident') throw new Error(`incident.json 的 kind 不对:${JSON.stringify(report.kind)}`)

	// 未知字段忽略(记下来,但不参与判断);未知版本说差异,不拒绝
	const knownManifest = packSchema.keys('manifest.json')
	const ignoredUnknownKeys = Object.keys(manifest).filter((key) => knownManifest.includes(key) === false)
	const versionGap = {
		manifest: manifest.schemaVersion > packSchema.version('manifest.json'),
		incident: report.schema > packSchema.version('incident.json'),
	}
	versionGap.any = versionGap.manifest || versionGap.incident

	// 能力矩阵:叶子路径 + 每格形状(按文档的清单比,不按代码)
	const capability = { leaves: [], unobserved: [], invalid: [], provenance: new Set() }
	for (const group of ['renderer', 'host', 'link']) {
		if (isObject(manifest.capabilities?.[group]) === false) continue
		for (const [name, cell] of Object.entries(manifest.capabilities[group])) {
			capability.leaves.push(`${group}.${name}`)
			if (isObject(cell) === false || ['state', 'provenance', 'reason'].every((key) => has(cell, key)) === false) {
				capability.invalid.push(`${group}.${name}`)
				continue
			}
			capability.provenance.add(cell.provenance)
			if (['on', 'degraded', 'off', 'unsupported'].includes(cell.state) === false) capability.invalid.push(`${group}.${name}.state=${cell.state}`)
		}
	}
	for (const item of Array.isArray(manifest.capabilities?.unobserved) ? manifest.capabilities.unobserved : []) {
		capability.unobserved.push(item?.id)
	}
	capability.leaves.sort()
	capability.unobserved.sort()

	// 摘要:帧数与分位从 frames 现算(与 tools/inspect-incident.mjs 同一口径)
	const incident = report.incident
	const live = (Array.isArray(incident.frames) ? incident.frames : []).filter((frame) => frame.gap !== true).map((frame) => frame.ms).sort((a, b) => a - b)
	const pick = (p) => (live.length === 0 ? null : live[Math.min(live.length - 1, Math.floor(p * live.length))])
	return {
		manifest,
		report,
		incident,
		manifestFiles: Array.isArray(manifest.files) ? manifest.files : [],
		ignoredUnknownKeys: ignoredUnknownKeys.sort(),
		versionGap,
		capability: { leaves: capability.leaves, unobserved: capability.unobserved, invalid: capability.invalid, provenance: [...capability.provenance].sort() },
		summary: { frames: live.length, p99: pick(0.99), worstFrameMs: live.length === 0 ? null : live[live.length - 1], worstFrameAt: incident.summary?.worstFrameAt ?? null },
	}
}

const readDeclared = readPack(declaredFiles)
const readZipOrder = readPack(zipFiles)

// ───────────────────────── ① 夹具自检:它真的还是"上一版"─────────��──────────────
check('兼容夹具:manifest 是 v1、incident 是 v2(v1 没有 complete / integrity,但带着已删的 dshVersion)',
	[
		readDeclared.manifest.schemaVersion, readDeclared.report.schema,
		Object.prototype.hasOwnProperty.call(previousManifest, 'complete'),
		Object.prototype.hasOwnProperty.call(previousManifest.incident, 'integrity'),
		Object.prototype.hasOwnProperty.call(previousManifest, 'dshVersion'),
		Object.prototype.hasOwnProperty.call(previousIncident.context, 'hostCpuProfile'),
	],
	[1, 2, false, false, true, false])
check('兼容夹具:v1 的 manifest.files 把 manifest 写在第二位(与包里真实顺序不同)',
	[previousManifest.files, zipFiles.map((file) => file.name)], [['summary.md', 'manifest.json', 'incident.json', 'README.md'], ['manifest.json', 'summary.md', 'incident.json', 'README.md']])

// ───────────────────────── ② 摘要:两种文件顺序都读得出来 ─────────────────────────
check('上一版包:按名字找文件(声明顺序 / 实际顺序各读一遍,读出同一份摘要)',
	[readDeclared.summary, readZipOrder.summary],
	[readDeclared.summary, readDeclared.summary])
check('上一版包:读出的摘要与包内 summary 字段一致(帧数 / p99 / 最差帧 —— p99 是现算的)',
	[readDeclared.summary.frames, readDeclared.summary.frames === row.summary.frames,
		readDeclared.summary.p99, readDeclared.summary.p99 === row.summary.p99,
		readDeclared.summary.worstFrameMs, readDeclared.summary.worstFrameMs === row.summary.worstFrameMs],
	[row.summary.frames, true, row.summary.p99, true, row.summary.worstFrameMs, true])

// ───────────────────────── ③ 能力矩阵 ─────────────────────────
check('上一版包:能力矩阵的叶子集合与 docs/pack-schema.md 的清单一致',
	[readDeclared.capability.leaves, readDeclared.capability.unobserved],
	[packSchema.required('capabilities').filter((key) => key !== 'schema').sort(), packSchema.required('capabilities.unobserved').slice().sort()])
check('上一版包:每个叶子仍然是 {state, provenance, reason},state 在四值域内、provenance 在三档内',
	[readDeclared.capability.invalid, readDeclared.capability.provenance],
	[[], ['inferred', 'measured', 'unknown']])

// ───────────────────────── ④ 仓库里真发货的那个读方 ─────────────────────────
const temp = mkdtempSync(join(tmpdir(), 'dsh-perf-hud-compat-'))
try {
	for (const file of zipFiles) writeFileSync(join(temp, file.name), file.text)
	const incidentPath = join(temp, 'incident.json')
	const cli = (path) => spawnSync(process.execPath, [join(ROOT, 'tools/inspect-incident.mjs'), path], { encoding: 'utf8' })
	const out = cli(incidentPath)
	const text = out.stdout ?? ''
	check('上一版包:tools/inspect-incident.mjs 退出 0(真发货的读方还认得它)', out.status, 0)
	check('上一版包:CLI 输出里有 schema 2 / 帧数 / 分位 / 最差帧 / 缺失声明(摘要读得出来)',
		[
			/schema 2/.test(text),
			text.includes(`${row.summary.frames} 帧`),
			/p99/.test(text),
			text.includes(`最差 ${row.summary.worstFrameMs}ms`),
			text.includes('precise:'),
			text.includes('devtools-trace:'),
		],
		[true, true, true, true, true, true])

	// 未知字段忽略:老包里的 dshVersion 不该进读方的判断
	check('未知字段被忽略:读方记下了清单外的 dshVersion,但不拿它做任何判断',
		[readDeclared.ignoredUnknownKeys, readDeclared.manifest.schemaVersion === 1],
		[['dshVersion'], true])

	// 未知版本说差异:更高版本的包不拒绝,但仍只读自己认得的键
	const newer = JSON.parse(JSON.stringify(previousManifest))
	newer.schemaVersion = 99
	newer.futureField = { shape: 'unknown' }
	const newerReport = JSON.parse(JSON.stringify(previousIncident))
	newerReport.schema = 99
	const readNewer = readPack([
		{ name: 'manifest.json', text: JSON.stringify(newer) },
		{ name: 'incident.json', text: JSON.stringify(newerReport) },
	])
	check('未知版本:不拒绝,但把版本差说出来(versionGap),能力矩阵与摘要照样读得出来',
		[readNewer.versionGap, readNewer.capability.leaves.length, readNewer.summary.frames, readNewer.ignoredUnknownKeys.includes('futureField')],
		[{ manifest: true, incident: true, any: true }, packSchema.required('capabilities').filter((key) => key !== 'schema').length, row.summary.frames, true])

	// ───────── ⑤ 反例:故意删一个顶层键,必须红 ─────────
	const brokenManifest = JSON.parse(JSON.stringify(previousManifest))
	delete brokenManifest.capabilities
	let manifestError = null
	try {
		readPack([{ name: 'manifest.json', text: JSON.stringify(brokenManifest) }, { name: 'incident.json', text: JSON.stringify(previousIncident) }])
	} catch (error) { manifestError = error instanceof Error ? error.message : String(error) }
	check('删掉 manifest 的必需顶层键 capabilities → 读方必须拒绝,并点名这个键',
		[manifestError === null ? 'no-error' : /manifest\.json\.capabilities/.test(manifestError), /缺必需键/.test(manifestError ?? '')],
		[true, true])

	const brokenReport = JSON.parse(JSON.stringify(previousIncident))
	delete brokenReport.incident
	const brokenPath = join(temp, 'incident-broken.json')
	writeFileSync(brokenPath, JSON.stringify(brokenReport, null, 2))
	const brokenCli = cli(brokenPath)
	check('删掉 incident.json 的必需顶层键 incident → 真读方也必须拒绝(退出码非 0)',
		[brokenCli.status === 0, /没有 incident 对象/.test(brokenCli.stderr ?? '')],
		[false, true])
} finally {
	rmSync(temp, { recursive: true, force: true })
}

// 一条命令跑完;`ok` 前缀行数与 ci.yml / release.yml 的「断言总数」门禁同一口径
console.log(failed === 0 ? 'ALL PASS' : `FAILURES=${failed}`)
process.exitCode = failed === 0 ? 0 : 1
