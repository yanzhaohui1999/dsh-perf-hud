# 2026-10-07 ~ 2026-10-18 验收证据与阶段决策

> 归档:2026-10-18 · 状态:只增不改 · 范围:采集 / 归因 / 守夜 / 诊断包 / 发布
> 本文件是**历史记录**,不是当前行为说明。当前有效的东西见 [REVIEW.md](../../REVIEW.md) 与 [AGENTS.md](../../AGENTS.md)。
> 逐行读数是实测当时的值,采集日期以行内为准,不表示都在小节标题那一天采集。

**为什么合成一份**:按日期拆成六个文件会让 `docs/plans/` 变成第二个需要通读的文档集;这里按阶段分节,只增不改,单文件方便检索也方便整体跳过。

## 2026-10-07 从「归因仪表盘」转向「行车记录仪」

### 1. 起点

第一个提交(`46c4f9d`)是一个「精确归因 HUD」:sourcemap 还原合并包名、fiber 归因、隔离实验、宿主 event-loop。它的前提是**人盯着面板看**。

### 2. 决定

1. 主体改成**默认常开、事后能回看**的记录器:帧级环形缓冲 + LoAF 观察器,自动留存最差几次卡顿。卡顿是偶发的,盯着面板等于永远抓不到。
2. 归因用**四条腿交叉**(fiber / 子树 / DOM 写入 / 包名),不追求单一「根因」;精确归因只在显式打开时拉 sourcemap 分段表。
3. 宿主半只做两件事:事件循环 p50/p99/max 与 bundle 读写代理;不注册服务、不改宿主原型、不写 profile 持久化状态。
4. 明确不做治理类特性、bisection 工作流、宿主侧每插件 CPU / 堆 / 磁盘 / 进程树 —— 生态里已有专门项目,重复做比谁都不做更糟。

### 3. 边界(当时写下,现在仍成立)

- 归因覆盖是**下界**:事件处理器 / Promise / 微任务不在调度点插桩里。
- 命中率会被 **DOM 写入腿抬高**,必须配合名字分布读。
- 隔离实验测的是固定开销,不是因果证明。

### 4. 验收证据

| 判据 | 怎么验 | 实测 |
|---|---|---|
| 守夜层能自动抓 | `__perfHud.watch()` | 真实会话:captured **25** · coalesced 102 · dropped 18 · kept 10 |
| 60 秒帧条与导出件同口径 | 面板 SVG + `tools/inspect-incident.mjs` 的 ASCII | 真实页面 **`width 100%`**(实测 **365×18**,`viewBox 0 0 60 18`)、`errors: 0`,每格都有 `title`(墙钟时间 + 该秒最差帧 + 点得动/点不动);`sparkPickMap` **只有那一秒真的有 LoAF 的格子可点**(点了把翻帧切过去),其余格子不给 `onClick`(不做点了没反应的假按钮);阈值一致性有静态断言(≥100 / ≥50) |
| 记录器自身不冒充元凶 | 面板「归属 Top」/ `blameText` | 真页面:`PerfHud / PerfHudStress` 那条 224ms 长任务改为归到 **`RootEntry`**(真组件);只有记录器自己是唯一候选时才单列「记录器自身 N×」 |
| 记录器自己贵不贵 | 面板「记录器自身」/ `context.recorder` | 真页面读数(本轮 P3 复核):`p99 0.1ms · max 0.2ms · samples 113`(它自己的 rAF 回调,最近 600 帧环形缓冲;更早一次是 `p99 0.1ms · 峰 0.1ms · 样本 167`)。机制由断言钉住(`recordSelf` / `selfStats` / 环形上限 600);这条是**自证**口径,不是页面开销 |
| 压缩名过滤 | `usableComponentName` 断言(传**类**) | `class $c {}` / `class $w {}` → `null`,`class ChatView {}` → 通过,匿名 `class {}` → `null`;`looksLikeInfrastructure('(ChatView)')` 实测 **false**(曾经有"括号名被它挡掉"的错说法,已加断言钉死) |
| 长任务四条腿归因 | `verification()` / 面板 | 真实会话 命中 **35/49** · 组件 35 · 独立包名 **90** |
| 精确归因(单包名) | 打开「深录」后归因表出现单包名 | 2/2 批次分段 ready;线上 sourcemap 58 sections、116 处边界 **0 错** |
| **LoAF 脚本 → 包名** | `incident.packages` / `summary.pkgCoverage` | 实测一次事故 **37/37** 条脚本全部定名(全部 `via: section`),归到 **`@deepseek-ai/dsh-api-gateway`** —— 同一份数据在这条路之前只能显示"58 个包的合并批 URL" |
| 假象能被识别 | `incident.summary.suspectedThrottle` | 真实那次 983.7ms 帧:`worstFrameJs: none` + 前后帧中位 16.7ms → 标成**疑似 rAF 节流**,不冒充真卡顿 |
| 基线可比 | `incident.baseline`(排除本窗口)+ `busyMs` | 真实会话 basline 5156 帧 / 在跑 86s → **60fps**(旧口径会被 22.7s 挂起拉成 43fps) |
| 宿主半可用 | `/api/dsh-perf-hud/host` | 无 cookie **401**;宿主半未加载 **404**;真实会话宿主 p99 **5.72ms** |
| 隔离实验能恢复 | `isolation.restored.ok` | 4 个候选逐项恢复 ✓;窗口含流式时明确写「不可比」且不给结论 |
| 不碰用户环境 | profile diff / `setBundle` 协议 | 未改 `cordis.patch.yml`;无 `confirm` 的 `setBundle` → **400**,前后快照零变化 |

### 5. 后续

- 2026-10-08:把插桩拆成独立开关,「守夜 = 零插桩」从文档变成事实 → 见下一节。
- 2026-10-11:事故逐帧诊断与上下文隔离 → 见本文 2026-10-11 一节。

## 2026-10-08 「守夜 = 零插桩」从口号变成事实

### 1. 问题

在 D1 之前,`start()` 一跑就把 `setTimeout` / `setInterval` / `rAF` 与 `appendChild` / `insertBefore` / `setAttribute` 全包上 —— 文档写的「守夜 = 零插桩」当时**只是文档**。

### 2. 决定

1. 插桩拆进 `applyProbeState()`,只在 `state.deep` 打开时装;深录同时管精确归因(两者是「要抓全」的同一件事)。
2. 开关放**开发者详情的标签页行**与设置页 —— 它是开发者开关,不该占标题栏那一行。
3. 拆解视图按「一张图只表达一个维度」重做:环只画四段(脚本 / 未归到脚本的任务 / 渲染 / 尾部);按来源与按包各一条 100% 堆叠条;两个正交维度做交叉表。
4. 悬停联动**整体停用**(真实鼠标移到交叉表行标签时外壳曾把整个条目停用);点击类交互不受影响。辅助代码一并删除,不留半活的死代码。

### 3. 后果

- 默认 `instrumented: false` / `precise: false`;深录有代价且必须显式打开。
- 折叠组传 thunk,收起时连函数体都不进 —— 面板自己不变成开销。
- 悬停联动若要恢复,必须先能复现原事故(复现配方在渲染区注释里),否则不许写进任何文档。

### 4. 验收证据

| 判据 | 怎么验 | 实测 |
|---|---|---|
| 守夜默认**零插桩** | `snapshot().instrumented` 在三种模式下的取值 | 默认(不插桩)档:`precise: false` / `instrumented: false`,`errors: 0` —— 守夜档仍然零插桩;点「深录」→ `true / true`;点回去 → `false / false`,`errors` 全程 0 |
| 拆解视图(环 / 堆叠条 / 交叉表) | 面板 DOM + `tools/check-panel.mjs` 现场量 | 环 **4 弧**(`viewBox 0 0 84 84` 里 4 个 circle);每个 scope 两条 100% 堆叠条(段 tooltip 形如 `setTimeout 240ms · 100%` / `script 209ms · 47%`);交叉表展开后 4 行 × 5 列,行 `插件批次(未按 sourcemap 拆) 371 …`、`无 URL(内联脚本) 240`、`dsh-client-modules 206`、`其余 70 19`;三处悬停联动 **已停用,而且那套辅助代码已删干净**(`hot` / `setHot` / `hotProps` / `hotStyle` 与各处的 `hot === …` 都不在了;复现尝试与结论见下面「悬停联动:真实鼠标复现尝试」一行);**点击类交互不受影响,已实测正常**;环的 4 条弧 stroke-width 恒 13;**字数**:展开面板 1360 字 / 109 行、`取证明细` 639 字 / 36 行(交叉表展开 896 / 65)。⚠️ 与改造前的 533/32 不能直接比 —— 那是另一次采样(窗口里的名字长度不同),同一份 live 数据下差值在 ±100 字量级;结构性减字是"环里不再有来源名、窗口全纯执行时少一行、其余来源并进条里",而"其余来源"的命名与交叉表表头是**加**的字 |
| 帧拆分:环的四段 + 脚本三种切法 / 两个分母 | 面板 SVG / `frameSplit` / `frameArcs` / `framePkgTally` / `invokerLabel` | 真实页面(**`node tools/check-panel.mjs --expr=…`**,自己造带脚本的 LoAF):环 **84×84**、`viewBox 0 0 84 84`、半径 34;一条只有单个来源的帧画出 **4 个 `<circle>`**(弧长 `175.3 / 35.1 / 0.3 / 0.1`,周长 213.6;颜色 `state-error / label-secondary / state-warn / brand` —— 任务那段是中性灰);六行块式值实测 `纯执行 260.1ms` / `未定名(未归因 1)` / `setTimeout 260ms` / `dsh-client-modules 192ms · 未定名 25` / `DOMWebSocket.onmessage 425ms · setTimeout 421ms · Response.json.then 322ms · 其余 1` / `纯执行 1353.2ms · 强制 6.4ms`;窗口那组的标题自带分母 `窗口:N 条长动画帧 · 跨 T · 平均每条脚本 Xms`(`spanText` 把跨度写成 `43分12秒`);没插桩时 `帧内未归因` 写「要深录」、`命中` 只列非零的腿、`回调归因` 与 `DOM 写入` 两行不渲染;**翻帧按钮真的换帧**(同一次实测:自动 `帧 1/16 · 530ms` → 环 `579.6ms`;按 ▶ → `2/25 · 275ms` → 环 `325ms`;再 ▶ → `3/28 · 170ms` → 环 `220.3ms`;按 ⟲ 回到 `1/… · 530ms`);**清单只收达线的帧**(同一次实测:环里 21 条 LoAF,选单只有 `帧 1/4 · 210ms · ≥100ms`,▶ 走到 `2/4`);`errors: 0`。**函数级的边界也是实测的**:`typeof Profiler === 'function'` 但 `new Profiler()` 抛 `NotAllowedError … disabled by Document Policy`(响应头实测 `null`)。⚠️ 行里"脚本那几段 `stroke-opacity` 递浅"是脚本细分还画在环上时的读数;后来环只画四段,来源/包各自搬成 100% 堆叠条、名次用压暗 overlay(见上一行) |
| 改版后整场深检(一次性 CDP,用完即删、没入库) | 面板 DOM + 真实鼠标 | 5 个组全展开渲染 **0 错误**;真实鼠标移到 5 个行级元素上(按包小表行 / 事故清单行 / 组头)**都没有被外壳停用**,0 错误 |
| 插桩可还原 | `disable()` 后原型比对 | `tests/host.mjs` 有断言钉住 |

### 5. 相关

- 插桩的可还原性由 `tests/host.mjs` 的断言钉住(见本页证据表「插桩可还原」一行)。
- 当前开关位置与代价:AGENTS §0.1 与 README「深录」。

## 2026-10-11 历史事故逐帧诊断:上下文隔离、证据链、回放

### 1. 问题

实时与历史可以共用视觉组件,但**不许共用一个错误的上下文**:以前「取证明细」的帧条与饼图吃实时帧环,事故卡片吃选中事故,于是「上面是历史事故、下面是另一条实时帧」必然出现。

刷新之后更糟:现算证据依赖当前会话的 `state.precise` 与内存缓存,两者都空,存好的包名 / 文件 / 行号会变成 `null` 或「还没预取」。

### 2. 决定

1. 分流只在 `detailContext()` 一处:`live` 只读实时帧环,`incident` 只读事故包;历史那一支不出现 `pickedLoaf` / `scriptPkgTally` / `frameRing`。
2. 选中存 **id 不存下标**(`state.watch.selId`),帧存 **t 不存下标**;被挤出留存清单就退回自动。
3. 证据在**捕获那一刻**写进 `summary.topScripts[]`,面板与「复制摘要」读同一份;老包缺字段才回退现算。
4. 文件与行号是**两个坐标系**,不拼成 `文件:行` —— 合并批只给文件,行号单独写「合并脚本行 N」。
5. 归因三档 `confirmed` / `suspected` / `unattributed`:有 JS 证据**且**定到包才算 confirmed;不把「没有 JS 证据」写成节流结论。
6. 历史帧条按时间切 240 列,每列取最差那一帧,点击 / 选中 / 高亮都映射回 `incident.frames` 的真实记录;整段 rAF 挂起**留白,不补桩**。

### 3. 当时写下的限制(现在仍是边界)

- 一列只有一条柱子能被点;更轻的帧只能 ◀ ▶ 走到。
- 异常帧判据只有帧间隔(≥100ms),不混 LoAF 的 `blocking`。
- 一帧的时间分解只取时间重叠最长的那条 LoAF。
- 原始源码行号、调用栈、函数级耗时仍然拿不到。

### 4. 验收证据

| 判据 | 怎么验 | 实测 |
|---|---|---|
| 事故落盘且活过刷新 | 抓一次 → 刷新 → `watch().restored` | restored **10**;读回条目带 `restored:true`、`env.perfOrigin` 保留,`report()` 跨会话可渲染(184 帧) |
| 留存两档并集 | 塞跨天旧事故 → 刷新 → `watch().kept[].tier` | 15 条旧事故(一天 12 条 + 另外三天各 1 条)→ **restored 13** · tier `{worst 9, daily 3, both 1}`,工具箱清单里「当天最差」出现 3 次 |
| 跨会话基线只进导出件 | `snapshot().context.sessionBaselines` | 一次会话一条(`frames 82 / p50 23.6ms`),`note` 写死「粗参照,不是回归判定」;面板不显示(静态断言钉住) |
| 悬停联动:真实鼠标复现尝试(**2026-10-11,结论:复现不出来**) | 真页面 CDP 探针 | 真实鼠标依次扫过交叉表容器内全部 **163** 个元素(每个元素来回两次)+ 用 JS 直接派发 **153** 次 `mouseover`:面板全程存活、`errors: 0`、环数不变、控制台无输出。所以既不能证明根因、也不能证明已修好 → **保持停用**,并按"不要留半活的死代码"把这套辅助代码**删掉**。踩坑记录:探针的 console 钩子必须装在同一次 `reload` **之后**,否则钩子随旧文档一起被清掉,等于没在监听 |
| 首屏精简(控件按需出现) | 面板 DOM + 条件渲染 | 「全部折叠」只在**有组开着**时渲染(`anyGroupOpen()`);「恢复默认布局」只在 `layoutDirty()` 为真时渲染(有组开着 / 翻帧被钉住 / 手选了事故 / `scope` 不是"最差" / 挂着一次性说明);两者都无意义时**整行不渲染**。「最差事件」行新增**「最近 / 最差」切换**(`state.watch.scope`,默认最差 = 严重度最高),点击清掉手选(`selId`),状态在下行写 `自动·最差` / `自动·最近` / `已选中`,`resetLayout()` 把 scope 归位;没有新增任何排行榜 / 指标卡 / 装饰图。一次性 CDP 深检:全折叠后「全部折叠」消失而「恢复默认布局」仍在(因为还有上下文),恢复默认布局后两个按钮都消失且 scope 归位,全程 0 错误 |
| 事故链:选中 → 定位 → 取证 | `__perfHud.capture()` 造事故 + 面板 DOM | 工具箱清单行可点选 → 清单出现 `●`、首屏「最差事件」块显示「已选中」,0 错误;`revealIncident('i84')` = 选中 + 展开「取证明细」+ 把翻帧钉到该事故开始时刻最近的长动画帧(**限定在事故窗口内** —— 跨会话读回的事故离当前帧环可能几百秒,那时"最近的帧"是无关帧);定位不到会写一句如实说明(`state.pickNote`);选中存 **id** 不存下标(`state.watch.selId` + `selectedIncident()`,默认自动跟严重度最差那条,选中的被挤出留存清单就退回自动) |
| **可疑脚本**:证据 → 代码定位(本轮核心) | 面板「取证明细」组内(组折叠时不算)+ `incident.summary.topScripts[]` | 新增一块,把「事故 → 帧 → 来源 → 包 → 文件:行」落到**个体脚本**:最多 **4** 行(`EVIDENCE_MAX`)、按耗时降序;**只列能定位的行**(函数名 / 包名 / 文件至少有一个,一个都没有的行不占名额);标题写明范围(事故优先 `可疑脚本 · 事故 i84 · 窗口内`,没有事故脚本才退回 `可疑脚本 · 本帧`);每行 `<函数名> @ <包名>` + 毫秒,hover 给完整证据行、**点击复制**「函数 @ 包 · 文件(:行) · 耗时 · 来源」;底下给**分母**(`11条脚本 · 定到包 1/11`,分母按**全部**脚本算 —— 过滤不会把"没定到名"藏起来)+ 口径 + 缺口。真页面(打开「深录」,两张合并批 map 都 ready:58 包 + 16 包):证据行 **4/4** 都拿到 `包 + /plugins/…/client.js + line=text`,**0 错误**;样例行(**本轮口径**:有界面的那一条已拆成文件 + 「合并脚本行」)`函数名未记录 @ dsh-client-connection · /plugins/@deepseek-ai/dsh-client-connection/client.js · 合并脚本行 25580 · 230ms · 来源 Response.json.then · pkg=section line=text`;一条能定位的都没有时整块收敛成一行 `可疑脚本:0 条定到名(窗口内 11 条脚本)· 要深录` + 一行"缺什么"。新管线:`sectionSource` / `sectionIndex` / `sectionPath`、`scriptPosition(url,charPos)`、`scriptEvidence`、`evidenceName/Place/Line`、`incidentEvidenceLines`、`evidenceScope/Footer/ZeroText`、`locatable(rows)`。⚠️ **光有行号不算能定位**:合并批里 charPos → 行号是相对那个几十包合起来的大文件,不知道属于哪个包时它指不出任何可打开的东西(实测非深录档会出现 `line=25580` 而 `pkg` 为 null),所以 `locatable` 只认函数名 / 包名 / 文件 |
| **历史事故的证据:存下来的优先(刷新后逐字一致)** | `incidentScriptEvidence` / `incidentEvidenceAt` + 面板 DOM + 「复制摘要」 | 事故包 `summary.topScripts[]` 在**捕获那一刻**就把 `pkg` / `pkgVia` / `file` / `line` / `lineVia` / `lineScope` / `invoker` 算好写进去了,但面板原先用 `scriptEvidence()` **重新现算** —— 现算吃当前会话的 `state.precise` 与内存里的脚本文本 / 分段缓存,**刷新后两者都空**,存好的定位就变成 `null` / `还没预取`。现在面板(`evidenceScope()`)与「复制摘要」(`incidentEvidenceLines()`)走的是**同一条路**(`incidentScriptEvidence` 存下来的字段优先,老包缺失才回退现算;`incidentEvidenceAt(row, script)` 解 URL 表 + 判断要不要现算),所以不会出现"面板上有、复制出来没有"。真页面 CDP 实测(一次性脚本,用完即删):深录档抓一次(事故包存下 `pkg=section · /plugins/@deepseek-ai/dsh-client-connection/client.js · line 25580 · lineScope=bundle`)→ **把深录与精确归因都关掉**(模拟"换台机器 / 过几天再打开")→ **刷新** → 证据行与刷新前**逐字一致**(照样显示「文件 + 合并脚本行 25580」),`errors: 0`。老包(加字段之前抓的)读回时如实显示 `pkg=precise-off line=text-not-fetched`,不崩、不编 |
| **合并脚本的 file / line 口径拆开(不拼 `文件:行`)** | `scriptEvidence` 的 `lineScope` + `evidencePlace` / `evidenceLine` / `evidenceWhereText` + 静态断言 | 合并批(`plugins/??a,b`)里 `charPos → 行号` 是相对**合并后大文件**的,而 `sectionPath()` 给的是那个包**自己的源文件** —— 两个坐标系拼成 `file:line` 看着精确、实际指不到任何一行。现在 `lineScope` 分三档:`bundle`(合并批)/ `file`(单包 URL、单包组合)/ `null`;`evidencePlace()` 对 `bundle` **只给文件**,行号由 `evidenceLine()` 单独成段写成**「合并脚本行 N」**,`evidenceWhereText()` 在悬停里也分列(文件 · 合并脚本行 N · pkg/line 两个 via 档);口径文案写明**行号是脚本自己的行号,不是原始 TS/TSX 源码行**(要原始源码行得解 section 内层 `mappings` 的 VLQ,本项目没做)。实测:合并批那几行**绝不**出现 `client.js:25580` 这种串;单包 URL 那一行照旧 `client.js:455`(行号确实属于那个文件)。静态断言:合并批不拼 `file:line`、老包缺 `lineScope` 时按 `pkgVia` 现推(`section` ⇒ `bundle`,否则 `file`) |
| **事故回放 · 历史帧时间轴(2026-10-11 起是逐帧诊断)** | 面板「取证明细」的**历史事故**那一支(`replayColumns` / `replayCellTitle` / `replayScope` / `replaySummaryText` / `incidentLoafAt` / `incidentFrameNav` / `detailContext`)+ `tools/check-incident.mjs` | 把**选中的那条事故**那一段窗口画成一条**可点的历史帧条**:数据**全部来自事故包**(`incident.frames` / `incident.loaf` / `summary` / `longTasks` / `urls`)→ **刷新生效、零新增采集**;与实时 60 秒帧条**刻意分开**(各自写明范围,历史那一支连实时帧环都不读)。当前实现覆盖:**点击时间轴里的真实帧**(最多 240 列、每列取该列最差的那一帧,点击映射回包里真实存在的记录,不合成帧)、**选中状态 / 耗时分解 / 关联证据同步更新**(`frameSplit` 的四段 + 与这一帧重叠的 long task + 这一帧自己的脚本证据)、**上一帧 / 下一帧**(按时间序)与**上一 / 下一异常帧**(帧间隔 ≥ 100ms;到不了就**禁用**按钮)、**缺失采样区间留白**(整段 rAF 挂起不补桩)、**刷新后恢复事故与帧的选中状态**(`LS_WATCHUI`)、**返回实时上下文**(实时帧条与实时读数回来、历史块消失)、**不混用实时与历史数据**(历史这一支的任何一个数都不来自实时帧环,分流只在 `detailContext()` 一处)。逐项判据与实测证据见本表下面那七行(上下文隔离 / 帧条映射 / 翻帧与禁用态 / 刷新同帧 / 缺失去向 / 三档归因 / 纯 CSS 悬停)。⚠️ 真实限制:不排**帧内执行顺序**、没有**完整函数级时间轴**;更细的原始数据仍走「导出事故包」+ `tools/inspect-incident.mjs` |
| **「可疑脚本」的正文/悬停分离(2026-10-11)** | 真页面 CDP 探针(临时,用完即删;含整块 innerText 的 markdown 记号计数)+ 两条词典级断言 | 「可疑脚本」底下那一行以前把**口径与缺口两整段**(各两三百字、带 `**` 与反引号)摊在正文里 —— 面板是**纯文本**渲染,那些记号原样显示,一屏全是解释、分母反而找不着(实测被吐槽"这段文字很丑陋")。现在正文只留分母 + 一句提示(实测 `11条脚本 · 定到包 1/11 · 悬停看口径与缺口`,**33 字符、单行**),完整口径/缺口进 `evidenceFooterTitle()` 的 `title`(实测悬停里带 `口径:` 与 `缺:`,与「复制摘要」共用同一份纯文本措辞);整块可见文本里 `**` / 反引号的计数 **0**(实时模式与历史事故模式各扫一遍,扫描范围内还有"展开全部折叠组")。词典级断言:正文文案不许带 markdown 记号,带记号的一律得是白名单里"只进悬停"的那 20 个键,且白名单不许有死键 |
| 「复制摘要」可直接交接给另一个 AI | 工具箱「复制摘要」 | = 结论 + 口径 + 可疑脚本证据行 + 「窗口内 ≥100ms 的交互」(有才写,标明端到端、不拆帧内)+ 缺什么;目的是**能直接交给另一个 AI 接着查** |
| 组合 URL 的"文件路径"不再退化成 `/plugins/` | `scriptEvidence` 断言 + 真页面 | 真 bug:`new URL(url).pathname` 对**组合 URL**(`plugins/??…`)会把第一个 `?` 当成查询串开始,pathname 只剩 `/plugins/` → "文件路径"显示成 `/plugins/`。现在组合 URL 走正则自己拼(单包组合 ⇒ `plugins/<包>/<文件>`);断言里同时钉住 `new URL` 的 pathname 就是 `/plugins/` |
| 合并包分段表三列对齐 | `rows` 一次建成 + 一起排序 | 真 bug:`names` 数组在 `offsets.sort()` 之后**没有跟着排序**(没人读过它所以一直没暴露);加上 `paths` 之后这个错位会变成"包名 A 配文件 B"。现在 offsets/names/paths 一次建成同一张表再一起排序 |
| 可复制 + 只有一个真手型 | 按来源/按包小表行 / 堆叠条色段 | 具名行 **8/8** 有手型(可复制);点一行之后面板仍在、`errors 0`、「已复制」照实显示(`copyText` 成功/失败都照实说);堆叠条色段 **0** 个手型(假按钮已去掉) |
| 帧严重度口径统一 | `frameSeverity(row)` = `max(blocking, dur)`,`worstLoaf` / `loafRanks` / `pickList` 三处共用 | 有一条断言钉住"自动选中的那条一定在翻帧清单里"(旧口径 `worstLoaf` / `loafRanks` 只看 blocking 时会出现标签 `帧 0/N`) |
| 窗口聚合不再冻住 | `scriptPkgTally` 缓存指纹带 `resolveSeq` | 旧指纹只有 `条数\|最后一条 t`,与**异步**到位的 sourcemap 分段表 / 脚本文本无关 → 环满 200 条而一时没有新 LoAF 时,「窗口」三行与「包 × 来源」交叉表会**永久冻在**"插件批次(未按 sourcemap 拆)"(同屏「本帧」行已给真名)。现在每个 `entry.state` 写入后与 `setPrecise` 各推一次(`markResolved()`) |
| 折叠组惰性渲染 | `group(key,label,summary,...children)` + 5 个调用点 | 唯一子节点是函数时折叠连函数体都不进(detail / cross / dom / host / tools 全传 thunk),不再每个 tick 重算派生统计 |
| 严重度两样都给 | `severityLevel` + 首屏「最差事件」块 | ≥200ms `bad`(与面板判色红档同一条线)、≥100ms `warn`(守夜触发线)、其余 `ok`;面板**文字 + token 颜色两样都给**,不只靠颜色 |
| 宿主 event-loop 补 max | 面板 `hostLoopText` | p50/p99/**max** 三个都给(宿主半 `index.js` 早在采 `max`,面板一直没显示);老版本没有 `max` 字段时如实只给 p50/p99,不补 0 |
| 脚本侧按包 | 面板「本帧按包 / 脚本按包·窗口」/ `incident.packages` | 真实页面 **`dsh-api-gateway 881ms · dsh-client-connection 312ms · dsh-client-modules 208ms · 其余 1`**(v0.3.0 实测,当时是窗口聚合那一行);定不到包名的条数会跟在同一行尾巴上(`· 未定名 8`) |
| 交互延迟(页面内那一半) | `snapshot().interactions` / CDP 真实输入 | `state: on`(supported = element + event);一次真实点击 **20** 条入库,`pointerover` 那条 `ms 112 / waitMs 0.3 / handlerMs 0.4` —— 端到端长 ≠ 页面反应慢;`element` 恒 0 并解释原因 |
| 落盘审计属性进导出件 | `snapshot().context.store` | `restored` / `trimmedByBytes` / `deduped` / `captured` / `dropped` 五个键都在(静态断言核) |
| 落盘容量如实 | `watch().trimmedByBytes` / `deduped` | 512KB 上限时真实会话显示「裁掉 6」→ 已提到 **2MB**;同一 id / 同一 `at|cause` 去重后被去掉的条数也单独计数 |
| 事故包可导出、可解析、自描述 | `exportIncident(0)` + `tools/inspect-incident.mjs` | 41KB / schema 2;渲染出 ASCII 帧条带 + longtask / LoAF / 脚本三张表 + 缺失声明 |
| 事故包不虚胖 | 身材回归断言 + 实测 | 同一份内容 URL 抽表前 **116.6KB** → 抽表后 **29.6KB**(导出缩进 138.6 → 51.5KB) |
| **诊断上下文隔离(本轮核心)** | `detailContext()` 单点分流 + 断言 + `tools/check-incident.mjs` | 历史事故那一支的任何一个数都不来自实时帧环:离线断言拿一份**带 432ms 帧的实时环** + 一条**另一条的**事故包,在 `incident` 模式下 `detailContext()` 给出的是事故包那一帧(`kind: incident` / `frame.t = 3000` / `split.total = 984`,都不是实时那条);`live` 模式下反过来只吃实时帧。真页面:详情区第一行是 `历史事故 i1 · 历史帧 41/46`,实时那一侧的选中值与实时采集全程没被动过 |
| **历史帧条:真实帧 + 时间间隔 + 缺口留白** | `replayColumns` / `replayX` / `replayCellTitle` + 真页面 DOM | 240 列、**每列取该列最差的那一帧**,断言"每个非空格子的 `frame` 都在 `incident.frames` 里"(不合成帧);gap 那一段取不到帧、该列为 `gap` 档留白;900 帧的窗口只画 ≤240 个节点。真页面:时间轴在场(11 个可点格子)、点最左那一根就把选中从 `41/46` 换到 `1/46` |
| **逐帧翻帧与禁用态** | `incidentFrameStep` / `incidentFrameBadStep` / `incidentFrameNav` + 真页面点击 | 离线:`上一帧/下一帧` 按时间序、到头停住、`hasPrev/hasNext/hasPrevBad/hasNextBad` 四个方向正确;真页面:`下一帧` 走到 `46/46` 后 **`disabled: true`**(「上一帧」仍可用),`下一异常帧` 落在 `10/46 · 135ms · 警告` 上 |
| **刷新后仍停在同一帧** | `LS_WATCHUI` + `tools/check-incident.mjs` 的 reload | 离线:`saveWatchUI`/`restoreWatchUI` 原样回 `mode/selId/frameT/scope`,落盘的 id 不在清单里 → 退回实时;真页面:刷新前后上下文标题逐字相同(`历史事故 i1 · 历史帧 63/63`) |
| **一帧的分解 / 证据只吃那一帧,缺就是缺** | `incidentLoafAt` / `incidentFrameTally` / `incidentFrameEvidenceRows` / `incidentLongTasksAt` | 离线:没有重叠 LoAF 的那一帧 `split === null`、证据退回**事故窗口内**切片并标 `missing`;long task 只给重叠的;刷新(解析缓存清空)后包名仍是存下来的 `dsh-b`。真页面现场:选中帧没有脚本记录时看到 `这一帧没有脚本记录:下面给的是事故窗口内的切片,不是这一帧的` + `可疑脚本 · 事故 i1 · 窗口内` |
| **归因状态三档(不再把可能写成结论)** | `incidentVerdict` / `verdictColor` / `eventVerdictText` + 断言 | 四条断言:已确认(JS 证据 + 定到包,自带"不等于已定位根因")/ 可疑(JS 证据但没定到包)/ 可疑(满足 `suspectedThrottle` 时写"更像…")/ 未归因(给的是那句校准过的说明);`jsNo` 文案不再出现"更像 rAF 被节流" |
| **纯 CSS 的 hover/focus/disabled(真实鼠标扫过不炸)** | `installStyle()` + CDP 真实鼠标扫场 | 644 个真实鼠标点扫过展开的面板(含取证明细最重的那一支)之后:条目仍活着、`enabled: true`、`errors: 0`;悬停时按钮边框解析到 `--dsw-alias-state-business-primary`(行内样式优先,所以那三条规则用 `!important`)。这是**纯 CSS**,没有任何 per-element 鼠标状态 |

### 5. 相关

- 上下文隔离的现行规则:AGENTS §7「诊断上下文」两条。
- 回放与事故包:README「偶发卡顿:守夜层」。

## 2026-10-12 方案 1:四视图、计数、诊断包与 ZIP

### 1. 问题

一屏堆技术数据,普通用户走不到结论;「留存了几份」被当成「卡了几次」;能力矩阵与缺失说明各写一套。

### 2. 决定

1. **四个视图**:主界面 / 卡顿详情 / 开发者五标签页 / 设置;主界面只回答五个问题,技术数据进开发者详情。
2. 主界面**只读纯函数**(`healthVerdict` / `causeCandidates` / `trendSummary` / `selectedIncident`),界面不做推断。
3. **计数与留存分开**:`triggered` / `coalesced` / `captured` / `dropped` / `trimmed` / `failed`,24h 分钟桶 + 30d 日汇总;被挤掉的卡顿不是没发生。
4. `capabilities()` 是能力状态的**唯一事实来源**;`causeCandidates()` 是「可能原因」的**唯一生成处**,每条都带 `limits`。
5. **诊断包四文件**(manifest / summary / incident / README),五段摘要;两条导出路径只差自由文本;ZIP 用 store-only,零依赖。
6. 脱敏做**减法**:不采聊天正文 / 提示词 / Cookie / Token / 请求头,导出件里没有可脱的凭据。

### 3. 当时的口径

- 检测到 = `triggered`;同串触发 = `coalesced`(密度不是次数);已保存现场 = `incidents.length`;丢失 = (triggered − captured) + dropped + trimmed + failed。
- 折叠药丸显示「检测 N 次」,不是留存份数。

### 4. 验收证据

| 判据 | 怎么验 | 实测 |
|---|---|---|
| 导出件不泄漏凭据 | `tools/check-counts.mjs`(真 location 里塞 `token` / `api_key`)+ 14 条离线断言 | 真页面 `history.replaceState` 塞入 `?token=LEAK_PROBE_12345&api_key=LEAK_KEY_67890` → `snapshot()` 与 `report(0)` 的序列化文本里**两个字符串都不出现**;`page` 只剩 `http://127.0.0.1:3080/`;`context.redaction` 的 applied / kept / neverCollected 三段齐全,口径写着"做减法,不是匿名化" |
| 捕获频次跨刷新、且不虚报 | `tools/check-counts.mjs` + 13 条离线计数断言 | 清桶后手动标记一次:`检测到 3(triggered 3 · 切成现场 2 · 同串触发 29)· 已保存现场 2 · 丢失 1`(同一份现场,旧口径 `captured + coalesced` 会记成 32);刷新后 `triggered` 仍 ≥ 落盘值;折叠药丸显示 `检测 N 次`(不再显示留存份数) |
| 诊断包可交付、且给人看也给 AI 读 | `tools/check-counts.mjs` + 离线断言 | 真页面 `__perfHud.pack(id)` 给出 `manifest.json / summary.md / incident.json / README.md`;摘要五段齐全;`manifest.capabilities.renderer` ≥ 6 个叶子;预览列出 4 个文件与 ≥ 3 条排除项;真 location 里塞过凭据 → **四个文件拼起来一个都不含**;候选原因现场给 `["script","longtask"]`,每条都带支持与限制 |
| 能力矩阵是唯一事实来源 | `tests/logic.mjs`(能力矩阵一节)+ `capabilityMissing` 前缀断言 | 叶子枚举 `state ∈ on/degraded/off/unsupported`、`provenance ∈ measured/inferred/unknown`、`reason` 非空;`unobserved` 单列 GPU 合成 / Electron 主进程 / 原始源码行号 / 帧内顺序 / DevTools trace;`missing` 的 `devtools-trace: / interaction-breakdown: / compositor: / recorder-cost: / baseline:` 五个前缀仍由它推出来 |
| 方案 1 的四个视图都能进、且默认那屏不出现技术术语 | `tools/check-incident.mjs`(真页面)+ 13 条离线断言 | 真页面走一遍:主界面「查看这次卡顿」→ 卡顿详情(标题带视图名 + 「← 返回」)→ 时间轴/翻帧照旧 → 刷新后仍停在同一帧 → 「← 返回」回主界面(该屏**不挂**返回按钮)→ 开发者详情 5 个标签页 → 「回到实时」实时帧条回来 → 设置页三块(记录模式 / 数据保留 / 隐私与脱敏)齐全、深录 `precise: false`。主界面现场文本:`! 刚才有卡顿 · 19 fps` / `0.20 秒` / 可能原因两条(各带支持与限制)/ `4 次卡顿 · 最长一次 205ms · 重复线索:dsh-client-modules(2 次)` |
| 监测不可用不许伪装成正常 | 离线断言(视图模型那一组) | `state.on=false` → `limited` + 原因带"关闭";`loafState='unsupported:…'` → `limited` + 原因带原始状态;`fps 20` 与 `最差帧 130ms` 都判 `stall`(阈值与 `levelFrame` 同源) |
| 最近 ≠ 最差(两个语义分开) | 离线断言 + `tools/check-counts.mjs` | 离线:一条 900ms/10:00 的"最差" + 一条 120ms/12:00 的"最新"放在同一个留存清单里 → `latestIncident()` 取后者、`selectedIncident()` 取前者;空清单给 `null`;静态断言"`mainView` 里不出现 `selectedIncident`"。真页面:主界面的「最近一次卡顿」与开发者详情的「最差事件」各自跟着自己的语义走 |
| 普通用户的原因不出现包名 | 离线断言 + 真页面 | 真页面主界面正文:`某个脚本模块的耗时偏高 · 线索中等` / `这一段时间里有较重的渲染任务 · 线索中等`,正则扫 `@deepseek-ai/` 与 `dsh-` **零命中**;点「为什么这样判断?」之后才出现 `以下是原始证据 … 脚本耗时最高的包 · dsh-client-modules · 出处:归因推断` 与支持 / 限制(含"不等于已定位根因") |
| 两条导出路径只差自由文本 | 离线断言 + 真页面 | 同一份事故:AI 包 `incident.note === null` + `noteDropped: true`、`summary.md` 里也不含备注原文(只写"备注:已置空");完整导出 `note` 保留、但里面那个裸 `token=SECRET_NOTE` 被换成 `token=<redacted>`;`preview().notes` 分别是 `dropped` / `kept`。真页面:主界面「导出诊断报告」→ 预览卡(4 个文件 + 备注已置空 + 生成并导出 / 取消),取消后卡片消失;开发者详情「原始数据」两个按钮文案分别写明"给 AI(脱敏、不含备注)"与"完整技术导出(保留备注)" |
| 界面不会印出词典 key | 离线反向断言 + 真页面逐视图扫 | 新断言:`t('…')` / `translate('…')` 字面量引用的键必须存在于 `DICT.zh` 与 `DICT.en` —— 它**当场抓出 8 个漏掉的条目**(面板上一直印着 `viewIncident` / `exportPreviewCopy` / `packFilesLabel` 等);真页面再按标识符边界扫开发者详情与卡顿详情两屏,零命中 |
| ZIP 一次交给 AI | 离线 11 条字节级断言 + `tools/check-counts.mjs`(真实字节) | 页面里生成的 zip 落盘 → **系统 `unzip -t` 报 `No errors detected`**,`unzip -l` 四份文件齐全;`unzip -p` 读回:`ai 55604B / full 55896B`(差的是自由文本),AI 包 `noteDropped: true` 且两个文件都不含备注原文,完整包保留备注正文但 `token=` 已脱成 `<redacted>`;离线另钉住 CRC32 标准向量与"压缩方式必须是 store(0)" |
| i18n 兜底与词典 | 真实页面 `html[lang]` + 两条断言 | 兜底**跟文档语言**(实测本机 `htmlLang / navLang` 都是 `zh-CN` → 中文);两本字典各 **239** 键、键集合一致、每个键都有人引用(死键会红) |

### 5. 相关

- 实施计划与逐项进度:[2026-10-12-next-phase-plan.md](2026-10-12-next-phase-plan.md)。
- 当前界面结构与口径:README「界面结构」「面板怎么读」,AGENTS §7。

## 2026-10-17 官方开发者工具对照与三条可靠性改造

### 1. 原文(摘自原 REVIEW.md §3.6)

**参考对象**:DSH `0.2.1-rc.1` 的 `@deepseek-ai/dsh-experimental-inspector-profile`(插件管理器官方分组「开发者工具」,默认关闭)。它挂两个插件:

- `NodeJS 诊断`:底部面板内嵌官方 Chrome DevTools(`chrome-devtools-frontend@1.0.1638082`),Worker 监听 `127.0.0.1:9230`,CDP 连 Host;Elements 是 **Cordis 树**,Performance / Memory 采 **Host** CPU / 堆,Network 是 Host fetch 抓包(含密钥、不脱敏);
- `会话数据诊断`:Sidebar tab,原始 session 日志 / chat group-node 树。

**边界(决定它不替代我们)**:Client 侧只有 Console 求值与只读 `lib/client.js` Sources,**没有页面渲染 trace / 堆 / 帧数据**;Performance 只采 Host CPU;界面只有英文;没有帧级留存 / 事故回放 / 事故包。它的强项是"现在为什么慢"的前台检查,我们的强项是"刚刚那一下多慢、是谁、能不能复盘"的常开记录。

| 能力 | 官方开发者工具 | dsh-perf-hud |
|---|---|---|
| 客户端帧 / LoAF / 长任务 / 事件计时 | 无 | 核心 |
| 常开、零插桩、事后回看 | 无(手动打开、实时) | 守夜默认常开 |
| 事故留存 / 逐帧回放 / 事故包 | 无 | 最差 10 + 每天 1,四件套 |
| Host console / 断点 / Sources / 网络 | 有 | 无(刻意不做) |
| Host CPU / 堆 | 有(交互式) | A5 路由可采 CPU,客户端未接线 |
| Cordis 树 / Session 原始日志 | 有 | 无 |
| 中英文 | 英文 | 中英 |

**本轮采纳的三条可靠性规则**(不是抄功能,是抄"记录器"的工程纪律;实现见 AGENTS §7.1):

1. **异步必须有 deadline 与代际**:它每个异步都有 `startupTimeoutMs` / `clientRuntimeTimeoutMs` / `queryTimeoutMs`,而且已关闭的 generation 不许再发布迟到结果。我们的 `hostOp` / `probeLink` / sourcemap / 脚本文本读取原来都没有 `signal`,宿主挂住时面板会一直显示旧数、`text-pending` 会永远停着;`stop()` 也不 abort 在途请求。现在统一走 `fetchTextWithin` / `fetchJsonWithin`,失败只写 `timeout` / `cancelled`。
2. **宿主快照四态**:它断联时保留最后一棵树但加 `disconnected`。我们原来在 `eventLoop` 对象存在、但 ring 还空时会把 `p50/p99` 渲染成 `nullms`,更糟的是 `infraVerdict()` 会在**零样本**时返回「链路已排除」。现在 `live / warming / stale / unsupported` 四态,过期标「Ns 前」,零样本不给正常结论,宿主恢复后重试事件监听。
3. **事故窗口完整性**:它用 `firstSequence` / `expectedSequence` / `droppedBefore` 对不上就要求 resnapshot,不静默接受缺口。我们的 LoAF / longtask 环也会挤掉记录,事故包却只有 `hiddenGaps`(rAF 挂起),没有"采集本身丢了记录"。现在条目带 `seq`,落定算 `expected - kept`,写进 `incident.integrity = { captureComplete, loafDropped, longTaskDropped, reasons }`;不完整时 `missing` 加一行、manifest 标 `complete:false`、面板写「现场不完整」。

**明确不抄**:不内嵌 DevTools / 不连它的 CDP / Worker / 不发布到 `ctx.inspector.publish`(experimental、可选、偏重,会破坏"零运行时依赖 + 默认常开便宜");不做它那 20 多个配置字段;不包 `globalThis.fetch`;不做底部 dock 面板;不把 UI 退成英文单语。它的 Worker 是为了 CDP 状态与 Host 暂停下的调试,我们的宿主探针只有 1 秒直方图 + 一个监听器,加 Worker 只会多一份生命周期债(它自己就记着"没有 Worker 自动重启")。

**本轮顺手落地的三件小事**:

- **快捷键**:`ctx.inject(['shortcuts'], …)` 可选注入,macOS / Windows 绑 `Cmd/Ctrl+Shift+U`;Linux Web 平台白名单只允许极少数组合,不硬塞默认绑定。收起/展开**不抢焦点** —— 实测外壳在键盘命令之后会把焦点还给输入框,硬抢只会让用户丢焦点(所以没有照抄 Inspector 的 focus restore)。
- **map 缓存淘汰**:`MAP_CACHE_MAX = 8` + LRU 索引(`dsh-perf-hud:map:index`);配额失败先淘汰最旧 rev 再重试一次,失败只留内存并记 `mapCache.failed`。内存 `bundleMaps` 同样走 LRU。
- **真事故 fixture**:`tests/fixtures/incident-real.json` 是真页面 `capture` → `report` → 脱敏后的切片(74 帧 / 21 条 LoAF / 2 条 longtask / `integrity.captureComplete=true`);离线套件断言它的形状、完整性字段,以及"不完整现场"时 summary/manifest 的措辞。

**深录 sourcemap 解析实测(决定要不要 Worker)**:在当前构建(17 个 section,不是早期 58 个)上清掉 map 缓存 → `setPrecise(true)` → 等 `bundleMap` ready,整段墙钟 **514ms**(含网络),**没有 >50ms 的 longtask**;所以本轮**不**把解析搬进 Worker。它仍可能随包数增长,后续要动就先重测这一条(阈值:出现 >50ms 的自有长任务)。

## 2026-10-18 0.5.0 发布与对外动作

### 1. 原文(摘自原 REVIEW.md §3.1)

- [x] **仓库转公开 + 加 `dsh-plugin` topic**(§1 #4)—— 已公开,`dsh-plugin` 等 6 个 topic 在场(2026-10-11 实测)。
- [x] **npm 首发** —— 2026-10-11,`dsh-perf-hud@0.4.0` 上线(`latest → 0.4.0`,`npm view dsh-perf-hud version` = `0.4.0`)。**走的是 staged publishing,不是直接 `npm publish`**(上一版本文档写成"本机 `npm publish` 首发",是错的 —— 按下面的实测证据改准)。
  - **证据(2026-10-11 当场查 registry)**:`dist.fileCount` = **18**;`gitHead` = `dbcd8f3404b3b8c8674d1ee3502ff37f6eee8237` = 当时的 `main`;把线上 tarball 拉下来与本机 `npm pack` 对比,**18 个文件逐文件 sha256 全等**;`_npmVersion` = 11.17.0 / `_nodeVersion` = 24.19.0(打包者与我的 11.12.1 不是一套,所以 tarball 的**字节** shasum 不同 —— 字节不同、内容相同,别把 shasum 不等读成"发错东西")。
  - **首发的真实机制(读 npm 11.17.0 的 `lib/commands/publish.js` 得到,不是推测)**:只有 `npm stage publish` 那条路会带 `stage: true` 去发(`if (this.isStage) { … stage: true … }`,成功输出 `+ <id> (staged with id <stageId>)`);`npm publish` 走 `otplease`,会当场要 OTP。而 **stage 一个还不存在的包时,registry 先建一个占位版本 `0.0.0-stage`**(`Temporary package placeholder for staged publishing`,2 文件 / 334B)把包名占住,真版本进 staged 队列,**必须有人用 2FA approve 才公开**([docs](https://docs.npmjs.com/staged-publishing))。所以"首版只能手工"这句要改准:**首版可以自动 stage(stage-only token 都行),但上线前那一次人工 approve 免不了**;**OIDC 直接 `npm publish` 发首版仍然不行**(npmjs.com 要到包已存在才能配 Trusted Publisher,[npm/cli#8544](https://github.com/npm/cli/issues/8544) 仍 open)。`0.0.0-stage` 会一直留在版本列表里(它是 registry 的占位条目,`latest` 已指向 0.4.0,所以不影响安装)。
  - **下一次发版前要做的**:npm 包设置页 → Trusted Publishers → Provider `GitHub Actions`,owner `yanzhaohui1999` / repo `dsh-perf-hud` / Workflow filename `release.yml`,Environment 留空。⚠️ **Allowed actions** 那一栏决定以后走哪条路(文档原话:`npm stage publish` **永远允许**,要不要**同时允许直接 `npm publish` / `npm dist-tag` 要显式勾选**,两项独立):
    - **只勾 staged** ⇒ 每次发版都要你点一次 Approve,而且 `release.yml` 现在跑的是 `npm publish`,会被注册表拒(得改成 `npm stage publish`);
    - **勾上直接 publish** ⇒ 现在的 `release.yml` 原样可用,建 Release 就自动上线。
    ⚠️ 另外,新建配置**必须 2 天内完成一次成功发布**,否则作废且无法编辑 —— 所以配的时机是"接下来两天真的会发一版";给一个**已经在 npm 上**的版本建 Release **不算验证**(工作流会走"跳过发布"那条分支)。
  - `release.yml` 现在对"该版本已在 npm 上"幂等:发布前查 registry,查到就跳过并写 notice(**实测**:给首发那版建 Release,v0.4.0 的 `release.yml` 跑绿,`Check whether…` 步骤 success、`Publish` 步骤 **skipped**);**查询失败照实报错退出**,不猜成"没发过"。
- [x] **0.5.0 发版(2026-10-18)**:`tag v0.5.0` → GitHub Release → `release.yml` 用 **OIDC 直接 publish** 成功(日志 `+ dsh-perf-hud@0.5.0`;registry `dist.attestations` 在场,`latest → 0.5.0`)。Trusted Publisher 配置:**Provider `GitHub Actions` / `yanzhaohui1999` / `dsh-perf-hud` / Workflow filename `release.yml` / Environment 留空 / Allow npm publish + Allow npm dist-tag 都勾**。⚠️ **配置生效之前**,同一条 run 报的是**误导性的 404**(`E404 PUT https://registry.npmjs.org/dsh-perf-hud`,`The requested resource 'dsh-perf-hud@0.5.0' could not be found or you do not have permission`),看起来像包名 / 权限错,实际是 OIDC 对不上 Trusted Publisher;配置生效后**重跑同一个 run** 即绿([npm/cli#9088](https://github.com/npm/cli/issues/9088))。`npm test` **613** 条、`npm pack` **23 个文件**。
- [x] **npm 搜索索引仍缺这个包(2026-10-18 发现)**:registry 与 `maintainer:yanzhaohui1999` 查询都有它,但文本搜索 `/-/v1/search?text=dsh-perf-hud` 翻到 1250 条也没有(同期同量级的 `dsh-token-hud` / 只有 `0.0.0-stage` 的 `dsh-cot-anchor` 搜自己的名字都是第 1 条);npmmirror 的搜索能搜到。0.4.0 时代就这样,0.5.0 正常 publish 后继续观察;48h 不恢复就把这两条证据报 npm support。
  - **结果(2026-10-19 实测)**:搜索索引自行追上 —— `/-/v1/search?text=dsh-perf-hud` 第 1 条就是 `dsh-perf-hud 0.5.0`(`total=23507`),不需要报 support。
- [x] **提收录 PR**(2026-10-18):只提了**一个文件** `data/plugins/yanzhaohui1999__dsh-perf-hud.yml`(category `dev`),PR [awesome-dsh-plugin#7814](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7814);`Submission gate` 与 `check` 已 pass,**2026-10-19 01:29(UTC+8)已合并**(`merged=true`),dsh-market 的每日刷新会带上。

### 2. 当前仍开放的对外项

- **无(2026-10-19)**。上一版列的两条(npm 搜索索引、收录 PR)都已闭环:索引恢复、[#7814](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7814) 已合并。0.6.0 之后重新开始观察。

## 2026-10-18 归档时基线

归档这一刻仍成立、且此后由 CI 每次复跑的几条(它们属于「当前门槛」,不随档案过期):

- `npm test` **613** 条全绿(attribution 11 / logic 561 / host 41);0.6.0 收口时是 **620** 条(11 / 568 / 41)。
- 真页面面板渲染 **0 错误**(`snapshot().errors`);四个验收器 `check-panel` / `check-storage` / `check-interaction` / `check-incident` 全跑过。它们不是离线门禁(要真浏览器 + 本机 `dsh web`),CI 只做 `node --check`。
- `pkgZeroText` 死分支已删、`node tools/dead-code.mjs` **0 个候选**(2026-10-13 审计的结论)。
