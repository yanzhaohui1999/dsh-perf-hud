# 导出包契约(1.0 冻结)

> **状态:已冻结(1.0 / S0,2026-11-07)**。这里列出的键是**读方依赖的那一层**:删键、改名、改语义、把可选变必需,都算破坏性变更,见 §7。
> 谁在读:随包发货的诊断 Skill([`skills/dsh-perf-diagnosis/SKILL.md`](../skills/dsh-perf-diagnosis/SKILL.md))、[`tools/inspect-incident.mjs`](../tools/inspect-incident.mjs)、外部脚本,以及 1.1 的只读 MCP。
> 为什么冻结、1.0 交什么:[1.0 里程碑](plans/2026-11-07-v1-milestone.md) §1.2。

---

## 0. 三个版本号,别混

| 文件 / 接口 | 版本字段 | 现为 | 升它的条件 |
|---|---|---|---|
| `manifest.json` | `schemaVersion` | **2** | manifest 这一份的键有破坏性变更 |
| `incident.json` | `schema` | **3** | incident 这一份的键有破坏性变更 |
| `capabilities()`(在 manifest 内) | `schema` | **1** | 叶子路径或 `state` 取值域有破坏性变更 |

三个号**互相独立**:`incident.json` 加一个可选字段不会动 `manifest.schemaVersion`。包里同时带着它们,读方按自己读的那一份去比。

---

## 1. 机器可读清单(`schema` 代码块)

本文的键清单写在带 `schema` 标记的代码块里,**它就是门禁的输入**。块只有两行是固定的:

- 开头一行(围栏后面):`` ```schema <名字> v<版本> required|optional ``;
- 结尾一行:三个反引号。

中间一行一个键;`#` 开头的行是注释、空行忽略。`required` = 读方要用,缺了就是坏包;`optional` = **老包可能没有**,缺了按"不知道"读。清单块的名字是 `manifest.json` / `incident.json` 这种;`example` 之类的名字不会被当成清单读。

⚠️ 本文**不用"四反引号套三反引号"来举例**:有的 Markdown 渲染器会把内外层围栏错配,后半篇的代码块就会被折成一行占位(2026-11-07 用一个预览器读 §2.3 时就只剩三行带数字的占位 —— 原文那里是三段键清单,不是三个数字)。想看原样的块直接看 §2.1;用 `sed -n '89,110p' docs/pack-schema.md` 也能看到 §2.3 那三段的源码。

`tests/schema.mjs` 解析这些块,`tests/logic.mjs` 与 `tests/compat.mjs` 都用它 —— 所以**改代码不改清单会红**,改清单不改代码也会红。

---

## 2. `manifest.json`(schemaVersion 2)

包的入口:这份包怎么读、缺什么、里面的四份文件叫什么。

### 2.1 顶层

```schema manifest.json v2 required
schemaVersion
kind
plugin
pluginVersion
platform
captureTier
instrumented
language
exportedAt
range
incident
tally
capabilities
notIncluded
files
redaction
```

```schema manifest.json v2 optional
complete
```

- `kind` 固定 `dsh-perf-hud-diagnostic-pack`;不匹配就不是本插件的包。
- `pluginVersion` 可为 `null`(宿主半没回执时)—— **键在,值是 null** 与 **键不在** 不是一回事。
- `complete`:`true` / `false` / `null`。`null` = 老包没有 `integrity`,**不知道**,不许当完整。v1 的 manifest 没有这个键。
- `files`:四份文件名,**顺序 = 包内顺序**(见 §6 `pack.files`)。v1 的包把 `manifest.json` 写在第二位 —— 读方按**名字**找文件,不许按下标。

### 2.2 `manifest.incident`

```schema manifest.incident v2 required
id
at
cause
severity
frames
loafEntries
longTasks
interactions
```

```schema manifest.incident v2 optional
integrity
```

`frames` / `loafEntries` / `longTasks` / `interactions` 是**条数**;`interactions` 按 interactionId 合并过(与 `incident.summary.interactionsInWindow` 同一口径)。`integrity` 是 v2 才有的(直接把事故的 `integrity` 折进来)。

### 2.3 `manifest.platform` / `range` / `redaction`

```schema manifest.platform v2 required
page
userAgent
viewport
devicePixelRatio
hardwareConcurrency
utcOffsetMin
```

```schema manifest.range v2 required
from
to
preMs
postMs
```

```schema manifest.redaction v2 required
rule
applied
kept
neverCollected
freeText
```

- `page` 只剩 origin + path(查询串整段丢),`userAgent` 只留浏览器主版本 + 系统 —— 这两条是**脱敏后的值**,不是原值。
- `range` 是整个 `null`(没有窗口)时不算缺键:键在、值是 `null`。

### 2.4 已删除的键:`dshVersion`

0.9.0 把 `manifest.dshVersion` 整个删了(理由:宿主半拿不到可验证的版本,字段恒 `null`,见 [REVIEW](../REVIEW.md) §2 第 7 条)。它**没有**升 `schemaVersion` —— 按本文 §7 的规则,这属于"删键应当升版本"的情形,是 1.0 之前欠的账。

对读方的要求有两条:① 老包里出现它,忽略即可(它不是必需键);② 1.0 之后不许再靠"悄悄删键"来改形状。

---

## 3. `incident.json`(schema 3)

### 3.1 顶层

```schema incident.json v3 required
plugin
kind
schema
exportedAt
context
incident
```

`kind` 固定 `perf-hud-incident`;`incident` 是一条事故的完整对象(§3.3)。

### 3.2 `context`

```schema context v3 required
page
userAgent
scenario
watch
tally
sessionBaselines
thresholds
missing
howToAdd
howToRead
redaction
```

```schema context v3 optional
hostCpuProfile
recorder
```

- `missing` 是**字符串数组**,每行大多形如 `前缀:说明`,前缀表见 §5。**缺键 != 没有缺口**:老包没有 `missing` 就是"这份没写",不许读成"齐了"。
- `hostCpuProfile` / `recorder` 是 0.9.0 后才加的可选段 —— **没有它们不升版本**,读方按"这一栏没采"读。
- `thresholds` / `tally` / `watch` 的内部字段不冻(没有读方依赖它们的全部键):`thresholds` 的 `triggerMs` / `gapMs` / `preMs` / `postMs` / `keep` / `dailyDays` / `recent` / `keepMax` / `reactionMs` 与 `tally` 的 `detected` / `triggered` / `captured` / `coalesced` / `kept` / `lost` 是读方会用到的那些;其余随实现增减。

### 3.3 `incident`(事故对象)

```schema incident v3 required
id
cause
note
kept
severity
atPerfMs
at
window
summary
urls
packages
frames
loaf
longTasks
interactions
baseline
host
env
```

```schema incident v3 optional
integrity
tier
day
restored
noteDropped
```

- `integrity` 是 v3 才有的;没有它 = **不知道采全没有**,不是"采全了"。
- `tier` / `day` 在留存时填;`restored` 表示这条是刷新后读回来的;`noteDropped` 只在"给 AI"的那条导出路径上出现(`note` 被置空时标 `true`)。
- `severity` 是 `round1` 过的毫秒数;`at` 是 ISO 字符串,`atPerfMs` 是 perf 毫秒 —— 两者靠 `env.perfOrigin` 换算。

### 3.4 `window` / `integrity` / `env` / `host`

```schema window v3 required
fromMs
toMs
preMs
postMs
from
to
```

```schema integrity v3 required
captureComplete
loafDropped
longTaskDropped
loafKept
longTaskKept
reasons
```

```schema env v3 required
domNodes
heapUsedBytes
instrumented
deep
precise
perfOrigin
viewport
utcOffsetMin
devicePixelRatio
hardwareConcurrency
visibility
```

```schema host v3 required
at
snapshotAgeMs
eventLoop
```

`host` 整个可以是 `null`(没拿到宿主快照);`host.eventLoop` 也可以是 `null`。

### 3.5 `summary`

```schema summary v3 required
worstFrameMs
worstFrameAt
frames
framesOver50Ms
framesOver100Ms
hiddenGaps
loafEntries
blockingMs
pkgCoverage
pkgVia
longTasksInWindow
interactionsInWindow
topScripts
streaming
visibility
```

```schema summary v3 optional
p50
p90
p99
worstFrameJs
worstFrameNeighboursMs
suspectedThrottle
```

可选那六个是"读方可以自己算"的:老包没有 `p50/p90/p99` 时从 `frames` 现算,没有 `worstFrameJs` / `suspectedThrottle` 时按 longtask / LoAF 与最差帧是否重叠现判 —— [`tools/inspect-incident.mjs`](../tools/inspect-incident.mjs) 就是这么做的,它同时兼容旧包。

### 3.6 数组元素(元素级清单)

读方实际依赖的元素键;**加可选元素键不升版本**。

| 数组 | 必需键 | 备注 |
|---|---|---|
| `frames[]` | `t` `ms` | `gap: true` 表示 rAF 被挂起,不是卡顿;`gap` 键只在挂起帧上有 |
| `loaf[]` | `t` `dur` `blocking` `scripts` | `renderStart` / `styleAndLayoutStart` 只在浏览器给的时候有 |
| `loaf[].scripts[]` | `ms` `fn` `invoker` `invokerType` `charPos` `u` | `u` 是 `urls[]` 的下标,`-1` = 没有 URL;`pkg` / `pkgVia` / `file` / `line` / `lineVia` / `lineScope` 是**归因推断**的结果(fn / ms 是直接测量) |
| `longTasks[]` | `seq` `t` `at` `ms` `owner` `source` | `owner` 是包名或 `(unknown)`;`component` / `subtreeComponent` / `domComponent` 按插桩可用性出现 |
| `interactions[]` | `type` `name` `ms` `waitMs` `handlerMs` `isInteraction` | 只收 ≥ `WATCH_EVENT_MS` 的交互;`type: "element"` 在 DSH 上恒为 0 条 |
| `packages[]` | `pkg` `ms` `count` | 按包汇总的脚本耗时,降序 |
| `summary.pkgCoverage` | `resolved` `total` | 有名字的脚本占比 |
| `summary.topScripts[]` | `at` `u` `ms` `fn` `invoker` `invokerType` `charPos` `pkg` `pkgVia` `file` `line` `lineVia` `lineScope` | 与 `loaf[].scripts[]` 是同一批,按 ms 降序取前 5 |
| `urls[]` | — | 纯字符串数组(脚本 URL 表) |
| `baseline` | `p50` `p90` `p99` `max` `worstMs` `frames` … | 帧环**除本窗口之外**的分布;整段可为 `null` |

---

## 4. `capabilities()`(schema 1)

能力矩阵是"这一层采到了没有"的**唯一事实来源**:`capabilityMissing()`、导出件与面板都读它。

### 4.1 叶子路径

```schema capabilities v1 required
schema
renderer.frames
renderer.loaf
renderer.longTasks
renderer.scriptAttribution
renderer.domWrites
renderer.interactions
renderer.elementTiming
host.eventLoop
host.events
host.cpuProfile
link.rtt
link.throughput
```

```schema capabilities.unobserved v1 required
gpu-compositor
electron-main
raw-source-lines
frame-inner-order
devtools-trace
```

**加叶子可以**(新增一条"采到了/没采到"的说明),**删叶子或改 `state` 取值域是契约破坏**。

### 4.2 每个叶子的形状

```
{ state: 'on' | 'degraded' | 'off' | 'unsupported', provenance: 'measured' | 'inferred' | 'unknown', reason: string }
```

- `state` 只认这四个值;`degraded` 是"采到了但有折扣"(采样 / 合并批次 / 只拿到一部分)。
- `provenance` 只认三档,与包内每条证据的"出处"同一套词:直接测量 / 归因推断 / 无法确认。
- `reason` 是**给人看的一句话**,可以是空字符串 —— 不要按它的措辞做程序判断(前缀那套只适用于 `missing`)。

### 4.3 `unobserved`

`[{ id, reason }]`,每个 `id` 是"页面上没有 API、本插件明确不看"的一层。**加条目不升版本**(读方按"多了一条看不到的东西"读)。

---

## 5. `missing:` 前缀

前缀表**只有一个来源**:[诊断 Skill §2.6](../skills/dsh-perf-diagnosis/SKILL.md) 那张表 —— 它由 `tools/gen-prefix-table.mjs` 从 `capabilityMissing()` 生成(`--check` 进 CI,手改 / 没重跑生成器都会红);分类与读法是人写的判断,前缀集合由代码决定。第二道网是 `tests/logic.mjs` 的双向断言。

本文不复述那张表 —— 复述过一份就必然会漂。读方要遵守的只有三条:

1. 前缀是**类别**,不是错误码;
2. 同一个前缀可能落在不同类别,必须读冒号后的说明;
3. 新前缀随时可以加(**不升版本**);删 / 改名 = 破坏,除非先有两个 minor 不再生成。

---

## 6. 四份文件

```schema pack.files v2 required
manifest.json
summary.md
incident.json
README.md
```

- 顺序 = `buildPack()` 的顺序 = `manifest.files` 的顺序(`tests/logic.mjs` 有一条断言钉住)。
- **读方按名字找文件**:v1 的包里 `manifest.json` 写在第二位。
- `summary.md` 固定五段(摘要 / 最可能的假设 / 缺失的证据 / 下一步验证 / 元信息),语言跟随页面;`README.md` 只讲这份包是什么、隐私口径。

---

## 7. 版本策略

### 7.1 什么时候升

| 改动 | 升版本? | 旧读方怎么办 |
|---|---|---|
| 加**可选**键 / 加新叶子 / 加 `unobserved` 条目 / 加新 `missing:` 前缀 | **不升** | 忽略未知字段,照常读。⚠️ 但"可选"不等于"可以只写进文档":每个可选键都得有代码路径产出它(否则它不是可选,是**不存在**),§8 那条样本并集断言会红 |
| 加**必需**键 | 升 | 旧包没这个键 → 按"不知道"读,不许当默认值 |
| 删键 / 改名 / 改单位 / 改 `null` 的含义 / 改枚举取值 | **升** | 旧读方遇到不认识的版本:说明差异,继续读它能认的键 |
| 把可选键改成必需 | 升 | 同上 |

**"冻结"不等于"不许更好"**:允许"加可选字段 + 加新前缀 + 加新读接口";不允许把已有的名字挪走、把单位从累计改成每秒、把 `null` 从"不知道"改成"没有"。

### 7.2 旧包怎么读(四步)

1. **看 `kind`**:不是 `dsh-perf-hud-diagnostic-pack` / `perf-hud-incident` 就不是本插件的包,别硬读。
2. **比版本**:`schemaVersion` / `schema` 小于当前 → 按本文件的可选键读(缺的按"不知道");大于当前 → **说差异**(`versionGap`),只读自己认得的键,不猜新字段。
3. **核必需键**:§2~§4 里 `required` 的键缺一个就是坏包 —— 读方必须**拒绝**并点名缺的是哪个,不许当成"没有数据"继续渲染。
4. **按名字取文件**、按前缀读 `missing`,不按下标、不按顺序。

### 7.3 已经发生过的变更(历史,不再发生)

| 版本 | 改了什么 |
|---|---|
| incident `schema: 1` → `2` | 脚本 URL 从每条脚本里抽成 `incident.urls` + `scripts[].u` |
| incident `schema: 2` → `3` | 加 `incident.integrity`(窗口完整性:到底采全没有) |
| manifest `schemaVersion: 1` → `2` | 加 `manifest.complete` 与 `manifest.incident.integrity`(都来自上面那条) |
| 不升版本的加字段 | `context.hostCpuProfile` / `context.recorder`(0.9.x)、`summary.worstFrameJs` 一类的派生读数 —— 都是**可选**,老包里没有照样读 |
| 不升版本的删字段 | `manifest.dshVersion`(0.9.0)—— **违反本节规则的那一条**,已记进 [REVIEW](../REVIEW.md) §2;以后不许再这样 |

---

## 8. 这份文件被谁钉住

| 断言 | 位置 | 挡什么 |
|---|---|---|
| `manifestFor()` 的键集合 == §2 的清单(`manifest.json` + `manifest.incident`) | `tests/logic.mjs`「契约冻结:manifestFor() 的键集合…」 | 代码加/删键而文档没动 |
| **文档里的每个键都真的有出产方**,`required` 与 `optional` 都算(样本并集 == required ∪ optional;16 个块逐块核) | `tests/logic.mjs`「契约冻结:文档 optional 键也有出产方…」 | 文档多写一个代码永不产出的键(以前只有单向:代码 → 文档) |
| `buildPack()` 的四份文件顺序 == `manifest.files` == §6 | `tests/logic.mjs`「诊断包:manifest 里描述的 files 顺序…」 | 顺序不一致(读方按下标就会读错) |
| 包内三个版本号 == §0 表里的版本 | `tests/logic.mjs`「契约冻结:包内版本号与清单同步…」 | 升了 `PACK_SCHEMA_VERSION` 却没改清单 |
| 上一版(`manifest` v1 / `incident` v2)的包仍能读出摘要与能力矩阵 | `tests/compat.mjs` | 老包被新读方弄坏 |
| 缺一个必需键 → 读方必须拒绝,并点名缺的是哪个 | `tests/compat.mjs` | "少了一半还静默通过" |

改这份文件之后跑:`npm test`(含 `compat`)、`npm run docs:check`。
