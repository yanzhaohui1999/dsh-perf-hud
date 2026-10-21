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

	/**
	 * 让标题栏真的可点。别的插件可能挂一层 `position: fixed` + 高 z-index 的浮层盖在上面
	 * (实测 `dsh-tablet` 的 `dshtb-root` 是 2147482000,叠在 HUD 的 60 之上)—— 那时 CDP 的鼠标
	 * 事件全落在那一层上,拖动断言会以"位置没变"失败,而代码其实是对的。这里只临时隐藏**命中点上方
	 * 的 fixed 高 z 层**,打完标签(而不是静默跳过),属主元素在 reload 后自然回来。
	 */
	const unhideOccluders = async () => {
		await page.evaluate(`(() => { for (const el of document.querySelectorAll('[data-dsh-check-hidden]')) { el.style.removeProperty('display'); delete el.dataset.dshCheckHidden; } })()`);
	};
	const ensureClickable = async (label) => {
		const hidden = await page.evaluate(`(() => {
			const root = document.getElementById('dsh-perf-hud-root');
			if (root === null) return [];
			const rect = root.firstElementChild.getBoundingClientRect();
			const x = Math.round(rect.left + 24);
			const y = Math.round(rect.top + rect.height / 2);
			const hit = document.elementFromPoint(x, y);
			if (hit === null || root.contains(hit)) return [];
			const hidden = [];
			for (const el of document.elementsFromPoint(x, y)) {
				if (root.contains(el)) break;
				if (el === document.body || el === document.documentElement) continue;
				const style = getComputedStyle(el);
				if (style.position !== 'fixed' || Number(style.zIndex) <= 60) continue;
				el.dataset.dshCheckHidden = '1';
				el.style.display = 'none';
				hidden.push(String(el.className).slice(0, 40) || el.tagName);
			}
			return hidden;
		})()`);
		if (hidden.length > 0) console.log(`     (${label})标题栏被别的浮层挡住,已临时隐藏:${hidden.join(', ')}`);
	};
	await ensureClickable('起跑');

	// 位置落盘是这次新加的键:上一次手动拖过会留下它,而"停过自定义位置"会让后面的审批卡让位
	// 那条断言失效(让位只对默认位置生效)。所以先清掉再刷新,给整条验收一个干净起点。
	const hadPos = await page.evaluate(`(() => { try { const value = localStorage.getItem('dsh-perf-hud:pos:v1'); if (value !== null) localStorage.removeItem('dsh-perf-hud:pos:v1'); return value !== null; } catch (error) { return false; } })()`);
	if (hadPos === true) {
		await page.reload();
		await page.waitForHud();
	}

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
	// ⚠️ 先等面板长到 maxHeight 封顶再记起点:根节点没有 height,塞进高内容时它会先长高
	// (底边固定 → 头部上移),那不是"滚走"。要验的是**滚轮**能不能把头部带走。
	const stuck = await page.evaluate(`(async () => {
		const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		const root = document.getElementById('dsh-perf-hud-root');
		const scroller = [...root.querySelectorAll('*')].find((el) => getComputedStyle(el).overflowY === 'auto');
		const head = root.firstElementChild;
		const tall = document.createElement('div');
		tall.style.height = '2000px';
		scroller.appendChild(tall);
		await frame();
		const before = Math.round(head.getBoundingClientRect().top);
		scroller.scrollTop = 1500;
		await frame();
		const after = Math.round(head.getBoundingClientRect().top);
		const out = { before, after, scrolled: Math.round(scroller.scrollTop), rootH: Math.round(root.getBoundingClientRect().height) };
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

	// ── 拖动标题栏:跟手 / 越界夹住 / 落盘 / 刷新恢复 / 双击复位 ─────────────────
	// 这里只能真发鼠标事件:拖动走的是 pointerdown + window 级 pointermove,离线套件测不到
	// "按钮还能不能点""React 会不会在拖动中把位置写回去"这类只在该路径发生的事。
	await ensureClickable('拖动');
	const headRect = await page.evaluate(`(() => {
		const root = document.getElementById('dsh-perf-hud-root');
		const rect = root.firstElementChild.getBoundingClientRect();
		return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
	})()`);
	const from = { x: headRect.left + 24, y: headRect.top + 8 };
	const to = { x: from.x - 300, y: from.y - 120 };
	await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 });
	await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
	for (let step = 1; step <= 6; step += 1) {
		const x = Math.round(from.x + (to.x - from.x) * (step / 6));
		const y = Math.round(from.y + (to.y - from.y) * (step / 6));
		await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
	}
	await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
	await new Promise((resolve) => setTimeout(resolve, 400));
	const moved = await page.evaluate(`(() => {
		const root = document.getElementById('dsh-perf-hud-root');
		const rect = root.getBoundingClientRect();
		return { left: Math.round(rect.left), top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width),
			stored: localStorage.getItem('dsh-perf-hud:pos:v1'), viewport: innerWidth, viewportH: innerHeight };
	})()`);
	check('拖动标题栏:面板跟手往左上移动,而且不越界', moved.left <= headRect.left - 200 && moved.left >= 12 && moved.bottom <= moved.viewportH && moved.bottom >= 12, JSON.stringify(moved));
	check('拖动之后位置落盘(没有在松手时被 React 写回去)', moved.stored !== null, String(moved.stored));
	await page.reload();
	await page.waitForHud();
	const restored = await page.evaluate(`(() => {
		const root = document.getElementById('dsh-perf-hud-root');
		const rect = root.getBoundingClientRect();
		return { left: Math.round(rect.left), top: Math.round(rect.top), bottom: Math.round(rect.bottom),
			gap: Math.round(innerHeight - rect.bottom), rightGap: Math.round(innerWidth - rect.right), viewportH: innerHeight };
	})()`);
	const saved = moved.stored === null ? null : JSON.parse(moved.stored);
	// 锚点是左下角:键里的 bottom 是"距视口底多少",刷新之后要能对得上
	// (底边钉住 = 展开仍然是向上长,而不是从标题栏往下长)
	// 水平锚点可能是 left 或 right(贴哪边近记哪边),两种都要对得上
	const horizontalOk = saved !== null && (saved.left !== undefined
		? Math.abs(restored.left - saved.left) <= 1
		: Math.abs(restored.rightGap - saved.right) <= 1);
	check('刷新之后回到拖过的那一格(水平锚点 / 距底 bottom 都对得上,高度仍夹在视口内)',
		horizontalOk && saved !== null && Math.abs(restored.gap - saved.bottom) <= 1 && restored.bottom <= restored.viewportH,
		JSON.stringify({ restored, saved }));
	// 用户在意的正是这一条:**展开时向上长**(底边不动),而不是从标题栏往下掉。
	// 点两次折叠/展开,底边必须回到原处(±1),否则就是锚点换方向了。
	const flip = await page.evaluate(`(async () => {
		const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const bottomOf = () => Math.round(document.getElementById('dsh-perf-hud-root').getBoundingClientRect().bottom);
		const clickBy = (label) => {
			const root = document.getElementById('dsh-perf-hud-root');
			const button = [...root.querySelectorAll('button')].find((node) => node.textContent === label);
			if (button === undefined) throw new Error('没找到按钮 ' + label);
			button.click();
		};
		const expanded = bottomOf();
		clickBy('–');
		await wait(600);
		const collapsed = bottomOf();
		clickBy('+');
		await wait(600);
		const reopened = bottomOf();
		return { expanded, collapsed, reopened };
	})()`);
	check('展开 / 收起都钉住底边(展开是向上长,不是从标题栏往下掉)',
		Math.abs(flip.collapsed - flip.expanded) <= 1 && Math.abs(flip.reopened - flip.expanded) <= 1,
		JSON.stringify(flip));
	// 双击标题栏 = 回默认右下角(与「恢复默认布局」同一个动作),键一起删掉。
	// ⚠️ 坐标要用**标题栏自己**的 rect:根节点有 10px 上内边距,按根的 top+8 点下去落在内边距上,
	// 拖动/双击都不会触发(第一次真跑就是这么"失败"的)。
	const headAfter = await page.evaluate(`(() => {
		const rect = document.getElementById('dsh-perf-hud-root').firstElementChild.getBoundingClientRect();
		return { x: Math.round(rect.left + 24), y: Math.round(rect.top + rect.height / 2) };
	})()`);
	await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: headAfter.x, y: headAfter.y, button: 'left', buttons: 1, clickCount: 1 });
	await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: headAfter.x, y: headAfter.y, button: 'left', buttons: 0, clickCount: 1 });
	await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: headAfter.x, y: headAfter.y, button: 'left', buttons: 1, clickCount: 2 });
	await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: headAfter.x, y: headAfter.y, button: 'left', buttons: 0, clickCount: 2 });
	await new Promise((resolve) => setTimeout(resolve, 400));
	const reset = await page.evaluate(`(() => {
		const root = document.getElementById('dsh-perf-hud-root');
		const rect = root.getBoundingClientRect();
		return { left: Math.round(rect.left), bottom: Math.round(rect.bottom), stored: localStorage.getItem('dsh-perf-hud:pos:v1'), viewport: innerWidth, viewportH: innerHeight,
			expectedLeft: Math.round(innerWidth - 12 - rect.width) };
	})()`);
	check('双击标题栏 → 回到右下角,位置键被删掉', reset.stored === null && Math.abs(reset.left - reset.expectedLeft) <= 1 && Math.abs(reset.bottom - (reset.viewportH - 12)) <= 1, JSON.stringify(reset));

	// ── 关闭后的胶囊:必须能贴到最右边,而且打开成药丸时右边缘不动 ─────────────────
	// 胶囊只有 ~168px、展开态 396px。左锚时按 panelWidth 夹,胶囊右边会永远空着一截死区;
	// 现在松手按"贴哪边近"记锚点,贴右就记 right。
	await page.evaluate(`(() => {
		localStorage.setItem('dsh-perf-hud:on', '0');
		localStorage.setItem('dsh-perf-hud:collapsed', '1');
		localStorage.removeItem('dsh-perf-hud:pos:v1');
	})()`);
	await page.reload();
	await page.waitForHud();
	await new Promise((resolve) => setTimeout(resolve, 400));
	await ensureClickable('胶囊');
	const chip = await page.evaluate(`(() => {
		const root = document.getElementById('dsh-perf-hud-root');
		const head = root.firstElementChild.getBoundingClientRect();
		const rect = root.getBoundingClientRect();
		return { x: Math.round(head.left + head.width / 2), y: Math.round(head.top + head.height / 2),
			width: Math.round(rect.width), left: Math.round(rect.left), right: Math.round(innerWidth - rect.right) };
	})()`);
	// 往右下角拖:目标点 = 视口右下角外面一点,靠夹紧把它顶到边上
	await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: chip.x, y: chip.y, button: 'left', buttons: 1, clickCount: 1 });
	for (let step = 1; step <= 6; step += 1) {
		await page.send('Input.dispatchMouseEvent', {
			type: 'mouseMoved', x: chip.x + step * 120, y: chip.y + step * 20, button: 'left', buttons: 1,
		});
	}
	await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: chip.x + 720, y: chip.y + 120, button: 'left', buttons: 0, clickCount: 1 });
	await new Promise((resolve) => setTimeout(resolve, 400));
	const chipPlaced = await page.evaluate(`(() => {
		const rect = document.getElementById('dsh-perf-hud-root').getBoundingClientRect();
		return { left: Math.round(rect.left), right: Math.round(innerWidth - rect.right), width: Math.round(rect.width),
			stored: localStorage.getItem('dsh-perf-hud:pos:v1') };
	})()`);
	check('关闭后的胶囊能拖到最右边(右间距 = 12,而不是按 396 卡住)',
		chipPlaced.right <= 13 && chipPlaced.stored !== null && JSON.parse(chipPlaced.stored).right !== undefined,
		JSON.stringify({ chip, chipPlaced }));
	// 打开:药丸比胶囊宽一倍多,右边缘必须还贴着右边(向左长),不许越界
	await page.evaluate(`(() => { localStorage.setItem('dsh-perf-hud:on', '1'); localStorage.setItem('dsh-perf-hud:collapsed', '1'); })()`);
	await page.reload();
	await page.waitForHud();
	await new Promise((resolve) => setTimeout(resolve, 500));
	const chipOpened = await page.evaluate(`(() => {
		const rect = document.getElementById('dsh-perf-hud-root').getBoundingClientRect();
		return { left: Math.round(rect.left), right: Math.round(innerWidth - rect.right), width: Math.round(rect.width), viewport: innerWidth };
	})()`);
	check('胶囊打开成药丸:右边缘不动(向左长),而且不越界',
		chipOpened.right <= 13 && chipOpened.left >= 12 && chipOpened.width > chipPlaced.width,
		JSON.stringify(chipOpened));
	await page.evaluate(`(() => { try { localStorage.removeItem('dsh-perf-hud:pos:v1'); localStorage.setItem('dsh-perf-hud:on', '1'); } catch (error) { /* 隐私模式之类 */ } })()`);

	// 窄屏(手机 / 分栏):定宽 396 会溢出去(实测 393px 视口:left = −15,标题被切掉一截),
	// 现在宽度走 panelWidthFor → "视口 − 两边各 12"。用 CDP 的设备模拟把视口压到 393×851。
	await page.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 851, deviceScaleFactor: 3, mobile: true });
	await new Promise((resolve) => setTimeout(resolve, 1200));
	await page.evaluate(`(() => { try { localStorage.setItem('dsh-perf-hud:collapsed', '0'); localStorage.setItem('dsh-perf-hud:on', '1'); } catch (error) { /* 隐私模式之类 */ } })()`);
	await page.reload();
	await new Promise((resolve) => setTimeout(resolve, 800));
	const narrow = await page.evaluate(`(() => {
		const root = document.getElementById('dsh-perf-hud-root');
		const rect = root.getBoundingClientRect();
		return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), viewport: innerWidth };
	})()`);
	check('393px 视口:面板不越界(左 ≥ 0、右 ≤ 视口)', narrow.left >= 0 && narrow.right <= narrow.viewport, JSON.stringify(narrow));
	check('393px 视口:面板宽度 = 视口 − 24', narrow.width === narrow.viewport - 24, JSON.stringify(narrow));
	await page.send('Emulation.clearDeviceMetricsOverride');

	// 只求值一次:**布尔**当断言(`false` 即失败),其它类型当诊断读数(打印出来,不影响通过)
	const value = await page.evaluate(`(() => { try { return (${expression}); } catch (error) { return 'expr-threw: ' + error.message; } })()`);
	const threw = typeof value === 'string' && value.startsWith('expr-threw: ');
	const ok = threw === false && (typeof value === 'boolean' ? value === true : true);
	check(`断言通过:${expression.slice(0, 72)}`, ok, threw === true ? value : (typeof value === 'boolean' ? JSON.stringify(value) : ''));
	if (typeof value !== 'boolean') console.log(`     读数 ${JSON.stringify(value)}`);
	await unhideOccluders();
});

console.log(failed === 0 ? 'ALL PASS(真页面)' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
