/**
 * 生成 README 用的界面截图(方案 1 的四屏 + 五个标签页 + 折叠药丸)。
 *
 *   node tools/shots.mjs                 # 写进 docs/images/
 *   node tools/shots.mjs --port=9341     # 换一个调试端口(默认 9340)
 *
 * 为什么要脚本而不是手截:面板的每一屏都由 `localStorage` 里的视图 / 标签页 / 折叠状态决定,
 * 手点容易漏一屏、也容易混进"上一次留下的状态";脚本每张图都**先把状态写死再刷新**,
 * 所以图与代码里的那一屏是一一对应的,重跑一遍就能全量更新。
 *
 * ⚠️ 与 `tools/check-*.mjs` 一样:**不是离线门禁**(要真浏览器 + 本机跑着 `dsh web`)。
 * ⚠️ 被强杀的验收器会留下 headless Chrome 占着 profile 与端口,让后续跑**挂死** ——
 *    先 `pkill -f 'remote-debugging-port=93'`,再 `rm -rf /tmp/dsh-perf-hud-chrome-*`(见 docs/verification.md 的残留 Chrome 处置)。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { withPage } from './cdp.mjs';

const argv = process.argv.slice(2);
const port = Number((argv.find((row) => row.startsWith('--port=')) ?? '--port=9340').slice(7));
const OUT = new URL('../docs/images/', import.meta.url);

const shot = async (page, file) => {
	// 别的浮动插件(比如待办面板)会盖在 HUD 上面 —— 截图裁的是 HUD 的矩形,拍到的却是它们。
	// 截图前把已知的其它浮层藏掉(只影响这次截图会话,不改任何插件状态)。
	await page.evaluate(`(() => {
		for (const node of document.querySelectorAll('.dshtb-root')) node.style.display = 'none';
		return true;
	})()`);
	const rect = await page.evaluate(`(() => {
		const node = document.getElementById('dsh-perf-hud-root');
		if (node === null) return null;
		const box = node.getBoundingClientRect();
		return { x: box.x, y: box.y, width: box.width, height: box.height };
	})()`);
	if (rect === null || rect.width < 40) throw new Error(`${file}:面板没渲染出来(width=${rect === null ? 'null' : rect.width})`);
	// 只按面板自己的矩形裁(2x 缩放让 README 里看得清)。**不要往外扩**:药丸/面板都是右对齐的浮层,
	// 往外扩 8px 就会把页面正文切进来(实测图上出现过半个词)。
	const clip = { x: Math.max(0, Math.floor(rect.x)), y: Math.max(0, Math.floor(rect.y)),
		width: Math.ceil(rect.width), height: Math.ceil(rect.height), scale: 2 };
	const result = await page.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
	writeFileSync(new URL(file, OUT), Buffer.from(result.data, 'base64'));
	const kb = Math.round(Buffer.from(result.data, 'base64').length / 1024);
	console.log(`ok  ${file}  ${Math.round(rect.width)}×${Math.round(rect.height)} @2x  ${kb}KB`);
};

// 每张图先写死状态再刷新 —— 状态写不进"读数",只写视图 / 标签页 / 折叠(见 client.js 的 LS_VIEW)
// ⚠️ `dsh-perf-hud:on` 也要写死:它落盘在**同一个 Chrome profile** 里(`/tmp/dsh-perf-hud-chrome-<port>`),
// 上一次跑(或真人在那个 profile 里点过「关闭」)留下的 `'0'` 会让面板根本不挂 HUD,先炸的是造样本那一步
// —— 实测踩过:报的是"没抓到事故",真因是 `capture()` 回 `not-recording(HUD 关闭时不记录)`。
const setState = (page, view, tab, collapsed) => page.evaluate(`(() => {
	localStorage.setItem('dsh-perf-hud:on', '1');
	localStorage.setItem('dsh-perf-hud:collapsed', ${JSON.stringify(collapsed ? '1' : '0')});
	localStorage.setItem('dsh-perf-hud:view:v1', JSON.stringify({ v: 1, view: ${JSON.stringify(view)}, devTab: ${JSON.stringify(tab ?? 'frames')}, trendMs: 3600000 }));
	return true;
})()`);

await withPage({ port, url: undefined }, async (page) => {
	mkdirSync(OUT, { recursive: true });
	await page.waitForHud();
	// 先把"总开关"打开并走一次刷新:采集没开的话下面造样本那一步必然失败(而且报的是别的错)。
	await page.evaluate(`(() => { localStorage.setItem('dsh-perf-hud:on', '1'); return true; })()`);
	await page.reload();
	await page.waitForHud();

	// 先造一条**带备注**的真实事故:否则"卡顿详情"与"最差事件"两屏是空的。
	// ⚠️ 先把页面里已有的事故清掉(`clearIncidents()`,不动计数桶):一是 README 的图里不该出现
	// 使用者真实会话留下的证据(id / 时刻 / 备注),二是手动标记的 severity 是 0,留存清单(最差 10 +
	// 每天最差 1)里只要已有 8~10 条真实卡顿,这条标记会被**挤掉**、截图样本就不成立。
	// ⚠️ 与 check-counts 同一个坑:等 `pending === null` 就立刻 capture,等待期间守夜可能又触发一次,
	// 标记被并进 pending、备注就丢了(样本不带备注,截图里那一行是空的)。所以看 `capture()` 的
	// 返回值重试,并按 `capture().incident.id` 取回**刚标记那条**(不是"谁有备注就取谁")。
	await page.evaluate(`window.__perfHud.clearIncidents()`);
	const incident = await page.evaluate(`(async () => {
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		for (let attempt = 0; attempt < 60; attempt += 1) {
			// 先等自动捕获的后摇结束;每次尝试前清一次留存清单(severity=0 的手动标记会被挤掉)。
			if (window.__perfHud.watch().pending !== null) {
				await sleep(500);
				continue;
			}
			window.__perfHud.clearIncidents();
			const result = window.__perfHud.capture('截图样本:主界面卡了一下 token=demo-not-a-real-token');
			if (result !== null && result !== undefined && result.ok === true && result.incident !== null && result.incident !== undefined) {
				await sleep(300);
				const list = window.__perfHud.incidents();
				const row = list.find((item) => item.id === result.incident.id) ?? null;
				if (row !== null) return { id: row.id, n: list.length, note: row.note !== null && row.note !== undefined };
			}
			await sleep(500);
		}
		return null;
	})()`);
	if (incident === null) throw new Error('没抓到事故 —— 截图样本不成立');
	if (incident.note !== true) throw new Error('样本没带上备注 —— 截图里的备注那一行会是空的');
	console.log(`样本:${incident.n} 条事故,取 ${incident.id}`);

	const frames = [
		['01-main.png', 'main', null, false],
		['02-dev-frames.png', 'dev', 'frames', false],
		['03-dev-dom.png', 'dev', 'dom', false],
		['04-dev-host.png', 'dev', 'host', false],
		['05-dev-tools.png', 'dev', 'tools', false],
		['06-dev-raw.png', 'dev', 'raw', false],
		['07-settings.png', 'settings', null, false],
	];
	for (const [file, view, tab, collapsed] of frames) {
		await setState(page, view, tab, collapsed);
		await page.reload();
		await page.waitForHud();
		await page.sleep(1200);   // 让 fps / 计数那一行有真数(不是 0.0)
		await shot(page, file);
	}

	// 卡顿详情:必须真的进历史上下文(光写 view 不够 —— mode 不是 incident 时会退回主界面)
	await page.evaluate(`(() => {
		localStorage.setItem('dsh-perf-hud:watchui:v1', JSON.stringify({ v: 1, mode: 'incident', selId: ${JSON.stringify(incident.id)}, frameT: null, scope: 'worst' }));
		localStorage.setItem('dsh-perf-hud:collapsed', '0');
		localStorage.setItem('dsh-perf-hud:view:v1', JSON.stringify({ v: 1, view: 'incident', devTab: 'frames', trendMs: 3600000 }));
		return true;
	})()`);
	await page.reload();
	await page.waitForHud();
	await page.sleep(1200);
	await shot(page, '08-incident.png');

	// 折叠药丸(日常那一颗)
	await setState(page, 'main', null, true);
	await page.reload();
	await page.waitForHud();
	await page.sleep(1200);
	await shot(page, '09-pill.png');
});

console.log('ALL DONE(docs/images/)');
