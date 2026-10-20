# Changelog

本项目遵循 [Conventional Commits](https://www.conventionalcommits.org/),版本号遵循 SemVer。

## [Unreleased]

### 面板:主界面加一行「近 60 秒帧分布」(2026-10-20)

守夜线的判据是 **≥100ms/帧**(=10fps),而人眼觉得卡的区间在 30–90ms;持续 20fps(每帧 50ms)
的段里**一条事故都不会触发**,tally 里也不会留下任何痕迹。补的不是采集,是视图:帧环里本来
就有每一帧,缺的是"这一分钟里有多少帧是慢的"这个问题的答案。

- 分档:≤16.7 / 16.7–33.3 / 33.3–50 / 50–100 / ≥100ms,边界落在 60Hz 一帧 / 30fps /
  LoAF 线 / 守夜线上,不另造刻度;标签是纯数字,不翻译。
- 排版:**五档一张表**(每档一行:标签 / 条数 / 占比),标题行带总帧数;数字右对齐、等宽数字。
  一条长串塞进 396px 只会被浏览器在 `16.7–` 中间乱断 —— 试过两行折中,同样难读。
- 精度:**两位小数**(3,600 帧里 1 条 = 0.03%;整数百分比会把它抹成 0%),整数不带 `.00`,
  条数带千分位。分母是**真的发生了多少帧**:rAF 间隙(gap)不是帧、不进分母;空窗口写
  「这一分钟还没有帧」。
- 位置:主界面独立一块(状态 / 帧分布 / 最近一次 / 原因 / 趋势);窗口与 60 秒帧条同一段。
- 零新采集:一个纯函数(`frameMix`)读帧环;3 条断言钉住分档边界 / 间隙不进分母 / 文本格式。

### 面板:诊断包把帧级结论挤掉,宿主 max 与 long task 次数印错(2026-10-20)

真实事故 i4189(帧 619.5ms、`worstFrameJs: none`、归因状态"可疑")导出的诊断包里,
「最可能的假设」三条分别是包 / 组件 / 宿主 —— 这一帧真正的结论「没有 JS 阻塞证据」
一条都没写。面板说"更像 rAF 被挂起/节流",包里却在怀疑 `dsh-client-modules` 与 `Sidebar`,
同一个函数的两个消费者互相矛盾。三处同源:

1. **帧级结论排在第四位,被 `slice(0, CAUSE_MAX)` 切掉**:`causeCandidates` 按 script →
   longtask → host → unknown 追加,unknown 永远最后。现在 `worstFrameJs === 'none'` 时把它
   挪到第一位,并把两条窗口级候选降为 `weak`、`limits` 里写明「窗口内累计,与这一帧没有
   时间重叠 —— 解释不了这一帧」。那条限制的措辞是新增的 `causeWindowOnly`(中英成对)。
2. **宿主那行的「最大」印的是快照年龄**:`basis` 用 `maxLabel` 拼 `snapshotAgeMs`,于是出现
   「最大 -2248ms」,真正的 max 是 414.19ms。快照年龄本来就在 `missing` 的 host-cpuprofile
   行里写明,不该借这一行。现在只印 `loop.max`。
3. **long task 的「累计 N 次」数的是不同名字的个数**:同一个组件命中 5 条时印「累计 1 次」
   (i4189 的 Sidebar 306ms 就是 5 条)。改成按名字聚合 `{ ms, count }`,次数按**条**数。

顺带:CI 的断言总数门禁还停在 620(文档已经走到 627),两边对不上;这次连同新增的 3 条
断言一起改成 **630**(attribution 11 / logic 578 / host 41),五份文档、step 名与门禁同步。
i18n 词典 406 键。

### 面板:三处读数让人"看了也不知道是谁卡了"(2026-10-19)

> ⚠️ **同批紧接的第二个事故(展开「技术细节」整块变红字)**:shellNote 被定义在**模块作用域**,
> 却用了 `scriptBreakdownRows` 的局部别名 `t(...)` → 真页面 ReferenceError,那一块只剩一行
> 「这一帧的脚本拆解算不出来:t is not defined」,脚本细拆 / 按来源 / 按包 / 交叉表全部消失。
> 三套件、静态检查、两个真页面验收器**都没响**:三套件测的是纯函数(不测这个渲染函数);
> 静态检查只覆盖未声明的**函数**调用,而 `t` 是变量引用、语法完全合法;验收器此前从不展开
> 折叠组,而 scriptBreakdownRows 只在展开时才计算。修法:改成**内嵌闭包** —— 拿不到局部 `t`
> 在结构上就不可能;配一条结构断言(shellNote 必须在 scriptBreakdownRows 内),已做变异测试。

真实事故(帧 275ms、脚本 273.5ms、定到包 0/3)暴露的三个可读性问题,都不是归因链路坏掉,
而是**数据在、读法没给**:

1. **「按包」第一名是应用外壳时,就地说明"这不是插件"**(`isShellScript` / `shellSummary`):
   `index-CN7NIWNw.js 281ms · 96%` 排在第一行,读者会理所当然把它当元凶,而它是宿主 /
   React 根那一层、从来不属于任何插件(React 根容器上的事件处理器就来自它)。数据本来就有
   (`pkgVia === 'not-plugin'`),只是没渲染。现在第一名是外壳时紧跟一行
   `最大一块来自应用外壳(不是插件)` + 毫秒 + 占比。
2. **long task 那一行不再显示 `? · TextPreview`**(`longTaskLabel`):四条腿一条都没咬住时,
   旧写法是 `owner ?? '?'` + `component ?? '无'`,于是窗口内唯一一条 long task(271ms,
   全屏第二重要的读数)以问号出场。现在走与 `blameText` 同一套优先级,一条都没有就照实写
   「未归因」;**正文只念主名字,悬停把四条腿各自看到什么 + 出处全摊开**。
3. **`Rx @ 包未定名` 这类行标「未定位」**(`evidenceLocatable`):只有函数名、定不到包也定不到
   文件的行,和真正定到名的行并排时会被当成"定位失败了"的线索 —— 它没定位是因为没开深录。
   毫秒仍是真的,所以不滤掉这一行,只在名字后加后缀、悬停给原因。判据与 `locatable`
   (决不决定占名额)刻意不同:`locatable` 只要有 fn/pkg/file 任一样就显示,这一条只认
   **能打开的东西**(包名或文件)。

### 面板:交叉表与未归因两处可读性(2026-10-19)

真实事故(帧 498ms、窗口内只有 81ms 脚本、无一条 LoAF 与最差帧重叠)暴露的两处:

1. **交叉表只有一格有值时画满 3×3** —— 另外 8 个 `·` 加底部重复的摘要,信息量 0、噪音 3 份
   (那一格的答案上面两条堆叠条已经各答过一遍)。`crossTable` 多回一个 `filled`(非空格子数),
   ≤1 时 `crossBlock` 收敛成一行带结论的话;**≥2 格才画表** —— 那时 2D 信息真实存在
   (最重的两件事分属不同的包×来源对)。顺带修掉名字列钉 84px 导致
   `插件批次(未按 sourcemap 拆)` 被截成 `插件批次(未...`:改成按这批名字里最长的取宽(上限 120px)。
2. **未归因那一支把"没观测到"量化**:原来只有一句"请结合前后帧和时间间隙检查",现在追加
   `(这一帧 498ms,与它重叠的 JS 观测为 0ms)`。刻意**不拿窗口脚本总量去减帧间隔** ——
   窗口跨度远大于一帧,两个分母不同,减出来的数会被读成"这一帧里有 X ms 脚本"。
   只报这一帧自己的观测结果(`worstFrameMs` + `worstFrameJs`);字段缺失时退回原来那句。

### 顺带一个结论:这一帧观测不到与深录无关

那一帧没有 LoAF 记录,而 LoAF 由守夜档的 `PerformanceObserver` 提供 —— 深录能补的是
**包名**(sourcemap 分段),补不出这一帧的 LoAF。所以归因状态给"未归因"而不是"要深录"是对的。

### 测试

- 新增 4 条断言(外壳识别 / shellSummary 三态 / longTaskLabel 四态 / 未定位标注),总数 620 → **626**;
- `logic.mjs` 守夜盒补 `blameText` / `blameName` / `looksLikeInfrastructure` / `isRecorderName`
  及其两个常量(它们必须排在 `PKG` 之后:`SELF_NAMES` 用它)。


### 客户端(2026-10-18,拆成包内分片)

**背景**:client.js 一个文件 8,595 行 / 354 个顶层函数 / 94 字段的共享 state,任何改动都要在同一个文件里找上下文。DSH 本身支持包内分片(package-local chunk),不需要构建步骤:

- 运行时 `require.async('./client.<name>.js')`,宿主按 `/plugins/dsh-perf-hud/client.<name>.js?rev=<rev>` 发;
- 分片用 `window.__ModuleLoader__.load({ id, chunk, factory })` 注册(与官方 `dsh-client-ui-sidebar-documentpreview` 的 `client.excel.js` 同一条路);
- `package.json#files` 与 `release.yml` 的产物核对覆盖 `client.*.js`(漏发分片 = 启动 404)。

**结果**:`client.js` **8,595 → 3,751 行**(拆分当时 3,723,面板两批改动又加回 28 行),拆成 1 主 + 6 片:

| 文件 | 行数 | 内容 | 加载时机 |
|---|---:|---|---|
| `client.js` | 3,751 | 采集 / 归因 / 宿主探针 / 面板状态 / apply + 同步包装 | 启动 |
| `client.model.js` | 3,198 | 证据链 / 能力矩阵 / 可能原因 / 诊断包 / 视图模型(159 个函数) | apply 与渲染前 |
| `client.ui.js` | 1,265 | 全部渲染(PerfHud / 四视图 / 各 block) | `PerfHudGate` |
| `client.watch.js` | 726 | 守夜层:observer 回调 / 事故组装 / 落盘(20 个函数) | apply(采集前) |
| `client.i18n.js` | 431 | 中英词典(各 405 键,纯数据) | 最前(locale 注册) |
| `client.tools.js` | 230 | 隔离实验 | 首次 `__perfHud.experiment()` |
| `client.pack.js` | 135 | zip(CRC32 / store-only) | `PerfHudGate` |

**依赖是显式的,不做反向 import**:`createModel(deps)` 收 96 个、`createWatch(deps)` 收 31 个、`createUi(deps)` 收 153 个、`createToolsApi(deps)` 收 16 个;主文件保留同名同步包装,分片没到位时抛明确错误而不是静默返回空值。

**装载顺序有依赖**:`apply()` 里 `Promise.all([loadI18n(), loadModel(), loadWatch()])` 之后才 `restore()` 与 `start()` —— 守夜捕获会调模型层的 `scriptEvidence` / `packageOfScript`,`restore()` 会调 `pruneMapCache`。

**三处必须记住的坑**:

- `HudBoundary` 是 `class`,按 function/const 收集依赖时会漏 —— `h(HudBoundary)` 拿到 undefined → React 抛 `Element type is invalid` → 外壳把整个条目停用(面板消失、`errors` 为空),与 dead-ends 第 7 条同一形态;
- `Promise.all` 的 then 里 `createUi` 抛错不会被 rejection 处理器接到,补了 `.catch` 落账(否则面板空白、`errors` 却是空的);
- 新增一个 `await` 进 `Promise.all` 后**解构位置要跟着改** —— 词典排第一时 `([, model, pack, ui])` 曾经错位成 `([model, pack, ui])`,报的是 `ui.createUi is not a function`。

**离线套件跟着走**:`logic.mjs` 的 `extract()` 分片优先(model → i18n → watch),静态检查用 `allSource`(主文件 + 四个分片);`attribution.mjs` 从 model 分片抽 `ownerOfUrl` / `isCore`;`tools/check-counts.mjs` 的词典键从 i18n 分片读。

**证据**:`npm test` 613 条全绿;`check-panel` / `check-incident` / `check-counts` / `check-storage` / `check-interaction` 全绿;`dead-code` 0 候选;真页面按 chunk 请求六个分片、面板 0 错误。

### 面板(2026-10-19,窄屏适配)

- **手机上面板不再溢出**:宽度改由 `panelWidthFor(innerWidth)` 算 —— `min(396, 视口 − 24)`,下限 240。模拟 393×851 实测:定宽 396 时 `left = −15`、`right = 381`,「性能 HUD · 已关」被切成「能 HUD · 已关」,药丸那条横贯整屏还把标题挤成「生…」。现在展开态 369px(左右各 12),已关态是一枚 168px 的小 chip。
- **收起态 / 已关态只封顶不设宽**:昨天给药丸加 `minWidth: 396` 时把已关态一起带上了,手机上就变成一条横贯整屏的胶布。现在这两种状态都是"内容多宽就多宽",只保留 `maxWidth`。
- **药丸窄屏档**(< 480px):只丢「检测 N 次」这一格(明细在悬停与设置页里),fps / 最差帧 / 最差 longtask 三个基本读数一个不丢。判据只有视口宽度 —— 面板样式全是内联的,没有媒体查询可用。
- **测试**:断言 618 → **620**(logic 566 → **568**:`panelWidthFor` 四档 + `pillCompact` 三档);`tools/check-panel.mjs` 加两条真页面检查 —— 用 CDP 设备模拟把视口压到 393×851,断言面板不越界、宽度 = 视口 − 24。

### 文档(2026-10-19,更正"分片必须重启宿主")

- 昨天写的"改包内分片必须重启宿主"**是错的**,实测更正:分片正文按 URL 记一次,而 URL 里的 rev 来自**主文件**的 mtime/size —— 所以 `touch client.js` 换掉 rev 就会重读分片,刷新页面即可,重启只是最后手段。
- 顺带记下 memo 的副作用:它会把"改坏那一刻"的字节钉在那个 rev 上(实测一次中间态把两行 `pickStep` 写重了,文件改好之后那个 rev 仍回坏字节,页面报 `client-modules: bundle …/client.ui.js?rev=… loaded without registering`)。处置是再 `touch client.js` 换一个 rev;别在分片半改完的状态下开页面。细节与探针抓法见 [环境与验证](docs/verification.md)。

### 面板(2026-10-18,头部常驻 / 宽度一个来源 / 审批卡让位)

- **头部常驻**:展开态由"根节点自己滚"改成 flex 列 + `overflow: hidden`,正文走新的 `S.scroll`(`overflowY: auto`)。以前 `overflowY: auto` 挂在根节点上,**滚轮滚走的是整块** —— 卡顿详情展开「技术细节」后必然要滚,于是标题栏连同「收起 / 关闭」一起滚没了(1400×757 实测必然发生),想收面板只能先滚回顶部。
- **宽度只有一个来源**:新常量 `PANEL_WIDTH = 396`,展开态与错误降级态共用(以前还有第三个字面量 380)。收起态拿它当 `minWidth`:药丸是**一行不可换行**的读数(标题 / 场景 / fps / 最差帧 / LT / 检测 N 次 / 两个按钮),实测 1400×757 的 zh 下宽 **425px** —— 比展开态还宽 29px;它是内容撑的,钉死 396 会在英文下截断(`worst frame 28ms` / `detected 1551 times`),所以只给下限,让它别随"有没有 LT / 检测到几次"忽宽忽窄。
- **审批卡让位(不许挡住批准按钮)**:审批面板是 composer takeover,「拒绝 / 允许一次」两个真按钮在卡片右下角(`actionRow` 右对齐),正压在 HUD 停的那一列上 —— 实测遮住的就是它们。新增纯函数 `hudDodge`(**算术与 DOM 分开**:渲染层量一次 `getBoundingClientRect`,判定全在模型层,离线可断言):卡片右边界伸进我们这一列就抬到卡片上方(`bottom = 视口高 − 卡片顶 + 12`),并把 `maxHeight` 收到抬上去之后剩下的空间(不跟着收会被顶出屏幕上沿);上方不足 200px 则退到左下角(动作按钮右对齐,挡不到);卡片占满整屏 / 不可见 / 还在视口下方 → 一律不动。钩子用外壳给的 `data-approval-key`(类名 `mna1RW_*` 是构建期哈希,不能用)。
- **测试**:断言 613 → **618**(logic 561 → **566**:让位判定四条 + "宽度只有一个来源"一条静态检查);`tools/check-panel.mjs` 加五条真页面几何检查 —— 展开态宽度 = 396、根节点不是滚动容器、正文滚 1500px 时头部不动、插一张假审批卡后面板让开、拿掉之后回到右下角。

### 文档(2026-10-18,档案拆分与上下文瘦身)

- **REVIEW.md 只留现在仍然有效的**:对外门槛、未还的债、当前边界(57.6KB → 5.5KB)。历史决策与 67 条实测证据移到 `docs/plans/2026-10-11-acceptance-evidence.md`;原 `REVIEW-2026-10-13.md` / `NEXT-PHASE-PLAN.md` 移到 `docs/plans/`,归档说明写在各自开头。
- **AGENTS 拆成「规则 + 按需参考」**:§7 面板读数 → `docs/reading-panel.md`;§2 环境与验证 → `docs/verification.md`;§6 归因机制 → `docs/mechanisms.md`;§8 已知坑 → `docs/dead-ends.md`;§10 发版 → `docs/release.md`;§12 竞争与 §0.2 → `docs/landscape.md`。AGENTS 只留规则、门禁、代码约定与指针:**94.8KB → 23KB**,整份都在 65536 字节自动加载预算内(以前被截断,§7 后半与 §8–§12 实际看不到)。
- **文档地图与链接同步**:README / README_EN / CONTRIBUTING / AGENTS §8–§11 的引用改指新档案;`docs/plans/README.md` 是档案索引。档案不进 npm 包。
- **AGENTS §5 收成「规则名 + 做法」**:面板布局 / 文案 / 交互九条(标签不收缩、长文本块式、标题栏、能不说就不说、长度预算、i18n 成对、可点界线、按钮按需、折叠组 thunk)的来历、实测数字与逐项清单移到 `docs/panel-rules.md`(正文未改,含标题栏事故的三条硬性、可点 5 类清单、`clipName` 14/15 与那次 53 字符折行)。§5 **8,355 → 4,592 字节**,AGENTS **25.1KB → 21.4KB**。连带两笔:长度预算不再抄数字(上限以 `tests/logic.mjs` 的 `长度预算` 断言为准 —— 原先那份清单漏了头部视图名 ≤5 字与圆环图例 ≤26 两条,抄本已经漂过一次);词典键数不再重复进 §5。
- **AGENTS §2 开头顶上「仓库一览」表**:10 行说清顶层文件与四个目录(`tests/` / `tools/` / `docs/` / `locale/`)各是什么、谁在什么时候读它。顺手纠正一处容易记错的:`locale/en.json` 是**插件登记信息**(title / description),不是面板词典 —— 中英词典(各 405 键)都在 `client.i18n.js`。表里的行数标成 2026-10-18 的快照,免得又变成一份会漂的抄本。
- **§8 只留症状,规则回各自的家**:「带锚点小批次」与「插桩可还原」原本在 §5 与 §8 各有一份,现在 §8 并成一条"改 `client.js` 的纪律"指回 §5(5 条 → 4 条)。同一批把 5 处**搬家前的旧引用**对齐:`tools/cdp.mjs` / `tools/check-panel.mjs` / `tools/shots.mjs` / `tests/logic.mjs` 里的 `AGENTS §2.2`、`AGENTS §8 第 14 条`、`§8 第 7 条` 改指 `docs/verification.md` 与 `docs/dead-ends.md`(旧的 §8 是 17 条的坑清单,现在 §8 只有 4 条,按旧编号找必然找错)。
- **`docs/dead-ends.md` 的条目编号修好**:末四条原本编成 15 / 16 / 15 / 16 / 17(15 与 16 各出现两次),现按顺序改成 15 / 16 / 17 / 18 / 19 —— 清单本身是 19 条,而 AGENTS §8 与 §9 一直写着"17 条",两处计数同步改成 **19 条**。引用按编号的四处(第 7 / 13 / 14 条)不受影响。

### 发布(2026-10-19,0.6.0)

- **对外状态收口**:收录 PR [#7814](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7814) 已于 2026-10-19 01:29 合并;npm 文本搜索索引也追上了 —— `/-/v1/search?text=dsh-perf-hud` 第 1 条就是 `dsh-perf-hud 0.5.0`。REVIEW §1 原先挂着的两条未完成项因此清空。
- **门禁**:620 条离线断言(attribution 11 / logic 568 / host 41)全绿;`npm pack` **29 个文件**(0.5.0 的 23 + 6 个分片);五个真页面验收器(`check-panel` / `check-incident` / `check-counts` / `check-storage` / `check-interaction`)全绿、面板全程 0 错误;`dead-code` 0 候选。
- **文档同步**:AGENTS §2 的行数快照(3,751 / 3,198 / 1,265)、REVIEW §2 债 #8 与 §5 的 P2-10 状态、验收档案的对外项;README / README_EN 的徽章与固定版本安装命令改指 `v0.6.0`。

## [0.5.0] - 2026-10-18

### 面板(2026-10-17,标题栏:一行永不换行)

- **标题栏改成不可换行的一行**:`S.head` 去掉 `flexWrap`,显式分成 `headLeft`(可压缩:`minWidth: 0` + `overflow: hidden`)与 `headRight`(控件,`flex: 0 0 auto`);标题与场景标签可让位(ellipsis),**控件不让位**。以前那一行里每个元素都是 `flex: 0 0 auto`(§5「标签不收缩」本来是给**数据行**写的),总宽一超,浏览器就按 DOM 顺序把**尾部三个控件整组**丢到第二行、还左对齐 —— 主界面一行放得下、卡顿详情放不下,于是"两个头部的按钮位置关系不一样",而那三个其实是全局控件。分组也不再靠 fps 上的 `margin-left: auto`(它只在所在那一行生效)。
- **量出来才敢改的宽度账**(真页面 `getBoundingClientRect`,396 面板 = 372 内容宽):zh 详情页原来差约 14px、开发者详情差约 80px。收紧头部间距与按钮内边距(8→6、`padding: 2px 6px`,只作用于头部 `S.headBtn`)后,**zh 详情页仍差 0.17px** —— 亚像素级的 flex 收缩就足以触发省略号(`scrollWidth` 取整看不出来,得看小数)。所以又两处:① **「深录」从标题栏移到开发者详情的标签页行**(它是唯一"只在某一屏出现"的头部控件,却占着最挤那一行 —— 实测把该屏标题挤到 21px;那一行本来就换行);② 返回键文案 **「← 返回」→「←」**(悬停给"回到主界面")。现在四个视图的头部都是**一行、零溢出、零裁剪**:标题 70 / 56px 完整、场景完整、控件在右端。
- **子页标题不再拼品牌名**(「性能 HUD · 卡顿详情」→「卡顿详情」,品牌名进悬停):它与下面第一行的上下文标题(`历史事故 i35 · 历史帧 23/56`)在回答同一个问题("我在哪")。
- **回归测试与验收底座**:新增四条静态断言(头部不换行且显式两组 / 没有 `margin-left: auto` / 只有标题与场景可让位 / 头部按钮 ≤4 个 / 深录不在标题栏而在标签页行)+ 一条词典长度预算(视图名 zh ≤5 字、en ≤17 字符);断言 606 → **613**(logic 554 → **561**);`tools/cdp.mjs` 的 `waitForHud` 就绪判据从"`innerText` 里含『性能 HUD』"改成"**根节点存在且文本非空**" —— 子页标题不再含品牌名,而 profile 里落盘的视图是滚动的,旧判据会把"上次停在开发者详情"报成"boot 失败,或槽位条目被外壳停用"(实测踩过);`check-incident` / `check-counts` 按新文案点返回键,真页面四件套全绿,九张 README 截图重出。

### 面板(2026-10-17,卡顿详情分层与界面去重)

- **卡顿详情那一屏分两层**:结论层常显(上下文标题 / 复制摘要 / 导出事故包 / 回放范围 / 归因状态 / 历史帧时间轴),技术读数收进**默认折叠**的「技术细节」(`state.groups.tech`)—— 与开发者详情**共用同一份渲染**(`techGroup`)。以前同一份 `incidentDetail` 在开发者详情里是可折叠的、在普通用户点「查看这次卡顿」落到的那一屏却是**全平铺**的(实测一屏 12 个按钮、约 10 块,含三行"这一帧没有记录"),方向正好反了。
- **同屏重复删掉**:视图外那一行动作里的第二个「← 返回」删除(返回只属于标题栏);事故 id 与"这一帧多少 ms"只在上下文标题里印一次(时间轴卡里不再重复);这一帧没有 LoAF 时,「帧里花在哪」「重叠的 long task」「可疑脚本」那三行"没有记录"合并成一行 `techFrameNone`,收起时那一组摘要给 `techFrameNoneShort`。
- **翻帧从四个按钮收敛成两个箭头 + 一个过滤器**:`incidentFrameNav(row, frame, onlyBad)` 与 `incidentFrameStep(±1)` **共用 `incidentFrameHot` 一个判据**,所以"按钮亮着"与"按下去会到哪一条"永远是同一件事(以前是两对箭头做同一件事、只是步长不同);`onlyBad` 与 `mode` / `selId` / `frameT` / `scope` 一起落在 `LS_WATCHUI`,`layoutDirty()` / `resetLayout()` 也认它。真页面验收器同步改成:打开「只看异常」→「下一帧」必须落在达线帧上 → 再点一次取消。
- **开关与按钮各归其位**:「深录」只在**开发者详情标题栏**与设置页(以前每个视图的标题栏都挂着一份,普通用户在卡顿详情里看到它只能猜);主界面的「设置」入口删掉(标题栏常驻,同屏不必两份);「最差事件」块只留上下文切换按钮(复制摘要 / 导出事故包属于卡顿详情自己的动作条);「工具箱」只留守夜状态 + 事故清单 + 标记刚才,导出与清空只在「原始数据」。
- **测试与文档**:断言 604 → **606**(attribution 11 / logic **554** / host 41 —— 补「只看异常」的可用性判据与步长落点两条,加「技术细节」摘要的长度预算);词典各 402 → **405**(删 `frameNavPrevBad` / `frameNavNextBad` / `frameNoLoaf`,增 `groupTech` / `techFrameNone` / `techFrameNoneShort` / `techNoneHint` / `onlyBad` / `onlyBadHint`);`tools/check-incident.mjs` 起手连折叠状态一起清掉,验收从**默认布局**的第一屏开始;`tools/shots.mjs` 起手强制写 `dsh-perf-hud:on=1` 再刷新 —— 那个 Chrome profile 里落盘的 `'0'` 会让造样本那一步只报"没抓到事故",真因是 `capture()` 回 `not-recording(HUD 关闭时不记录)`;九张 README 截图重出。

### 可靠性(2026-10-17,参考 DSH 自带开发者工具)

- **异步读取全部有 deadline 与代际**:`hostOp` / `probeLink` / sourcemap / 脚本文本读取原来都是裸 `fetch`,宿主挂住时面板会一直显示旧数、`text-pending` 会永远停着,`stop()` 也不 abort 在途请求。现在统一走 `fetchTextWithin` / `fetchJsonWithin`(宿主 5s / map 与脚本文本 20s / probe 30s),失败只写 `timeout` / `cancelled`;`start()` 递增 `state.epoch` 并建 `AbortController`,`stop()` abort 当前代,旧代结果一律丢弃。补静态断言:源码里的 `fetch(` 必须带 `signal:`。
- **宿主快照从"两态"改成四态**:`live / warming / stale / unsupported`(外加路由不可达)。以前 `eventLoop` 对象存在但 ring 还空时,面板会把 `p50/p99` 渲染成 `nullms`,更糟的是 `infraVerdict()` 会在**零样本**时返回「链路已排除」。现在零样本给中性「宿主数据不足」,超过 2.5 个轮询周期标「已过期 Ns」并降级判定;`eventLoopLive=false` 写「宿主未采到」;宿主从 404 恢复后重新请求 `session/event` 监听(不再因为第一次失败就永久 `hostWatchAsked`)。
- **事故窗口完整性**:LoAF / longtask 条目带 `seq`,落定时算 `expected − kept`,写进 `incident.integrity = { captureComplete, loafDropped, longTaskDropped, loafKept, longTaskKept, reasons }`。前摇已经滚出环(环满、确实丢过记录,且最老一条晚于窗口起点)单列 `*-pre-window-overflow`,不编缺失条数。`captureComplete=false` 时:面板写「现场不完整」、`missing` 加 `window-integrity:` 行、`manifest.complete=false`;`hiddenGaps`(rAF 挂起)仍是另一个维度。诊断包 `PACK_SCHEMA_VERSION` 1→2,事故包 `schema` 2→3。
- **map 缓存有上限与淘汰**:`MAP_CACHE_MAX=8` + LRU 索引 `dsh-perf-hud:map:index`;写配额失败先淘汰最旧 rev 再重试一次,仍失败只留内存并记 `mapCache.failed`。内存 `bundleMaps` 同样 LRU。整机导出件的 `context.mapCache` 给出 `max / evicted / failed`。
- **快捷键**:`ctx.shortcuts` 可选注入,macOS / Windows `Cmd/Ctrl+Shift+U` 展开/收起;Linux Web 平台白名单不允许这个组合,不硬塞默认绑定。收起/展开**不抢焦点**(实测外壳会把焦点还给输入框,硬抢会让用户丢焦点;因此没有照抄 Inspector 的 focus restore)。
- **真事故 fixture**:`tests/fixtures/incident-real.json` 是真页面 `capture` → `report` → 脱敏后的切片(74 帧 / 21 条 LoAF / 2 条 longtask / `integrity.captureComplete=true`)。离线套件断言形状、完整性字段,以及"不完整现场"时 summary/manifest 的措辞。
- **深录 sourcemap 解析先测再决定**:当前构建 17 个 section,清 map 缓存后 `setPrecise(true)` 整段墙钟 514ms(含网络),**没有 >50ms 的 longtask**,所以本轮不搬 Worker;后续若出现 >50ms 的自有长任务再重测。
- **文档**:AGENTS 新增 §0.2「与 DSH 自带开发者工具的分工」与 §7.1「记录器可靠性三条」;README 中英新增分工表、快捷键、宿主过期 / 现场不完整说明;词典各 396 → **402**(新增完整性 / 宿主状态 / 快捷键文案);断言总数 586 → **604**(attribution 11 / logic 552 / host 41),CI 与 README/REVIEW 同步。

### 重构
- **死代码层清掉:`4393ea8` 撤面板入口时没收回来的函数、状态位与词典键**(2026-10-13,`review/2026-10-13-audit` 的实施)。`experimentText` / `beyondNoiseText` / `metricList` / `stressText` / `eventTitleText` / `tallyText` / `pkgWhoText` / `invokerWhoText` / `replaySplitText` / `levelDown` 十个函数在 `client.js` 里**零调用点**,却被 `tests/logic.mjs` 抽出来断言着 —— **改坏了没有任何界面会变,CI 却全绿**(与已还的 `pkgZeroText` 同一形态)。现在函数、`extract` / `pieces` 条目与对应断言一起删(`metricList` 是删 `beyondNoiseText` 之后才暴露出来的级联),连带只被它们引用的 **13 个词典键**(中英各 409 → **396**)、`state.markDraft` 与 `PerfHud()` 里三个未用局部(`v` / `tally` / `unexplained`)。重新扫:**0 个候选**(`node tools/dead-code.mjs`,判据保守,不是门禁)。断言 603 → **586**(attribution 11 / logic 534 / host 41);随后「可靠性」一轮把 logic 加到 **552**,总数回到 **604**。
- **`snapshot()` 不再是"读 + 写"**:`sessionBaselines()` 以前直通 `saveSessionBaseline()`,于是**文档承诺的只读 API 每被调一次就重写一遍 `localStorage` 的跨会话基线**(五个真页面验收器每轮会调它若干次,多数只为读 `errors`)。现在拆成 `readSessionBaselines()`(纯读)+ `mergeSessionBaseline()`(合并本次会话但**不写盘**)+ `saveSessionBaseline()`(只由 `pagehide` 调),导出件的内容**逐字不变**(仍含当前会话,仍最多 20 条),只是不再落盘;新增断言钉住"调 `sessionBaselines()` 前后 `localStorage` 一个字节都没变"。
- **帧条不再白扫整个环**:`frameRing.slice()` 从环头正扫改成**从最新一帧倒着走、遇到 `at < from` 就停**。环容量 12000(60fps ≈ 3.3 分钟),而调用方只要最近 60 秒(≈3600 条)—— 展开「取证明细」时每个渲染 tick 白扫约 8400 条,正是"测量工具自己变成被测开销"那条边界要挡的事。倒扫依赖"环按时间升序"这条不变式(生产里每帧只经 rAF 循环 push 一次);一条构造出乱序环的旧用例因此改用 `triggerCapture` 起捕获,并把这个不变式写进注释。
- **导出件的 `timeline.last60s` 删掉**:它是 `timeline.samples` 的子集(500 条环约 106KB,它重复约 13KB),而全仓唯一引用是一句 `Array.isArray`。

### 修复
- **诊断包 `manifest.files` 的顺序说错了**:manifest 在描述"这份包里有什么"时把 `summary.md` 排在第一,而 `buildPack()` 与 UI 词典 `packFilesValue` 都是 `manifest.json` 在最前(它是入口,注释也这么写)。现在三处一致,并补一条断言(manifest 描述的顺序 == 包里真实的顺序)。
- **折叠态与展开态对同一个数用了不同粒度**:宿主摘要写 `宿主 24.04ms`(实际是 p99),展开那一行写 `p50 X · p99 Y · 最大 Z` —— 读者会把折叠态的数当成均值。现在摘要也写 `p99 Xms`(宿主与 RTT 两处)。⚠️ 按 review 的原话"两处都加 p99"会把这一行从 33 字符顶到 41,而摘要预算是 **34**(真机截图里折成了两行)—— 所以同时把**判定那一句从摘要里拿掉**:它已经是展开后的**第一行**(标签 `宿主 event-loop · 判定`),摘要再说一遍就是同一句话说两遍;而且它最长那句(`链路已排除(宿主与隧道均正常)`,16 字)本来就把摘要顶到 43 字符,那个折行**改动之前就有**(桩喂 `未采集` 的那条断言没测到)。现在真实量级(四位数 + 小数)下是 `宿主 p99 1234.5ms · RTT p99 1234.5ms` = 34,一行放得下;并补了一条**喂真实量级**的预算断言(桩里的小数字挡不住这类回归)。
- **工具箱折叠摘要与展开后第一行说同一句话**(`守夜 5 次 · 最差 282ms` vs `抓到 5 次 · 最差 282ms`):摘要改成折叠态独有的信息 `守夜 N 次 · 24h 检测 M 次`(跨刷新、24 小时口径),`抓到 / 最差 / 读回 / 裁掉` 仍只由展开后那一行给。
- **`localStorage` 键位清单两处都不全**:面板那行只列 7 个、README 列 11 个,而代码里有 **13 个**;两处都漏了 **`:deep`**(它决定下次打开是守夜档还是深录档)。现在面板与 README 对齐成同一份 13 项清单,并把"会改变采集档位"的三个(`:on` / `:deep` / `:precise`)点出来。
- **`__perfHud.marks()` 在 README 里承诺过却没实现**:`4393ea8` 撤「场景标记」面板入口时给的出口一直是空的。现在补上只读 getter(`marks: () => state.marks`),并加静态断言防止它再消失。
- **`crossSummary`(第 5 个折叠组摘要)没有长度预算**:真实量级的名字 `dsh-client-ui-renderer · DOMWebSocket.onmessage 1234ms` = **53** 字符,在 396px 里会把摘要折成参差两行。现在 `clipName()` 把两个名字各截到 14 / 15 字符(完整名字在展开后的交叉表里),并补上**拿真实量级名字喂**的预算断言(≤ 40 字符 + 必须出现省略号)。
- **`check-counts.mjs` 的"有时绿"**:它等 `pending === null` 就立刻 `capture()`,但等待期间守夜可能又自己触发一次,手动标记被并进 pending、样本不带备注 —— 第一次跑 3 条 FAIL、重跑三次全过。现在看 `capture()` 的返回值(`{ok, reason}`)**重试**,并按 `capture().incident.id` 取回刚标记那条,不再用"谁有备注就取谁"的启发式。⚠️ 实施时又发现**第二层**:手动标记的 severity 是 **0**,留存策略是"最差 10 + 每天最差 1" —— 页面里已有 8~10 条真实卡顿时这条标记会被**挤掉**,样本根本不在清单里;不清残留的话,旧写法会取到**上一轮留下的那条**,三条 ZIP 断言验的就不是这次的标记(实测:接在 `shots.mjs` 之后跑必翻车)。所以 `check-counts.mjs` 与 `shots.mjs` 都先 `clearIncidents()`(不动计数桶)再取样 —— 验收器不许依赖上一轮的残留。这种抖动比红更糟:它会训练人忽略失败。**顺带**:`shots.mjs` 的样本竞态与残留事故同样修掉(README 的图里也不该出现使用者真实会话的证据)。
- **宿主半的 confirm 安全线只钉住了一半**:`setBundle` 的 deny 名单有两项(自己 + `session-persistence-jsonl`),而 `tests/host.mjs` 只测了"拒绝动自己"。补上第二条,并断言两条都拒绝时**一次都没写**。
- **README 的两处漂移**:`exportPack` 那行还写着"逐个文件下载(P1 换成一个 zip)"(zip 已在 `f92399e` 落地);`NEXT-PHASE-PLAN.md` 的"下一轮"清单里 zip 也还在待办。

### 新增
- **诊断包改成一个 ZIP 一次下载**(`zipStore()` / `crc32()`,**零依赖、store 模式不压缩**)。P1 之前是逐个下载 4 个文件 —— 部分浏览器会把后续下载拦掉,用户文件夹里也会散落四个文件。现在 `exportPack(id, options)` 打一个 zip,名字带 `-ai` / `-full`,两条路径落到磁盘上也分得清。不压缩的理由:包里全是 JSON / Markdown,deflate 能省一半体积,但要么引依赖、要么依赖异步的 `CompressionStream`,为几十 KB 不值得;CRC 用逐位算法(一次打包只调 4 次,省掉一份模块级查表状态)。预览卡从"每份大小"改成**压缩包总大小 + 逐份清单**,并删掉那句"一次打包成一个 zip 是下一步"的过渡文案。
- **主界面的「最近一次卡顿」用时间语义,与开发者详情的「最差事件」分开**(`latestIncident()`)。原来主界面吃的是 `selectedIncident()`,而它默认跟**全局最差**那条 —— 于是一小时前那次最严重的会被显示成"最近一次"。现在两个语义各有各的函数、各有各的视图:主界面 = 时间最新,开发者详情 = 默认最差 / 用户手选;结构上有断言钉住"主界面不碰 selectedIncident"。
- **候选原因给普通用户说人话**(`causePlainLead()`):主界面只给"某个脚本模块的耗时偏高 / 这一段时间里有较重的渲染任务 / 宿主进程那侧偏忙 / 缺少能解释这次停顿的 JS 证据" + 线索强度,**不带包名**;原始包名 / 毫秒 / 支持证据 / 出处收进「为什么这样判断?」展开区(默认收起),开发者详情里照旧全给。趋势那一行的「重复线索」同样只说"同一个脚本模块",包名进展开区。不编模块功能,也不把相关写成根因。
- **两条导出路径在文案与 UI 上明确区分,并加分享前预览**:给 AI 的那条叫「导出诊断包(给 AI:脱敏、不含备注)」,带 `dropFreeText: true`;本机调试件叫「完整技术导出(保留备注)」。主界面点「导出诊断报告」**先出预览**(文件清单 + 每份大小 + 备注已置空 + 本包不含多少项 + "一次打包成 zip 是下一步"),确认后才生成;`packPreview()` 新增 `notes: 'dropped' | 'kept'`,两条路的差别因此可断言。现有 JSON 接口(`snapshot` / `report` / `exportJson` / `exportIncident` / `pack` / `preview` / `exportPack`)一个都没改签名。
- **界面改成四个视图(方案 1:整屏切换,不再把摘要贴在旧面板顶上)**。默认是**主界面**,只回答五个问题:当前状态(`healthVerdict()`:运行流畅 / 刚才有卡顿 / **监测受限** —— HUD 关着或 LoAF 没装上时给的是后者 + 原因,绝不伪装成正常)、最近一次卡顿(秒数 + 时刻 + 现场有没有留住)、可能原因(`causeCandidates()`,每条都带**支持与限制**)、最近趋势(1 小时 / 24 小时可切:检测到几次 / 最长一次 / 重复线索)、两个主操作(查看这次卡顿 / 导出诊断报告)。**卡顿详情**是独立一屏(「← 返回」);**开发者详情**是 5 个标签页(**帧与归因 / DOM 与堆 / 宿主与链路 / 工具箱 / 原始数据**,照实映射现有分组,现有能力一个都没删);**设置**管记录模式(守夜默认常开、深录必须显式开)、数据保留与隐私脱敏。落盘只存"在看哪个视图 / 哪个标签页 / 哪个趋势窗口"(`LS_VIEW`),**不存任何读数**;折叠药丸展开时回到主界面。主界面**不出现** LoAF / p99 / RTT / 包名排行 / 帧编号。
- **能力矩阵 + 诊断包:把"哪一层采到了、可能是什么原因、缺什么"固化成可断言的数据**(`capabilities()` / `capabilityMissing()` / `causeCandidates()` / `buildPack()`)。`capabilities()` 是能力状态的唯一事实来源(renderer / host / link 三组叶子 + `unobserved` 一层:GPU 合成、Electron 主进程、原始源码行号、帧内顺序、DevTools trace),每片叶子给 `{ state, provenance, reason }`;事故包那串 `missing:` / `howToAdd` 改由 `capabilityMissing(row)` 从它推出来(前缀形状不变,线上断言照旧认)。`causeCandidates(row)` 给**最多 3 条候选原因**,每条带**支持证据 / 限制 / 出处三档**(`measured` / `inferred` / `unknown`),而且限制里一定有"不等于已定位根因";`worstFrameJs === 'none'` 时不会顺手写节流结论(只有 `suspectedThrottle` 成立才写"更像 rAF 挂起或浏览器节流")。`__perfHud.pack(id)` 打出**四个文件**:`manifest.json`(入口:schemaVersion、平台、采集档位、能力矩阵、脱敏、不含什么)/ `summary.md`(固定五段:摘要 → 最可能的假设 → 缺失的证据 → 下一步验证 → 元信息)/ `incident.json`(与面板「导出事故包」同源)/ `README.md`(怎么读 + 隐私口径);`preview(id)` 只给清单,`exportPack(id)` 才下载(P0 逐个文件,P1 换成一个 zip)。构建全是**纯函数**,不碰 DOM —— 所以离线套件直接断言格式,以后换界面 / 加 MCP 不用动这份格式。
- **捕获频次:跨刷新的时间桶,与"留存了几份现场"彻底分开**(`state.tally` / `LS_TALLY` = `dsh-perf-hud:tally:v1`)。留存清单受容量限制(最差 10 + 每天 1),**它的条数不能回答"最近卡了几次"** —— 被挤掉的卡顿不是没发生(实测一次会话里 `captured 40 · dropped 38`)。现在每分钟一个 7 元桶、只留最近 24 小时,再按天汇总 30 天;落盘走 2 秒合并定时器(`markTallyDirty`:后摇窗口里每帧都会触发,不能每帧写盘),读回时形状不对的桶**整桶丢掉**并把原因记进 `tally.loadError`。四个数各有各的名字,面板悬停与导出件(`context.tally`)都写全:**检测到 = `triggered`**(起过几次捕获)**/ 同串触发 = `coalesced`**(同一串里被并掉的触发数,是密度不是次数)**/ 已保存现场 = `incidents.length` / 丢失 = (triggered − captured) + dropped + trimmed + failed**。折叠药丸那一格从"留存份数"改成"最近 24 小时检测到几次"(它原来把 `incidents.length` 显示成"抓到 N 次",正是产品计划 §3.A 要拆开的那个混淆)。`clearIncidents()` **不清**计数桶(清掉的是证据,不是事实),要清频次得显式 `clearTally()`。

- **导出脱敏:任何离开本机的导出件先做一遍减法,并把它减了什么写进文件**(`redactExport()` / `redactionReport()`,**导出件只有这一个出口**,以后加字段不会漏)。四条规则:① `page` / `href` 只保留 `origin + path`、**查询串整段丢弃**;② `url` / `urls` / `sourceURL` 去掉协议与主机、保留路径与 `rev`,而 `token` / `accessToken` / `api_key` / `secret` / `password` / `signature` / `code` 等键的**值**换成 `<redacted>`(键名保留 —— 读的人要知道这里本来有什么);③ 其余字符串里的 `/Users/<用户名>`、`/home/<用户名>`、`C:\Users\<用户名>` 统一换成 `~`(所以错误原文、组件栈、宿主 profile 路径这些"顺手带出来的东西"也被一并覆盖);④ `userAgent` 只留浏览器主版本 + 系统。"其余字符串一律过一遍"这一条是刻意的:按字段名逐个加规则一定会漏,而漏一个就是一次泄漏。文件里 `context.redaction` 给三问三答 —— `applied`(做了什么)/ `kept`(留了什么)/ `neverCollected`(本来就没采:聊天正文、提示词、Cookie、Token、请求头),口径写明**这是减法不是匿名化**。`incidentReport(id, { dropFreeText: true })` 把用户手敲的自由文本(事故 `note`、场景标记)置空并标 `noteDropped: true`,默认(本机调试件)原样保留。

- **"检测到"一开始被写成 `captured + coalesced`,真页面上把一次停顿记成 18 次**:同一串卡顿在 3 秒的后摇窗口里**每帧都会触发一次**,于是 `coalesced` 能到两位数 —— 两者相加得到的数"看着挺忙",却答不了"卡了几次"。现在 `detected = triggered`(`triggerCapture` 起一次新 pending 才 +1),`coalesced` 单独作为"这一串有多密"给出。这条是**先在真页面上量出来**才发现的:离线盒子里两种写法都能算出一个数,只有真页面的触发密度能暴露它。
### 修复
- **AI 诊断包的 `summary.md` 会把用户备注原样带出去**:`incident.json` 那边按 `dropFreeText` 置空并标了 `noteDropped`,而 `diagnosticSummary()` 直接读了原始 `row.note` —— **同一份包里两份文件各说各话**,而这份包正是要交给外部 AI 的那份。现在摘要走同一个 `dropFreeText`(置空并写一句"备注:已置空"),保留那一支也会过 `scrubParams`。**这条是被新加的断言抓出来的**(断言拿一份 `note` 里带 `token=SECRET` 的事故跑两条路径)。
- **自由文本里"裸的"凭据没被脱敏**:`scrubParams` 原来只认 URL 形态(`?token=…` / `&api_key=…`),而用户粘贴的备注常常是 `token=abc` 这种没有前缀的写法。现在按**词边界**再扫一遍(代价是 `code=200` 这类无关键也会被换成占位符 —— 宁可多脱一个,不要漏一个)。
- **8 个文案只有引用、没有词典条目,面板上直接印出了 key 名**(`viewIncident` / `backHint` / `exportPreviewCopy` / `packFilesLabel|Hint|Value` / `storageKeys|Hint`)。三套件全绿、死键断言也不响(它只管"词典里没人用"),只有真页面才看得出来。补齐词条,并**补上反向断言**:凡是被 `t('…')` / `translate('…')` 字面量引用的键,必须真的在 `DICT.zh` 与 `DICT.en` 里。

- **`snapshot().page` 与 `incidentReport().context.page` 原来直接写 `location.href`**:DSH 首屏是 `http://127.0.0.1:3080/?token=…` 进来的,于是**一次导出就可能把会话 token 一起带出去**,而这份文件正是准备交给外部 AI 的那份。现在按上面那条脱敏规则处理,并有端到端断言:往真实状态里塞 `?token=SECRET_TOKEN_VALUE`、`/Users/tester/…`、`api_key=SECRET_KEY_VALUE`,断言序列化后的导出件里这三个字符串一个都不剩。

- **历史事故逐帧诊断:选中一条事故之后,可以在「同一个诊断上下文」里逐帧回看、看那一帧的耗时分解与真实证据**:「取证明细」现在一次只服务**一个**上下文 —— `live`(实时帧环里的当前帧)或 `incident`(选中事故里的一条**历史帧**),由 `state.watch.mode` 决定,**分流只发生在 `detailContext()` 一处**,渲染那侧只读它的返回值。以前帧条 / 翻帧 / 饼图吃实时 `pickedLoaf()`,而事故卡片与回放吃 `selectedIncident()`,于是"上面是历史事故、下面是另一条实时帧的编号与耗时"必然出现 —— 现在实时与历史**共用视觉组件**(`ringBlock` / `scriptBreakdownRows` / `evidenceBlock` / `crossBlock`),但**不共用一个错误的上下文**。详情区第一行是上下文标题(`实时监控 · 当前帧` / `历史事故 i12 · 历史帧 3/305`),折叠组标题带上事故 id,事故卡片上按「看这一帧」进历史、按「回到实时」回实时;切换**只切数据源**,实时采集与另一侧的选中都不动。
- **历史帧时间轴:可点的导航器,不是装饰性图表**(`replayColumns` / `replayCellTitle`)。事故窗口按**时间**切成 240 列,每列取该列里**最差的那一帧**,并把**那一帧的引用**留在格子里 —— 点击 / 选中 / 高亮全部映射回 `incident.frames` 里真实存在的记录(断言:每个非空格子的 `frame` 都在原数组里,不合成帧);整段 rAF 被挂起 / 采样缺失的地方**留白**,不补桩。档位与实时帧条共用 `sparkLevel` 与 `SPARK_COLORS`,选中帧是**一条蓝色竖线**(`--dsw-alias-state-business-primary`)。240 列把"一条 13 秒窗口几百帧"的绘制量钉在 ≤240 个 DOM 节点上。
- **四个方向的逐帧导航 + 真实禁用态**(`incidentFrameNav` / `incidentFrameStep` / `incidentFrameBadStep`):`上一帧 / 下一帧` 按**时间序**走(与帧条方向一致),`上一异常帧 / 下一异常帧` 按守夜触发线(`PICK_MIN_MS`)筛;没有下一条就**禁用**按钮,不留"点了没反应"的动作。选中帧的**序号 / 耗时 / 档位文字**跟着更新。
- **一帧的分解与证据只吃那一帧**:与选中帧**时间重叠**的 `incident.loaf`(多条取最重)提供时间分解与脚本证据;这一帧没有 LoAF 就写「这一帧没有长动画帧记录」,**不拿最差那一帧、更不拿实时帧顶**;脚本证据退回**事故窗口内**切片时块首写明"不是这一帧的";**与这一帧重叠的 Long Task** 单列一块(owner / component / 来源),窗口内总条数当分母。这一帧的脚本聚合走与实时同一套 `tallyScripts`,但 `pkg` / `pkgVia` **优先用捕获时存下来的** —— 刷新之后当前会话的 sourcemap 缓存是空的,现算会把历史事故的包名全算成"未定名"。
- **归因状态收敛成三档**(`incidentVerdict` + `verdictColor`):**已确认**(有 JS 阻塞证据且窗口里定到了包,并写明"这只缩小到哪个包,不等于已定位根因")/ **可疑**(有 JS 证据但没定到包;或满足 `suspectedThrottle` 的检测条件)/ **未归因**(给的是校准过的那句:未观察到足以解释该帧的 JS 阻塞证据;请结合前后帧和时间间隙检查 rAF 挂起或浏览器节流)。档位**文字 + 档位色**两样一起给,面板与「复制摘要」读同一个函数。

### 修改

- **诊断上下文落盘(`LS_WATCHUI`,只存 `mode` / `selId` / `frameT` / `scope`,不存数据)**:刷新之后**仍然停在同一条事故的同一帧**;落盘的事故 id 或帧 `t` 找不到就退回自动,没有事故就退回实时。实时那一侧的 `pickT` 在切换上下文时**不动**,切回来还是原来那条。
- **`jsNo` 不再把可能性写成结论**:文案从「无(更像 rAF 被节流)」改成「无(longtask/LoAF 都不与它重叠)」;"更像 rAF 挂起 / 浏览器节流"只作为**可疑**那一档的说明出现,而且只有 `suspectedThrottle` 真的成立时才提。
- **零证据那一行的分母范围按上下文说**:历史帧 / 本帧 / 窗口内三档(`evidenceZeroText` 读 `scopeKind`),不再一律写"窗口内";事故窗口那一支的交叉表也给自己的范围说明(`crossIncidentHint`)。
- **面板补齐控件态样式**:根节点加 `id="dsh-perf-hud-root"`,用一条**纯 CSS**(`installStyle()`)给按钮补 hover / focus-visible / disabled —— 没有 per-element 鼠标状态(那条禁令见 AGENTS §7)。行内样式优先,所以这三条规则用 `!important`。视觉上补齐 8px 圆角卡片、次级背景 `--dsw-alias-bg-layer-2`、18px/600 的"核心耗时"与等宽数字,颜色全部走既有 theme token。

### 修复

- **`h('div', …, hint ?? t('crossHint')})` 那处交叉表范围提示的括号结构**(改 `crossBlock` 参数时引入,`node --check` 当场拦下)。记一笔是因为它正是 AGENTS §8 第 14 条那类"批量替换看起来对、其实断了结构"的同类风险。
- **`incident.frames` 里的 `gap` 以前会被当成普通帧参与序号与翻帧**:现在 `gap === true` 明确不是帧(整段 rAF 被挂起),不参与序号 / 选中 / 翻帧,只在帧条上留白。


### 测试
- 断言 **591 → 603**(logic 541 → 553):ZIP 一组 11 条 —— CRC32 标准向量(空串 0 / `'123456789'` = 0xCBF43926 / `'a'` = 0xE8B7BE43)、UTF-8 按字节算长度、DOS 时间戳年份下限、本地头与 EOCD 签名、EOCD 里的条目数与中央目录偏移、本地头 CRC 与内容字节对得上、压缩方式必须是 0、体积 = 内容之和 + 目录开销、空清单也给合法 zip、以及"导出真的走一个 zip 一次下载"的接线断言。
- `tools/check-counts.mjs` 真页面新增 **真实字节验收**:先等 `watch().pending === null` 再手动标记一条**带备注**的事故(否则会被并进正在等的那一次,样本就没备注),把页面里生成的 zip 落盘交给**系统 `unzip -t`** 判(`No errors detected`)、`unzip -l` 核四份文件、`unzip -p` 逐份读回来核内容:AI 包里 `incident.note === null` + `noteDropped: true` + `summary.md` 写"备注:已置空"且两个文件都不含原文;完整包保留备注正文、但里面粘的 `token=` 已被脱成 `<redacted>`;两个包大小不同(差的正是那段自由文本)。现场:`ai 55604B / full 55896B · unzip -t 通过 · 四份文件齐全`。
- 断言 **574 → 591**(logic 524 → 541):最近 vs 最差(时间最新那条 / 空清单给 null / 主界面结构上不碰 `selectedIncident`)、人话原因(四种 kind 都有分类、不出现 `@`/`dsh-`/`.js`/数字、"未知"那支只写"缺少 JS 证据"不写节流)、两条导出路径(AI 包备注置空且 `summary.md` 也不带 / 完整导出保留备注但裸 token 变占位 / 预览 `notes` 两种取值 / 文件清单一致)、趋势行(人话不含包名、原始线索才含、没有重复线索给 null)。
- `tools/check-counts.mjs` 真页面加了一组:主界面默认**不出现包名**、展开「为什么这样判断?」之后才有支持 / 限制、点「导出诊断报告」**先出预览**(文件 / 备注已置空 / 生成与取消 / 取消后收起),以及**每个视图的正文里都不许出现词典键名**(按标识符边界比,避免 `watchui` 里的 `watch` 假阳性)。
- 断言 **561 → 574** 条(logic 511 → 524):视图模型与主界面 13 条 —— 监测不可用不许说"运行流畅"、三个档位图标不同、秒数写法、`frameLevel` 与判色同源(fps 20 → stall/bad;最差帧 130ms 也 stall)、趋势三个数的口径与长度预算 ≤ 60、只出现一次不算"重复线索"、空窗口给人话不显示零值。
- `tools/check-incident.mjs` 跟着改成方案 1 的走法,并把**视图切换**也纳入验收:主界面「查看这次卡顿」→ 卡顿详情(独立一屏,有「← 返回」)→ 逐帧回放照旧 → 刷新后仍停在同一帧 → 「← 返回」回主界面(不再挂返回按钮)→ 开发者详情 5 个标签页 → 「回到实时」→ 设置页三块齐全且深录仍默认关。**ALL PASS**。
- 断言 **539 → 561** 条(logic 489 → 511):能力矩阵(叶子形状与枚举、三组齐全与 unobserved、没插桩时 DOM 写入 off 且理由写明、element timing 恒 unsupported、`capabilityMissing` 由它推且前缀齐全)+ 候选原因(最多 3 条、每条三个非空字段、限制里必有"不等于根因"、覆盖率不到 100% 时写明还剩几条、宿主只在 p99 偏高时出现、`worstFrameJs==='none'` 时只能"证据不足"或"更像…"、空 id 给空数组)+ 诊断包(四文件顺序、manifest 字段、凭据进不去、五段形态、每条假设的出处只能是三档之一、预览的包含 / 排除 / 脱敏、`dropFreeText` 在 manifest 与 incident 两处都留标记、不存在的 id 返回 null)。

- 离线断言 **497 → 539** 条(attribution 11 / logic **489** / host 39):捕获计数的口径(窗口边界按分钟桶切、`coveredFrom/To` 照实给、日汇总与当日分钟桶同一口径、24h 外裁剪有计数、`worstMs` 取 max 不求和、跨刷新读回、坏 JSON 与形状不对的桶不静默变 0、`bumpTally` 认不出的 kind 不静默记错、起过捕获没切成现场单列 `unsettled`、清事故不动计数桶、药丸文案不再拿留存份数当次数)+ 导出脱敏(丢查询串 / 留 rev / 只换值不换键 / `~` 降级 / UA 降级 / 数组走脚本规则 / `dropFreeText` 留 `noteDropped` 标记)。`ci.yml` 的 `-eq` 门禁与 README / README_EN / AGENTS / REVIEW 的数字同步。
- **新增 `tools/check-counts.mjs`(真页面验收器,和 `check-panel` 一样不是离线门禁)**:用 `history.replaceState` 把凭据**塞进真的 `location`** 再断言导出件里一个都不剩(离线盒子的 `location` 是桩,这条在那里是空断言);清桶 → 手动标记一次真捕获 → 断言 `detected = triggered`、`detected !== captured + coalesced`、`kept ≤ detected`、落盘两拍之后读得回来;刷新后计数还在;折叠药丸上出现「检测 N 次」。**ALL PASS**,现场读数:`检测到 3(triggered 3 · 切成现场 2 · 同串触发 29)· 已保存现场 2 · 丢失 1` —— 旧口径会把这次记成 32 次。
### 测试

- **新增 `tools/check-incident.mjs`(真页面验收器,和 `check-panel` 一样不是离线门禁)**:清事故 → 同步烧 400ms 造一条真达线帧 → 等守夜自动切片 → 按「看这一帧」进历史上下文 → 断言上下文标题 / 时间轴在场 / 点柱子换帧 / 下一帧上一帧 / 下一异常帧落在达线帧上 / 走到最后一帧后「下一帧」禁用 / **刷新后仍停在同一帧** / 「回到实时」把实时帧条换回来 / 全程 `errors: 0`。**ALL PASS**。
- 离线断言 **458 → 490** 条(attribution 11 / logic **440** / host 39):上下文隔离(历史那一支不吃实时帧、实时那一支不吃事故)、历史帧列表跳过 gap、选中帧 `t` 找不到就退回自动、四个方向的导航与禁用态、帧条"每列取最差且一定是真实帧 + 缺口留白 + 900 帧只画 ≤240 列"、包名用存下来的(刷新后仍定得到名)、这一帧没有 LoAF 时证据退回窗口切片并标 `missing`、long task 只给重叠的、三档归因状态、`LS_WATCHUI` 落盘/读回与失效退回,以及"`frameNearestIncident` 这条就近定位老路已删掉";`.github/workflows/ci.yml` 的 `-eq 490` 门禁与两处 `Offline suites (…)` 标题、README / README_EN / AGENTS / REVIEW 里的数字同步改。
- 随后再补 **490 → 494** 条(logic 440 → 444):一条**零证据分母范围**的口径断言(历史帧 / 本帧 / 窗口内三档,不许一律写"窗口内"),以及**三条结构性静态检查** —— ① 上下文只在 `detailContext()` 一处分流;② `incidentDetail` 的函数体里不出现任何实时读数(`pickedLoaf` / `scriptPkgTally` / `framePkgTally` / `worstSecond` / `recorderText` / `unexplainedFrame` / `frameRing`);③ 新加的渲染辅助函数(定义在 `function PerfHud(` **之前**,旧的"渲染区裸调用"检查盖不到)单独跑同一条未声明引用分析。后两条的**牙齿**是用副本验过的:往 `incidentDetail` 里塞一个 `pickedLoaf()`、往 `timelineBlock` 里塞一个未声明的裸调用,断言都会 FAIL。`ci.yml` / `release.yml` 的 `-eq` 门禁与 README / README_EN / AGENTS / REVIEW 里的总数随之同步到 **494**。
- 再补 **494 → 497** 条(logic 444 → 447):**证据块底下那一行的正文/悬停分离**("可疑脚本"底下以前把口径与缺口两整段摊在正文里,面板是纯文本渲染,`**` 与反引号原样显示 —— 现在正文只留分母 + 一句悬停提示,全文进 `evidenceFooterTitle()` 的 `title`,与「复制摘要」共用同一份措辞),以及两条**词典级**断言:① 正文文案不许带 markdown 记号(`**` / 反引号),带记号的一律得是白名单里"只进悬停"的那 20 个键;② 那份白名单不许有死键。
- 真页面四件套:`check-panel` / `check-storage` / `check-interaction` / `check-incident` **ALL PASS**;另外用 CDP 真实鼠标扫过展开的面板 644 个点,断言条目仍活着、`errors: 0`、悬停边框解析到交互蓝 token —— 这是纯 CSS,没有任何 JS 鼠标状态。

### 工具
- **记录器自己的代价可以量了(`tools/measure-cost.mjs`)**:分 `off` / `watch` / `deep` 三档,各测空闲期帧节奏(帧间隔 p50 / p95 / max)、堆增量(每档先 `clear()` 再测,含"这一档又攒起来"的驻留成本)与 `setTimeout` 微基准(6000 次的耗时;**深录档与另外两档的比值就是调度点包装的逐调用成本**)。为什么不能再用"驱动一次同步提交、比两次提交谁慢"来量:同步提交期间 rAF 与两个观察器**根本插不进来**,而 HUD 关着那一档连 `stress()` 组件都不存在(它只在 HUD 渲染时存在)—— 两档量的不是同一件事。**守夜内部无法再细分**(`state.watch.on` 与总开关联动,`watchStatus()` 返回的是快照副本,写不进去),所以守夜档的代价是合计的;这是代码的结构缺口,不是测量偷懒。它要真浏览器 + 本机 `dsh web`,不在 `npm test` 与 CI 里。

### 文档
- **README / README_EN 的界面说明跟上新版 UI**:补「四屏一眼看完」的九张截图(主界面 / 卡顿详情 / 设置 / 开发者详情五个标签页 / 折叠药丸)、五步操作路径(展开 → 看那一次卡顿 → 看技术数据 → 交给 AI → 本机排查),并写明两条导出路径的差别。截图由新脚本 `tools/shots.mjs` 生成:每张图**先把视图状态写死再刷新**,所以图与代码里的那一屏一一对应,改完重跑即全量更新;它和 `check-*.mjs` 一样不在离线门禁里。截图放 `docs/images/`,**不进** `package.json#files`(GitHub 上的 README 用相对路径就够;真要以 npm 页面为主再把它加进白名单 —— 这条取舍写在这里,免得以后当成遗漏)。


- **首发机制改准(staged publishing,不是直接 `npm publish`)**:0.4.0 实际是先 `npm stage publish`(registry 见状建了占位版本 `0.0.0-stage` 占住包名),再由维护者用 2FA **approve** 上线的 —— 证据是 registry 的 `gitHead` 等于当时的 `main`、`fileCount` 18、线上 tarball 与本机 `npm pack` 逐文件 sha256 全等(字节 shasum 不同只因打包用的 npm 版本不同:线上 11.17.0 / 本机 11.12.1)。REVIEW §3.1 与 AGENTS §10/§11 按这份证据改写,并记下 Trusted Publisher 的 **Allowed actions** 决定以后是否需要每版人工 approve(`npm stage publish` 永远允许;直接 `npm publish` 要显式勾选)。上一版文档写"本机 `npm publish` 首发"是错的。

## [0.4.0] - 2026-10-11

### 新增

- **事故回放:把选中事故那一段窗口画回面板上(只用事故包里存下来的数据 → 刷新生效、零新增采集)**:事故切片里的 `incident.frames` / `incident.loaf` 一直只喂给「导出事故包」,面板里看不到 —— 要看"那 13 秒到底发生了啥"必须先导出再跑 `tools/inspect-incident.mjs`。现在「取证明细」里紧跟实时帧条多一块**事故回放**(`replayScope` / `replayX` / `replaySummaryText` / `replaySplitText`):帧条 + 一行**范围**(跨度 / 帧数 / p50 / p99 / 最差帧 / 缺口数)+ 一行**最差帧的四段分解**(复用 `frameSplit`,相加 = 这一帧时长)+ 一行口径脚注。三条硬性:① 横轴**按时间**放(`replayX`)—— 按序号会把整段 rAF 挂起压成一根柱子,那是在说谎;**挂起段留白**,一眼看出"这段时间根本没在测";越界夹住;② 档位与实时帧条**共用** `sparkLevel`、颜色共用 `SPARK_COLORS` —— 同一档观感不许打架;③ 它跟上面那条 60 秒帧条是**两份数据、两条时间轴**,所以刻意分开显示、各自写明范围(标签实测 `事故回放 · i1 · 13秒`),刷新生效是因为数据在包里。⚠️ **不排帧内执行顺序**:LoAF 不给每帧内脚本的起止时间;逐帧脚本明细仍走「导出事故包」+ `tools/inspect-incident.mjs`。

### 修复

- **历史事故的定位信息在刷新后丢失(真 bug)**:事故包 `summary.topScripts[]` 在**捕获那一刻**就把 `pkg` / `pkgVia` / `file` / `line` / `lineVia` / `lineScope` / `invoker` 算好写进去了,但面板的 `scriptEvidence()` **拿当前会话重新现算** —— 现算吃 `state.precise` 与内存里的脚本文本 / sourcemap 分段缓存,**刷新后两者都空**,存好的定位就变成 `null` / `还没预取`。现在新增 `incidentScriptEvidence(script, url, fallback)`(存下来的字段优先,**老包缺字段才回退现算**)与 `incidentEvidenceAt(row, script)`(解该包的 URL 表 + 判断要不要现算);面板(`evidenceScope()`)与「复制摘要」(`incidentEvidenceLines()`)走的是**同一条路**,所以不会出现"面板上有、复制出来没有"。实测(真页面 CDP,一次性脚本用完即删):深录档抓一次(事故包存下 `pkg=section · /plugins/@deepseek-ai/dsh-client-connection/client.js · line 25580 · lineScope=bundle`)→ **把深录与精确归因都关掉**(模拟换台机器 / 过几天再打开)→ **刷新** → 证据行与刷新前**逐字一致**,照样显示「文件 + 合并脚本行 25580」,`errors: 0`;老包(加字段之前抓的)读回时如实显示 `pkg=precise-off line=text-not-fetched`,不崩、不编。
- **合并批把 `file` 与 `line` 拼成一个看着精确、实际指不到任何一行的 `文件:行`**:合并批(`plugins/??a,b`)里 `charPos → 行号` 是相对**合并后大文件**的,而 `sectionPath()` 给的是那个包**自己的源文件** —— 两个坐标系,拼起来像精确定位,实际指不到任何一行。现在 `scriptEvidence()` 多带一个 `lineScope`(`bundle` 合并批 / `file` 单包 URL、单包组合 / `null`),`evidencePlace()` 对 `bundle` **只给文件**,行号由 `evidenceLine()` 单独成段写成**「合并脚本行 N」**,`evidenceWhereText()` 在悬停里也分列(文件 · 合并脚本行 N · pkg/line 两个 via 档);口径文案写明**行号是脚本自己的行号,不是原始 TS/TSX 源码行**(要原始源码行得解 section 内层 `mappings` 的 VLQ,本项目没做)。实测:合并批那几行**绝不**出现 `client.js:25580` 这种串;单包 URL 那一行照旧 `client.js:455`(行号确实属于那个文件)。
- **事故切片没把 `lineScope` 写进包(包自身不自描述)**:以前事故切片只写 `file` / `line` / `lineVia`,合并批的 `lineScope` 靠读回时现推。现在 `script.lineScope = evidence.lineScope` 一起落进 `summary.topScripts[]`,包离开现场后仍能自证"这个行号属于哪个坐标系"。
- 测试:离线断言 **448 → 458** 条(attribution 11 / logic **408** / host 39),`.github/workflows/ci.yml` 的 `-eq 458` 门禁与两处 `Offline suites (…)` 标题同步改;CI 门禁模拟 **PASS**,三条真页面验证器 `check-panel` / `check-storage` / `check-interaction` **ALL PASS**。本轮针对性验证走一次性 CDP 脚本(深录抓一次 → 关掉 → 刷新看证据行 / 合并批那几行不出现 `文件:行` / 回放块在场且刷新后仍可用),全程 `errors: 0`,用完即删。新增静态断言:合并批不拼 `file:line`、老包缺 `lineScope` 时按 `pkgVia` 现推、`pkgZeroText` 已删、回放的三条(`replayScope` 无事故 / 无帧退 `null`、live 帧环为空也照样能回放、`replayX` 按时间线性 + 越界夹住)。

### 修改

- **删掉不可达分支 `pkgZeroText`,断言改成实际渲染的数据(REVIEW §3.4 记的那笔债)**:确认那段「按包:0 条定到名(带分母)· 要深录」**永远渲染不到** —— 外层要求 `window.js > 0`,而 `js > 0` 必然有脚本,脚本要么进 `top`、要么进 `byOther`(且 ms>0),两个条件互斥;旧套件却**直接测那个函数**,于是一直绿。现在死分支与函数一起删掉,测试改成断言**面板真正吃的那份数据**:喂给「按包」堆叠条的就是 `whoRows(tally)`,一个包名都没定到时看到的是**按原因命名的「其余来源」段(带名字与毫秒)** —— `插件批次(未按 sourcemap 拆)` / `无 URL(内联脚本)` / 外壳文件名,不是一行"0 条定到名";另加一条静态断言:全仓不再有 `pkgZeroText`(死代码不许回来)。

### 新增

- **「可疑脚本」:把证据落到个体脚本(证据 → 代码定位)**:`incident.summary.topScripts[]` 里早就带着 `sourceFunctionName` / `sourceCharPosition`,但**面板从来不显示**它 —— 事故包里有"哪个文件的哪一段"的原料,界面上只看得到按包 / 按来源的排行。新增一块(在「取证明细」组内,组折叠时不计算):把「事故 → 帧 → 来源 → 包 → 文件:行」落到**个体脚本**,最多 `EVIDENCE_MAX = 4` 行、按耗时降序;**只列能定位的行**(函数名 / 包名 / 文件至少有一个 —— 一个定位字段都没有的行不再占名额,它只是"函数名未记录 @ 包未定名 + 一个毫秒数",占名额还不缩小范围);标题写明范围(事故优先:`可疑脚本 · 事故 i84 · 窗口内` —— 事故脚本是窗口切片、跨会话读回仍在;没有事故脚本时才退回 `可疑脚本 · 本帧`);每行 `<函数名> @ <包名>` + 毫秒,悬停给完整证据行,**点击复制**「函数 @ 包 · 文件:行 · 耗时 · 来源」;底下一行给**分母**(`11条脚本 · 定到包 1/11`,分母按**全部**脚本算 —— 过滤不会把"没定到名"藏起来)+ 口径 + 缺什么;一条能定位的都没有时(没开深录 / 脚本被压掉函数名),整块收敛成**一行带分母的说明** `可疑脚本:0 条定到名(窗口内 11条脚本)· 要深录` + 一行"缺什么"。**口径三档写进产品里**:① 直接测量(函数名 / 毫秒 = LoAF 给的);② 归因推断(包 / 文件 / 行号 = URL 与 sourcemap 分段推的,`viaText` 压成五档:直接读出来 / 分段推断 / 不是插件脚本 / 解析失败 / 还没到位);③ 尚无法确认(原始源码行号 / 调用栈 / 函数级耗时)。⚠️ **行号是脚本文本自己的行号,不是原始源码行**(那要解 section 内层 `mappings` 的 VLQ,没做);**光有行号不算能定位** —— 合并批里 charPos → 行号是相对那个几十包合起来的大文件,不知道属于哪个包时它指不出任何可打开的东西(实测非深录档会出现 `line=25580` 而 `pkg` 为 null)。新管线:`sectionSource` / `sectionIndex` / `sectionPath`(给"哪个文件")、`scriptPosition(url,charPos)`(字符位置 → 行号,带 via)、`scriptEvidence(script,url)`(一条脚本的证据)、`evidenceName/Place/Line`、`incidentEvidenceLines`、`evidenceScope/Footer/ZeroText`、`locatable(rows)`;`assembleIncident` 的 `summary.topScripts[]` 多带 `invoker` / `file` / `line` / `lineVia`,`howToRead` 补 4 条(文件与行号的口径、直接测量 vs 归因推断、invoker 的含义、交互只给端到端)。
- **`复制摘要` 变成可直接交接的取证件**:= 结论 + 口径 + 可疑脚本证据行 + 「窗口内 ≥100ms 的交互」(有才写,标明端到端、不拆帧内)+ 缺什么 —— 目的是**能直接交给另一个 AI 接着查**,而不只是一句结论。
- **「最差事件」新增「最近 / 最差」切换**(`state.watch.scope`):默认最差(严重度最高),一键切到"时刻最新";点击会清掉手选(`selId`),状态在下行写明 `自动·最差` / `自动·最近` / `已选中`,`resetLayout()` 也会把 scope 归位。

### 修复

- **组合 URL 的"文件路径"被截成 `/plugins/`**(真 bug):`new URL(url).pathname` 对**组合 URL**(`plugins/??…`)会把第一个 `?` 当成查询串开始,pathname 只剩 `/plugins/` —— 于是"文件路径"就显示成 `/plugins/`。现在组合 URL 走正则自己拼(单包组合 ⇒ `plugins/<包>/<文件>`);有断言钉住(断言里同时钉住 `new URL` 的 pathname 就是 `/plugins/`)。
- **合并包分段表的 `names` 没跟 `offsets` 一起排序**(真 bug;一直没暴露是因为没人读过它):`offsets.sort()` 之后 `names[i]` 与 `offsets[i]` 从排序那一刻起就说不上是同一段,加上 `paths` 之后这个错位会直接变成"包名 A 配文件 B"。现在 offsets / names / paths 一次建成同一张表再一起排序。
- 测试:离线断言 **417 → 448** 条(attribution 11 / logic **398** / host 39),`.github/workflows/ci.yml` 的 `-eq 448` 门禁与两处 `Offline suites (…)` 标题同步改。

### 修改

- **悬停联动:停用 + 把辅助代码删干净**(不留半活的死代码):`hot` / `setHot` / `hotProps` / `hotStyle`、各处的 `hot === …` 分支、交叉表格子的 `lit` 加粗、环的 `stroke-width 17/13` 切换、图例随 hot 加粗,整套删掉;渲染区里留了一条**可执行的复现说明**(含"去外壳日志里 grep `slot entry crashed`")。2026-10-11 用真实鼠标扫过交叉表容器内全部 **163** 个元素(每个来回两次)+ JS 直接派发 **153** 次 `mouseover`:面板全程存活、`errors: 0`、环数不变、控制台无输出 —— **复现不出来**(踩坑记录:探针的 console 钩子必须装在同一次 `reload` **之后**,否则随旧文档一起被清掉,等于没在监听)。新增回归断言(静态):渲染区不含 `onMouseEnter`/`onMouseLeave`;全仓不再有 `hotProps(` / `hotStyle(` / `setHot(`;那条停用说明里点名了外壳日志的关键串。
- **首屏控件按需出现,不留"点了没反应"的动作**:「全部折叠」只在**有组开着**时渲染(`anyGroupOpen()`);「恢复默认布局」只在 `layoutDirty()` 为真时渲染(有组开着 / 翻帧被钉住 / 手选了事故 / scope 不是"最差" / 挂着一次性说明);两者都无意义时**整行不渲染**。没有新增任何排行榜 / 指标卡 / 装饰图。
- **词条 `evAuto` 拆成 `evAutoWorst` / `evAutoLatest`**:旧的删了,免得留死键 —— 词典有"每个键都得有人引用"的断言(中英成对)。

### 新增

- **首屏重排:先给结论、再给证据,起点是「最差事件」**(P0 布局可读性)。顺序固定为 概览(`概览 · 近 60 秒`)→ **最差事件**块 → 回调归因 Top3 → 布局工具(全部折叠 / 恢复默认布局)→ 5 个折叠组;「最差事件」块是"事故 → 证据 → 来源/包"那条链的入口(严重度 + 时刻 + 三个真动作:定位到帧 / 下载事故包 / 复制结论)。严重度分三档(`severityLevel`):≥200ms `bad`(与面板判色红档同一条线)、≥100ms `warn`(守夜触发线)、其余 `ok`;面板**文字 + token 颜色两样都给**,不只靠颜色。
- **事故选中上下文**(P1 可追溯诊断):新增 `state.watch.selId`(存 **id** 不存下标)+ `selectedIncident()`(默认自动跟**严重度**最差那条;选中的被挤出留存清单就退回自动)、`selectIncident` / `revealIncident`。工具箱清单行可点选(选中的那行出现 `●`,首屏「最差事件」块显示「已选中」);`revealIncident('i84')` = 选中 + 展开「取证明细」+ 把翻帧钉到该事故开始时刻最近的**长动画帧**,**并且限定在事故窗口内** —— 跨会话读回的事故离当前帧环可能几百秒,那时"最近的帧"是无关帧;定位不到就写一句如实说明(`state.pickNote`),而不是让按钮点了像没反应。
- **可复制 + 只有一个真手型**:`copyText`(复制成功/失败**都照实显示**),按来源/按包小表行可点复制(实测具名行 8/8 有手型,点一行之后「已复制」照实出现);堆叠条色段的**假手型去掉** —— 那段本来不是按钮,给手型等于骗人点。
- **60 秒帧条可导航**:块式铺满一行(实测 `width 100%`、宽 365px)、挪到「取证明细」**最前**;每格给 `title`(墙钟时间 + 该秒最差帧 + 点得动/点不动)。新增 `sparkPickMap`:**只有那一秒真的有 LoAF 的格子可点**(点了把翻帧切过去),其余格子不给 `onClick` —— 不做"点了没反应"的假按钮。
- **宿主 event-loop 那一行补上 `max`**:宿主半 `index.js` 早在采,面板一直没显示,而 max 才是"最坏卡了多久"。老版本宿主半没有 `max` 字段时如实只给 p50/p99,不补 0。
- **折叠组惰性渲染**(P2):`group(key,label,summary,...children)` 现在支持传**一个函数**当子节点 —— 折叠时连函数体都不进。5 个调用点(detail / cross / dom / host / tools)全传 thunk,折叠组不再每个 tick 重算派生统计。
- 测试:离线断言 **375 → 417** 条(attribution 11 / logic **367** / host 39),`.github/workflows/ci.yml` 的 `-eq 375` 门禁与两处 `Offline suites (…)` 标题同步改;真页面三条验证器(`tools/check-panel.mjs` / `check-storage.mjs` / `check-interaction.mjs`)都跑过并 **ALL PASS**;另做了一次一次性 CDP 深检:5 个组全展开渲染 **0 错误**,真实鼠标移到 5 个行级元素(按包小表行 / 事故清单行 / 组头)都没有条目被外壳停用,`capture()` 造事故后清单可点选、「已选中」照实显示,堆叠条色段 0 个手型。

### 修复

- **翻帧口径统一:新增 `frameSeverity(row) = max(blocking, dur)`,`worstLoaf` / `loafRanks` / `pickList` 三处共用**。以前 `worstLoaf` / `loafRanks` 只看 blocking、`pickList` 看 max,于是"自动选中的那条"可能**不在翻帧清单里**,标签显示成 `帧 0/N`(同一份数据两个答案)。现在有一条断言钉住"自动选中的那条一定在清单里"。
- **窗口聚合的缓存指纹与异步解析脱钩**(真 bug):`scriptPkgTally` 的指纹原来只有 `条数|最后一条 t`,与**异步**到位的 sourcemap 分段表 / 脚本文本无关 → 环满 200 条而一时没有新 LoAF 时,「窗口」那三行与「包 × 来源」交叉表会**永久冻在**"插件批次(未按 sourcemap 拆)",而同屏「本帧」行已经给出真名,打开深录也不刷新(证伪"等下一次 LoAF 就会自己好")。现在指纹带上 `resolveSeq` —— 每个 `entry.state` 写入后与 `setPrecise` 各推一次,由 `markResolved()` 负责。

### 修改

- **DOM 写入(次数 + 按插件估算)从「取证明细」挪到「DOM 与堆」**:前者回答的是"这一帧的时间去哪了",DOM 写入不是帧内时间。
- **文案与口径修正**:`avgPerFrame` 中文「平均每条脚本」→「**平均每帧脚本**」(除数其实是帧数,英文本来是对的);`pkgHint` 拆成**本帧**与**窗口**两条(`pkgWindowHint`);交叉表标题改成 `包 × 来源 · 窗口` 并在 hint 里写明它是窗口**累计**;`framePickHint` 不再写"blocking ≥ 100ms / 按 blocking 降序";`watchLatestText` 更名 `watchSelectedText`(跟的是**选中的那条**,不再是硬编码 `incidents[0]`);新增 `watchFlagText`,只在"读回 / 裁掉 / 落盘失败"这类还有话要说时才出现(未开录与"还没抓到"都不重复);`overviewLine1()` 去掉 `(最差那条:未归因)` 后缀 —— 它与紧接着的 `overviewLine2()` 里的 `最差那条:<归属>` **触发条件完全相同**,相邻两行必然把同一句话说两遍;`eventValueText()` 把"未开录 / 还没抓到(≥100ms)/ 严重度"三种状态收进一行,不再另起一行重复。i18n 中英各 **211** 键(成对)。

### 新增

- **「帧里花在哪」从三段饼改成四段饼,脚本那一侧再拆三层**:
  - **环放大到 84px、最多 7 段**(`frameArcs`,只做分区:各段之和恒等于整帧):48px 的环周长只有 126px(1% ≈ 1.3px),段一多就分不出来;84px + `r = 34` + **段间 1.4px 缝**(`raw > 2×缝` 才扣,小段保原长;推进量按原始长度走,缝才落在段与段之间)。四类:脚本(被 LoAF 归到脚本的同步 JS)/ 任务里没归到脚本的那部分(短于上报阈值的脚本 + 事件派发 / 微任务 / GC)/ 渲染 / 样式+布局+绘制。**任务那段改成中性灰** —— 它现在和脚本的四个红同处一环,再用红会分不清。图例两行(四个百分比挤一行会折行,改文案时用真页面量过行高)。
  - **脚本那一段在环上再按「调用来源」切成最多 4 块**(同一个红 `1 / 0.72 / 0.46 / 0.28`,由深到浅 = 耗时降序,顺序与下面「本帧按来源」那行一致):这一帧里 >5ms 的脚本有几条,环上就有几块。实测大多数帧只有 1~2 条(一个任务里连着做 timer + 事件 + 微任务,LoAF 仍然只报一条 `setTimeout`),多来源要看「·窗口」那几行。脚本那段在 `frameSplit` 里被夹到 ≤ 任务段,而按来源的原始求和可能更大(渲染阶段跑的脚本也算在 `scripts[]` 里)—— 那种情况按比例缩,不然弧会互相盖住。
  - **脚本三层** = 纯执行 / 强制样式布局(`forcedStyleAndLayoutDuration`)/ 暂停(`pauseDuration`)。三者是 `scripts[].duration` 的**分区**(相加 = 脚本耗时,不是另加);**为 0 的两项不显示** —— 大多数帧里它俩就是 0,写出来只是噪声(实测窗口那行带上 `暂停 0ms` 会在 396px 里折行)。`pauseDuration` 此前只被写进事故包、**没有任何界面读它**。
  - **两个分母说清楚**:原来那张饼是**单帧**(blocking 最大的那条 LoAF),下面「脚本按包 / 纯 JS vs 强制布局」却是**整窗聚合** —— 同一张面板上两个词、两种分母,数字对不上账。现在四行都带范围:「脚本细拆 / 本帧按包」= 饼图那一帧(新增 `framePkgTally`),「脚本细拆·窗口 / 脚本按包·窗口」= 最近 `WATCH_LOAF_MAX` 条的聚合(原 `scriptPkgTally`,仍按窗口指纹缓存)。
  - **按来源再拆一层**(`invokerLabel`):脚本耗时按 LoAF 的 `invoker` 汇总 —— 「这条脚本是谁调起来的」。真页面抓到的一份事故里 24 条脚本按 invoker 是 **`DOMWebSocket.onmessage` 19 条**、`TimerHandler:setTimeout` 2、`Response.json.then` 2、脚本加载 1 —— 也就是说那几帧的脚本耗时大头是**会话事件流的消息处理器**,不是定时器也不是渲染,这是原来给不出的答案。归一规则:`SCRIPT[…]` → `script`、带冒号取最后一段(`TimerHandler:setTimeout` → `setTimeout`)、截 28 字符、缺失退到 `invokerType`。它与「按包」是**同一份耗时的两种切法**:按来源覆盖全部脚本(合计 = 脚本耗时),按包只覆盖定得到包名的(合计 ≤ 脚本耗时)—— 两个合计**本来就不相等**,有断言钉住(160 vs 150)。
  - **顺带修掉一处误读**:按包那行原来只在"一个包都没定到"时才提未定名,于是窗口里 1116.8ms 脚本只定到 200ms 时,那行看起来就是"这一层只有 200ms"。现在尾巴上跟 `· 未定名 8`;六行改用**块式**布局(en 值宽实测 352px、行宽 365px,真数据下 `按来源·窗口` 会占两行,右对齐会折成参差两行)。
  - **`frameSplit` 全部向下 clamp**(`js ≤ head`、`forced + pause ≤ js`、`exec ≥ 0`):每条脚本的毫秒各自 `round1`,脚本多而每条约 0.05ms 时求和会超过父区间 —— 不夹就会画出负长度的弧。三条都有断言。
  - 顺带修掉饼图 tooltip 里硬编码的 `脚本 ${js}ms`(en 用户会看到中文),改用 `splitScript` 键。
  - **函数级那一层实测走不通**:页面内唯一的采样剖析器是 JS Self-Profiling —— `typeof Profiler === 'function'`,但 `new Profiler({sampleInterval:10})` 抛 `NotAllowedError: JS profiling is disabled by Document Policy.`,因为 HTML 响应**没有** `Document-Policy` 头(实测 `null`),而那个头由 DSH 服务的 HTML 决定(动它就越过项目边界)。→ 函数级只剩 CDP / DevTools Performance(`missing` 里的 `devtools-trace`);宿主进程的函数级另有 A5 的 `node:inspector`。
  - **窗口那三行补上分母**(`windowScopeText`):它们是**累计**,`纯执行 21623.8ms` 这种数不写分母会被读成"某一次执行花了 21 秒"(实测被这么质疑过)。现在窗口行前面单独一行:`窗口:200 条长动画帧 · 跨 43分12秒 · 平均每条脚本 108.1ms` —— 条数与跨度回答"这段时间卡了多少次",**平均每条那一栏才和上面那张饼可比**(饼是单帧)。跨度越久累计越大,所以 hover 里明写"别拿它当越来越慢"。`tallyScripts` 因此多带 `count` 与 `spanMs`(最后一条 t − 第一条 t),`spanText(ms)` 把它写成人读的 `43分12秒`。
  - 测试:375 条离线断言(attribution 11 / logic 325 / host 39),真页面 `tools/check-panel.mjs` 验过(4 个 `<circle>`、`本帧按来源 setTimeout 260ms`、`errors: 0`)。

### 新增

- **「取证明细」可以翻帧了**:圆环上面多一行 `帧 1/12 · 530ms · ≥100ms ◀ ▶ ⟲` —— 最近 200 条长动画帧里**只收值得回看的**(blocking ≥ 100ms,与守夜触发线同一条;刚过 50ms 的边角帧不进榜,一条都不到线时退回全部),按 blocking 降序,◀ ▶ 换一条看,⟲ 回到自动。面板默认**自动跟着最差那条**(它不是按时间刷新的,而是被更差的一条顶掉才换,所以同一条常常挂很久);选过之后钉住,选中的那条被挤出 200 条会自动退回自动(存的是帧的 `t` 而不是下标 —— 帧环会追加新的、挤掉老的,下标会指到别的帧上)。环与「本帧」那组吃的是同一条帧,数字能对着看。实测:自动 `1/16 · 530ms`(环 579.6ms)→ ▶ `2/25 · 275ms`(环 325ms)→ ▶ `3/28 · 170ms`(环 220.3ms)→ ⟲ 回到 `1/… · 530ms`。

### 新增

- **拆解视图改成成熟形态(三刀)**:原来那张环把"帧的四段"和"脚本按来源细分"画在同一圈里(段数从 4 涨到最多 7;层级只能靠同色深浅 + 1.4px 缝表示,84px 周长里 2% ≈ 4px 基本看不见)。现在:
  1. **环只画四段**(脚本 / 任务里没归到的 / 渲染 / 尾部),它就是一个维度;
  2. **「按来源」「按包」各一条 100% 堆叠横条**(Top3 + 其余;段宽按这一维度的总量算所以恒满格,名次由深到浅;每段 hover 给 `名字 毫秒 · 占比`),来源用 brand 蓝、包用 success 绿;
  3. **包 × 来源交叉表**(默认折叠,`state.groups.cross`):只展开 Top3 × Top3,其余行列用减法补足、四块之和恒等于脚本总耗时(有断言);它回答的是"哪个包的哪类回调在烧时间" —— 分开看两张榜单永远答不了;
  4. **三处悬停联动**:共享 key `ring:` / `src:` / `pkg:`,指到条的一段,表里同名的行/列与格子一起亮、其余段压暗一档。

  参考的先例是查证过的:[Chrome DevTools Performance](https://developer.chrome.com/docs/devtools/performance/reference) 把同一份 profile 给 Call tree / Bottom-up / Event log 三个页签,[speedscope](https://github.com/jlfwong/speedscope) 给 Time Order / Left Heavy / Sandwich 三种视图 —— **"多个角度"在成熟工具里是"多个视图",不是"一张图更多段"**;饼/环只在"一个主分组、段数少"时用([Atlassian 的堆叠条指南](https://www.atlassian.com/data/charts/stacked-bar-chart-complete-guide))。Sankey / 平行集**不做**(表达力换来的是可读性)。帧内脚本时间轴**做不了**:LoAF 只给每条脚本的时长,不给它在帧内的起止。

### 修复

- **`clear()` 漏清帧环**:它清了帧间隔环、longTasks、DOM 写入、各类序列,但 `state.watch.loaf`(最近 200 条长动画帧)**没清** —— 于是"清读数"之后翻帧清单的 `帧 1/128` 与「窗口:… 跨 3分」纹丝不动,而屏幕上的时间明明已经重置。现在连 `watch.pickT`(翻帧选择)一起清,并加一条静态断言钉住(改回就红)。顺带确认一条硬事实:`t = entry.startTime` 是**页面时间轴**,所以跨度的上界就是"页面已打开多久" —— 跨度不可能超过它。

- **翻帧清单的判据从 `blocking` 改成 `max(blocking, 帧时长)`,标签也改显示帧时长**:实测一次会话里 **45 帧的 `blocking` 全部 < 100ms**(最大 92ms),于是"只收达线的帧"直接退回"全部",而标签上的 `92ms` 又和圆环的 `帧里花在哪 154.4ms` 对不上 —— 两个读数都在指向同一个困惑。现在:判据用 `max(blocking, dur)`(帧时长才是面板自己的严重度口径:判色 120/200ms、圆环显示的就是它),标签显示帧时长,`blocking` 留在 tooltip。实测同一份数据:清单从"45/45"收到 **3/13**,标签 `帧 1/3 · 242ms · ≥100ms` 与圆环一致。

- **点开「包 × 来源」会把整块面板打成错误边界(面板直接消失)**:`short()` 写的是 `id.replace(...)`,而交叉表"摘要"那行在 **Top3 之间一格交集都没有**时会拿到 `null`(最大的包住在第 4 名的来源里——完全可能) → `null.replace` 抛错 → 面板渲染抛错 → 外壳停用该条目(只能刷新)。两处修:① `short()` 对 null/undefined 返回空串;② `crossTable` 一个正格子都没有时把 `top` 退回"最大的行 × 最大的列"(而不是留 null),摘要改说「Top3 之间没有交集」。另外给这一块加了**可见的**降级:派生统计算炸时只降级成一行错误原文并记进导出件(`crossFailed`),不再把整块取证面板带走。

### 修复

- **脚本拆解那一整块(细拆 / 两条条 / 交叉表)加可见兜底**:任何一处派生统计抛错,现在只降级成一行 `这一帧的脚本拆解算不出来: <错误原文>`(交叉表那层还有自己的 `交叉表算不出来`),原文同时记进导出件的 `errors`。之前一处抛错会把**整块取证面板**交给外壳的错误边界 → 条目被永久停用、面板整块消失,现场只剩"刷新"这一个动作,错误原文也一起丢了(不满足 §1「不许假装成功」)。
- **按包:一个插件包名都没有时不再只剩"未定名 N"**:那种情况下如果「其余来源」(外壳文件名 / 无 URL / 插件批次)有内容,现在会把它们连毫秒一起说出来(`其余来源 index-abc.js 266ms · 无 URL(内联脚本) 12ms`)。上一版的改动在零分支里丢了,有断言补上。

### 修改

- **「按来源 / 按包」从"一整块长文本"改成"每项一行"的小表**:原来是右对齐的一整串(`setTimeout 240ms · script 199ms · …`),折行会折在**名字中间**(实测 `ResizeObserverCallback` / `index-5SrrfWpU.js` 都被劈成两半),读之前得先把断行拼回去。现在是名字左(超长省略号 + title 给全名)、毫秒右(等宽数字),每项一行;`其余` 那一行还带条数(`其余 3 次`)。真页面实测:10 行、**0 行发生折行**(每行恰好 20px)。

- **两条堆叠条的用色与主导段显示**(实测驱动):量出来这个主题里 `--dsw-alias-brand-primary` 是**近白** `rgb(249,250,251)`、`--dsw-alias-state-success-primary` 是**纯绿** `rgb(34,197,94)`,而顶段不透明度取的是 `1` —— 于是"某一段独占 100%"时整条就是一块纯白/纯绿的发光色块,比例信息为零。三处改:① 填充**保持不透明**,名次靠**压暗**(黑色 overlay `0.32 / 0.46 / 0.58 / 0.68`)而不是变透明 —— 这两个 token 在这个主题里是近白/纯绿,降不透明度只会让整条发灰(实测被吐槽「更淡了」),压亮度则保留色相(绿还是绿,只是不荧光);② 小段保底宽度(段改成 `flexGrow: 毫秒` + `flexBasis: 3px`,段间 1px 背景色缝 —— 以前 6% 的段只有 21px × 0.28 不透明度);③ 顶段 ≥ **80%** 时在条右边内联占比(`86%` / `100%`)—— 严重偏斜时"几乎全在一桶"要用数字说出来。条高 10px → **8px**,轨道(12% 白)始终可见。
- **静态检查补一个洞**:「面板渲染区的函数调用都有声明」那条正则的前瞻没排掉 `-`,于是 `linear-gradient(` 被当成裸调用 `gradient(` 报错(CSS 函数名带连字符)。白名单 `CSS_FUNCS` 本来认它,是正则的锅;前瞻补成 `(?<![.\w$-])`。

- **面板减字**(「取证明细」展开后 16 行 → 11 行左右,标签从 5~7 字缩到 2~3 字):
  - **没插桩就不显示需要插桩的行**:`回调归因 0ms/s` 那一整段不再占位(它是"没测",不是"没有开销");`DOM 写入(按插件) 0` 同理;`命中` 只列**非零的腿**(`245/348 · fiber 245 · 未归因 103`,不再是 `245/0/0/0`),比率与概览同一口径。
  - **顺手修掉一个会被误读的数**:`帧内未归因` 只在插桩下有定义(`帧间隔 − 插桩回调`),没插桩时它退化成**平均帧间隔**(实测 16.7ms 被当成未归因);现在没插桩就写「要深录」。同一原因,`unexplainedFrame()` 先要求 `state.deep === true` —— 否则"该帧几乎无 JS 解释"这条结论会在**每一条**长帧上都成立(等于恒报)。
  - **两个小标题接管范围**:「本帧」/「窗口:200 条长动画帧 · 跨 … · 平均每条脚本 …ms」各管一组,行标签不再重复"本帧 / ·窗口";按包那两行在一个名都没定到时收敛成**一行带分母**的说明:`按包:0 条定到名(本帧 1 · 窗口 461 条脚本)· 要深录` —— 直接不显示会让人以为这一层被删了(实测被这么问过)。
  - **定不到插件包名的脚本,现在按原因给名字**(`unresolvedLabel`),不再笼统写「未定名」:URL 空 → `无 URL(内联脚本)`;URL 在 `plugins/` 下但没拆 → `插件批次(未按 sourcemap 拆)`;其余有 URL 的 → **直接用文件名**(多半是应用自己的外壳 bundle —— 实测 `/assets/index-<hash>.js`,React 根容器上的事件处理器就来自它,它本来不属于任何插件)。这些统一收在「其余来源」那段里,带毫秒:`按包 dsh-client-modules 211ms · 其余来源 index-5SrrfWpU.js 234ms`。`tallyScripts` 为此多带 `byOther` 与 `unresolvedMs` —— 只写条数会和同一行的 ms 混单位(实测被读成"按包只有 16ms")。
  - **去掉重复**:`归属 Top` 尾巴上不再重复「记录器自身 N×」(它上面就有独立一行);行距与分节留白一起收紧(`S.row` 5→4、`S.sep` 10/9→8/8)。

### 决策(2026-10-08,逐条讨论后定稿)

- **REVIEW §3 从"缺口清单"改成"待做清单"**:每条都过了优劣、留了结论(A 组证据缺口 5 条、B 组读数修正
  3 条、C 组 2 条、D 组形态 5 条、E 组对外动作)。做与不做各有明确理由,不做的那几条也写清"为什么不做"。
- **发现并记录:插桩此前没有独立开关** —— `start()` 无条件包装调度点与 DOM 写入,所以文档里
  「守夜 = 零插桩」在实现上不成立。决定改成**三种模式、两档采集**(守夜/现场同一档,深录才插桩)。

## [0.3.0] - 2026-10-08

首个公开发布版本。纯客户端性能 HUD:一个浏览器半 + 一个可选的宿主半。

### 新增

- **宿主进程 CPU 火焰图(A5)**:宿主半用内置 `node:inspector` 在**同进程**按需采一段 V8 CPU profile(`Profiler.enable → start → N 秒 → stop`),`Profiler.stop` 回的就是标准 `.cpuprofile`,speedscope 可直接打开。路由形态沿用既有那套(`requestBody: 'buffered'` + `Request`/`Response.json`):`POST {op:'profileStart', seconds?}` —— 默认 **5 秒**、夹 [0.1, 30],**只等"真的开起来"就返回**(采样由定时器后台收尾,不占着 HTTP 请求 5 秒);`POST {op:'profileGet'}` —— 取回最近一次采到的 profile,**没采过回 404「还没采过」而不是空对象**;`GET` 的 `host.cpuProfile` 给状态(`running` / `collected` / `bytes` / `samples` / `meta` / `error`)。四条硬性:① **不常开**(采样本身有开销,只由显式 op 触发)、**单飞**(采集中重入 500 拒绝);② 失败(会话未连接 / `Profiler.*` 报错)**照实回错误原文**,不许假装成功;③ profile **只在内存**,不写任何目录;④ 不改宿主任何原型(`apply(ctx, options)` 的第二参只是测试缝)。两条**实测证伪**写进 [AGENTS.md](AGENTS.md) §8.16/§8.17:① "宿主已开着别的 inspector 会冲突"不成立 —— 同进程 `new Session().connect()` 不需要 `--inspect`,`inspector.url()` 是 undefined,且**多会话并存**(另一会话正在采时再 `Profiler.start` 也不报错,后来的直接接手采样;防互踩的是我们自己的单飞);② 采样密度实测只有 **~180~250 次/秒**(标称 1000Hz),所以 5 秒包只有 ~1000 个采样、**约 10~13KB**(轻负载 11.5KB / 重负载 12.5KB / 边解析 5.5MB JSON 10.3KB)—— 体积由**不同调用栈的数量**决定、不由时长决定。宿主 event-loop 影响实测在噪声内(p50 1.27→1.28ms)。⚠️ 宿主半改动,**要重启宿主才生效**
- **交互延迟采集(event / element timing,A4 的页面内那一半)**:一个 `PerformanceObserver` 同时挂 `event`(带 `durationThreshold: 100`)与 `element`,留最近 200 条;整机导出件给全量、事故包给窗口内的。每条给端到端 `ms`、推导出来的 `waitMs`(输入延迟)/ `handlerMs`(处理器本身)与 `isInteraction`(`interactionId > 0` 才是真交互)。**只进导出件,面板不显示**。**不承诺帧内拆分**:输入延迟 / 处理 / 呈现三段页面内没有 API,已写进 `missing` + `howToRead` 并给出 DevTools 的替代路径;`element` timing 只观察带 `elementtiming` 属性的元素,DSH 页面上恒为 0 —— 照实记 0 并解释原因,不假装采到。真页面实测(CDP 真实鼠标输入):20 条事件入库,`pointerover` 的 `ms 112 / waitMs 0.3 / handlerMs 0.4` —— 正好说明"端到端长 ≠ 页面反应慢"
- **饼图二级:脚本侧按包 + 纯 JS / 强制样式布局**(「取证明细」组里再加两行):「脚本按包」把最近这段 LoAF 窗口的脚本耗时按包汇总(与事故包 `incident.packages` 走同一条 resolve 路),「纯 JS / 强制布局」把 `forcedStyleAndLayoutDuration` 从脚本耗时里单列 —— 它**已经算在**脚本耗时里,回答的是"脚本慢是因为 JS 还是因为样式"。结果按窗口指纹缓存,不让面板每 tick 重算 200×12 条脚本。实测面板给出 `dsh-api-gateway 881ms · dsh-client-connection 312ms · dsh-client-modules 208ms`
- **导出件带跨会话基线(A2)**:每个会话落一条帧分布(`p50` / `p90` / `p99` / 最差 / 帧数 / 时刻 / 会话起点),最多留最近 20 条,写进导出的 `context.sessionBaselines`(整机导出件与事故包都带)。**只进导出件,面板不显示** —— 它不是"现在"的读数;文件里就标明它是**粗参照,不是回归判定**(会话之间的负载、视口、是否插桩都不同,帧数量级能差一个数量级)。事故包 `missing` 里那条"没有对照基线"随之改成"跨机器 / 跨浏览器"
- **面板多一条 60 秒帧条**(「取证明细」组里,100×18 的 SVG):一格一秒、柱高 = 那一秒里最差那一帧的间隔,颜色与导出件 ASCII 帧条带**逐条对应**(≥100ms 红 / ≥50ms 黄 / 其余正常 / 整格 rAF 挂起画成矮灰柱)。以前只能在导出件里看到这一点,现在展开面板就能看出"这一分钟哪几秒抖了";阈值一致性由一条静态断言钉住(两处改一处就会红)
- **导出件补一段落盘审计属性 `context.store`**(`restored` / `trimmedByBytes` / `deduped` / `captured` / `dropped`):事故包的 `context.watch` 里早就有这几个计数,整机导出件却没有 —— 文件离开现场之后,读的人无从判断手上的证据是否被字节上限裁过、读回来的算不算数
- **事故落盘**:留存的事故进 `localStorage`(512KB 上限,超了丢最弱的;写失败如实报 `persistError`),刷新/重启后仍在;每条带 `env.perfOrigin`,跨会话读时 perf 毫秒能对齐墙上时间
- **面板瘦身:把旧方向的东西从界面上撤掉**(面板从 ~20 行 + 4 按钮收到 ~4 行 + 3 件控件):
  - **隔离实验**(候选 / 基线 / 噪声底 / 逐条结果 / 恢复状态 + 3 个按钮)—— 方向已明确不做(让给 `dsh-performance-guard`),而且它要写 profile 的持久化选择,不该放在随手点的位置;能力保留在 `__perfHud.experiment()` / `abortExperiment()` / `baselines()` / `stress()`;
  - **验收四行**(maps / 独立包名 / longtask 归因 / 空闲基线)—— 开发自检,事故包的 `missing` 已经覆盖同一件事;保留在 `__perfHud.verify()`;
  - **场景标记**的清单与独立「标记」按钮 —— 与守夜的「标记刚才」重复;备注输入框保留(它就是写进事故包的 note),标记列表保留在 `__perfHud.marks()`。
  工具箱摘要也从「隔离实验 idle · 场景标记 0」改成「守夜 6 次 · 最差 202ms」(收起时看得见的东西必须和组里的东西一致)
- **长动画帧的时间去哪了:饼图 + 占比**:LoAF 的三个时间点(`t` / `renderStart` / `styleAndLayoutStart`)能拆出三段 —— 脚本侧(任务 + 同步 JS)/ 渲染(rAF 回调)/ 样式+布局+绘制。面板「取证明细」里给一张三段甜甜圈 + 一行占比(hover 给 ms 与其中脚本耗时),渲染工具也在每条长动画帧后面画一条 ASCII 条 + 窗口合计。**实测两个环境(用户真实包、本机 headless 自测)都是「脚本侧 99%」** —— 绘制与合成**分不开**(要分只能录 Chrome trace,已在缺失声明里),所以第三段是"剩下的都在这儿",不能读成"样式布局占比"
- **导出的文件名改成"人读得懂的时间 + id"**:原来是 `perf-hud-incident-i84-2026-10-08T14-05-55-043Z.json`(ISO + **导出**时刻),既难读、又和面板上显示的本地时间对不上。现在用**事故发生时刻的本地时间**:`perf-hud-20261008-220358-i84.json` —— 日期在前可排序、无冒号(Windows 合法),完整 ISO 仍在文件体里。顺带把本地时区偏移记进 `env.utcOffsetMin`,否则只读文件的人算不出本地时间
- **基线"跨度"不再冒充观察时长**:一份真实包里它横跨 **21.3 小时**(标签页开了 21 小时、rAF 大部分时间挂着),而"真的在跑"只有 198s。现在写成「覆盖 21.3 小时(其中真的在跑 198s → 56.9fps)」,并在跨度 >10 分钟时警告"倍数看趋势别当精确值"
- **事故包三处口径修正(来自一份真实新包)**:① `summary.pkgVia` 给出每条脚本"是怎么定名的"完整分布 —— `missing` 里那句原来只数 `topScripts`,会写出「2/11 没定到(not-plugin×1)」这种自相矛盾的话;② 宿主快照年龄可能是**负的**(快照在事故之后才采),文案原来一律说"事故前",现在按符号说「事故后 Nms」;③ 渲染工具在基线太薄(<200 帧,刚刷新不久)时明确警告"这个倍数不可信",别让人拿着 ×19 去改代码
- **修掉「导出最近一次」导错东西**:那个按钮点的是下标 0 —— 而列表按**严重度**排序,下标 0 是**最差**的那条,不是最近的;落盘读回的旧事故常常正是最差的,于是"导出最近一次"反复导出一份几天前的证据(实测踩过两次)。现在按**时刻**取最新(`exportIncident('latest')`),并把「按 id 导指定一条」写进按钮 hover
- **LoAF 脚本 → 包名**:合并批里"是谁"原来只能给到那个 58 包的 URL。现在按
  `sourceCharPosition` → 行号 → sourcemap 分段表还原包名(单包 URL 直接读),并按包汇总
  `incident.packages`、给出 `summary.pkgCoverage`;拿不到时 `scripts[].pkgVia` 写清为什么。
  换算要那段脚本文本,所以按 URL 后台预取、只留行起始偏移(逐 UTF-16 code unit 数换行)。
  实测一次事故 37/37 条脚本全部定名,归到 `@deepseek-ai/dsh-api-gateway`
- **修掉"同一次卡顿裂成三条事故"的根因**:`PerformanceObserver.observe({ buffered: true })` 在每次重新挂观察器(`disable→enable`、HMR 重载)时会把最近 200 条 LoAF 重放一遍,同一个 `startTime` 于是被重新触发 —— 面板上同时出现过 `i2 / i29 / i31`,时间戳一模一样。去掉 `buffered`,并按 `at|cause` 去重兜底(缺这两个字段的条目不参与去重)
- **取证明细摘要砍到只留结论对**(`最差秒 152ms · 未归因 17ms`):加上 DOM 写入那一段后,真实量级(五位数)在 396px 里会挤成两行 —— 而原来的长度预算断言用的是桩里的小数字,一直没发现;现在桩里塞五位数
- **落盘上限 512KB → 2MB**:实测一个晚上就被裁了 6 次,实际只留得下 8 条
- **id 跨会话不再撞、同一条事故不再占多个留存位**:恢复时按 id 去重(去掉的条数记 `deduped`),新事故的序号从读回的最大 id 之后继续 —— 真实落盘里出现过**同一条事故被存了三遍**(占掉 3 个留存位,原因没复现出来:`disable→enable` 不重复),以及新会话的 i2 与上一次会话的 i2 撞号
- **baseline 的 fps 改用"真的在跑的时间"**:原来用首尾跨度做分母,中间夹一次 22.7 秒的挂起会把 60fps 算成 43fps;现在另给 `busyMs`(Σ 帧间隔)
- **summary 补窗口自己的 p50/p90/p99**:没有它,包里那句"拿 summary 和 baseline 比"在文件内根本执行不了(只读文件的读者就卡在这)
- **口径打架的两处文案修掉**:`howToAdd` 里"用 blocking=0 与 scripts 为空互相印证"和 `howToRead` 里"blocking=0 不等于没卡"自相矛盾;`missing` 里"宿主 CPU profile 只有宿主 event-loop 也高时才值得做"的前提在本事故里是错的 —— 改成按**快照年龄**说清(实测那份快照是事故前 6.2 秒采的,可能完全没覆盖)
- **基线口径修正(来自一份真实事故)**:真实数据里出现了一帧 **983.7ms** —— 前后都是 16.7ms(正好 60fps)、没有任何 longtask/LoAF 与它重叠,而且它恰好卡在 1 秒间隙线下面被当成"真卡顿"。三处改动:① `incident.baseline` 现在**排除本窗口**(含自己就永远"比不上",原来给出 ×1.00 把 983ms 的尖刺判成正常);② 新增 `summary.worstFrameJs` / `worstFrameNeighboursMs` / `suspectedThrottle`(≥500ms + 无 JS 重叠 + 前后帧中位 <100ms → 更像 rAF 被浏览器节流/挂起);③ 渲染工具的"对比"改成区分**单帧尖刺**(看最差帧倍数)与**慢性劣化**(看 p50)
- **常显瘦身:4 块 → 3 块**。「帧内未归因」搬进「取证明细」组(数字挂到该组摘要上:`最差秒 186ms · 未归因 50ms · DOM 写入 3288`);常显只留「概览 / 回调归因 Top3 / 守夜」。实测展开态省 2 行、折叠药丸多出「抓到 N 次」
- **落盘容量口径补齐**:原来只裁落盘那份、内存仍留 10 条 —— 面板说「抓到 10 次」刷新后可能只回来 7 条。现在内存按同一份裁,并单独记「裁掉 N」
- **守夜层上到面板**:常显区一行(`抓到 N 次 · 最差 X ms` + 最近一条的时刻与备注)、工具箱里最差几次的清单与「标记刚才」/「导出最近一次」两个按钮、折叠成小药丸时也显示抓到几次。之前只有控制台 API,等于要求人记得敲命令
- **事故包瘦身(URL 抽表,schema 2)**:实测一份事故 116.6KB 里 **75.4KB 是同一个 2.9KB 的 combo URL 重复 27 遍**(导出的缩进版 138.6KB 里还有 14.7KB 被 `topScripts` 又抄了一遍)。改成 `incident.urls` 字符串表 + `scripts[].u` 下标之后:紧凑 **29.6KB** / 导出 **51.5KB**、512KB 从放 4 条变成放 **17** 条,信息一点没丢。同时留存条数 5 → **10**
- **事故包 v2(按一次独立盲读的反馈改的)**:加 `incident.baseline`(整个帧环的分布,用来判断"这一段是不是真的比平时差"而不是只看绝对值)、`env.viewport/devicePixelRatio/hardwareConcurrency`(渲染环境)、宿主 `snapshotAgeMs`(原来那个 `lagAheadMs` 口径没定义);`howToRead` 补三个坑(frames 与 loaf 是同一信号的两个视图、`blocking=0` 不等于没卡、longTasks 不是慢帧清单);`missing` 补 compositor / 记录器自开销 / 对照基线,`howToAdd` 补零成本检查(`chrome://gpu`、Rendering 面板的 Frame Rendering Stats)
- **守夜层(默认常开、不插桩)**:帧级环形缓冲(12000 帧)+ LoAF 观察器;一帧 >100ms 自动抓「前 10 秒 + 后 3 秒」原样切片,只留最差 5 次;`__perfHud.watch() / incidents() / report() / exportIncident() / capture() / clearIncidents()`;事故包自带缺失声明(没有 DevTools trace、没有宿主 CPU profile 都照实写)
- **四条腿长任务归因**,同时给出不一致的两条:`fiber` 祖先走查 / `子树` 走查(`alternate === null`,补"整棵挂载"的空档)/ `DOM 写入` 插桩(1/10 采样,估算带 `≈`)/ `包名`(调度点插桩 × 长任务时间重叠)
- **精确归因**:按合并 bundle 自带的 indexed sourcemap 分段还原单包名(懒加载,同一个 rev 只拉一次 map)
- **隔离实验**:逐个关闭候选插件 60 秒 → 恢复并逐项核验;A/B/A 对照 + 噪声底;所有窗口注入同一份合成负载;窗口含流式时标"不可比"且不给结论
- **宿主半**:事件循环 p50/p99/max(`monitorEventLoopDelay({resolution: 1})`)、`session/event` 到达延迟(公开 `ctx.on`)、bundle 读写代理(带 `confirm` 安全线)
- **面板分层**:常显只留"现在顺不顺 + 谁的锅",四个折叠组各带一句话摘要;按显示值指纹渲染(未变则跳过重绘)
- **导出 JSON**:`timeline` / `longTasks` / `isolation` 三段 + `context` 自描述头(场景、阈值、map 状态、版本)
- **场景标记**与**渲染卡顿自测**(显式燃烧,面板标注"人为燃烧")
- 链路 RTT / 吞吐时间线;宿主事件到达延迟开关;`window.__perfHud` 控制台 API

### 修复

- **事故包 `missing` 里两处与实现矛盾的声明改准**(`missing` 的职责是"这份文件缺什么",不是"这东西有没有做"):① `host-cpuprofile` 原写「宿主进程的 CPU 火焰图…拿不到」,而 A5 的宿主路由**已经能采**(真宿主实测 1 秒 = 292 节点 / 223 采样 / 82KB)—— 改成「宿主 CPU 火焰图**没有自动采**:路由支持 `POST {op:'profileStart', seconds}` / `{op:'profileGet'}`,但客户端还没接线,要的话手动打一次」,`howToAdd` 那条也从「`kill -USR1` → chrome://inspect」改成**一上来就教怎么走插件自己的路由**(SIGUSR1 那条退成备选);② `recorder-cost` 原写「本记录器自身的开销没有独立测量」,而 A1 早把它测在面板「记录器自身」与整机导出件的 `context.recorder` 里 —— 改成「**没带在这份事故包里**」。真实页面验过(手动 `capture()` 后 `report('latest')`:`missing` 10 条、两条新措辞都在,`errors: 0`)
- **i18n 兜底跟文档语言**(C2):locale 服务不在时,内置兜底以前写死 `DICT.zh` —— 英文用户会看到中文串;但简单反转(`DICT.en ?? key`)又会让中文用户看到英文,同样错。现在先看 `document.documentElement.lang`(取不到退 `navigator.language`):是中文用中文那本,其余(含认不出来)用英文那本,两本都没有才原样返回键名。顺带清掉 **32 个没人引用的死键**(面板撤下后遗留:隔离实验 / 场景标记 / 验收那批,加上更早的 `fps` / `longtask` / `ltCount` / `hits` / `domWritesShort` / `unattrSuffix` / `watchOnDisk` / `precise` / `preciseHint` / `preciseShort`),两本字典各 **166 → 134** 键;补两条断言把「键集合一致」与「每个键都有人引用」钉住(后再加界面又忘了删键,会直接红)
- **记录器自己被当成元凶**:本 HUD 每帧都在自己的 rAF 回调里跑,四条腿必然命中它 —— 于是长任务常被归到 `PerfHud` / `PerfHudStress` / 本包名头上,读起来像是这个插件在拖慢页面。现在**标注而不静默剔除**:命中的名字显示成 `PerfHud[记录器自身]`,并从「归属 Top」里**单列**(`记录器自身 N×`),`primaryBlame` 在有别的候选时跳过它。不选静默剔除的理由:那会让人读成"这段时间没人干活";标注 + 单列既不改写原始证据,也不必靠注释解释
- **压缩名过滤补边界**:`usableComponentName` 以前只挡「1–2 个字母 + 数字」,生产构建里的 `$c` / `$w` 会混进"独立包名 / 组件名"的读数 —— 它们看着像真名字,比匿名更误导;现在 `$` 开头一律挡掉。断言用**类**(`class $c {}` / `class ChatView {}` / 匿名 `class {}`)钉住三条;括号形态 `(ChatView)` 不在这个函数里处理 —— 它是渲染层给 DOM 写入表"组件兜底桶"加的显示标记,不是入参类型。提交说明里曾写"它更早被 `looksLikeInfrastructure` 挡掉",**那句是错的**:实测那条判据对括号名返回 false
- 同一段窗口里的第二次触发会另立一份事故(实测一次受控卡顿裂成两份,第二份其实又碰了同一段窗口)→ 触发时刻落在上一份窗口内就不再另立,记进 `coalesced`;手动标记例外
- rAF 被挂起(标签页隐藏/系统休眠)后回来的第一帧会被当成"最差帧",面板红一整秒 —— 现在判为间隙:只进帧环并标 `gap`,不计入 FPS / 最差帧,也不触发捕获
- 长任务三个计数判定与窗口不一致(命中口径漏了 DOM 腿、名字分布与累计命中分属两个窗口、`clear()` 未清近因窗口)
- 宿主外壳名被当成归属:`SlotOutlet` / `CenterColumn` / `*Boundary` / `*Provider` / `*Context` 与生产构建压缩名(`n5` / `Bn`)一律跳过
- 误导读数:`0ms/s` 改为 `<0.1ms/s`;归因行峰值速率补单位;「其余」行改用与上面同一套单位
- 空闲基线点名改用窗口增量(原来用累计写入表,空窗口里也会点名)
- 自测四连修:竞态(定时器比渲染间隔短)/ 无反馈 / React 时间切片导致无长任务 / 布局未落在同一任务,最终改为显式燃烧
- 面板条目渲染抛错会让外壳**永久停用**该条目 → 自带 `HudBoundary` 降级并把错误写进导出件

### 调整

- **`release.yml` 的产物核对改成按目录**:原来写死 `tools/inspect-incident.mjs` 与 `locale/en.json` —— 以后加一个验证器或一种语言,漏进包**不会失败**(而 `package.json#files` 里这两个都是目录)。现在显式清单之外,`tools/` 与 `locale/` 各自"目录里每个文件都得在产物里"地核,并补上 `package.json`,合计覆盖包内全部 **18** 个文件;空目录也会报错(而不是静默通过)
- **真页面验证器进仓库**(`tools/check-panel.mjs` / `check-storage.mjs` / `check-interaction.mjs`,共用零依赖底座 `tools/cdp.mjs`):改到面板渲染或 `apply()` / `start()` 路径之后,一条命令就能验「HUD 挂上 + 面板渲染 0 错误 + 目标元素在场」,不用每次手写一段 CDP。`check-storage` 走"写 → 重新加载 → 读回",`check-interaction` 用 CDP 发**可信**输入(合成点击 Event Timing 不认)。它们**不是离线门禁**:要真浏览器 + 本机 `dsh web`,所以 `npm test` 与 CI 里都没有(CI 只对 `tools/*.mjs` 做语法检查);CONTRIBUTING 里"面板改动请附截图"也改成了"跑这条、把输出贴上来"
- **留存策略改成两档并集:全局最差 10 条 + 每天最差 1 条(最多最近 7 天)**。原来只按全局严重度排,于是同一小时里连抓 10 次就能把更早整天的证据全挤掉(实测 `捕获 40 · 丢弃 38`)。现在每条事故带 `day` 与 `tier`(`worst` / `daily` / `both`),工具箱清单里给"当天最差"那档标注,条数上限是 10 + 7;`context.watch.triggers` 与事故包 `context.thresholds` 补 `dailyDays` / `keepMax`,导出件 `howToRead` 说明 `tier` 怎么读
- 概览改块式左对齐 + 主动断行(名字相同时整行不显示);补长度预算断言(36/60/30/30/34/24)
- 隔离实验主指标改用「每帧未归因残差」,并收窄口径为"空闲筛查,不是因果证明"
- 合并判色:FPS ≤50 或最差帧 ≥120ms → 黄;≤30 或 ≥200ms → 红(任一触发即降色)
- 测试:342 条离线断言(attribution 11 / logic 292 / host 39)+ 两个线上套件

### 文档

- **REVIEW 从"待做清单"收敛成"还剩什么"**:已完成那 12 条(D1 / A1 / A2 / A4 / A5 / B1 / B2 / B3 / C2 / D2 / D3 / D5)不再重复列 —— 做法与理由看本文件的「未发布」段,判据与实测证据并进 REVIEW §2(A1 的真实页面读数、B1 的重新归因、B2 的压缩名边界、B3 的 `store` 段、C2 的兜底与词典各加一行);§3 只剩对外动作(转公开 + topic、npm 首发待凭据的两条路、收录 PR)与**三条新尾巴**(A5 只暴露路由还没接进客户端/导出件、D4 的 `stressText()` 死代码、`locale` 的打包边界)。顺带修掉 §2 里"打开「精确」"这类过期指引(那个按钮已并进「深录」)
- **状态改成实话**:AGENTS §11 与 README 顶部(含状态徽章)写清 `v0.3.0` 已 bump / 打 tag / **已推到 origin**、`npm test` 342 条、`npm pack --dry-run` 18 个文件,以及**首发卡在 npm 凭据**(`ENEEDAUTH`)、仓库仍私有、收录 PR 未提 —— 不再让读者以为东西还没做完
- **手册补上这一批新增读数**:README「面板怎么读」收录三档模式(守夜 = 默认 = 零插桩 / 现场同档 / 深录才插桩 + 精确归因)与四个新读数(帧里花在哪的三段饼、脚本按包、纯 JS vs 强制布局、60 秒帧条、记录器自身);AGENTS §7 用开发口径把同几件事写清(绘制合成分不开、强制布局已含在脚本耗时里、强制布局/按包的缓存与静态断言、`SELF_RING`、深录是唯一插桩开关);README_EN 同步一份摘要
- `README.md` / `README_EN.md` / `AGENTS.md` / `CONTRIBUTING.md` / `REVIEW.md` / `CHANGELOG.md`
- **文档收敛成六份**:`README` / `README_EN` / `AGENTS` / `CONTRIBUTING` / `REVIEW` / `CHANGELOG`。
  原来的 `ACCEPTANCE.md`(验收判据与实测数字)并进 [REVIEW.md](REVIEW.md) §2,`DIRECTION.md`(方向取舍)并进
  [AGENTS.md](AGENTS.md) §0.1,`LANDSCAPE.md`(生态与撞车矩阵)并进 [AGENTS.md](AGENTS.md) §12 —— 三份带日期的
  记录文档删除,git 历史里还在

[0.6.0]: https://github.com/yanzhaohui1999/dsh-perf-hud/releases/tag/v0.6.0
[0.5.0]: https://github.com/yanzhaohui1999/dsh-perf-hud/releases/tag/v0.5.0
[0.4.0]: https://github.com/yanzhaohui1999/dsh-perf-hud/releases/tag/v0.4.0
[0.2.0]: https://github.com/yanzhaohui1999/dsh-perf-hud/releases/tag/v0.2.0
