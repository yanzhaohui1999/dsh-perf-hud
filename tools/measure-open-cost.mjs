#!/usr/bin/env node
/**
 * measure-open-cost.mjs —— 会话体积 → 打开耗时曲线(A3,1.0 附录)
 *
 * 它回答一个问题:**同一个宿主上,打开一个会话到「首帧正文」要多久,时间花在哪**。
 * 用 `tools/cdp.mjs` 起一个**独立的 headless Chrome**(自己的 `--user-data-dir`,
 * 端口默认 9361),不碰用户正在用的页面:
 *
 *   1. 把它自己的 localStorage 预置成「当前会话 = 本工作区里一个很小的会话」,
 *      刷新页面 —— 应用启动后落在这个工作区;
 *   2. 在侧栏里点开目标会话(CDP 发真实鼠标事件),从 click 事件开始计时;
 *   3. 记录三段:基线 JSON 解析、侧栏重渲染活动、以及「点击 → 首帧正文」总耗时。
 *
 * 会话只读:不新建、不删除、不改内容。两道默认守卫:
 *   ① 会话必须有 `session.v4.jsonl.zstd` —— 否则宿主打开时会做一次格式迁移(写一个新文件);
 *   ② 会话最后一条事件必须是 `session/end-seed` —— 否则宿主第一次恢复它时会追加这条标记。
 * 任一不满足就拒绝;`--allow-migration` / `--allow-seed-write` 可显式放行,结果里标明。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────────
 *   node tools/measure-open-cost.mjs                 # 默认 6 个体积点 × 3 次 + 每点 1 次热身,打印表
 *   node tools/measure-open-cost.mjs --scan          # 只列候选会话(不启动浏览器)
 *   node tools/measure-open-cost.mjs --from=old.json --svg=x.svg --markdown=x.md  # 用旧结果重画
 *   node tools/measure-open-cost.mjs --reps=1        # 快速跑一遍(结果噪声更大)
 *   node tools/measure-open-cost.mjs --warmup=0      # 不热身(第一次打开含宿主首次加载,不要混着比)
 *   node tools/measure-open-cost.mjs --json=out.json --markdown=out.md --svg=out.svg
 *   node tools/measure-open-cost.mjs --points=<id>,<id> --boot=<id> --workspace=<title>
 *   node tools/measure-open-cost.mjs --keep          # 留下 Chrome 看现场
 *   node tools/measure-open-cost.mjs --allow-seed-write   # 允许打开「还没带 end-seed 标记」的会话(会写一次标记)
 *
 * ── 口径(同机同版本内可比,跨版本比趋势不比绝对值)──────────────────────────
 *   t0            侧栏行上的 `click` 事件(CDP 真实鼠标;capture 阶段读 performance.now)
 *   首帧正文      目标会话标题已进 crumbs **且** 正文 `textContent.length >= --content-chars`
 *                 (默认 1200)的第一帧;正文用 rAF 采样,MutationObserver 触发
 *   基线解析      打开窗口里 `JSON.parse` 长度 ≥ 256KB 的调用;优先取网关流帧解析
 *                 (`parseMessage` / `RemoteStreamMux` 栈),取不到则如实退回全部大解析
 *   Response.json 单独记录(只统计 ≥64KB 的);在 DSH 0.2.1-rc.3 上会话基线走 WS 流帧,
 *                 这条通常只剩插件请求 —— 结果里会写清楚
 *   侧栏重渲染    侧栏会话列表区域(`[data-sidebar-list-area]`,旧外壳上退回
 *                 `[data-slot="sidebar.workspaces"] [role="tree"]`)的 DOM 变更活动窗口:
 *                 首条变更 → 最后一条变更的 span + 条数(过滤悬停跑马灯的两类属性)
 *   deliver       点击 → 基线解析开始(宿主读盘 / 序列化 / 传输)
 *   render        基线解析结束 → 首帧正文
 *
 * 默认计划是**作者本机**上的 6 个会话(7.24 → 36.73MB);换一台机器或被删掉之后,
 * 先 `--scan` 看候选,再用 `--points` / `--boot` 指定。`--scan` 只读、不启动浏览器。
 *
 * 这不是离线门禁(`npm test` / CI 里没有它):要真浏览器 + 本机跑着 `dsh web`,
 * token 从 `~/Library/Logs/ai.dsh.web.log` 里取(见 tools/cdp.mjs)。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { withPage } from './cdp.mjs';

const HOME = homedir();
const WORKSPACE_JSON = `${HOME}/.dsh/storages/workspace.json`;
const SESSIONS_ROOT = `${HOME}/.dsh/sessions`;

/** 默认测量点:DSH `dsh-perf-hud` / `dsh` 两个工作区里**已带 v4 投影与 end-seed** 的会话,7.24 → 36.73MB。 */
const DEFAULT_PLAN = [
	{ workspace: 'dsh-perf-hud', session: 'session-dbb69ea9-7573-4711-8f0c-58403b98adab' },
	{ workspace: 'dsh-perf-hud', session: 'session-f8d74a36-0bf3-4dcd-8a8c-58f472a73173' },
	{ workspace: 'dsh-perf-hud', session: 'session-c34cda76-9d85-4857-b75a-4f4a43b02c37' },
	{ workspace: 'dsh-perf-hud', session: 'session-88e8e85f-6aae-48fa-93a2-8b304bf3b28b' },
	{ workspace: 'dsh-perf-hud', session: 'session-05420f45-79a9-4afb-974f-0f9b1cf70e1b' },
	{ workspace: 'dsh', session: 'session-0482b0dc-c494-4e7d-98f1-f65b0a38fa5f' },
];

/** 每个工作区用来「冷启动」的那个会话:小、有正文、已带 v4 投影。 */
const BOOT_BY_WORKSPACE = {
	'dsh-perf-hud': 'session-b104f757-7cb0-461f-ba06-475cce9b74de',
	dsh: 'session-25677289-c3f5-418e-bfaf-891fbc156a34',
};

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
	const hit = argv.find((row) => row.startsWith(`--${name}=`));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const num = (name, fallback) => {
	const value = Number(opt(name, ''));
	return Number.isFinite(value) && value > 0 ? value : fallback;
};

const REPS = num('reps', 3);
const WARMUP = opt('warmup', '1') === '0' ? 0 : Math.max(0, Number(opt('warmup', '1')) || 1);
const CONTENT_CHARS = num('content-chars', 1200);
const QUIET_MS = 400;
const MAX_WAIT = num('max-wait', 6000);
const IDLE_MS = num('idle-ms', 1200);
const PORT = num('port', 9361);
const JSON_OUT = opt('json', '');
const MD_OUT = opt('markdown', '');
const SVG_OUT = opt('svg', '');
const FROM = opt('from', '');
const ALLOW_MIGRATION = flag('allow-migration');
const ALLOW_SEED_WRITE = flag('allow-seed-write');
const KEEP = flag('keep');
const SCAN = flag('scan');
const VERBOSE = flag('verbose');

/* ─────────────────────────── 本地会话目录(只读) ─────────────────────────── */

function loadWorkspaces() {
	if (!existsSync(WORKSPACE_JSON)) throw new Error(`读不到 ${WORKSPACE_JSON}(这台机器上跑过 dsh 吗?)`);
	const parsed = JSON.parse(readFileSync(WORKSPACE_JSON, 'utf8'));
	const rows = Object.values(parsed.tables?.workspaces ?? {});
	return rows.map((row) => ({
		title: row.title,
		workspaceId: row.workspaceId,
		path: row.path,
		sessionIds: [...(row.sessionIds ?? [])],
		dir: `${SESSIONS_ROOT}/--${row.path.slice(1).split('/').join('-')}--`,
	}));
}

function sessionFile(workspace, sessionId) {
	const dir = `${workspace.dir}/${sessionId}`;
	const v4 = `${dir}/session.v4.jsonl.zstd`;
	const v3 = `${dir}/session.jsonl.zstd`;
	if (existsSync(v4)) return { file: v4, v4: true, dir };
	if (existsSync(v3)) return { file: v3, v4: false, dir };
	return null;
}

/**
 * 解压后字节数 + 文件尾部(只读)。zstd 是只读解压,不落盘。
 * 尾部用来判 `session/end-seed`:宿主在**第一次**恢复一个没有该标记的旧会话时,
 * 会往会话里追加这条事件(见 packages/core/session 的 resume 分支)。带标记的会话
 * 再次打开不会再写 —— 所以默认只测带标记的,免得"打开会话"顺手改了会话文件。
 */
function readSessionBytes(file) {
	const out = execFileSync('zstd', ['-dc', file], { maxBuffer: 800 * 1024 * 1024 });
	return { raw: out.length, tail: out.subarray(Math.max(0, out.length - 4096)).toString('utf8') };
}

function zstdAvailable() {
	try {
		execFileSync('zstd', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

function resolvePlan(workspaces) {
	const explicit = opt('points', '');
	if (explicit !== '') {
		const workspaceTitle = opt('workspace', '');
		const workspace = workspaces.find((row) => row.title === workspaceTitle);
		if (workspace === undefined) {
			throw new Error(`--points 需要配合 --workspace=<标题>;可选:${workspaces.map((row) => row.title).join(' / ')}`);
		}
		return explicit.split(',').map((row) => row.trim()).filter(Boolean)
			.map((session) => ({ workspace: workspace.title, session }));
	}
	return DEFAULT_PLAN;
}

function findSession(workspaces, planRow) {
	const workspace = workspaces.find((row) => row.title === planRow.workspace);
	if (workspace === undefined) throw new Error(`工作区「${planRow.workspace}」不在 ${WORKSPACE_JSON} 里`);
	const entry = sessionFile(workspace, planRow.session);
	if (entry === null) {
		throw new Error(`会话 ${planRow.session} 的文件不在 ${workspace.dir} 下 —— 默认计划是本机特定的,`
			+ '先 `node tools/measure-open-cost.mjs --scan` 看看现在有哪些候选,再用 --points / --boot 指定');
	}
	return { workspace, ...entry };
}

function scan(workspaces) {
	if (!zstdAvailable()) throw new Error('找不到 zstd:brew install zstd');
	const rows = [];
	for (const workspace of workspaces) {
		for (const sessionId of workspace.sessionIds) {
			const entry = sessionFile(workspace, sessionId);
			if (entry === null) continue;
			const compressed = statSync(entry.file).size;
			rows.push({ workspace: workspace.title, workspaceId: workspace.workspaceId, sessionId, file: entry.file, v4: entry.v4, compressed });
		}
	}
	rows.sort((left, right) => right.compressed - left.compressed);
	const sized = [];
	for (const row of rows) {
		if (row.compressed < 1_000_000) {
			sized.push({ ...row, raw: 0, seeded: null });
			continue;
		}
		const bytes = readSessionBytes(row.file);
		sized.push({ ...row, raw: bytes.raw, seeded: bytes.tail.includes('session/end-seed') });
	}
	sized.sort((left, right) => right.raw - left.raw);
	console.log('体积点候选(按 v4 原始体积降序;>=6MB):');
	console.log('  标记 原始MB  压缩MB  工作区              会话');
	for (const row of sized) {
		if (row.raw < 6 * 1024 * 1024) continue;
		const mark = row.v4 === true && row.seeded === true ? '✓ ' : (row.v4 === true ? '! ' : '· ');
		console.log(`  ${mark} ${(row.raw / 1048576).toFixed(2).padStart(7)}  ${(row.compressed / 1048576).toFixed(2).padStart(6)}  ${row.workspace.padEnd(18)} ${row.sessionId}`);
	}
	console.log(`\n共 ${sized.length} 个会话。✓ = v4 + end-seed(默认直接可测);`);
	console.log('  ! = v4 但没有 end-seed(第一次打开会追加一次标记,需 --allow-seed-write);');
	console.log('  · = 只有 v3(打开会做格式迁移,需 --allow-migration)。');
}

/* ───────────────────────────── 页面内测量代码 ───────────────────────────── */
/* 下面这些函数会被 String() 序列化后送进页面,所以必须是自包含的。 */

/** 装探针:拦截 JSON.parse / Response.json、记长任务与两处 DOM 变更、按帧采样正文。 */
function installA3(opts) {
	const A = {
		opts, t0: 0, done: false, reason: null, frames: 0,
		parses: [], fetchJson: [], longtasks: [], side: [], main: [], samples: [],
		baselineLen: 0, baselineHeader: '', idle: null, lastActivity: 0,
		titleAt: null, contentAt: null, finalLen: 0,
	};
	window.__a3 = A;
	const now = () => performance.now();
	const mainEl = () => document.querySelector('[data-slot="main.conversation"]');
	const sideEl = () => document.querySelector('[data-sidebar-list-area]')
		|| document.querySelector('[data-slot="sidebar.workspaces"] [role="tree"]')
		|| document.querySelector('[data-slot="sidebar.workspaces"]')
		|| document.querySelector('[class*="sidebarCol"]');
	const rowEl = () => document.querySelector(`[data-row-key="session:${opts.sessionId}"]`);
	const crumb = () => {
		const node = document.querySelector('[class*="crumbs"]');
		return node ? node.textContent.trim() : '';
	};
	const selected = () => {
		const node = rowEl();
		return node === null ? true : node.getAttribute('aria-selected') === 'true';
	};
	A.selectors = {
		main: mainEl() !== null,
		side: sideEl() !== null,
		sideIsList: document.querySelector('[data-sidebar-list-area]') !== null,
		sideSelector: document.querySelector('[data-sidebar-list-area]') !== null ? '[data-sidebar-list-area]'
			: (document.querySelector('[data-slot="sidebar.workspaces"] [role="tree"]') !== null ? '[data-slot="sidebar.workspaces"] [role="tree"]'
				: (document.querySelector('[data-slot="sidebar.workspaces"]') !== null ? '[data-slot="sidebar.workspaces"]' : '[class*="sidebarCol"]')),
		row: rowEl() !== null,
	};

	const nativeParse = JSON.parse;
	JSON.parse = function patchedParse(text, reviver) {
		const len = typeof text === 'string' ? text.length : 0;
		if (len < 32768) return nativeParse.call(this, text, reviver);
		const start = now();
		try {
			return nativeParse.call(this, text, reviver);
		} finally {
			const end = now();
			const frames = (new Error().stack || '').split('\n').slice(1, 6);
			const stack = frames.join(' | ');
			const fn = frames
				.map((line) => (line.match(/at\s+([^\s(]+)/) || [])[1] || '')
				.find((name) => name !== '' && !/patchedParse/.test(name)) || '';
			A.parses.push({ start, end, ms: end - start, len, fn, stack: stack.slice(0, 500) });
		}
	};

	const nativeJson = Response.prototype.json;
	Response.prototype.json = function patchedJson(...args) {
		const start = now();
		const entry = { url: String(this.url || ''), start, end: 0, ms: 0, decoded: 0, failed: false };
		const done = nativeJson.apply(this, args);
		done.then(() => {
			entry.end = now();
			entry.ms = entry.end - start;
			try {
				const hit = performance.getEntriesByName(entry.url).at(-1);
				if (hit !== undefined) entry.decoded = hit.decodedBodySize;
			} catch { /* 资源计时可能还没结算 */ }
		}, () => {
			entry.end = now();
			entry.ms = entry.end - start;
			entry.failed = true;
		}).finally(() => { A.fetchJson.push(entry); });
		return done;
	};

	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				A.longtasks.push({ start: entry.startTime, end: entry.startTime + entry.duration, dur: entry.duration });
			}
		}).observe({ type: 'longtask', buffered: false });
	} catch (error) {
		A.longtaskError = String(error);
	}

	let sampleQueued = false;
	const evaluateProgress = () => {
		if (A.t0 === 0) return;
		const node = mainEl();
		const len = node === null ? 0 : node.textContent.length;
		const header = crumb();
		const titleHit = header.includes(opts.title);
		if (A.titleAt === null && titleHit) A.titleAt = now();
		if (A.contentAt === null && titleHit && selected() && len >= opts.contentChars) A.contentAt = now();
		A.finalLen = Math.max(A.finalLen, len);
		const quiet = now() - A.lastActivity;
		if (A.done) return;
		if (A.contentAt !== null && quiet >= opts.quietMs && now() - A.t0 > 400) {
			A.done = true;
			A.reason = 'content';
		} else if (now() - A.t0 >= opts.maxWait) {
			A.done = true;
			A.reason = A.contentAt === null ? 'no-content' : 'cap';
		}
	};
	const scheduleSample = () => {
		if (sampleQueued) return;
		sampleQueued = true;
		requestAnimationFrame(() => {
			sampleQueued = false;
			const node = mainEl();
			A.samples.push({ t: now(), len: node === null ? 0 : node.textContent.length, header: crumb().slice(0, 120), selected: selected() });
			evaluateProgress();
		});
	};

	const observe = (target, sink) => {
		if (target === null) return false;
		new MutationObserver((records) => {
			const t = now();
			A.lastActivity = Math.max(A.lastActivity, t);
			for (const record of records) {
				sink.push({
					t,
					type: record.type,
					add: record.addedNodes.length,
					rem: record.removedNodes.length,
					attr: record.attributeName || '',
					tgt: `${record.target.nodeName || ''}.${String(record.target.className || '').slice(0, 36)}`.slice(0, 60),
				});
			}
		}).observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
		return true;
	};
	A.observed = {
		main: observe(mainEl(), A.main),
		side: observe(sideEl(), A.side),
	};

	const loop = () => {
		if (A.t0 !== 0) {
			A.frames += 1;
			evaluateProgress();
		}
		requestAnimationFrame(loop);
	};
	requestAnimationFrame(loop);

	document.addEventListener('click', (event) => {
		if (A.t0 !== 0) return;
		const row = event.target && event.target.closest ? event.target.closest('[data-row-key]') : null;
		A.t0 = now();
		A.clickKey = row === null ? null : row.getAttribute('data-row-key');
		A.lastActivity = A.t0;
	}, { capture: true, once: true });
}

/** 结束 idle 观测,清空窗口计数,准备接 click。 */
function armA3() {
	const A = window.__a3;
	const node = document.querySelector('[data-slot="main.conversation"]');
	A.baselineLen = node === null ? 0 : node.textContent.length;
	const crumb = document.querySelector('[class*="crumbs"]');
	A.baselineHeader = crumb === null ? '' : crumb.textContent.trim();
	A.idle = {
		sideCount: A.side.length,
		mainCount: A.main.length,
		longTaskCount: A.longtasks.length,
		parseCount: A.parses.length,
		responseJsonCount: A.fetchJson.length,
	};
	A.side.length = 0;
	A.main.length = 0;
	A.longtasks.length = 0;
	A.parses.length = 0;
	A.fetchJson.length = 0;
	return { baselineLen: A.baselineLen, baselineHeader: A.baselineHeader, idle: A.idle };
}

/** 把窗口内的原始记录压成一份小结果(避免把几万条变更搬回 Node)。 */
function collectA3() {
	const A = window.__a3;
	const t0 = A.t0;
	const rel = (t) => Math.round((t - t0) * 10) / 10;
	const inWindow = (entry) => entry.start >= t0 - 1;
	const parses = A.parses.filter(inWindow);
	const gateway = parses.filter((entry) => /parseMessage|RemoteStreamMux|parseRemoteStream/.test(`${entry.fn} ${entry.stack}`));
	const used = gateway.length > 0 ? gateway : parses;
	const parseMs = used.reduce((sum, entry) => sum + entry.ms, 0);
	const parseChars = used.reduce((max, entry) => Math.max(max, entry.len), 0);
	const parseFirst = used.length === 0 ? null : rel(Math.min(...used.map((entry) => entry.start)));
	const parseLast = used.length === 0 ? null : rel(Math.max(...used.map((entry) => entry.end)));
	const parseFns = [...new Set(used.map((entry) => entry.fn).filter(Boolean))].slice(0, 3);
	const parseTasks = used.length === 0 ? [] : A.longtasks
		.filter((task) => task.end >= Math.min(...used.map((entry) => entry.start)) && task.start <= Math.max(...used.map((entry) => entry.end)))
		.map((task) => ({ start: rel(task.start), dur: Math.round(task.dur) }));

	const response = A.fetchJson
		.filter((entry) => inWindow(entry) && (entry.decoded >= 65536 || entry.ms >= 16))
		.map((entry) => ({ url: entry.url.replace(location.origin, '').slice(0, 160), ms: Math.round(entry.ms * 10) / 10, decoded: entry.decoded, start: rel(entry.start) }))
		.slice(0, 6);

	const MARQUEE = new Set(['data-scrolled', 'data-clipped']);
	const isMarquee = (entry) => entry.type === 'attributes' && MARQUEE.has(entry.attr);
	const sideAll = A.side.filter((entry) => entry.t >= t0);
	const side = sideAll.filter((entry) => !isMarquee(entry));
	const sideHover = sideAll.filter((entry) => isMarquee(entry));
	const main = A.main.filter((entry) => entry.t >= t0 && !(entry.type === 'attributes' && MARQUEE.has(entry.attr)));
	const span = (rows) => rows.length === 0
		? { count: 0, firstMs: null, lastMs: null, spanMs: null }
		: {
			count: rows.length,
			firstMs: rel(rows[0].t),
			lastMs: rel(rows[rows.length - 1].t),
			spanMs: Math.round((rows[rows.length - 1].t - rows[0].t) * 10) / 10,
			detail: rows.slice(0, 12).map((entry) => ({ t: rel(entry.t), type: entry.type, attr: entry.attr, tgt: entry.tgt, add: entry.add, rem: entry.rem })),
		};
	const sideInOpen = A.contentAt === null ? [] : side.filter((entry) => entry.t <= A.contentAt);

	const longtasks = A.longtasks
		.filter((task) => task.end >= t0)
		.map((task) => ({ start: rel(task.start), dur: Math.round(task.dur) }))
		.slice(0, 40);
	const lastActivity = A.lastActivity === 0 ? null : rel(A.lastActivity);

	const samples = A.samples.filter((sample) => sample.t >= t0);
	return {
		t0,
		clickKey: A.clickKey,
		reason: A.reason,
		done: A.done,
		selectors: A.selectors,
		observed: A.observed,
		longtaskError: A.longtaskError ?? null,
		title: A.opts.title,
		contentChars: A.opts.contentChars,
		baselineLen: A.baselineLen,
		baselineHeader: A.baselineHeader,
		finalLen: A.finalLen,
		titleMs: A.titleAt === null ? null : rel(A.titleAt),
		interactiveMs: A.contentAt === null ? null : rel(A.contentAt),
		lastActivityMs: lastActivity,
		parse: {
			count: used.length,
			ms: Math.round(parseMs * 10) / 10,
			chars: parseChars,
			firstMs: parseFirst,
			lastMs: parseLast,
			fns: parseFns,
			fallback: gateway.length === 0,
			otherParses: parses.length - used.length,
		},
		parseTasks,
		responseJson: response,
		longtasks,
		side: span(side),
		sideInOpen: span(sideInOpen),
		sideHover: span(sideHover),
		main: span(main),
		frames: A.frames,
		idle: A.idle ?? null,
		samples: samples.slice(0, 40).map((sample) => ({ t: rel(sample.t), len: sample.len, title: sample.header.includes(A.opts.title), selected: sample.selected })),
	};
}

/* ─────────────────────────────── 浏览器侧流程 ─────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => (value === null || value === undefined ? null : Math.round(value * 10) / 10);

async function poll(page, expression, timeoutMs, intervalMs, what) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			if (await page.evaluate(expression) === true) return true;
		} catch (error) {
			lastError = error;
		}
		await sleep(intervalMs);
	}
	throw new Error(`等不到${what}(${timeoutMs}ms)${lastError === null ? '' : `:${lastError.message}`}`);
}

const READY_EXPR = `(() => {
	const rows = document.querySelectorAll('[data-row-key^="session:"]');
	const crumb = document.querySelector('[class*="crumbs"]');
	return document.querySelector('[data-slot="sidebar.workspaces"]') !== null
		&& rows.length > 0
		&& crumb !== null
		&& crumb.textContent.trim() !== '';
})()`;

/**
 * 预置 localStorage。必须在**新文档开始时**写:
 * 点开一个会话后应用会自己写 `dsh.sessions.current`,若是先 evaluate 再 reload,
 * 那次写入可能排在 reload 之后、把种子盖掉(实测第二次启动就恢复成了上一个会话)。
 */
function seedScript(bootId, workspaceId) {
	return `(() => {
		localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: ${JSON.stringify(bootId)} }));
		localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({
			groupBy: 'workspace',
			orderBy: 'updated',
			groupExpansion: { ${JSON.stringify(workspaceId)}: true },
			sessionOrderByAccount: {},
			archivedFilter: 'default',
		}));
	})();`;
}

async function rowRect(page, key) {
	return page.evaluate(`(() => {
		const node = document.querySelector(${JSON.stringify(`[data-row-key="${key}"]`)});
		if (node === null) return null;
		node.scrollIntoView({ block: 'center', inline: 'nearest' });
		const box = node.getBoundingClientRect();
		if (box.width === 0 || box.height === 0) return null;
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	})()`);
}

async function clickKey(page, key) {
	const rect = await rowRect(page, key);
	if (rect === null) return false;
	await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
	await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
	return true;
}

async function revealRow(page, sessionId) {
	const key = `session:${sessionId}`;
	const selector = JSON.stringify(`[data-row-key="${key}"]`);
	const overflowSelector = JSON.stringify('[data-row-key^="overflow:"]');
	for (let i = 0; i < 24; i += 1) {
		if (await page.evaluate(`document.querySelector(${selector}) !== null`) === true) return true;
		const clicked = await page.evaluate(`(() => {
			const buttons = [...document.querySelectorAll(${overflowSelector})]
				.filter((node) => node.offsetParent !== null);
			const button = buttons.at(-1);
			if (button === undefined) return false;
			button.scrollIntoView({ block: 'nearest' });
			button.click();
			return true;
		})()`);
		if (clicked !== true) return false;
		await sleep(500);
	}
	return false;
}

async function readTitle(page, sessionId) {
	return page.evaluate(`(() => {
		const node = document.querySelector(${JSON.stringify(`[data-row-key="session:${sessionId}"]`)});
		if (node === null) return '';
		const line = node.innerText.split('\\n')[0].trim();
		return line;
	})()`);
}

/** 打开一个工作区:预置 localStorage → 刷新 → 等应用就绪。 */
async function bootWorkspace(page, bootId, workspaceId) {
	const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: seedScript(bootId, workspaceId) });
	try {
		// 标记旧文档:reload 之后如果还能看到这个标记,说明 evaluate 落在旧文档上,
		// 这时 READY_EXPR 会被上一次的 DOM 满足,后续检查就会拿到过期状态(实测踩过)。
		await page.evaluate('window.__a3Stale = true').catch(() => {});
		await page.send('Page.reload', { ignoreCache: false });
		const freshReady = `(typeof window.__a3Stale === 'undefined') && (${READY_EXPR})`;
		await poll(page, freshReady, 25000, 120, '应用就绪(新文档)');
	} finally {
		await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
	}
	const bootReady = `(() => {
		const row = document.querySelector(${JSON.stringify(`[data-row-key="session:${bootId}"]`)});
		const crumb = document.querySelector('[class*="crumbs"]');
		const current = localStorage.getItem('dsh.sessions.current') ?? '';
		const restored = row !== null && row.getAttribute('aria-selected') === 'true';
		const saved = current.includes(${JSON.stringify(bootId)});
		return (restored || saved) && crumb !== null && crumb.textContent.trim() !== '';
	})()`;
	await poll(page, bootReady, 10000, 120, `启动会话 ${bootId} 被恢复`);
	await sleep(300);
}

async function measureOnce(page, point) {
	await bootWorkspace(page, point.boot, point.workspace.workspaceId);
	const revealed = await revealRow(page, point.session);
	if (!revealed) throw new Error(`侧栏里找不到会话 ${point.session}(展开按钮点完了还是没出现)`);
	const title = await readTitle(page, point.session);
	if (title === '') throw new Error(`会话 ${point.session} 的侧栏标题是空的,没法用 crumbs 校验`);
	await page.evaluate(`(${installA3.toString()})(${JSON.stringify({
		sessionId: point.session,
		title,
		contentChars: CONTENT_CHARS,
		quietMs: QUIET_MS,
		maxWait: MAX_WAIT,
	})})`);
	const armed = await page.evaluate(`(${armA3.toString()})()`);
	await sleep(IDLE_MS);
	const rect = await rowRect(page, `session:${point.session}`);
	if (rect === null) throw new Error(`会话 ${point.session} 的行不可见`);
	await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
	await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
	// 指针留在行上会触发标题跑马灯(data-scrolled / data-clipped 反复写),那是悬停动画,
	// 不是"打开会话"的重渲染;把指针移开,后面的计数里再过滤一次这两类属性。
	await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 480, button: 'none' });
	await poll(page, 'window.__a3 !== undefined && window.__a3.done === true', MAX_WAIT + 4000, 100, '本次打开结束');
	const result = await page.evaluate(`(${collectA3.toString()})()`);
	if (result.observed?.main !== true) {
		throw new Error('页面里没找到 [data-slot="main.conversation"] —— 外壳结构变了,探针没装上,不能拿这份数字');
	}
	if (result.clickKey !== `session:${point.session}`) {
		throw new Error(`点击没落在目标行(落在 ${result.clickKey});侧栏可能被遮挡或行被重建`);
	}
	const closed = await page.evaluate(`(() => {
		const row = document.querySelector(${JSON.stringify(`[data-row-key="session:${point.session}"]`)});
		return row !== null && row.getAttribute('aria-selected') === 'true';
	})()`);
	return { ...result, title, armed, rowSelected: closed === true, bootHeader: armed.baselineHeader };
}

function fingerprint() {
	return {
		platform: process.platform,
		node: process.version,
		measuredAt: new Date().toISOString(),
		reps: REPS,
		warmup: WARMUP,
		contentChars: CONTENT_CHARS,
		idleMs: IDLE_MS,
		maxWait: MAX_WAIT,
	};
}

/* ─────────────────────────────── 汇总 / 输出 ─────────────────────────────── */

function median(values) {
	const rows = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
	if (rows.length === 0) return null;
	const mid = Math.floor(rows.length / 2);
	return rows.length % 2 === 1 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

function summarize(results) {
	const byPoint = new Map();
	for (const result of results) {
		if (!byPoint.has(result.point.session)) byPoint.set(result.point.session, []);
		byPoint.get(result.point.session).push(result);
	}
	return [...byPoint.entries()].map(([session, rows]) => {
		const ok = rows.filter((row) => row.interactiveMs !== null);
		const parseStart = ok.map((row) => row.parse.firstMs).filter((value) => value !== null);
		const deliver = ok.map((row) => (row.parse.firstMs === null ? null : row.parse.firstMs)).filter((value) => value !== null);
		return {
			session,
			workspace: rows[0].point.workspace.title,
			rawMB: rows[0].point.rawMB,
			reps: rows.length,
			interactiveMs: median(ok.map((row) => row.interactiveMs)),
			interactiveMin: ok.length === 0 ? null : Math.min(...ok.map((row) => row.interactiveMs)),
			interactiveMax: ok.length === 0 ? null : Math.max(...ok.map((row) => row.interactiveMs)),
			titleMs: median(ok.map((row) => row.titleMs)),
			deliverMs: median(deliver),
			parseMs: median(ok.map((row) => row.parse.ms)),
			parseChars: median(ok.map((row) => row.parse.chars)),
			parseTaskMs: median(ok.map((row) => (row.parseTasks.length === 0 ? 0 : Math.max(...row.parseTasks.map((task) => task.dur))))),
			renderMs: median(ok.map((row) => (row.interactiveMs === null || row.parse.lastMs === null ? null : row.interactiveMs - row.parse.lastMs))),
			sidebarSpanMs: median(ok.map((row) => row.side.spanMs)),
			sidebarCount: median(ok.map((row) => row.side.count)),
			sidebarFirstMs: median(ok.map((row) => row.side.firstMs)),
			sidebarInOpenCount: median(ok.map((row) => row.sideInOpen.count)),
			sidebarInOpenSpanMs: median(ok.map((row) => row.sideInOpen.spanMs)),
			sidebarHoverCount: median(ok.map((row) => row.sideHover.count)),
			responseJson: ok.flatMap((row) => row.responseJson).slice(0, 4),
		};
	}).sort((left, right) => left.rawMB - right.rawMB);
}

function printSummary(summary, label = '') {
	if (label !== '') console.log(label);
	console.log('  体积MB  打开ms(中位)   [min..max]    标题ms  交付ms  解析ms  解析任务ms  渲染ms  侧栏spanms  侧栏条数  打开内侧栏条数');
	for (const row of summary) {
		const fmt = (value, width) => (value === null ? '—' : String(Math.round(value)).padStart(width));
		console.log(`  ${String(row.rawMB.toFixed(2)).padStart(7)}  ${fmt(row.interactiveMs, 12)}  ${`[${fmt(row.interactiveMin, 4)}..${fmt(row.interactiveMax, 4)}]`.padStart(14)}  ${fmt(row.titleMs, 6)}  ${fmt(row.deliverMs, 6)}  ${fmt(row.parseMs, 6)}  ${fmt(row.parseTaskMs, 10)}  ${fmt(row.renderMs, 6)}  ${fmt(row.sidebarSpanMs, 10)}  ${fmt(row.sidebarCount, 7)}  ${fmt(row.sidebarInOpenCount, 12)}`);
	}
}

function printTable(summary, results) {
	printSummary(summary, `\n体积点:${summary.length} 个 × 每点 ${REPS} 次;t0 = 侧栏行 click;首帧正文 = 标题进 crumbs 且正文 ≥ ${CONTENT_CHARS} 字符`);
	const failures = results.filter((row) => row.interactiveMs === null || row.done !== true);
	console.log(`\n完成 ${results.length} 次;未拿到首帧正文 ${failures.length} 次`);
	for (const row of failures) console.log(`  ${row.point.workspace.title} / ${row.point.session}: reason=${row.reason ?? '?'}`);

	const response = summary.flatMap((row) => row.responseJson.map((entry) => ({ ...entry, point: row.rawMB })));
	if (response.length > 0) {
		console.log('\n打开窗口里的 Response.json(≥64KB 或 ≥16ms;会话基线在本版本走 WS 流帧,不在这一栏):');
		for (const entry of response.slice(0, 6)) console.log(`  ${String(entry.point).padStart(6)}MB  ${String(entry.ms).padStart(6)}ms  ${String((entry.decoded / 1024).toFixed(0)).padStart(7)}KB  ${entry.url}`);
	}
}

function markdownTable(summary) {
	const lines = [
		'| 会话体积(v4 原始) | 基线帧字符 | 打开→首帧正文 | 标题切换 | 交付 | JSON 解析 | 解析所在长任务 | 解析后渲染 | 侧栏 span | 侧栏条数 | 打开窗口内条数 |',
		'|---|---|---|---|---|---|---|---|---|---|---|',
	];
	for (const row of summary) {
		const cell = (value, suffix = '') => (value === null ? '—' : `${Math.round(value)}${suffix}`);
		lines.push(`| ${row.rawMB.toFixed(2)} MB | ${(row.parseChars / 1e6).toFixed(2)}M | ${cell(row.interactiveMs, ' ms')} | ${cell(row.titleMs, ' ms')} | ${cell(row.deliverMs, ' ms')} | ${cell(row.parseMs, ' ms')} | ${cell(row.parseTaskMs, ' ms')} | ${cell(row.renderMs, ' ms')} | ${cell(row.sidebarSpanMs, ' ms')} | ${cell(row.sidebarCount)} | ${cell(row.sidebarInOpenCount)} |`);
	}
	return `${lines.join('\n')}\n`;
}

/** 两条折线:总耗时 / 基线解析所在长任务。纯手写 SVG,无依赖。 */
function svgChart(summary) {
	const width = 720;
	const height = 340;
	const pad = { left: 64, right: 24, top: 28, bottom: 48 };
	const plotW = width - pad.left - pad.right;
	const plotH = height - pad.top - pad.bottom;
	const points = summary.filter((row) => row.interactiveMs !== null);
	const minX = Math.min(...points.map((row) => row.rawMB)) * 0.86;
	const maxX = Math.max(...points.map((row) => row.rawMB)) * 1.04;
	const maxY = Math.max(...points.map((row) => row.interactiveMs), 1);
	// 对数横轴:7.2 → 36.7 的点才是均匀的;线性轴会把前 5 个点挤成一团。
	const x = (mb) => pad.left + (Math.log10(mb) - Math.log10(minX)) / (Math.log10(maxX) - Math.log10(minX)) * plotW;
	const y = (ms) => pad.top + plotH - (ms / maxY) * plotH;
	const line = (key, color, dash = '') => {
		const path = points.map((row, index) => `${index === 0 ? 'M' : 'L'}${x(row.rawMB).toFixed(1)},${y(row[key]).toFixed(1)}`).join(' ');
		const dots = points.map((row) => `<circle cx="${x(row.rawMB).toFixed(1)}" cy="${y(row[key]).toFixed(1)}" r="3.5" fill="${color}"/>`).join('');
		return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2"${dash === '' ? '' : ` stroke-dasharray="${dash}"`}/>${dots}`;
	};
	const xTicks = points.map((row) => `<text x="${x(row.rawMB).toFixed(1)}" y="${height - 20}" text-anchor="middle" font-size="11" fill="#666">${row.rawMB.toFixed(1)}</text>`).join('');
	const yTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
		const ms = Math.round(maxY * fraction);
		return `<line x1="${pad.left}" y1="${y(ms).toFixed(1)}" x2="${width - pad.right}" y2="${y(ms).toFixed(1)}" stroke="#e5e5e5"/><text x="${pad.left - 10}" y="${(y(ms) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#666">${ms}</text>`;
	}).join('');
	const labels = points.map((row) => `<text x="${x(row.rawMB).toFixed(1)}" y="${(y(row.interactiveMs) - 10).toFixed(1)}" text-anchor="middle" font-size="11" fill="#111">${Math.round(row.interactiveMs)}</text>`).join('');
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="会话体积 → 打开耗时">
<text x="${pad.left}" y="18" font-size="12" fill="#111">打开会话 → 首帧正文(ms,中位)× 会话体积(MB,v4 原始)</text>
${yTicks}
<text x="${pad.left}" y="${height - 4}" font-size="11" fill="#666">MB(对数)</text>
<text x="14" y="${pad.top + 4}" font-size="11" fill="#666">ms</text>
${xTicks}
${line('interactiveMs', '#1f6feb')}
${line('parseTaskMs', '#d29922', '4 3')}
${labels}
<text x="${pad.left}" y="${pad.top + 14}" font-size="11" fill="#666">实线 = 打开总耗时;虚线 = 基线解析所在长任务的实际跨度(刻度共用,仅比形状)</text>
</svg>
`;
}

/* ─────────────────────────────── 主流程 ─────────────────────────────── */

async function renderFrom(file) {
	const data = JSON.parse(readFileSync(file, 'utf8'));
	if (data.kind !== 'perf-hud-open-cost' || !Array.isArray(data.summary)) {
		throw new Error(`${file} 不是 measure-open-cost 的结果文件(kind=perf-hud-open-cost)`);
	}
	printSummary(data.summary, `从 ${file} 重新渲染(没有重新测量)`);
	if (MD_OUT !== '') {
		writeFileSync(MD_OUT, `实测(中位;t0 = click,首帧正文 = 正文 ≥ ${data.env?.contentChars ?? CONTENT_CHARS} 字符):\n\n${markdownTable(data.summary)}`);
		console.log(`Markdown → ${MD_OUT}`);
	}
	if (SVG_OUT !== '') {
		writeFileSync(SVG_OUT, svgChart(data.summary));
		console.log(`SVG → ${SVG_OUT}`);
	}
}

async function main() {
	if (FROM !== '') {
		await renderFrom(FROM);
		return;
	}
	const workspaces = loadWorkspaces();
	if (SCAN) {
		scan(workspaces);
		return;
	}
	if (!zstdAvailable()) throw new Error('找不到 zstd(体积要按解压后字节算):brew install zstd');
	if (JSON_OUT !== '' && !existsSync(JSON_OUT) && !JSON_OUT.includes('/')) {
		throw new Error(`--json 需要一个路径(收到 "${JSON_OUT}")`);
	}

	const planRows = resolvePlan(workspaces);
	const plan = planRows.map((row) => {
		const found = findSession(workspaces, row);
		if (!found.v4 && !ALLOW_MIGRATION) {
			throw new Error(`会话 ${row.session}(${row.workspace})只有 v3 格式;打开它会让宿主写一份 v4 迁移文件。`
				+ '测量默认不改会话目录,换一个已带 v4 的会话,或显式加 --allow-migration。');
		}
		const boot = opt('boot', '') === '' ? BOOT_BY_WORKSPACE[row.workspace] : opt('boot', '');
		if (boot === undefined) throw new Error(`工作区「${row.workspace}」没有预设的启动会话,用 --boot=<id> 指定一个小的`);
		const bytes = readSessionBytes(found.file);
		const seeded = bytes.tail.includes('session/end-seed');
		if (!seeded && !ALLOW_SEED_WRITE) {
			throw new Error(`会话 ${row.session}(${row.workspace})的最后一条事件不是 session/end-seed;`
				+ '宿主第一次打开它时会追加这条标记(会话内容不变,但文件会变)。测量默认只开不写的会话;'
				+ '要测它请显式加 --allow-seed-write,并把这件事写进报告。');
		}
		return {
			...row,
			boot,
			workspace: found.workspace,
			file: found.file,
			v4: found.v4,
			seeded,
			rawMB: bytes.raw / 1048576,
			compressedMB: statSync(found.file).size / 1048576,
		};
	});

	console.log(`测量点 ${plan.length} 个 × ${REPS} 次;先热身 ${WARMUP} 次(丢弃,曲线是热态);会话只读(宿主会写 0 字节 session.lock)`);
	for (const point of plan) {
		console.log(`  ${point.rawMB.toFixed(2)}MB  ${point.workspace.title} / ${point.session}${point.v4 ? '' : '  ⚠ v3(已允许迁移)'}${point.seeded ? '' : '  ⚠ 无 end-seed(会写一次标记)'}`);
	}

	const workspaceBefore = statSync(WORKSPACE_JSON).mtimeMs;
	const sessionBefore = new Map();
	for (const point of plan) {
		const entry = point.v4 ? `${point.workspace.dir}/${point.session}/session.v4.jsonl.zstd` : point.file;
		sessionBefore.set(entry, existsSync(entry) ? statSync(entry).mtimeMs : null);
	}

	const results = [];
	const env = {};
	const port = PORT;
	const profile = `/tmp/dsh-perf-hud-a3-${port}`;
	if (!profile.startsWith('/tmp/dsh-perf-hud-a3-') || profile.includes('..')) {
		throw new Error(`拒绝清理不认识的临时目录:${profile}`);
	}
	let occupied = false;
	try {
		await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
		occupied = true;
	} catch { /* 连不上 = 端口空闲,正常 */ }
	if (occupied) {
		throw new Error(`端口 ${port} 上还有 Chrome(上次被强杀留下的?);先 pkill -f 'remote-debugging-port=${port}' 再重跑。`
			+ '残留实例会让新实例连到旧页面,waitForHud 之后的第一次 evaluate 会一直不返回。');
	}
	// 每轮从干净的 profile 起:否则上一轮留下的 localStorage 会让应用在启动时先打开上次的目标会话
	// (既不在测量窗口里,也会在宿主侧预先加载它)。
	rmSync(profile, { recursive: true, force: true });
	await withPage({ port, profile, keep: KEEP }, async (page) => {
		const shellReady = `document.readyState === 'complete' && document.querySelector('[data-slot="sidebar"]') !== null`;
		await poll(page, shellReady, 25000, 150, '外壳就绪');
		const chrome = await page.send('Browser.getVersion');
		const userAgent = await page.evaluate('navigator.userAgent');
		const assets = await page.evaluate(`performance.getEntriesByType('resource')
			.map((entry) => entry.name)
			.filter((name) => /\\/assets\\/(index|vendor)-[^/]+\\.(js|css)$/.test(name))
			.map((name) => name.replace(location.origin + '/assets/', ''))
			.sort()`);
		env.chrome = chrome.product;
		env.userAgent = userAgent;
		env.assets = assets;
		console.log(`Chrome ${chrome.product};外壳资源 ${assets.join(', ')}`);
		for (let i = 0; i < WARMUP; i += 1) {
			for (const point of plan) {
				const started = Date.now();
				const result = await measureOnce(page, point);
				const took = ((Date.now() - started) / 1000).toFixed(1);
				console.log(`  热身${i + 1} ${point.rawMB.toFixed(2)}MB → ${Math.round(result.interactiveMs ?? -1)}ms  (丢弃,${took}s)`);
			}
		}
		for (let rep = 0; rep < REPS; rep += 1) {
			for (const point of plan) {
				const started = Date.now();
				const result = await measureOnce(page, point);
				results.push({ ...result, point });
				const took = ((Date.now() - started) / 1000).toFixed(1);
				const ms = result.interactiveMs === null ? 'FAIL' : `${Math.round(result.interactiveMs)}ms`;
				const parse = `${Math.round(result.parse.ms)}ms/${(result.parse.chars / 1e6).toFixed(2)}M`;
				console.log(`  rep${rep + 1} ${point.rawMB.toFixed(2)}MB → ${ms}  解析 ${parse}  交付 ${Math.round(result.parse.firstMs ?? -1)}ms  侧栏 ${Math.round(result.side.spanMs ?? -1)}ms/${result.side.count}  (${took}s)`);
				if (VERBOSE) console.log(JSON.stringify(result, null, 1));
			}
		}
		await page.evaluate('window.__a3 = undefined');
	});

	const workspaceAfter = statSync(WORKSPACE_JSON).mtimeMs;
	const sessionWrites = [];
	for (const [entry, before] of sessionBefore) {
		const after = existsSync(entry) ? statSync(entry).mtimeMs : null;
		if (after !== before) sessionWrites.push(entry);
	}
	if (workspaceAfter !== workspaceBefore) console.warn(`⚠ ${WORKSPACE_JSON} 在测量期间变了 —— 可能是用户自己在操作,也可能是宿主行为;本次数字仍按采集记录。`);
	if (sessionWrites.length > 0) console.warn(`⚠ 以下会话文件 mtime 变了(测量工具不写它们):\n  ${sessionWrites.join('\n  ')}`);

	const summary = summarize(results);
	printTable(summary, results);

	const document = {
		kind: 'perf-hud-open-cost',
		version: 1,
		env: {
			...fingerprint(),
			host: 'http://127.0.0.1:3080',
			chrome: env.chrome ?? null,
			userAgent: env.userAgent ?? null,
			assets: env.assets ?? [],
			sessionV4Guard: !ALLOW_MIGRATION,
			seedWriteAllowed: ALLOW_SEED_WRITE,
		},
		plan: plan.map((point) => ({
			workspace: point.workspace.title,
			workspaceId: point.workspace.workspaceId,
			session: point.session,
			boot: point.boot,
			file: point.file.replace(HOME, '~'),
			v4: point.v4,
			seeded: point.seeded,
			rawMB: Math.round(point.rawMB * 100) / 100,
			compressedMB: Math.round(point.compressedMB * 100) / 100,
		})),
		summary,
		reps: results.map((row) => ({
			workspace: row.point.workspace.title,
			session: row.point.session,
			rawMB: Math.round(row.point.rawMB * 100) / 100,
			title: row.title,
			interactiveMs: round(row.interactiveMs),
			titleMs: round(row.titleMs),
			lastActivityMs: round(row.lastActivityMs),
			reason: row.reason,
			parse: row.parse,
			parseTasks: row.parseTasks,
			responseJson: row.responseJson,
			side: row.side,
			sideInOpen: row.sideInOpen,
			sideHover: row.sideHover,
			main: row.main,
			longtasks: row.longtasks,
			frames: row.frames,
			idle: row.idle,
			baselineLen: row.baselineLen,
			finalLen: row.finalLen,
		})),
	};
	if (JSON_OUT !== '') {
		writeFileSync(JSON_OUT, `${JSON.stringify(document, null, 2)}\n`);
		console.log(`\nJSON → ${JSON_OUT}`);
	}
	if (MD_OUT !== '') {
		writeFileSync(MD_OUT, `实测(中位;t0 = click,首帧正文 = 正文 ≥ ${CONTENT_CHARS} 字符):\n\n${markdownTable(summary)}`);
		console.log(`Markdown → ${MD_OUT}`);
	}
	if (SVG_OUT !== '') {
		writeFileSync(SVG_OUT, svgChart(summary));
		console.log(`SVG → ${SVG_OUT}`);
	}
	const failed = results.filter((row) => row.interactiveMs === null);
	if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
	console.error(`❌ ${error.message}`);
	process.exitCode = 1;
});
