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
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

/** 词典的键名:面板正文里出现任何一个,就说明它少了词条、界面上印出了 key(实测踩过 7 个)。 */
const DICT_KEYS = (() => {
	const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
	const start = source.indexOf('const DICT = {');
	const block = source.slice(start, source.indexOf('\n\t\t};', start));
	return [...new Set([...block.matchAll(/^\s{4}([A-Za-z_$][\w$]*):/gm)].map((row) => row[1]))];
})();

/** 某个视图的正文里有没有漏成 key 的文案。
 * ⚠️ 要按**标识符边界**比:直接 `includes` 会把 `watchui` 里的 `watch` 也算成漏文案(实测的假阳性)。 */
const leakedKeys = (text) => DICT_KEYS.filter((key) => new RegExp(`(^|[^A-Za-z0-9_$])${key}([^A-Za-z0-9_$]|$)`).test(text));

let failed = 0;
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failed += 1;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
};

/** 按可见文字点一个按钮(面板没有 test-id,按文案点最接近"用户真的点了它")。 */
const clickText = (evaluate, text) => evaluate(`(() => {
	const nodes = [...document.querySelectorAll('#dsh-perf-hud-root button')].filter((node) => node.textContent.trim() === ${JSON.stringify(text)});
	if (nodes.length === 0) return 'missing';
	if (nodes[0].disabled === true) return 'disabled';
	nodes[0].click();
	return 'clicked';
})()`);

await withPage({}, async ({ evaluate, reload, waitForHud, sleep }) => {
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

	// ── 诊断包:能力矩阵 / 候选原因 / 四个文件,而且凭据进不去 ──
	const pack = await evaluate(`(() => {
		const list = window.__perfHud.incidents();
		if (list.length === 0) return { none: true };
		const id = list[0].id;
		history.replaceState({}, '', '/?token=LEAK_PROBE_12345&api_key=LEAK_KEY_67890');
		const built = window.__perfHud.pack(id);
		const preview = window.__perfHud.preview(id);
		const text = built.files.map((file) => file.text).join(String.fromCharCode(10));
		const manifest = JSON.parse(built.files.find((file) => file.name === 'manifest.json').text);
		const causes = window.__perfHud.causes(id);
		history.replaceState({}, '', '/');
		return {
			files: built.files.map((file) => file.name),
			hasSecret: text.includes('LEAK_PROBE_12345') || text.includes('LEAK_KEY_67890'),
			sections: ['## 1. 摘要', '## 2. 最可能的假设', '## 3. 缺失的证据', '## 4. 下一步验证', '## 5. 元信息']
				.filter((head) => built.files[1].text.includes(head)).length,
			manifest: [manifest.schemaVersion, manifest.capabilities.schema, manifest.redaction.applied.length > 0, manifest.notIncluded.length],
			capLeaves: Object.keys(manifest.capabilities.renderer).length,
			previewFiles: preview.files.length,
			previewExcludes: preview.excludes.length,
			causeLeads: causes.map((item) => item.kind),
			causeShape: causes.every((item) => item.basis.length > 0 && item.limits.length > 0
				&& ['measured', 'inferred', 'unknown'].includes(item.provenance)),
		};
	})()`);
	check('诊断包:四个文件按固定顺序给出来', pack.files, ['manifest.json', 'summary.md', 'incident.json', 'README.md']);
	check('诊断包:凭据进不去(真 location 里塞了 token / api_key)', pack.hasSecret, false);
	check('诊断包:摘要五段齐全', pack.sections, 5);
	check('诊断包:manifest 带 schemaVersion / 能力矩阵 / 脱敏 / 不含清单',
		[pack.manifest[0], pack.manifest[1], pack.manifest[2], pack.manifest[3] > 0], [1, 1, true, true]);
	check('诊断包:能力矩阵 renderer 一组齐全(>= 6 个叶子)', pack.capLeaves >= 6, true);
	check('诊断包:预览列出文件与排除项', [pack.previewFiles, pack.previewExcludes >= 3], [4, true]);
	check('诊断包:候选原因每条都带支持与限制、出处三档', pack.causeShape, true);
	console.log(`     包 = ${pack.files.join(' / ')} · 候选 ${JSON.stringify(pack.causeLeads)}`);

	// ── P1:ZIP 的真实字节验收(页面里生成的 zip 落盘,交给系统 unzip 判)──
	// 先造一条**带备注**的事故:否则"AI 包脱敏 / 完整包保留"这件事根本验不到
	// ⚠️ 手动标记会被**并进正在等的那一次**(`triggerCapture` 的 pending 分支),那样样本就没备注 ——
	// 所以先等 pending 空出来。这不是放宽断言,而是让样本真的落在"手动标记"这条路上。
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (await evaluate(`window.__perfHud.watch().pending === null`)) break;
		await sleep(300);
	}
	const zipInfo = await evaluate(`(async () => {
		window.__perfHud.capture('验收:带备注 token=SECRET_NOTE');
		await new Promise((resolve) => setTimeout(resolve, 900));
		const list = window.__perfHud.incidents();
		if (list.length === 0) return null;
		const withNote = list.find((row) => row.note !== null && row.note !== undefined) ?? list[0];
		const id = withNote.id;
		return { id, hasNote: withNote.note !== null && withNote.note !== undefined,
			ai: window.__perfHud.zip(id, { dropFreeText: true }), full: window.__perfHud.zip(id, { dropFreeText: false }) };
	})()`);
	check('ZIP:验收样本真的带备注(否则下面两条是空断言)', zipInfo === null ? false : zipInfo.hasNote, true);
	if (zipInfo !== null) {
		const aiPath = `${tmpdir()}/dsh-perf-hud-check-ai.zip`;
		const fullPath = `${tmpdir()}/dsh-perf-hud-check-full.zip`;
		writeFileSync(aiPath, Buffer.from(zipInfo.ai, 'base64'));
		writeFileSync(fullPath, Buffer.from(zipInfo.full, 'base64'));
		const probe = execFileSync('unzip', ['-t', aiPath], { encoding: 'utf8' });
		check('ZIP:系统 unzip 认它是合法压缩包(No errors detected)', /No errors detected/.test(probe), true);
		const listing = execFileSync('unzip', ['-l', aiPath], { encoding: 'utf8' });
		check('ZIP:包里就是那四份文件(顺序与清单一致)',
			['manifest.json', 'summary.md', 'incident.json', 'README.md'].filter((name) => listing.includes(name)),
			['manifest.json', 'summary.md', 'incident.json', 'README.md']);
		const aiIncident = execFileSync('unzip', ['-p', aiPath, 'incident.json'], { encoding: 'utf8' });
		const fullIncident = execFileSync('unzip', ['-p', fullPath, 'incident.json'], { encoding: 'utf8' });
		const aiSummary = execFileSync('unzip', ['-p', aiPath, 'summary.md'], { encoding: 'utf8' });
		check('ZIP:AI 包把备注置空并标 noteDropped,两个文件里都不出现原文',
			[JSON.parse(aiIncident).incident.note, JSON.parse(aiIncident).incident.noteDropped,
				/备注:已置空/.test(aiSummary), /SECRET_NOTE/.test(aiIncident + aiSummary)],
			[null, true, true, false]);
		check('ZIP:完整包保留备注正文,但里面粘的凭据照样被脱成占位符',
			[/验收:带备注/.test(fullIncident), /token=<redacted>/.test(fullIncident), /SECRET_NOTE/.test(fullIncident)],
			[true, true, false]);
		check('ZIP:两条路的包大小不一样(差的正是那段自由文本)', Buffer.from(zipInfo.full, 'base64').length > Buffer.from(zipInfo.ai, 'base64').length, true);
		console.log(`     真 zip:ai ${Buffer.from(zipInfo.ai, 'base64').length}B / full ${Buffer.from(zipInfo.full, 'base64').length}B · unzip -t 通过 · 四份文件齐全`);
	}

	// ── 本轮收尾:人话原因 / 展开区 / 两条导出路径 / 分享前预览 ──
	// 先把面板摆到主界面(这一屏才是普通用户看到的)
	await evaluate(`localStorage.setItem('dsh-perf-hud:collapsed','0'); localStorage.setItem('dsh-perf-hud:view:v1', JSON.stringify({ v: 1, view: 'main', devTab: 'frames', trendMs: 3600000 }))`);
	await reload();
	const mainText = await evaluate(`document.getElementById('dsh-perf-hud-root').innerText`);
	check('主界面:原因块在,而且默认**不出现**包名(普通用户看到的是人话线索)',
		[/可能原因/.test(mainText), /某个脚本模块的耗时偏高|这一段时间里有较重的渲染任务|宿主进程那侧偏忙|缺少能解释这次停顿的 JS 证据/.test(mainText),
			/@deepseek-ai\/|dsh-/.test(mainText)],
		[true, true, false]);
	check('主界面:默认不铺展开区(支持 / 限制要先点开)',
		[mainText.includes('以下是原始证据'), mainText.includes('为什么这样判断?')], [false, true]);

	const why = await clickText(evaluate, '为什么这样判断?');
	const expanded = await evaluate(`document.getElementById('dsh-perf-hud-root').innerText`);
	check('展开「为什么这样判断?」之后才给原始包名与支持 / 限制(要查的时候够得着)',
		[why, expanded.includes('以下是原始证据'), expanded.includes('支持:'), expanded.includes('限制:'),
			/不等于已定位根因/.test(expanded)],
		['clicked', true, true, true, true]);
	console.log(`     展开后片段 = ${JSON.stringify(expanded.slice(expanded.indexOf('以下是原始证据'), expanded.indexOf('以下是原始证据') + 120).replace(/\s+/g, ' '))}`);

	// 分享前预览:点「导出诊断报告」不许直接下载,先摊清单
	const previewOpen = await clickText(evaluate, '导出诊断报告');
	const previewText = await evaluate(`document.getElementById('dsh-perf-hud-root').innerText`);
	check('主界面导出先出预览:写明文件 / 备注已置空 / 本包不含,并给"生成并导出"与"取消"',
		[previewOpen, /导出预览/.test(previewText), /备注:已置空/.test(previewText), /manifest\.json/.test(previewText),
			previewText.includes('生成并导出'), previewText.includes('取消')],
		['clicked', true, true, true, true, true]);
	check('预览态不产生渲染错误', (await evaluate(`window.__perfHud.snapshot().errors.length`)), 0);
	const cancelled = await clickText(evaluate, '取消');
	const afterCancel = await evaluate(`document.getElementById('dsh-perf-hud-root').innerText`);
	check('取消之后预览收起(不留一个关不掉的卡片)', [cancelled, /导出预览/.test(afterCancel)], ['clicked', false]);

	// 两条导出路径在开发者详情里各有各的名字
	await clickText(evaluate, '开发者详情(技术数据)');
	await clickText(evaluate, '原始数据');
	const devText = await evaluate(`document.getElementById('dsh-perf-hud-root').innerText`);
	check('开发者详情把两条导出路径分开写:给 AI(脱敏、不含备注) / 完整技术导出(保留备注)',
		[/导出诊断包\(给 AI/.test(devText), /完整技术导出\(保留备注\)/.test(devText), devText.includes('复制导出预览')],
		[true, true, true]);

	// 面板正文里出现词典键名 = 那个文案少了词条(translate 退回 key)。逐视图扫一遍。
	const devLeaks = await evaluate(`document.getElementById('dsh-perf-hud-root').innerText`);
	check('开发者详情 / 原始数据这一屏没有漏成 key 的文案(引用的键都在词典里)',
		leakedKeys(devLeaks), []);
	await clickText(evaluate, '← 返回');
	await clickText(evaluate, '查看这次卡顿').catch(() => 'missing');
	const incidentLeaks = await evaluate(`document.getElementById('dsh-perf-hud-root').innerText`);
	check('卡顿详情这一屏也没有漏成 key 的文案',
		leakedKeys(incidentLeaks), []);
	await clickText(evaluate, '卡顿详情 ← 返回').catch(() => 'missing');


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
