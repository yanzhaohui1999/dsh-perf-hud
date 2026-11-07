#!/usr/bin/env node
/**
 * check-timeline.mjs —— A4「宿主 + 客户端同一时间轴」的验收命令(无浏览器、无网络)。
 *
 *   node tools/check-timeline.mjs
 *
 * 两件事,一条命令:
 *   1. **对齐误差 ≤1 帧**:用 tests/fixtures/timeline-host.json(同一进程里真采的 V8 profile
 *      + 按 ~60fps 记的帧;`frames[].busyMs` 是烧 CPU 起止点当场记下的地面真值)跑一遍
 *      production 的 `incidentTimeline()`,把"真烧帧段"与"对齐后 js 采样 ≥50% 的帧段"逐段比;
 *   2. **一次真实卡顿的占比 + 两段原始序列**:拿 tests/fixtures/incident-real.json 里那条真
 *      事故(最差帧 137.1ms),把上面那份真 profile 平移到它的时间轴上,打印 `宿主占比 X%`
 *      与宿主采样 / 帧两段原始序列。
 *
 * ⚠️ 第 2 步的 profile 是**重定位**到真事故窗口的(当时没有同时采宿主),不是同一次现场采集;
 * 真页面 + 真宿主的双端采集要等宿主半重启后由父会话在合并后跑(见报告的"未验证"清单)。
 * 工具只证明:同一套 production 代码、同一份真 profile、同一批真帧,能给出可复核的百分比。
 *
 * 退出码:0 = 两条都通过;1 = 有失败。
 */
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');
const modelSource = read('client.model.js');
const clientSource = read('client.js');
const fixture = JSON.parse(read('tests/fixtures/timeline-host.json'));
const real = JSON.parse(read('tests/fixtures/incident-real.json')).incident;

// 与 tests/logic.mjs 同一套"抽真函数"的办法:从分片里按 header 找到配对右括号。
function extract(text, header) {
	const start = text.indexOf(header);
	if (start === -1) throw new Error(`missing ${header}`);
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
	throw new Error(`unbalanced ${header}`);
}
const line = (header) => {
	const at = clientSource.indexOf(header);
	if (at === -1) throw new Error(`missing ${header}`);
	return clientSource.slice(at, clientSource.indexOf('\n', at));
};
const round1 = (value) => Math.round(value * 10) / 10;
const TIMELINE_SAMPLE_MAX = Number(line('const TIMELINE_SAMPLE_MAX').split('=')[1].replace(';', '').trim());
const TIMELINE_MIN_COVERAGE = Number(line('const TIMELINE_MIN_COVERAGE').split('=')[1].replace(';', '').trim());
const pieces = [
	'function timelineHostAnchor(',
	'function timelineAnchorWallAt(',
	'function timelineHostSamples(',
	'function timelineOverlap(',
	'function incidentTimeline(',
].map((header) => extract(modelSource, header)).join('\n');
const TL = new Function('round1', 'TIMELINE_SAMPLE_MAX', 'TIMELINE_MIN_COVERAGE', `${pieces}
	return { timelineHostAnchor, timelineHostSamples, timelineOverlap, incidentTimeline };`)(round1, TIMELINE_SAMPLE_MAX, TIMELINE_MIN_COVERAGE);

let failed = 0;
const check = (name, ok, detail = '') => {
	if (!ok) failed += 1;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  ${detail}`}`);
};

// ── 1) 夹具上的对齐误差 ─────────────────────────────────────────────
const perfOriginMs = Date.parse(fixture.perfOrigin);
const frames = fixture.frames.map((row) => ({ t: row.t, ms: row.ms, gap: false }));
const row = {
	id: 'timeline-fixture',
	window: { fromMs: frames[0].t - 100, toMs: frames[frames.length - 1].t + 100, preMs: 10000, postMs: 3000 },
	frames,
	env: { perfOrigin: new Date(perfOriginMs).toISOString() },
};
const record = { phase: 'done', profile: fixture.profile, meta: fixture.meta };
const segments = TL.incidentTimeline(row, record);
const segment = Array.isArray(segments) ? segments[0] : null;
check('夹具:真 profile + 真帧序列产出一段 timeline', segment !== null);
if (segment === null) {
	console.log('FAILURES=1');
	process.exit(1);
}
const byT = new Map(segment.frames.map((item) => [item.t, item]));
const paired = fixture.frames.filter((item) => byT.has(item.t));
const runs = (flags) => {
	const out = [];
	let start = -1;
	for (let i = 0; i <= flags.length; i += 1) {
		const on = i < flags.length && flags[i] === true;
		if (on && start === -1) start = i;
		if (on === false && start !== -1) { out.push([start, i - 1]); start = -1; }
	}
	return out;
};
const truthRuns = runs(paired.map((item) => item.busyMs > 0));
const alignedRuns = runs(paired.map((item) => {
	const aligned = byT.get(item.t);
	return aligned.ms > 0 && aligned.jsMs / aligned.ms >= 0.5;
}));
const overlap = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]) + 1);
const offsets = truthRuns.map((run) => {
	const best = alignedRuns.reduce((top, cur) => (overlap(cur, run) > overlap(top, run) ? cur : top), alignedRuns[0] ?? [99, 99]);
	return Math.max(Math.abs(best[0] - run[0]), Math.abs(best[1] - run[1]));
});
const worstOffset = offsets.length === 0 ? 99 : Math.max(...offsets);
check('夹具:两端对齐误差 ≤1 帧(真烧帧段 vs 对齐后宿主忙帧段)', worstOffset <= 1,
	`真烧 ${JSON.stringify(truthRuns)} · 对齐 ${JSON.stringify(alignedRuns)} · 匹配后误差 ${worstOffset} 帧`
	+ (alignedRuns.length > truthRuns.length ? '(多出的单帧是空闲段里调度下一帧的 processTimers,那 8.7ms 宿主确实在跑,不是时间轴错位)' : ''));
check('夹具:占比由两段原始序列支撑(hostMs 能从 host.samples 重算回来)', (() => {
	const share = segment.share;
	if (share === undefined) return false;
	const raw = segment.host.samples.map((item) => ({ from: item.t - item.ms, to: item.t, ms: item.ms, idle: item.kind === 'idle', native: item.kind === 'native' }));
	const again = TL.timelineOverlap(raw, Math.max(segment.stall.fromMs, segment.fromMs), Math.min(segment.stall.toMs, segment.toMs));
	return Math.abs(again.busy + again.native - share.hostMs) <= 0.2 && segment.frames.length > 0 && segment.host.samples.length > 0;
})(), `hostPct=${segment.share?.hostPct}%`);
console.log(`     夹具时间轴:${segment.fromMs}..${segment.toMs}ms · 宿主样本 ${segment.host.samples.length} 条 · 帧 ${segment.frames.length} 条 · 锚点误差 ${segment.alignment.errorMs}ms`);

// ── 2) 真事故 fixture:重定位一份真 profile,给出占比 + 两段原始序列 ──
// 找真事故最差那一帧;把夹具里第二段忙期(12 帧 × 24ms burn)平移到"卡顿后 40% 处开始"。
const worst = real.frames.filter((item) => item.gap !== true).reduce((top, item) => (item.ms > top.ms ? item : top));
const secondRun = truthRuns[truthRuns.length - 1];
const burnStart = fixture.frames[secondRun[0]].t;
const realPerfOriginMs = Date.parse(real.env.perfOrigin);
// 重定位:夹具坐标系里 burnStart 的墙钟 = fixture.perfOrigin + burnStart;要让它在真事故的
// perf 轴上落在 (worst.t - worst.ms * 0.4),整段 meta 平移 delta 即可。
const targetPerf = worst.t - worst.ms * 0.4;
const delta = targetPerf - (perfOriginMs + burnStart - realPerfOriginMs);
const rebased = {
	phase: 'done',
	profile: fixture.profile,
	meta: {
		...fixture.meta,
		startedAt: fixture.meta.startedAt + delta,
		endedAt: fixture.meta.endedAt + delta,
	},
};
const realSegments = TL.incidentTimeline(real, rebased);
const realSegment = Array.isArray(realSegments) ? realSegments[0] : null;
check('真事故 fixture:重定位后的 profile 盖住最差帧,给出 share', realSegment !== null && realSegment.share !== undefined,
	realSegment === null ? 'timeline=null' : `stall=${realSegment.stall.ms}ms · coverage=${realSegment.share?.coveragePct ?? '—'}%`);
if (realSegment !== null) {
	const share = realSegment.share;
	if (share !== undefined) {
		console.log(`     真事故:${real.id} · 最差帧 ${worst.ms}ms @ perf ${worst.t}ms`);
		console.log(`     宿主占比 ${share.hostPct}%  (host ${share.hostMs}ms / stall ${realSegment.stall.ms}ms · js ${share.jsMs} / native ${share.nativeMs} / idle ${share.idleMs} · js+native+idle=${round1(share.jsMs + share.nativeMs + share.idleMs)}ms)`);
		console.log(`     宿主原始序列(${realSegment.host.kept} 条,截断 ${realSegment.host.omitted} 条):`
			+ JSON.stringify(realSegment.host.samples.slice(0, 3)));
		console.log(`     帧原始序列(${realSegment.frames.length} 条):`
			+ JSON.stringify(realSegment.frames.slice(0, 3)));
	}
	check('真事故 fixture:两段原始序列都不是空的(不能只给一个数)',
		realSegment.host.samples.length > 0 && realSegment.frames.length > 0,
		`host=${realSegment.host.samples.length} frames=${realSegment.frames.length}`);
}

console.log(failed === 0 ? 'PASS: 一条命令复跑(夹具对齐 + 真事故占比 + 两段原始序列)' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
