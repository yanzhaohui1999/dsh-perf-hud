/**
 * dsh-perf-hud 的包内分片:诊断与视图模型。
 *
 * 归因证据链 / 能力矩阵 / 可能原因 / 诊断包 / 视图模型与摘要,**全部是纯读函数**
 * (输入 state 与已算好的数据,输出字符串或对象)。渲染层与主文件都通过
 * `createModel(deps)` 拿同一份实现,不各自复制一套。
 */
window.__ModuleLoader__.load({
	id: 'dsh-perf-hud',
	chunk: 'client.model.js',
	factory: (require) => {
		const exports = {};
		exports.createModel = (deps) => {
			const {
				BUNDLE_PREFIX,
				CAUSE_MAX,
				CROSS_SUMMARY_NAME_MAX,
				CROSS_SUMMARY_SRC_MAX,
				EVIDENCE_MAX,
				EXPERIMENT_LOAD_BURN_MS,
				EXPERIMENT_LOAD_PERIOD_MS,
				FETCH_TIMEOUT_MS,
				FREE_TEXT_KEYS,
				HOME_PATH,
				HOST_ROUTE,
				LS_MAP,
				LS_MAP_INDEX,
				MAP_CACHE_MAX,
				MUT_SAMPLE,
				PACK_SCHEMA_VERSION,
				PAGE_KEYS,
				PICK_MIN_MS,
				PKG,
				PLUGIN_URL,
				REPLAY_COLS,
				SCRIPT_LINES_MAX,
				SCRIPT_URL_KEYS,
				SECRET_PARAM,
				SECRET_PARAM_NAMES,
				SPARK_COLORS,
				SPARK_HEIGHT,
				SPARK_MAX_MS,
				SPARK_SECONDS,
				TALLY_BUCKET_MS,
				TALLY_MINUTES,
				TARGETS,
				TOP_N,
				W,
				WATCH_DAILY_DAYS,
				WATCH_EVENT_MS,
				WATCH_GAP_MS,
				WATCH_INCIDENT_MAX,
				WATCH_KEEP_MAX,
				WATCH_POST_MS,
				WATCH_PRE_MS,
				WATCH_REACTION_MS,
				WATCH_TRIGGER_MS,
				WIN_HOME_PATH,
				blame,
				blameText,
				bundleMaps,
				bundleMeta,
				clipName,
				clock,
				docLang,
				domWriteTable,
				experiment,
				fallback,
				flush,
				frame,
				frameRing,
				h,
				hostFreshness,
				hostLoopText,
				incidentTallyCache,
				linkRowText,
				linkStats,
				loafScripts,
				longTaskTally,
				markResolved,
				natives,
				noiseFloor,
				perfOrigin,
				pluginTable,
				primaryBlame,
				push,
				rate,
				rateText,
				resolveStamp,
				ring,
				round1,
				scriptLines,
				scriptTallyCache,
				selectIncidentFrame,
				selfStats,
				sessionBaselines,
				setPrecise,
				short,
				start,
				state,
				stop,
				suspectLink,
				tallyReport,
				tallyWindow,
				translate,
				verification,
				viaLabel,
				wallClock,
				watchStatus,
				worstLongTask,
				zipStore
			} = deps;

		function timeoutError(ms) {
			const error = new Error(`timeout ${ms}ms`);
			error.name = 'TimeoutError';
			return error;
		}
		function cancelledError() {
			const error = new Error('cancelled');
			error.name = 'AbortError';
			return error;
		}
		function isAbortError(error) {
			return error !== null && typeof error === 'object' && error.name === 'AbortError';
		}
		function fetchFailureText(error, ms) {
			if (isAbortError(error)) return 'cancelled';
			if (error !== null && typeof error === 'object' && error.name === 'TimeoutError') return `timeout ${ms}ms`;
			return error instanceof Error ? error.message : String(error);
		}
		/**
		 * 同源 fetch + 读取 body,并受两个上限约束:单次 `ms` 与当前采集代。
		 * ⚠️ 读 body 也包在 deadline 里 —— 只把 `fetch()` resolve 当完成会让慢 body 永远 pending。
		 */
		async function fetchTextWithin(url, options, ms) {
			const epoch = state.epoch;
			const controller = new AbortController();
			let timedOut = false;
			const timer = natives.setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, ms);
			const outer = state.abort === null || state.abort === undefined ? null : state.abort.signal;
			const onAbort = () => controller.abort();
			if (outer !== null) {
				if (outer.aborted) controller.abort();
				else outer.addEventListener('abort', onAbort, { once: true });
			}
			try {
				const response = await fetch(url, { ...options, signal: controller.signal });
				const text = await response.text();
				if (state.epoch !== epoch) throw cancelledError();
				return { response, text };
			} catch (error) {
				if (timedOut) throw timeoutError(ms);
				if (outer !== null && outer.aborted) throw cancelledError();
				if (state.epoch !== epoch) throw cancelledError();
				throw error;
			} finally {
				natives.clearTimeout(timer);
				if (outer !== null) outer.removeEventListener('abort', onAbort);
			}
		}
		/** 同源 JSON 读取:HTTP 状态由调用方判断,但 body 必须是合法 JSON。 */
		async function fetchJsonWithin(url, options, ms) {
			const { response, text } = await fetchTextWithin(url, options, ms);
			let data;
			try {
				data = JSON.parse(text);
			} catch (error) {
				throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
			}
			return { response, data };
		}
		function ownerOfUrl(url) {
			const m = PLUGIN_URL.exec(url);
			if (m === null) return null;
			if (m[1] !== undefined) {
				const ids = m[1].split(',').map((s) => s.replace(/\/[^/,]+\.js(\.map)?$/, '')).filter(Boolean);
				if (ids.length === 0) return null;
				if (ids.length === 1) return ids[0];
				// 多包同 URL:包名只能由 section 分段表还原,不再拼成一串包名糊弄面板。
				const key = BUNDLE_PREFIX + url;
				state.bundleKeys.add(key);
				if (state.bundleKeys.size > 50) state.bundleKeys.delete(state.bundleKeys.values().next().value);
				return BUNDLE_PREFIX + url;
			}
			return m[2] ?? null;
		}
		/** 把栈帧里可能出现的相对 URL 绝对化。 */
		function absolutePluginUrl(url) {
			if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) return url;
			const at = url.indexOf('plugins/??');
			return `${location.origin}/${at === -1 ? url.replace(/^\//, '') : url.slice(at)}`;
		}
		/** 合并脚本 URL → 它的 indexed sourcemap URL(给列表里每一项加 .map,按 loader 的 comboSearch 形态)。 */
		function mapUrlOf(scriptUrl) {
			const at = scriptUrl.indexOf('??');
			if (at === -1) return null;
			const revAt = scriptUrl.indexOf('&rev=');
			const list = scriptUrl.slice(at + 2, revAt === -1 ? undefined : revAt);
			if (list === '') return null;
			const mapped = list.split(',').map((item) => `${item}.map`).join(',');
			return `${scriptUrl.slice(0, at + 2)}${mapped}${revAt === -1 ? '' : scriptUrl.slice(revAt)}`;
		}
		/** 一个 section 属于哪个包:优先按 sources 里的 /plugins/<包>/ 取。 */
		function sectionName(section) {
			const sources = section?.map?.sources;
			if (Array.isArray(sources) === false) return null;
			for (const source of sources) {
				if (typeof source !== 'string') continue;
				const m = /\/plugins\/((?:@[^/]+\/)?[^/?#]+)\//.exec(source);
				if (m !== null) return m[1];
			}
			return null;
		}
		/** 合并批次的名字与包数:优先读 boot payload,其次数 URL 里的逗号列表。 */
		function bundleMetaOf(key) {
			const cached = bundleMeta.get(key);
			if (cached !== undefined) return cached;
			const scriptUrl = absolutePluginUrl(key.slice(BUNDLE_PREFIX.length));
			const list = /\/plugins\/\?\?([^&]+)/.exec(scriptUrl);
			let meta = { phase: '', count: list === null ? 0 : list[1].split(',').length };
			const boot = W.__DSH_BOOT__;
			if (boot !== null && typeof boot === 'object' && Array.isArray(boot.batches)) {
				const relative = scriptUrl.replace(`${location.origin}/`, '');
				for (const batch of boot.batches) {
					if (batch?.url !== relative && batch?.url !== scriptUrl) continue;
					meta = { phase: typeof batch.phase === 'string' ? batch.phase : '', count: Array.isArray(batch.entries) ? batch.entries.length : meta.count };
					break;
				}
			}
			bundleMeta.set(key, meta);
			return meta;
		}
		/** 面板/归因表里显示的一行:批次名 + 包数(+状态),绝不展开成 58 个名字。 */
		function bundleLabel(key) {
			const meta = bundleMetaOf(key);
			if (state.precise === false) return `${meta.phase === '' ? '合并' : meta.phase}批次(${meta.count} 包)`;
			const entry = bundleMaps.get(key);
			const status = entry === undefined || entry.state === 'pending'
				? '·解析中'
				: entry.state === 'ready' ? '' : `·map失败(${entry.reason})`;
			return `${meta.phase === '' ? '合并' : meta.phase}批次(${meta.count} 包)${status}`;
		}
		/**
		 * 懒加载 + 按 rev 缓存。只有「精确归因」打开、并且真的遇到多包 URL 时才拉 map,
		 * 而且同一 rev 只解析一次(12.8MB 只下这一次)。
		 */
		function bundleMap(key) {
			const existing = bundleMaps.get(key);
			if (existing !== undefined) {
				// 上一代被 stop() 取消的条目不留成永久失败:下次开启精确归因时重新排队。
				if (existing.state === 'failed' && existing.reason === 'cancelled') bundleMaps.delete(key);
				else {
					// 访问即刷新 LRU 位置(内存缓存也有上限)。
					bundleMaps.delete(key);
					bundleMaps.set(key, existing);
					return existing;
				}
			}
			const scriptUrl = absolutePluginUrl(key.slice(BUNDLE_PREFIX.length));
			const entry = { state: 'pending', offsets: null, names: null, paths: null, count: 0, reason: '', source: '' };
			bundleMaps.set(key, entry);
			while (bundleMaps.size > MAP_CACHE_MAX) {
				const oldest = bundleMaps.keys().next().value;
				if (oldest === key) break;
				bundleMaps.delete(oldest);
			}
			const revMatch = /[?&]rev=([^&#]*)/.exec(scriptUrl);
			const signature = `v1:${revMatch === null ? 'norev' : revMatch[1]}:${scriptUrl.length}`;
			const storageKey = `${LS_MAP}:${signature}`;
			entry.storageKey = `${LS_MAP}:${signature}`;
			try {
				const saved = localStorage.getItem(storageKey);
				const parsed = saved === null ? null : JSON.parse(saved);
				if (parsed !== null && Array.isArray(parsed.offsets) && parsed.offsets.length > 1 && Array.isArray(parsed.names)) {
					entry.offsets = parsed.offsets;
					entry.names = parsed.names;
					// 老缓存(v1,加 paths 之前存的)没有这一项 → 文件路径那一层如实留空
					entry.paths = Array.isArray(parsed.paths) ? parsed.paths : null;
					entry.count = parsed.offsets.length;
					entry.state = 'ready';
					markResolved();
					entry.source = 'localStorage';
					return entry;
				}
			} catch (error) { /* 缓存坏了就重取 */ }
			loadBundleMap(entry, scriptUrl);
			return entry;
		}
		/**
		 * map 缓存的 LRU 索引。为什么必须有上限:rev 每次构建都变,`localStorage` 里的
		 * `dsh-perf-hud:map:<rev>:<len>` 只写不删,几个月后会悄悄吃配额,而写失败被 catch 掉。
		 * 保留最近 `MAP_CACHE_MAX` 个 rev;写入配额失败时先淘汰可重建的 map 缓存,再重试一次。
		 */
		function readMapIndex() {
			try {
				const parsed = JSON.parse(localStorage.getItem(LS_MAP_INDEX) ?? 'null');
				return parsed !== null && Array.isArray(parsed.keys) ? parsed.keys : [];
			} catch (error) { return []; }
		}
		function writeMapIndex(keys) {
			try { localStorage.setItem(LS_MAP_INDEX, JSON.stringify({ v: 1, keys })); } catch (error) { /* 索引写不进就下次重建 */ }
		}
		/** 纯函数:按 at 降序留最近 max 个;坏的条目丢掉。 */
		function pruneMapIndex(keys, max = MAP_CACHE_MAX) {
			const list = (Array.isArray(keys) ? keys : [])
				.filter((row) => row !== null && typeof row === 'object' && typeof row.key === 'string')
				.map((row) => ({ key: row.key, at: typeof row.at === 'number' ? row.at : 0 }))
				.sort((a, b) => b.at - a.at);
			return { keep: list.slice(0, max), evicted: list.slice(max) };
		}
		function evictMapEntries(count) {
			const index = readMapIndex();
			const keepCount = Math.max(0, index.length - Math.max(0, count));
			const pruned = pruneMapIndex(index, keepCount);
			for (const row of pruned.evicted) {
				try { localStorage.removeItem(row.key); } catch (error) { /* 删不掉就交给配额错误 */ }
			}
			writeMapIndex(pruned.keep);
			state.mapCache.evicted += pruned.evicted.length;
			return pruned.evicted.length;
		}
		function touchMapCache(storageKey) {
			const index = readMapIndex().filter((row) => row.key !== storageKey);
			index.push({ key: storageKey, at: Date.now() });
			const pruned = pruneMapIndex(index, MAP_CACHE_MAX);
			for (const row of pruned.evicted) {
				try { localStorage.removeItem(row.key); } catch (error) { /* 同上 */ }
			}
			writeMapIndex(pruned.keep);
			state.mapCache.evicted += pruned.evicted.length;
		}
		/** 写一份 map 缓存;配额失败时先淘汰最旧的 map(它们可重建),仍失败则只留内存。 */
		function saveMapCache(storageKey, payload) {
			const text = JSON.stringify(payload);
			try {
				localStorage.setItem(storageKey, text);
				touchMapCache(storageKey);
				return true;
			} catch (error) {
				if (evictMapEntries(2) > 0) {
					try {
						localStorage.setItem(storageKey, text);
						touchMapCache(storageKey);
						return true;
					} catch (retryError) { /* 落到下面记失败 */ }
				}
				state.mapCache.failed += 1;
				return false;
			}
		}
		/** 启动时清一次旧 rev;老安装没有索引时按 localStorage 的插入顺序保留最近 N 个。 */
		function pruneMapCache() {
			const index = readMapIndex();
			if (index.length === 0) {
				try {
					if (typeof localStorage.key !== 'function') return;
					const keys = [];
					for (let i = 0; i < localStorage.length; i += 1) {
						const key = localStorage.key(i);
						if (typeof key === 'string' && key.startsWith(`${LS_MAP}:`) && key !== LS_MAP_INDEX) keys.push(key);
					}
					const extra = keys.length - MAP_CACHE_MAX;
					if (extra > 0) {
						for (const key of keys.slice(0, extra)) localStorage.removeItem(key);
						state.mapCache.evicted += extra;
					}
				} catch (error) { /* 扫不了就算了,不影响功能 */ }
				return;
			}
			const pruned = pruneMapIndex(index, MAP_CACHE_MAX);
			for (const row of pruned.evicted) {
				try { localStorage.removeItem(row.key); } catch (error) { /* 同上 */ }
			}
			writeMapIndex(pruned.keep);
			state.mapCache.evicted += pruned.evicted.length;
		}
		async function loadBundleMap(entry, scriptUrl) {
			const url = mapUrlOf(scriptUrl);
			if (url === null) {
				entry.state = 'failed';
				markResolved();
				entry.reason = 'URL 里没有 ?? 列表';
				return;
			}
			try {
				const { response, text } = await fetchTextWithin(url, { credentials: 'same-origin' }, FETCH_TIMEOUT_MS.map);
				if (response.ok === false) throw new Error(`HTTP ${response.status}`);
				const document = JSON.parse(text);
				const sections = Array.isArray(document?.sections) ? document.sections : null;
				if (sections === null || sections.length === 0) throw new Error('没有 sections');
				// 一次建成**三列对齐**的表,再一起排序 —— 原来只 sort offsets、names 没跟着动,
				// 于是 `names[i]` 与 `offsets[i]` 从排序那一刻起就说不上是同一段(没人读过它,
				// 所以一直没暴露);paths 加上之后这个错位会直接变成"文件路径配错包"。
				const rows = [];
				for (const section of sections) {
					const line = section?.offset?.line;
					const name = sectionName(section);
					if (typeof line !== 'number' || name === null) continue;
					rows.push([line, name, sectionSource(section)]);
				}
				if (rows.length === 0) throw new Error('sections 里没有可用边界');
				rows.sort((a, b) => a[0] - b[0]);
				const offsets = rows.map((row) => [row[0], row[1]]);
				const names = rows.map((row) => row[1]);
				const paths = rows.map((row) => row[2]);
				entry.offsets = offsets;
				entry.names = names;
				entry.paths = paths;
				entry.count = offsets.length;
				entry.state = 'ready';
				markResolved();
				entry.source = 'sourcemap';
				// 只留 offsets/names/paths,原始 JSON 立刻丢掉(58 段时 paths 只多几百字节)。
				// 写不进配额时会先淘汰最旧的 map(可重建),再重试一次;失败只留内存并计数。
				saveMapCache(entry.storageKey, { v: 1, offsets, names, paths });
			} catch (error) {
				if (isAbortError(error)) {
					entry.state = 'failed';
					entry.reason = 'cancelled';
					markResolved();
					return;
				}
				entry.reason = fetchFailureText(error, FETCH_TIMEOUT_MS.map);
				await loadBundleMapByProbe(entry, scriptUrl);
			}
		}
		/** 兜底:map 拿不到时,用各单包响应的开头在合并文本里定位边界(代价高,只在失败后走一次)。 */
		async function loadBundleMapByProbe(entry, scriptUrl) {
			try {
				const list = /\/plugins\/\?\?([^&]+)/.exec(scriptUrl);
				if (list === null) throw new Error('URL 里没有 ?? 列表');
				const ids = list[1].split(',').map((item) => item.replace(/\/[^/,]+\.js(\.map)?$/, '')).filter(Boolean);
				const revMatch = /[?&]rev=([^&#]*)/.exec(scriptUrl);
				const suffix = revMatch === null ? '' : `&rev=${revMatch[1]}`;
				const [merged, probes] = await Promise.all([
					fetchTextWithin(scriptUrl, { credentials: 'same-origin' }, FETCH_TIMEOUT_MS.probe),
					Promise.all(ids.map(async (id) => {
						try {
							const { text } = await fetchTextWithin(`${location.origin}/plugins/??${id}/client.js${suffix}`, { credentials: 'same-origin' }, FETCH_TIMEOUT_MS.probe);
							return { id, head: text.slice(0, 200) };
						} catch (error) {
							return { id, head: '' };
						}
					})),
				]);
				const text = merged.text;
				const hits = [];
				for (const probe of probes) {
					if (probe.head === '') continue;
					const offset = text.indexOf(probe.head);
					if (offset === -1) continue;
					hits.push({ offset, id: probe.id });
				}
				if (hits.length === 0) throw new Error(`${entry.reason} / 单包首字节也定位不到`);
				hits.sort((a, b) => a.offset - b.offset);
				const offsets = [];
				let line = 0;
				let cursor = 0;
				for (const hit of hits) {
					for (let i = cursor; i < hit.offset; i += 1) if (text.charCodeAt(i) === 10) line += 1;
					cursor = hit.offset;
					offsets.push([line, hit.id]);
				}
				entry.offsets = offsets;
				entry.names = offsets.map((item) => item[1]);
				// 兜底路径只认得包 id(靠单包响应的首字节定位边界),**没有**每个 section 的
				// sources → 文件路径这一层如实留空(面板会写"未还原到分片",不拿包名冒充文件名)。
				entry.paths = null;
				entry.count = offsets.length;
				entry.state = 'ready';
				markResolved();
				entry.source = 'probe';
				saveMapCache(entry.storageKey, { v: 1, offsets, names: entry.names });
			} catch (error) {
				entry.state = 'failed';
				markResolved();
				entry.reason = isAbortError(error) ? 'cancelled' : fetchFailureText(error, FETCH_TIMEOUT_MS.probe);
			}
		}
		/**
		 * section 的**源文件路径**。合并包的 sourcemap 里,每个 section 的 `map.sources[0]`
		 * 就是那个包的那份文件(`/plugins/<包>/<文件>`)。包名只能回答"是谁",文件才回答
		 * "打开哪个文件" —— 所以两者都留。拿不到时返回 null(照实说,不猜)。
		 */
		function sectionSource(section) {
			const sources = section?.map?.sources;
			if (Array.isArray(sources) === false) return null;
			let fallback = null;
			for (const source of sources) {
				if (typeof source !== 'string' || source === '') continue;
				if (/\/plugins\/[^?#]+/.test(source)) return source;
				if (fallback === null) fallback = source;
			}
			return fallback;
		}
		/**
		 * V8 行号(1-based)二分到第几段(offset 0-based)。段表为空 / 行号非法 → -1。
		 * `sectionOwner`(包名)与 `sectionPath`(文件路径)共用它,免得两处各写一遍二分。
		 */
		function sectionIndex(entry, lineNumber) {
			const offsets = entry?.offsets;
			if (Array.isArray(offsets) === false || offsets.length === 0) return -1;
			const line0 = lineNumber - 1;
			let lo = 0;
			let hi = offsets.length - 1;
			let found = -1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (offsets[mid][0] <= line0) {
					found = mid;
					lo = mid + 1;
				} else hi = mid - 1;
			}
			return found;
		}
		/** V8 行号(1-based)二分到 section(offset 0-based)→ 包名。 */
		function sectionOwner(entry, lineNumber) {
			const index = sectionIndex(entry, lineNumber);
			return index === -1 ? null : entry.offsets[index][1];
		}
		/**
		 * 同一段的源文件路径。⚠️ `paths` 是后加的字段:老的 localStorage 缓存(v1)里没有它,
		 * 那时返回 null —— **不为了补它去重下那份 12MB 的 map**(宁可少一个文件名)。
		 */
		function sectionPath(entry, lineNumber) {
			const index = sectionIndex(entry, lineNumber);
			if (index === -1) return null;
			const paths = entry?.paths;
			if (Array.isArray(paths) === false) return null;
			const path = paths[index];
			return typeof path === 'string' && path !== '' ? path : null;
		}
		/** 把 ownerOfUrl 的结果落成"具体包名";多包 URL 未解析完成时给一行批次标签。 */
		function resolveOwner(owner, line) {
			if (owner.startsWith(BUNDLE_PREFIX) === false) return owner;
			if (state.precise === false) return bundleLabel(owner);
			const entry = bundleMap(owner);
			if (entry.state !== 'ready') return bundleLabel(owner);
			const name = sectionOwner(entry, line);
			return name ?? `${bundleLabel(owner)}·越界`;
		}
		/** 打开精确归因时,把已经见过的多包 URL 一次性登记解析。 */
		function primeBundleMaps() {
			for (const key of state.bundleKeys) bundleMap(key);
		}
		/** 取一段脚本文本的「每行起始偏移」,用于 charPos → 1-based 行号。 */
		async function loadScriptLines(url) {
			const entry = { state: 'pending', starts: null, reason: '' };
			scriptLines.set(url, entry);
			try {
				const { response, text } = await fetchTextWithin(url, { credentials: 'same-origin' }, FETCH_TIMEOUT_MS.script);
				if (response.ok === false) throw new Error(`HTTP ${response.status}`);
				// 逐 UTF-16 code unit 扫 —— 与 V8 给的 sourceCharPosition 同一套计数,
				// 不能用 code point(遇到 emoji 一类会整体错位)
				const starts = [0];
				for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
				entry.starts = starts;
				entry.length = text.length;
				entry.state = 'ready';
				markResolved();
			} catch (error) {
				entry.state = 'failed';
				entry.reason = isAbortError(error) ? 'cancelled' : fetchFailureText(error, FETCH_TIMEOUT_MS.script);
				// 取消的条目不留在缓存里:下次还能重新预取(否则永远是 failed)。
				if (isAbortError(error)) scriptLines.delete(url);
				markResolved();
			}
			if (scriptLines.size > SCRIPT_LINES_MAX) {
				const oldest = scriptLines.keys().next().value;
				if (oldest !== url) scriptLines.delete(oldest);
			}
			return entry;
		}
		/** 幂等预取(后台跑,不挡切片)。 */
		function ensureScriptLines(url) {
			if (scriptLines.has(url)) return;
			loadScriptLines(url);
		}
		/** charPos → 1-based 行号;文本还没到位返回 null,落在文本之外返回 -1(都不猜)。 */
		function scriptLineOf(url, charPos) {
			const entry = scriptLines.get(url);
			if (entry === undefined || entry.state !== 'ready') return null;
			if (typeof charPos !== 'number' || charPos < 0) return null;
			if (typeof entry.length === 'number' && charPos >= entry.length) return -1;
			const starts = entry.starts;
			let lo = 0;
			let hi = starts.length - 1;
			let found = 0;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (starts[mid] <= charPos) { found = mid; lo = mid + 1; } else hi = mid - 1;
			}
			return found + 1;
		}
		/**
		 * 一条 LoAF 脚本 → 包名。`via` 说明这个名字是怎么来的,拿不到就写清为什么 ——
		 * 面板与导出件都要能回答"为什么这一条没名字"。
		 */
		function packageOfScript(url, charPos) {
			if (typeof url !== 'string' || url === '') return { pkg: null, via: 'no-url' };
			const owner = ownerOfUrl(url);
			if (owner === null) return { pkg: null, via: 'not-plugin' };
			if (owner.startsWith(BUNDLE_PREFIX) === false) return { pkg: owner, via: 'url' };
			if (state.precise === false) return { pkg: null, via: 'precise-off' };
			const lines = scriptLines.get(url);
			if (lines === undefined) { ensureScriptLines(url); return { pkg: null, via: 'text-pending' }; }
			if (lines.state === 'failed') return { pkg: null, via: `text-failed(${lines.reason})` };
			if (lines.state !== 'ready') return { pkg: null, via: 'text-pending' };
			const line = scriptLineOf(url, charPos);
			if (line === null) return { pkg: null, via: 'no-charpos' };
			if (line < 1) return { pkg: null, via: 'out-of-range' };   // 字符位置超出了这段脚本
			const entry = bundleMap(owner);
			if (entry.state !== 'ready') return { pkg: null, via: `map-${entry.state}` };
			const name = sectionOwner(entry, line);
			return name === null ? { pkg: null, via: 'out-of-range' } : { pkg: name, via: 'section' };
		}
		/**
		 * 脚本里的字符位置 → **这份脚本文本里的行号**(1-based)。返回 `{ line, via }`;
		 * line 为 null 时 `via` 说明为什么拿不到(照实显示,不猜)。
		 *
		 * ⚠️ 口径:这是**脚本文件自己的行号** —— 单包 URL 时就那个文件;合并批里是**合并后的
		 * 大文件**的行号。**不是**原始源码(TS/TSX)的行号:那要解开 section 内层 `mappings`
		 * 的 VLQ,本项目没做(见 REVIEW「还剩什么」)。所以它够用来定位"打开哪个文件的哪一段",
		 * 不够用来"跳到源码某一行"。
		 */
		function scriptPosition(url, charPos) {
			if (typeof url !== 'string' || url === '') return { line: null, via: 'no-url' };
			if (typeof charPos !== 'number' || charPos < 0) return { line: null, via: 'no-charpos' };
			const entry = scriptLines.get(url);
			// ⚠️ 这里**不预取**脚本文本:预取只发生在深录档(`loafScripts` 里判 precise)。
			// 以前这里顺手 `ensureScriptLines(url)` —— 于是"看一眼面板"会去拉整份合并批脚本文本
			// (几 MB),破坏了守夜的零成本边界;而且会在**没有包名**的情况下算出一个合并大文件里的
			// 行号(25580 这种),那不是精度,是误导。没预取就照实说"还没预取"。
			if (entry === undefined) return { line: null, via: 'text-not-fetched' };
			if (entry.state === 'failed') return { line: null, via: `text-failed(${entry.reason ?? ''})` };
			if (entry.state !== 'ready') return { line: null, via: 'text-pending' };
			const line = scriptLineOf(url, charPos);
			if (line === null) return { line: null, via: 'no-charpos' };
			if (line < 1) return { line: null, via: 'out-of-range' };
			return { line, via: 'text' };
		}
		/**
		 * 「这个包名 / 这个行号是从哪来的」压成一句人话。**故意只分五类** —— 面板正文放不下
		 * 十几个 via 码,而"直接从 URL 读出来的"与"靠 sourcemap 分段推断的"之间**信任度的差别**
		 * 才是读者要看的。原始 via 码仍然进悬停与导出件(留给分析者核对)。
		 */
		function viaText(via) {
			if (via === 'url' || via === 'text') return translate('viaDirect');
			if (via === 'section') return translate('viaInferred');
			if (via === 'not-plugin') return translate('viaNotPlugin');
			if (via === 'text-not-fetched') return translate('viaNotFetched');
			if (typeof via === 'string' && (via.startsWith('text-failed') || via.startsWith('map-'))) return translate('viaFailed');
			return translate('viaUnavailable');
		}
		/**
		 * 一条脚本的**证据**:把"函数名 / 哪个包 / 哪个文件 / 第几行 / 花了多久 / 谁调起来的"
		 * 一次算齐,每一段都带**它是怎么来的**(`pkgVia` / `lineVia`)—— 面板与导出件共用同一份
		 * 口径,不许把"推断出来的包名"说成"测出来的根因"(直接测量 / 归因推断 / 尚无法确认三者
		 * 在文案上分开)。
		 *
		 * `script` 有两个来源:帧环里的脚本(自带 `url` / `invoker`)或事故包的 `topScripts`
		 * (url 在 `incident.urls` 表里,由调用方解出来传进来)。
		 */
		function scriptEvidence(script, url) {
			const charPos = script?.charPos;
			const resolved = packageOfScript(url, charPos);
			const position = scriptPosition(url, charPos);
			const owner = typeof url === 'string' && url !== '' ? ownerOfUrl(url) : null;
			const inBundle = owner !== null && owner.startsWith(BUNDLE_PREFIX);
			let file = null;
			if (inBundle === true) {
				// 合并批:文件名只能从 sourcemap 的 section 拿(probe 兜底过就只剩包名 → null)
				if (state.precise === true && position.line !== null) {
					const entry = bundleMap(owner);
					if (entry.state === 'ready') file = sectionPath(entry, position.line);
				}
			} else if (typeof url === 'string' && url !== '') {
				// 单包 URL / 应用自己的外壳 bundle:URL 的路径部分就是那个文件。
				// ⚠️ **单包组合**(`plugins/??<包>/client.js`)不能交给 `new URL().pathname` ——
				// `??` 里第一个 `?` 会被当成查询串的开始,pathname 只剩 `/plugins/`,于是面板会
				// 把"文件路径"显示成 `/plugins/`(实测踩到)。这类 URL 自己拼:组合里只有一个包,
				// 等价于 `plugins/<包>/<文件>`。
				const combo = /\/plugins\/\?\?([^/?&,]+)\/([^?&,]+?\.js)/.exec(url);
				if (combo !== null) {
					file = `/plugins/${combo[1]}/${combo[2]}`;
				} else {
					try {
						const path = new URL(url, location.href).pathname;
						file = path === '' ? null : path;
					} catch (error) { file = null; }
				}
			}
			// 「这个行号属于哪个文件」—— 合并批的 charPos → 行号是相对**合并后的大文件**的,
			// 而 file 是那个包自己的源文件;两者不是同一个坐标系,**不许拼成 file:line**
			// (那看着精确,实际指不到任何一行)。单包 URL / 单包组合才是同一个文件。
			const lineScope = position.line === null ? null : (resolved.via === 'section' ? 'bundle' : (file === null ? null : 'file'));
			return {
				fn: typeof script?.fn === 'string' && script.fn !== '' ? script.fn : null,
				ms: typeof script?.ms === 'number' ? script.ms : 0,
				pkg: resolved.pkg,
				pkgVia: resolved.via,
				file,
				line: position.line,
				lineVia: position.via,
				lineScope,
				invoker: typeof script?.invoker === 'string' && script.invoker !== '' ? script.invoker : null,
				invokerType: typeof script?.invokerType === 'string' ? script.invokerType : null,
				url: typeof url === 'string' && url !== '' ? url : null,
			};
		}
		/**
		 * 那两行小表里的名字:`<函数> @ <包>`,缺什么就照实写缺什么。
		 * ⚠️ 字段一律用 `== null` 判:**事故包里读回的 topScripts 可能是加这几个字段之前存的**
		 * (少了 file/line/invoker),那时不能抛错、也不能渲染成 `undefined`。
		 */
		function evidenceName(ev) {
			const who = ev.fn == null || ev.fn === '' ? translate('fnUnknown') : short(ev.fn);
			const pkg = ev.pkg == null || ev.pkg === '' ? translate('pkgUnresolvedShort') : short(ev.pkg);
			return `${who} @ ${pkg}`;
		}
		/**
		 * 「文件(:行)」那一格。文件拿不到就退回脚本名,两个都没有才给 null。
		 * ⚠️ **合并批不拼 `file:line`**:那里的行号是合并后大文件里的行号,而 file 是包内源文件 ——
		 * 拼起来看着精确,其实指不到任何一行。那种情况只给文件,行号另起一段(`evidenceLine`)。
		 */
		function evidencePlace(ev) {
			const file = ev.file == null ? (ev.url == null ? null : ev.url) : ev.file;
			if (file === null && ev.line == null) return null;
			const where = file === null ? translate('fileUnresolved') : short(file);
			if (ev.line == null || ev.lineScope === 'bundle') return where;
			return `${where}:${ev.line}`;
		}
		/**
		 * 悬停/复制里的「位置」那段:文件与行号**分列**,合并批的行号明确标成"合并脚本行"。
		 * 不把两者混成一个数字,是为了让读者一眼看出"这不是原始源码行"。
		 */
		function evidenceWhereText(ev) {
			const parts = [];
			const place = evidencePlace(ev);
			if (place !== null) parts.push(place);
			if (ev.line != null && ev.lineScope === 'bundle') parts.push(`${translate('evidenceBundleLine')} ${ev.line}`);
			parts.push(`${viaText(ev.pkgVia)} / ${viaText(ev.lineVia)}`);
			return parts.join(' · ');
		}
		/**
		 * 复制一行时给的文本:自描述、能直接粘给别的 AI。末尾把两个 via 码原样带上 ——
		 * 读的人不必猜"这个包名是读出来的还是推出来的"。
		 */
		function evidenceLine(ev) {
			const parts = [evidenceName(ev)];
			const place = evidencePlace(ev);
			if (place !== null) parts.push(place);
			// 合并批:行号单独一段,写明它是**合并脚本**里的行(不是 file 里的行,也不是源码行)
			if (ev.line != null && ev.lineScope === 'bundle') parts.push(`${translate('evidenceBundleLine')} ${ev.line}`);
			parts.push(`${Math.round(typeof ev.ms === 'number' ? ev.ms : 0)}ms`);
			if (ev.invoker != null && ev.invoker !== '') parts.push(`${translate('evidenceInvoker')} ${ev.invoker}`);
			parts.push(`pkg=${ev.pkgVia ?? '-'} line=${ev.lineVia ?? '-'}`);
			return parts.join(' · ');
		}
		/**
		 * 事故里的一条证据:**优先用捕获时存下来的定位结果**,只有包里确实没有的字段才回退到现算。
		 *
		 * 为什么不能一律现算:`scriptEvidence()` 依赖**当前**会话的 `state.precise` 与内存里的
		 * `scriptLines` / `bundleMaps` 缓存 —— 刷新之后那两个缓存都是空的,现算会把捕获时已经定下来的
		 * pkg / file / line 变成 `null` / `text-not-fetched`,**历史事故的定位信息就这样丢了**
		 * (事故包落盘本来就为了活过刷新)。老包(加 file/line/lineVia/invoker 之前抓的)没有这些
		 * 字段,那时才现算 —— 它是兼容垫片,不是主路。
		 */
		function incidentScriptEvidence(script, url, fallback) {
			const stored = script ?? {};
			const computed = fallback ?? {};
			const pick = (key) => (stored[key] !== undefined ? stored[key] : (computed[key] ?? null));
			const ms = typeof stored.ms === 'number' ? stored.ms : (typeof computed.ms === 'number' ? computed.ms : 0);
			const line = pick('line');
			const pkgVia = pick('pkgVia');
			// 老包没有 lineScope:按同一条规则现推(分段表算出来的包 → 行号属于合并大文件)
			const lineScope = stored.lineScope !== undefined
				? stored.lineScope
				: (line == null ? null : (pkgVia === 'section' ? 'bundle' : 'file'));
			return {
				fn: pick('fn'),
				ms,
				pkg: pick('pkg'),
				pkgVia,
				file: pick('file'),
				line,
				lineVia: pick('lineVia'),
				lineScope,
				invoker: pick('invoker'),
				invokerType: pick('invokerType'),
				url: computed.url ?? (typeof url === 'string' && url !== '' ? url : null),
			};
		}
		/**
		 * 事故里第 N 条脚本 → 证据(URL 从事故的 URL 表里解)。**面板与复制摘要共用它** ——
		 * 两条路必须是同一份口径,否则"面板上看到一个文件:行、复制出来却没有"这种不一致会回来。
		 */
		function incidentEvidenceAt(row, script) {
			const urls = row === null || row === undefined || Array.isArray(row.urls) === false ? [] : row.urls;
			const url = script !== null && script !== undefined && script.u >= 0 ? (urls[script.u] ?? '') : '';
			const needs = script === null || script === undefined || script.pkg === undefined
				|| script.file === undefined || script.line === undefined || script.lineVia === undefined;
			return incidentScriptEvidence(script, url, needs ? scriptEvidence(script, url) : null);
		}
		/** 事故包里那几条脚本的证据行(与面板「可疑脚本」同一份口径,同样只取前 EVIDENCE_MAX 条)。 */
		function incidentEvidenceLines(row) {
			const summary = row?.summary ?? {};
			const top = Array.isArray(summary.topScripts) ? summary.topScripts : [];
			return top.slice(0, EVIDENCE_MAX).map((script) => evidenceLine(incidentEvidenceAt(row, script)));
		}
		/**
		 * 面板上「可疑脚本」那一块吃什么。**两个上下文各吃自己那一份**:
		 *
		 *   · 历史事故:先给**选中那一帧**自己的脚本记录(`incident.loaf[].scripts[]` —— 它是
		 *     捕获时存下来的,跨会话读回仍在);这一帧没有 LoAF 记录时才退回**这条事故窗口内**
		 *     的切片,并把范围写在标签上、明说"不是这一帧的"。绝不回退到实时帧环。
		 *   · 实时:当前选中的那条实时帧的脚本。
		 *
		 * 范围写在标签上,读者不会把两者当同一份数据。
		 */
		function evidenceScope() {
			if (diagMode() === 'incident') {
				const row = selectedIncident().row;
				if (row === null) return null;
				const frame = selectedIncidentFrame(row);
				const frameRows = incidentFrameEvidenceRows(row, frame);
				if (frameRows.length > 0) {
					return {
						label: `${translate('evidenceLabel')} · ${translate('evidenceScopeIncident')} ${row.id} · ${translate('ctxHistoryFrame')}`,
						scopeKind: 'history', frame: true, missing: false,
						rows: locatable(frameRows).slice(0, EVIDENCE_MAX),
						total: frameRows.length,
						named: frameRows.filter((item) => item.pkg !== null).length,
						titled: frameRows.filter((item) => item.fn !== null).length,
					};
				}
				// 这一帧没有脚本记录(老包 / 这一帧没有 LoAF):退回事故**窗口内**的切片,
				// 并把"下面这些不是这一帧的"写在 missing 上,由渲染那侧照实说。
				const summary = row.summary ?? {};
				const top = Array.isArray(summary.topScripts) ? summary.topScripts : [];
				const coverage = summary.pkgCoverage ?? { resolved: 0, total: top.length };
				const rows = top.map((script) => incidentEvidenceAt(row, script)).sort((a, b) => b.ms - a.ms);
				return {
					label: `${translate('evidenceLabel')} · ${translate('evidenceScopeIncident')} ${row.id} · ${translate('evidenceWindowPrefix')}`,
					scopeKind: 'window', frame: false, missing: frame !== null,
					rows: locatable(rows).slice(0, EVIDENCE_MAX),
					total: coverage.total ?? rows.length,
					named: coverage.resolved ?? 0,
					titled: rows.filter((item) => item.fn !== null).length,
				};
			}
			const frame = pickedLoaf();
			const scripts = frame === null || Array.isArray(frame.scripts) === false ? [] : frame.scripts;
			if (scripts.length === 0) return null;
			const rows = scripts.map((script) => scriptEvidence(script, script.url)).sort((a, b) => b.ms - a.ms);
			return {
				label: `${translate('evidenceLabel')} · ${translate('scopeFrame')}`,
				scopeKind: 'frame', frame: true, missing: false,
				rows: locatable(rows).slice(0, EVIDENCE_MAX),
				total: rows.length,
				named: rows.filter((item) => item.pkg !== null).length,
				titled: rows.filter((item) => item.fn !== null).length,
			};
		}
		/**
		 * 一条名字都没有时,不要摆一列 `函数名未记录 @ 包未定名 + 毫秒` —— 那既没缩小范围,
		 * 又把行数翻了几倍(与「按包:0 条定到名」同一条规矩)。换成**一行带分母 + 要深录**,
		 * 并说明为什么:合并批的包名要靠 sourcemap 分段(深录才拉),而函数名来自 LoAF 的
		 * `sourceFunctionName`,压缩/合并后的脚本经常就没有它。
		 */
		function evidenceZeroText(scope) {
			// 分母的范围要说对:实时帧 = 本帧,历史帧 = 历史帧,事故窗口切片 = 窗口内。
			// 三种都写成"窗口内"会把"这一帧一条都没定到名"说成"整个窗口"。
			const kind = scope.scopeKind ?? (scope.frame === true ? 'frame' : 'window');
			const prefix = kind === 'history' ? translate('ctxHistoryFrame')
				: (kind === 'frame' ? translate('scopeFrame') : translate('evidenceWindowPrefix'));
			return `${translate('evidenceLabel')}:${translate('pkgZeroNamed')}(${prefix} ${scope.total}${translate('scriptsUnit')})· ${translate('needDeep')}`;
		}
		/**
		 * 只留**能定位的**那些行:函数名 / 包名 / 文件 / 行号一个都没有的行,列出来只是"函数名未记录
		 * @ 包未定名 + 一个毫秒数"——占掉名额还不缩小范围。**分母仍然按全部脚本算**(见
		 * `evidenceFooter`),所以过滤不会把"没定到名"这件事藏起来。
		 */
		function locatable(rows) {
			// ⚠️ **光有行号不算能定位**:合并批里 charPos → 行号是相对于那个几十包合起来的大文件,
			// 不知道属于哪个包时,那个数字指不出任何可打开的东西(实测非深录档会出现 line=25580 而
			// pkg 为 null)。有包名时行号才有意义,而那已经被 pkg != null 覆盖。
			return rows.filter((row) => row.fn != null || row.pkg != null || row.file != null);
		}
		/**
		 * 块底下那两行:先给**这一块的覆盖分母**,再给口径与缺口。
		 * 分母不能省 —— `定到包 3` 不写"共 N 条"会被读成"全都定到了";而且它按**全部**脚本算,
		 * 不随上面列出的行数变(列出来的只是"能定位的那几条")。
		 */
		function evidenceFooter(scope) {
			// ⚠️ 正文只留**分母**与一句提示。以前这里把「口径」与「缺口」两整段(各两三百字)摊在正文里,
			// 而面板是**纯文本**渲染(不是 markdown),于是 `**` 与反引号原样显示出来 —— 一屏全是解释,
			// 分母反而找不着。完整口径与缺口进 evidenceFooterTitle() 的悬停;「复制摘要」那份交接件
			// 仍然照旧带全文(它本来就是给别的 AI 读的,不受这里影响)。
			return `${scope.total}${translate('scriptsUnit')} · ${translate('pkgNamed')} ${scope.named}/${scope.total} · ${translate('evidenceHoverHint')}`;
		}
		/**
		 * 上面那一行悬停时给的**完整**口径与缺口 —— 与「复制摘要」的交接件用**同一份措辞**
		 * (`evidenceCaliberPlain` / `evidenceMissingPlain`),所以两处不会各说一套。
		 */
		function evidenceFooterTitle() {
			return `${translate('evidenceCaliberPlain')}\n${translate('evidenceMissingPlain')}`;
		}
		/** Δ 是否超出噪声底(逐指标判断)。 */
		function significance(delta, noise) {
			if (delta === null || noise === null) return null;
			return {
				fps: Math.abs(delta.fps) > noise.fps,
				longTasks: Math.abs(delta.longTasks) > noise.longTasks,
				domPerMin: Math.abs(delta.domPerMin) > noise.domPerMin,
				unattrAvg: Math.abs(delta.unattrAvg ?? 0) > noise.unattrAvg,
			};
		}
		/** 最近 60 秒里最差的那一秒 —— 用来把"卡"对齐到具体时钟刻度。 */
		function worstSecond(seconds = 60) {
			const cutoff = Date.now() - seconds * 1000;
			let worst = null;
			for (const sample of ring) {
				if (sample.t < cutoff) continue;
				if (worst === null || (sample.frameMs ?? 0) > (worst.frameMs ?? 0)) worst = sample;
			}
			return worst;
		}
		// ───────────────────── 能力矩阵与证据出处(导出件的自证部分)─────────────────────
		/**
		 * 出处三档。**每个结论都要能回答"这是量出来的还是推出来的"** —— 这是本项目
		 * 所有"别把相关写成根因"规矩的落点:
		 *   measured = 直接测量(观察器 / 计数器给的,不是算出来的);
		 *   inferred = 归因推断(URL、sourcemap 分段表、时间重叠、采样折算);
		 *   unknown  = 证据不足(拿不到就说拿不到,不补默认值)。
		 */
		function provenanceOf(kind) {
			return kind === 'measured' || kind === 'inferred' || kind === 'unknown' ? kind : 'unknown';
		}
		/**
		 * 能力矩阵:每一条证据来源现在处于什么状态、为什么、属于哪一档出处。
		 * 这是**唯一的事实来源** —— `capabilityMissing()` 与导出件都读它,免得"某一层没采到"
		 * 这件事在三个地方各说各话(以前 `missing` / `howToAdd` 是手写的一串 if)。
		 * state 取值:on / degraded / off / unsupported;`reason` 一律是**给用户看的原因**。
		 */
		function capabilities() {
			const watch = state.watch;
			const maps = { pending: 0, ready: 0, failed: 0 };
			for (const entry of bundleMaps.values()) maps[entry.state] = (maps[entry.state] ?? 0) + 1;
			const host = state.host;
			const loop = host === null || host === undefined ? null : host.eventLoop ?? null;
			const io = state.watch.interactions.length;
			// 读数一律**防御性取值**:能力矩阵的职责是"照实说现在有什么",不是"假设字段一定在"
			const taskRows = Array.isArray(state.longTasks) ? state.longTasks.length : 0;
			const taskTotal = typeof state.ltTotal === 'number' ? state.ltTotal : taskRows;
			const linkCount = Array.isArray(state.link) ? state.link.length : 0;
			const loadState = state.loadState ?? 'pending';
			const frameCount = frameRing !== undefined && frameRing !== null && typeof frameRing.size === 'number' ? frameRing.size : 0;
			const leaf = (capState, provenance, reason) => ({ state: capState, provenance: provenanceOf(provenance), reason: reason ?? '' });
			return {
				schema: 1,
				renderer: {
					frames: leaf(state.on === true ? 'on' : 'off', 'measured',
						state.on === true ? `帧环 ${frameCount} 帧` : 'HUD 已关闭,帧环没有在采'),
					loaf: leaf(watch.loafState === 'on' ? 'on' : (watch.loafState === 'unsupported' || String(watch.loafState).startsWith('unsupported') ? 'unsupported' : 'off'),
						'measured', `LoAF 观察器:${watch.loafState}`),
					longTasks: leaf(state.on === true ? 'on' : 'off', 'measured', `longtask 明细 ${taskRows} 条 / 累计 ${taskTotal} 条`),
					// 脚本这一层是**混合**的:函数名与毫秒是 LoAF 直接给的,包名 / 文件 / 行号是推断出来的
					scriptAttribution: leaf(state.precise === true ? (maps.pending > 0 ? 'degraded' : 'on') : 'degraded', 'inferred',
						state.precise === true
							? `精确归因已开;分段表 pending ${maps.pending} / ready ${maps.ready} / failed ${maps.failed}`
							: '精确归因没开:合并批次只能给整批,拿不到单包名'),
					domWrites: leaf(state.deep === true ? 'degraded' : 'off', 'inferred',
						state.deep === true ? `插桩已开(DOM 写入按 1/${MUT_SAMPLE} 采样,估算是折算的)` : '深录没开:DOM 写入者没有记账'),
					interactions: leaf(watch.eventState === 'on' ? 'on' : (String(watch.eventState).startsWith('unsupported') ? 'unsupported' : 'off'),
						'measured', `交互计时:${watch.eventState}(窗口内保留 ${io} 条)`),
					elementTiming: leaf('unsupported', 'unknown', 'DSH 的 DOM 上没有 elementtiming 属性,这一路恒为 0'),
				},
				host: {
					eventLoop: leaf(loop === null ? 'off' : 'on', 'measured',
						loop === null ? (state.hostError === null || state.hostError === undefined ? '还没拿到宿主快照' : `宿主路由不可达:${state.hostError}`) : `p50/p99/max 已采(${host.at ?? '—'})`),
					events: leaf(state.hostEvents === null || state.hostEvents === undefined ? 'off' : (state.hostEvents.installed === true ? 'on' : 'degraded'), 'measured',
						state.hostEvents === null || state.hostEvents === undefined ? '还没请求宿主事件监听' : `session/event 到达延迟:${state.hostEvents.installed === true ? '已装' : state.hostEvents.reason ?? '没装上'}`),
					cpuProfile: leaf('off', 'unknown', '宿主路由能采 Node CPU profile,客户端还没接线(要动宿主半,排在后面)'),
				},
				link: {
					rtt: leaf(linkCount > 0 ? 'on' : 'off', 'measured', `链路样本 ${linkCount} 条(环形缓冲里全部)`),
					throughput: leaf(loadState === 'ok' ? 'on' : (String(loadState).startsWith('failed') ? 'degraded' : 'off'), 'measured', `吞吐采样:${loadState}`),
				},
				// 明确**不观测**的东西:不假装有,也不给默认值
				unobserved: [
					{ id: 'gpu-compositor', reason: '帧时间花在合成 / 光栅 / GPU 的哪一段,页面内没有 API' },
					{ id: 'electron-main', reason: 'Electron 主进程 / GPU 进程这一层本插件没有采' },
					{ id: 'raw-source-lines', reason: '原始源码(TS/TSX)行号要解 section 内层 mappings 的 VLQ,本项目没做' },
					{ id: 'frame-inner-order', reason: '帧内脚本的起止顺序 LoAF 不给(只给每条脚本的时长)' },
					{ id: 'devtools-trace', reason: '完整 Chrome trace 需要 DevTools 录制,页面内录不了' },
				],
			};
		}
		/**
		 * 事故包里的缺失声明。**从能力矩阵推**(而不是手写一串 if),但保留每一行的
		 * `前缀:` 形状与原有措辞 —— 线上/离线都靠前缀断言(见 tests/logic.mjs)。
		 * `row` 为 null 时只给与这一条事故无关的整机级缺失。
		 */
		function capabilityMissing(row) {
			const caps = capabilities();
			const missing = [];
			const howToAdd = [];
			const incident = row ?? null;
			const summary = incident === null ? null : incident.summary ?? {};
			const loaf = caps.renderer.loaf;
			if (loaf.state !== 'on') {
				missing.push(`loaf:脚本级归因(这一层唯一的"谁"的来源)—— ${state.watch.loafState}`);
				howToAdd.push('LoAF 要 Chrome 123+ 且非 dsh-app:// 源;不满足时只能靠既有 longtask 明细与人工 trace');
			} else if (incident !== null && summary.topScripts.length === 0) {
				missing.push('loaf-scripts:这一帧没有脚本(<5ms 的脚本不上报;Mac/Windows 桌面端 dsh-app:// 上恒为空)');
			} else if (incident !== null && summary.pkgCoverage !== undefined && summary.pkgCoverage.resolved < summary.pkgCoverage.total) {
				// 用完整分布(summary.pkgVia),不要只数 topScripts —— 否则会写出"2/11 没定到(not-plugin×1)"这种自相矛盾的话
				const all = summary.pkgVia ?? {};
				const unresolved = Object.entries(all).filter(([key]) => key !== 'url' && key !== 'section');
				missing.push(`loaf-pkg:${summary.pkgCoverage.total - summary.pkgCoverage.resolved}/${summary.pkgCoverage.total} 条脚本没定到包名(${unresolved.map(([k, v]) => `${k}×${v}`).join(' · ') || '原因见 summary.pkgVia'})`);
			}
			if (state.on === false) {
				missing.push('instrumentation:四条腿的归因(没插桩就没有 DOM 写入与调度点包名)');
				howToAdd.push('打开 HUD(面板「开启」或 __perfHud.enable())');
			}
			if (incident !== null && incident.env.precise === false) {
				missing.push('precise:合并批次里的单包名 —— 也包含 LoAF 脚本的 scripts[].pkg(需要精确归因,会拉那份 12MB 的 map)');
				howToAdd.push('面板「深录」(它同时打开精确归因)或 __perfHud.setPrecise(true) —— 只能改善之后抓到的事故,这一条不会重放');
			}
			missing.push('devtools-trace:完整的 Chrome trace(页面内录不了)');
			// A4:交互延迟采到了什么、没采到什么,一律照实写
			if (caps.renderer.interactions.state !== 'on') {
				missing.push(`interaction-timing:交互延迟(event timing)—— ${state.watch.eventState}`);
				howToAdd.push('event timing 要 Chrome 96+;装不上时这一层给不出"点了多久才反应"');
			} else if (incident !== null && summary.interactionsInWindow === 0) {
				missing.push(`interaction-timing:这个窗口里没有 ≥${WATCH_EVENT_MS}ms 的交互(阈值以下的事件不记;长时间没有真人操作也会是 0)`);
				howToAdd.push('复现时真的点几下(≥100ms 的交互才会进环形缓冲),再导出');
			}
			if (state.watch.elementCount === 0) {
				missing.push('element-timing:元素渲染时刻 —— element timing 只观察带 elementtiming 属性的元素,DSH 的 DOM 上没有这个属性,所以这一路恒为 0(照实记,不假装采到)');
			}
			missing.push('interaction-breakdown:单次交互内部"输入延迟 / 处理 / 呈现"的拆分 —— 页面内没有 API,这里只有端到端时长与 processingStart/End');
			howToAdd.push('要拆交互的三段:DevTools → Performance 录制,Hover 到 Interactions 轨道上那一下,看 Input delay / Processing / Presentation');
			howToAdd.push('DevTools → Performance → 录制(勾 include script source maps)→ Save trace → Perfetto 打开');
			missing.push('compositor:帧时间到底花在合成 / 光栅 / GPU 的哪一段(这一层只看得到主线程侧)');
			missing.push('recorder-cost:本记录器自身的开销**没带在这份事故包里**(它每帧跑一次 rAF 采样;面板「记录器自身」与整机导出件的 context.recorder 有 p99 / 峰 / 样本数)');
			missing.push('baseline:跨机器 / 跨浏览器的对照基线 —— context.sessionBaselines 只来自同一个浏览器 profile,而且只是粗参照');
			if (incident === null || incident.host === null) {
				missing.push('host:没有任何宿主快照(宿主半未加载或路由不可达)');
			} else {
				missing.push(`host-cpuprofile:宿主进程的 CPU 火焰图**没有自动采** —— 路由已经能采(POST {op:'profileStart', seconds} / {op:'profileGet'},真宿主实测 1 秒 = 292 节点 / 223 采样 / 82KB),但客户端还没接线,要的话手动打一次;而这份宿主快照是${incident.host.snapshotAgeMs >= 0 ? `事故前 ${incident.host.snapshotAgeMs}ms` : `事故**后** ${-incident.host.snapshotAgeMs}ms`}采的(每 10 秒一次),未必覆盖卡顿瞬间;别把它当"宿主没问题"的证据`);
			}
			if (incident !== null && incident.integrity?.captureComplete === false) {
				const drop = incident.integrity;
				missing.push(`window-integrity:这份现场不完整 —— LoAF 丢 ${drop.loafDropped} 条 / longtask 丢 ${drop.longTaskDropped} 条(${drop.reasons.join(' · ')})`);
				howToAdd.push('窗口的事后补采不了:下次卡顿前不要清空 HUD,也不要在 13 秒窗口内刷新 / 触发 HMR;要完整证据只能等下一次');
			}
			howToAdd.push('零成本、当场可做:chrome://gpu 看是不是落到了软件渲染;DevTools → Rendering 打开 Frame Rendering Stats(FPS 表)与 Paint flashing —— 页面完全静止时帧率是否也上不去');
			howToAdd.push('判定"主线程之外":Performance 面板录 5 秒,看 Main 轨道自身的忙碌时间是否远小于墙钟 —— 注意 blocking=0 / scripts 为空**不能**当证据(见上面的读取说明),要看 Main 轨道本身');
			howToAdd.push('宿主火焰图:插件自带路由就能采 —— 带宿主 cookie(见 docs/verification.md)POST /api/dsh-perf-hud/host {op:"profileStart", seconds:5},再 POST {op:"profileGet"} 取回标准 .cpuprofile(speedscope 打开);退一步也可以 kill -USR1 <dsh web pid> → chrome://inspect → Performance → Record');
			return { missing, howToAdd, capabilities: caps };
		}
		/** 出处 / 线索强度的文字档位 —— 只给名字,颜色与排版由 UI 那一侧定。 */
		function provenanceText(kind) {
			// 逐分支写**字面量**键:logic.mjs 的"死键"断言只认字面量 translate('…'),
			// 拼出来的键名它看不见,于是会被当成"没人引用"报出来(踩过)。
			if (kind === 'measured') return translate('provenanceMeasured');
			if (kind === 'inferred') return translate('provenanceInferred');
			return translate('provenanceUnknown');
		}
		function strengthText(level) {
			if (level === 'strong') return translate('strengthStrong');
			if (level === 'medium') return translate('strengthMedium');
			if (level === 'weak') return translate('strengthWeak');
			return translate('strengthNone');
		}
		/**
		 * 候选原因(最多 `CAUSE_MAX` 条)。**这是"可能原因"那一块的唯一生成处**,面板与
		 * 诊断包读同一份 —— 所以"面板上说 A、导出件里说 B"在结构上不会发生。
		 *
		 * 三条不许越界(与 docs/reading-panel.md 的归因三档同源):
		 *   ① 每条候选都带 `limits`,而且限制里一定有那句"不等于已定位根因";
		 *   ② `worstFrameJs === 'none'` 时**不**给节流结论:要么是"更可能"(只有 `suspectedThrottle`
		 *      成立时),要么就是"证据不足";
		 *   ③ 每条候选的 `basis` 全部来自**已经采到的字段**,不合成、不推测。
		 */
		function causeCandidates(row) {
			if (row === null || row === undefined) return [];
			const summary = row.summary ?? {};
			const out = [];
			const notRoot = translate('verdictNotRootCause');
			// ① 脚本 / 包这一支:毫秒是直接测的,包名是推断的
			const packages = Array.isArray(row.packages) ? row.packages : [];
			const cov = summary.pkgCoverage ?? { resolved: 0, total: 0 };
			if (packages.length > 0) {
				const top = packages[0];
				const covered = cov.total === 0 ? true : cov.resolved >= cov.total * 0.8;
				const basis = [`${top.pkg} · ${Math.round(top.ms)}ms · ${top.count}${translate('scriptsUnit')}`,
					`${translate('pkgNamed')} ${cov.resolved}/${cov.total}`];
				const limits = [notRoot];
				if (cov.resolved < cov.total) limits.push(`${cov.total - cov.resolved}${translate('scriptsUnit')}${translate('causeUnresolvedSuffix')}`);
				out.push({
					kind: 'script',
					lead: translate('causeScriptLead'),
					name: top.pkg,
					strength: top.ms >= 100 && covered ? 'strong' : 'medium',
					basis,
					limits,
					provenance: 'inferred',
				});
			}
			// ② long task 的四条腿(owner = 调度方包名 / component = 渲染方组件名)
			const tasks = Array.isArray(row.longTasks) ? row.longTasks : [];
			const byWho = new Map();
			for (const task of tasks) {
				const name = task.component ?? task.owner ?? null;
				if (name === null || name === undefined) continue;
				byWho.set(name, round1((byWho.get(name) ?? 0) + (typeof task.ms === 'number' ? task.ms : 0)));
			}
			const ranked = [...byWho.entries()].sort((a, b) => b[1] - a[1]);
			if (ranked.length > 0) {
				const [name, ms] = ranked[0];
				out.push({
					kind: 'longtask',
					lead: translate('causeLongTaskLead'),
					name,
					strength: ms >= 100 ? 'medium' : 'weak',
					basis: [`${name} · ${ms}ms`, `${translate('cumulative')} ${ranked.length}${translate('times')}`],
					limits: [notRoot, translate('causeLongTaskLimit')],
					provenance: 'inferred',
				});
			}
			// ③ 宿主事件循环(有快照才提,快照年龄写在支持证据里)
			const host = row.host;
			const loop = host === null || host === undefined ? null : host.eventLoop ?? null;
			if (loop !== null && typeof loop.p99 === 'number' && loop.p99 > 50) {
				const age = typeof host.snapshotAgeMs === 'number' ? host.snapshotAgeMs : null;
				out.push({
					kind: 'host',
					lead: translate('causeHostLead'),
					name: translate('hostShort'),
					strength: loop.p99 > 200 ? 'strong' : 'medium',
					basis: [`${translate('causeHostBasis')} ${loop.p50}ms / ${loop.p99}ms`,
						age === null ? translate('notYet') : `${translate('maxLabel')} ${age >= 0 ? '-' : '+'}${Math.abs(age)}ms`],
					limits: [notRoot, translate('hostSnapshotNotInstant')],
					provenance: 'measured',
				});
			}
			// ④ JS 证据缺失那一支:不许把"没证据"写成"浏览器节流"
			if (summary.worstFrameJs === 'none') {
				const throttle = summary.suspectedThrottle === true;
				out.push({
					kind: 'unknown',
					lead: translate('causeNoEvidenceLead'),
					name: null,
					strength: throttle ? 'weak' : 'none',
					basis: [throttle ? translate('verdictThrottleText') : translate('verdictUnattributedText')],
					limits: [translate('jsNo')],
					provenance: 'unknown',
				});
			}
			return out.slice(0, CAUSE_MAX);
		}
		function manifestFor(row, options) {
			const caps = capabilities();
			const win = row === null || row === undefined ? null : row.window ?? null;
			const raw = {
				schemaVersion: PACK_SCHEMA_VERSION,
				kind: 'dsh-perf-hud-diagnostic-pack',
				plugin: PKG,
				pluginVersion: state.host === null || state.host === undefined ? null : state.host.pluginVersion ?? null,
				dshVersion: state.host === null || state.host === undefined ? null : state.host.dshVersion ?? null,
				platform: {
					page: location.href,
					userAgent: navigator.userAgent,
					viewport: `${W.innerWidth}×${W.innerHeight}`,
					devicePixelRatio: W.devicePixelRatio,
					hardwareConcurrency: navigator.hardwareConcurrency ?? null,
					utcOffsetMin: -new Date().getTimezoneOffset(),
				},
				captureTier: state.deep === true ? 'deep' : 'watch',
				instrumented: state.on === true && state.deep === true,
				language: docLang(),
				exportedAt: new Date().toISOString(),
				range: win === null ? null : { from: win.from ?? null, to: win.to ?? null, preMs: win.preMs ?? null, postMs: win.postMs ?? null },
				// null = 老包(没有 integrity 字段):不知道,不许冒充"完整"
				complete: row === null || row === undefined || row.integrity === undefined ? null : row.integrity.captureComplete !== false,
				incident: row === null || row === undefined ? null : {
					id: row.id, at: row.at, cause: row.cause, severity: row.severity,
					frames: Array.isArray(row.frames) ? row.frames.length : 0,
					loafEntries: Array.isArray(row.loaf) ? row.loaf.length : 0,
					longTasks: Array.isArray(row.longTasks) ? row.longTasks.length : 0,
					interactions: Array.isArray(row.interactions) ? row.interactions.length : 0,
					integrity: row.integrity ?? null,
				},
				tally: tallyReport(),
				capabilities: caps,
				// 这份包**不含**什么:与 redactionReport 的 neverCollected 是同一份口径
				notIncluded: [
					'聊天正文与提示词(本插件从不读取被测量的 DOM 内容)',
					'Cookie / Token / 请求头(只读 performance 观察器与自己的宿主路由回执)',
					'宿主进程的 CPU profile(路由能采,但这份包没有自动采)',
				],
				files: ['manifest.json', 'summary.md', 'incident.json', 'README.md'],
			};
			const safe = redactExport(raw, options);
			safe.redaction = redactionReport(options);
			return safe;
		}
		/** 摘要的固定形态:摘要 → 假设 → 缺失 → 下一步 → 元信息(产品计划 §4 要求的那六段)。 */
		function diagnosticSummary(row, options) {
			const t = translate;
			const opts = options ?? {};
			const lines = [t('packSummaryTitle'), ''];
			const verdict = incidentVerdict(row);
			const owner = incidentOwner(row);
			const win = row.window ?? {};
			const span = typeof win.fromMs === 'number' && typeof win.toMs === 'number' ? round1(win.toMs - win.fromMs) : null;
			lines.push(t('packSecSummary'));
			lines.push(`- ${t('sevLabel')}:${severityText(severityLevel(row.severity))}(${Math.round(row.severity)}ms)`);
			// ⚠️ 摘要这一行**必须吃同一个 dropFreeText**:否则同一份包里 `incident.json` 把备注置空了、
			// `summary.md` 还带着原文 —— 两份文件各说各话,而包里那份正是要交给 AI 的(实测踩过)。
			// 保留那一支也要过 scrubParams:自由文本里粘贴的凭据同样不许原样出门。
			const note = row.note === null || row.note === undefined ? '' : String(row.note);
			const noteText = note === '' ? '' : (opts.dropFreeText === true ? ` · ${t('previewNotesDropped')}` : ` · ${redactPath(scrubParams(note))}`);
			lines.push(`- ${t('worstEvent')}:${row.at}${noteText}`);
			lines.push(`- ${t('evWindow')}:${span === null ? t('none') : `${Math.round(span)}ms`} · ${Array.isArray(row.frames) ? row.frames.length : 0}${t('framesUnit')}`);
			if (row.integrity?.captureComplete === false) {
				lines.push(`- ${t('integrityIncomplete')}:LoAF ${row.integrity.loafDropped} · longtask ${row.integrity.longTaskDropped}(${row.integrity.reasons.join(' · ')})`);
			}
			lines.push(`- ${t('verdictLabel')}:${t(verdict.level === 'confirmed' ? 'verdictConfirmed' : verdict.level === 'suspected' ? 'verdictSuspected' : 'verdictUnattributed')}`);
			lines.push('');
			// 假设
			const candidates = causeCandidates(row);
			lines.push(t('packSecCandidates'));
			if (candidates.length === 0) {
				lines.push(`- ${t('packNoCandidate')}`);
			} else {
				candidates.forEach((item, index) => {
					lines.push(`### ${t('packCauseLabel')} ${index + 1}:${item.lead}${item.name === null ? '' : ` · ${item.name}`} —— ${strengthText(item.strength)}`);
					lines.push(`- ${t('packSupport')}:${item.basis.join(' / ')}`);
					lines.push(`- ${t('packLimits')}:${item.limits.join(' / ')}`);
					lines.push(`- ${t('packProvenance')}:${provenanceText(item.provenance)}`);
					lines.push('');
				});
			}
			// 缺失 / 下一步 / 元信息
			const gaps = capabilityMissing(row);
			lines.push(t('packSecMissing'));
			for (const line of gaps.missing) lines.push(`- ${line}`);
			lines.push('');
			lines.push(t('packSecNext'));
			for (const line of gaps.howToAdd) lines.push(`- ${line}`);
			lines.push('');
			lines.push(t('packSecMeta'));
			lines.push(`- plugin:${PKG}${state.host === null || state.host === undefined || state.host.pluginVersion === undefined ? '' : ` v${state.host.pluginVersion}`}`);
			lines.push(`- ${t('packTier')}:${state.deep === true ? t('deepShort') : t('watch')}`);
			lines.push(`- exportedAt:${new Date().toISOString()}`);
			lines.push(`- schemaVersion:${PACK_SCHEMA_VERSION}`);
			if (owner !== null) lines.push(`- ${t('evOwner')}:${owner.name} · ${Math.round(owner.ms)}ms`);
			lines.push('');
			return lines.join('\n');
		}
		/** 包里的 README:告诉人(和 AI)这份包是什么、怎么读、缺什么。跟着界面语言走。 */
		function packReadme(options) {
			const t = translate;
			return [
				t('packReadmeTitle'),
				'',
				t('packReadmeWhat'),
				t('packReadmeHow'),
				t('packReadmePrivacy'),
				t('packReadmeNotes'),
				'',
			].join('\n');
		}
		/**
		 * 构建诊断包(不下载)。返回 `{ files, preview }` —— 顺序固定,`manifest.json` 在最前,
		 * 因为它是"这份包该怎么读"的入口。
		 */
		function buildPack(id, options) {
			const row = pickIncident(id);
			if (row === null || row === undefined) return null;
			const opts = options ?? {};
			const report = incidentReport(id, opts);
			const files = [
				{ name: 'manifest.json', text: JSON.stringify(manifestFor(row, opts), null, 2) },
				{ name: 'summary.md', text: diagnosticSummary(row, opts) },
				{ name: 'incident.json', text: JSON.stringify(report, null, 2) },
				{ name: 'README.md', text: packReadme(opts) },
			];
			return { files, preview: packPreview(id, opts, files) };
		}
		/**
		 * 导出预览:即将包含哪些文件、各多大、脱了什么、哪些证据是缺的。
		 * `files` 传进来就直接算(避免重复构建),否则只算清单不算内容。
		 */
		function packPreview(id, options, files) {
			const row = pickIncident(id);
			if (row === null || row === undefined) return null;
			const opts = options ?? {};
			const list = files ?? buildPack(id, opts)?.files ?? [];
			// 压缩包总大小:预览里给用户看的那个数(store 模式 ≈ 各份之和 + 每个条目 ~100 字节的目录开销)
			const zipBytes = list.length === 0 ? 0 : zipStore(list).length;
			const gaps = capabilityMissing(row);
			return {
				incident: { id: row.id, at: row.at, severity: row.severity },
				tier: state.deep === true ? 'deep' : 'watch',
				files: list.map((file) => ({
					name: file.name,
					bytes: file.text.length,
				})),
				zipBytes,
				includes: [
					'事故的结构化证据:帧序列 / LoAF / 窗口内 long task / 环境读数',
					'能力矩阵与缺失声明(哪一层采到了、哪一层没有、为什么)',
					'发生频次(最近 24 小时的滚动计数)',
				],
				excludes: capabilities().unobserved.map((item) => `${item.id}:${item.reason}`),
				// 两条导出路径的**唯一实质差别**:给 AI 的那条把自由文本置空并标 noteDropped,
				// 本机调试件保留。放在预览里写明,免得用户以为两份是同一份。
				notes: opts.dropFreeText === true ? 'dropped' : 'kept',
				redaction: redactionReport(opts),
				missingCount: gaps.missing.length,
				nextStepCount: gaps.howToAdd.length,
				note: translate('packPreviewNote'),
			};
		}
		/**
		 * 下载整包:**一个 zip 一次搞定**(P1 之前是逐个下载 4 个文件 —— 部分浏览器会把后续
		 * 下载拦掉,而且用户文件夹里会散落四个文件)。文件名带 `-ai` / `-full`,两条路径落到
		 * 磁盘上也分得清。返回 false 表示没这个 id(不静默成功)。
		 */
		function exportPack(id, options) {
			const opts = options ?? {};
			const pack = buildPack(id, opts);
			if (pack === null) return false;
			const row = pickIncident(id);
			const bytes = zipStore(pack.files);
			const base = incidentFileName(row, row.at).replace(/\.json$/, '');
			const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
			const link = document.createElement('a');
			link.href = url;
			link.download = `${base}${opts.dropFreeText === true ? '-ai' : '-full'}.zip`;
			link.click();   // 不挂进 body:避免污染被统计的 DOM
			natives.setTimeout(() => URL.revokeObjectURL(url), 2000);
			return true;
		}
		/** 敏感参数只换**值**、保留键名 —— 读的人要知道这里本来有什么,才知道该不该去别处找。 */
		function scrubParams(text) {
			const raw = String(text);
			if (raw.indexOf('=') === -1) return raw;
			return raw
				.replace(/([?&#])([A-Za-z0-9_.-]+)=([^&#\s]*)/g,
					(all, sep, key) => (SECRET_PARAM.test(key) ? `${sep}${key}=<redacted>` : all))
				// 自由文本里的凭据常常是**裸的** `token=abc`(前面没有 ?/&),URL 那条规则漏掉它们。
				// 再按词边界扫一遍:代价是 `code=200` 这类无关键也会被换成占位符 —— 宁可多脱一个,不要漏一个。
				.replace(/(^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+)=([^\s&#]*)/g, (all, head, key, value) =>
					(SECRET_PARAM.test(key) && value !== '<redacted>' ? `${head}${key}=<redacted>` : all));
		}
		/** 页面地址:只留 origin + path(+ 脱敏过的 hash),**查询串整段丢**。 */
		function redactPageUrl(raw) {
			if (typeof raw !== 'string' || raw === '') return null;
			try {
				const url = new URL(raw, location.href);
				if (url.origin === 'null') return scrubParams(raw);
				return `${url.origin}${url.pathname}${url.hash === '' ? '' : scrubParams(url.hash)}`;
			} catch (error) {
				return scrubParams(raw);
			}
		}
		/** 脚本 URL:路径与 `rev` 都要留(它们是证据),去掉协议+主机,敏感参数换值。 */
		function redactScriptUrl(raw) {
			if (typeof raw !== 'string' || raw === '') return null;
			return scrubParams(String(raw).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, ''));
		}
		/** 用户目录 → `~`:整条路径带着用户名,把它交出去等于连人一起交出去。 */
		function redactPath(text) {
			if (typeof text !== 'string' || text === '') return text;
			return text.replace(HOME_PATH, '$1~').replace(WIN_HOME_PATH, '~');
		}
		/** UA 只留"浏览器主版本 + 系统":完整 UA 能指纹到具体机器,而兼容性判断只用到主版本。 */
		function redactUserAgent(raw) {
			if (typeof raw !== 'string' || raw === '') return null;
			const browser = /(Edg|OPR|Chrome|CriOS|Firefox|FxiOS|Version)\/(\d+)/.exec(raw);
			const os = /(Windows NT [\d.]+|Mac OS X [\d_]+|Android \d+|iPhone OS [\d_]+|Linux)/.exec(raw);
			const head = browser === null ? 'unknown-browser' : `${browser[1]}/${browser[2]}`;
			return `${head} · ${os === null ? 'unknown-os' : os[1]}`;
		}
		/**
		 * 深度脱敏:导出件只有这一个出口,规则集中在这里 —— 以后加导出字段不会漏。
		 * 其余字符串一律过 `scrubParams` + `redactPath`(不对路就原样返回),所以**错误原文、
		 * 组件栈、profile 路径**这些"顺手带出来的东西"也被一并覆盖。
		 * `options.dropFreeText` 为真时把自由文本置空并标 `noteDropped:true`:那些是用户自己敲的字,
		 * 可能整段贴着敏感内容,AI 诊断包默认不带(原始导出件仍保留 —— 那是本机调试件)。
		 */
		function redactExport(value, options, key) {
			const opts = options ?? {};
			if (typeof value === 'string') {
				if (opts.dropFreeText === true && FREE_TEXT_KEYS.has(key)) return null;
				if (PAGE_KEYS.has(key)) return redactPageUrl(value);
				if (SCRIPT_URL_KEYS.has(key)) return redactScriptUrl(value);
				if (key === 'userAgent') return redactUserAgent(value);
				return redactPath(scrubParams(value));
			}
			if (Array.isArray(value)) return value.map((item) => redactExport(item, opts, key));
			if (value === null || typeof value !== 'object') return value;
			const out = {};
			for (const name of Object.keys(value)) {
				const item = value[name];
				if (opts.dropFreeText === true && FREE_TEXT_KEYS.has(name) && (item === null || typeof item === 'string')) {
					out[name] = null;
					out[`${name}Dropped`] = true;
					continue;
				}
				out[name] = redactExport(item, opts, name);
			}
			return out;
		}
		/** 这份文件做了什么减法、留了什么、本来就没采什么 —— 三问三答,给读文件的人。 */
		function redactionReport(options) {
			const opts = options ?? {};
			return {
				rule: '导出时做减法,不做匿名化;applied / kept / neverCollected 三个数组说明做了什么、没做什么',
				applied: [
					'page / href:只保留 origin + path,查询串整段丢弃(DSH 首屏的 ?token=… 就在这里)',
					`url / urls / sourceURL:去掉协议与主机,保留路径与 rev;这些键名的值会被替换成 <redacted>:${SECRET_PARAM_NAMES.join(' / ')}`,
					'其余字符串:/Users/<用户名>、/home/<用户名>、C:\\Users\\<用户名> 一律换成 ~',
					'userAgent:只保留浏览器主版本 + 操作系统(完整 UA 能指纹到具体机器)',
					opts.dropFreeText === true
						? '自由文本(note / 场景标记的 note):已置空并标 noteDropped:true'
						: '自由文本(note / 场景标记的 note):原样保留(用户自己敲的字,可能含敏感内容)',
				],
				kept: [
					'性能数值本身(毫秒、计数、分位、帧序列)—— 不含个人信息,丢了这份文件就没用了',
					'插件的包名 / 源文件路径 / 行号 —— 这是归因的全部价值,路径只做了 ~ 降级',
					'viewport / devicePixelRatio / hardwareConcurrency / 时区 —— 解读帧耗时与分位要用',
				],
				neverCollected: [
					'聊天正文与提示词(本插件从不读取被测量的 DOM 内容)',
					'Cookie / Token / 请求头(只读 performance 观察器与自己的宿主路由回执)',
					'宿主进程内存 / 磁盘 / 进程树(那是 dsh-perf-lens 的地盘)',
				],
				freeText: opts.dropFreeText === true ? [] : ['incident.note', 'timeline.marks[].note'],
			};
		}
		function snapshot(options) {
			const worst = worstLongTask();
			const payload = {
				plugin: PKG,
				exportedAt: new Date().toISOString(),
				// 自描述头:文件离开现场后仍能自证口径
				context: {
					scenario: state.streaming ? 'streaming' : 'idle',
					idleSeconds: state.idleSince === 0 ? 0 : Math.round((performance.now() - state.idleSince) / 1000),
					instrumented: state.on && state.deep === true,
					deep: state.deep === true,
					precise: {
						enabled: state.precise,
						bundles: [...bundleMaps.entries()].map(([key, entry]) => ({
							label: bundleLabel(key), state: entry.state, source: entry.source, sections: entry.count,
						})),
					},
					// sourcemap 缓存是可重建的:淘汰 / 写失败都计数,别让它静默吃满 localStorage
					mapCache: { max: MAP_CACHE_MAX, evicted: state.mapCache.evicted, failed: state.mapCache.failed },
					host: {
						route: HOST_ROUTE,
						reachable: state.hostError === null,
						error: state.hostError,
						profile: state.host === null || state.host === undefined ? null : state.host.profile ?? null,
						nodeVersion: state.host === null || state.host === undefined ? null : state.host.nodeVersion ?? null,
						pluginVersion: state.host === null || state.host === undefined ? null : state.host.pluginVersion ?? null,
					},
					isolation: { candidates: experiment.candidates, method: experiment.method, loadBurnMs: EXPERIMENT_LOAD_BURN_MS, loadPeriodMs: EXPERIMENT_LOAD_PERIOD_MS },
					// 判色阈值也写进文件:别人拿到 JSON 能按同一套口径重新解读
					recorder: selfStats(),   // 测量工具先自证没有明显改变被测对象
					// 证据的审计属性:拿到文件的人要能判断"这份证据被裁过没有、读回来的算不算数"。
					// 事故包的 context.watch 里本来就有这几个计数,这里补的是**整机导出件**那一份。
					store: {
						restored: state.watch.restored,          // 这次启动从落盘读回几条
						trimmedByBytes: state.watch.trimmedByBytes,   // 因为字节上限被裁掉的条数
						deduped: state.watch.deduped,            // 同一 id / 同一 at|cause 去重去掉的条数
						captured: state.watch.captured,          // 一共捕获过几次
						dropped: state.watch.dropped,            // 抓到了但没留存下来的次数
					},
					// 发生频次(跨刷新,最近 24h 滚动窗口)—— 与上面的 store(本次会话)不是同一窗口
					tally: tallyReport(),
					// 能力矩阵:哪一层采到了、哪一层没有、为什么 —— 与事故包读同一份函数
					capabilities: capabilities(),
					// A2:跨会话基线(每个会话一条,只进导出件)。口径写在 note 里
					sessionBaselines: sessionBaselines(),
					thresholds: {
						fps: { warnBelow: 50, errorBelow: 30 },
						frameMs: { warnAbove: 120, errorAbove: 200 },
						unattrPeakForUnexplainedFrame: 100,
						hostP99Ms: { warnAbove: 50, errorAbove: 200 },
						rttP99Ms: { warnAbove: 100, errorAbove: 300 },
					},
				},
				page: location.href,
				userAgent: navigator.userAgent,
				instrumented: state.on && state.deep === true,
				deep: state.deep === true,
				since: new Date(state.since > 0 ? state.since : Date.now()).toISOString(),
				summary: {
					fps: round1(state.fps),
					worstFrameMs: round1(state.frameWorst),
					attributedMsPerSec: round1(state.attributedPerSec),
					unattributedMsPerFrame: { avg: round1(state.unattrAvg), peak: round1(state.unattrPeak) },
					worstLongTask60s: worst === null ? null : {
						at: new Date(worst.t).toISOString(),
						ms: round1(worst.ms),
						owner: worst.owner,
						startTime: round1(worst.at),
					},
					domNodes: state.dom.total,
					domGrowthPerMin: round1(rate(state.dom.series)),
					heapUsedBytes: state.heap,
					heapGrowthPerMin: state.heap === null ? null : Math.round(rate(state.heapSeries)),
					domMutations: {
						total: state.mutations,
						sampledEvery: MUT_SAMPLE,
						perPlugin: domWriteTable(),
					},
					longTaskStats: { total: state.ltTotal, attributed: state.ltBlamed },
					worstSecondLast60s: worstSecond(),
					containers: TARGETS.map((target) => {
						const entry = state.targets.get(target.id);
						return {
							id: target.id,
							nodes: entry === undefined ? null : entry.nodes,
							growthPerMin: entry === undefined ? 0 : round1(rate(entry.series)),
						};
					}),
					plugins: pluginTable(),
				},
				// ── 三段取证 ────────────────────────────────────────────────
				// 1) 采样曲线:每秒一条 + 场景标记 + 空闲基线
				timeline: {
					note: '每秒一条(t 是 epoch ms):fps / 最差帧 / longtask 条数 / 节点 / 堆 / 归因 Top3;marks 是场景标记',
					samples: ring,
					marks: state.marks,
					idleBaseline: state.idleBaseline,
				},
				// 2) longtask 明细:owner = 调度方包名,component = 渲染方组件名
				longTasks: {
					note: 'owner 来自调度点插桩,component 来自 fiber 上溯;source 标明这条靠哪边定的',
					total: state.ltTotal,
					attributed: state.ltBlamed,
					records: state.longTasks,
				},
				// 3) 隔离实验:逐插件关/开的因果对照与恢复核验
				isolation: {
					note: '每步带宿主真实回执(changeResult);applied:false 表示宿主没真的关掉,该步不产出 Δ',
					phase: experiment.phase,
					message: experiment.message,
					method: experiment.method,
					via: experiment.via,
					viaLabel: viaLabel(experiment.via),
					noiseFloor: experiment.noise,
					drifts: experiment.drifts,
					startedAt: experiment.startedAt > 0 ? new Date(experiment.startedAt).toISOString() : null,
					candidates: experiment.candidates,
					candidateState: experiment.candidateState,
					baseline: experiment.baseline,
					results: experiment.results,
					restored: experiment.restored,
				},
				host: {
					at: state.hostAt > 0 ? new Date(state.hostAt).toISOString() : null,
					error: state.hostError,
					last: state.host,
					eventWatch: state.hostEvents,
				},
				link: { stats60s: linkStats(), throughput: state.linkText, suspect: suspectLink(), samples: state.link.slice(-120) },
				// A4:交互延迟(event / element timing)。只进导出件,面板不显示
				interactions: {
					state: state.watch.eventState,
					supported: state.watch.eventSupported,
					thresholdMs: WATCH_EVENT_MS,
					events: state.watch.eventCount,
					elements: state.watch.elementCount,
					note: 'event 给端到端时长(ms)与推导出来的 waitMs(输入延迟)/ handlerMs(处理器本身);isInteraction 为真的才是 interactionId>0 的"真交互",pointerover 那类被动事件也会进来(它们的 ms 是到下一次渲染更新为止)。element 只观察带 elementtiming 属性的元素(DSH 的 DOM 上没有,恒为 0 是正常的)。帧内拆分(输入延迟/处理/呈现)页面内拿不到',
					kept: state.watch.interactions.length,
					records: state.watch.interactions,
				},
				verification: verification(),
				errors: state.errors,
			};
			// 唯一的出口:先脱敏,再把"减了什么"贴上去(报告本身不过脱敏,否则它会把自己的说明改掉)
			const safe = redactExport(payload, options);
			safe.context.redaction = redactionReport(options);
			return safe;
		}
		function exportJson() {
			flush(true);
			const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' }));
			const link = document.createElement('a');
			link.href = url;
			link.download = `perf-hud-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
			link.click();   // 不挂进 body:避免污染被统计的 DOM
			natives.setTimeout(() => URL.revokeObjectURL(url), 2000);
		}
		/**
		 * 事故包:一份给"读它的人(或 agent)"的自描述文件。
		 * 只放证据与口径,不做归因推断;并且**显式写出这次没拿到什么**(missing)以及怎么补齐 ——
		 * 沿用"不许假装成功"那条:缺的东西写清楚,比不写有用。
		 */
		/**
		 * 取一条事故:数字 = 按严重度的下标(0 最差),字符串 = id,`'latest'` = 时刻最新的那条。
		 * 面板上那个「导出最近一次」以前导的就是下标 0 —— 那是**最差**的一次,而落盘读回的旧事故
		 * 常常正是最差的,于是"最近一次"导出来的是一份几天前的证据(实测踩过两次)。
		 */
		function pickIncident(id) {
			const list = state.watch.incidents;
			if (id === 'latest') {
				let newest = null;
				for (const row of list) if (newest === null || row.at > newest.at) newest = row;
				return newest;
			}
			if (typeof id === 'number') return list[id] ?? null;
			return list.find((row) => row.id === id) ?? null;
		}
		/**
		 * 事故包(下载件 / 交给 AI 的那份)。`options.dropFreeText` 为真时把用户自己敲的
		 * note 置空并标 `noteDropped` —— 诊断包走 true,本机调试导出走默认(false)。
		 */
		function incidentReport(id, options) {
			const incident = pickIncident(id);
			if (incident === null || incident === undefined) return null;
			// 缺失声明**由能力矩阵推**(唯一事实来源),不再手写一串 if —— 前缀仍是线上断言认的那几个
			const gaps = capabilityMissing(incident);
			const missing = gaps.missing;
			const howToAdd = gaps.howToAdd;
			const payload = {
				plugin: PKG,
				kind: 'perf-hud-incident',
				schema: 3,                      // 3 = incident.integrity(窗口完整性);2 = URLs 抽表
				exportedAt: new Date().toISOString(),
				context: {
					page: location.href,
					userAgent: navigator.userAgent,
					scenario: state.streaming ? 'streaming' : 'idle',
					watch: watchStatus(),
					// 导出时刻的滚动 24h 计数(跨刷新)。它**不属于事故窗口** —— 用途是回答
					// "最近是偶发还是变频繁了";scope / sessionCounters 里写明别当这一条的统计口径
					tally: tallyReport(),
					// A2:跨会话基线(只进导出件)。readonly 参照,别当回归判定
					sessionBaselines: sessionBaselines(),
					thresholds: {
						triggerMs: WATCH_TRIGGER_MS, gapMs: WATCH_GAP_MS,
						preMs: WATCH_PRE_MS, postMs: WATCH_POST_MS,
						keep: WATCH_INCIDENT_MAX, dailyDays: WATCH_DAILY_DAYS, keepMax: WATCH_KEEP_MAX,
						reactionMs: WATCH_REACTION_MS,
					},
					missing,
					howToAdd,
					howToRead: [
						'incident.env.utcOffsetMin 是采这份包时的本地时区偏移(分钟,UTC+8 = 480):把 at 加上它才是当时墙上钟的时间',
						'incident.frames:窗口内每一帧(t 是 perf 毫秒,要靠 incident.env.perfOrigin 换成墙钟;ms 是帧间隔;gap:true 表示 rAF 被挂起,不是卡顿)。首帧晚于 window.fromMs 是正常的,但**差得多就说明这一段被挂起过**(实测有一份晚了 6.3 秒,因为中间有一次 22.7 秒的 rAF 挂起)—— 去看 frames[].gap',
						'incident.loaf 与 incident.frames 是**同一信号的两个视图**(LoAF 的 t+dur 就落在某一帧上),不是两份独立证据:别相加,也别当互相印证',
						'incident.loaf[].blocking(blockingDuration)只累计"被归因到的 >50ms 长任务"的超出部分 —— **它可以是 0,而这一帧仍然有几百毫秒**。判严重度看帧间隔,blocking=0 不等于没卡',
						'incident.longTasks 是既有四条腿落在窗口内的明细(at=任务开始的 perf 毫秒,t=上报时刻的墙钟毫秒),**它不是慢帧清单**:条数通常远少于超线帧',
						'incident.interactions 是窗口内 ≥100ms 的交互(event / element timing):`ms` 是端到端(到下一次渲染更新为止),`waitMs` 是事件发生到处理器真正开始的输入延迟、`handlerMs` 是处理器本身(两个都是推导值,原始字段 processingStart/End 也在);`isInteraction` 为真的才是 interactionId>0 的真交互,pointerover 那类被动事件也会进来。**这一层不承诺帧内拆分**(输入延迟 / 处理 / 呈现得去 DevTools 的 Interactions 轨道看);`type: "element"` 的条目只可能来自带 `elementtiming` 属性的元素,DSH 页面上恒为 0',
						'incident.baseline 是**除这一段之外**整个帧环的分布(故意排除本窗口,否则"比会话最差还差"永远不成立)—— 拿它和 summary 比,才知道这一段是真的比平时差还是这台机器一直这样',
						'context.sessionBaselines 是**跨会话**的帧分布(每个会话一条,最多 20 条;只进导出件,面板不显示)。它是**粗参照,不是回归判定**:会话之间的负载、视口、是否插桩都不同,帧数量级也能差一个数量级 —— 只看"这次是不是比平时差一个量级",别拿它下"变慢了"的结论',
						'summary.worstFrameJs / suspectedThrottle:最差那一帧有没有 longtask / LoAF 与它重叠;若 none 且前后帧都健康(worstFrameNeighboursMs < 100),更像浏览器把 rAF 节流或挂起了一次,不是页面真忙了那么久',
						'脚本的 URL 不在脚本里:incident.urls 是字符串表,scripts[].u 是它的下标(u=-1 表示没有 URL)—— 抽表是因为同一个 combo URL 会重复几十遍',
						'scripts[].pkg 是这条脚本归属的包名(合并批里靠"字符位置 → 行号 → sourcemap 分段表"还原);pkg 为 null 时看 scripts[].pkgVia:url(单包 URL 直接读出来)/ section(分段表算出来)/ precise-off(精确归因没开)/ text-pending(脚本文本还在拉)/ not-plugin(宿主自己的 bundle)…',
						'summary.topScripts[].file / .line 是"打开哪个文件、哪一段":file 是那个包的**源文件路径**(合并批取自 sourcemap section 的 sources;probe 兜底或老缓存时为 null);line 是**脚本文本自己的行号**(单包 = 那个文件;合并批 = 合并后的大文件)。⚠️ 它**不是**原始源码(TS/TSX)的行号 —— 那要解开 section 内层 mappings 的 VLQ,本项目没做;lineVia 说明行号是怎么来的(text / text-pending / out-of-range …)',
						'scripts[].fn(sourceFunctionName)与 scripts[].ms(sourceCharPosition→duration)是 LoAF **直接给的**(直接测量);pkg / file / line 是由 URL 与分段表**推断的**(归因推断);原始源码行号、调用栈、函数级耗时**都拿不到**(尚无法确认)—— 这条链能缩小到"哪个包的哪个文件哪一段",不能直接指出根因',
						'summary.topScripts[].invoker 是这条脚本**被谁调起来的**(与面板「按来源」同一份归一规则);事件处理器的 invoker 形如 DOMWebSocket.onmessage,不代表"这一帧的 JS 全部来自它"',
						'incident.interactions 是窗口内 ≥100ms 的交互(event timing):ms 是**端到端**时长(到下一次渲染更新),waitMs / handlerMs 是推导出来的两段;**它不拆帧内**(输入延迟/处理/呈现要 DevTools Interactions 轨道)',
						'incident.packages 是按包汇总的脚本耗时(降序),summary.pkgCoverage 是有名字的脚本占比 —— 覆盖率不到 100% 时别把第一行当成全部',
						'脚本侧再往下拆一层:scripts[].forcedMs(forcedStyleAndLayoutDuration)是脚本耗时里"强制样式布局"那部分 —— **它已经算在 ms 里**,别再相加;它是"来源是样式而不是业务逻辑"的同步布局。面板「取证明细」里那两行(脚本按包 / 纯 JS 与强制布局)就是这两件事',
						'incident.integrity.captureComplete 为 false 时,这份现场**采集本身丢过记录**(loafDropped / longTaskDropped 是窗口内的条数;reasons 写明是环形缓冲溢出还是前摇已经滚出环)—— 它仍是一份真实切片,但不能当成"完整的那 13 秒";hiddenGaps 是另一回事(rAF 被挂起,不是我们丢数据)',
						'incident.summary 是上面几块的汇总(含窗口自己的 p50/p90/p99),方便直接和 incident.baseline 比;这一层不做推断,结论请自己下',
						'context.watch.kept 按**严重度降序**,不是时间序;带 restored 的条目来自上一次会话(时间靠 env.perfOrigin 对齐),所以 id 与时间看起来会跳',
						'context.watch.kept[].tier 说明这条是靠哪一档留下来的:worst = 全局最差那一档(前 10 条)、daily = 它那一天最差的一条(最多留最近 7 天)、both = 两档都占。留存是**两档并集**,所以条数上限是 10 + 7 而不是 10 —— 单靠全局最差档时,"昨天下午那次卡"会被同一小时里的 10 次挤掉',
					],
				},
				incident,
			};
			const safe = redactExport(payload, options);
			safe.context.redaction = redactionReport(options);
			return safe;
		}
		/** 下载一份事故包。返回 false 表示没这个 id(不静默成功)。 */
		/**
		 * 导出文件名:`perf-hud-20261008-220358-i84.json`。
		 * 用**事故发生的本地时间**(不是导出时间)——文件名要回答"这是哪一次",不是"我什么时候导的";
		 * ISO 的 `2026-10-08T14-03-58-490Z` 既难读又和面板上的时间对不上。日期在前可排序,
		 * 不含冒号(Windows 不允许)。完整 ISO 与 perfOrigin 都在文件体里。
		 */
		function incidentFileName(incident, at) {
			const d = at instanceof Date ? at : new Date(at);
			const p = (n) => (String(n).length < 2 ? `0${n}` : String(n));
			return `perf-hud-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${incident.id}.json`;
		}
		function exportIncident(id) {
			const report = incidentReport(id);
			if (report === null) return false;
			const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
			const link = document.createElement('a');
			link.href = url;
			link.download = incidentFileName(report.incident, report.incident.at);
			link.click();
			natives.setTimeout(() => URL.revokeObjectURL(url), 2000);
			return true;
		}
		// ───────────────── 事故:选中上下文 + 面板上那几行文案 ─────────────────
		/**
		 * 事故严重度的**文字档位**。面板上"严重度"不许只靠颜色表达(色盲 / 打印 / 截图转灰度
		 * 都会丢信息),所以先算档位,再同时给文字与 token 颜色。
		 * 阈值不另立一套:红档 200ms 与面板判色的红档同一条线(见 README「面板怎么读」);
		 * 黄档用**守夜触发线** 100ms —— 它已经是一条事故了,"正常"这个词在这里没有意义。
		 */
		function severityLevel(ms) {
			if (typeof ms !== 'number' || Number.isNaN(ms)) return 'none';
			if (ms >= 200) return 'bad';
			if (ms >= WATCH_TRIGGER_MS) return 'warn';
			return 'ok';
		}
		function severityText(level) {
			if (level === 'bad') return translate('sevBad');
			if (level === 'warn') return translate('sevWarn');
			if (level === 'ok') return translate('sevOk');
			return translate('none');
		}
		function severityColor(level) {
			if (level === 'bad') return 'var(--dsw-alias-state-error-primary)';
			if (level === 'warn') return 'var(--dsw-alias-state-warn-primary)';
			if (level === 'ok') return 'var(--dsw-alias-state-success-primary)';
			return 'var(--dsw-alias-label-secondary)';
		}
		/**
		 * 这条事故"是谁":先看按包汇总(packages,已经按包聚合、降序),再退到 topScripts[0]。
		 * 两者都是同一份 scripts 数据,但 packages 去过重 —— 所以它是第一顺位。
		 * 一个包名都没定到时返回 null(面板照实写未归因,**不猜**)。
		 */
		function incidentOwner(row) {
			if (row === null || row === undefined) return null;
			const pkg = Array.isArray(row.packages) && row.packages.length > 0 ? row.packages[0] : null;
			if (pkg !== null && pkg !== undefined && pkg.pkg !== null && pkg.pkg !== undefined) {
				return { name: pkg.pkg, ms: pkg.ms, count: pkg.count };
			}
			const script = row.summary === undefined || row.summary === null ? undefined : row.summary.topScripts[0];
			if (script !== undefined && script !== null && script.pkg !== null && script.pkg !== undefined) {
				return { name: script.pkg, ms: script.ms, count: 1 };
			}
			return null;
		}
		/**
		 * 面板当前选中的那条事故。`{ row, auto }`:
		 *   auto=true  = 没选(跟严重度最差那条,incidents 由 keepIncident 维持降序);
		 *   auto=false = 用户选的;
		 * 选中的那条被更差的新事故挤出留存清单之后**退回自动** —— 不指着一个不存在的条目
		 * (与翻帧那条 `pickT` 的规矩同源)。
		 */
		function selectedIncident() {
			const list = state.watch.incidents;
			if (list.length === 0) return { row: null, auto: true };
			// 「自动」有两条口径:严重度最差(默认,事后回看的重点)或**时刻最新**(刚卡的那一下)。
			// 取不到最新(数据形状不对)时退回最差。
			const auto = state.watch.scope === 'latest' ? (pickIncident('latest') ?? list[0]) : list[0];
			if (state.watch.selId === null) return { row: auto, auto: true };
			const found = list.find((row) => row.id === state.watch.selId);
			if (found === undefined) return { row: auto, auto: true };
			return { row: found, auto: false };
		}
		// ─────────── 诊断上下文 + 历史事故的**逐帧**数据层(全部来自事故包) ───────────
		/**
		 * 当前诊断上下文:`live` = 实时帧环里的当前帧,`incident` = 选中事故里的一条历史帧。
		 *
		 * **取证明细里每一块吃哪份数据,只由这一个函数决定** —— "上面是历史事故、下面是另一条
		 * 实时帧的编号 / 耗时 / 饼图"那类错误在结构上就无处发生(有断言钉住两个上下文不混)。
		 * 没有可看的事故时不给 `incident`:那会是一个只有缺失状态的空壳。
		 */
		function diagMode() {
			if (state.watch.mode !== 'incident') return 'live';
			return selectedIncident().row === null ? 'live' : 'incident';
		}
		/**
		 * 这条事故里**真实存在的帧**。`gap === true` 不是帧,是整段 rAF 被挂起(帧间隔突然变成
		 * 几秒)—— 它是"这段时间没在测",不参与选中、翻帧与序号,只在帧条上留白。
		 */
		function incidentFrameRows(row) {
			if (row === null || row === undefined || Array.isArray(row.frames) === false) return [];
			return row.frames.filter((frame) => frame !== null && typeof frame === 'object'
				&& frame.gap !== true && typeof frame.t === 'number' && Number.isFinite(frame.t));
		}
		/**
		 * 与这一帧**时间上重叠**的那条 LoAF(`incident.loaf`,捕获时存下来的):这一帧的时间分解
		 * 与脚本 / 来源证据都由它提供。重叠多条时取时长最大的那条(一帧里最重的那一次)。
		 * 没有重叠就是**没有记录** —— 面板照实写缺失,不回退到别的帧,更不回退到实时帧环。
		 */
		function incidentLoafAt(row, frame) {
			if (row === null || frame === null || frame === undefined || Array.isArray(row.loaf) === false) return null;
			const start = frame.t - (typeof frame.ms === 'number' ? frame.ms : 0);
			let best = null;
			for (const entry of row.loaf) {
				if (entry === null || typeof entry.t !== 'number') continue;
				if (entry.t <= frame.t && entry.t + (entry.dur ?? 0) >= start
					&& (best === null || (entry.dur ?? 0) > (best.dur ?? 0))) best = entry;
			}
			return best;
		}
		/**
		 * 这条事故里**最差的那一帧**。严重度只按**帧间隔** —— 事故的严重度口径就是它
		 * (见 README:「事故的严重度以帧间隔为准,LoAF 的 blocking 只当补充」);
		 * 实时那条清单用的是 `frameSeverity = max(blocking, LoAF 时长)`,两者各自在自己
		 * 那份数据上有定义,不互相借用。
		 */
		function incidentWorstFrame(row) {
			let worst = null;
			for (const frame of incidentFrameRows(row)) {
				if (worst === null || (frame.ms ?? 0) > (worst.ms ?? 0)) worst = frame;
			}
			return worst;
		}
		/**
		 * 历史回放**选中的那一帧**:默认跟着最差那一帧;点过帧条 / 翻过帧之后就钉住。
		 * 存的是 `t` 不是下标 —— 与实时翻帧同一个理由(下标会悄悄指到另一帧上)。
		 * 选中的 t 在这个包里找不到就退回自动,不指着一个不存在的帧。
		 */
		function selectedIncidentFrame(row) {
			const frames = incidentFrameRows(row);
			if (frames.length === 0) return null;
			if (state.watch.frameT !== null) {
				const hit = frames.find((frame) => frame.t === state.watch.frameT);
				if (hit !== undefined) return hit;
				state.watch.frameT = null;
			}
			return incidentWorstFrame(row);
		}
		/**
		 * 帧条上这一帧的档位:**与实时帧条共用 `sparkLevel`**(≥100ms 红 / ≥50ms 黄 / 其余中性灰),
		 * 判"异常帧"用同一条线(`PICK_MIN_MS` = 守夜触发线)—— 于是"翻得到的异常帧"与实时清单里
		 * "值得回看的帧"是同一批,两处读数不许打架。
		 */
		function incidentFrameLevel(frame) {
			if (frame === null || frame === undefined) return 'empty';
			if (frame.gap === true) return 'gap';
			return sparkLevel({ ms: frame.ms ?? 0, seen: true, gap: false });
		}
		/** 这一帧算不算"异常帧"(翻帧用的判据):帧间隔越过守夜触发线。 */
		function incidentFrameHot(frame) {
			if (frame === null || frame === undefined) return false;
			return frame.gap !== true && (frame.ms ?? 0) >= PICK_MIN_MS;
		}
		/**
		 * 历史帧的导航状态(序号 / 总数 / 上一条 / 下一条有没有)。渲染侧**只读它**来决定按钮的
		 * 可用性 —— 没有上一条就禁用,不留一个"点了没反应"的动作。
		 * `onlyBad`(「只看异常」开着)时,能不能走**按异常帧判**:按钮上写的是什么,判据就是什么。
		 */
		function incidentFrameNav(row, frame, onlyBad) {
			const frames = incidentFrameRows(row);
			const at = frame === null || frame === undefined ? -1 : frames.findIndex((item) => item.t === frame.t);
			const reachable = (dir) => {
				for (let i = at + dir; i >= 0 && i < frames.length; i += dir) {
					if (onlyBad !== true || incidentFrameHot(frames[i])) return true;
				}
				return false;
			};
			return {
				index: at === -1 ? 0 : at + 1,
				count: frames.length,
				hasPrev: at === -1 ? false : reachable(-1),
				hasNext: at === -1 ? false : reachable(1),
			};
		}
		/**
		 * 历史帧翻帧:按**时间序**走一步 —— 帧条是从左到右读的,◀ ▶ 也按时间走(不是按严重度),
		 * 否则"下一帧"会在时间轴上乱跳。到头就停住(按钮那时是禁用的)。
		 * 「只看异常」开着时步长落在**异常帧**上,判据与 `incidentFrameNav` 同一个函数 ——
		 * 所以"按钮亮着"与"按下去会到哪一条"永远是同一件事,不会出现亮着却走不动。
		 */
		function incidentFrameStep(delta) {
			const row = selectedIncident().row;
			const frames = incidentFrameRows(row);
			if (frames.length === 0) return;
			const onlyBad = state.watch.onlyBad === true;
			const current = selectedIncidentFrame(row);
			const at = current === null ? -1 : frames.findIndex((frame) => frame.t === current.t);
			const base = at === -1 ? 0 : at;
			for (let i = Math.max(0, base + delta); i >= 0 && i < frames.length; i += delta) {
				if (onlyBad !== true || incidentFrameHot(frames[i])) { selectIncidentFrame(frames[i].t); return; }
			}
		}
		/**
		 * 这条事故的**归因状态**:已确认 / 可疑 / 未归因(§五)。三档都从**已测量的字段**算:
		 *   · `summary.worstFrameJs`  —— 最差那一帧有没有 longtask / LoAF 与它重叠(直接测量);
		 *   · `incidentOwner()`       —— 窗口里的脚本有没有定到包(归因推断,不是因果证明);
		 *   · `summary.suspectedThrottle` —— 捕获时按 ≥500ms + 无 JS 重叠 + 前后帧中位健康判出来的。
		 *
		 * 这一层刻意不做的事:
		 *   · **不**把"没有 JS 证据"直接说成"浏览器节流 / rAF 被挂起" —— 那是一种可能,只有
		 *     `suspectedThrottle` 真的成立时才提,而且写成"更像…",不写成结论;
		 *   · **不**把"窗口里耗时最高的那个包"宣称成根因 —— 归因只缩小到包 / 文件 / 函数名,
		 *     因果关系要别的证据(Chrome trace、二分、隔离实验)。
		 */
		function incidentVerdict(row) {
			if (row === null || row === undefined) return null;
			const summary = row.summary ?? {};
			const owner = incidentOwner(row);
			const js = summary.worstFrameJs === 'js';
			if (js && owner !== null) {
				return {
					level: 'confirmed', label: translate('verdictConfirmed'),
					detail: `${translate('verdictConfirmedText')}:${short(owner.name)} ${Math.round(owner.ms)}ms · ${translate('verdictNotRootCause')}`,
				};
			}
			if (js) {
				return { level: 'suspected', label: translate('verdictSuspected'), detail: translate('verdictSuspectedJsNoPkg') };
			}
			if (summary.suspectedThrottle === true) {
				return {
					level: 'suspected', label: translate('verdictSuspected'),
					detail: `${translate('verdictThrottleText')}(${translate('verdictNeighbours')} ${summary.worstFrameNeighboursMs}ms)`,
				};
			}
			return { level: 'unattributed', label: translate('verdictUnattributed'), detail: translate('verdictUnattributedText') };
		}
		/** 归因状态的档位色:已确认绿 / 可疑橙 / 未归因中性灰(文字永远同时给,不只靠颜色)。 */
		function verdictColor(level) {
			if (level === 'confirmed') return 'var(--dsw-alias-state-success-primary)';
			if (level === 'suspected') return 'var(--dsw-alias-state-warn-primary)';
			return 'var(--dsw-alias-label-secondary)';
		}
		/** 「最差事件」块的那一行:归因状态 + 第一顺位归属(它**不**自己下结论,结论在下一行)。 */
		function eventEvidenceText(row) {
			if (row === null || row === undefined) return '';
			const owner = incidentOwner(row);
			const verdict = incidentVerdict(row);
			const who = owner === null ? translate('unblamed') : `${short(owner.name)} ${Math.round(owner.ms)}ms`;
			return `${translate('verdictLabel')} ${verdict.label} · ${translate('evOwner')} ${who}`;
		}
		/**
		 * 「最差事件」块的**归因说明**行:三档各自把"凭什么"写出来。它替代了旧的那句
		 * `无(更像 rAF 被节流)` —— 那是把一个**可能性**写成了结论。
		 */
		function eventVerdictText(row) {
			if (row === null || row === undefined) return '';
			const verdict = incidentVerdict(row);
			return `${verdict.label}:${verdict.detail}`;
		}
		/** 「最差事件」块的窗口行:窗口里有几帧、几条 LoAF、脚本按包的覆盖率(带分母)。 */
		function eventWindowText(row) {
			if (row === null || row === undefined) return '';
			const summary = row.summary ?? {};
			const cov = summary.pkgCoverage ?? { resolved: 0, total: 0 };
			return `${translate('evWindow')} ${summary.frames ?? 0}${translate('framesUnit')} · LoAF ${summary.loafEntries ?? 0} · ${translate('byPkg')} ${cov.resolved}/${cov.total}`;
		}
		/**
		 * 「复制摘要」要复制的那段文本。给的是**结论 + 口径**,不是整份事故包
		 * (整份走「导出事故包」,那是 JSON)。缺数据的地方照实写,不省略成空。
		 */
		/**
		 * 「复制摘要」的那段文本。它的用途是**交给别的 AI / 同事继续查**,所以除了结论与口径,
		 * 还要带上"缩小到哪个文件哪一段"的证据行与"缺什么" —— 只给一句"最差那条是 X"是查不下去的。
		 *
		 * ⚠️ 它会读 `incident.interactions`(交互延迟)。那一层按规矩**不进面板渲染区**
		 * (见 AGENTS:交互只当端到端时长,不能读成帧内拆分),而这里是给分析者的交接件,
		 * 所以照实写、并写明"端到端、不拆帧内"。
		 */
		function incidentSummaryText(row) {
			if (row === null || row === undefined) return '';
			const summary = row.summary ?? {};
			const owner = incidentOwner(row);
			const cov = summary.pkgCoverage ?? { resolved: 0, total: 0 };
			const verdict = incidentVerdict(row);
			const lines = [
				`${PKG} ${row.id} · ${row.cause} · ${Math.round(row.severity)}ms · ${row.at}`,
				`${translate('sevLabel')} ${severityText(severityLevel(row.severity))} · ${translate('jsEvidence')} ${summary.worstFrameJs === 'js' ? translate('jsYes') : translate('jsNo')}`,
				`${translate('verdictLabel')} ${verdict.label} · ${verdict.detail}`,
				`${translate('evOwner')} ${owner === null ? translate('unblamed') : `${owner.name} ${Math.round(owner.ms)}ms`}`,
				`${translate('evWindow')} ${summary.frames ?? 0}${translate('framesUnit')} · LoAF ${summary.loafEntries ?? 0} · ${translate('byPkg')} ${cov.resolved}/${cov.total}`,
			];
			if (row.integrity?.captureComplete === false) {
				lines.push(`${translate('integrityIncomplete')} · LoAF ${row.integrity.loafDropped} · longtask ${row.integrity.longTaskDropped}(${row.integrity.reasons.join(' · ')})`);
			}
			// 事件来源:窗口里 ≥100ms 的交互(端到端)。没有就整段不写,不摆 0。
			const interactions = Array.isArray(row.interactions) ? row.interactions : [];
			if (interactions.length > 0) {
				const top = interactions.slice().sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 2);
				lines.push(`${translate('handoffInteractions')} ${interactions.length}${translate('times')}: ${top.map((item) => `${item.name ?? item.type ?? '?'} ${Math.round(item.ms ?? 0)}ms`).join(' · ')}${translate('handoffInteractionsScope')}`);
			}
			const evidence = incidentEvidenceLines(row);
			if (evidence.length > 0) {
				lines.push(`${translate('evidenceLabel')}:`);
				for (const line of evidence) lines.push(`  - ${line}`);
			}
			// 正在逐帧回看时,把手边**这一帧**的证据也带上 —— 界面显示哪几行,复制出来就有哪几行
			// (面板与交接件共用 incidentFrameEvidenceRows 这一条路)。
			if (diagMode() === 'incident' && selectedIncident().row === row) {
				const frame = selectedIncidentFrame(row);
				if (frame !== null) {
					const nav = incidentFrameNav(row, frame);
					const frameEvidence = incidentFrameEvidenceRows(row, frame);
					if (frameEvidence.length > 0) {
						lines.push(`${translate('ctxHistoryFrame')} ${nav.index}/${nav.count} · ${Math.round(frame.ms ?? 0)}ms · ${translate('evidenceLabel')}:`);
						for (const ev of frameEvidence.slice(0, EVIDENCE_MAX)) lines.push(`  - ${evidenceLine(ev)}`);
					} else {
						lines.push(`${translate('ctxHistoryFrame')} ${nav.index}/${nav.count} · ${Math.round(frame.ms ?? 0)}ms · ${translate('handoffFrameNoEvidence')}`);
					}
				}
			}
			lines.push(`${translate('evidenceCaliberPlain')}`);
			lines.push(`${translate('evidenceMissingPlain')}`);
			return lines.join('\n');
		}
		/**
		 * 归因行的主值:本秒速率 + 峰值速率。
		 * 两个都要带 /s —— 实测 `0.5/s · 峰 17.8` 会被读成"峰值 17.8 毫秒",实际是 17.8 次/秒。
		 */
		function attrText(row) {
			return `${row.cps}${translate('perSec')} · ${translate('peak')} ${row.cpsPeak}${translate('perSec')}`;
		}
		/**
		 * 「其余」行:和上面三行**同一套单位**(本秒速率 + 本秒耗时),累计值收进悬停。
		 * 原来这行给的是累计次数/累计耗时,和上面的 `/s` 并排出现,同一张表两套单位 —— 必然读错。
		 */
		function restValueText(rows) {
			return `${round1(rows.reduce((sum, row) => sum + row.cps, 0))}${translate('perSec')} · ` +
				`${round1(rows.reduce((sum, row) => sum + row.msps, 0))}ms${translate('perSec')}`;
		}
		function restTitleText(rows) {
			const count = rows.reduce((sum, row) => sum + row.count, 0);
			const ms = rows.reduce((sum, row) => sum + row.ms, 0);
			return `${translate('restHint')}\n${translate('cumulative')} ${count}${translate('times')} / ${ms.toFixed(0)}ms`;
		}
		/** 合计耗时:小于 0.05ms/s 不写成 0 —— "0"读起来像"一点都没花",其实是四舍五入没了。 */
		function msPerSecText(value) {
			if (!(value > 0)) return '0ms/s';
			return value < 0.05 ? '<0.1ms/s' : `${round1(value)}ms/s`;
		}
		/**
		 * 标题栏的场景标签。
		 * "流式还是空闲"是解读所有数字的前提 —— 之前它只藏在工具箱的「空闲基线」里,
		 * 误判正是这么来的。所以它必须常显在标题栏。
		 */
		function sceneChip() {
			if (state.streaming) return { text: translate('running'), color: 'var(--dsw-alias-state-warn-primary)' };
			if (state.idleSince === 0) return { text: translate('idle'), color: 'var(--dsw-alias-label-secondary)' };
			return { text: `${translate('idle')} ${Math.round((performance.now() - state.idleSince) / 1000)}s`, color: 'var(--dsw-alias-label-secondary)' };
		}
		/**
		 * 未解释帧的自动结论。
		 * 触发条件:最差帧够长(≥100ms)且"帧内未归因"的峰值几乎等于它 —— 说明那一帧
		 * 完全没有 JS 回调能为它负责,开销在样式/布局/绘制/vsync 一侧。
		 */
		function unexplainedFrame() {
			// 没插桩时 `unattr` 就等于帧间隔(见 unattrText),这个判据会在**每一条**长帧上
			// 得出"几乎无 JS 解释"—— 那是假的:我们根本没测有没有 JS。所以先要求插桩。
			if (state.deep !== true) return null;
			const worst = state.frameWorst;
			if (!(worst >= 100) || worst <= 0) return null;
			const share = state.unattrPeak / worst;
			if (share < 0.95) return null;
			return { ms: round1(worst), percent: Math.round(share * 100) };
		}
		/** 宿主与链路的**判定**(不是只摆数字):两者都正常时直接说"链路已排除"。 */
		function infraVerdict() {
			const fresh = hostFreshness();
			const link = linkStats();
			if (fresh.state === 'unreachable') return { text: translate('hostDown'), color: 'var(--dsw-alias-state-warn-primary)', bad: true };
			// 零样本 / 还在等第一个样本:**不许**给「链路已排除」。这不是"正常",是"不知道"。
			if (fresh.state === 'warming' || fresh.state === 'unsupported') {
				return { text: translate('hostUnknown'), color: 'var(--dsw-alias-label-secondary)', bad: false };
			}
			if (fresh.state === 'stale') {
				return { text: `${translate('hostShort')} ${translate('hostStale')}`, color: 'var(--dsw-alias-state-warn-primary)', bad: true };
			}
			const hostBad = fresh.loop.p99 > 50;
			const linkBad = link.count > 0 && link.p99 > 100;
			if (hostBad || linkBad) {
				const parts = [];
				if (hostBad) parts.push(translate('hostShort'));
				if (linkBad) parts.push(translate('linkShort'));
				return { text: `${parts.join(' / ')}${translate('suspectSuffix')}`, color: 'var(--dsw-alias-state-warn-primary)', bad: true };
			}
			return { text: translate('cleared'), color: 'var(--dsw-alias-state-success-primary)', bad: false };
		}
		/**
		 * 概览第一行:帧 + 长任务 + 命中(短,必须一行放得下)。
		 *
		 * ⚠️ 这里**不**再挂 `(最差那条:未归因)` 那个后缀:`overviewLine2()` 紧接着就在同一块里
		 * 写 `最差那条:<归属>`,而两者的触发条件完全相同(`primaryBlame(worst) === null`)——
		 * 于是相邻两行必然把同一句话说两遍(§5「能不说就不说」)。"命中率"与"最差那条有没有
		 * 归属"是两个口径这件事,由第二行自己的标签 `最差那条` 承担,不再靠第一行重复。
		 */
		function overviewLine1() {
			const worst = worstLongTask();
			return `${translate('overviewFrame')} ${state.frameWorst.toFixed(0)}ms · LT ${worst === null ? translate('none') : `${worst.ms.toFixed(0)}ms`} · ${translate('hit')} ${state.ltBlamed}/${state.ltTotal}`;
		}
		/**
		 * 概览第二/三行:归属,以及(**只有提供信息时**才出现的)最多。
		 *
		 * 断行由我自己给(值节点是 white-space: pre-line):交给浏览器按宽度断,会断在
		 * `最多` 后面、把 `ChatView 22×` 甩到下一行 —— 实测被吐槽过一次。
		 * 另外:若"最多"与上面那个主名字相同,它只是把同一句话说两遍,直接不显示。
		 */
		function overviewLine2() {
			const worst = worstLongTask();
			const tally = longTaskTally();
			const blame = worst === null ? translate('none') : blameText(worst);
			const primary = worst === null ? null : primaryBlame(worst);
			const lines = [`${translate('overviewBlame')}:${blame}`];
			const leader = tally.topNames.length === 0 ? null : tally.topNames[0];
			if (leader !== null && leader[0] !== primary) {
				lines.push(`${translate('maxBlame')}:${short(leader[0])} ${leader[1]}×`);
			}
			return lines.join('\n');
		}
		/** 折叠组的一句话摘要:刻意短 —— 摘要自己换行会比正文更难看(实测)。 */
		/**
		 * 一个长动画帧的时间去哪了 —— 这是页面内能拿到的极限,LoAF 只给三个时间点:
		 *   [t, renderStart)              任务(含同步 JS)
		 *     ├─ scripts[].duration       被 LoAF 归到脚本的那部分(短于上报阈值的脚本不在内)
		 *     └─ taskOther                剩下的:没上报的短脚本 + 非脚本的任务开销
		 *   [renderStart, styleAndLayout) rAF 回调 / 渲染准备
		 *   [styleAndLayout, t+dur)       样式 + 布局 + 绘制/合成
		 * **绘制与合成分不开**(要分只能录 Chrome trace,那一项在缺失声明里)——
		 * 所以最后一段是"剩下的都在这儿",不要读成"样式布局占了多少"。
		 * 脚本自己再拆三层:纯执行 / 强制样式布局 / 暂停。后两者是 scripts[] 里的
		 * forcedStyleAndLayoutDuration 与 pauseDuration,**都已经算在 duration 里**,
		 * 所以它们是 duration 的分区,不能相加。
		 * 每一层都向下 clamp:每条脚本的毫秒各自 round1,脚本多而每条约 0.05ms 时,
		 * 求和会反过来超过父区间(四舍五入的算术后果,不是猜测)—— 分区图的子项
		 * 永远不许超过父项,否则画出来是负长度的弧。
		 */
		function frameSplit(row) {
			if (row === null || row === undefined || typeof row.dur !== 'number' || row.dur <= 0) return null;
			const start = row.t;
			const total = row.dur;
			const renderStart = typeof row.renderStart === 'number' && row.renderStart > start ? row.renderStart : null;
			const styleStart = typeof row.styleAndLayoutStart === 'number' && row.styleAndLayoutStart > start ? row.styleAndLayoutStart : null;
			let rawJs = 0;
			let rawForced = 0;
			let rawPause = 0;
			for (const script of row.scripts ?? []) {
				rawJs += script.ms ?? 0;
				rawForced += script.forcedMs ?? 0;
				rawPause += script.pauseMs ?? 0;
			}
			const head = renderStart === null ? total : renderStart - start;
			const js = round1(Math.min(rawJs, head));
			const forced = round1(Math.min(rawForced, js));
			const pause = round1(Math.min(rawPause, js - forced));
			const exec = round1(Math.max(0, js - forced - pause));
			const render = renderStart === null ? 0 : (styleStart === null ? total - head : styleStart - renderStart);
			const tail = Math.max(0, total - head - render);
			return {
				at: row.t,
				total: round1(total),
				head: round1(head),                 // 任务(含同步 JS)
				js: js,                             // 其中被 LoAF 归到脚本的部分(是 head 的子集)
				taskOther: round1(head) - js,       // 任务里没归到脚本的部分(与 js 相加正好等于 head)
				exec: exec,                         // 脚本 = 纯执行 + 强制样式布局 + 暂停
				forced: forced,
				pause: pause,
				render: round1(render),
				tail: round1(tail),
				blocking: round1(row.blocking ?? 0),
			};
		}
		/**
		 * 圆环的图例:两行、每行两段 —— 四个百分比挤一行在 396px 的面板里会折行(实测同类事故),
		 * 顺序与圆环从上往下的走向一致(脚本 → 任务 → 渲染 → 样式+布局+绘制)。
		 */
		function splitLegend(split) {
			const pct = (ms) => `${Math.round((ms / split.total) * 100)}%`;
			return [
				`${translate('splitScript')} ${pct(split.js)} · ${translate('splitTask')} ${pct(split.taskOther)}`,
				`${translate('splitRender')} ${pct(split.render)} · ${translate('splitTail')} ${pct(split.tail)}`,
			];
		}
		/**
		 * 圆环的**段**:脚本那一段再按「来源」切细(同一族的红,由深到浅 = 耗时降序),
		 * 后面照旧接 任务 / 渲染 / 样式+布局+绘制 —— 所以一个环上最多 3+1+3 = 7 段。
		 * 三条硬性:
		 *   ① **只做分区**:各段之和恒等于 `split.total`(脚本那几段之和用减法凑齐,
		 *      `其余` 那一段补足差额),否则弧会互相盖住;
		 *   ② 按来源的原始求和可能**大于**脚本那一段(frameSplit 把 js 夹到了 ≤ 任务段,
		 *      而渲染阶段跑的脚本也算在 `scripts[]` 里)—— 那种情况下按比例缩一下,保持分区;
		 *   ③ 颜色只给名字(`error` / `warn` / `brand` / `neutral`),token 由渲染那侧映射。
		 */
		/**
		 * 环的四段 = **一个维度**:脚本 / 任务里没归到的 / 渲染 / 样式+布局+绘制(相加恒等于整帧)。
		 * 脚本内部的「来源」细分**不在这里** —— 层级挤在环里读不出来(见 docs/reading-panel.md 的拆解铁律),
		 * 那件事交给 `barSegments` 的堆叠条。
		 */
		function frameArcs(split) {
			return [
				{ ms: split.js, color: 'error', opacity: 1 },
				{ ms: split.taskOther, color: 'neutral', opacity: 1 },
				{ ms: split.render, color: 'warn', opacity: 1 },
				{ ms: split.tail, color: 'brand', opacity: 1 },
			];
		}
		/**
		 * 一条长动画帧的严重度 = `max(blocking, 帧时长)`。**面板里"最差那条帧"只有这一个口径**:
		 * LoAF 的 blocking 在这个环境里常年偏小(实测 45 帧的 blocking 全部 < 100ms,最大 92ms),
		 * 只看它会把 92ms 的帧排到 300ms 的帧前面;而判色(120/200ms)与圆环上的「帧里花在哪」
		 * 显示的也是帧时长。
		 * 以前 `worstLoaf` / `loafRanks` 只看 blocking、`pickList` 看 max —— 于是"自动选中的那条"
		 * 可能根本不在翻帧清单里,标签会显示 `帧 0/N`。现在三处共用这一个函数。
		 */
		function frameSeverity(row) {
			if (row === null || row === undefined) return 0;
			return Math.max(row.blocking ?? 0, row.dur ?? 0);
		}
		/** 最差的那条长动画帧(面板的饼图默认看的就是它)。 */
		function worstLoaf() {
			let best = null;
			for (const row of state.watch.loaf) if (best === null || frameSeverity(row) > frameSeverity(best)) best = row;
			return best;
		}
		/** 按严重度降序的帧清单(最差的排第一)。 */
		function loafRanks() {
			return state.watch.loaf.slice().sort((a, b) => frameSeverity(b) - frameSeverity(a));
		}
		/**
		 * 翻帧的清单:**只收值得回看的帧**(`frameSeverity` ≥ `PICK_MIN_MS`,即帧时长与 blocking
		 * 里更大的那个)。200 条里绝大多数是刚过 50ms 的边角帧,全列出来 ◀ ▶ 就成了体力活
		 * (实测 68 条里真正想看的往往是个位数)。阈值取守夜那条触发线(`WATCH_TRIGGER_MS`),
		 * 这样「翻帧翻得到的」和「守夜留得下的」是同一批帧。
		 * 一条都不到线时**退回全部**(否则按钮点了像坏的),此时 `filtered:false`,面板不显示阈值。
		 */
		function pickList() {
			const all = loafRanks();
			const hot = all.filter((row) => frameSeverity(row) >= PICK_MIN_MS);
			return hot.length === 0 ? { rows: all, filtered: false } : { rows: hot, filtered: true };
		}
		/**
		 * 面板**正在看**的那一条长动画帧:默认自动跟着最差那条走;用 ◀ ▶ 选过之后就钉住。
		 * 记的是 `t` 不是下标 —— 帧环会追加新的、挤掉老的,下标会指到别的帧上。
		 * 选中的那条被挤出 200 条之外就退回自动(并清掉选择),不指着一个不存在的帧。
		 */
		function pickedLoaf() {
			const rows = state.watch.loaf;
			if (rows.length === 0) return null;
			if (state.watch.pickT !== null) {
				const hit = rows.find((row) => row.t === state.watch.pickT);
				if (hit !== undefined) return hit;
				state.watch.pickT = null;
			}
			return worstLoaf();
		}
		/**
		 * 最近 SPARK_SECONDS 秒的分格数据:一格一秒,格值 = 那一格里最差那帧的间隔;间隙另标。
		 * `t` 带上"最差那一帧的 perf 毫秒" —— 帧条 hover 要给出墙钟时间,点格导航也要它。
		 */
		function sparkBars(now) {
			const from = now - SPARK_SECONDS * 1000;
			const cells = [];
			for (let i = 0; i < SPARK_SECONDS; i += 1) cells.push({ ms: 0, t: null, seen: false, gap: false });
			for (const row of frameRing.slice(from, now)) {
				const index = Math.min(SPARK_SECONDS - 1, Math.max(0, Math.floor((row.t - from) / 1000)));
				const cell = cells[index];
				if (row.gap === true) { cell.gap = true; continue; }
				cell.seen = true;
				if (row.ms > cell.ms) { cell.ms = row.ms; cell.t = row.t; }
			}
			return cells;
		}
		/**
		 * 帧条上**点得动**的格子:一格 → 那一格里最差的那条**长动画帧**(LoAF 环里真实存在的)。
		 * 为什么不是每格都能点:帧条是按 `frameRing` 画的(每个 rAF 一条),而翻帧只在
		 * `state.watch.loaf` 里翻 —— 点一个没有 LoAF 的格子会"什么也没发生",那正是最糟的一种
		 * 假按钮。所以只有能真正导航过去的格子才给 onClick,别的格子只给 title 说清原因。
		 */
		function sparkPickMap(now) {
			const from = now - SPARK_SECONDS * 1000;
			const picks = new Map();
			for (const frame of state.watch.loaf) {
				const index = Math.floor((frame.t - from) / 1000);
				if (index < 0 || index >= SPARK_SECONDS) continue;
				const current = picks.get(index);
				if (current === undefined || (frame.dur ?? 0) > (current.dur ?? 0)) picks.set(index, frame);
			}
			return picks;
		}
		/**
		 * 帧条一格 hover 的说明:墙钟时间 + 这一秒最差帧多少 + 点得动还是点不动。
		 * **点不动要写在 title 里** —— 不然读者只会以为"这个面板点了没反应"。
		 */
		function sparkCellTitle(cell, pick) {
			const when = cell.t === null ? '' : `${clock(wallClock(cell.t))} · `;
			if (cell.seen !== true) {
				return when + (cell.gap === true ? translate('sparkGap') : translate('notYet'));
			}
			const base = `${when}${translate('worstOne')} ${Math.round(cell.ms)}ms`;
			return pick === undefined ? `${base} · ${translate('sparkNoPick')}` : `${base} · ${translate('sparkPickHint')}`;
		}
		// ───────────────── 事故回放(数据全部来自事故包) ─────────────────
		/**
		 * 事故回放吃的那份数据:**只用事故包里存下来的东西**(`incident.frames` / `incident.loaf` /
		 * `summary`),所以它**刷新生效**,也不花任何新的采集成本 —— 面板上面那条 60 秒帧条是
		 * **实时**帧环(刷新就没了),两者刻意分开显示、各自写明范围。
		 *
		 * 不做、也不假装的事:LoAF 不给每帧内脚本的**起止时间**,所以这里**不排帧内执行顺序**;
		 * 一帧里谁先谁后只有 Chrome trace 知道。
		 */
		function replayScope() {
			const row = selectedIncident().row;
			if (row === null || Array.isArray(row.frames) === false || row.frames.length === 0) return null;
			const frames = row.frames;
			const win = row.window ?? {};
			const from = typeof win.fromMs === 'number' ? win.fromMs : frames[0].t;
			const to = typeof win.toMs === 'number' ? win.toMs : frames[frames.length - 1].t;
			const span = Math.max(1, round1(to - from));
			let worst = null;
			let gaps = 0;
			for (const frame of frames) {
				if (frame.gap === true) { gaps += 1; continue; }
				if (worst === null || frame.ms > worst.ms) worst = frame;
			}
			// 与最差帧**时间上重叠**的那条 LoAF:只用来给这一帧的时间分解(就近,不等于"这一帧只属于它")
			let split = null;
			const loaf = Array.isArray(row.loaf) ? row.loaf : [];
			if (worst !== null) {
				for (const entry of loaf) {
					const start = worst.t - worst.ms;
					if (entry.t <= worst.t && entry.t + (entry.dur ?? 0) >= start) { split = frameSplit(entry); break; }
				}
			}
			return { row, frames, from, to, span, worst, gaps, split, summary: row.summary ?? {} };
		}
		/**
		 * 回放条上这一帧的横坐标 —— **按时间**放(不是按序号):整段 rAF 被挂起的那几秒会留白,
		 * 一眼看得出"这段时间根本没在测"。按序号放会把那个间隔压成一根柱子,那就等于说谎。
		 */
		function replayX(t, from, spanMs, width) {
			if (!(spanMs > 0) || !(width > 0)) return 0;
			const x = Math.round(((t - from) / spanMs) * width);
			return x < 0 ? 0 : (x > width ? width : x);
		}
		/** 回放范围那一行:窗口跨度 / 帧数 / 分位 / 最差 / 缺口数(每一项都带单位)。 */
		function replaySummaryText(scope) {
			const summary = scope.summary;
			const parts = [`${translate('windowScope')} ${spanText(scope.span)}`, `${scope.frames.length}${translate('framesUnit')}`];
			if (typeof summary.p50 === 'number') parts.push(`p50 ${summary.p50}ms`);
			if (typeof summary.p99 === 'number') parts.push(`p99 ${summary.p99}ms`);
			if (scope.worst !== null) parts.push(`${translate('watchWorst')} ${Math.round(scope.worst.ms)}ms`);
			if (scope.gaps > 0) parts.push(`${translate('replayGaps')} ${scope.gaps}`);
			return parts.join(' · ');
		}
		/**
		 * 事故包里某一刻的**墙钟**时间。⚠️ 不能用 `wallClock()`:那个用的是**当前页面**的
		 * timeOrigin,跨会话读回的事故(perf 时间轴已经重开)会被算成"今天的某个时刻"。
		 * 事故包自带 `env.perfOrigin`(捕获那一刻的 timeOrigin),用它才对;老包没有就返回 null,
		 * 面板照实写"时间未知",不编一个。
		 */
		function incidentWallClock(row, t) {
			if (row === null || row === undefined || typeof t !== 'number') return null;
			const origin = Date.parse(row.env?.perfOrigin ?? '');
			return Number.isFinite(origin) ? origin + t : null;
		}
		/**
		 * 历史帧条的**列**:把事故窗口按时间切成 `REPLAY_COLS` 列,每列取该列里**最差的那一帧**
		 * (所以尖刺不会被平均掉),并把那一帧的引用留在格子里。
		 *
		 * 三条硬性:
		 *   ① 横轴按**时间**放(不是序号):整段 rAF 被挂起的那几秒是**留白**,一眼看出
		 *      "这段时间根本没在测";按序号放会把那个缺口压成一根柱子 = 说谎;
		 *   ② **不合成帧**:格子里的 `frame` 一定是 `incident.frames` 里真实存在的那一条,
		 *      点击 / 选中 / 高亮全部映射回它(有断言钉住"列的 frame 都在原数组里");
		 *   ③ 只画真实存在的时间区间,采样缺失的地方不补柱子。
		 */
		function replayColumns(row) {
			const frames = row === null || row === undefined || Array.isArray(row.frames) === false ? [] : row.frames;
			if (frames.length === 0) return null;
			const win = row.window ?? {};
			const from = typeof win.fromMs === 'number' ? win.fromMs : frames[0].t;
			const to = typeof win.toMs === 'number' ? win.toMs : frames[frames.length - 1].t;
			const span = Math.max(1, round1(to - from));
			const cells = [];
			for (let i = 0; i < REPLAY_COLS; i += 1) cells.push(null);
			let liveCount = 0;
			let gapCount = 0;
			for (const frame of frames) {
				if (frame === null || typeof frame.t !== 'number' || Number.isFinite(frame.t) === false) continue;
				const index = Math.min(REPLAY_COLS - 1, Math.max(0, replayX(frame.t, from, span, REPLAY_COLS)));
				let cell = cells[index];
				if (cell === null) { cell = { index, frame: null, ms: 0, count: 0 }; cells[index] = cell; }
				cell.count += 1;
				if (frame.gap === true) { gapCount += 1; continue; }
				liveCount += 1;
				// 同一格里有多帧时留**最差**的那一条(它才是这一格里值得点开的那一帧)
				if (cell.frame === null || (frame.ms ?? 0) > cell.ms) { cell.frame = frame; cell.ms = frame.ms ?? 0; }
			}
			for (const cell of cells) if (cell !== null) cell.level = cell.frame === null ? 'gap' : incidentFrameLevel(cell.frame);
			return { row, from, to, span, cols: cells, liveCount, gapCount, frameCount: frames.length };
		}
		/**
		 * 帧条一格 hover 的说明:它在时间轴上的墙钟时刻、这一格的帧在事故窗口里的序号与耗时、
		 * 以及"点了会怎样"。**不可点的格子要写出原因**(间隙 / 那一列没有真实帧),
		 * 不留一个点了没反应的假按钮。
		 */
		function replayCellTitle(row, cell, nav) {
			const when = incidentWallClock(row, cell.frame === null ? null : cell.frame.t);
			const stamp = when === null ? '' : `${clock(when)} · `;
			if (cell.frame === null) return `${stamp}${translate('replayGapCell')} · ${translate('replayCellCount')} ${cell.count}`;
			return `${stamp}${translate('ctxHistoryFrame')} ${nav.index}/${nav.count} · ${Math.round(cell.ms)}ms · ${translate('replayCellPick')}`;
		}
		/**
		 * 事故里的一条脚本 → 与实时帧脚本**同一种形状**(`url` 从事故的 URL 表里解出来),
		 * 这样 `tallyScripts` 那一套口径(按来源 / 按包 / 交叉表)可以原样吃两边的数据。
		 * `pkg` / `pkgVia` 是**捕获时存下来的**:tallyScripts 看到它们就不再走当前会话的
		 * sourcemap 缓存 —— 刷新之后缓存是空的,现算会把历史事故的包名全变成"未定名"。
		 */
		function incidentScriptOf(row, script) {
			const urls = Array.isArray(row?.urls) ? row.urls : [];
			const index = typeof script?.u === 'number' ? script.u : -1;
			return {
				url: index >= 0 ? (urls[index] ?? '') : '',
				charPos: script?.charPos ?? null,
				ms: script?.ms ?? 0,
				forcedMs: script?.forcedMs ?? 0,
				pauseMs: script?.pauseMs ?? 0,
				invoker: script?.invoker ?? null,
				invokerType: script?.invokerType ?? null,
				pkg: script?.pkg === undefined ? undefined : script.pkg,
				pkgVia: script?.pkgVia,
			};
		}
		/** 一条历史帧的脚本聚合(只有这一帧的 LoAF 里那些脚本)。 */
		function incidentFrameTally(row, frame) {
			const loaf = incidentLoafAt(row, frame);
			if (loaf === null) return null;
			return tallyScripts([{ t: frame.t, scripts: (loaf.scripts ?? []).map((script) => incidentScriptOf(row, script)) }]);
		}
		function incidentWindowTally(row) {
			if (row === null || row === undefined) return null;
			if (incidentTallyCache.id === row.id) return incidentTallyCache.value;
			const loaf = Array.isArray(row.loaf) ? row.loaf : [];
			const value = tallyScripts(loaf.map((entry) => ({ t: entry.t, scripts: (entry.scripts ?? []).map((script) => incidentScriptOf(row, script)) })));
			incidentTallyCache.id = row.id;
			incidentTallyCache.value = value;
			return value;
		}
		/**
		 * **这一帧**的脚本证据行(LoAF 的 scripts[] → 函数名 / 包 / 文件 / 行号)。
		 * 走 `incidentEvidenceAt`:捕获时存下来的定位优先,老包才现算(见它的说明)。
		 * 这一帧没有 LoAF 时返回空数组 —— **不回退**到别的帧,更不回退到实时帧环。
		 */
		function incidentFrameEvidenceRows(row, frame) {
			const loaf = incidentLoafAt(row, frame);
			if (loaf === null || Array.isArray(loaf.scripts) === false) return [];
			return loaf.scripts.map((script) => incidentEvidenceAt(row, script)).sort((a, b) => b.ms - a.ms);
		}
		/** 与这一帧**时间上重叠**的 long task 明细(事故包里存下来的四条腿归因)。 */
		function incidentLongTasksAt(row, frame) {
			if (row === null || frame === null || frame === undefined || Array.isArray(row.longTasks) === false) return [];
			const start = frame.t - (typeof frame.ms === 'number' ? frame.ms : 0);
			return row.longTasks
				.filter((task) => typeof task?.at === 'number' && task.at < frame.t && task.at + (task.ms ?? 0) > start)
				.sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0));
		}
		/** 历史帧详情区的上下文标题:`历史事故 i12 · 历史帧 3/305`(耗时单独用"核心耗时"字号给)。 */
		function incidentFrameHeadingText(row, frame, nav) {
			const id = row === null || row === undefined ? '?' : row.id;
			if (frame === null || frame === undefined) return `${translate('ctxIncident')} ${id} · ${translate('ctxHistoryFrame')}`;
			return `${translate('ctxIncident')} ${id} · ${translate('ctxHistoryFrame')} ${nav.index}/${nav.count}`;
		}
		/** 实时帧详情区的上下文标题:`实时监控 · 当前帧`(耗时同样单独给)。 */
		function liveFrameHeadingText(frame) {
			if (frame === null || frame === undefined) return `${translate('ctxLive')} · ${translate('ctxFrame')}`;
			return `${translate('ctxLive')} · ${translate('ctxFrame')}`;
		}
		/**
		 * 取证明细的**唯一**数据入口:实时与历史事故两个上下文只在这一处分流。
		 *
		 * 为什么要有它:渲染那侧如果各自 `pickedLoaf()` / `selectedIncident().row` 各取一份,
		 * "上面是历史事故、下面是另一条实时帧的编号 / 耗时 / 饼图"就会回来(那正是这次要修的)。
		 * 现在渲染只读这个返回值,而历史那一支的数据只来自 `incident.frames` / `incident.loaf`
		 * —— 拿不到就是 null / 空数组,由渲染照实写缺失。
		 */
		function detailContext() {
			if (diagMode() === 'incident') {
				const row = selectedIncident().row;
				if (row === null) {
					return { kind: 'incident', row: null, frame: null, loaf: null, nav: null, split: null, tallyFrame: null, tallyWindow: null, longTasks: [], evidence: null };
				}
				const frame = selectedIncidentFrame(row);
				const loaf = frame === null ? null : incidentLoafAt(row, frame);
				return {
					kind: 'incident', row, frame, loaf,
					nav: incidentFrameNav(row, frame, state.watch.onlyBad === true),
					split: frameSplit(loaf),
					tallyFrame: frame === null ? null : incidentFrameTally(row, frame),
					tallyWindow: incidentWindowTally(row),
					longTasks: frame === null ? [] : incidentLongTasksAt(row, frame),
					evidence: evidenceScope(),
				};
			}
			const frame = pickedLoaf();
			return {
				kind: 'live', row: null, frame, loaf: frame, nav: null,
				split: frameSplit(frame),
				tallyFrame: framePkgTally(frame),
				tallyWindow: scriptPkgTally(),
				longTasks: [],
				evidence: evidenceScope(),
			};
		}
		/**
		 * 一格算哪一档 —— 与导出件 ASCII 条带**逐条对应**:
		 * `█` ≥100ms → bad · `▒` ≥50ms → warn · `·` 其余 → ok · `_` 整格 rAF 间隙 → gap · 空格 没采到 → empty。
		 * 阈值改动必须两处一起改(logic.mjs 有一条断言专门核这件事)。
		 */
		function sparkLevel(cell) {
			if (cell.seen === true) {
				if (cell.ms >= 100) return 'bad';
				if (cell.ms >= 50) return 'warn';
				return 'ok';
			}
			return cell.gap === true ? 'gap' : 'empty';
		}
		/**
		 * 一个包名都没定到时那一行:**必须留下分母** —— 直接不显示会让人以为"按包"被删了
		 * (实测被这么问过)。给不出占比是因为没有名字就没有排行,不是没采。
		 */
		/**
		 * 一条脚本"是谁调起来的" —— LoAF 的 `invoker` 是一句 devtools 风格的调用点描述。
		 * 真页面抓到的形态(2026-10-08,一份 24 条脚本的事故):
		 *   `DOMWebSocket.onmessage`      ×19   会话事件流的消息处理器
		 *   `TimerHandler:setTimeout`     ×2    → setTimeout
		 *   `Response.json.then`          ×2    Promise 回调
		 *   `SCRIPT[src="plugins/??…"]`   ×1    → script(整串是 URL,放不下也没信息量)
		 * 归一规则:① `SCRIPT[…]` 收敛成 `script`;② 带冒号的取**最后一段**
		 * (`TimerHandler:setTimeout` → `setTimeout`);③ 还是太长就截断;
		 * ④ 没有 invoker 就退到 `invokerType`(user-callback / event-listener / …),
		 * 都没有才写"来源未记录"。
		 * 它只回答"哪一类调用",**不回答"函数里面慢在哪"** —— 函数级要采样器,页面内没有
		 * (JS Self-Profiling 被 Document Policy 挡着,实测 `new Profiler()` 抛 NotAllowedError)。
		 */
		function invokerLabel(script) {
			const raw = typeof script.invoker === 'string' ? script.invoker : '';
			let label = '';
			if (raw.startsWith('SCRIPT[')) label = 'script';
			else if (raw !== '') {
				const cut = raw.lastIndexOf(':');
				label = cut === -1 ? raw : raw.slice(cut + 1);
			}
			if (label === '') label = typeof script.invokerType === 'string' ? script.invokerType : '';
			if (label === '') return translate('invokerUnknown');
			return label.length > 28 ? `${label.slice(0, 27)}…` : label;
		}
		/**
		 * D5 二级:脚本侧往下拆一层 —— 一份汇总,两个分母共用:
		 *   ① 按包汇总脚本耗时(`script.url` 与事故包 `incident.packages` 走**同一条**
		 *      resolve 路:单包 URL 直接读出来,合并批按 sourcemap 分段还原);
		 *   ② 纯执行 / 强制样式布局 / 暂停:LoAF 的 forcedStyleAndLayoutDuration 是读布局、
		 *      写样式逼出来的同步布局,pauseDuration 是被同步 XHR / 对话框卡住的时间 ——
		 *      两者**都已经算在** duration 里(是分区,不是相加);
		 *   ③ 按 invoker 汇总:同一份脚本耗时的**另一种切法**(谁调起来的)。
		 * ②③ 与 ① 的关系:按包那份只覆盖"定得到包名"的脚本,按来源那份覆盖全部 ——
		 * 所以「按来源」的合计 = `js`,「按包」的合计 ≤ `js`,两者不是同一件事(有断言钉住)。
		 * 计量单位统一为"脚本毫秒",但 unresolved 计的是**条数**(不是毫秒)。
		 */
		function tallyScripts(rows) {
			const byPkg = new Map();
			const byOther = new Map();
			const byInvoker = new Map();
			const byPair = {};
			let js = 0;
			let forced = 0;
			let pause = 0;
			let unresolved = 0;
			let unresolvedMs = 0;
			for (const row of rows) {
				for (const script of row.scripts ?? []) {
					js += script.ms ?? 0;
					forced += script.forcedMs ?? 0;
					pause += script.pauseMs ?? 0;
					const label = invokerLabel(script);
					byInvoker.set(label, (byInvoker.get(label) ?? 0) + (script.ms ?? 0));
					// 事故包里的脚本**带捕获时存下来的 pkg / pkgVia**(incidentScriptOf 把它们传进来):
					// 有就直接用,不再走 packageOfScript —— 那条路依赖当前会话的 sourcemap 分段表与
					// 脚本文本缓存,刷新之后是空的,现算会把历史事故的包名全算成"未定名"
					// (与 incidentEvidenceAt「存下来的优先」是同一条规矩)。
					const resolved = script.pkg !== undefined
						? { pkg: script.pkg, via: script.pkgVia ?? 'stored' }
						: packageOfScript(script.url, script.charPos);
					// "谁"这个名字一份:定得到插件包名就用它,否则用 unresolvedLabel 给的替身
					// (外壳文件名 / 无 URL / 插件批次)—— 交叉表的行与两处汇总共用同一条口径。
					let who = resolved.pkg;
					if (resolved.pkg === null) {
						unresolved += 1;
						unresolvedMs += script.ms ?? 0;
						who = unresolvedLabel(script);
						byOther.set(who, (byOther.get(who) ?? 0) + (script.ms ?? 0));
					} else {
						byPkg.set(resolved.pkg, (byPkg.get(resolved.pkg) ?? 0) + (script.ms ?? 0));
					}
					const pair = `${who}\u0000${label}`;
					byPair[pair] = round1((byPair[pair] ?? 0) + (script.ms ?? 0));
				}
			}
			return {
				js: round1(js), exec: round1(Math.max(0, js - forced - pause)), forced: round1(forced), pause: round1(pause), unresolved, unresolvedMs: round1(unresolvedMs),
				// 窗口那几行是**累计**,必须带回它的分母:条数与跨度。没有它,`纯执行 21623.8ms`
				// 会被读成"某一次执行花了 21 秒"(真被这么质疑过)—— 其实是 200 条长帧各百来毫秒攒起来的。
				count: rows.length,
				spanMs: rows.length === 0 ? 0 : Math.round(rows[rows.length - 1].t - rows[0].t),
				top: [...byPkg.entries()].sort((a, b) => b[1] - a[1]).map(([name, ms]) => [name, round1(ms)]),
				// 定不到插件包名的那部分:按**原因 / 文件名**汇总(不是笼统的"未定名")
				byOther: [...byOther.entries()].filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]).map(([name, ms]) => [name, round1(ms)]),
				byPair,
				// ms 为 0 的来源不进榜:它们没占时间,列出来只是噪声
				byInvoker: [...byInvoker.entries()].filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]).map(([name, ms]) => [name, round1(ms)]),
			};
		}
		/**
		 * 脚本侧三分(纯执行 / 强制样式布局 / 暂停):本帧那一行与窗口那一行共用同一份文案。
		 * 为 0 的那两项**不显示** —— 大多数帧里它俩就是 0,写出来只是噪声,还会把这一行挤成两行
		 * (实测窗口那行 `纯执行 1116.8ms · 强制 10.7ms · 暂停 0ms` 在 396px 里折过行)。
		 */
		function jsBreakdownText(tally) {
			const parts = [`${translate('jsExec')} ${tally.exec}ms`];
			if (tally.forced > 0) parts.push(`${translate('forcedShort')} ${tally.forced}ms`);
			if (tally.pause > 0) parts.push(`${translate('jsPause')} ${tally.pause}ms`);
			return parts.join(' · ');
		}
		/** 一段跨度写成人读得懂的:43分12秒 / 1小时3分 / 47秒(秒级以下不写)。 */
		function spanText(ms) {
			const total = Math.max(0, Math.round(ms / 1000));
			const hours = Math.floor(total / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			const seconds = total % 60;
			if (hours > 0) return `${hours}${translate('hourUnit')}${minutes}${translate('minUnit')}`;
			if (minutes > 0) return `${minutes}${translate('minUnit')}${seconds}${translate('secUnit')}`;
			return `${seconds}${translate('secUnit')}`;
		}
		/**
		 * 窗口那三行的**分母**:它们是"最近 N 条长动画帧"的累计,不是某一帧的时长。
		 * 平均每条那一栏才和上面那张饼可比(最差帧 341ms vs 平均 108ms = 这条帧比平时差 3 倍),
		 * 条数与跨度顺带回答"这段时间卡了多少次"。
		 */
		function windowScopeText(tally) {
			if (tally.count === 0) return translate('notYet');
			return `${translate('windowScope')}:${tally.count} ${translate('loafRows')} · ${translate('spanOver')} ${spanText(tally.spanMs)} · ${translate('avgPerFrame')} ${round1(tally.js / tally.count)}ms`;
		}
		function scriptPkgTally() {
			const rows = state.watch.loaf;
			// 指纹必须带 `resolveSeq`:脚本按包的结果依赖**异步**到位的 sourcemap 分段表与脚本文本,
			// 少了它,环不再变长时窗口那三行与交叉表会冻在旧的解析状态(见 markResolved 的说明)。
			const stamp = rows.length === 0 ? 'x' : `${rows.length}|${rows[rows.length - 1].t}|${resolveStamp()}`;
			if (scriptTallyCache.stamp === stamp) return scriptTallyCache.value;
			const value = tallyScripts(rows);
			scriptTallyCache.stamp = stamp;
			scriptTallyCache.value = value;
			return value;
		}
		/**
		 * 单帧聚合(饼图看的那一条):与窗口聚合**同一份口径、不同分母** —— 面板上两行
		 * 分别标了"本帧"与"窗口",避免拿两种分母的数字互相印证。只有一条 LoAF 行,
		 * 不需要缓存(≤ WATCH_SCRIPT_MAX 条脚本)。
		 */
		function framePkgTally(row) {
			if (row === null || row === undefined) return null;
			return tallyScripts([row]);
		}
		/**
		 * "是谁"那一段文案:Top3 包 + 其余 + 定不到包名的条数(本帧与窗口两行共用)。
		 * 定不到包名时也要说 —— 只报"有名字的那部分"会让人把 200ms 当成这一层的全部
		 * (实测:窗口里 1116.8ms 脚本只有 200ms 定到了包,旧文案只写 `dsh-client-modules 200ms`)。
		 */
		/**
		 * 定不到**插件包名**时,尽量给一个认得出的名字 —— 统一写"未定名"是把已知信息丢掉:
		 *   · URL 为空(`no-url`)→ 真不知道:内联 / 动态构造的处理器;
		 *   · URL 在 `plugins/` 下但还没拆开(`precise-off` / 脚本文本或 map 还在拉)→ "插件批次",
		 *     它不是"没名字",只是还没按 sourcemap 分段还原;
		 *   · 其余(有 URL、但不是 plugins 路径)→ **多半是应用自己的外壳 bundle**
		 *     (实测 `/assets/index-<hash>.js` —— React 根容器上的事件处理器就来自它)。
		 *     直接用文件名标出来,比"未定名"有用得多。
		 */
		function unresolvedLabel(script) {
			const url = typeof script.url === 'string' ? script.url : '';
			if (url === '') return translate('srcNoUrl');
			if (ownerOfUrl(url) !== null) return translate('srcBatch');
			const parts = url.split('?')[0].split('/');
			const file = parts[parts.length - 1] === '' ? url : parts[parts.length - 1];
			return file.length > 28 ? `${file.slice(0, 27)}…` : file;
		}
		/** "谁"的两类标签合起来(插件包 + 其余来源),按耗时降序 —— 堆叠条与交叉表都用它。 */
		function whoRows(tally) {
			return [...tally.top, ...(tally.byOther ?? [])].sort((a, b) => b[1] - a[1]);
		}
		/**
		 * 一条 100% 堆叠横条的段:按耗时降序,Top3 + 其余。与环的分工是"环画分几类、条画每类里是谁"。
		 * 段宽按**这一维度的总量**算(不是段之和),所以条本身恒满格;颜色只给名字(渲染侧映射 token),
		 * 名次靠由深到浅的透明度 —— 与环当年的做法一致,读者不用记两套配色。
		 */
		function barSegments(rows) {
			const list = (rows ?? []).filter(([, ms]) => ms > 0);
			const top = list.slice(0, 3);
			const segs = top.map(([name, ms]) => ({ name, ms: round1(ms) }));
			const restMs = round1(list.slice(3).reduce((sum, [, ms]) => sum + ms, 0));
			if (restMs > 0) segs.push({ name: null, ms: restMs });
			return { segs, total: round1(list.reduce((sum, [, ms]) => sum + ms, 0)) };
		}
		/**
		 * 包 × 来源的**交叉表**:两个正交维度只有交叉起来才回答"哪个包的哪类回调在烧时间"
		 * (分开看两张榜单永远答不了)。只展开 Top3 × Top3,其余并进"其余"行/列 —— 面板只有 372px,
		 * 格子给毫秒(单位写在角上),占比放 hover。
		 * "其余"那一行/列是**减法**:该行(列)的总量减去已展开的三格。四块拼起来恒等于脚本总耗时
		 * (`js`),因为两个维度各自都是 js 的分区。
		 */
		/** 交叉表折叠起来时的摘要:最重的那一格(它就是这张表存在的理由)。 */
		function crossSummary(cross) {
			if (cross === null) return translate('crossNone');
			if (cross.top.who === null || cross.top.ms === 0) return translate('crossNoOverlap');
			return `${clipName(short(cross.top.who), CROSS_SUMMARY_NAME_MAX)} · ${clipName(short(cross.top.src), CROSS_SUMMARY_SRC_MAX)} ${Math.round(cross.top.ms)}ms`;
		}
		function crossTable(tally) {
			const who = whoRows(tally).filter(([, ms]) => ms > 0);
			const src = (tally.byInvoker ?? []).filter(([, ms]) => ms > 0);
			if (who.length === 0 || src.length === 0) return null;
			const rows = who.slice(0, 3).map(([name]) => name);
			const cols = src.slice(0, 3).map(([name]) => name);
			const byPair = tally.byPair ?? {};
			const at = (w, s) => byPair[`${w}\u0000${s}`] ?? 0;
			const grid = rows.map((w) => cols.map((s) => round1(at(w, s))));
			const restCol = rows.map((w, r) => round1(Math.max(0, who[r][1] - grid[r].reduce((a, b) => a + b, 0))));
			const restRow = cols.map((s, c) => round1(Math.max(0, src[c][1] - grid.reduce((sum, row) => sum + row[c], 0))));
			const js = round1(tally.js ?? 0);
			const corner = round1(Math.max(0,
				js - rows.reduce((sum, w, r) => sum + who[r][1], 0) - cols.reduce((sum, s, c) => sum + src[c][1], 0)
					+ grid.reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0)));
			let best = { who: null, src: null, ms: 0 };
			rows.forEach((w, r) => cols.forEach((s, c) => { if (grid[r][c] > best.ms) best = { who: w, src: s, ms: grid[r][c] }; }));
			// Top3 之间可能**一格交集都没有**(最大的包住在第 4 名的来源里):这时不能把 top 留成 null,
			// 否则摘要那行拿到 null 去格式化。退回"最大的那一行 × 最大的那一列",并让 ms = 0 说明是空的。
			if (best.who === null) best = { who: rows[0], src: cols[0], ms: 0 };
			return { rows, cols, grid, restCol, restRow, corner, js, top: best };
		}
		function sparkStrip() {
			const now = performance.now();
			const cells = sparkBars(now);
			const picks = sparkPickMap(now);
			const colors = SPARK_COLORS;
			const bars = [];
			for (let i = 0; i < cells.length; i += 1) {
				const level = sparkLevel(cells[i]);
				if (level === 'empty') continue;
				// 间隙画成最矮的一根:它是"这段时间没在测",不是"这段时间没卡"
				const height = level === 'gap' ? 2 : Math.max(2, Math.min(SPARK_HEIGHT, Math.round((cells[i].ms / SPARK_MAX_MS) * SPARK_HEIGHT)));
				const pick = picks.get(i);
				bars.push(h('rect', {
					key: `s${i}`, x: i, y: SPARK_HEIGHT - height, width: 1, height, fill: colors[level],
					title: sparkCellTitle(cells[i], pick),
					// 点得动就给手型 + 真实行为;点不动就明确不给(不做"点了没反应"的假按钮)
					style: pick === undefined ? undefined : { cursor: 'pointer' },
					onClick: pick === undefined ? undefined : () => { state.watch.pickT = pick.t; bump(); },
				}));
			}
			return h('svg', {
				width: '100%', height: SPARK_HEIGHT, viewBox: `0 0 ${SPARK_SECONDS} ${SPARK_HEIGHT}`, preserveAspectRatio: 'none',
				style: { display: 'block' },
			}, bars);
		}
		/**
		 * 「帧内未归因」的值。⚠️ 它只在**插桩**下有定义:`idle = 帧间隔 − 插桩回调耗时`,
		 * 没插桩时 busy 恒为 0,这个数就退化成"平均帧间隔"(实测 16.7ms 被当成未归因 ——
		 * 那正好是 60fps 的帧间隔)。所以未插桩时不给数,直说需要深录。
		 */
		function unattrText() {
			if (state.deep !== true) return translate('needDeep');
			return `${state.unattrAvg.toFixed(1)}ms · ${translate('peak')} ${state.unattrPeak.toFixed(0)}ms`;
		}
		/**
		 * 「命中」那一行:四条腿**只列非零的** —— 没插桩时子树 / DOM写入 / 包名恒为 0,
		 * 全列出来就是 `245/0/0/0` 这种噪声。比率与概览同一口径(命中长任务数 / 长任务总数)。
		 */
		function hitText(tally) {
			const legs = [
				[translate('legFiber'), tally.fiber], [translate('legSubtree'), tally.subtree],
				[translate('legDom'), tally.dom], [translate('legOwner'), tally.owner],
			].filter(([, count]) => count > 0).map(([name, count]) => `${name} ${count}`);
			return `${translate('hit')} ${state.ltBlamed}/${state.ltTotal}`
				+ (legs.length === 0 ? '' : ` · ${legs.join('/')}`)
				+ (tally.none === 0 ? '' : ` · ${translate('unblamed')} ${tally.none}`);
		}
		function detailSummary() {
			// 历史事故上下文里这一组的东西全换了一份数据(窗口统计 / 历史帧 / 帧内分解 / 证据),
			// 摘要也必须换:折叠着的时候,它就是"现在看的是哪一帧"的唯一线索。
			if (diagMode() === 'incident') {
				const row = selectedIncident().row;
				const frame = row === null ? null : selectedIncidentFrame(row);
				if (row === null || frame === null) return translate('watchNone');
				const nav = incidentFrameNav(row, frame);
				return `${translate('ctxHistoryFrame')} ${nav.index}/${nav.count} · ${Math.round(frame.ms ?? 0)}ms`;
			}
			const second = worstSecond();
			// 帧内未归因搬进这一组之后,它的数字要留在摘要上 —— 否则常显就更"瞎"了
			// 只留"结论对"(最差秒 + 未归因):加上 DOM 写入那一段,真实量级(五位数)会在 396px
			// 里挤成两行(实测截图),而 DOM 写入展开就能看到,不必占摘要。
			// 摘要里只留平均(带峰值会撑到两行 —— 预算断言钉着 ≤26 字);
			// 没插桩时那个数没意义(见 unattrText),摘要里直说要深录
			const unattr = state.deep === true ? `${state.unattrAvg.toFixed(0)}ms` : translate('needDeep');
			return `${translate('worstSecondShort')} ${second === null ? translate('none') : `${second.frameMs.toFixed(0)}ms`} · ${translate('unattrShort')} ${unattr}`;
		}
		function domSummary() {
			return `${state.dom.total}${translate('nodesSuffix')} ${rateText(state.dom.series)} · ${translate('messages')} ${containerNodes('messages')}`;
		}
		function hostSummary() {
			const fresh = hostFreshness();
			const link = linkStats();
			// ⚠️ 折叠态与展开态必须同一个粒度,否则读者会把 p99 当成均值:展开那一行写的是
			// `p50 X · p99 Y · 最大 Z`(hostLoopText),这里也照写分位名(RTT 那一行同理)。
			const host = fresh.state === 'unreachable' ? translate('hostDown')
				: fresh.state === 'unsupported' ? translate('hostUnsupported')
					: fresh.state === 'warming' ? translate('hostWarming')
						: fresh.state === 'stale' ? `${translate('hostStale')} ${Math.max(1, Math.round(fresh.ageMs / 1000))}s`
							: `p99 ${fresh.loop.p99}ms`;
			// 判定(`infraVerdict()`)刻意**不进摘要**:它已经是展开后的第一行(标签 `宿主 event-loop · 判定`),
			// 摘要再说一遍就是同一句话说两遍(§5);而且它最长那句(`链路已排除(宿主与隧道均正常)`,16 字)
			// 会把这一行顶到 43 字符,在 396px 里必然折行 —— 摘要 34 字符的预算容不下它。
			return `${translate('hostShort')} ${host} · ${translate('linkShort')} ${link.count === 0 ? translate('notYet') : `p99 ${link.p99}ms`}`;
		}
		/**
		 * 工具箱摘要:这一组现在只装守夜(事故清单 + 备注 + 导出),摘要就照它写。
		 * ⚠️ 写的是**折叠态独有**的信息(检测到的次数,跨刷新 24h);「抓到 N 次 · 最差 Xms」
		 * 由展开后的第一行 `watchPanelText()` 给 —— 两处说同一句话等于白占一行(§5「能不说就不说」)。
		 */
		function toolsSummary() {
			const detected = tallyWindow(TALLY_MINUTES * TALLY_BUCKET_MS).detected;
			if (state.watch.incidents.length === 0) {
				return `${translate('watch')} ${translate('watchNone')} · 24h ${translate('watchDetected')} ${detected}${translate('times')}`;
			}
			return `${translate('watch')} ${state.watch.incidents.length}${translate('times')} · 24h ${translate('watchDetected')} ${detected}${translate('times')}`;
		}
		/**
		 * 守夜层在面板上的那一行:抓到几次、最差多少、有几条是刷新后读回来的。
		 * 没抓到也照实说(把当前阈值写出来,免得读成"守夜没在工作")。
		 */
		function watchPanelText() {
			const watch = state.watch;
			if (watch.on === false) return translate('watchOff');
			if (watch.incidents.length === 0) return `${translate('watchNone')}(≥${WATCH_TRIGGER_MS}ms)`;
			const worst = watch.incidents[0];
			return `${translate('watchCaught')} ${watch.incidents.length}${translate('times')} · ${translate('watchWorst')} ${Math.round(worst.severity)}ms` +
				(watch.restored === 0 ? '' : ` · ${translate('watchRestored')} ${watch.restored}`) +
				(watch.trimmedByBytes === 0 ? '' : ` · ${translate('watchTrimmed')} ${watch.trimmedByBytes}`) +
				(watch.persistError === null ? '' : ` · ⚠️ ${translate('watchPersistFailed')}`);
		}
		/**
		 * 「最差事件」块底下/悬停的那一句话:这条事故是什么、什么时候、带没带备注。
		 * ⚠️ 它跟的是**选中的那条**(selectedIncident),不是硬编码 incidents[0] —— 用户在清单里
		 * 切了一条之后,面板上三处必须说同一条事故,否则"选中的"和"摘要说的"会打架。
		 */
		function watchSelectedText() {
			const row = selectedIncident().row;
			if (row === null) return null;
			const at = Date.parse(row.at);
			return `${row.id} · ${row.cause} · ${Math.round(row.severity)}ms` +
				(Number.isFinite(at) ? ` · ${clock(at)}` : '') +
				(row.note === null || row.note === undefined ? '' : ` · ${row.note}`);
		}
		/**
		 * 「最差事件」块底下那一行:只在**还有话要说**的时候出现。
		 * 「抓到几次 / 最差多少 / 还没抓到 / 未开录」上面那一行已经说过,再说一遍就是同一句话
		 * 说两遍(§5 那条规矩);真正需要说出口的是三个状态位:读回 / 裁掉 / 落盘失败。
		 */
		function watchFlagText() {
			const watch = state.watch;
			// 上面那行已经写了「未开录」/「还没抓到(≥100ms)」,这里不重复
			if (watch.on === false) return null;
			if (watch.incidents.length === 0) return null;
			const flags = [];
			if (watch.restored > 0) flags.push(`${translate('watchRestored')} ${watch.restored}`);
			if (watch.trimmedByBytes > 0) flags.push(`${translate('watchTrimmed')} ${watch.trimmedByBytes}`);
			if (watch.persistError !== null) flags.push(`⚠️ ${translate('watchPersistFailed')}`);
			return flags.length === 0 ? null : `${translate('watch')} · ${flags.join(' · ')}`;
		}
		/**
		 * 「最差事件」块那一行的**值**:未开录 / 还没抓到(带阈值)/ 严重度(文字 + 数字)。
		 * 阈值写在这里而不是另起一行 —— 「还没抓到」+「还没抓到(≥100ms)」两行是同一句话。
		 */
		function eventValueText(row) {
			if (state.watch.on === false) return translate('watchOff');
			if (row === null || row === undefined) return `${translate('watchNone')}(≥${WATCH_TRIGGER_MS}ms)`;
			return `${severityText(severityLevel(row.severity))} ${Math.round(row.severity)}ms`;
		}
		/**
		 * 工具箱里的一条事故:`1. i7 · frame · 326ms · 14:48 · 读回`。
		 * 被选中的那条前面加 `● ` —— 清单排序是**按严重度**的,不标出来读者会以为"第一条就是最近那条"。
		 */
		function watchRowText(row, index) {
			const at = Date.parse(row.at);
			const marker = state.watch.selId === row.id ? '● ' : '';
			return `${marker}${index + 1}. ${row.id} · ${row.cause} · ${Math.round(row.severity)}ms` +
				(Number.isFinite(at) ? ` · ${clock(at)}` : '') +
				(row.restored === true ? ` · ${translate('watchRestored')}` : '') +
				// 靠"每天最差"那一档留下的要标出来,否则读者会奇怪它为什么没被更差的事故挤掉
				(row.tier === 'daily' ? ` · ${translate('watchDaily')}` : '') +
				(row.note === null || row.note === undefined ? '' : ` · ${row.note}`);
		}
		/** 概览的 hover:把口径(四条腿)与名字分布都摊开,免得只看到一个被抬高的命中率。 */
		function overviewTitle() {
			const tally = longTaskTally();
			return `${translate('overviewHint')}\n` +
				`${translate('hit')} = 四条腿任一命中:${translate('legFiber')} ${tally.fiber} · ${translate('legSubtree')} ${tally.subtree} · ${translate('legDom')} ${tally.dom} · ${translate('legOwner')} ${tally.owner} · ${translate('unblamed')} ${tally.none}` +
				(tally.topNames.length === 0 ? '' : `\n${translate('topBlame')}: ${tally.topNames.map(([name, count]) => `${name} ${count}×`).join(' · ')}`) +
				// B1:记录器自己单列,并且**明说它不在这张榜里参与排名**
				(tally.selfTotal === 0 ? '' : `\n${translate('recorder')}(${translate('blameSelfHint')}): ${tally.self.map(([name, count]) => `${name} ${count}×`).join(' · ')}`);
		}
		/** 折叠摘要里的一句话节点数:取不到就如实说未采集。 */
		function containerNodes(id) {
			const entry = state.targets.get(id);
			return entry === undefined || entry.nodes === null ? translate('notYet') : String(entry.nodes);
		}
		/**
		 * 面板"需要重渲染"的指纹:只包含面板真正显示的数值。
		 * 没变就跳过 500ms 的强制渲染 —— 全部折叠、数值不动时,HUD 自身开销应当接近零。
		 * (500ms 定时器本身不贵,贵的是一次 React 渲染 + 上万次 DOM 读。)
		 */
		function displayKey() {
			const tally = longTaskTally();
			const rows = pluginTable();
			return [
				state.on ? 1 : 0, state.precise ? 1 : 0, state.collapsed ? 1 : 0,
				state.fps.toFixed(1), state.frameWorst.toFixed(0), state.unattrAvg.toFixed(1), state.unattrPeak.toFixed(0),
				state.ltTotal, state.ltBlamed, state.longTasks.length,
				state.dom.total, state.mutations, state.heap ?? 'x',
				state.streaming ? 1 : 0, state.idleSince === 0 ? 0 : Math.round((performance.now() - state.idleSince) / 1000),
				rows.slice(0, TOP_N).map((row) => `${row.id}:${row.cps}:${row.cpsPeak}`).join(','),
				`${tally.fiber}/${tally.subtree}/${tally.dom}/${tally.owner}/${tally.none}`,
				tally.topNames.map((row) => `${row[0]}:${row[1]}`).join(','), tally.selfTotal,
				state.host === null || state.host === undefined ? 'x' : `${state.host.eventLoop?.p50}/${state.host.eventLoop?.p99}/${state.hostError}`,
				linkRowText(), state.loadState, state.linkText,
				experiment.phase, experiment.message, experiment.results.length, experiment.restored === null ? 0 : 1,
				state.marks.length, state.errors.length, state.stressNodes > 0 ? 1 : 0, state.baselineRunning ? 1 : 0,
				// 事故选中上下文:选中的那条被更差的新事故挤出留存清单时会**自动退回**,指纹不带它
				// 面板就会一直显示旧的「已选中」(而 selectedIncident 已经换了一条)
				state.watch.incidents.length, state.watch.selId ?? 'x', state.copyNote ?? 'x', state.pickNote ?? 'x',
				state.causeOpen ? 1 : 0, state.packPreviewId ?? 'x',
				// 诊断上下文(实时 / 历史事故 / 事故里的哪一帧):切上下文是用户动作,必须立刻重绘,
				// 所以它也在指纹里(否则切了模式面板可能停在旧的那一支,直到别的数字变化)
				state.watch.mode, state.watch.frameT ?? 'x', state.watch.scope,
				unexplainedFrame() === null ? 0 : 1, infraVerdict().text,
				Object.values(state.groups).map((value) => (value ? 1 : 0)).join(''),
				// 60 秒帧条:它每秒都在滚(老格子出窗口、新格子进来),而其它数字可能几百秒不动 ——
				// 不放进指纹的话,展开着也会冻在打开那一刻。用 5 秒刻度而不是每帧算一遍条子,
				// 是为了不让"面板自己的开销"变成每 tick 遍历 3600 帧。
				Math.floor(performance.now() / 5000),
			].join('|');
		}
		/** 用户动作 → 立刻重渲染并刷新指纹(动作必须即时反馈,不能等 0.5 秒)。 */
		function bump() {
			state.displayKey = displayKey();
			if (typeof state.requestRender === 'function') state.requestRender();
		}
		/** 还有组开着吗(没有的话「全部折叠」就是个点了没反应的按钮)。 */
		function anyGroupOpen() {
			for (const key of Object.keys(state.groups)) if (state.groups[key] === true) return true;
			return false;
		}
		/**
		 * 「现在的布局/上下文与默认值不一样吗」—— 界面据此决定要不要露出「恢复默认布局」。
		 * 默认布局下这个按钮本身没有意义,常驻只会让首屏多一个"点了也没变化"的动作。
		 */
		function layoutDirty() {
			if (anyGroupOpen()) return true;
			if (state.watch.mode === 'incident') return true;
			if (state.watch.onlyBad === true) return true;
			if (state.watch.frameT !== null) return true;
			if (state.watch.pickT !== null) return true;
			if (state.watch.selId !== null) return true;
			if (state.watch.scope !== 'worst') return true;
			if (state.copyNote !== null || state.pickNote !== null) return true;
			return false;
		}

			return {
				timeoutError,
				cancelledError,
				isAbortError,
				fetchFailureText,
				fetchTextWithin,
				fetchJsonWithin,
				ownerOfUrl,
				absolutePluginUrl,
				mapUrlOf,
				sectionName,
				bundleMetaOf,
				bundleLabel,
				bundleMap,
				readMapIndex,
				writeMapIndex,
				pruneMapIndex,
				evictMapEntries,
				touchMapCache,
				saveMapCache,
				pruneMapCache,
				loadBundleMap,
				loadBundleMapByProbe,
				sectionSource,
				sectionIndex,
				sectionOwner,
				sectionPath,
				resolveOwner,
				primeBundleMaps,
				loadScriptLines,
				ensureScriptLines,
				scriptLineOf,
				packageOfScript,
				scriptPosition,
				viaText,
				scriptEvidence,
				evidenceName,
				evidencePlace,
				evidenceWhereText,
				evidenceLine,
				incidentScriptEvidence,
				incidentEvidenceAt,
				incidentEvidenceLines,
				evidenceScope,
				evidenceZeroText,
				locatable,
				evidenceFooter,
				evidenceFooterTitle,
				significance,
				worstSecond,
				provenanceOf,
				capabilities,
				capabilityMissing,
				provenanceText,
				strengthText,
				causeCandidates,
				manifestFor,
				diagnosticSummary,
				packReadme,
				buildPack,
				packPreview,
				exportPack,
				scrubParams,
				redactPageUrl,
				redactScriptUrl,
				redactPath,
				redactUserAgent,
				redactExport,
				redactionReport,
				snapshot,
				exportJson,
				pickIncident,
				incidentReport,
				incidentFileName,
				exportIncident,
				severityLevel,
				severityText,
				severityColor,
				incidentOwner,
				selectedIncident,
				diagMode,
				incidentFrameRows,
				incidentLoafAt,
				incidentWorstFrame,
				selectedIncidentFrame,
				incidentFrameLevel,
				incidentFrameHot,
				incidentFrameNav,
				incidentFrameStep,
				incidentVerdict,
				verdictColor,
				eventEvidenceText,
				eventVerdictText,
				eventWindowText,
				incidentSummaryText,
				attrText,
				restValueText,
				restTitleText,
				msPerSecText,
				sceneChip,
				unexplainedFrame,
				infraVerdict,
				overviewLine1,
				overviewLine2,
				frameSplit,
				splitLegend,
				frameArcs,
				frameSeverity,
				worstLoaf,
				loafRanks,
				pickList,
				pickedLoaf,
				sparkBars,
				sparkPickMap,
				sparkCellTitle,
				replayScope,
				replayX,
				replaySummaryText,
				incidentWallClock,
				replayColumns,
				replayCellTitle,
				incidentScriptOf,
				incidentFrameTally,
				incidentWindowTally,
				incidentFrameEvidenceRows,
				incidentLongTasksAt,
				incidentFrameHeadingText,
				liveFrameHeadingText,
				detailContext,
				sparkLevel,
				invokerLabel,
				tallyScripts,
				jsBreakdownText,
				spanText,
				windowScopeText,
				scriptPkgTally,
				framePkgTally,
				unresolvedLabel,
				whoRows,
				barSegments,
				crossSummary,
				crossTable,
				sparkStrip,
				unattrText,
				hitText,
				detailSummary,
				domSummary,
				hostSummary,
				toolsSummary,
				watchPanelText,
				watchSelectedText,
				watchFlagText,
				eventValueText,
				watchRowText,
				overviewTitle,
				containerNodes,
				displayKey,
				bump,
				anyGroupOpen,
				layoutDirty
			};
		};
		exports.ready = true;
		return exports;
	},
});
