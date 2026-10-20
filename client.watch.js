/**
 * dsh-perf-hud 的包内分片:守夜层(帧环观察、事故捕获与留存)。
 *
 * 默认常开,但代码只在页面启动时加载一次;启停与状态仍在主文件(start / stop /
 * state.watch),这里只放观察器回调、事故组装与落盘。依赖通过 createWatch(deps)
 * 显式传入,不做反向 import。
 */
window.__ModuleLoader__.load({
	id: 'dsh-perf-hud',
	chunk: 'client.watch.js',
	factory: (require) => {
		const exports = {};
		exports.createWatch = (deps) => {
			const {
				BUNDLE_PREFIX,
				LS_INCIDENTS,
				W,
				WATCH_DAILY_DAYS,
				WATCH_EVENT_MAX,
				WATCH_EVENT_MS,
				WATCH_FRAMES,
				WATCH_GAP_MS,
				WATCH_INCIDENT_MAX,
				WATCH_KEEP_MAX,
				WATCH_LOAF_MAX,
				WATCH_PERSIST_MAX_BYTES,
				WATCH_POST_MS,
				WATCH_PRE_MS,
				WATCH_REACTION_MS,
				WATCH_RECENT_MAX,
				WATCH_SCRIPT_MAX,
				WATCH_TRIGGER_MS,
				bumpTally,
				bundleMap,
				ensureScriptLines,
				evictMapEntries,
				frame,
				frameRing,
				natives,
				noteTallySeverity,
				ownerOfUrl,
				push,
				ring,
				round1,
				scriptEvidence,
				start,
				state
			} = deps;

		/**
		 * 触发判据:低于 WATCH_TRIGGER_MS 的帧不配叫卡顿。纯函数,便于单测,
		 * 也便于回答"为什么这次没抓到"。返回严重度,不触发返回 null。
		 */
		function watchTrigger(ms) {
			return typeof ms === 'number' && ms >= WATCH_TRIGGER_MS ? round1(ms) : null;
		}
		/** 本页性能时钟的原点(墙上时间毫秒)。跨会话读事故时,perf 毫秒要靠它才能对齐。 */
		function perfOrigin() {
			return typeof performance.timeOrigin === 'number' && performance.timeOrigin > 0
				? performance.timeOrigin
				: Date.now() - performance.now();
		}
		/** perf 时间 → 墙上时间。 */
		function wallClock(perfMs) {
			return new Date(perfOrigin() + perfMs).toISOString();
		}
		/** 一条 LoAF 里最多记 WATCH_SCRIPT_MAX 个脚本:只用于回答"谁",不做统计。 */
		function loafScripts(entry) {
			const out = [];
			try {
				const scripts = Array.isArray(entry.scripts) ? entry.scripts : [];
				for (const script of scripts) {
					if (out.length >= WATCH_SCRIPT_MAX) break;
					const scriptUrl = typeof script.sourceURL === 'string' ? script.sourceURL : null;
					// 只要 URL 是**组合**(`plugins/??…`)就预取脚本文本 —— 单包组合
					// (`??<一个包>/client.js`)也算:它的 charPos 同样要靠文本才能换成行号。
					// 以前判据是 `indexOf(',') !== -1`(只看多包),单包组合于是永远停在 text-pending。
					if (scriptUrl !== null && state.precise === true && /\/plugins\/\?\?/.test(scriptUrl)) {
						// 多包:后台把脚本文本与分段表准备好。这两个请求都是浏览器内存缓存命中,
						// 但走的是异步,所以只预取、不在这里等。
						ensureScriptLines(scriptUrl);
						const owner = ownerOfUrl(scriptUrl);
						if (owner !== null && owner.startsWith(BUNDLE_PREFIX)) bundleMap(owner);
					}
					out.push({
						url: scriptUrl,
						fn: typeof script.sourceFunctionName === 'string' && script.sourceFunctionName !== '' ? script.sourceFunctionName : null,
						invoker: typeof script.invoker === 'string' ? script.invoker.slice(0, 80) : null,
						invokerType: script.invokerType ?? null,
						charPos: typeof script.sourceCharPosition === 'number' ? script.sourceCharPosition : null,
						ms: round1(script.duration ?? 0),
						forcedMs: round1(script.forcedStyleAndLayoutDuration ?? 0),
						pauseMs: round1(script.pauseDuration ?? 0),
					});
				}
			} catch (error) { /* 条目形状变了:宁可少记,不要抛 */ }
			return out;
		}
		/** 收一条长动画帧。触发按 blockingDuration —— 它才是"这一帧挡了多久",纯渲染不算卡。 */
		function watchLoaf(entry) {
			const watch = state.watch;
			watch.loafSeq += 1;
			const row = {
				seq: watch.loafSeq,
				t: round1(entry.startTime),
				dur: round1(entry.duration),
				blocking: round1(entry.blockingDuration ?? 0),
				renderStart: round1(entry.renderStart ?? 0),
				styleAndLayoutStart: round1(entry.styleAndLayoutStart ?? 0),
				scripts: loafScripts(entry),
			};
			watch.loaf.push(row);
			if (watch.loaf.length > WATCH_LOAF_MAX) {
				const dropped = watch.loaf.length - WATCH_LOAF_MAX;
				watch.loaf.splice(0, dropped);
				watch.loafDropped += dropped;
			}
			const severity = watchTrigger(row.blocking);
			if (severity !== null) triggerCapture('loaf', entry.startTime, severity);
		}
		/** 装上 LoAF 观察器(可还原:stop() 里 disconnect)。返回状态串,照实写进导出件。 */
		function startLoaf() {
			const watch = state.watch;
			if (watch.loafObserver !== null) return watch.loafState;
			const Observer = W.PerformanceObserver;
			if (typeof Observer !== 'function') return (watch.loafState = 'unsupported:no-PerformanceObserver');
			const supported = Observer.supportedEntryTypes;
			if (Array.isArray(supported) && supported.indexOf('long-animation-frame') === -1) {
				return (watch.loafState = 'unsupported:no-long-animation-frame');
			}
			try {
				const observer = new Observer((list) => {
					for (const entry of list.getEntries()) watchLoaf(entry);
				});
				// 不带 buffered:每次重新挂观察器(disable→enable、HMR 重载)都会把最近 200 条重放
				// 一遍,同一个 startTime 于是被重新触发 —— 实测同一次卡顿裂成了 i2 / i29 / i31
				// 三条不同 id 的事故(时间戳一模一样)。挂上之前的帧我们本来也没采,不需要它。
				observer.observe({ type: 'long-animation-frame' });
				watch.loafObserver = observer;
				watch.loafState = 'on';
			} catch (error) {
				watch.loafState = `error:${error instanceof Error ? error.message : String(error)}`;
			}
			return watch.loafState;
		}
		/**
		 * A4(页面内那一半):交互延迟。
		 *
		 * `event` timing 是页面内**唯一**能拿到"这一下点了多久才反应"的 API:它给端到端时长
		 * (`duration`)与 `processingStart/End`,所以能说清"有多少是排在主线程后面等出来的"。
		 * ⚠️ **不承诺帧内拆分** —— 输入延迟 / 处理 / 呈现这三段的进一步拆分页面内没有 API
		 * (要拆只能看 DevTools 的 Interactions 轨道,已写进 missing)。
		 * `element` timing 只观察带 `elementtiming` 属性的元素,DSH 的 DOM 上没有这个属性,
		 * 所以这一路**大概率恒为 0** —— 照实记 0 并写进导出件,不假装采到了。
		 */
		function watchInteraction(entry) {
			const watch = state.watch;
			const isElement = entry.entryType === 'element';
			if (isElement) watch.elementCount += 1;
			else watch.eventCount += 1;
			const start = entry.startTime ?? 0;
			const processingStart = entry.processingStart ?? start;
			const processingEnd = entry.processingEnd ?? processingStart;
			watch.interactions.push({
				type: entry.entryType,
				// 事件名(click / keydown…)或元素选择器
				name: String(isElement ? (entry.element ?? entry.name ?? '?') : (entry.name ?? '?')).slice(0, 60),
				at: round1(start),
				ms: round1(entry.duration ?? 0),      // 端到端(到下一次渲染更新为止)
				// 下面两个是推导值,但读文件的人第一眼要的就是它们:多少是排队等出来的、多少是处理
				waitMs: round1(processingStart - start),          // 输入延迟:事件发生 → 处理器真正开始
				handlerMs: round1(processingEnd - processingStart),   // 处理器本身
				processingStart: round1(entry.processingStart ?? 0),
				processingEnd: round1(entry.processingEnd ?? 0),
				interactionId: typeof entry.interactionId === 'number' ? entry.interactionId : null,
				// interactionId > 0 才是"一次交互"里的那一批;0 的是 pointerover 这类被动事件
				isInteraction: typeof entry.interactionId === 'number' && entry.interactionId > 0,
				renderTime: isElement ? round1(entry.renderTime ?? 0) : undefined,
			});
			if (watch.interactions.length > WATCH_EVENT_MAX) watch.interactions.splice(0, watch.interactions.length - WATCH_EVENT_MAX);
		}
		/** 装上交互计时观察器(可还原:stop() 里 disconnect)。返回状态串,照实写进导出件。 */
		function startInteractions() {
			const watch = state.watch;
			if (watch.eventObserver !== null) return watch.eventState;
			const Observer = W.PerformanceObserver;
			if (typeof Observer !== 'function') return (watch.eventState = 'unsupported:no-PerformanceObserver');
			const supported = Array.isArray(Observer.supportedEntryTypes) ? Observer.supportedEntryTypes : [];
			watch.eventSupported = supported.filter((type) => type === 'event' || type === 'element');
			if (watch.eventSupported.length === 0) return (watch.eventState = 'unsupported:no-event-timing');
			try {
				const observer = new Observer((list) => {
					for (const entry of list.getEntries()) watchInteraction(entry);
				});
				// 也不带 buffered:挂上之前的事件不属于这段时间的交互(同 LoAF 那条的理由)
				for (const type of watch.eventSupported) {
					if (type === 'event') observer.observe({ type: 'event', durationThreshold: WATCH_EVENT_MS });
					else observer.observe({ type: 'element' });
				}
				watch.eventObserver = observer;
				watch.eventState = 'on';
			} catch (error) {
				watch.eventState = `error:${error instanceof Error ? error.message : String(error)}`;
			}
			return watch.eventState;
		}
		/**
		 * 每帧一次(从 FPS 循环里调)。
		 * 帧间隔超过 WATCH_GAP_MS 说明 rAF 被挂起(标签页隐藏/系统休眠):那是间隙,
		 * 既不算卡顿也不触发 —— 否则每次切回标签页都会"抓到"一次几百秒的假事故。
		 */
		function watchFrame(at, ms, isGap) {
			if (state.watch.on === false) return;
			frameRing.push(at, ms, isGap);
			if (isGap) return;
			const severity = watchTrigger(ms);
			if (severity !== null) triggerCapture('frame', at, severity);
		}
		/**
		 * 起一次捕获。同时只留一个 pending:一次卡顿通常是一串,归并成一条比抓成一堆碎
		 * 事件有用(被归并的次数记进 coalesced,不假装没发生)。
		 */
		function triggerCapture(cause, at, severity, note) {
			const watch = state.watch;
			if (watch.on === false) return null;
			if (watch.pending !== null) { watch.coalesced += 1; bumpTally('coalesced', Date.now()); return null; }
			// 这个时刻已经被上一份事故的窗口覆盖了(证据就在那份包里),别再另立一份 ——
			// 实测过一次卡顿裂成两份(第二份其实只是又碰了一下同一段窗口)。
			// 手动标记例外:那是明确意图,哪怕落在窗口里也收。
			if (cause !== 'manual' && watch.coveredUntil > 0 && at <= watch.coveredUntil) {
				watch.coalesced += 1;
				bumpTally('coalesced', Date.now());
				return null;
			}
			watch.pending = {
				cause, at, severity: round1(severity), note: note ?? null, until: at + WATCH_POST_MS,
				// 窗口完整性的起点状态:环满 + 确实丢过记录 + 最老一条晚于窗口起点 ⇒ 前摇已经丢了记录。
				loafFull: watch.loaf.length >= WATCH_LOAF_MAX,
				loafDroppedAtTrigger: watch.loafDropped,
				loafOldestAt: watch.loaf.length === 0 ? null : watch.loaf[0].t,
				longTaskFull: state.longTasks.length >= 200,
				longTaskDroppedAtTrigger: state.ltDropped,
				longTaskOldestAt: state.longTasks.length === 0 ? null : state.longTasks[0].at,
			};
			// 起一次新捕获 = 检测到一次卡顿(同一串里的后续触发会走上面的 coalesced,不重复计)
			bumpTally('triggered', Date.now());
			const delay = Math.max(0, watch.pending.until - performance.now());
			if (delay <= 0) return settleCapture();
			watch.pendingTimer = natives.setTimeout(settleCapture, Math.ceil(delay));
			return null;
		}
		/**
		 * 留存策略:三档并集。
		 *   ① 全局最差 WATCH_INCIDENT_MAX 条;
		 *   ② 每天最差 1 条,最多最近 WATCH_DAILY_DAYS 天;
		 *   ③ 最近 WATCH_RECENT_MAX 条(**不看严重度**)。
		 * 只有 ① 时,短时间里连抓 10 次就把更早的整天挤掉了;② 保证"每天至少留一条证据";
		 * ③ 保证"刚才那一下"还在清单里 —— 100–150ms 的小现场永远挤不进最差榜,
		 * 而它恰恰是使用者回头要点的第一条。
		 * "抓到了但没留存"和"没抓到"是两件事,所以 dropped 单独计数,不混进 captured。
		 */
		function keepIncident(incident) {
			const watch = state.watch;
			const list = watch.incidents;
			const previous = list.slice();
			const kept = pruneIncidents(previous.concat(incident));
			const survived = kept.indexOf(incident) !== -1;
			const displaced = previous.some((row) => kept.indexOf(row) === -1);
			list.length = 0;
			for (const row of kept) list.push(row);
			if (survived === false) { watch.dropped += 1; bumpTally('dropped', Date.now()); return 'dropped'; }
			return displaced ? 'replaced' : 'kept';
		}
		/** 事故发生在哪一天(本地日期)—— 只用于"每天最差一条"那个档位;取不到时间算 null。 */
		function dayKeyOf(row) {
			const at = Date.parse(row === null || row === undefined ? '' : row.at);
			if (Number.isFinite(at) === false) return null;
			const d = new Date(at);
			// 补零:日期键要按字符串排序取"最近 N 天",'2026-10-8' > '2026-10-10' 是错的
			const p = (n) => String(n).padStart(2, '0');
			return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
		}
		/**
		 * 按三档策略裁一次,并给活下来的每条写上 `tier`(它是靠哪一档留下的)。
		 * 出入都按**严重度降序** —— 落盘的字节裁切(`list.pop()` 丢最弱的)依赖这个不变量。
		 */
		function pruneIncidents(list) {
			const sorted = list.slice().sort((a, b) => b.severity - a.severity);
			const worst = sorted.slice(0, WATCH_INCIDENT_MAX);
			const bestOfDay = new Map();
			for (const row of sorted) {
				const key = row.day ?? dayKeyOf(row);
				row.day = key;
				// 降序遍历:每天碰到的第一条就是当天最差
				if (key === null || bestOfDay.has(key)) continue;
				bestOfDay.set(key, row);
			}
			const days = [...bestOfDay.keys()].sort().slice(-WATCH_DAILY_DAYS);   // 最近的 N 天
			// 最近档按**时刻**排(不是严重度):没有可解析时刻的条目没有资格占这个名额
			const recent = list
				.filter((row) => Number.isFinite(Date.parse(row === null || row === undefined ? '' : row.at)))
				.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
				.slice(0, WATCH_RECENT_MAX);
			const kept = new Set(worst);
			for (const key of days) kept.add(bestOfDay.get(key));
			for (const row of recent) kept.add(row);
			const daily = new Set(days.map((key) => bestOfDay.get(key)));
			const out = sorted.filter((row) => kept.has(row));
			for (const row of out) {
				const inWorst = worst.indexOf(row) !== -1;
				const inDaily = daily.has(row);
				row.tier = inWorst ? (inDaily ? 'both' : 'worst') : (inDaily ? 'daily' : 'recent');
			}
			return out;
		}
		/**
		 * 窗口完整性:用序号断档判断"环是不是把记录挤掉了"。
		 * `rows` 已按时间升序;`dropped = 末序号 − 首序号 + 1 − 实际条数` 精确回答"中间缺了几条"。
		 * `preOverflow` 是另一件事:窗口起点早于环里最老的一条、环当时是满的**且确实丢过记录** —— 开头那段已经丢了,
		 * 但丢了几条无从得知(不编数字,只标原因)。老数据没有 seq 时返回 0,不假装算过。
		 */
		function windowIntegrity(rows, oldestAt, ringFull, droppedAtTrigger, from) {
			const list = Array.isArray(rows) ? rows : [];
			// 环满 ≠ 丢过记录:只有真的丢过(droppedAtTrigger>0)才谈"前摇滚出环"。
			const preOverflow = ringFull === true && droppedAtTrigger > 0 && typeof oldestAt === 'number' && oldestAt > from;
			if (list.length === 0) return { dropped: 0, preOverflow };
			const first = list[0];
			const last = list[list.length - 1];
			if (typeof first.seq !== 'number' || typeof last.seq !== 'number' || last.seq < first.seq) {
				return { dropped: 0, preOverflow: false };
			}
			return { dropped: Math.max(0, last.seq - first.seq + 1 - list.length), preOverflow };
		}
		/**
		 * 把一个事件窗口切成事故包:前摇 WATCH_PRE_MS + 后摇 WATCH_POST_MS,原样带上帧序列、
		 * LoAF 条目、窗口内的 longtask 明细。严重度取"触发时的值"与"窗口里最差帧"的较大者 ——
		 * 手动标记传进来的 0 因此不会因为"不够差"而被留存策略丢掉。
		 */
		function assembleIncident(pending) {
			const from = pending.at - WATCH_PRE_MS;
			const to = pending.until;
			const frames = frameRing.slice(from, to);
			const rows = state.watch.loaf.filter((row) => row.t >= from && row.t <= to);
			// URL 抽表:实测一份事故里同一个 combo URL 会被写 27 遍 —— 116.6KB 里有 75.4KB 是
			// 那个 2.9KB 的 URL 重复(导出的缩进版 138.6KB 里更糟)。脚本只留下标之后:
			// 紧凑 29.6KB / 导出 51.5KB / 512KB 能放 17 条(原来 4 条)。信息一点没少。
			// u = -1 表示这条脚本没有 URL。
			const urls = [];
			const urlIndex = (url) => {
				if (typeof url !== 'string' || url === '') return -1;
				const found = urls.indexOf(url);
				if (found !== -1) return found;
				urls.push(url);
				return urls.length - 1;
			};
			const loaf = rows.map((row) => ({
				t: row.t,
				dur: row.dur,
				blocking: row.blocking,
				renderStart: row.renderStart,
				styleAndLayoutStart: row.styleAndLayoutStart,
				scripts: row.scripts.map((script) => ({
					u: urlIndex(script.url),
					fn: script.fn,
					invoker: script.invoker,
					invokerType: script.invokerType,
					charPos: script.charPos,
					ms: script.ms,
					forcedMs: script.forcedMs,
					pauseMs: script.pauseMs,
				})),
			}));
			const longTasks = state.longTasks.filter((row) => row.at >= from && row.at <= to);
			// A4:窗口内的交互延迟(端到端时长;页面内没有帧内拆分,见 watchInteraction 的说明)
			const interactions = (state.watch.interactions ?? []).filter((row) => row.at >= from && row.at <= to);
			// 窗口完整性:和官方 Inspector 的 sequence gap 同一条纪律 —— 缺口必须显式,不许静默。
			const loafIntegrity = windowIntegrity(rows, pending.loafOldestAt, pending.loafFull, pending.loafDroppedAtTrigger, from);
			const longTaskIntegrity = windowIntegrity(longTasks, pending.longTaskOldestAt, pending.longTaskFull, pending.longTaskDroppedAtTrigger, from);
			const integrityReasons = [];
			if (loafIntegrity.dropped > 0) integrityReasons.push('loaf-ring-overflow');
			if (longTaskIntegrity.dropped > 0) integrityReasons.push('longtask-ring-overflow');
			if (loafIntegrity.preOverflow) integrityReasons.push('loaf-pre-window-overflow');
			if (longTaskIntegrity.preOverflow) integrityReasons.push('longtask-pre-window-overflow');
			const integrity = {
				captureComplete: integrityReasons.length === 0,
				loafDropped: loafIntegrity.dropped,
				longTaskDropped: longTaskIntegrity.dropped,
				loafKept: rows.length,
				longTaskKept: longTasks.length,
				reasons: integrityReasons,
			};
			let worst = null;
			let live = 0;
			let over50 = 0;
			let over100 = 0;
			let gaps = 0;
			const durations = [];
			for (const row of frames) {
				if (row.gap) { gaps += 1; continue; }
				live += 1;
				durations.push(row.ms);
				if (row.ms >= 50) over50 += 1;
				if (row.ms >= 100) over100 += 1;
				if (worst === null || row.ms > worst.ms) worst = row;
			}
			durations.sort((a, b) => a - b);
			const quantile = (p) => (durations.length === 0 ? null : round1(durations[Math.min(durations.length - 1, Math.floor(p * durations.length))]));
			const pick50 = quantile(0.5);
			const pick90 = quantile(0.9);
			const pick99 = quantile(0.99);
			// 每条脚本尽力定包名(拿不到就写清 via),再按包汇总一次 ——
			// 「是谁」在合并批里原来只能给到那个 58 包的 URL,等于没有答案。
			// 现在顺手把**文件与行号**也按同一份证据函数算出来(面板与导出件共用这套 via 码):
			// 面板那一块能定位到"哪个文件的哪一段",事故包离开现场后也还留着这两样。
			// ⚠️ 切片是**当时**算的:脚本文本 / sourcemap 还没到位时 lineVia 就是 text-pending,
			// 照实记 —— 不给"事后补算"的假位置(事后补的会与这份包的其它读数不同源)。
			for (const row of loaf) {
				for (const script of row.scripts) {
					const evidence = scriptEvidence(script, script.u >= 0 ? urls[script.u] : '');
					script.pkg = evidence.pkg;
					script.pkgVia = evidence.pkgVia;
					script.file = evidence.file;
					script.line = evidence.line;
					script.lineVia = evidence.lineVia;
					// 行号属于哪个坐标系(合并大文件 / 那个文件自己)—— 存进包,面板与导出件才不用现推
					script.lineScope = evidence.lineScope;
				}
			}
			const scripts = [];
			for (const row of loaf) for (const script of row.scripts) scripts.push({ at: row.t, ...script });
			scripts.sort((a, b) => b.ms - a.ms);
			const byPkg = new Map();
			let pkgResolved = 0;
			for (const script of scripts) {
				if (script.pkg === null) continue;
				pkgResolved += 1;
				const row = byPkg.get(script.pkg);
				if (row === undefined) byPkg.set(script.pkg, { pkg: script.pkg, ms: script.ms, count: 1 });
				else { row.ms = round1(row.ms + script.ms); row.count += 1; }
			}
			const packages = [...byPkg.values()].sort((a, b) => b.ms - a.ms);
			const pkgVia = {};
			for (const script of scripts) {
				const key = script.pkgVia === null || script.pkgVia === undefined ? 'unknown' : script.pkgVia;
				pkgVia[key] = (pkgVia[key] ?? 0) + 1;
			}
			let blocking = 0;
			for (const row of loaf) blocking += row.blocking;
			// 最差那一帧有没有 JS 解释?用 longtask / LoAF 与它的区间是否重叠判。
			// 再往前一步:如果它既没有 JS 证据、前后又都是健康帧,那更可能是**浏览器把 rAF
			// 节流/挂起了一次**(Windows 遮挡、省电),不是页面真的忙了这么久 —— 实测有一帧
			// 983.7ms,前后都是 16.7ms(正好 60fps),而 983.7 恰好卡在 1 秒间隙线下面。
			let worstJs = 'none';
			let suspectedThrottle = false;
			let neighboursMs = null;
			if (worst !== null) {
				const start = worst.t - worst.ms;
				const end = worst.t;
				const hasJs = longTasks.some((row) => row.at < end && row.at + row.ms > start)
					|| loaf.some((row) => row.t < end && row.t + row.dur > start);
				worstJs = hasJs ? 'js' : 'none';
				const index = frames.indexOf(worst);
				const around = frames.slice(Math.max(0, index - 5), index).concat(frames.slice(index + 1, index + 6))
					.filter((row) => row.gap === false).map((row) => row.ms).sort((a, b) => a - b);
				neighboursMs = around.length === 0 ? null : round1(around[Math.floor(around.length / 2)]);
				suspectedThrottle = worst.ms >= 500 && hasJs === false && neighboursMs !== null && neighboursMs < WATCH_TRIGGER_MS;
			}
			return {
				id: `i${(state.watch.seq += 1)}`,
				cause: pending.cause,          // frame / loaf / manual
				note: pending.note,
				kept: null,                    // settleCapture 填 kept / replaced / dropped
				severity: round1(Math.max(pending.severity, worst === null ? 0 : worst.ms)),
				atPerfMs: round1(pending.at),
				at: wallClock(pending.at),
				window: {
					fromMs: round1(from), toMs: round1(to),
					preMs: WATCH_PRE_MS, postMs: WATCH_POST_MS,
					from: wallClock(from), to: wallClock(to),
				},
				// 这份现场**采全了没有**。false 时不要把它当完整证据:面板、missing、manifest 都会标。
				integrity,
				summary: {
					worstFrameMs: worst === null ? null : worst.ms,
					worstFrameAt: worst === null ? null : wallClock(worst.t),
					frames: live,
					framesOver50Ms: over50,
					framesOver100Ms: over100,
					hiddenGaps: gaps,
					loafEntries: loaf.length,
					blockingMs: round1(blocking),
					pkgCoverage: { resolved: pkgResolved, total: scripts.length },   // 有名字的脚本占比
					pkgVia,                       // 每一条脚本"是怎么定名的"(url / section / not-plugin / …)
					longTasksInWindow: longTasks.length,
					interactionsInWindow: interactions.length,   // A4:窗口内的交互次数(≥100ms 的那些)
					topScripts: scripts.slice(0, 5).map((script) => ({
						at: script.at, u: script.u, ms: script.ms, fn: script.fn,
						invoker: script.invoker, invokerType: script.invokerType, charPos: script.charPos,
						// 「打开哪个文件、哪一段」:file = 包内那份文件(section 的 sources),
						// line = **脚本文本自己的行号**(不是原始源码行),两个 via 码说明它们是怎么来的
						pkg: script.pkg, pkgVia: script.pkgVia,
						file: script.file, line: script.line, lineVia: script.lineVia, lineScope: script.lineScope,
					})),
					// 窗口自己的分位:没有它,howToRead 里那句"拿 summary 和 baseline 比"在
					// 文件内根本没法执行(实测一位只读文件的读者就卡在这)
					p50: pick50,
					p90: pick90,
					p99: pick99,
					worstFrameJs: worstJs,                  // js = 有 longtask/LoAF 重叠;none = 没有任何 JS 解释
					worstFrameNeighboursMs: neighboursMs,   // 最差帧前后各 5 帧的中位(健康帧 ≈ 16.7ms)
					suspectedThrottle,                      // true = 更像 rAF 被节流/挂起,而不是页面真忙
					streaming: state.streaming,
					visibility: document.visibilityState,
				},
				urls,                          // 脚本 URL 表(scripts[].u 是它的下标)
				packages,                      // 按包汇总的脚本耗时(降序):「是谁」在这一层才有答案
				frames,
				loaf,
				longTasks,
				interactions,
				baseline: frameRing.stats(from, to),   // 排除本窗口之后的分布:含自己就永远"比不上"
				host: state.host === null || state.host === undefined ? null : {
					at: state.hostAt > 0 ? new Date(state.hostAt).toISOString() : null,
					// 快照年龄:这份宿主数据是事故时刻之前多少毫秒采到的(正 = 更早,负 = 事故之后才采到)。
					// 以前这里写的是"距现在多久",口径没定义,读的人只能猜。
					snapshotAgeMs: state.hostAt > 0 ? Math.round(perfOrigin() + pending.at - state.hostAt) : null,
					eventLoop: state.host.eventLoop ?? null,
				},
				env: {
					domNodes: state.dom.total,
					heapUsedBytes: state.heap,
					instrumented: state.on && state.deep === true,
					deep: state.deep === true,
					precise: state.precise,
					// 跨会话(落盘后重开页面)读这份事故时,perf 毫秒要靠它才能对齐墙上时间
					perfOrigin: new Date(perfOrigin()).toISOString(),
					// 渲染环境:判断"这段是坏还是这台机器一直这样"的另一个前提
					viewport: `${W.innerWidth}×${W.innerHeight}`,
				// 本地时区偏移(分钟,UTC+8 = 480)—— 只读文件的人靠它把 ISO 换成本地时间;
				// 注意 JS 的 getTimezoneOffset() 符号是反的
				utcOffsetMin: -new Date().getTimezoneOffset(),
					devicePixelRatio: W.devicePixelRatio,
					hardwareConcurrency: navigator.hardwareConcurrency ?? null,
					visibility: document.visibilityState,
				},
			};
		}
		/** 后摇到点:切片、计数、按策略留存。 */
		function settleCapture() {
			const watch = state.watch;
			if (watch.pendingTimer !== 0) { natives.clearTimeout(watch.pendingTimer); watch.pendingTimer = 0; }
			const pending = watch.pending;
			watch.pending = null;
			if (pending === null) return null;
			const incident = assembleIncident(pending);
			watch.captured += 1;
			// 计数与留存分开记:上面那个 captured 是**本次会话**的计数,下面这份是跨刷新的时间桶
			const now = Date.now();
			bumpTally('captured', now);
			noteTallySeverity(now, incident.severity);
			incident.kept = keepIncident(incident);
			watch.coveredUntil = pending.until;   // 这段窗口已经有主了,见 triggerCapture 的去重
			saveIncidents();
			return incident;
		}
		/**
		 * 落盘:事故要能活过刷新 —— "等了很久才抓到"的东西丢了最肉疼。
		 * localStorage 有配额,所以三步兜底:超过字节上限就丢最弱的 → 写失败再把列表砍半重试 →
		 * 仍失败就把原因记进 persistError,并在 watch() 里照实说"这次没能落盘"。
		 */
		function saveIncidents() {
			const watch = state.watch;
			// 按触发时刻去重:同一 at(0.1ms 精度)就是同一次事件 —— 即使 id 不同也只留一条。
			// 这是兜底:buffered 重放那条根因已修,但读回来的旧数据里可能还带着重复。
			const seenAt = new Set();
			const list = [];
			for (const row of watch.incidents) {
				// 只有两个字段都在才谈得上"同一次事件";缺字段的一律不参与去重(不能把它们
				// 当成同一条而把真事故吃掉)。
				const key = typeof row.at === 'string' && typeof row.cause === 'string' ? `${row.at}|${row.cause}` : null;
				if (key !== null) {
					if (seenAt.has(key)) { watch.deduped += 1; continue; }
					seenAt.add(key);
				}
				list.push(row);
			}
			const afterDedupe = list.length;
			for (let attempt = 0; attempt < 3; attempt += 1) {
				let payload;
				try {
					payload = JSON.stringify({ v: 1, savedAt: Date.now(), incidents: list });
				} catch (error) {
					watch.persistError = `serialize:${error instanceof Error ? error.message : String(error)}`;
					bumpTally('failed', Date.now());
					return false;
				}
				if (payload.length > WATCH_PERSIST_MAX_BYTES && list.length > 1) {
					// 按严重度降序裁最弱的那条,但**最近档**最后才动:它是使用者回头要点的那几条。
					// 全清单只剩最近档时退回"丢掉最弱的",否则会死循环。
					let at = list.length - 1;
					for (let i = list.length - 1; i >= 0; i -= 1) {
						if (list[i].tier !== 'recent') { at = i; break; }
					}
					list.splice(at, 1);
					continue;
				}
				try {
					localStorage.setItem(LS_INCIDENTS, payload);
					watch.persistError = null;
					// 内存里也按同一份裁掉:"看到的"必须等于"刷新后还在的"。
					// 以前这里只裁落盘的那份,面板说"抓到 10 次"、刷新后可能只回来 7 条,对不上。
					// 两个计数分开:去重的算 deduped,字节装不下的才算 trimmedByBytes。
					if (watch.incidents.length !== list.length) {
						watch.incidents.length = 0;
						for (const row of list) watch.incidents.push(row);
					}
					// 裁掉的那部分进计数桶(单列成 trimmed,不混进 dropped:一个是"没比留存更好",
					// 一个是"字节装不下",原因不同,读数的人要能分辨)
					const trimmedNow = Math.max(0, afterDedupe - list.length);
					watch.trimmedByBytes += trimmedNow;
					if (trimmedNow > 0) bumpTally('trimmed', Date.now(), trimmedNow);
					return true;
				} catch (error) {
					watch.persistError = error instanceof Error ? error.message : String(error);
					// 配额不够时**先丢可重建的 sourcemap 分段表**,别拿证据换缓存;清掉之后重试一轮
					if (typeof evictMapEntries === 'function' && evictMapEntries(2) > 0) continue;
					if (list.length > 1) { list.length = Math.ceil(list.length / 2); continue; }
					bumpTally('failed', Date.now());
					return false;
				}
			}
			bumpTally('failed', Date.now());
			return false;
		}
		/** 读回落盘的事故。形状不对的条目直接丢(丢了不会静默:restored 会告诉你读回几条)。 */
		function restoreIncidents() {
			const watch = state.watch;
			let parsed = null;
			try { parsed = JSON.parse(localStorage.getItem(LS_INCIDENTS) ?? 'null'); } catch (error) { return; }
			if (parsed === null || Array.isArray(parsed.incidents) === false) return;
			const rows = [];
			for (const row of parsed.incidents) {
				if (row === null || typeof row !== 'object') continue;
				if (typeof row.id !== 'string' || typeof row.severity !== 'number') continue;
				if (Array.isArray(row.frames) === false || Array.isArray(row.loaf) === false) continue;
				row.restored = true;   // 跨会话的 perf 毫秒要靠 env.perfOrigin 对齐,标出来免得误读
				rows.push(row);
			}
			rows.sort((a, b) => b.severity - a.severity);
			// 同一个 id 只留一条:实测落盘里出现过同一条事故被存了三遍(占掉 3 个留存位),
			// 原因没复现出来(disable→enable 不会重复),所以这里按 id 兜住 —— 有牙齿的是断言。
			const seen = new Set();
			const unique = [];
			for (const row of rows) {
				const key = typeof row.at === 'string' && typeof row.cause === 'string' ? `${row.at}|${row.cause}` : null;
				if (key !== null) {
					if (seen.has(key)) { watch.deduped += 1; continue; }
					seen.add(key);
				}
				unique.push(row);
			}
			// 读回来也按同一份两档策略裁一遍:落盘那份是旧版本写的、或天数已经翻过去了,
			// 都可能比现在的上限多。裁不动也要保证"看到的 = 刷新后还在的"。
			watch.incidents = pruneIncidents(unique);
			watch.restored = watch.incidents.length;
			// 新事故的序号从读回来的最大 id 之后继续,否则新 id 会和旧的撞(旧包里的 i2 撞了三次)
			for (const row of watch.incidents) {
				const n = /^i(\d+)$/.exec(row.id);
				if (n !== null) watch.seq = Math.max(watch.seq, Number(n[1]));
			}
		}
		/**
		 * 手动标记"刚刚卡了一下":回退 WATCH_REACTION_MS(默认 3 秒,人的反应时间),
		 * 立刻切片(不等后摇)。note 原样进事故包,方便事后知道当时在干什么。
		 */
		function captureNow(note) {
			if (state.watch.on === false) return { ok: false, reason: 'not-recording(HUD 关闭时不记录)' };
			const incident = triggerCapture('manual', performance.now() - WATCH_REACTION_MS, 0, note ?? null);
			return incident === null ? { ok: false, reason: 'coalesced(已并进正在等的那一次)' } : { ok: true, incident };
		}
		/** 守夜层状态:装没装上、录了多少、抓到几次 —— 一律照实,不写"运行中"。 */
		function watchStatus() {
			const watch = state.watch;
			const oldest = frameRing.size === 0 ? 0 : frameRing.at[(frameRing.head - frameRing.size + WATCH_FRAMES) % WATCH_FRAMES];
			return {
				recording: watch.on,
				loaf: watch.loafState,
				// A4:交互延迟(event / element timing)。面板不显示,导出件里照实写状态与计数
				interactions: {
					state: watch.eventState,
					supported: watch.eventSupported,
					thresholdMs: WATCH_EVENT_MS,
					events: watch.eventCount,
					elements: watch.elementCount,
					kept: watch.interactions.length,
				},
				frameSamples: frameRing.size,
				frameBudget: WATCH_FRAMES,
				coveredMs: oldest === 0 ? 0 : round1(performance.now() - oldest),
				loafEntries: watch.loaf.length,
				pending: watch.pending === null ? null : { cause: watch.pending.cause, severity: watch.pending.severity },
				captured: watch.captured,
				coalesced: watch.coalesced,
				dropped: watch.dropped,
				restored: watch.restored,
				trimmedByBytes: watch.trimmedByBytes,
				deduped: watch.deduped,
				persistError: watch.persistError,
				kept: watch.incidents.map((row) => ({ id: row.id, severity: row.severity, cause: row.cause, at: row.at, note: row.note, tier: row.tier ?? null, day: row.day ?? null })),
				triggers: {
					frameMs: WATCH_TRIGGER_MS, gapMs: WATCH_GAP_MS,
					preMs: WATCH_PRE_MS, postMs: WATCH_POST_MS, keep: WATCH_INCIDENT_MAX,
					dailyDays: WATCH_DAILY_DAYS, keepMax: WATCH_KEEP_MAX,
					reactionMs: WATCH_REACTION_MS,
				},
			};
		}

			return {
				watchTrigger,
				perfOrigin,
				wallClock,
				loafScripts,
				watchLoaf,
				startLoaf,
				watchInteraction,
				startInteractions,
				watchFrame,
				triggerCapture,
				keepIncident,
				dayKeyOf,
				pruneIncidents,
				windowIntegrity,
				assembleIncident,
				settleCapture,
				saveIncidents,
				restoreIncidents,
				captureNow,
				watchStatus
			};
		};
		exports.ready = true;
		return exports;
	},
});
