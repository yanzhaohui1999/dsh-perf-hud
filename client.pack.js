/**
 * dsh-perf-hud 的包内分片(package-local chunk):诊断包 / zip / 导出。
 *
 * 加载方:`client.js` 的 `PerfHudGate` 用 `require.async('./client.pack.js')`。
 * 注册约定来自 DSH 的 `@deepseek-ai/dsh-client-modules`:
 *   - 文件名必须是 `client.<suffix>.js`(宿主只服务这个形状,见 `CLIENT_CHUNK`);
 *   - `chunk` 字段写文件名,`id` 仍写包名;加载器按 `<包名>/<文件名>` 记 factory;
 *   - 脚本执行即注册,`factory(require)` 的返回值就是 `require.async` 的 exports。
 *
 * 现在只放一个探针导出:S1 先验证「分片能加载、面板照常渲染、失败可观测」,
 * 下一步再把 `zipStore` / `buildPack` / `manifestFor` / `diagnosticSummary` /
 * `packPreview` 搬进来。
 */
window.__ModuleLoader__.load({
	id: 'dsh-perf-hud',
	chunk: 'client.pack.js',
	factory: (require) => {
		const exports = {};
		exports.ready = true;
		exports.version = 1;
		return exports;
	},
});
