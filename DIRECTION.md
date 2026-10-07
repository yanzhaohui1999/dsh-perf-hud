# 方向评审:行车记录仪、事故包与官方边界(2026-10-07)

> 本文是**设计讨论记录 + 方向结论**。它不管验收数字(→ [ACCEPTANCE.md](ACCEPTANCE.md))、不管发布缺口(→ [REVIEW.md](REVIEW.md))、不管环境事实与源码级机制(→ [AGENTS.md](AGENTS.md) §2 / §6 / §8)。
>
> **方法**:读本仓代码 + 读官方源码仓 `/Users/y/workspace/dsh/deepseek-harness`(`0.2.1-alpha.1`)+ 在**运行中的** `127.0.0.1:3080` 上实测(CDP 驱动 headless Chrome,只读、不点任何按钮)。凡"实测"都标了测量环境;凡没验的写在 §7。

---

## 0. 一句话结论

**这个工具该是"行车记录仪 + 事故包",不是"仪表盘"**:默认静默常驻、自动抓住那一下、一次抓全、产出给分析者(尤其给 agent)读的证据包;官方短期内不会和它撞,归因是护城河。

**2026-10-07 补充**:生态侧的复核(谁在同一条路上、他们放弃了什么)见 [LANDSCAPE.md](LANDSCAPE.md);结论仍是这一句,但有两处要修正 —— ①"守夜"这个**形态**已被 perf-lens 排进路线图(P1 #5,宿主侧,0.3.0),空的只是**客户端侧事故包 + 跨进程取证**;②桌面端(`dsh-app://`)上 LoAF 的 `scripts` 恒空,所以 §8 里"用 LoAF 做桌面脚本级归因"的假设不成立,见 §8 的修正段。方向本身不变,转向决定见 §9。

---

## 1. 评审提出的问题(原始清单)

**第一轮:定位与充分性**

1. 当前性能分析工具是否足够?市面上的工具有什么可借鉴?
2. 这类应用应该怎么分析?
3. 用户希望能看到的是什么?
4. 官方有没有给出足够的接口供分析?
5. 这种工具能不能出火焰图之类的直观结果?
6. 当前的展示效果是否可以提升或者重构?
7. 当前工具的目的与最初的意图,是否发生了偏移?

**第二轮:使用现场与边界**

1. 卡顿是**偶发**的:得一直开着才可能复现,不是点一下就复现。
2. 复现之后必须**一次抓全**,否则还要再等第二次复现。
3. 官方后续对这个工具的形态会是什么样?会不会撞?
4. 这个 HUD 的理想形态是什么?

**第三轮:平台**

1. 换到桌面端(Desktop)是不是就有意义了?

---

## 2. 现状盘点(实测)

### 2.1 面板现场读数

测量环境:headless Chrome 154(本机,`--headless=new --no-sandbox`,**无 GPU**)、`127.0.0.1:3080`、全新 profile(HUD 默认开启且展开)。

| 时刻 | 面板原文(节选) |
|---|---|
| 16s(冷启动) | `空闲 16s` · `14.7 fps` · 概览:`帧 147ms · LT 271ms · 命中 2/3(最差那条:未归因)` / `最差那条:未归因` / `整窗最多:SidebarRoot 1×` |
| 16s | `帧内未归因 68.1ms · 峰 147ms` + 结论行 `该帧几乎无 JS 解释:146.5ms(100%)→ 样式/布局/绘制/vsync` |
| 16s | `回调归因(耗时) 0.4ms/s` → 行 `1. application批次(16 包) 3.2/s · 峰 8/s`、`2. application批次(58 包) 0/s · 峰 0/s` |
| 16s | 折叠摘要:`取证明细 最差秒 217ms · DOM 写入(按插件) 3328` / `宿主与链路 宿主 10.37ms · RTT 526ms · RTT 存疑` / `工具箱 隔离实验 idle · 场景标记 0` |
| 55s | 除 fps(14.6)与宿主 p99(4.89ms)外**几乎不变**;`RTT 236.6ms · RTT 存疑` 仍在 |

面板几何:396px 宽、展开 510–600px 高、固定在右下角、**默认展开**;1600×857 视口下约占 1/4 面积。

**帧率与 RTT 受环境影响的说明**:无 GPU 的 headless 会把帧率压低、把长任务放大,`14–17 fps` **不是**真实体验,只用来观察面板行为。**但下面这条与 GPU 无关**:同一页面后续 6 次同源 RTT 采样是 `236.6(首个) → 5.2 → 5.0 → 5.4 → 4.6 → 5.1 → 5.5 ms`,页面自己连续 5 次直测是 `4.0 / 4.2 / 4.7 / 4.0 / 3.8 ms`(同机 curl 同路由 ≈2.6ms)。根因:`start()` 里**首个 RTT 探测立即发起**,撞上启动期主线程风暴,而 `infraVerdict()` 用 `link.p99 > 100` 判"链路存疑",那条脏样本会在 60 秒窗口里持续污染 p99。

### 2.2 代码构成([client.js](client.js) 2849 行)

| 部分 | 行数(约) | 占比 |
|---|---:|---:|
| 测量(URL→包名 / sourcemap / fiber / 插桩 / DOM / 帧 / 长任务) | 960 | 34% |
| 面板 + 文案词典 | 630 | 22% |
| 隔离实验 | 408 | 14% |
| 宿主与链路 | 263 | 9% |
| 导出 / 空闲基线 / 验收自证 | 290 | 10% |
| 装配 | 48 | 2% |

测试 ≈1293 行,文档 ≈1131 行(不含本文)。**真正"测量"的代码约占 1/3。**

### 2.3 提交史

`19 fix / 6 feat / 2 chore / 1 style / 1 refactor`;最近 8 条里 4 条是 docs/chore(发布元数据、CI、文档地图),2 条是"去掉作者写死的插件名 / 修 pluginVersion"这类可移植性修复。**近期的力气在"发出去",不在"测得更准"。**

---

## 3. 评估(第一轮)

### 3.1 工具是否足够 / 市面可借鉴什么

- **「包名」腿的覆盖是下界**:现方案包 `setTimeout/setInterval/rAF` 抓栈,事件处理器 / Promise / 微任务 / React 自身调度**都不在内**([README.md](README.md) 已如实写明)。
- **LoAF 可整块替换它的上游**。实测(同一台机、同一页面):`PerformanceObserver.supportedEntryTypes` 含 `long-animation-frame`;15 秒内收到 **175 条**。样例:
  - `duration 82 / blockingDuration 32`,`invoker TimerHandler:setTimeout`,`sourceURL …/assets/index-5SrrfWpU.js`
  - `duration 234 / blockingDuration 184`,`invokerType event-listener`,`sourceURL …/plugins/??@deepseek-ai/dsh-client-modu…`,`sourceCharPosition 19879`,`forcedStyleAndLayoutDuration 2`
  - 另有 4 条 >60ms 的条目 `scripts: []` 且 `blockingDuration: 0`
  → 第二条正是面板里那行「application批次(58 包)」;LoAF 原生给出了**脚本 URL + 字符位置 + 被强制的样式/布局耗时**,而单包名还原用本仓已有的 indexed sourcemap 分段表就能做。
- **「帧内未归因」现在是减法推断,LoAF 是直接测量**:`blockingDuration === 0 && scripts.length === 0` 就是"这一帧没有 JS,是样式/布局/绘制";`renderStart` / `styleAndLayoutStart` 还能把帧切成 [JS | 样式布局 | 渲染]。当前那句"可用 Paint flashing 交叉验证"因此可以升级成可量化结论。
- **缺交互级归因**:`PerformanceEventTiming`(Baseline 2025)给 `target` 元素 + `interactionId` + 三段拆分;`web-vitals/attribution` 的 `onINP` 已把"元素 + 最长脚本 + input/processing/presentation"拼好。实测该 entryType 在本页可用,但 headless 无真实交互 → 0 条,**数值未验**。
- **借不上的**:React DevTools Profiler 只认 dev/profiling build(DSH 是生产 `react-dom`);react-scan / react-render-tracker 只高亮重渲染、无时间轴;Million Lint 已废弃。**组件级归因必须自研** —— 截至今天没有任何浏览器 API 能把长帧归到 DOM 节点。
- **能白拿的 viewer**:导出改成 Chrome trace event 或 V8 `.cpuprofile`,即可用 Perfetto(时间轴 + SQL)与 speedscope(火焰图)打开。

### 3.2 这类应用应该怎么分析

- **官方自己的答案**:`benchmarks/long-session-browser/long-session.bench.ts`(下面凡写"官方源码仓"均指本机检出 `/Users/y/workspace/dsh/deepseek-harness`)用 Playwright + CDP `Performance.getMetrics`(`TaskDuration` / `JSHeapUsedSize`)+ `HeapProfiler.collectGarbage` + 页内 `performance.now()`,240 轮合成会话 ×3 次取中位数,每端点带预算(开屏 900 / 最慢翻页 700 / 首个 Trajectory 520 ms,×1.25 余量)。配套决策记录 `.agents/notes/implemented/testing/2026-09-06-frontend-performance-budgets.md` 写明三条方法论:**测量者自身的 CPU 也算进被测区间**、**堆/DOM 数只当诊断不当预算**、**合成负载必须走生产路径**。这是**回归门禁**。
- **HUD 该干的是"现场取证 + 分诊"**:发生了什么、在哪一相位、归到谁。现有的 A/B/A + 噪声底 + "流式窗口不给结论"已是准实验设计;但单次窗口、无重复,只能筛"固定开销大"。
- **指标层级**:交互延迟(INP)→ 长帧/LoAF → 脚本与组件 → 火焰图。当前从第 2 层开始(没有交互),第 4 层完全没有。
- **三个相位必须分开**:冷启动 / 稳态 / 流式。当前把冷启动的 147ms/271ms 直接当"卡"报红(§2.1 有证)。
- **环境必须声明**:无 GPU 的 headless 会放大一切。导出件的 `context` 头应补 UA / renderer。

### 3.3 用户想看到什么

- 用户视角只有三问:能不能用 → 谁的锅 → 我该怎么办。
- **默认态答不出"谁的锅"**(实测):归因表两行是 `application批次(16 包)` / `(58 包)` —— 精确归因默认关、还要拉 12MB map。
- **冷启动三行红字,两行在说"不知道"**,而场景标签写「空闲」。
- [ACCEPTANCE.md](ACCEPTANCE.md) 的评审响应里已经写着答案:场景标签常显、合并判色、加主语、**未解释帧自动给结论**、给"链路已排除"判定 —— 即**要判定,不要原始读数**。目前只做了两条。
- 面板里的「验收」区(独立包名 / 命中 / 空闲基线)是**作者视角**(发布评审证据),不该占常显位。

### 3.4 官方接口够不够

- **够搭 HUD**:客户端插件上下文(`ctx.slots` / `ctx.get('locale')` / `ctx.remote`)、脚本 URL + indexed sourcemap + `__DSH_BOOT__`、宿主 `connection.fetch.register`、`pluginManager.listBundles/setBundleEnabled`、`ctx.on('session/event')`、`dsh-client-hmr` 热载。细节见 [AGENTS.md](AGENTS.md) §6.4。
- **不够"直接读性能"**:没有 per-plugin 埋点、没有 `data-dsh-plugin`、生产 React 没有 `_debugSource`、没有任何 trace/span 出口。
- **DSH 的 OTel 是 logs 不是 traces**:`dsh-otel`(事件 + 有界 Session-log 的 OTLP 通道)、`dsh-session-telemetry-otel`(Session logs over OTLP-HTTP)、`dsh-host-product-telemetry-otel`(产品使用事件)—— 全是日志,且目标是**远端上报**,不是本地火焰图。要 span 得自己埋。
- 官方给的"性能接口"其实是**基准 + 决策记录**(`benchmarks/*` + `apps/web/tests/complex-history.perf.ts`,后者明确 opt-in、只报告、不做时间断言),第三方插件复用不了。
- 插件开发文档在源码仓 `docs/user/develop/`,npm 包只带各包 README;**没有性能章节**。→ 建议在 [README.md](README.md) 里明写一句"官方没有性能探针,所以本插件插桩"。

### 3.5 火焰图

- **页内出不了真火焰图**:栈采样只存在于 DevTools/CDP,页面拿不到。
- **页内能做的三种"类火焰"**:帧条带(每帧一柱,>50ms 涂红)/ 长任务 × 四条腿堆叠条 / 60 秒 sparkline。**数据都已在采**(`ring` 500 条、`dom.series`、`heapSeries`、unattr 序列)—— 采了没画。
- **宿主半能出真火焰图**:宿主是 Node,`node:inspector` 在进程内 `Profiler.start/stop` 直接拿 `.cpuprofile`(外部也可 `kill -USR1 <pid>` → `127.0.0.1:9229`)。`.cpuprofile` 每个节点带 `callFrame.url` → **可按包名聚合**;speedscope / Chrome DevTools 的 Load profile / cpupro 都能画(Perfetto 不吃 `.cpuprofile`)。
- **最省力的桥**:DevTools 录 trace → Save trace(勾 include script source maps)→ 离线脚本按本仓的 sourcemap 分段表把 combo 帧翻成**插件名火焰图**。本仓最独特的资产在**离线后处理**里比实时归因更值钱 —— DevTools 只按 URL 分组,分不出 combo 里的包。

### 3.6 展示重构

- **该重构的是信息架构,不是像素**。价效比排序:①60 秒时间条 ②默认态只留"一行结论 + 时间条 + 折叠" ③归因默认给名字(至少提示开启精确)④前 30 秒标「启动中」且不判色 ⑤四处判定收成一个 verdict 列表(每条带下一步动作)⑥折叠态缩成药丸。
- 一处口径混行:「回调归因(耗时)」组头是 `0.4ms/s`,组内行是 `3.2/s · 峰 8/s`,单位只在 hover 里。
- 一处真误读见 §2.1 的 RTT 首样本污染;这也说明 **in-page RTT 把主线程排队时间算进去了**,当前实现分不清"网络慢"和"主线程饿"。
- 右下角正在变成"插件 UI 停车场"(同屏还有 `dsh-cost-meter` 等),常驻 396×600 浮层的信息密度打不过"按需展开的全屏面板"。

### 3.7 目的与意图是否偏移

- **声明**(README 首行)是两个问题:卡不卡、卡在谁身上。**交付**是 1 个度量平台 + 1 个实验框架 + 1 套发布工程。
- **代码形状**见 §2.2:测量 1/3,展示/实验/自证 2/3。
- **意图证据**:第一版把作者自己的 4 个插件名硬编码进隔离实验候选([REVIEW.md](REVIEW.md) §2 第 7 条)→ 真实意图是"**我装的这几个插件哪个在拖后腿**",不是"通用性能平台"。泛化之后为发布补的 i18n 兜底、可移植性、187 条断言、9 份文档,都是**发布要求**,不是诊断要求。
- **偏移的代价(具体)**:默认态答不出插件名;最该有的时间轴没画;隔离实验 408 行但方法上只能测固定开销;`verification()` 进了产品常显区。
- **结论:不砍功能,重新锚定一个问题** ——"我今天用下来,哪一段最卡、是谁";隔离实验 / 验收自证 / 导出退到二级。

---

## 4. 设计结论(第二轮)

### 4.1 偶发卡顿 → 触发必须自动,证据必须带前摇

- **不能靠"看到卡了再点"**:人的反应是 1–3 秒,而证据窗口比这短。
- **自动触发 + 前摇/后摇**:帧 >阈值 / LoAF `blockingDuration` >阈值 / 长任务 >阈值 → 立即把 `[t-10s, t+3s]` 的**原样切片**存成一个"事件"。
- **现状存的是聚合,不是原始**:`ring` 是 1 秒 1 条的聚合、`dom.series` 仅 40 点、`worstFrame` 是标量、长任务明细有条数上限 → **"刚才那一下"在落盘前已被压成数字**,这是"要抓第二次"的根因。
- **底层需要一层帧级环形缓冲**(每帧一条紧凑记录,`Float32Array` 环形,60fps × 10 分钟 = 3.6 万条,可忽略),常驻、有界、零渲染。
- **自动保留"最差 N 次"**(默认 5,滚动覆盖):人不需要盯着屏幕。
- 附带收益:LoAF 是**纯被动观察器**,不包原型。**默认守夜模式可以完全不插桩**,评审那条"默认改全局原型"的风险随之消失。

### 4.2 "一次抓全" —— 有些证据只存在于当时

| 证据 | 现状 | 只存在于当时? |
|---|---|---|
| 帧级时间轴(每帧 start/duration) | ✗ 只有标量最差帧 | 否(但现在没存) |
| LoAF 全字段(`blockingDuration` / `renderStart` / `styleAndLayoutStart` / `scripts[]{sourceURL, invokerType, sourceCharPosition, sourceFunctionName, forcedStyleAndLayoutDuration, pauseDuration}`) | ✗ 完全没用 | 否(但须当时就订阅) |
| 长任务 + 四条腿归属 | 部分(常留空) | **是** —— fiber 只看最近 2 秒变更节点 |
| DOM 写入栈 / 组件名 / 变更节点 | 采样 1/10,只留计数 | **是** —— 栈只在写入点存在 |
| 回调 owner(调度点栈) | 有(累计) | **是** —— `state.recent` 上限 256 |
| 会话/agent 事件时间轴(`tool/result`、`compaction/prune`、`turn/start`…) | ✗ 只统计到达延迟 | 否(但须常开记录) |
| 宿主 event loop 逐秒 | ✓ 300 秒环形 | 否 |
| 环境自描述(rev / bundle 版本 / UA / 视口 / 会话规模 / HUD 自身开销 / 阈值) | 部分 | 否 |

- **最该补的是会话时间轴**:宿主 `ctx.on('session/event')` 现成可用,只记 `type + time`(不记 payload → 便宜且无隐私问题)。DSH 的真实事件里就有 `compaction/prune`、`workspace/changes`、`tool/result` 这类**一次性、重建历史**的操作 —— 流式界面偶发卡顿的典型元凶,而当前面板对它一无所知。
- **时间基准要统一**:宿主每次响应带 `Date.now()` + `hrtime`,客户端配对 `performance.timeOrigin + performance.now()` → 建立偏移,事后才能回答"卡的那 300ms 宿主在干什么"。现在只靠 RTT 采样对齐,不够。
- **导出必须带"缺失声明"**:这次没拿到 DevTools trace / 宿主 CPU profile,就写清楚,并给出补齐的确切步骤(延续"不许假装成功")。
- **两个文件别混**:`incident.json`(结构化证据,给人也给 agent 读)+ 可选 `trace.json` / `*.cpuprofile`(给 viewer)。当前 455KB 的聚合导出其实**比原样片段更大**;10 秒原样事件约几十到几百 KB。

### 4.3 官方形态与撞车分析

**短期不会撞;中期只在"入口"上撞;归因是护城河。** 证据(均来自上游源码仓 `0.2.1-alpha.1`):

- **官方没有运行时性能埋点**:69 个 client 包里没有 devtools/diagnostics/perf 包;`PerformanceObserver` / `performance.mark` 在产品代码里**零使用**(只出现在测试与 webworker stub);`data-dsh-plugin` **仍不存在**。
- **官方的性能形态是 CI 预算,不是用户面板**(§3.2);上游最近的 `perf(...)` 提交全是**产品优化**(tool-arg 流式、会话列表时间切片、长会话渲染、鲸鱼动画),不是监控工具。
- **官方对"常驻日志"是保守的**:`.agents/notes/implemented/architecture/2026-09-22-fatal-diagnostics-and-crash-reports.md` 里,连续日志设计是 **future work**,姿态为"闭集事件词表 + 脱敏 + 限速";原始内容只在**一次性崩溃报告**里保留,且有界(64KiB)、owner-only、本地、用户可见。
- **Web 端产品分析被明确排除**(`dsh-api-remotes` README:"Web usage is excluded")→ 不存在"官方遥测长成性能面板"这条路。
- **真正会撞的两处**:①官方给 DOM 打 `data-dsh-plugin` 或开放 per-plugin 钩子 → 归因贬值,此时应**主动消费**(插件变准,不对抗);②官方做"诊断面板"会抢入口,但它是**事后/致命**视角,不是"卡顿现场"。策略:定位成"官方基准的补充 + 官方数据的消费者",格式对齐(owner-only、有界、标准 trace/cpuprofile),被收编时是数据源而不是竞品。→ **桌面端(Desktop)会改变这里的几条结论,见 §8;生态里各家的逐条复核(装机量、技术硬点、他们明确放弃了什么)见 [LANDSCAPE.md](LANDSCAPE.md)。**

### 4.4 理想形态

**默认静默的守夜记录器 + 一次点击产出的事故包;面板是次要的。**

| 模式 | 什么时候 | 做什么 | 开销目标 |
|---|---|---|---|
| **守夜**(默认常驻) | 一直 | 零插桩:帧 rAF + LoAF 观察器;帧级环形缓冲;自动保留最差 5 次事件;零面板或只剩一个状态点 | <0.1% 主线程 |
| **现场**(展开) | 想看一眼 | 一行结论 + 60 秒时间条 + 事故列表(可点开看证据链) | 可忽略 |
| **深录**(显式 5–10 分钟) | 要抓全 | 才打开原型插桩(DOM 写入 1/1 + 抓栈)、可选宿主 `node:inspector` CPU profile、提示同时存一份 DevTools trace | 有代价,显式 |

- **交互**:一个快捷键 = "标记刚才那一下"(自动按 -3s 反应时间回退);其余全自动。用户永远不需要盯着面板。
- **输出**:一个 `.zip`/文件夹 —— `incident.json` + 自带口径的 README(阈值、缺失项、复现方法)+ 可选 trace/cpuprofile。**默认按"给 agent 一次读懂"设计**:不截断、字段自解释、时间轴已对齐、"结论"与"证据"分开。
- **历史**:事故进 IndexedDB(浏览器侧,不碰 DSH profile),可对比、可按签名归组("同类事件出现 4 次")。
- **与现状的关系**:当前面板 + 隔离实验不删,降级成深录模式的一部分;守夜是新增的最轻那一层。

---

## 5. 已定决策与最小改造路径

> 转向的完整取舍(保留 / 停投 / 明确不做,以及为什么)见 §9;本节是执行面上的最小路径。

**决策**

1. 定位从"仪表盘"改为"行车记录仪 + 事故包";面板退居二级。
2. 默认模式**不插桩**:帧 + LoAF 就够给出"帧级 + 脚本级"归因。
3. 「包名」腿的上游改用 LoAF(保留旧腿作为非 Chrome 兜底),并在单包名还原时复用已有 sourcemap 分段表。
4. 导出从"聚合快照"改成"**事件切片 + 缺失声明**",聚合导出保留为概览。
5. 常开记录 `session/event` 的 `type + time`,并把宿主时间基准带进响应。

**最小改造路径(三步)**

1. **守夜层**:帧级环形缓冲 + LoAF 观察器 + 自动保留最差 5 次(新代码、不插桩)。
2. **会话时间轴**:`watchEvents` 从"只统计延迟"改成"常开记录 type+time";宿主响应带时间基准。
3. **导出改造**:`incident.json`(证据切片 + 缺失声明),旧聚合导出保留。

**顺带该修的小问题(本轮发现)**

- 首个 RTT 探测延后 5–10 秒或丢弃首个样本 —— 现在它会把本地回环测成 236–526ms 并让整分钟显示"链路存疑"。
- `infraVerdict()` 的 `link.p99 > 100` 判据应加"主线程不忙"的前提,或改成只看经过启动期的窗口。

---

## 6. 未验证与已知边界

- **Event Timing**:entryType 支持已实测,但 headless 无真实交互 → 条目数 0,**数值与实际归因能力未验**(需真人交互)。
- **LoAF 的浏览器覆盖是 Chrome 侧**:Firefox / Safari 未实现(MDN 标 not Baseline)。非 Chrome 需要保留旧腿 —— 因此"默认不插桩"只在 Chrome 成立,要有特征检测与降级路径。
- **Perfetto 直接导入 `.cpuprofile`** 未确认(其文档列出的外部格式不含 `.cpuprofile`);speedscope 与 Chrome DevTools 的 Load profile 是已确认路径。
- **combo URL(`??a.js,b.js`)在 DevTools 火焰图里的标注方式**未确认;本仓的 sourcemap 分段方案不受影响。
- **LoAF 的 `blockingDuration` 语义尚未摸清**:受控实测里一帧 325ms、窗口 43 帧 >100ms,116 条 LoAF 的 blocking **全是 0**,而 longtask 表给出了 223ms 与组件名。已写进 AGENTS §8 第 10 条当坑记着;需要真人交互(非 CDP 触发)复测一次才能定论。
- **落盘容量:选了"缩小数据"而不是"扩大容量"**(2026-10-07,实测决定)。一份事故:紧凑 **116.6KB** / 导出缩进 **138.6KB**;分块看 **`loaf` 占 77.9%**,而它里面 **75.4KB 是同一个 2.9KB 的 combo URL 重复了 27 遍**,`summary.topScripts` 又抄了 14.7KB。抽成 URL 表(`incident.urls` + `scripts[].u`)后:**29.6KB / 51.5KB**,512KB 从放 4 条变成放 **17** 条,信息零损失。gzip 也能压到 7.7KB,但抽表后只到 6.8KB —— 说明 gzip 省的就是这块重复,那就直接去掉它,不必引入编解码器和异步恢复。结论:留存 5 → **10** 条;天花板仍是 512KB 字节上限(约 17 条),`localStorage` 够用,**暂时不需要 IndexedDB**;真要"存一整天"(上百条)再换,那时按时间淘汰而不是按严重度。
- **桌面端的四条推论全部未实测**(见 §8;其中 Electron 侧的 API 形状已按 `electron.d.ts` 核对,运行时行为未测):插件能否安装、`connection.fetch.register` 在 Desktop 的 Host 子进程里是否同样可达、`webContents.debugger`(CDP)挂到应用窗口是否与私有 IPC/`dsh-app://` 协议冲突、hide 期间是否继续记录。
- 本文 §2.1 的帧率/长任务数字来自 **headless、无 GPU** 环境,不可当作真实体验;RTT 与 LoAF 结论与该环境无关。
- 面板截图留在 `/tmp/hud-panel.png`(冷启动)与 `/tmp/hud-panel-warm.png`(55s),是临时文件;重取方法见 §7。

---

## 7. 本次实测的可复现记录

**测量手段**:CDP 驱动 headless Chrome,`Page.navigate` 到 `http://127.0.0.1:3080/?token=…`(token 从宿主日志现取,不落盘),等固定时长后用 `Runtime.evaluate` 读面板 `innerText` 与 `window.__perfHud` 的实时读数,再用 `Page.captureScreenshot` 截图**只读,不点任何按钮**。

1. **面板读数 + 截图**:冷启动 15–18s 一次、稳定期 55s 一次。
2. **RTT 对照**:同一页面连续 5 次 `fetch('/api/dsh-perf-hud/host')` 计时(4.0–4.7ms),与面板显示的 `RTT 236.6ms · 存疑` 对照;`__perfHud.link()` 给出全部样本序列。
3. **LoAF 支持与真实条目**:`PerformanceObserver.supportedEntryTypes`;`observe({type:'long-animation-frame', buffered:true})` 收 12–15 秒,打印 `duration / blockingDuration / renderStart / styleAndLayoutStart / scripts[]`。
4. **Event Timing**:同样的 observe(`type:'event'`),确认类型可用、条目数为 0(无交互)。
5. **代码构成**:按 [client.js](client.js) 的分节注释统计行数区间。
6. **官方侧**:`/Users/y/workspace/dsh/deepseek-harness` 的 `package.json` 版本、`packages/client` 目录清单、`grep -rn "data-dsh-plugin|PerformanceObserver|performance.mark"`、`git log | grep -i "perf"`、`.agents/notes/{proposed,implemented,rejected}` 与两个决策记录。
7. **桌面端侧**:`apps/desktop/README.md`(架构与生命周期)、`apps/desktop/src/main.ts` 的 `webPreferences` 与 DevTools 快捷键、`apps/desktop/src/host-process.ts` 的 `spawn`、以及 `grep -rn "contentTracing|getAppMetrics|webContents.debugger|getProcessMemoryInfo" apps packages`(**0 命中**)。本机没有 Desktop 环境,故 §8 的推论均未在 Desktop 上实测。

---

## 8. 桌面端(Desktop):结论会怎么变

**结论:会,而且三个方向同时变大 —— 守夜的价值、取证的能力、撞车的风险。** 以下是官方源码仓 `apps/desktop` 的清单事实,推导出的推论**均未在 Desktop 上实测**(本机没有 Desktop 环境)。

**事实(读源码得到)**

- Desktop 是 **Electron 外壳 + 完整 Web 应用**:Electron 用 `spawn` 起共享 profile 的 Host 子进程,主窗口加载打包好的 Web 入口(`dsh-app://app/`);窗口关闭只是 hide,**页面与 Host 继续跑、任务继续**。
- 主窗口 `webPreferences { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: true }`;官方 README 写明 **F12 / ⌘⌥I / Ctrl+Shift+I 在打包版里也能开 DevTools**(隐藏菜单项),只有更新遮罩与打包的嵌入浏览器 guest 除外。
- 官方**没有使用任何 Electron 级性能面**:`contentTracing` / `app.getAppMetrics` / `webContents.debugger` / `getProcessMemoryInfo` 在全仓 **0 命中**。
- Desktop 的分析字节沿用产品采集策略,**Web usage is excluded**;更新安装会等本地分析 intake(1 秒上限)。

**Electron 侧的 API 已按类型定义核对**(`apps/desktop/node_modules/electron/electron.d.ts`,Electron `^44.0.0`;运行时行为仍未测):

- `webContents.debugger: Debugger`(`attach()` / `detach()` / `sendCommand(method, params, sessionId)`)→ 对真实应用窗口的**完整 CDP**。
- `contentTracing.startRecording(options)` 的 `TraceConfig` 有 `recording_mode`(`record-until-full` / `record-continuously` / **`record-as-much-as-possible`** / `trace-to-console`)、`trace_buffer_size_in_kb`、`trace_buffer_size_in_events`、`included_categories`;`stopRecording(resultFilePath?)` 返回落盘路径;`getTraceBufferUsage()` 给出缓冲区占用(`value` / `percentage`);`getCategories()` 列 category,Electron 另加一个 `electron` category。
- `app.getAppMetrics(): ProcessMetric[]`,每项带 `cpu: CPUUsage` 与 `memory: MemoryInfo`。

**桌面端把"一次抓全"从近似变成真的(这是本次讨论最大的结论翻转)**

- `record-as-much-as-possible` + 固定 `trace_buffer_size_in_kb` **就是 Chromium 级的环形记录器**:一直在录、满了覆盖最早的,触发时 `stopRecording()` 拿到的 trace 正好**结束在触发那一刻**。这正是 §4.1 想要的"前摇",只不过粒度是引擎级的。
- 于是桌面端的事故包能装下 Web 端根本拿不到的东西:一份**真实的 Chrome trace**(Perfetto / DevTools 直接可开)+ 渲染进程 CPU profile(`webContents.debugger` + `Profiler` domain)+ 宿主进程 profile(Host 是 Electron 的子进程)+ **按进程的 CPU/内存**(`getAppMetrics`)。§4.2 那张表里所有"只存在于当时"的证据,在桌面端都有对应的引擎级来源。
- 代价与边界:这几样都是**主进程**能力,所以"守夜"在桌面端要由一个 Electron 侧的组件承担(现有插件形态是 `dsh.bundle.patch` 的 Node 半边 + 浏览器半边,能不能拿到主进程句柄需要另做设计);缓冲占用与采样的常驻开销、category 清单、以及打包版里的可用性都要实测。

**⚠️ 修正:桌面端会同时废掉 in-page 的脚本级归因**

perf-lens 在 `docs/evidence.md` §17 实测:`dsh-app://` 上 `PerformanceObserver` 照常交付长帧(`blockingDuration` 最高 352 ms),但 **`scripts.length === 0` 对每一帧都成立**(900 条长帧样本)。也就是说 **§3.1 那条"用 LoAF 替换调度点插桩"的策略在桌面端不成立**。桌面端剩下的两条路是:

1. **V8 CallSite**(我们现在那条老路):perf-lens 记录到的脚本位置形如 `dsh-app://app/plugins/??<id,id,…>&rev=<rev>:LINE:COLUMN` —— 位置信息在,所以 sourcemap 分段照样能用;
2. **主进程侧取证**(本节的 CDP / `contentTracing`)—— 打包版默认**不带 `--remote-debugging-port`**(只有 `apps/desktop/scripts/dev.ts` 传),所以外部 attach 不可用,只能由 Electron 主进程自己挂。

于是"桌面端更有意义"这句话要说得更准确:**不是"桌面端更好",而是"桌面端把归因预算从 in-page 挪到了主进程"** —— 普通 Web 端靠 LoAF 就能做好脚本级归因,桌面端必须靠主进程 trace,而后者恰好能给出 Web 端永远拿不到的东西(见上一段的 trace + 双 profile + 按进程指标)。

**推论:为什么"有意义"**

1. **守夜形态与桌面生命周期天然吻合**:用户整天开着、关窗不停 —— 偶发卡顿本来就发生在这样的使用里;常驻记录器的边际成本更低、命中率更高。
2. **取证能力升一级**:CDP、`contentTracing`、`getAppMetrics` 都是桌面独有的,展开在上面那一段;其中"按进程的 CPU/内存"还能回答另一个 Web 端答不出的问题 —— **卡的是页面进程还是宿主进程**。
3. **撞车风险同步变大**:官方已内置 F12 DevTools(含打包版)→"随手看一眼"这个需求已经被满足了。DevTools 与守夜记录器的区别是**前者必须先开始录、后者事后能回看**。本工具该占的是 DevTools 抓不到的那部分:偶发、无人值守、跨进程、一次抓全、产出交给 agent 读。

**必须先想清楚的后果与未知**

- **端口不再是 3080**(Desktop 用 OS 分配端口)→ 相对路径的路由不受影响,但任何写死 `3080` 的脚本都不通用。
- **sourcemap 缓存的策略会失效**:Desktop 把插件 bundle 响应标成 `no-store`,且 rev 每次启动都变 → 现在"按 `rev` 缓存那份 12MB map"在桌面端**每次启动都要重拉一次**。长期用就得改成按内容哈希缓存,或改成"只在需要还原某个事故时按需拉一次"。
- **hide 期间的行为要定**:页面 continue,守夜缓冲是否继续、要不要降采样 —— 需实测。
- **两条可达性未验证**:本插件在 Desktop 的 profile 里能否安装;客户端半边只依赖 `slots` / `locale` / React(与 sandbox 约束不冲突),但宿主半边的 `connection.fetch.register` 与 `pluginManager` 在 Desktop 的 Host 子进程里是否同样可达,得实测。

---

## 9. 转向(2026-10-07)

**从"一个四条腿的仪表盘"转向"客户端守夜记录器 + 事故包";面板与隔离实验退到二级。** 依据:生态复核见 [LANDSCAPE.md](LANDSCAPE.md),桌面端与 LoAF 的事实见 §8。

**保留(生态里只有我们有;桌面端 LoAF 失效后更重要)**

- fiber / 子树 / DOM 写入三条腿 —— 唯一在产的 `dsh-perf` 按插件归因坏着,perf-lens 明确不做组件级。
- sourcemap 单包名还原 —— 但降级为"**按需、只还原这一个事故**";默认改用 combo 边界算术(perf-lens 的 `start(i+1)=start(i)+len+2`),算术认不出新格式再退回 map。
- 宿主 event-loop 采样 + bundle 读写代理(带 confirm 安全线)。

**停投(建议,理由在 LANDSCAPE)**

- 隔离实验 → 让给 `dsh-performance-guard`:它的 profile 复制 + 重启 + 配对 CI/Hedges' g 比我们的 A/B/A 硬。本仓改成**交接**:导出可疑集 + 一行可复制的隔离命令。
- 「验收自证」不再占常显区;聚合导出不再当主产物(降为二级概览)。

**明确不做**

- 治理类特性(写批频控、publish gate、`content-visibility` 补丁)—— `dsh-perf` 的地盘。
- bisection 工作流 —— performance-guard 的地盘(perf-lens 也在路线图里明确让给它)。
- 宿主侧每插件 CPU / 堆 / 磁盘 / 进程树 —— perf-lens 的地盘,它已有 always-on JSONL 与进程树。

**唯一新增(三件,全部服务于同一个问题:"我今天用下来,哪一段最卡、是谁")**

1. **客户端守夜层**:帧级环形缓冲 + LoAF + 自动保留最差 N 次;不插桩(§4.1)。
2. **事故包**:`incident.json` + 缺失声明 + 可选 trace / `.cpuprofile`(§4.2)。
3. **桌面端主进程取证**:`contentTracing` 环形 + `webContents.debugger` + `getAppMetrics`(§8)。

**进度(2026-10-07)**

- [x] 第 1 件:客户端守夜层 —— 帧级环形缓冲 + LoAF + 自动留存最差 5 次(`feat(client)`)。
- [x] 第 2 件:事故包 —— `report(id)` / `exportIncident(id)`,含缺失声明与补齐办法;留存的事故落盘(活过刷新),`tools/inspect-incident.mjs` 可把它们渲染成人读的样子。
- [x] 守夜层上到面板(常显一行 + 工具箱清单 + 标记/导出两个按钮 + 折叠药丸上的计数)—— 之前只有控制台 API,等于要求人记得敲命令。
- [x] 常显瘦身:4 块 → 3 块(「帧内未归因」搬进取证明细,数字挂到该组摘要上)。**还没到 §4.4 说的「一行结论 + 时间条」**:那要新做 sparkline,是独立的一步。
- [ ] 第 3 件:桌面端主进程取证(`contentTracing` 环形 + `webContents.debugger`)—— 未开始,需要 Electron 侧载体。

**风险与前提**

- perf-lens 的 **P1 #5「Auto deep-profile on a stall」是同款形态**(宿主侧,排 0.3.0)。→ 不要重复做宿主侧 deep profile;我们要么比它快,要么就站到它旁边只做**客户端那一半 + 跨进程合成**。
- 桌面端要另做 Electron 侧载体(§8),是新工程量,不是改几行。
- 守夜层的成本纪律来自对手的实测:always-on `async_hooks` 在 promise 密集路径 2.3–2.6×(LANDSCAPE §4)。默认模式**只许**挂 rAF + `PerformanceObserver`。
