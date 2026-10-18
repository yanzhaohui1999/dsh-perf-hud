/**
 * dsh-perf-hud 的包内分片(package-local chunk):控制台工具(隔离实验)。
 *
 * 只有 `__perfHud.experiment()` 会加载它 —— 不跑实验就永远不下载,也不占主文件。
 * 注册约定同 client.pack.js:文件名必须是 client.<suffix>.js,chunk 写文件名,id 写包名。
 */
window.__ModuleLoader__.load({
	id: 'dsh-perf-hud',
	chunk: 'client.tools.js',
	factory: (require) => {
		const exports = {};
		exports.createToolsApi = (deps) => {
			const {
				state, experiment, translate, PKG, bundleOp, measureWindow, sleep,
				pickExperimentCandidates, experimentDelta, noiseFloor, significance, natives,
				STEP_MS, BRACKET_MS, EXPERIMENT_IDLE_WAIT_MS, EXPERIMENT_LOAD_BURN_MS,
				EXPERIMENT_LOAD_PERIOD_MS, IDLE_GAP_MS,
			} = deps;

		function abortExperiment() {
			if (experiment.phase !== 'running') return false;
			experiment.aborted = true;
			experiment.message = '中止中:正在恢复原状';
			stopExperimentLoad();
			return true;
		}
		/**
		 * 实验用的合成负载:每个窗口注入**同一份**工作。
		 *
		 * 为什么必须有:空闲下比较毫无意义(所有窗口都没活干,Δ 必然≈0),而流式又不稳定
		 * (各窗口负载不同)。所以自己造一份恒定负载,让所有窗口的对比基准一致。
		 * 用 natives.setInterval(不经过我的插桩)、只烧 CPU 不动 DOM,以免污染归因表。
		 */
		function startExperimentLoad() {
			if (experiment.loadTimer !== 0) return;
			experiment.loadTimer = natives.setInterval(() => {
				const until = performance.now() + EXPERIMENT_LOAD_BURN_MS;
				while (performance.now() < until) { /* 合成负载 */ }
			}, EXPERIMENT_LOAD_PERIOD_MS);
		}
		function stopExperimentLoad() {
			if (experiment.loadTimer === 0) return;
			natives.clearInterval(experiment.loadTimer);
			experiment.loadTimer = 0;
		}
		/**
		 * 等会话空闲(连续 IDLE_GAP_MS 没有流式),最多等 waitMs。
		 * 实测两次实验都跑在流式回合里,四行全被标"不可比" —— 与其事后标注,不如先等。
		 */
		async function waitForIdle(waitMs) {
			const started = performance.now();
			let calmSince = state.streaming ? 0 : performance.now();
			while (performance.now() - started < waitMs) {
				if (experiment.aborted === true) return false;
				if (state.streaming) {
					calmSince = 0;
				} else if (calmSince === 0) {
					calmSince = performance.now();
				} else if (performance.now() - calmSince >= IDLE_GAP_MS) {
					return true;
				}
				experiment.message = `等待会话空闲(${Math.round((performance.now() - started) / 1000)}s)`;
				await sleep(1000);
			}
			return false;
		}
		/** 把候选恢复成原始开关状态;返回每一项的真实回执。 */
		async function restoreCandidates(stateBefore) {
			const restores = [];
			for (const [name, enabled] of stateBefore) {
				if (enabled !== true) continue;
				try {
					const payload = await bundleOp('setBundle', { op: 'setBundle', name, enabled: true, confirm: true });
					restores.push({
						name,
						ok: payload.ok === true && payload.result?.application === 'applied',
						application: payload.result?.application ?? null,
						error: payload.ok === true ? null : payload.error,
					});
				} catch (error) {
					restores.push({ name, ok: false, application: null, error: error instanceof Error ? error.message : String(error) });
				}
			}
			return restores;
		}
		async function runExperiment() {
			if (experiment.phase === 'running') return false;
			experiment.phase = 'running';
			experiment.aborted = false;
			experiment.results = [];
			experiment.restored = null;
			experiment.baseline = null;
			experiment.startedAt = Date.now();
			experiment.message = '读取原始 bundle 列表';
			experiment.via = null;
			let listed;
			try {
				listed = await bundleOp('listBundles', { op: 'listBundles' });
			} catch (error) {
				experiment.phase = 'failed';
				experiment.message = `宿主不可达:${error instanceof Error ? error.message : String(error)}`;
				return false;
			}
			if (listed.ok !== true) {
				experiment.phase = 'failed';
				experiment.message = `宿主不可用:${String(listed.error)}`;
				return false;
			}
			experiment.original = listed.bundles;
			experiment.via = listed.via ?? null;
			// 候选来自宿主刚给的列表本身,不是写死的名字 —— 换台机器换个 profile 都成立。
			experiment.candidates = pickExperimentCandidates(listed.bundles, PKG);
			if (experiment.candidates.length === 0) {
				experiment.phase = 'failed';
				experiment.message = 'bundle 列表里没有可对照的第三方插件(需要已启用且可移除的非官方包)';
				return false;
			}
			const stateBefore = new Map();
			for (const name of experiment.candidates) {
				const found = listed.bundles.find((bundle) => bundle.name === name);
				stateBefore.set(name, found === undefined ? null : found.enabled === true);
			}
			experiment.candidateState = [...stateBefore.entries()].map(([name, enabled]) => ({ name, enabledBefore: enabled }));

			experiment.message = '等待会话空闲';
			const calmed = await waitForIdle(EXPERIMENT_IDLE_WAIT_MS);
			if (experiment.aborted === true) {
				experiment.message = '已中止(还没开始测量)';
			} else if (calmed === false) {
				// 等不到也照跑,但把"这次对照会被标注不可比"说在前面,不偷偷给数字。
				experiment.message = '一直有回合在跑,继续测量(各行会被标"不可比")';
			}
			startExperimentLoad();

			experiment.message = `基线窗口 0(${Math.round(BRACKET_MS / 1000)}s)`;
			// A/B/A:每个候选都跟"紧邻它前面的那个基线"对照,并在恢复后立刻再打一次基线 ——
			// 后者既验证"恢复是否真的回到原状",又提供基线漂移样本(噪声底)。
			let previousBase = await measureWindow('base', BRACKET_MS);
			experiment.baseline = previousBase;
			experiment.drifts = [];
			experiment.noise = null;

			try {
				const total = experiment.candidates.length;
				for (let position = 0; position < total; position += 1) {
					const name = experiment.candidates[position];
					const step = `${position + 1}/${total}`;
					if (experiment.aborted === true) break;
					const before = stateBefore.get(name);
					if (before === null) {
						experiment.results.push({ name, applied: false, reason: '不在 bundle 列表里(未安装或不是 bundle)' });
						continue;
					}
					if (before === false) {
						experiment.results.push({ name, applied: false, reason: '本来就是关闭状态,无法对比' });
						continue;
					}
					experiment.message = `${step} ${name}:关闭`;
					const off = await bundleOp('setBundle', { op: 'setBundle', name, enabled: false, confirm: true });
					const offApplied = off.ok === true && off.result?.application === 'applied';
					const row = {
						name,
						applied: offApplied,
						changeResult: off.result ?? null,
						error: off.ok === true ? null : off.error,
					};
					if (offApplied === false) {
						row.reason = `宿主没有真的关掉(${String(off.result?.application ?? off.error)})`;
						experiment.results.push(row);
						continue;
					}
					experiment.message = `${step} ${name}:测量窗口(${Math.round(STEP_MS / 1000)}s)`;
					row.window = await measureWindow(`off:${name}`, STEP_MS);
					experiment.message = `${step} ${name}:恢复`;
					const back = await bundleOp('setBundle', { op: 'setBundle', name, enabled: true, confirm: true });
					row.restore = {
						ok: back.ok === true && back.result?.application === 'applied',
						application: back.result?.application ?? null,
						error: back.ok === true ? null : back.error,
					};
					experiment.message = `${step} ${name}:恢复后基线(${Math.round(BRACKET_MS / 1000)}s)`;
					const base = await measureWindow('base', BRACKET_MS);
					row.afterBase = base;
					row.delta = experimentDelta(previousBase, row.window);
					row.drift = experimentDelta(previousBase, base);
					// 窗口里有流式渲染时,帧率与长任务都被别的东西主导,这种对照不可比。
					row.confounded = row.window.streaming === true || previousBase.streaming === true;
					experiment.drifts.push(row.drift);
					previousBase = base;
					experiment.results.push(row);
				}
			} catch (error) {
				experiment.message = `中断:${error instanceof Error ? error.message : String(error)}`;
			}

			stopExperimentLoad();
			experiment.message = experiment.aborted === true ? '中止:恢复原状' : '恢复原状并核验';
			const restores = await restoreCandidates(stateBefore);
			let after = null;
			try {
				after = await bundleOp('listBundles', { op: 'listBundles' });
			} catch (error) {
				after = null;
			}
			const diff = [];
			if (after !== null && after.ok === true && Array.isArray(after.bundles) && Array.isArray(experiment.original)) {
				for (const before of experiment.original) {
					const now = after.bundles.find((bundle) => bundle.name === before.name);
					if (now === undefined || now.enabled !== before.enabled) diff.push({ name: before.name, before: before.enabled, after: now === undefined ? null : now.enabled });
				}
			}
			experiment.restored = { restores, after: after !== null && after.ok === true ? after.bundles : null, diff, ok: diff.length === 0 };
			// 噪声底先算出来,再逐条判断"这个 Δ 是不是超出噪声"。
			experiment.noise = noiseFloor(experiment.drifts);
			for (const row of experiment.results) {
				if (row.delta === undefined || row.delta === null) continue;
				row.significant = significance(row.delta, experiment.noise);
			}
			experiment.phase = experiment.aborted === true ? 'aborted' : 'done';
			experiment.message = experiment.aborted === true ? '已中止并恢复' : `完成,恢复核验:${experiment.restored.ok ? '一致' : `有 ${experiment.restored.diff.length} 处不一致`}`;
			dirty = true;
			return true;
		}

			return { runExperiment, abortExperiment };
		};
		exports.ready = true;
		return exports;
	},
});
