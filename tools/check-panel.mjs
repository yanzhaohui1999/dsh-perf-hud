/**
 * 改完**面板渲染 / `start()` / `apply()` 路径**之后跑这条:真开一次 DSH 页面,断言
 * 「HUD 挂上 + 面板渲染 0 错误 + 你指定的元素/条件确实在场」。
 *
 *   node tools/check-panel.mjs                                    # 默认:面板标题在 DOM 里
 *   node tools/check-panel.mjs --expr="!!document.querySelector('svg[viewBox=\"0 0 60 18\"]')"
 *
 * 参数:`--expr=<js>`(布尔表达式,`false` 即失败)、`--url=`、`--port=`、`--keep`(留着 Chrome 看现场)。
 *
 * 这不是离线门禁:`npm test` / CI 里没有它 —— 它要真浏览器 + 本机跑着 `dsh web`(token 从
 * `~/Library/Logs/ai.dsh.web.log` 取,见 tools/cdp.mjs 的说明)。它挡的是 AGENTS §8 第 14 条那类
 * 事故:文件语法没错、三套件全绿,但插件激活或渲染在浏览器里失败,面板整块消失。
 */
import { withPage } from './cdp.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
	const hit = argv.find((row) => row.startsWith(`--${name}=`));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const expression = opt('expr', `document.body.innerText.includes('性能 HUD')`);

let failed = 0;
const check = (name, ok, detail = '') => {
	if (ok !== true) failed += 1;
	console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  ${detail}`}`);
};

await withPage({ port: Number(opt('port', '9370')), url: opt('url', undefined), keep: argv.includes('--keep') }, async (page) => {
	await page.waitForHud();
	check('HUD 挂上且面板渲染出来', true);

	const errors = await page.evaluate(`window.__perfHud.snapshot().errors`);
	check('面板渲染 0 错误(HudBoundary 没兜到东西)', Array.isArray(errors) && errors.length === 0, JSON.stringify(errors ?? null));

	// macOS / Windows 的快捷键:真的发一次物理键,断言折叠态翻转,再翻回来。
	// Linux Web 平台白名单不允许这个组合,不在这里测(客户端也没绑)。
	if (process.platform === 'darwin' || process.platform === 'win32') {
		const modifiers = process.platform === 'darwin' ? 12 : 10;   // meta+shift / ctrl+shift
		const press = async () => {
			await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, nativeVirtualKeyCode: 85, modifiers });
			await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, nativeVirtualKeyCode: 85, modifiers });
			await new Promise((resolve) => setTimeout(resolve, 250));
		};
		const collapsed = () => page.evaluate(`localStorage.getItem('dsh-perf-hud:collapsed') === '1'`);
		const before = await collapsed();
		await press();
		const toggled = await collapsed();
		check('快捷键 Cmd/Ctrl+Shift+U 切换折叠态', toggled !== before, JSON.stringify({ before, toggled }));
		await press();
		const back = await collapsed();
		check('快捷键再按一次回到原状态', back === before, JSON.stringify({ before, back }));
	}

	// 只求值一次:**布尔**当断言(`false` 即失败),其它类型当诊断读数(打印出来,不影响通过)
	const value = await page.evaluate(`(() => { try { return (${expression}); } catch (error) { return 'expr-threw: ' + error.message; } })()`);
	const threw = typeof value === 'string' && value.startsWith('expr-threw: ');
	const ok = threw === false && (typeof value === 'boolean' ? value === true : true);
	check(`断言通过:${expression.slice(0, 72)}`, ok, threw === true ? value : (typeof value === 'boolean' ? JSON.stringify(value) : ''));
	if (typeof value !== 'boolean') console.log(`     读数 ${JSON.stringify(value)}`);
});

console.log(failed === 0 ? 'ALL PASS(真页面)' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
