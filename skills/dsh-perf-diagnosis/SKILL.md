---
name: dsh-perf-diagnosis
description: 诊断 DeepSeek Harness 的卡顿、掉帧与渲染性能问题。读取 dsh-perf-hud 导出的事故包（manifest.json / summary.md / incident.json），把直接测量、归因推断和无法确认分开，并按包内的缺失声明给出下一步。Use when the user reports lag, stutter, dropped frames, or 卡 and dsh-perf-hud is installed.
whenToUse: 用户说「卡 / 卡顿 / 掉帧 / 不流畅 / 性能」且 dsh-perf-hud 在运行；或用户直接给来 perf-hud-*.zip 或 perf-hud-incident-*.json。
---

# 诊断 DSH 卡顿：从事故包到可验证的结论

你手里只有一份离开现场的导出件。任务不是"猜谁慢"，而是**把这份证据能回答的和不能回答的分开**，再给出下一步最便宜的验证动作。

先记住三件事：

1. **`summary.md` 里的「最可能的假设」是假设，不是判决**。它是插件根据同一份数据生成的摘要；真正的证据在 `incident.json`。
2. **包里的 `missing` 是"这份包缺什么"**，不是"这个功能没做"，也不是"页面没发生"。
3. **"是谁"最多只到"哪个包的哪个文件哪一段"**。原始源码行号、调用栈、帧内执行顺序、GPU/合成拆分都拿不到；没有证据时写"未归因"，不要补一个听起来合理的名字。

## 0. 什么时候用

**适用**：用户说「卡 / 卡顿 / 掉帧 / 不流畅 / 性能」，且 dsh-perf-hud 在运行；或用户直接给来一份 `perf-hud-*.zip` / `perf-hud-incident-*.json`。

**不适用**：插件没装 / 没有事故可读；或者问题明显不在页面主线程（网络瀑布、内存泄漏、GPU / 合成、Electron 主进程）。这些情况先说明边界，再要对应的数据（DevTools trace、宿主 profile、堆快照等）；不要拿这份包硬解释。

## 1. 先拿到数据

### 1.1 最常用：让用户从面板导出

主界面 → 事故行右侧的下载图标 → 先出预览 → 「生成并导出」。两个选项：

- **给 AI**：文件名以 `-ai.zip` 结尾。自由文本（用户自己敲的 `note`）被置空并标 `noteDropped: true`，默认用这个。
- **完整导出**：文件名以 `-full.zip` 结尾。保留自由文本，只用于本机调试；不要默认索要。

如果用户只发来一个 `perf-hud-incident-*.json`，它就是 `incident.json` 那一份，直接读。它没有 `manifest.json` / `summary.md` 外壳。

**隐私**：`-ai.zip` 不含聊天正文、提示词、Cookie、Token、请求头；但仍含页面 origin+path、包路径、视口、浏览器主版本与性能数值。不要未经用户同意上传或转发；需要用户手输的备注时才用 `-full`，并先说明它会保留那些内容。

### 1.2 你（或用户）能在页面控制台取数时

只调用只读 API；不要顺手 `enable()` / `disable()` / `clear()` / `experiment()` 改用户环境。

```js
__perfHud.incidents()        // 留存事故的摘要数组；索引 0 是"最差"，不是"最近"
__perfHud.watch()            // 守夜层状态 + 本次会话计数器（刷新归零）
__perfHud.tally()            // 滚动窗口（默认一天）的检测/保存/丢失计数（跨刷新）
__perfHud.report('latest')   // 完整事故对象；'latest' = 时刻最新
__perfHud.pack('latest', { dropFreeText: true })  // { files, preview }，不下载
__perfHud.preview('latest')  // 只看清单和脱敏声明
__perfHud.exportPack('latest', { dropFreeText: true }) // 下载 -ai.zip
__perfHud.capabilities()     // 当前（或导出时刻）的能力矩阵
__perfHud.causes('latest')   // 候选原因（带支持 / 限制 / 出处）
```

`report` / `pack` 的 `id` 有三种写法：

- 数字：按严重度的下标，`0` = 最差；
- 字符串：事故 `id`；
- `'latest'`：按 `at` 取时刻最新的一条。

⚠️ **`report(0)` 不是"最近一次"**。要最近一次就用 `'latest'`。这是最容易拿错证据的一步。

⚠️ **不带 `{ dropFreeText: true }` 的 `report()` / `pack()` / `exportPack()` 会保留用户备注**（`exportPack()` 不带参数还会下载 `-full.zip`）。要转述或外发，一律显式传 `true`。

如果页面里没有 `window.__perfHud`：插件没装、没加载，或页面还没跑过 `apply()`。直接说"没有数据"，不要用常识补一份诊断。

### 1.3 没有事故可读时

让用户复现一次，然后手动标记：`__perfHud.capture('note')`。它会回看最近一段窗口并新增一条事故。**先征得用户同意**，因为这会改变留存清单。

不要默认索要整机 `snapshot()`：它更大，而且很多字段（DOM 趋势、链路、插件表）不属于这一条事故，混读会误导。

## 2. 包里有什么，先读哪一份

`-ai.zip` / `-full.zip` 固定四份文件，按这个顺序读：

| 顺序 | 文件 | 用途 |
|---|---|---|
| 1 | `manifest.json` | 入口：格式版本、完整性、采集档位、能力矩阵、脱敏声明 |
| 2 | `summary.md` | 人读摘要，固定五段：摘要 / 最可能的假设 / 缺失的证据 / 下一步验证 / 元信息 |
| 3 | `incident.json` | 结构化原始证据（与 `report(id)` 同一份） |
| 4 | `README.md` | 这份包是什么、隐私口径；通常可以跳过 |

`summary.md` 的语言跟随页面语言（中文或英文）。每条假设都带「支持 / 限制 / 出处」三行；**读完摘要仍要回 `incident.json` 核对**，因为摘要可能比原始字段更"顺"，但不会多出证据。

### 2.1 `manifest.json`

| 字段 | 含义 | 读的时候注意 |
|---|---|---|
| `kind` | 固定为 `dsh-perf-hud-diagnostic-pack` | 不匹配就不是本插件的包 |
| `schemaVersion` | 诊断包格式版本 | 本技能按 2 写；文件里更高就先说明版本差异，不要猜新字段 |
| `complete` | `true` / `false` / `null` | `false` = 采集丢过记录；`null` = 老包没有 `integrity`，**不知道**，不要当完整 |
| `captureTier` | 导出时刻的 `watch` / `deep` | 不是事故当时的档位；事故当时看 `incident.env.deep` / `precise` / `instrumented`。深录档通常同时打开精确归因，但包名 / 文件 / 行号到底有没有，最终看 `pkgVia` |
| `range` | 事故窗口与前后摇 | 与 `incident.window` 对得上 |
| `incident` | 条数摘要（frames / loafEntries / longTasks / interactions / integrity） | 只是计数，不是结论 |
| `tally` | 导出时刻的滚动计数 | **不属于事故窗口**；实际范围看 `windowMs` / `coveredFrom` / `coveredTo` |
| `capabilities` | 导出时刻的能力矩阵 | 不是事故那一刻的状态；采集档位看 `incident.env.precise` / `instrumented` / `deep` |
| `notIncluded` | 这份包**不含**什么 | 与 `redaction.neverCollected` 同一类声明（措辞不完全相同） |
| `redaction` | `applied` / `kept` / `neverCollected` / `freeText` | 是"减法"，不是"已匿名化" |
| `files` | 包内文件顺序 | 应与真实顺序一致 |

### 2.2 `incident.json` 顶层

| 字段 | 含义 |
|---|---|
| `kind` | `perf-hud-incident` |
| `schema` | 事故包 schema；本技能按 3 写（3 = 带 `incident.integrity`） |
| `exportedAt` | 导出时刻，不是事故时刻 |
| `context` | 事故的"口径与缺口"：`page` / `scenario` / `watch` / `tally` / `sessionBaselines` / `recorder` / `thresholds` / `missing` / `howToAdd` / `howToRead` / `redaction` |
| `incident` | 结构化证据本体，见下 |

**时间基准不要混**：

- 事故当时：`incident.at`（墙钟）、`incident.atPerfMs`（perf 毫秒）、`incident.window`、`frames[].t`、`loaf[].t`、`longTasks[].at`；
- 导出时刻：`manifest.exportedAt`、`manifest.captureTier`、`manifest.instrumented`、`context.tally`、`context.recorder`、`manifest.capabilities`、`context.sessionBaselines`。

例如：`context.recorder` 是导出时记录器自己的开销，不是事故那一刻的开销；`manifest.capabilities` 反映导出时的采集层状态，不代表事故当时——采集档位看 `incident.env.precise` / `instrumented` / `deep`。

**`context` 里有两套计数，不要混用**：

| 字段 | 时间窗口 | 含义 |
|---|---|---|
| `watch.captured` / `coalesced` / `dropped` / `restored` / `trimmedByBytes` / `deduped` / `persistError` | 本次会话，刷新归零 | 采集器的内部计数 / 落盘状态；`coalesced` 是同一串触发的密度，不是次数 |
| `tally.detected` / `triggered` / `captured` / `coalesced` / `unsettled` / `kept` / `lost` / `dropped` / `trimmed` / `failed` | 最近一段滚动窗口（`windowMs`），跨刷新 | 发生频次；`detected = triggered`，`unsettled = triggered - captured`，`lost = unsettled + dropped + trimmed + failed` |
| `watch.kept[]` | 当前留存清单 | `id` / `severity` / `cause` / `at` / `tier`；受容量限制，不是发生次数 |
| `tally.windowMs` / `tally.coveredFrom` / `tally.coveredTo` | 导出时刻的实际窗口 | 边界落在分钟桶上；写范围时用它，不要吹成"正好 24 小时" |

`context.thresholds` 给出这份包的判据（触发线 / gap 线 / 前摇后摇 / 留存上限 / 手动回退）。**不要背固定数值**；引用"超过阈值"时用它。

`context.sessionBaselines` 是跨会话的帧分布（每个会话一条），只是粗参照，**不是回归判定**；同一会话内的对照看 `incident.baseline`。

### 2.3 `incident` 本体

| 字段 | 是什么 | 注意 |
|---|---|---|
| `id` / `cause` / `severity` | 编号 / 哪个检测器先触发 / 触发时刻的严重度 | `cause` 是 `frame` / `loaf` / `manual`，是**触发器**，不是根因；`severity` 取触发严重度与窗口最差帧的较大者，不是平均 |
| `at` / `atPerfMs` | 触发的墙钟 / perf 毫秒 | 帧的墙钟 ≈ `at + (frame.t - atPerfMs)` |
| `window` | `fromMs` / `toMs`（perf）+ `from` / `to`（墙钟）+ `preMs` / `postMs` | 事故窗口不是固定长度；读这里的值 |
| `integrity` | `captureComplete` / `loafDropped` / `longTaskDropped` / `reasons` | `false` 时仍是一份真实切片，但不能当完整窗口 |
| `summary` | 汇总读数，见下 | 这一层不做推断 |
| `urls` | 脚本 URL 字符串表 | 当前包用 `loaf[].scripts[].u` 当下标；老包可能内联 `url` |
| `packages` | 按包汇总的脚本耗时，降序 | 只含**定到包名**的脚本；先看 `summary.pkgCoverage` 的分母 |
| `frames` | 窗口内帧记录 | 见下 |
| `loaf` | LoAF 长动画帧条目 | 与 `frames` 是同一信号的两个视图 |
| `longTasks` | 窗口内的 long task 明细 | **不是慢帧清单** |
| `interactions` | 窗口内 ≥阈值的事件计时 | `ms` 是端到端，不是帧内拆分 |
| `baseline` | 排除本窗口后的帧分布 | 可能是 `null`（旧包 / 还没铺满） |
| `host` | 宿主事件循环快照 | 周期性采样，未必覆盖卡顿瞬间 |
| `env` | 采集档位与渲染环境 | `precise` / `instrumented` / `deep` 是**事故当时**的档位 |
| `tier` / `kept` | 为什么被留存 / 留存结果 | 不是质量分，也不是发生次数 |

### 2.4 帧、LoAF、long task、交互

**`incident.frames[]`**：`{ t, ms, gap }`

- `t`：perf 毫秒；`ms`：帧间隔（这一帧距上一帧多久，不是"页面忙了多久"）；
- `gap: true`：rAF 被挂起（标签页隐藏、系统休眠、浏览器节流）。**不是卡顿**，不参与 `summary` 的分位与最差帧；
- 空白 / 缺记录：没采到，**不是 0**。

**`incident.summary`** 的关键字段：

| 字段 | 含义 |
|---|---|
| `frames` / `hiddenGaps` | 有效帧数（不含 gap）/ gap 条数 |
| `framesOver50Ms` / `framesOver100Ms` | 超过 50ms / 100ms 的有效帧数 |
| `worstFrameMs` / `worstFrameAt` | 窗口最差帧的帧间隔 / 墙钟 |
| `p50` / `p90` / `p99` | 有效帧间隔的分位；与 `baseline` 比才有"比平时差多少" |
| `loafEntries` / `blockingMs` | LoAF 条数 / 窗口内累计 blocking（**可以很低甚至为 0**） |
| `pkgCoverage` / `pkgVia` | 有包名的脚本数 / 总数；`pkgVia` 是按 via 分类的计数 |
| `longTasksInWindow` / `interactionsInWindow` | 窗口内 long task 条数 / 交互次数（都不是慢帧数） |
| `worstFrameJs` | `js` = 有 longtask / LoAF 与最差帧重叠；`none` = 没有任何 JS 解释 |
| `worstFrameNeighboursMs` | 最差帧前后若干帧的中位；健康时接近显示刷新间隔（60Hz 约 16.7ms） |
| `suspectedThrottle` | 更可能是 rAF 被节流 / 挂起，而不是页面忙 |
| `streaming` / `visibility` | 当时是流式还是空闲 / 页面可见性 |

**`incident.loaf[]`**：LoAF 条目。`t` 是开始 perf 毫秒，`dur` 是总时长，`blocking` 是 blockingDuration，`renderStart` / `styleAndLayoutStart` 给出帧内三段的大致位置，`scripts[]` 是这条 LoAF 归到的脚本。

**`incident.loaf[].scripts[]`**：

- `ms`、`fn`、`invoker`、`invokerType`、`charPos`：LoAF **直接给的**，属于测量；
- `pkg` / `file` / `line` / `pkgVia` / `lineVia`：由 URL、sourcemap 分段表、脚本文本**推断**；
- `u` 是 `incident.urls` 的下标，`u = -1` 表示没有 URL；
- `line` 是**脚本文本自己的行号**，不是原始源码（TS/TSX）行号；合并批里它属于合并后的大文件；
- `forcedMs` 是脚本耗时里"强制样式布局"的部分，**已经算在 `ms` 里**，不要相加；`pauseMs` 同理，是脚本内部的暂停；
- `pkgVia` 常见值：`url`（单包 URL 直读）/ `section`（分段表算出来）/ `precise-off`（精确归因没开）/ `text-pending`（文本还没拉到）/ `not-plugin`（宿主 / 应用外壳，不属于插件）/ `out-of-range` / `map-pending` / `map-failed` 等。

**`incident.summary.topScripts[]`**：同一批脚本按耗时取前几条的副本；字段与 `loaf[].scripts[]` 相同（另有 `at`）。面板与摘要里的「可疑脚本」读的是这一份。

**`incident.packages[]`**：`{ pkg, ms, count }`。`ms` 是这些脚本的累计耗时，`count` 是脚本条数（不是帧数）。只含定到包名的脚本；应用外壳（`not-plugin`）与没定到名的脚本都不在列表里，所以**合计 ≤ 脚本总耗时**，覆盖率在 `summary.pkgCoverage`。

**`incident.longTasks[]`**：`{ seq, t, at, ms, owner, component, subtreeComponent, domComponent, source }`

- `owner` = 调度点插桩给的包名；`component` = fiber 上溯的组件名；`subtreeComponent` / `domComponent` 是另外两条腿；`source` 说明这条靠哪条腿定出来的；
- 四条腿（调度点 / fiber / 子树 / DOM 写入）覆盖的是**下界**：事件处理器、Promise、微任务不在调度点插桩里；
- 命中率会被 DOM 写入腿抬高，必须配合名字分布读；
- `longTasks` 条数通常**远少于**超线帧数，不能拿它当"卡了几次"。

**`incident.interactions[]`**：事件计时。`ms` 是端到端（到下一次渲染更新），`waitMs`（输入延迟）与 `handlerMs`（处理器本身）是**推导值**，原始字段 `processingStart` / `processingEnd` 也在。`isInteraction: true` 才是 `interactionId > 0` 的真交互；`pointerover` 这类被动事件也会进来。**不拆帧内**（输入延迟 / 处理 / 呈现要去 DevTools 的 Interactions 轨道看）。

**`incident.baseline`**：排除本窗口之后的帧分布（`p50` / `p90` / `worstMs` / `frames` / `spanMs` / `busyMs` / `fps`）。

- `null`：没有可比基线，只能报绝对值；
- `frames` 很少（刚刷新）：倍数不可信，明确说出来；
- `spanMs` 横跨很久：中间有 rAF 挂起 / 后台时段，它是"这台机器这些帧的样子"，不是一段连续观察。

**`incident.host`**：`eventLoop.p50/p99/max` + `snapshotAgeMs`。正数 = 快照在事故**之前**采的，负数 = 事故**之后**才采到。宿主快照不是事故瞬间的连续采样；`null` 表示没有宿主数据。

**`incident.env`**：`instrumented` / `deep` / `precise`（事故当时的档位）、`perfOrigin`（perf → 墙钟）、`utcOffsetMin`（本地时区偏移）、`viewport` / `devicePixelRatio` / `hardwareConcurrency`、`domNodes` / `heapUsedBytes`、`visibility`。

### 2.5 `capabilities`：哪一层采到了

`capabilities` 在 `manifest.json` 里（也在 `__perfHud.capabilities()`），**不在** `incident.json` 里。只拿到单份 `incident.json` 时，用 `context.missing` + `incident.env` 还原档位。

形状：

```
renderer: frames / loaf / longTasks / scriptAttribution / domWrites / interactions / elementTiming
host:     eventLoop / events / cpuProfile
link:     rtt / throughput
unobserved: [ { id, reason } ]
```

每个叶子是 `{ state, provenance, reason }`：

- `state`：`on` / `degraded` / `off` / `unsupported`。说的是**采集层**，不是页面健康度；`off` 不等于"没发生"，`degraded` 不等于"数据是假的"；
- `provenance`：`measured`（直接测量）/ `inferred`（归因推断）/ `unknown`（证据不足）。它告诉你这条能力本身属于哪一档，不自动等于每个字段的档位；
- `reason`：给用户看的原因，通常已经能回答"为什么没采到"；
- `unobserved`：工具**结构上**看不到的东西（GPU/合成、Electron 主进程、原始源码行号、帧内顺序、完整 Chrome trace）。不要用它们的缺席反推"这件事没发生"。

### 2.6 `missing` / `howToAdd` / `howToRead`

`context.missing` 是**字符串数组**，大多数行形如 `前缀:说明`。前缀是类别，不是错误码。它回答的是"这份包缺什么"，可能是下面五类之一：

| 类别 | 例子 | 读法 |
|---|---|---|
| 平台 / 浏览器不支持 | `loaf:`、`interaction-timing:`（unsupported） | 这一层本来就没有，换数据源（longtask / DevTools） |
| 没开 | `precise:`、`instrumentation:`、`interaction-timing:`（off） | 下一次按 `howToAdd` 开对应档位再抓；**这一条补不了** |
| 这个窗口没发生 / 没到阈值 | `loaf-scripts:`（这一帧没有脚本）、`interaction-timing:`（窗口内 0 条） | 不是故障，也不等于"没有 JS / 用户没操作" |
| 结构上不采 | `devtools-trace:`、`compositor:`、`interaction-breakdown:`、`element-timing:`（DSH DOM 上没有 elementtiming，恒 0）、`baseline:`（跨机器 / 跨浏览器基线） | 要这些只能走 DevTools / Chrome trace / 别的机器；别假装包里有 |
| 采集丢了 / 还没采到 | `window-integrity:`、`recorder-cost:`（`samples = 0`）、`host:`（没有宿主快照）、`host-snapshot:`（有快照，但采在事故之前 / 之后，未必覆盖卡顿瞬间）、`loaf-pkg:`（这几条脚本没定到包名，冒号后是没定到的原因分布）、`host-cpuprofile:`（没自动采） | 这一条的证据不完整；`recorder-cost` 的 0 是"空"，不是"零成本" |

> ⚠️ 这张表与客户端 `capabilityMissing()` 生成的前缀**由一条离线断言钉住**（`tests/logic.mjs`
> 的「缺失声明的前缀集合与诊断 Skill §2.6 的前缀表一一对应」）：客户端改措辞 / 换前缀 / 加新前缀时，
> 这里没跟着改，`npm test` 会红。反过来说，读包时看到的每一个前缀都该在这张表里找得到 ——
> 找不到的那个是**新版本**的前缀，按冒号后的说明读，别硬套旧类别。

同一个前缀可能落在不同类别：`interaction-timing:` 可能是浏览器不支持、观察器没开，或只是这个窗口里没有达到阈值的事件。**必须读冒号后的说明**，不能只看前缀。

`context.howToAdd` 是一组补齐办法（不逐条对应）；`context.howToRead` 是包里自带的读法说明，**先通读一遍再下结论**。两者都可能随版本增减，按"前缀冒号前的类别"读，不要背全表。

深录没开时，`capabilities.renderer.domWrites` 会是 `off`，但 `missing` 里不一定有一行专门的 `instrumentation:`（那一行只在 HUD 本身关闭时出现）。所以"没开"也可能只体现在能力矩阵与 `incident.env` 里。

## 3. 判读口径：测量 / 推断 / 未知

| 档位 | 典型字段 | 怎么用 |
|---|---|---|
| **直接测量** | `frames[].ms`、`loaf[].dur`、`loaf[].blocking`、`scripts[].ms` / `fn`、`interactions[].ms` / `processingStart` / `processingEnd`、`host.eventLoop`、各种计数 | 可以作为事实陈述；仍要说明单位和时间基准 |
| **归因推断** | `scripts[].pkg` / `file` / `line` / `pkgVia` / `lineVia`、`packages`、`summary.worstFrameJs`、`summary.suspectedThrottle`、`interactions[].waitMs` / `handlerMs`、`causeCandidates` 的名字与强度、`baseline` 的倍数比较 | 说"推断 / 更像 / 线索"，并给出限制；不要升级成"根因" |
| **无法确认** | 根因、帧内执行顺序、GPU / 合成 / 光栅占比、原始源码行号、调用栈、函数级耗时、完整 Chrome trace | 直接说"拿不到"；给需要什么数据才能确认 |

一条快速判断：**如果这个结论需要 URL 解析、sourcemap 分段、时间重叠判断、采样折算或阈值判断，它就是推断；只有直接来自观察器 / 计数器 / LoAF 的数值才是测量。**

`frames[].gap` 是按 `context.thresholds.gapMs` 对帧间隔做的规则判定，不是独立观测；它仍然可靠，但要知道它是分类结果。

几条硬规矩：

- **`packages[0]` 不是"元凶"**。脚本毫秒是测量的，包名是推断的；先看 `pkgCoverage` 的分母与 `pkgVia`。第一名只是"定到包名的脚本"里最大的——应用外壳（`not-plugin`）与没定到名的脚本都不在 `packages` 里，合计会小于脚本总耗时。
- **`blocking = 0` 不等于没卡**。blocking 只累计被归因到的 >50ms 长任务；帧间隔仍可能很长。严重度取 `max(blocking, 帧间隔)`，不是只看 blocking。
- **`loaf` 与 `frames` 不能相加**。它们是同一信号的两个视图（LoAF 的 `t + dur` 落在某一帧上），不是两份独立证据。
- **`gap` / 空白不等于卡顿**。`gap` 是 rAF 被挂起；空白是没采到。
- **`longTasks` 不是慢帧清单**。条数通常远少于超线帧；它回答"谁在调度点 / fiber / DOM 写入上被看到"，不回答"卡了几次"。
- **`context.tally` 的滚动窗口不是这一段的次数**。`detected` 是检测到，`kept` 是保存的现场（受容量限制），`lost` 是丢失；三者不能互相替代。
- **`coalesced` 不是卡顿次数**。它数的是同一串触发里被并掉的触发数（密度）；把 `detected` 和它相加会把一次停顿记成十几次。
- **`context.recorder` 是记录器自己的开销**，不是页面开销；`samples = 0` 表示还没采到，不是 0 成本。
- **`summary.md` 的假设不是判决**。每条假设都自带限制；没有额外证据时，不要替它下"根因"。

## 4. 三步诊断流程

### 第一步：这一段到底多糟

先回答"值不值得继续"，再回答"是谁"。

1. 读 `manifest.complete`（如果有）和 `context.missing`：这份证据能不能用？缺的是哪一类？
2. 读 `incident.window`、`summary.frames` / `hiddenGaps`：窗口多长，有效帧多少，gap 多少；空白是没采到，不是 0。
3. 读 `summary.p50` / `p90` / `p99` / `worstFrameMs` 与 `incident.baseline`：
   - 基线存在且够厚：比较 `summary.p50` 与 `baseline.p50`（慢性劣化）以及 `summary.worstFrameMs` 与 `baseline.worstMs`（单帧尖刺）。两条要分开说，不要只拿最差倍数下结论。
   - 基线是 `null`、帧数很少、或横跨很久：明确写"没有可比基线 / 倍数不可信"，只报绝对值。
4. 读 `context.tally`：最近这段窗口里是偶发还是变频繁？`detected` / `kept` / `lost` 三个数分开说；`kept` 少不代表只发生了几次。
5. 读 `incident.env`：当时 `deep` / `precise` 是否开着，页面是否可见。档位决定了"谁"能细到什么程度。

**这一段能回答**：这次是不是真的异常、是单帧尖刺还是整段劣化、最近是否变频繁。
**这一段不能回答**：是谁。不要在这一步就点包名。

### 第二步：落到帧和"谁"

1. 在 `incident.frames` 里找最差帧（或直接信 `summary.worstFrameMs` / `worstFrameAt`），确认它没有 `gap`。
2. 看 `summary.worstFrameJs`：有 `js` 说明有 longtask / LoAF 与这一帧重叠；`none` 说明没有 JS 解释，接下来要么是节流/挂起，要么是未观测层，别硬指一个包。
3. 看 `incident.loaf` 里与这一帧重叠的条目（重叠 = `loaf.t < frame.t` 且 `loaf.t + loaf.dur > frame.t - frame.ms`）：`dur`、`blocking`、`renderStart` / `styleAndLayoutStart` 的三段，以及 `scripts[]` 的 `ms` / `fn` / `invoker`。
4. 看 `incident.packages` 与 `summary.pkgCoverage`：
   - 覆盖率低时，先写"只定到 N/M 条脚本"，不要把第一名当全部；
   - 逐条核对 `loaf[].scripts[]` / `summary.topScripts[]` 的 `pkgVia`：`precise-off` / `text-pending` 不是包名，是"没定到"；
   - `not-plugin` 是宿主 / 应用外壳，不是插件。
5. 看 `incident.longTasks`：`owner` / `component` / `subtreeComponent` / `domComponent` 分别是哪条腿，`source` 说明这条靠哪条腿定出来的。同一个名字命中多条时，次数要数**条数**，不是数不同名字的个数。
6. 看 `incident.host`：`eventLoop.p99` 高不高，`snapshotAgeMs` 是事故前还是事故后。快照过期或没有快照时，不能写"宿主没问题"，也不能写"宿主就是元凶"。
7. 看 `incident.interactions`：窗口内有没有 ≥阈值的交互；`ms` 是端到端，不要拆成帧内三段。

**这一步的产出**：一条（最多两条）候选，每条都带：
`名字` + `毫秒` + `来自哪个字段` + `是测量还是推断` + `覆盖率/限制`。
没有候选就写"未归因"，并说明缺哪一层。

### 第三步：说清"不知道"，给下一步

1. 把 `context.missing` 按 §2.6 分类，挑出**影响当前结论**的几条，不要整段复述。
2. 读 `capabilities.unobserved`（manifest 里有；只有单份 `incident.json` 时用 `context.missing` 里的结构性缺口代替）：如果问题可能落在 GPU / 合成 / Electron 主进程 / 帧内顺序，直接说"这份包看不到"，不要用"没有证据"反推"没有问题"。
3. 按缺口给最便宜的下一步：
   - `precise` 没开 → 开深录 / 精确归因，复现后再抓一份；
   - `loaf` 不支持 / 没有脚本级归因 → 用 longtask 明细 + DevTools Performance 录制；
   - 怀疑合成 / 光栅 / GPU → Chrome trace 或 DevTools Rendering；
   - 怀疑宿主 → 用插件自带路由采宿主 CPU profile，或在宿主侧用 `node:inspector`；
   - `window-integrity` 不完整 → 下一次卡顿前不要刷新 / 不要触发 HMR，再抓一份；
   - 最差帧 `none` 且 `suspectedThrottle` 为 false → 标"未归因"，要 Chrome trace 才能继续。
4. 给结论加置信标签：**已确认**（测量一致且覆盖充分）/ **可疑**（推断，有支持也有限制）/ **未归因**（证据不足）。不要写"根因是…"。

## 5. 输出模板

```text
结论：<一句话；标明 已确认 / 可疑 / 未归因>

这一段是什么：
- 场景 / 时间 / 窗口 / 有效帧 / gap
- p50 / p99 / 最差帧；与 baseline 比是尖刺还是慢性（没有基线就直说）

测量到的：
- <字段> = <值>（单位）
- <字段> = <值>（单位）

推断的（带限制）：
- <包 / 脚本 / 组件>：<毫秒>，来自 <字段>；覆盖率 <N/M>；<pkgVia 说明>
- 限制：<覆盖率不足 / 只是时间重叠 / 快照过期 / 没有帧内顺序 …>

这份包缺什么：
- <missing 类别 + 影响结论的几条>
- <integrity / complete 的状态>

下一步：
- <最便宜的验证动作；需要用户做什么；预计能补上哪一条缺失>
```

写法要求：

- 数字带单位；时间说明是墙钟还是 perf 毫秒；
- 每个"谁"都能指回字段；指不回去就不写；
- 不把 `summary.md` 的措辞当证据；不改写成"根因"；
- 证据不足时，宁愿只给"这一段多糟 + 缺什么 + 下一步"，也不要凑一个名字。

## 6. 常见误判

| 你看到的 | 不要读成 | 正确读法 |
|---|---|---|
| `context.watch.coalesced` 很大 | "发生了很多次卡顿" | 它是同一串触发里被并掉的次数（密度）；次数看 `tally.detected` / `tally.triggered`，保存的现场看 `tally.kept` |
| `loaf[].blocking = 0` | "这一帧没卡" | blocking 只累计被归因到的长任务；帧间隔仍可能很长，严重度取 `max(blocking, 帧间隔)` |
| `frames[].gap = true`、空白 | "卡了很久" / "没卡" | `gap` 是 rAF 被挂起（隐藏 / 省电 / 切后台），不算卡顿；空白是没采到，不是 0 |
| `longTasks.length` 很少 | "只卡了几次" | long task 是 >50ms 的任务，不是慢帧清单；条数通常少于超线帧 |
| `packages[0].pkg` 是某个包 | "它就是元凶" | 先看 `pkgCoverage` 分母与 `pkgVia`；第一名只是"定到包名的脚本"里最大的，应用外壳与未定名脚本不在 `packages` 里，合计 ≤ 脚本总耗时 |
| `missing` 里有 `devtools-trace` / `compositor` | "这个功能没做" / "页面没发生" | `missing` 是"这份包缺什么"；分没装 / 没开 / 没触发 / 结构上不采 / 采集丢了五类，读冒号后的说明（能力矩阵里的对应叶子才有 `reason` 字段） |
| `summary.worstFrameJs = "none"` | "一定是浏览器节流" | 只有 `suspectedThrottle: true` 且前后帧健康才更像节流；否则可能是合成 / GPU 等未观测层，标"未归因" |
| `summary.md` 写了"最可能的假设" | "已经定位根因" | 它是候选，每条都带限制；根因需要额外证据，包里没有 |
| `baseline` 只有几十帧 / 跨了很久 | "比平时慢 ×N" | 薄基线或跨挂起的基线，倍数不可信；看绝对值，或等更长的基线 |
| `context.recorder` 有 p99 | "页面开销" | 记录器自己的 rAF 回调开销；`samples = 0` 是"还没采到"，不是 0 成本 |
| `context.tally` 的数字 | "这一段的次数" | 导出时刻的滚动窗口，不是事故窗口；窗口看 `incident.summary`，范围看 `windowMs` |

## 7. 最小读取示例

下面的命令只读包，不改页面。把 `<pack>.zip` 换成实际文件名；没有 `jq` 就用同样的键在 Node / Python 里取。

```sh
# 把这一行换成实际的 -ai.zip（已解压的话，PACK 指向目录或文件）
PACK="perf-hud-YYYYMMDD-HHMMSS-iN-ai.zip"

# 0. 四份文件是否齐全
unzip -l "$PACK"

# 1. 入口：版本、完整性、档位、范围
unzip -p "$PACK" manifest.json \
  | jq '{schemaVersion, complete, captureTier, range, incident}'

# 2. 这一段：帧数 / 分位 / 最差帧 / 包覆盖率
unzip -p "$PACK" incident.json \
  | jq '.incident | {
      id, cause, severity, at, window,
      summary: {
        frames: .summary.frames,
        hiddenGaps: .summary.hiddenGaps,
        p50: .summary.p50, p99: .summary.p99,
        worstFrameMs: .summary.worstFrameMs,
        worstFrameJs: .summary.worstFrameJs,
        suspectedThrottle: .summary.suspectedThrottle,
        pkgCoverage: .summary.pkgCoverage
      },
      topPackages: .packages[:3],
      host: .host
    }'

# 3. 缺口：这份包缺什么
unzip -p "$PACK" incident.json | jq '.context.missing'
```

输出骨架（值省略；每次都要从包里读，不要照抄示例）：

```text
{
  "schemaVersion": <n>,        // 本技能按 2 写；文件里更高就先说明版本差异
  "complete": true | false | null,
  "captureTier": "watch" | "deep",
  "incident": { "id": "i…", "cause": "frame | loaf | manual", "severity": <ms>, "at": "<ISO>" },
  "summary": { "frames": <n>, "hiddenGaps": <n>, "p50": <ms>, "p99": <ms>,
               "worstFrameMs": <ms>, "worstFrameJs": "js | none",
               "suspectedThrottle": true | false,
               "pkgCoverage": { "resolved": <n>, "total": <n> } }
}
```

只拿到单份 JSON 时，先校验外壳再读字段：

```sh
node -e '
const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if (r.kind !== "perf-hud-incident") throw new Error("不是事故包: " + r.kind);
const i = r.incident, s = i.summary;
console.log({
  id: i.id, cause: i.cause, severity: i.severity,
  p50: s.p50, p99: s.p99, worst: s.worstFrameMs,
  worstFrameJs: s.worstFrameJs, coverage: s.pkgCoverage,
  missing: r.context.missing.length
});
' perf-hud-incident-*.json
```

## 8. 30 秒自检

- [ ] 我读的是 `manifest.json` + `incident.json`（或完整事故 JSON），不是只看 `summary.md`。
- [ ] 我说的每个"谁"都能指回字段（`packages` / `loaf[].scripts` / `longTasks`），并标了测量还是推断。
- [ ] 我把 `missing` 当"这份包缺什么"，没有当成"这个功能没做 / 页面没发生"。
- [ ] 我没有把 `coalesced`、`longTasks.length`、`packages[0]` 当次数或根因。
- [ ] 我给了下一步，而不是只给一个结论。
