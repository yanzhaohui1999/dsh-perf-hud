#!/usr/bin/env node
/**
 * make-timeline-fixture.mjs —— 生成「宿主 CPU profile ↔ 客户端帧环」对齐用的真采样夹具。
 *
 *   node tools/make-timeline-fixture.mjs [output]
 *
 * 为什么要有它:事故里的 `incident.timeline` 不是拿两个数组硬凑出来的 —— 它依赖一个
 * 真实的时间基准(宿主 `meta.startedAt/endedAt` 是墙钟毫秒,`.cpuprofile` 的
 * `startTime/endTime` 是 V8 自己的微秒时钟)。这份工具用 `node:inspector` 采一段**真的**
 * CPU profile,同时在同一个进程里按 ~60fps 记录"帧",并故意在已知的帧里烧 CPU:
 *
 *   - `frames[].busyMs` 是**地面真值**(烧 CPU 的起止点是当场记的,不是事后猜的);
 *   - `profile` 是 V8 原样回的标准 .cpuprofile(只裁掉测时间轴用不到的 children/positionTicks);
 *   - `meta.startedAt/endedAt` 与宿主半 `createCpuProfiler` 写的字段同名同口径;
 *   - `perfOrigin` 是 `Date.now() - performance.now()`,与页面 `performance.timeOrigin` 同一语义。
 *
 * 所以离线套件可以拿它回答"对齐到底准不准":把 profile 的采样按同一套换算落到帧上,
 * 再和 `frames[].busyMs` 比 —— 错一帧就是错一帧,不是"看着差不多"。
 *
 * 输出默认写 `tests/fixtures/timeline-host.json`。夹具是生成一次、随仓库走的;不要把它
 * 当成 npm test 的运行时依赖(采样本进程有开销,也会让套件变慢)。
 */
import { Session } from 'node:inspector';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.argv[2] ?? resolve(HERE, '..', 'tests', 'fixtures', 'timeline-host.json'));

const round1 = (value) => Math.round(value * 10) / 10;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const session = new Session();
session.connect();
const post = (method) => new Promise((ok, fail) => {
	session.post(method, {}, (error, result) => (error ? fail(error) : ok(result)));
});

await post('Profiler.enable');
await post('Profiler.start');
const startedAt = Date.now();
const perfOrigin = Date.now() - performance.now();

// ── 帧 + 地面真值:先 0.35s 空闲,再两段"已知烧 CPU"的帧,中间与结尾各留空闲段 ──
// 每帧 16.7ms 起跳;burnMs > 0 的帧在 tick 里同步烧掉,帧间隔因此变长 —— 这正是
// "页面卡了一下"的形状,而烧的起点/终点是当场记的,能拿来判对齐。
const plan = [
	...Array.from({ length: 20 }, () => 0),       // ~0.35s idle
	...Array.from({ length: 20 }, () => 12),      // ~0.6s: 每帧烧 12ms(约 40% 帧内)
	...Array.from({ length: 20 }, () => 0),       // ~0.35s idle
	...Array.from({ length: 12 }, () => 24),      // ~0.5s: 每帧烧 24ms(约 60% 帧内)
	...Array.from({ length: 12 }, () => 0),       // ~0.2s idle
];

const frames = [];
const burns = [];
let last = performance.now();

function burnFor(ms) {
	if (ms <= 0) return;
	const from = performance.now();
	const until = from + ms;
	let x = 0;
	// 内层跑一批再看表:不让 `performance.now()` 自己变成采样热点(第一版就踩了 ——
	// 1.5s 的 profile 里 `now` 占了 409ms,空闲帧被算成"宿主忙 54%")。
	while (performance.now() < until) {
		for (let i = 0; i < 4096; i += 1) x = (x + i) & 0x7fffffff;
	}
	burns.push({ from: round1(from), to: round1(performance.now()), ticks: x });
}

for (const burnMs of plan) {
	// 先干这一帧的活,再等下一帧的到点,最后把 `t` 记在**帧结束**的位置 —— 与浏览器 rAF
	// 回调同一语义:`t` 是这一帧的结束时刻,`ms = t - 上一帧 t`,所以 [t-ms, t] 才是这帧。
	// (第一版把 t 记在烧 CPU 之前,时间轴整体错一帧;对齐断言当场就红了。)
	const before = performance.now();
	burnFor(burnMs);
	const after = performance.now();
	await sleep(Math.max(0, last + 16.7 - performance.now()));
	const now = performance.now();
	frames.push({ t: round1(now), ms: round1(Math.max(now - last, 0.1)), gap: false, busyMs: burnMs > 0 ? round1(after - before) : 0 });
	last = now;
}

const { profile } = await post('Profiler.stop');
const endedAt = Date.now();
session.disconnect();

// 每条帧的 ms 已经是"上一帧 t → 本帧 t";不再从下一条帧回填(那会把最后一帧漏掉)。


// 只留时间轴用得上的节点字段:夹具要小而可读,不冒充"完整可导入 speedscope 的原始文件"
// (原始 .cpuprofile 的下载路径在面板里,那份不经过这里)。
const nodes = profile.nodes.map((node) => ({
	id: node.id,
	callFrame: {
		functionName: node.callFrame?.functionName ?? '',
		url: '',
		lineNumber: node.callFrame?.lineNumber ?? -1,
		columnNumber: node.callFrame?.columnNumber ?? -1,
	},
}));
const fixture = {
	note: '真 V8 CPU profile + 同一进程里按 ~60fps 记的帧;frames[].busyMs 是烧 CPU 的起止点当场记下的地面真值。时间轴只用 nodes[].id/callFrame + samples/timeDeltas,所以节点已裁掉 children/positionTicks。',
	recordedAt: new Date().toISOString(),
	nodeVersion: process.version,
	perfOrigin: new Date(perfOrigin).toISOString(),
	meta: {
		startedAt,
		endedAt,
		seconds: round1((endedAt - startedAt) / 1000),
		nodes: nodes.length,
		samples: Array.isArray(profile.samples) ? profile.samples.length : 0,
	},
	profile: {
		startTime: profile.startTime,
		endTime: profile.endTime,
		nodes,
		samples: profile.samples,
		timeDeltas: profile.timeDeltas,
	},
	frames,
	burns,
};

writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
console.log(`wrote ${OUT}`);
console.log(`frames=${frames.length} busyFrames=${frames.filter((row) => row.busyMs > 0).length} samples=${fixture.meta.samples} profileSpan=${round1((profile.endTime - profile.startTime) / 1000)}ms wallSpan=${fixture.meta.seconds * 1000}ms`);
