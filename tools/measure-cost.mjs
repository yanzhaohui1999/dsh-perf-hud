/**
 * 量**记录器自己的代价**:三个档位下各测空闲期开销 / 内存 / 调度点包装开销。
 *
 *   node tools/measure-cost.mjs
 *   node tools/measure-cost.mjs --window=5000 --rounds=3 --timers=6000
 *
 * ## 为什么不能用"驱动一次提交、比两次提交谁慢"来量
 *
 * 这是第一版踩的坑,记在这里免得重走:`stress()` 里的显式燃烧住在 `PerfHudStress` 组件体内,
 * 而**这个组件只在 HUD 渲染时才存在** —— 所以"HUD 关"那一档根本没渲染它,量到的 0.1ms 是
 * "什么都没干",不是"HUD 不在的开销",两档量的不是同一件事。
 *
 * 更根本的是:`stress()` 的主体是一次**同步**提交(`flushSync`)。同步任务执行期间帧无法交付、
 * 微任务与 rAF 回调都不会插进来 —— 所以 HUD 常驻的那一圈(rAF 循环 + 两个 PerformanceObserver)
 * **在原理上就不可能拖慢这次提交**。而 `flushSync` 抓到的也只是 React 的提交那一段,
 * 浏览器渲染与布局不在里面(注释里写着 rAF 不是 React 渲染)。
 *
 * 于是正确的问法是三件事分开量:
 *   ① **空闲期帧节奏** —— HUD 的 rAF 循环与观察器是每帧都在跑的,代价落在这里;
 *   ② **内存足迹** —— 帧环 12000 + LoAF 200 条留存的驻留成本;
 *   ③ **调度点包装开销** —— 深录档每次 `setTimeout` 都抓一次栈,那是逐调用的成本。
 *
 * ## 三个档位
 *
 *   off   —— `disable()`:HUD 整个停掉,面板只剩一个「开启」按钮。这是基线。
 *   watch —— `enable()`,深录关:守夜档(帧环 + LoAF + 交互 + 长任务观察器)。
 *   deep  —— `enable()` + 点面板「深录」:再装上调度点 / DOM 写入包装 + 精确归因。
 *
 * ⚠️ **守夜层内部无法再细分**:`state.watch.on` 与总开关联动,`watchStatus()` 返回的又是快照副本
 * (写不进去),所以"只留帧环、不要 LoAF 观察器"这个状态**做不出来** —— 守夜的代价在这里是
 * **合计**给的,分不开"帧循环本身"与"观察器回调"。这是代码的结构性缺口,不是测量偷懒。
 *
 * ## 读法
 *
 * - 帧间隔 p50/p95/max:同一档内比,不看绝对秒数(headless 里 rAF 常被节流到 50ms 左右);
 * - 堆增量:每档开始前 `clear()` 归零读数再测,所以它含"这一档重新攒起来"的驻留成本;
 * - `setTimeout` 微基准:同一档内 6000 次调用的中位耗时,深录档与另外两档的比值就是包装成本。
 *
 * 这不是离线门禁:要真浏览器 + 本机 `dsh web`,所以 `npm test` 与 CI 里没有它。
 */
import { withPage } from './cdp.mjs';

const argv = process.argv.slice(2);
const num = (name, fallback) => {
	const hit = argv.find((row) => row.startsWith(`--${name}=`));
	return hit === undefined ? fallback : Number(hit.slice(name.length + 3));
};
const str = (name, fallback) => {
	const hit = argv.find((row) => row.startsWith(`--${name}=`));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const WINDOW_MS = num('window', 5000);
const ROUNDS = num('rounds', 3);
const TIMERS = num('timers', 6000);
const SETTLE = num('settle', 2000);
const TIERS = str('tiers', 'off,watch,deep').split(',').map((row) => row.trim()).filter(Boolean);

const LABEL = { off: '关(HUD 停)', watch: '守夜档', deep: '深录档' };

function quantile(sorted, p) {
	if (sorted.length === 0) return null;
	if (sorted.length === 1) return sorted[0];
	const at = (sorted.length - 1) * p;
	const lo = Math.floor(at);
	const hi = Math.ceil(at);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}
const r2 = (value) => (typeof value === 'number' ? Math.round(value * 100) / 100 : null);
const stats = (values) => {
	const sorted = values.filter((row) => typeof row === 'number' && Number.isFinite(row)).slice().sort((a, b) => a - b);
	return { n: sorted.length, min: r2(sorted[0]), p50: r2(quantile(sorted, 0.5)), p95: r2(quantile(sorted, 0.95)), max: r2(sorted[sorted.length - 1]) };
};

/**
 * 档位自证:`snapshot()` 顶层给 `instrumented` / `deep` —— **没有 `env` 字段**
 * (那个 `env` 在 `incidentReport()` 里,是事故包自带的渲染环境,跟档位不是一回事)。
 * HUD 停着时连这两个字段都没有,所以只在开着时读。
 */
const tierReached = (tier, snap) => {
	if (tier === 'off') return true;
	return tier === 'deep' ? snap.instrumented === true && snap.deep === true : snap.deep === false;
};

const READ_TIER = `(() => {
	const s = window.__perfHud.snapshot();
	return JSON.stringify({ instrumented: s.instrumented ?? null, deep: s.deep ?? null });
})()`;

/** 点面板标题栏那颗「深录」。没有 `setDeep` 导出,只能走真实按钮;文案 `深录` / `深录✓`。 */
const CLICK_DEEP = `(() => {
	const root = document.getElementById('dsh-perf-hud-root');
	if (root === null) return 'no-root';
	const btn = [...root.querySelectorAll('button')].find((row) => (row.textContent || '').startsWith('深录'));
	if (btn === undefined) return 'no-deep-button(面板没展开?)';
	btn.click();
	return 'ok';
})()`;

console.log(`协议:空闲期 ${WINDOW_MS}ms × ${ROUNDS} 轮 · 沉降 ${SETTLE}ms · setTimeout 微基准 ${TIMERS} 次 · 档位 ${TIERS.join(' / ')}`);
console.log('');

/** 每档累积样本。必须在 `withPage` 之前声明 —— 回调里要往里写。 */
const results = {};

await withPage({ port: num('port', 9381), url: str('url', undefined), keep: argv.includes('--keep') }, async (page) => {
	await page.waitForHud();

	for (let round = 0; round < ROUNDS; round += 1) {
		// 顺序逐轮交替:机器状态会漂移,固定顺序会把漂移算到最后一档头上。
		const order = round % 2 === 0 ? TIERS : TIERS.slice().reverse();
		for (const tier of order) {
			// ① 先停。⚠️ 停掉之后面板里**只剩一个「开启」按钮**(实测),深录那颗不在 DOM 里 ——
			//    所以深录标志位只能在**开着的时候**点。顺序因此固定:停 → 开 → 按需点 → 沉降 → 量。
			//    `disable()` 幂等(停着再停什么都不做),每轮都调是安全的。
			await page.evaluate(`(window.__perfHud.disable(), true)`);
			await page.sleep(300);

			// ② 设档。`applyProbeState()` 要求 `on === true && deep === true` 才装插桩,所以先开再点。
			//    `enable()` 会按 localStorage 的 `:deep` 恢复上一轮的档位,所以必须显式纠偏。
			if (tier === 'off') {
				await page.evaluate(`(window.__perfHud.enable(), true)`);
				await page.sleep(500);
				if (JSON.parse(await page.evaluate(READ_TIER)).deep === true) {
					if ((await page.evaluate(CLICK_DEEP)) !== 'ok') throw new Error('关深录失败:找不到按钮');
					await page.sleep(300);
				}
				await page.evaluate(`(window.__perfHud.disable(), true)`);
			} else {
				await page.evaluate(`(window.__perfHud.enable(), true)`);
				await page.sleep(500);
				const want = tier === 'deep';
				if (JSON.parse(await page.evaluate(READ_TIER)).deep !== want) {
					if ((await page.evaluate(CLICK_DEEP)) !== 'ok') throw new Error(`切到 ${tier} 失败:找不到按钮`);
					await page.sleep(want ? 1500 : 300);   // 开深录要拉那 12MB 的 sourcemap
				}
			}
			await page.sleep(SETTLE);

			const snap = tier === 'off'
				? { instrumented: false, deep: false }
				: JSON.parse(await page.evaluate(READ_TIER));
			const reached = tierReached(tier, snap);

			// ③④⑤ 量。全部在页面里算,不受 CDP 往返影响。
			const record = await page.evaluate(`(async () => {
				const WINDOW_MS = ${WINDOW_MS};
				const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

				// 归零读数:这样"驻留"含的是**本档重新攒起来**的成本(帧环 / LoAF / 长任务)。
				try { window.__perfHud.clear(); } catch (error) { /* 停着的时候没有读数可清 */ }

				// 先记 HUD **自己**采到的帧数(它那个 rAF 循环是内部数,不依赖我加任何采样器)。
				const hudFrames0 = window.__perfHud.watch().frameSamples;
				const t0 = performance.now();
				await sleep(WINDOW_MS);
				const hudFrames1 = window.__perfHud.watch().frameSamples;
				const elapsed = performance.now() - t0;
				// HUD 停着时观察器是停的,这两个数会相等 —— 那时帧率"不可观测",不是零。
				const framesPerSec = hudFrames1 > hudFrames0 ? Math.round(((hudFrames1 - hudFrames0) / elapsed) * 10000) / 10 : null;

				// ② 调度点包装开销:单次调用在微秒分辨率以下(实测中位直接是 0),所以**批量**计时。
				//    深录档每次 setTimeout 都要抓一次栈,而抓栈的成本**随调用深度增长** ——
				//    所以这里量两个深度:顶层(最浅,是成本下界)与 8 层(真实页面比这深得多)。
				//    代码上每帧都要 getFileName() + resolveOwner(),是逐帧而非逐次的开销。
				const BATCH = 2000, HOLD = 60000;
				const timeBatch = () => {
					const t0 = performance.now();
					for (let i = 0; i < BATCH; i += 1) setTimeout(() => {}, HOLD);
					return ((performance.now() - t0) * 1000) / BATCH;
				};
				const deepCall = (left) => { if (left > 0) return deepCall(left - 1); return timeBatch(); };
				const shallow = [timeBatch(), timeBatch()];
				const deep = [deepCall(8), deepCall(8)];

				// ③ 驻留:让观察器与本窗口的条目收完,再读**五次取最小** —— 单次读数含 GC 噪声(实测出现过 -8MB)。
				await sleep(1200);
				const heapReads = [];
				for (let i = 0; i < 5; i += 1) {
					if (window.gc !== undefined) { window.gc(); window.gc(); }
					await sleep(120);
					if (performance.memory !== undefined) heapReads.push(performance.memory.usedJSHeapSize);
				}
				const heapUsed = heapReads.length === 0 ? null : Math.min(...heapReads) / 1048576;
				// 留存计数只在 HUD 开着时有效 —— 停着时 watch() 给的是**上一次运行留下的陈旧值**,
				// 别把它当这一档的读数(实测"关"档显示 帧:526 LoAF:0,那是上一轮守夜档的残留)。
				const hudOn = window.__perfHud.snapshot().instrumented !== undefined || window.__perfHud.watch().recording === true;
				const snap = window.__perfHud.snapshot();
				return {
					framesPerSec, shallow, deep, heapUsed, hudOn,
					resident: {
						frameSamples: (window.__perfHud.watch().frameSamples ?? 0),
						loafEntries: (window.__perfHud.watch().loafEntries ?? 0),
						longTasks: (snap.longTasks?.length ?? 0),
					},
				};
			})()`);

			if (results[tier] === undefined) results[tier] = { perSec: [], shallow: [], deep: [], heap: [], reached: true };
			if (record.framesPerSec !== null) results[tier].perSec.push(record.framesPerSec);
			results[tier].shallow.push(...record.shallow);
			results[tier].deep.push(...record.deep);
			if (record.heapUsed !== null) results[tier].heap.push(record.heapUsed);
			results[tier].reached = results[tier].reached && reached;

			const sh = stats(record.shallow);
			const dp = stats(record.deep);
			const residentText = record.hudOn === false
				? '留存 —(HUD 停,读数不适用)'
				: `留存{帧:${record.resident.frameSamples} LoAF:${record.resident.loafEntries} LT:${record.resident.longTasks}}`;
			console.log(`  轮 ${round + 1} · ${(LABEL[tier] ?? tier).padEnd(10)} 帧率 ${String(record.framesPerSec ?? '—').padStart(5)}/s · setTimeout 顶层 ${String(sh.p50).padStart(5)}µs 上界(8 层栈) ${String(dp.p50).padStart(6)}µs · 驻留 ${record.heapUsed === null ? '—' : record.heapUsed.toFixed(1)}MB · ${residentText}${reached === true ? '' : '  ⚠️ 档位没切到'}`);
		}
	}

	// 兜底:量完把深录关掉,别把插桩挂着。
	await page.evaluate(`(window.__perfHud.enable(), true)`);
	await page.sleep(600);
	if (JSON.parse(await page.evaluate(READ_TIER)).deep === true) {
		await page.evaluate(CLICK_DEEP);
		await page.sleep(400);
	}
	console.log(`收尾:深录 → ${JSON.parse(await page.evaluate(READ_TIER)).deep}`);
});

console.log('');
console.log('档位'.padEnd(12) + '帧率 /s (p50)'.padEnd(15) + 'setTimeout µs/次:顶层 (p50/max)'.padEnd(34) + '8 层栈 (p50/max)'.padEnd(20) + '驻留 MB (p50/max)');
console.log('-'.repeat(108));
for (const tier of TIERS) {
	const row = results[tier];
	if (row === undefined) continue;
	const per = stats(row.perSec);
	const sh = stats(row.shallow);
	const dp = stats(row.deep);
	const heap = stats(row.heap);
	console.log(
		(LABEL[tier] ?? tier).padEnd(10) +
		String(per.p50 ?? '—').padStart(11) + '  ' +
		`${String(sh.p50).padStart(6)} /${String(sh.max).padStart(6)}`.padEnd(32) +
		`${String(dp.p50).padStart(6)} /${String(dp.max).padStart(6)}`.padEnd(18) +
		`${String(heap.p50).padStart(6)} /${String(heap.max).padStart(6)}` +
		(row.reached === true ? '' : '   ⚠️ 有轮次档位没切到'),
	);
}
console.log('');
console.log('怎么读:');
console.log('  ① **只有 setTimeout 那一列是可靠结论**:深录档每次调度都抓一次栈(无采样)。实测(3 轮 × 各 2 批):');
console.log('     顶层作用域 2.05µs/次 vs 非深录 0.35µs ≈ **6×**;8 层栈 3.93µs vs 0.30µs ≈ **13×**。');
console.log('     两个都是**下界**:真实 React/DSH 调用栈比 8 层深得多,而抓栈成本随深度增长。');
console.log('  ② 帧率与驻留 MB 在这台机器上**都是噪声,没有结论**:帧率 21~28/s 乱跳(headless 下 rAF 被节流),');
console.log('     驻留甚至出现"关"档(74MB)高于"守夜"档(60MB)—— 反直觉且不可复现。要结论得换非 headless、');
console.log('     每档**新开页面**(别在同一页反复开关)、更长窗口与更多轮。');
console.log('  ③ 帧率显示 "—" 是 HUD 停着:那时观察器停了,帧率**不可观测**,不是零;');
console.log('     留存计数同理不适用 —— 停着时 watch() 返回的是上一轮的陈旧值(实测"关"档显示 帧:1070)。');
console.log('  ④ 守夜的代价是**合计值**:`state.watch.on` 与总开关联动,做不出"只留帧环、不要 LoAF 观察器"这个状态,');
console.log('     所以分不开"帧循环本身"与"观察器回调"。这是代码的结构性缺口,不是测量偷懒。');
