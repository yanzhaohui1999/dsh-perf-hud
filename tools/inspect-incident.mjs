#!/usr/bin/env node
/**
 * 把一份事故包(`perf-hud-incident-*.json`)渲染成人能读的样子。
 *
 *   node tools/inspect-incident.mjs <file.json> [--width 96]
 *
 * 只读文件、不联网、不依赖任何包。输出四块:
 *   1. 头部与口径(触发原因、严重度、阈值、缺失声明、守夜层状态)
 *   2. 一条 ASCII 帧条带(█ >100ms · ▒ 50–100ms · · 正常 · _ rAF 挂起 · 空白 没采到)
 *   3. 三张表:窗口内的 longtask、LoAF 长动画帧、按耗时排序的脚本
 *   4. 末尾一句话汇总
 *
 * 它**不做归因推断** —— 只把事故包里的东西摊开,结论留给读的人(或 agent)。
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => a.startsWith('-') === false);
const widthFlag = args.indexOf('--width');
const WIDTH = widthFlag === -1 ? 96 : Math.max(40, Number(args[widthFlag + 1]) || 96);

if (file === undefined) {
	console.error('用法:node tools/inspect-incident.mjs <perf-hud-incident-*.json> [--width 96]');
	process.exit(2);
}

let report;
try {
	report = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
	console.error(`读不了这份文件:${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
if (report === null || typeof report !== 'object' || report.kind !== 'perf-hud-incident') {
	console.error(`这不是事故包(kind=${report === null ? 'null' : JSON.stringify(report.kind)})。`);
	process.exit(1);
}

const incident = report.incident ?? {};
const context = report.context ?? {};
const summary = incident.summary ?? {};
const frames = Array.isArray(incident.frames) ? incident.frames : [];
const loaf = Array.isArray(incident.loaf) ? incident.loaf : [];
const longTasks = Array.isArray(incident.longTasks) ? incident.longTasks : [];

const liveRows = frames.filter((row) => row.gap !== true);
const live = liveRows.map((row) => row.ms).sort((a, b) => a - b);
const busyMs = liveRows.reduce((sum, row) => sum + row.ms, 0);
// 包里没有 worstFrameJs / suspectedThrottle(改动之前采的、或从落盘读回的老包)就自己算一遍 ——
// 判据与 client.js 里那份一致,免得老证据只剩一堆数字。
const worstLive = liveRows.slice().sort((a, b) => b.ms - a.ms)[0];
const worstJs = (() => {
	if (worstLive === undefined) return 'none';
	const start = worstLive.t - worstLive.ms;
	const end = worstLive.t;
	const hasJs = longTasks.some((row) => row.at < end && row.at + row.ms > start)
		|| loaf.some((row) => row.t < end && row.t + row.dur > start);
	return hasJs ? 'js' : 'none';
})();
const neighboursMs = (() => {
	if (worstLive === undefined) return null;
	const index = frames.indexOf(worstLive);
	const around = frames.slice(Math.max(0, index - 5), index).concat(frames.slice(index + 1, index + 6))
		.filter((row) => row.gap !== true).map((row) => row.ms).sort((a, b) => a - b);
	return around.length === 0 ? null : Math.round(around[Math.floor(around.length / 2)] * 10) / 10;
})();
const suspectedThrottle = summary.suspectedThrottle !== undefined
	? summary.suspectedThrottle
	: worstLive !== undefined && worstLive.ms >= 500 && worstJs === 'none' && neighboursMs !== null && neighboursMs < 100;
const jsFromPack = summary.worstFrameJs !== undefined;

const pad = (text, size, align = 'left') => {
	const s = String(text);
	return s.length >= size ? s : align === 'right' ? s.padStart(size, ' ') : s.padEnd(size, ' ');
};
const num = (value, digits = 1) => (typeof value === 'number' ? String(Math.round(value * 10 ** digits) / 10 ** digits) : '—');
const sec = (ms) => `${ms >= 0 ? '+' : ''}${(ms / 1000).toFixed(1)}s`;
const rule = (title) => `\n── ${title} ${'─'.repeat(Math.max(0, WIDTH - title.length - 4))}`;

/** 脚本的 URL 现在放在 incident.urls 里(scripts[].u 是下标);旧包还是内联的 url。 */
function scriptUrl(script) {
	if (script === null || script === undefined) return '';
	if (typeof script.url === 'string') return script.url;
	const table = Array.isArray(incident.urls) ? incident.urls : [];
	return typeof script.u === 'number' && script.u >= 0 && script.u < table.length ? table[script.u] : '';
}

/** 合并批次 URL 太长:只留第一个包名 + 包数。 */
function shortUrl(url) {
	if (typeof url !== 'string' || url === '') return '—';
	const marker = url.indexOf('/plugins/??');
	if (marker === -1) return url.replace(/^https?:\/\/[^/]+/, '');
	const head = url.slice(marker + '/plugins/??'.length).split('&')[0];
	const parts = head.split(',');
	if (parts.length === 1) return `plugins/??${parts[0]}`;
	return `plugins/??${parts[0]}…(+${parts.length - 1} 包)`;
}

// ── 1. 头部 ────────────────────────────────────────────────────────────
const window0 = incident.window ?? {};
console.log(`\n事故 ${incident.id ?? '?'}  ·  ${report.exportedAt ?? '?'}${report.schema === undefined ? '' : `  ·  schema ${report.schema}`}`);
console.log(`${file}`);
console.log(rule('发生了什么'));
console.log(`触发原因   ${incident.cause ?? '?'}${incident.cause === 'loaf' ? '(长动画帧的 blockingDuration 超线)' : incident.cause === 'frame' ? '(帧间隔超线)' : incident.cause === 'manual' ? '(手动标记)' : ''}`);
console.log(`触发时刻   ${incident.at ?? '?'}  ·  perf ${num(incident.atPerfMs)}ms`);
console.log(`严重度     ${num(incident.severity)}ms${incident.restored === true ? '   ⚠️ 这份是上次会话落盘读回的,perf 毫秒按 env.perfOrigin 对齐' : ''}`);
console.log(`窗口       ${window0.from ?? '?'} → ${window0.to ?? '?'}  (前摇 ${num(window0.preMs, 0)}ms + 后摇 ${num(window0.postMs, 0)}ms)`);
console.log(`保留状态   ${incident.kept ?? '?'}${incident.note === null || incident.note === undefined ? '' : `  ·  标记:${incident.note}`}`);
console.log(rule('汇总'));
console.log(`帧         ${num(summary.frames, 0)} 帧  ·  最差 ${num(summary.worstFrameMs)}ms${summary.worstFrameAt === undefined ? '' : ` @ ${summary.worstFrameAt}`}`);
console.log(`超线帧     >50ms ${num(summary.framesOver50Ms, 0)}  ·  >100ms ${num(summary.framesOver100Ms, 0)}  ·  rAF 挂起 ${num(summary.hiddenGaps, 0)}`);
console.log(`长动画帧   ${num(summary.loafEntries, 0)} 条  ·  累计 blocking ${num(summary.blockingMs)}ms`);
console.log(`longtask   窗口内 ${num(summary.longTasksInWindow, 0)} 条`);
console.log(`最差帧解释 ${worstJs === 'js' ? '有 longtask / LoAF 与它重叠' : '没有任何 longtask / LoAF 与它重叠'}  ·  前后帧中位 ${num(neighboursMs)}ms${jsFromPack ? '' : '  (包里没有这一栏,是本工具现算的)'}`);
if (suspectedThrottle === true) {
	console.log('⚠️ 疑似节流  最差这一帧没有 JS 证据、前后又都是健康帧 —— 更像浏览器把 rAF 节流/挂起了一次(遮挡、省电),而不是页面真的忙了这么久');
}
console.log(`页面       场景 ${summary.streaming === true ? '流式' : '空闲'}  ·  可见性 ${summary.visibility ?? '?'}  ·  DOM ${num((incident.env ?? {}).domNodes, 0)} 节点  ·  堆 ${num(((incident.env ?? {}).heapUsedBytes ?? 0) / 1048576)}MB  ·  插桩 ${(incident.env ?? {}).instrumented === true ? '开' : '关'}  ·  精确归因 ${(incident.env ?? {}).precise === true ? '开' : '关'}`);
const env = incident.env ?? {};
if (env.viewport !== undefined) console.log(`渲染环境   视口 ${env.viewport}  ·  DPR ${num(env.devicePixelRatio, 2)}  ·  逻辑核 ${num(env.hardwareConcurrency, 0)}  ·  UA ${String(context.userAgent ?? '').slice(0, 56)}`);

// ── 2. 帧条带 ──────────────────────────────────────────────────────────
console.log(rule(`帧条带(每个字符一格,共 ${WIDTH} 格 ≈ ${((window0.toMs - window0.fromMs) / WIDTH / 1000).toFixed(2)} 秒/格)`));
const from = window0.fromMs ?? 0;
const to = window0.toMs ?? 0;
const span = Math.max(1, to - from);
const cells = new Array(WIDTH).fill(null);
for (const row of frames) {
	const index = Math.min(WIDTH - 1, Math.max(0, Math.floor(((row.t - from) / span) * WIDTH)));
	const cell = cells[index];
	if (cell === null) cells[index] = { ms: row.gap ? 0 : row.ms, gap: row.gap === true, n: 1 };
	else {
		cell.n += 1;
		if (row.gap === true) cell.gap = true;
		else if (row.ms > cell.ms) cell.ms = row.ms;
	}
}
const bar = cells.map((cell) => {
	if (cell === null) return ' ';
	if (cell.gap === true && cell.ms === 0) return '_';
	if (cell.ms >= 100) return '█';
	if (cell.ms >= 50) return '▒';
	return '·';
}).join('');
console.log(bar);
{
	const at = incident.atPerfMs ?? 0;
	const axis = new Array(WIDTH).fill(' ');
	const put = (text, index) => {
		const start = Math.max(0, Math.min(WIDTH - text.length, index));
		for (let i = 0; i < text.length; i += 1) axis[start + i] = text[i];
	};
	put(sec(from - at), 0);
	put('▲ 触发', Math.max(0, Math.round(((at - from) / span) * WIDTH) - 3));
	put(sec(to - at), WIDTH - sec(to - at).length);
	console.log(axis.join('').trimEnd());
}
console.log('图例:█ >100ms · ▒ 50–100ms · · <50ms · _ rAF 挂起(不是卡顿)· 空白 没采到');

let windowP50 = null;
if (live.length > 0) {
	const pick = (p) => live[Math.min(live.length - 1, Math.floor(p * live.length))];
	windowP50 = pick(0.5);
	console.log(`分位: p50 ${num(pick(0.5))}ms · p90 ${num(pick(0.9))}ms · p99 ${num(pick(0.99))}ms · max ${num(live[live.length - 1])}ms · 在跑 ${num(busyMs / 1000)}s → ${num(busyMs > 0 ? Math.round((live.length * 1000 / busyMs) * 10) / 10 : 0)}fps${summary.p50 === undefined ? '' : `  (包内 summary: p50 ${num(summary.p50)} / p90 ${num(summary.p90)} / p99 ${num(summary.p99)})`}`);
}
// 会话基线:没有它,"最差帧 325ms" 判不出是这一段真的变坏了,还是这台机器一直这样
{
	const baseline = incident.baseline;
	if (baseline === null || baseline === undefined) {
		console.log('会话基线   (没有:旧版本的事故包不带这个字段)');
	} else {
		// 两种形状要分开判:尖刺看最差帧的倍数,慢性劣化看 p50。只看 p50 会把 983ms 的
		// 单帧尖刺判成"与平时一致"(实测踩过)。
		const p50Ratio = windowP50 === null || !(baseline.p50 > 0) ? null : windowP50 / baseline.p50;
		const worstRatio = typeof summary.worstFrameMs === 'number' && baseline.worstMs > 0 ? summary.worstFrameMs / baseline.worstMs : null;
		const spike = worstRatio !== null && worstRatio >= 2 && (p50Ratio === null || p50Ratio < 1.15);
		const verdict = spike ? `**单帧尖刺**:本窗口最差 ${num(summary.worstFrameMs)}ms 是会话其余部分最差(${num(baseline.worstMs)}ms)的 ×${worstRatio.toFixed(1)},而 p50 与平时一致`
			: worstRatio !== null && worstRatio >= 1.5 ? `明显差于平时(最差 ×${worstRatio.toFixed(1)})`
				: p50Ratio !== null && p50Ratio >= 1.5 ? `整段慢性劣化(p50 ×${p50Ratio.toFixed(2)})`
					: p50Ratio !== null && p50Ratio >= 1.15 ? `略差于平时(p50 ×${p50Ratio.toFixed(2)})`
						: '与本会话其余部分基本一致';
		console.log(`会话基线   其余 ${num(baseline.frames, 0)} 帧 · 跨度 ${num((baseline.spanMs ?? 0) / 1000)}s(真的在跑 ${num((baseline.busyMs ?? baseline.spanMs ?? 0) / 1000)}s → ${num(baseline.fps)}fps)· p50 ${num(baseline.p50)}ms · p90 ${num(baseline.p90)}ms · 最差 ${num(baseline.worstMs)}ms`);
		console.log(`对比       ${verdict}`);
	}
}

// ── 3. 表 ──────────────────────────────────────────────────────────────
console.log(rule('窗口内的 longtask(既有四条腿的明细)'));
if (longTasks.length === 0) console.log('(没有)');
for (const row of longTasks) {
	console.log(`  ${pad(sec(row.at - (incident.atPerfMs ?? 0)), 7, 'right')}  ${pad(`${num(row.ms)}ms`, 8, 'right')}  组件 ${pad(row.component ?? '—', 18)} 调度方 ${pad(row.owner ?? '—', 20)} 来源 ${row.source ?? '—'}`);
	if (row.subtreeComponent !== undefined && row.subtreeComponent !== null) console.log(`     子树腿 ${row.subtreeComponent}${row.domComponent === null || row.domComponent === undefined ? '' : `  ·  DOM 写入腿 ${row.domComponent}`}`);
}

console.log(rule('LoAF 长动画帧(blocking 才是"挡了多久")'));
if (loaf.length === 0) console.log('(没有:LoAF 未装,或这段窗口里没有长动画帧)');
const worstLoaf = loaf.slice().sort((a, b) => b.blocking - a.blocking).slice(0, 12);
for (const row of worstLoaf) {
	console.log(`  ${pad(sec(row.t - (incident.atPerfMs ?? 0)), 7, 'right')}  dur ${pad(`${num(row.dur)}ms`, 8, 'right')}  blocking ${pad(`${num(row.blocking)}ms`, 8, 'right')}  脚本 ${row.scripts.length} 个`);
}
if (loaf.length > worstLoaf.length) console.log(`  …共 ${loaf.length} 条,上面按 blocking 取前 ${worstLoaf.length} 条`);

console.log(rule('按包汇总(脚本耗时归到包名)—— 这一层才是"是谁"'));
const packages = Array.isArray(incident.packages) ? incident.packages : [];
if (packages.length === 0) {
	console.log('(一条都没定到包名:看下面的 pkgVia 与缺失声明)');
} else {
	const coverage = summary.pkgCoverage;
	for (const row of packages.slice(0, 8)) {
		console.log(`  ${pad(`${num(row.ms)}ms`, 9, 'right')}  ${pad(`×${row.count}`, 5, 'right')}  ${row.pkg}`);
	}
	if (packages.length > 8) console.log(`  …共 ${packages.length} 个包`);
	if (coverage !== undefined) console.log(`  覆盖率 ${coverage.resolved}/${coverage.total} 条脚本有包名${coverage.resolved === coverage.total ? '' : ' —— 没定到的那几条见脚本表'}`);
}

console.log(rule('脚本(按耗时排序,取前 10)—— 这是"谁"'));
const scripts = [];
for (const row of loaf) for (const script of row.scripts) scripts.push({ at: row.t, ...script });
scripts.sort((a, b) => b.ms - a.ms);
if (scripts.length === 0) console.log('(没有脚本级归因:见下面的缺失声明)');
for (const script of scripts.slice(0, 10)) {
	const pkg = typeof script.pkg === 'string' && script.pkg !== '' ? script.pkg : null;
	const why = script.pkg === undefined || script.pkg === null ? (script.pkgVia === undefined ? '' : `[${script.pkgVia}]`) : '';
	console.log(`  ${pad(`${num(script.ms)}ms`, 8, 'right')}  ${pad(script.invokerType ?? '—', 16)}  ${pkg === null ? `${why} ${shortUrl(scriptUrl(script))}` : pkg}`);
	console.log(`            invoker ${script.invoker ?? '—'}${script.fn === null || script.fn === undefined ? '' : `  ·  fn ${script.fn}`}${script.charPos === null || script.charPos === undefined ? '' : `  ·  charPos ${script.charPos}`}${script.forcedMs > 0 ? `  ·  强制样式布局 ${num(script.forcedMs)}ms` : ''}`);
}

// ── 4. 口径与缺失 ──────────────────────────────────────────────────────
console.log(rule('口径与缺失声明'));
const thresholds = context.thresholds ?? {};
console.log(`阈值       触发 ${num(thresholds.triggerMs, 0)}ms  ·  间隙 ${num(thresholds.gapMs, 0)}ms  ·  前摇 ${num(thresholds.preMs, 0)}ms  ·  后摇 ${num(thresholds.postMs, 0)}ms  ·  保留 ${num(thresholds.keep, 0)} 次  ·  手动回退 ${num(thresholds.reactionMs, 0)}ms`);
const watch = context.watch ?? {};
console.log(`守夜层     录制 ${watch.recording === true ? '中' : '停'}  ·  LoAF ${watch.loaf ?? '?'}  ·  帧样本 ${num(watch.frameSamples, 0)}/${num(watch.frameBudget, 0)}(覆盖 ${num((watch.coveredMs ?? 0) / 1000)}s)  ·  捕获 ${num(watch.captured, 0)} 次(归并 ${num(watch.coalesced, 0)} · 丢弃 ${num(watch.dropped, 0)} · 读回 ${num(watch.restored, 0)})`);
console.log(`宿主       ${incident.host === null || incident.host === undefined ? '(没有宿主数据)' : `p99 ${num((incident.host.eventLoop ?? {}).p99)}ms  ·  快照年龄 ${num(incident.host.snapshotAgeMs, 0)}ms(正数=比事故更早采到)  ·  ${incident.host.at ?? '?'}`}`);
console.log('这次**没有**拿到:');
for (const line of context.missing ?? []) console.log(`  · ${line}`);
console.log('要补的话:');
for (const line of context.howToAdd ?? []) console.log(`  · ${line}`);
console.log('读取说明:');
for (const line of context.howToRead ?? []) console.log(`  · ${line}`);
console.log('');
