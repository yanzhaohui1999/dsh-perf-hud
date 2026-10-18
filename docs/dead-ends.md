# 已知坑与已证伪的死路

> 从 [AGENTS.md](../AGENTS.md) §8 移出(2026-10-18),正文未改。踩之前先查这里。

## 8. 已知坑与已证伪的死路

仓库 / 发布侧:

1. **改 `engines.dsh` / `peerDependencies` 前必须用真实 semver 验一遍**:宿主启动预检(`plugin-compatibility`)对 `@deepseek-ai/dsh` 与所有 `@deepseek-ai/dsh-*` peer 跑 `semver.satisfies(宿主版本, range, { includePrerelease: true })`,不满足就把**整行静默禁用**(只在 stderr 留一行 `disabling profile plugin …`)。实测(宿主 `0.2.0-rc.2`):
   - `>=0.2.0-rc.2 <0.3.0-0` → PASS;`^0.2.0-rc.1` → PASS;`>=0.1.5-rc.1` → PASS
   - `^0.1.5-rc.1` → **FAIL**(caret 上界落在下一个 minor 上,范围里没有与宿主同 `[major,minor,patch]` 元组、自带预发布标签的比较子 → 预发布版本被静默排除)。生态里 `dsh-context` 用 `>=0.1.5-rc.1` 这种**开区间**能过,换成 caret 就踩坑。
   - 验法:`node -e "console.log(require('<dsh>/node_modules/semver').satisfies('0.2.0-rc.2', RANGE, {includePrerelease:true}))"`。
   - `peerDependenciesMeta.optional` **不豁免**这条检查;`engines.dsh` 只是声明(市场卡片按它或 lockstep peer 判),不参与预检。
2. **`git push` 不会带走 `refs/original/`**,但本机改写历史后旧提交仍在 `.git` 里;要真清掉得显式 `git update-ref -d refs/original/refs/heads/main && git reflog expire --expire=now --all && git gc --prune=now`(不可逆)。

已证伪的路(**不要重试**):

3. **包 `Context.emit` 抓不到 `session/event`**:该事件走**带作用域过滤的派发**(见 `@deepseek-ai/dsh-scope`),不经过公开的 `ctx.emit`。证据:装了 120 秒、期间一个子代理跑完整回合,`stats` 始终为空。→ 改用 `ctx.on(…)`,口径改成"提交 → 到达延迟"。
4. **`launchctl submit` 在本机被拒**(Bad request / 服务未登记)。→ 排队重启用 `nohup … &`,验证器用 `setsid` 起独立进程组(见 [环境与验证](verification.md))。
5. **靠节点数凑 50ms 长任务**:12000 个离屏节点 React 提交仅 ~15ms,20000 个 ~28ms;而且**布局可能被推迟到下一帧**,任务里只剩十几毫秒。→ 必须用 `flushSync` 强制同步提交 + 在任务里强制布局(读 `offsetHeight`),仍不稳就**显式燃烧**(面板标注"含人为燃烧",不冒充自然卡顿)。
6. **`require('react-dom')` 意外可用**:实测能拿到,`flushSync` 能强制同步提交(自测结果里的"(同步)"就是它)——别以为模块表里没有它。
7. **`h(undefined, …)` 这类"引用了没声明"靠 `node --check` 拦不住**(语法合法)。实测事故:一次"整段替换样式块"把紧跟在 `const S` 之后的 `const signed` 与 `function PerfHudStress` 一起吞掉 → 文件里 `h(PerfHudStress, …)` 还在、定义没了 → React 抛 `Element type is invalid` → 外壳停用条目(面板凭空消失,只能刷新)。这就是 [测试与门禁](../AGENTS.md#3-测试与门禁) 那两条静态检查存在的原因。
8. **名字黑名单是补丁**(见 [归因机制](mechanisms.md) §6.3):靠枚举宿主命名追不上宿主改名与压缩,真正的答案是四条腿交叉。
9. **通知类插件可能整个会话零回调**:`dsh-notify-me` 实测从未出现在归因表里 —— 这是"它没干活",不是"没认出"。要验它,得先让它真的做点什么。
10. **LoAF 的 `blockingDuration` 会是 0,哪怕这一帧确实很重**:受控实测(CDP 触发 `stress(8000, 200)`)那一帧帧间隔 **325.6ms**、窗口里 43 帧 >100ms,但同窗口 **116 条 LoAF 的 blocking 全是 0**;而既有的 longtask 表如实给出了 `223ms · 组件 PerfHud · 子树腿/DOM 写入腿 PerfHudStress`。所以:① **不要把 `blocking = 0` 读成"没有阻塞"**,它只说明这一帧里没有*被归因到*的长任务;② 事故的严重度以**帧间隔**为准,LoAF 的 blocking 只当补充。这次的 200ms 燃烧是经 CDP 触发的,所以不能反推"所有同步 JS 都不计"(可能只是没有 TaskAttribution)。**真人交互下的实测(2026-10-07,Windows Chrome,13 秒窗口)blocking 是 143.5 / 5.5 / 2.1ms —— 不是 0**:那条"全 0"是 headless/CDP 环境的产物,结论(blocking=0 不能读成没卡)不变。
11. **单帧尖刺不能用 p50 基线判,而且基线必须排除本窗口**:真实数据里有一帧 **983.7ms**,而它前后都是 **16.7ms(正好 60fps)**、窗口里没有一条 longtask/LoAF 与它重叠 —— 这一帧恰好卡在 1 秒间隙线**下面**(983.7 < 1000),所以被当成"真卡顿"抓了下来。三条改法:① `baseline` 改成 `frameRing.stats(from, to)`(排除本窗口),否则"比会话最差还差"永远不成立;② 额外交 `worstFrameJs`(最差帧有没有 JS 重叠)与 `suspectedThrottle`(≥500ms + 无 JS + 前后帧中位 <100ms);③ 判"是不是真的变差"要看**最差帧的倍数**,不是 p50 —— 同一份包原先给出"与本会话平时基本一致(×1.00)",把 983ms 的尖刺判成了正常。
12. **`PerformanceObserver.observe({ buffered: true })` 会把已经采过的 LoAF 再放一遍**:每次重新挂观察器(`disable→enable`、HMR 重载、重新 `apply`)都会重放最近 200 条 —— 同一个 `startTime` 于是被**重新触发**,同一次卡顿裂成多条不同 id 的事故。实测面板上同时出现 `i2 / i29 / i31`,三条的时间戳一模一样(298ms @ 23:30:18)。修法:去掉 `buffered: true`(挂上之前的帧我们本来也没采);另外按 `at|cause` 去重兜底 —— 但**缺这两个字段的条目不能参与去重**,否则会把真事故当成重复吃掉(单测里踩过)。
13. **长度预算的桩数据必须是真实量级**:`detailSummary` 的预算一直是 30~34,而桩里的数字全是 0/个位数,于是"最差秒 152ms · 未归因 17ms · DOM 写入 36250"在 396px 面板里被挤成两行这件事**从来没被断言发现**。现在桩里塞五位数,并把摘要砍到只留结论对。
14. **写模块作用域的视图函数时,`props` 里的字段必须落地成局部名字**:实测把 `mainView(props)` 里写成裸的 `trendMs`(它只是 props 的一个键),浏览器当场 `ReferenceError: trendMs is not defined` → 外壳把整个条目停用(`slot entry crashed in 'shell.overlay'`),面板整块消失;而 `node --check`、三套件、静态检查**全都看不出**来(它是个语法合法的标识符引用,不是"引用了没声明的函数")。→ 抓法只有一条:`tools/check-panel.mjs` 真开一次页面;要看清原文就临时用 CDP 收 `Runtime.consoleAPICalled`(外壳会 `console.error('slot entry crashed in …')`)。同一批还踩到:用 `page.evaluate` 拿整个 `localStorage` 会打出几十万字,别那么写探针。
15. **`tools/check-*.mjs` 里的 `check(name, ok, detail)` 只认布尔**:传数组/对象一律算失败(我给设置页那条传了 `[a, b, c]`,于是"三块齐全"明明为真却报 FAIL)。同一个文件里两种签名都出现过,改之前先看它自己的定义。
16. **批量替换(按次数替换)会改到同名调用点,而且文件本身还是"语法正确"的**:给 `frame()` 的 rAF 循环插一句自计时,锚点 `state.fpsLoop = natives.requestAnimationFrame(frame);` 在 `frame()` 与 `start()` 里**各有一处**,按次数替换就把 `selfStarted` 插进了 `start()` —— 那里没有这个变量,于是**插件激活直接失败**(外壳日志 `web boot: 1 entry did not activate / dsh-perf-hud: failed`),面板整块消失,而 `node --check` 与三套件**全绿**(单测只抽纯函数,不跑 `apply`)。教训:替换后要 `grep -c` 确认命中数;凡是插进"只在浏览器里跑"的路径(apply / start / 渲染),必须真的打开页面看一眼。
17. **改 `client.js` 时不要同时跑"受控实测"**:`dsh-client-hmr` 会热载新代码,正在跑的采集会**换到新实例**(seq 归零、状态重置),实验结果直接作废。实测踩过一次:边写落盘功能边跑受控捕获,拿到的 id 与时间戳全对不上。要采集就先把代码定下来。
18. **`node:inspector` 的同进程会话总能连上,而且允许多会话并存**(Node v25.9.0 实测,A5 采宿主 CPU profile 时撞到):`new Session().connect()` 不需要 `--inspect`(连上后 `inspector.url()` 是 `undefined`);**另一个会话正在采时再 `Profiler.start` 也不报错** —— 后来的那个直接接手采样,两个会话各自 `Profiler.stop` 都能拿到 profile。所以「宿主已经开着别的 inspector,所以我们会失败」是**错的**:真正防止两段采样互相踩的是我们自己的单飞(`running` 标志),不是 V8。错误分支实际挡的是:inspector 不可用 / 会话未连接或已断开(`post` 没 connect → `Session is not connected`;同一会话重复 `connect()` → `The inspector session is already connected`)/ `Profiler.*` 自身报错。**不管哪种都要把错误原文回给调用方,不许假装成功。**
19. **V8 CPU profile 的采样密度远低于标称**:`Profiler.start` 的默认间隔是 1000µs,但实测只有 **~180~250 次/秒**(V8 只在"可采样点"取栈,原生/GC 期间取不到)。所以一段 **5 秒** `.cpuprofile` 只有 ~1000 个采样、**约 10~13KB**(轻负载 11.5KB / 重负载 12.5KB / 边解析 5.5MB JSON 10.3KB),体积由**不同调用栈的数量**决定、不由时长决定 —— "profile 会很大所以别常开"里的**体积**不是理由,常开的代价在采样本身。反过来:回包体积从来不是问题,别为此加压缩/分片。
