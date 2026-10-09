/**
 * 验证**交互延迟真的被采到**(A4 的页面内那一半:`event` timing)。
 *
 *   node tools/check-interaction.mjs
 *
 * 为什么不能只靠单元测试:合成的 `element.click()` **不算** —— Event Timing 只交付可信事件,
 * 所以离线/合成点击跑出来恒为 0 条,会让人以为"这一路坏了"。这里用 CDP 的 `Input` 域发**真实**
 * 鼠标点击与按键,再读 `snapshot().interactions`。
 *
 * 做法:① 页面里挂一个故意烧 160ms 的 click 监听 ② CDP 发真实输入 ③ 断言
 * `state === 'on'`、`events > 0`、每条记录带 `ms` / `waitMs` / `handlerMs` / `isInteraction`。
 * 顺带说明为什么"端到端长 ≠ 页面反应慢":`ms` 是到下一次渲染更新为止,`handlerMs` 才是处理器本身。
 *
 * 这不是离线门禁(要真浏览器 + 本机 `dsh web`;headless 下 `element` timing 恒为 0,那是正常的,
 * DSH 的 DOM 上没有 `elementtiming` 属性)。
 */
import { withPage } from './cdp.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
	const hit = argv.find((row) => row.startsWith(`--${name}=`));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
};

let failed = 0;
const check = (name, ok, detail = '') => {
	if (ok !== true) failed += 1;
	console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  ${detail}`}`);
};

await withPage({ port: Number(opt('port', '9372')), url: opt('url', undefined), keep: argv.includes('--keep') }, async (page) => {
	await page.waitForHud();
	// ① 挂一个慢监听:这样"处理器本身"是几百毫秒量级,读数一眼能验
	await page.evaluate(`(() => {
		const burn = () => { const until = performance.now() + 160; while (performance.now() < until) { /* 故意的 */ } };
		document.addEventListener('click', burn, true);
		return true;
	})()`);
	await page.sleep(400);

	// ② 真实输入(CDP 的 Input 域发的是 trusted 事件)
	for (const type of ['mousePressed', 'mouseReleased']) {
		await page.send('Input.dispatchMouseEvent', { type, x: 300, y: 300, button: 'left', clickCount: 1 });
	}
	await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
	await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
	await page.sleep(1500);

	// ③ 读回执
	const state = await page.evaluate(`window.__perfHud.watch().interactions`);
	check("观察器装上了(state === 'on')", state?.state === 'on', String(state?.state));
	check('采集到了可信交互事件(合成事件会被 Chrome 忽略,所以必须走 CDP 真实输入)', state?.events > 0, `events=${state?.events}`);

	const sample = await page.evaluate(`window.__perfHud.snapshot().interactions.records.slice(-1)[0] ?? null`);
	const fields = ['ms', 'waitMs', 'handlerMs', 'isInteraction'];
	check(`每条记录带 ${fields.join(' / ')}`, sample !== null && fields.every((key) => key in sample), JSON.stringify(sample));

	const errors = await page.evaluate(`window.__perfHud.snapshot().errors.length`);
	check('面板渲染 0 错误', errors === 0, String(errors));

	if (sample !== null) {
		console.log(`读数说明:${sample.name} 端到端 ${sample.ms}ms = 输入延迟 ${sample.waitMs}ms + 处理器 ${sample.handlerMs}ms —— 端到端长 ≠ 页面反应慢`);
	}
});

console.log(failed === 0 ? 'ALL PASS(真页面)' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
