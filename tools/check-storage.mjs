/**
 * 验证「写进 `localStorage` 的东西能活过一次刷新」—— 落盘的事故、跨会话基线都靠这条。
 *
 *   node tools/check-storage.mjs
 *   node tools/check-storage.mjs \
 *     --one="localStorage.setItem('dsh-perf-hud:incidents:v1', JSON.stringify({ v: 1, savedAt: Date.now(), incidents: [] }))" \
 *     --two="JSON.parse(localStorage.getItem('dsh-perf-hud:incidents:v1')).incidents.length" \
 *     --expect=0
 *
 * 做法:同一个 Chrome 用户目录里**分两阶段**跑 —— ① 在页面里写 ② **重新加载** ③ 再读。
 * 注意一定要走 `reload()`,不是新开一个标签页:要验的正是"刷新之后还在"。
 *
 * 参数:`--one=<js 写>`、`--two=<js 读>`、`--expect=<JSON>`(不给就只打印读到的值)、`--url=`、`--port=`。
 * 默认那一对写/读一个探针键 —— 它同时也在验证这个两阶段骨架本身能用。
 *
 * 这不是离线门禁(要真浏览器 + 本机 `dsh web`);它挡的是"面板说存下来了、刷新之后没了"。
 */
import { withPage } from './cdp.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
	const hit = argv.find((row) => row.startsWith(`--${name}=`));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const KEY = 'dsh-perf-hud:check';
// 默认那一对:写一个探针键并**把写进去的值返回**(setItem 自己返回 undefined,打出来不好看),
// 读回来对比 —— 这同时验证了"两阶段骨架本身能用"。
const one = opt('one', `(() => { const v = String(Date.now()); localStorage.setItem(${JSON.stringify(KEY)}, v); return v; })()`);
const two = opt('two', `localStorage.getItem(${JSON.stringify(KEY)})`);
const expect = opt('expect', null);

let failed = 0;
const check = (name, ok, detail = '') => {
	if (ok !== true) failed += 1;
	console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `  ${detail}`}`);
};

await withPage({ port: Number(opt('port', '9371')), url: opt('url', undefined), keep: argv.includes('--keep') }, async (page) => {
	await page.waitForHud();
	const written = await page.evaluate(one);
	console.log(`阶段 1(写)  返回 ${JSON.stringify(written)}`);
	await page.reload();
	console.log('阶段 2 重新加载完成,面板又回来了');
	const read = await page.evaluate(two);
	console.log(`阶段 2(读)  ${JSON.stringify(read)}`);

	if (expect === null) {
		check('写入的键在刷新之后仍然读得到(值见上)', read !== null && read !== undefined);
	} else {
		let want = expect;
		try { want = JSON.parse(expect); } catch { /* 不是 JSON 就按字符串比 */ }
		check(`刷新之后读到的值等于 --expect(${JSON.stringify(want)})`, JSON.stringify(read) === JSON.stringify(want), JSON.stringify(read));
	}
	const errors = await page.evaluate(`window.__perfHud.snapshot().errors.length`);
	check('刷新后面板渲染 0 错误', errors === 0, String(errors));
});

console.log(failed === 0 ? 'ALL PASS(真页面)' : `FAILURES=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
