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
 * `~/Library/Logs/ai.dsh.web.log` 取,见 tools/cdp.mjs 的说明)。它挡的是 AGENTS §8 与
 * docs/dead-ends.md 第 14 条那类事故:文件语法没错、三套件全绿,但插件激活或渲染在浏览器里
 * 失败,面板整块消失。
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

	// ── 面板几何:这三条离线套件看不出来,只有真布局才知道 ────────────────────
	// ① 宽度只有一个来源;② 头部常驻(面板自己不滚,正文才滚);③ 审批卡让位(不许压住批准按钮)。
	const geom = await page.evaluate(`(() => {
		const root = document.getElementById('dsh-perf-hud-root');
		const scroller = [...root.querySelectorAll('*')].find((el) => getComputedStyle(el).overflowY === 'auto');
		return {
			width: Math.round(root.getBoundingClientRect().width),
			overflowY: getComputedStyle(root).overflowY,
			scroller: scroller === undefined ? null : scroller.tagName,
			headInScroller: scroller === undefined ? null : scroller.contains(root.firstElementChild),
		};
	})()`);
	check('展开态宽度 = PANEL_WIDTH(396)', geom.width === 396, JSON.stringify(geom));
	check('面板自己不是滚动容器(头部不会被滚走)', geom.overflowY === 'hidden', String(geom.overflowY));
	check('正文有独立滚动容器,而且头部不在它里面', geom.scroller !== null && geom.headInScroller === false, JSON.stringify(geom));

	// 往正文里塞 2000px 再滚 1500px:头部必须原地不动(以前整块一起滚,「收起 / 关闭」够不着)。
	const stuck = await page.evaluate(`(async () => {
		const root = document.getElementById('dsh-perf-hud-root');
		const scroller = [...root.querySelectorAll('*')].find((el) => getComputedStyle(el).overflowY === 'auto');
		const head = root.firstElementChild;
		const before = head.getBoundingClientRect().top;
		const tall = document.createElement('div');
		tall.style.height = '2000px';
		scroller.appendChild(tall);
		scroller.scrollTop = 1500;
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		const out = { before: Math.round(before), after: Math.round(head.getBoundingClientRect().top), scrolled: Math.round(scroller.scrollTop) };
		tall.remove();
		return out;
	})()`);
	check('正文滚 1500px 时头部原地不动', stuck.scrolled > 1000 && stuck.before === stuck.after, JSON.stringify(stuck));

	// 插一张假审批卡(外壳那侧的真约定是 `data-approval-key`,类名是构建期哈希、不能用):
	// 面板必须让到卡片上方;拿掉之后再回到右下角。渲染是"显示值变了"+ 兜底 2 秒一次,所以轮询等。
	const dodge = await page.evaluate(`(async () => {
		const root = document.getElementById('dsh-perf-hud-root');
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const stub = document.createElement('div');
		stub.setAttribute('data-approval-key', 'approval:check');
		stub.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:231px;background:rgba(0,0,0,.4);z-index:59';
		document.body.appendChild(stub);
		const cardTop = Math.round(stub.getBoundingClientRect().top);
		let dodged = null;
		for (let i = 0; i < 12 && dodged === null; i += 1) {
			await wait(500);
			const rect = root.getBoundingClientRect();
			if (rect.bottom <= cardTop + 1) dodged = Math.round(rect.bottom);
		}
		const during = Math.round(root.getBoundingClientRect().bottom);
		stub.remove();
		let restored = null;
		for (let i = 0; i < 12 && restored === null; i += 1) {
			await wait(500);
			if (Math.abs(root.getBoundingClientRect().bottom - (innerHeight - 12)) <= 1) restored = Math.round(root.getBoundingClientRect().bottom);
		}
		return { cardTop, dodged, during, restored, viewport: innerHeight };
	})()`);
	check('审批卡出现 → 面板让到卡片上方(不压批准按钮)', dodge.dodged !== null, JSON.stringify(dodge));
	check('审批卡消失 → 面板回到右下角', dodge.restored !== null, JSON.stringify(dodge));

	// 只求值一次:**布尔**当断言(`false` 即失败),其它类型当诊断读数(打印出来,不影响通过)
	const value = await page.evaluate(`(() => { try { return (${expression}); } catch (error) { return 'expr-threw: ' + error.message; } })()`);
	const threw = typeof value === 'string' && value.startsWith('expr-threw: ');
	const ok = threw === false && (typeof value === 'boolean' ? value === true : true);
	check(`断言通过:${expression.slice(0, 72)}`, ok, threw === true ? value : (typeof value === 'boolean' ? JSON.stringify(value) : ''));
	if (typeof value !== 'boolean') console.log(`     读数 ${JSON.stringify(value)}`);
});

console.log(failed === 0 ? 'ALL PASS(真页面)' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
