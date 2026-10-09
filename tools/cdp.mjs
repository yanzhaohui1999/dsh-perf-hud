/**
 * 真实页面的验证底座:起一个 headless Chrome,用 CDP 直连把 DSH 页面交给调用方。
 *
 * 为什么需要它:离线三套件只抽纯函数,**不跑 `apply()` / `start()` / 渲染**。所以"改完面板
 * 路径要真打开一次页面"这条规矩(AGENTS §8 第 14 条)得有个可复用的实现,而不是每次手写一段 CDP。
 *
 * 它**不是离线门禁**:需要本机跑着 `dsh web`(默认 `127.0.0.1:3080`)、装着 Chrome。`npm test`
 * 里没有它,CI 里也没有 —— 用它的是 `tools/check-*.mjs`。
 *
 * 零依赖:用 Node 内置的 `fetch` 与 `WebSocket`(Node ≥22),CDP 消息自己拼。
 * token 从宿主启动日志 `~/Library/Logs/ai.dsh.web.log` 里取最后一枚(每次重启都会换)。
 *
 * 环境变量:`CHROME_PATH` 覆盖 Chrome 路径(默认 macOS 的 `/Applications/...`)。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LOG = `${homedir()}/Library/Logs/ai.dsh.web.log`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 宿主启动日志里最后一枚 token(取不到就抛,别猜)。 */
export function tokenFromLog() {
	const text = readFileSync(LOG, 'utf8');
	const found = text.match(/token=([A-Za-z0-9_-]+)/g);
	if (found === null) throw new Error(`从 ${LOG} 里没找到 token=(宿主起来过吗?)`);
	return found[found.length - 1].slice('token='.length);
}

/**
 * 打开页面并跑 `run(page)`;跑完关掉 Chrome(除非 `keep` 为 true)。
 * `page` 上可用的东西:
 *   evaluate(表达式) —— 在页面里求值(returnByValue + awaitPromise)
 *   send(方法, 参数) —— 任意 CDP 命令(例如 Input.dispatchMouseEvent)
 *   reload()          —— 重新加载并把 HUD 等回来(验"活过刷新"用)
 *   waitForHud()      —— 等 `window.__perfHud` 挂上且面板渲染出来
 */
export async function withPage(options, run) {
	const port = options.port ?? 9333;
	const token = options.token ?? tokenFromLog();
	const url = options.url ?? `http://127.0.0.1:3080/?token=${token}`;
	const profile = options.profile ?? `/tmp/dsh-perf-hud-chrome-${port}`;
	const chrome = spawn(CHROME, [
		'--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
		'--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox',
		'--window-size=1400,900', url,
	], { stdio: 'ignore' });

	const kill = () => { try { chrome.kill('SIGKILL'); } catch { /* 已经没了 */ } };
	try {
		let target = null;
		for (let i = 0; i < 120 && target === null; i += 1) {
			await sleep(250);
			try {
				const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
				target = list.find((row) => row.type === 'page' && typeof row.webSocketDebuggerUrl === 'string') ?? null;
			} catch { /* 还没起来 */ }
		}
		if (target === null) throw new Error(`Chrome 没起来(端口 ${port};用 CHROME_PATH 换个浏览器?)`);

		const ws = new WebSocket(target.webSocketDebuggerUrl);
		let nextId = 1;
		const pending = new Map();
		ws.addEventListener('message', (event) => {
			const message = JSON.parse(event.data);
			const slot = pending.get(message.id);
			if (slot === undefined) return;
			pending.delete(message.id);
			slot(message);
		});
		const send = (method, params = {}) => new Promise((resolve, reject) => {
			const id = nextId++;
			const timer = setTimeout(() => reject(new Error(`CDP 超时:${method}`)), 40000);
			pending.set(id, (message) => {
				clearTimeout(timer);
				if (message.error === undefined) resolve(message.result);
				else reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
			});
			ws.send(JSON.stringify({ id, method, params }));
		});
		await new Promise((resolve, reject) => {
			ws.addEventListener('open', resolve);
			ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连不上')));
		});
		await send('Runtime.enable');
		await send('Page.enable');

		const evaluate = async (expression) => {
			const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
			if (out.exceptionDetails !== undefined) {
				throw new Error(`页面里抛错:${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`);
			}
			return out.result.value;
		};
		/** 等 HUD 挂上、面板渲染出来(首次加载要跑完 web boot)。 */
		const waitForHud = async (tries = 60) => {
			for (let i = 0; i < tries; i += 1) {
				await sleep(500);
				try {
					const ready = await evaluate(`typeof window.__perfHud !== 'undefined' && document.body.innerText.includes('性能 HUD')`);
					if (ready === true) return true;
				} catch { /* 文档还在换 */ }
			}
			throw new Error(`${tries * 0.5} 秒内没看到 HUD 面板:boot 失败,或槽位条目被外壳停用`);
		};
		const reload = async () => { await send('Page.reload', { ignoreCache: false }); await sleep(1500); await waitForHud(); };

		return await run({ evaluate, send, reload, waitForHud, port, url, sleep });
	} finally {
		if (options.keep !== true) kill();
	}
}
