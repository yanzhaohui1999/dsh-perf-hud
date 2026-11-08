/**
 * 事故回放站的核心(零依赖、纯函数):读导出的 zip / incident.json,现算一遍摘要与归因。
 *
 * 为什么单独一个文件:同一份逻辑要给两处用 —— `preview/replay.html`(浏览器里拖文件)
 * 与 `tests/replay.mjs`(离线断言"回放器算出来的数 == 包里 summary 记的数")。页面与测试
 * 共用一份实现,才不会出现"页面显示对了、测试测的是另一份代码"。
 *
 * ⚠️ 它**不重新实现**插件的采集/归因:只做"读包 + 用包里的 frames/loaf 现算摘要"。
 * 归因(按包 / 可疑脚本 / long task)直接摊包里的 packages / summary.topScripts / longTasks ——
 * 那些是面板与导出件同源的数据,回放器只负责画。
 */
(function (root) {
	const round1 = (value) => Math.round(value * 10) / 10;
	const has = (object, key) => object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);

	/** 帧档位:与面板 / 导出件 ASCII 条带同一组阈值(≥100 红 / ≥50 黄 / gap 表示 rAF 挂起)。 */
	function frameLevel(ms, gap) {
		if (gap === true) return 'gap';
		if (typeof ms !== 'number' || Number.isFinite(ms) === false) return 'none';
		if (ms >= 100) return 'bad';
		if (ms >= 50) return 'warn';
		return 'ok';
	}

	function quantile(sorted, p) {
		if (sorted.length === 0) return null;
		return round1(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
	}

	/**
	 * 从 incident 的 frames / loaf 现算摘要。口径与 `client.watch.js` 的 `assembleIncident()` 一致:
	 * 只统计非 gap 帧,分位取 `sorted[floor(p*n)]`,毫秒一律 round1。
	 */
	function computeSummary(incident) {
		const frames = Array.isArray(incident?.frames) ? incident.frames : [];
		const live = frames.filter((row) => row.gap !== true);
		const durations = live.map((row) => row.ms).sort((a, b) => a - b);
		let worst = null;
		for (const row of live) if (worst === null || row.ms > worst.ms) worst = row;
		const origin = typeof incident?.env?.perfOrigin === 'string' ? Date.parse(incident.env.perfOrigin) : null;
		const wallOf = (t) => (origin === null || origin !== origin || typeof t !== 'number' ? null : new Date(origin + t).toISOString());
		const loaf = Array.isArray(incident?.loaf) ? incident.loaf : [];
		return {
			frames: live.length,
			framesOver50Ms: durations.filter((ms) => ms >= 50).length,
			framesOver100Ms: durations.filter((ms) => ms >= 100).length,
			hiddenGaps: frames.length - live.length,
			p50: quantile(durations, 0.5),
			p90: quantile(durations, 0.9),
			p99: quantile(durations, 0.99),
			worstFrameMs: worst === null ? null : round1(worst.ms),
			worstFrameAt: worst === null ? null : wallOf(worst.t),
			loafEntries: loaf.length,
			blockingMs: round1(loaf.reduce((sum, row) => sum + (typeof row.blocking === 'number' ? row.blocking : 0), 0)),
			longTasksInWindow: Array.isArray(incident?.longTasks) ? incident.longTasks.length : 0,
		};
	}

	/** 包内 summary 与现算值逐项比。老包缺的字段跳过(不把"没写"算成"不一致")。 */
	const COMPARE_FIELDS = ['frames', 'framesOver50Ms', 'framesOver100Ms', 'hiddenGaps', 'p50', 'p90', 'p99',
		'worstFrameMs', 'worstFrameAt', 'loafEntries', 'blockingMs', 'longTasksInWindow'];
	function compareSummary(incident) {
		const computed = computeSummary(incident);
		const pack = incident?.summary ?? {};
		const diffs = [];
		const compared = [];
		for (const key of COMPARE_FIELDS) {
			if (has(pack, key) === false) continue;
			compared.push(key);
			const a = pack[key];
			const b = computed[key];
			// 毫秒是 round1 过的:允许 0.05 的浮点漂移,别让两个 round1 的加法顺序差异变成假红
			const equal = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 0.05 : a === b;
			if (equal === false) diffs.push({ key, pack: a, computed: b });
		}
		// 一个键都没比 = **没比对过**,不是"一致":空 summary 的包不该拿到绿勾。
		return { computed, pack, diffs, compared, comparable: compared.length > 0, matches: compared.length > 0 && diffs.length === 0 };
	}

	/** 归因:直接摊包里已有的三份(面板与导出件同源),不另算。 */
	function attribution(incident) {
		const summary = incident?.summary ?? {};
		const packages = (Array.isArray(incident?.packages) ? incident.packages : [])
			.map((row) => ({ pkg: row.pkg, ms: round1(row.ms ?? 0), count: row.count ?? 0 }))
			.sort((a, b) => b.ms - a.ms);
		const suspects = Array.isArray(summary.topScripts) ? summary.topScripts : [];
		const longTasks = (Array.isArray(incident?.longTasks) ? incident.longTasks : [])
			.map((row) => ({ at: row.at, ms: row.ms, owner: row.owner, component: row.component ?? null, source: row.source ?? null }))
			.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
		return { packages, suspects, longTasks };
	}

	// ── zip(store 模式)读方:本插件的导出包就是 store,所以不需要 deflate ──
	function unzipStore(input) {
		const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
		if (bytes.length < 22) throw new Error('文件太小,不是 zip');
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let eocd = -1;
		const floor = Math.max(0, bytes.length - 22 - 0xffff);
		for (let i = bytes.length - 22; i >= floor; i -= 1) {
			if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
		}
		if (eocd === -1) throw new Error('这不是一个 zip(找不到目录结尾 EOCD)');
		const count = view.getUint16(eocd + 10, true);
		const cdOffset = view.getUint32(eocd + 16, true);
		const decoder = new TextDecoder();
		const files = new Map();
		let at = cdOffset;
		for (let index = 0; index < count; index += 1) {
			if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`第 ${index + 1} 个中央目录项不是 ZIP 头`);
			const method = view.getUint16(at + 10, true);
			const compressed = view.getUint32(at + 20, true);
			const nameLen = view.getUint16(at + 28, true);
			const extraLen = view.getUint16(at + 30, true);
			const commentLen = view.getUint16(at + 32, true);
			const localOffset = view.getUint32(at + 42, true);
			const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
			if (method !== 0) throw new Error(`${name} 是 deflate 压缩的 —— 本回放器只认 store(本插件导出包就是 store)`);
			if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`${name} 的本地文件头不对`);
			const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
			files.set(name, decoder.decode(bytes.subarray(start, start + compressed)));
			at += 46 + nameLen + extraLen + commentLen;
		}
		return files;
	}

	/**
	 * 认三种输入:完整包(四份文件里的 incident.json + manifest.json)、单份 incident.json、
	 * 事故切片 `{incident, thresholds, redaction}`(仓库自带的 fixture 就是它)。
	 */
	function parsePack(input) {
		const files = input instanceof Map ? input : null;
		let report = null;
		let manifest = null;
		if (files !== null) {
			if (files.has('incident.json') === false) throw new Error('包里没有 incident.json');
			report = JSON.parse(files.get('incident.json'));
			if (has(report, 'incident') === false) throw new Error('incident.json 里没有 incident 对象');
			if (files.has('manifest.json')) manifest = JSON.parse(files.get('manifest.json'));
		} else {
			const value = typeof input === 'string' ? JSON.parse(input) : input;
			if (value === null || typeof value !== 'object') throw new Error('不是 JSON 对象');
			if (value.kind === 'perf-hud-incident' || has(value, 'context')) report = value;
			else if (has(value, 'incident')) report = value;          // 切片:{incident, thresholds, redaction}
			else if (Array.isArray(value.frames) && value.summary !== undefined) report = { incident: value };
			else throw new Error('认不出这是事故包 / incident.json / 事故切片');
			if (has(report, 'incident') === false) throw new Error('里面没有 incident 对象');
		}
		return { manifest, report, incident: report.incident };
	}

	root.ReplayCore = { frameLevel, computeSummary, compareSummary, attribution, unzipStore, parsePack, COMPARE_FIELDS };
})(typeof window === 'undefined' ? globalThis : window);
