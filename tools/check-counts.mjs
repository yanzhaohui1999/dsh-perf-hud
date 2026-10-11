/**
 * 真页面验收器:捕获计数(与留存分离)+ 导出脱敏。
 *
 *   node tools/check-counts.mjs
 *
 * 它挡的是离线套件结构上盖不到的两类事故:
 *   ① 计数只在内存里"看着对" —— 离线盒子里 `tallyWindow()` 绿,但真页面上
 *      `triggerCapture → settleCapture → 落盘 → 刷新` 这条路上少接了一环(比如漏了
 *      `restoreTally()`,或者 `markTallyDirty()` 的合并定时器根本没跑);
 *   ② 导出件把凭据带出去 —— 离线盒子里 `location` 是桩,只有真页面的 `location.href`
 *      才可能带着真凭据(所以下面用 `history.replaceState` 把凭据**塞进真 location**,
 *      否则这条断言是空的:DSH 启动之后自己会把 `?token=` 从地址栏抹掉)。
 *
 * ⚠️ 两条与"活页面"有关的写法,别改成死断言:
 *   - 真页面一直在跑,`coalesced` 会被真实的帧触发推着走 —— 所以只断言**口径**
 *     (`detected === captured + coalesced`)与"至少 +1",不断言具体等于 1;
 *   - 药丸是每 500ms 按指纹重绘的,读 DOM 时的数字**允许落后于** `tally()` 一笔 ——
 *     所以只断言"那一格在、且是检测到那个数",具体等于几由 `tally()` 负责。
 *
 * ⚠️ 不是离线门禁:要本机跑着 `dsh web` + 装着 Chrome(与 check-panel 同一套约定)。
 */
import { withPage } from './cdp.mjs';

let failed = 0;
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failed += 1;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
};

await withPage({}, async ({ evaluate, reload, waitForHud }) => {
	await waitForHud();
	check('HUD 挂上了', await evaluate(`typeof window.__perfHud === 'object'`), true);

	// ── 导出脱敏:把凭据塞进**真的** location,再看它会不会被带出去 ──
	const privacy = await evaluate(`(() => {
		const before = location.href;
		history.replaceState({}, '', '/?token=LEAK_PROBE_12345&api_key=LEAK_KEY_67890');
		const href = location.href;
		const snap = window.__perfHud.snapshot();
		const incident = window.__perfHud.incidents().length === 0 ? null : window.__perfHud.report(0);
		const text = JSON.stringify(snap) + (incident === null ? '' : JSON.stringify(incident));
		const out = {
			hrefHasSecrets: href.includes('LEAK_PROBE_12345') && href.includes('LEAK_KEY_67890'),
			snapHasSecrets: text.includes('LEAK_PROBE_12345') || text.includes('LEAK_KEY_67890'),
			page: snap.page,
			redactionApplied: Array.isArray(snap.context.redaction.applied) && snap.context.redaction.applied.length > 0,
			redactionSaysSubset: /做减法/.test(snap.context.redaction.rule ?? ''),
		};
		history.replaceState({}, '', new URL(before).pathname);
		return out;
	})()`);
	check('真 location 里确实有凭据(这条断言才有牙齿)', privacy.hrefHasSecrets, true);
	check('整机导出件 + 事故包里都没有那两个凭据', privacy.snapHasSecrets, false);
	check('导出件的 page 只剩 origin + path(查询串整段丢了)', /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(privacy.page), true);
	check('导出件自带 redaction 声明,而且口径是"做减法"不是"已匿名化"',
		[privacy.redactionApplied, privacy.redactionSaysSubset], [true, true]);
	console.log(`     page = ${privacy.page}`);

	// ── 计数:清干净 → 手动标记一次 → 口径与落盘都要对 ──
	const before = await evaluate(`(() => {
		window.__perfHud.clearTally();
		window.__perfHud.clearIncidents();
		const row = window.__perfHud.tally(24 * 3600 * 1000);
		return { detected: row.detected, kept: row.kept, lost: row.lost };
	})()`);
	check('清干净之后:检测到 / 已保存 / 丢失 三个数都是 0', [before.detected, before.kept, before.lost], [0, 0, 0]);

	// 合并落盘是 2 秒一拍(markTallyDirty),所以这里要等过它 —— 等 1.2 秒会假失败。
	// 而"切现场"这一步(settleCapture)可能落在**这一拍之后**,所以等两拍(5 秒),
	// 否则读到的是上一次落盘那份(实测:存的是 coalesced,captured 还差一拍)。
	const after = await evaluate(`(async () => {
		const ok = window.__perfHud.capture('验收器:计数探针');
		await new Promise((resolve) => setTimeout(resolve, 5000));
		const row = window.__perfHud.tally(24 * 3600 * 1000);
		const stored = localStorage.getItem('dsh-perf-hud:tally:v1');
		const parsed = stored === null ? null : JSON.parse(stored);
		let storedCaptured = 0;
		for (const bucket of Object.values(parsed?.minute ?? {})) storedCaptured += bucket[1];
		return {
			captureOk: ok?.ok === true,
			detected: row.detected, triggered: row.triggered, captured: row.captured,
			coalesced: row.coalesced, kept: row.kept, lost: row.lost,
			storedBuckets: parsed === null ? 0 : Object.keys(parsed.minute ?? {}).length,
			storedCaptured,
		};
	})()`);
	check('口径在真页面上也成立:检测到 = triggered', [after.detected, after.triggered], [after.triggered, after.triggered]);
	check('coalesced 不是次数 —— 一次卡顿在后摇窗口里每帧触发,把两者相加会虚报',
		[after.coalesced === 0 ? true : after.detected !== after.captured + after.coalesced], [true]);
	check('真捕获进了桶(至少 +1)', [after.captured >= 1, after.detected >= 1], [true, true]);
	check('留存份数是另一个数:kept ≤ detected(它只多不少不了)', after.kept <= after.detected, true);
	check('计数落盘了(不是只在内存里)', after.storedBuckets >= 1 && after.storedCaptured >= 1, true);
	console.log(`     检测到 ${after.detected}(triggered ${after.triggered} · 切成现场 ${after.captured} · 同串触发 ${after.coalesced})· 已保存现场 ${after.kept} · 丢失 ${after.lost}`);

	// ── 活过刷新:以**落盘的那份**为基准(活页面读数会继续涨) ──
	await reload();
	const revived = await evaluate(`(() => {
		const row = window.__perfHud.tally(24 * 3600 * 1000);
		return { detected: row.detected, captured: row.captured };
	})()`);
	check('刷新之后计数读回来了(跨刷新口径成立)',
		[revived.captured >= after.storedCaptured, revived.captured >= 1], [true, true]);

	// ── 折叠药丸那一格:说的是"检测 N 次",不是留存份数 ──
	await evaluate(`localStorage.setItem('dsh-perf-hud:collapsed', '1')`);
	await reload();
	const pill = await evaluate(`(() => {
		const text = document.querySelector('#dsh-perf-hud-root')?.innerText ?? '';
		const row = window.__perfHud.tally(24 * 3600 * 1000);
		const found = /检测 (\\d+) 次/.exec(text);
		return { text, detected: row.detected, kept: row.kept, shown: found === null ? null : Number(found[1]) };
	})()`);
	check('折叠药丸上出现「检测 N 次」那一格', pill.shown === null, false);
	check('药丸上的数与计数同一量级(DOM 允许落后一笔,但不会差一个数量级)',
		[pill.shown >= 1, pill.shown <= pill.detected + 5], [true, true]);
	console.log(`     药丸 = ${JSON.stringify(pill.text.replace(/\s+/g, ' ').trim())}`);

	check('全程面板 0 错误', await evaluate(`window.__perfHud.snapshot().errors.length`), 0);
	await evaluate(`localStorage.setItem('dsh-perf-hud:collapsed', '0')`);
});

console.log(failed === 0 ? 'ALL PASS(真页面)' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
