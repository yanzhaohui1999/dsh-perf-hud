/**
 * 改完**历史事故回放 / 取证明细的上下文切换**之后跑这条:真开一次 DSH 页面,手动抓一条事故,
 * 然后在历史事故上下文里逐帧走一遍,断言界面真的跟着变。
 *
 *   node tools/check-incident.mjs
 *
 * 它挡的是离线套件**结构上挡不住**的那一类事故:纯函数全绿,但"点了帧条下面的详情没跟着变"、
 * "上面是历史事故、下面是实时帧"、"刷新之后历史事故打不开"这些只有在真实渲染里才看得出来。
 *
 * 覆盖(对应任务书里的验收场景):
 *   1. 打开一条历史事故:历史回放与详情说的是同一条事故
 *   2. 帧条 / 上一帧 / 下一帧 / 上一异常帧 / 下一异常帧:标题与耗时同步更新
 *   3. 绿色档位以外的帧:按钮该禁用就禁用(没有"点了没反应")
 *   4. 刷新之后仍然能打开、还停在同一帧
 *   5. 切回实时:实时帧条与实时读数回来,历史帧块消失
 *
 * 与 `check-panel.mjs` 一样:**不是离线门禁**(要真浏览器 + 本机跑着 `dsh web`),
 * `npm test` 与 CI 里都没有它。
 */
import { withPage } from './cdp.mjs';

let failed = 0;
const check = (name, ok, detail = '') => {
	if (ok !== true) failed += 1;
	console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  ${detail}`}`);
};

/** 按可见文字点一个按钮(面板没有 test-id,按文案点最接近"用户真的点了它")。 */
const clickText = (page, text) => page.evaluate(`(() => {
	const nodes = [...document.querySelectorAll('#dsh-perf-hud-root button')].filter((node) => node.textContent.trim() === ${JSON.stringify(text)});
	if (nodes.length === 0) return 'missing';
	if (nodes[0].disabled === true) return 'disabled';
	nodes[0].click();
	return 'clicked';
})()`);

/** 面板里那段上下文标题(取证明细的第一行)。 */
const contextBar = (page) => page.evaluate(`(() => {
	const node = document.querySelector('#dsh-perf-hud-root [data-ctx-bar="1"]');
	return node === null ? null : node.textContent.trim();
})()`);

const errors = (page) => page.evaluate(`window.__perfHud.snapshot().errors`);

const frameCount = (page) => page.evaluate(`document.querySelectorAll('#dsh-perf-hud-root svg[viewBox="0 0 240 24"] rect').length`);

await withPage({ port: Number(process.env.PORT ?? 9371) }, async (page) => {
	await page.waitForHud();
	check('HUD 挂上且面板渲染出来', true);

	// 先清一遍:验收要的是"这一次真的抓到了",不是上一个 profile 里留下的记录。
	// 用 clearIncidents(只清事故)+ 刷新:刷新会顺带把上下文选择归零(没有事故就回实时)。
	await page.evaluate(`window.__perfHud.clearIncidents()`);
	await page.reload();
	await page.waitForHud();
	// 同步烧 400ms → 帧环里真的出现一条达线的帧(不是造数据:事故包的帧只有真烧出来的才算数,
	// headless 空闲页可能一条达线帧都没有)。守夜会因此自动起一次捕获,等它的 3 秒后摇切片。
	await page.evaluate(`(() => { const until = performance.now() + 400; while (performance.now() < until) { /* burn */ } return true; })()`);
	await page.sleep(4500);
	const captured = await page.evaluate(`(() => {
		const list = window.__perfHud.incidents();
		if (list.length === 0) return { n: 0 };
		const pack = window.__perfHud.incident(0);
		return { n: list.length, id: list[0].id, cause: list[0].cause, ms: Math.round(list[0].severity), frames: Array.isArray(pack.frames) ? pack.frames.length : -1, loaf: Array.isArray(pack.loaf) ? pack.loaf.length : -1 };
	})()`);
	check('烧出来的长帧被守夜自动抓成一条事故,而且包里真带帧记录(后面所有回放的地基)',
		captured.n >= 1 && captured.frames > 0, JSON.stringify(captured));

	const clicked = await clickText(page, '看这一帧');
	check('「看这一帧」可点并且切进了历史事故上下文', clicked === 'clicked', clicked);

	const ctxIncident = await contextBar(page);
	check('详情区第一行是**历史事故**上下文(不是实时那一支)', typeof ctxIncident === 'string' && ctxIncident.includes('历史事故') && ctxIncident.includes('历史帧'), JSON.stringify(ctxIncident));
	check('事故回放的时间轴在场(历史帧条)', (await frameCount(page)) > 0);
	check('面板没有渲染错误', (await errors(page)).length === 0, JSON.stringify(await errors(page)));

	// 帧条:点一根柱子 → 选中的帧必须换(标题与耗时同步更新)
	const beforePick = await contextBar(page);
	const barPick = await page.evaluate(`(() => {
		const bars = [...document.querySelectorAll('#dsh-perf-hud-root svg[viewBox="0 0 240 24"] rect')].filter((node) => node.getAttribute('width') === '1');
		if (bars.length < 2) return 'few';
		// 点最靠左的那一根:它与"最差那一帧"通常不是同一条
		bars[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
		return 'clicked';
	})()`);
	const afterPick = await contextBar(page);
	check('点帧条柱子 → 选中的历史帧跟着换(标题同步更新)', barPick === 'clicked' && afterPick !== beforePick, `${JSON.stringify(beforePick)} → ${JSON.stringify(afterPick)}`);

	// 翻帧:下一帧 / 上一帧回到原处
	const step1 = await clickText(page, '下一帧 ▶');
	const afterNext = await contextBar(page);
	const step2 = await clickText(page, '◀ 上一帧');
	const afterPrev = await contextBar(page);
	check('下一帧 / 上一帧都是真动作(标题跟着变,再变回来)',
		step1 === 'clicked' && step2 === 'clicked' && afterNext !== afterPick && afterPrev === afterPick,
		`${JSON.stringify(afterPick)} → ${JSON.stringify(afterNext)} → ${JSON.stringify(afterPrev)}`);

	// 上一/下一异常帧:必须走到一条帧间隔 ≥ 100ms 的帧上(异常档位是"警告"或"严重")
	const badNext = await clickText(page, '下一异常帧 ⏭');
	const afterBad = await contextBar(page);
	const hot = await page.evaluate(`(() => {
		const bar = document.querySelector('#dsh-perf-hud-root [data-ctx-bar="1"]');
		return /(严重|警告)/.test(bar.parentElement.innerText);
	})()`);
	check('下一异常帧落到的是一条达线的帧(档位文字给出"警告/严重")', badNext === 'clicked' && hot === true, JSON.stringify(afterBad));

	// 禁用态:一路点到最后一帧之后,"下一帧"必须是禁用的(不许点不动却还在)。
	// ⚠️ 两次 evaluate 必须分开:React 18 把这次状态更新排在**微任务**里,同一次同步执行里
	// 读到的还是旧 DOM —— 前一次 4000 次点击的循环就是这么读出一个假"没禁用"的。
	await page.evaluate(`(() => {
		const find = () => [...document.querySelectorAll('#dsh-perf-hud-root button')].find((node) => node.textContent.trim() === '下一帧 ▶');
		for (let i = 0; i < 1200; i += 1) find().click();
		return true;
	})()`);
	await page.sleep(400);
	const atEnd = await page.evaluate(`(() => {
		const find = (text) => [...document.querySelectorAll('#dsh-perf-hud-root button')].find((node) => node.textContent.trim() === text);
		return {
			bar: document.querySelector('#dsh-perf-hud-root [data-ctx-bar="1"]').textContent.trim(),
			nextDisabled: find('下一帧 ▶').disabled,
			prevDisabled: find('◀ 上一帧').disabled,
		};
	})()`);
	check('走到最后一帧后「下一帧」被**禁用**(而不是点了没反应),「上一帧」仍然可用',
		atEnd.nextDisabled === true && atEnd.prevDisabled === false && /\/(\d+)/.test(atEnd.bar) && atEnd.bar.includes(`/${atEnd.bar.match(/\/(\d+)/)[1]}`),
		JSON.stringify(atEnd));

	// 刷新:历史事故与当前帧的选择都要活下来(事故落盘 + 上下文落盘)
	const beforeReload = await contextBar(page);
	await page.reload();
	await page.waitForHud();
	const afterReload = await page.evaluate(`(() => {
		const node = document.querySelector('#dsh-perf-hud-root [data-ctx-bar="1"]');
		return node === null ? document.body.innerText.includes('历史帧时间轴') : node.textContent.trim();
	})()`);
	check('刷新之后仍然停在同一条事故的同一帧上(历史事故活过刷新)',
		typeof afterReload === 'string' && afterReload.includes('历史事故') && afterReload === beforeReload,
		`${JSON.stringify(beforeReload)} → ${JSON.stringify(afterReload)}`);
	check('刷新之后面板依然没有渲染错误', (await errors(page)).length === 0, JSON.stringify(await errors(page)));

	// 切回实时:历史块让位给实时帧条与实时读数
	const back = await clickText(page, '回到实时');
	const liveCtx = await contextBar(page);
	const liveStrip = await page.evaluate(`!!document.querySelector('#dsh-perf-hud-root svg[viewBox="0 0 60 18"]')`);
	const historyGone = await page.evaluate(`document.querySelectorAll('#dsh-perf-hud-root svg[viewBox="0 0 240 24"]').length === 0`);
	check('回到实时:上下文标题变成实时监控 · 当前帧', back === 'clicked' && typeof liveCtx === 'string' && liveCtx.includes('实时监控'), JSON.stringify(liveCtx));
	check('回到实时:60 秒实时帧条回来,历史回放块消失', liveStrip === true && historyGone === true, JSON.stringify({ liveStrip, historyGone }));
	check('全程面板 0 渲染错误', (await errors(page)).length === 0);
});

console.log(failed === 0 ? 'ALL PASS(真页面 · 历史事故逐帧回放)' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
