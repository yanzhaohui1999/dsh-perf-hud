# dsh-perf-hud 仓库规则(AGENTS)

> 本文含**项目全局开发规则 + 源码级机制 + 方向取舍**(面向贡献者与 agent)。
> 装什么怎么用、读数怎么看 → [README.md](README.md);发布门槛与未还的债 → [REVIEW.md](REVIEW.md);
> 历史决策与实测证据(不是必读)→ [docs/plans/](docs/plans/);变更历史 → [CHANGELOG.md](CHANGELOG.md)。

---

## 0. 项目边界

**纯客户端性能 HUD**:一个浏览器半(`client.js`,右下角浮层)+ 一个宿主半(`index.js`,只提供事件循环与 bundle 代理两个探针)。
它**测量别人的性能**,所以它自己必须便宜、可关、可还原 —— 这条决定了下面几乎所有规则。

### 0.1 定位:行车记录仪 + 事故包(2026-10-07 起)

要回答的问题只有一个:**"我今天用下来,哪一段最卡、是谁"**。卡顿是偶发的,指望人盯着面板就等于
永远抓不到 —— 所以主体不是"仪表盘",而是**默认常开、事后能回看的记录器**:

| 模式 | 什么时候 | 做什么 | 成本 |
|---|---|---|---|
| **守夜**(默认常开) | 一直 | 帧级环形缓冲 + LoAF 观察器;自动留存**最差 10 次 + 每天最差 1 条**(最多 7 天)并落盘 | 零插桩:只挂本来就在跑的 rAF 与两个 `PerformanceObserver`(LoAF + 交互计时) |
| **现场**(展开面板) | 想看一眼 | **主界面**只回答五个问题(当前状态 / 最近一次卡顿 / 可能原因 / 最近趋势 / 下一步);技术数据进**开发者详情**的五个标签页(帧与归因 / DOM 与堆 / 宿主与链路 / 工具箱 / 原始数据,内层仍是 `state.groups` = `detail` / `cross` / `dom` / `host` / `tools` / `tech`)。**卡顿详情**是"普通用户也会走到"的技术屏,所以它分两层:结论层常显(上下文标题 / 这条事故的两个动作 / 回放范围 / 归因状态 / 历史帧时间轴),技术读数全在默认收起的 `tech`(「技术细节」)里 —— 与开发者详情**共用同一份渲染**(`techGroup`) | 可忽略 |
| **深录**(显式) | 要抓全 | 才打开原型插桩(DOM 写入 1/10 采样 + 调度点抓栈)与「精确归因」 | 有代价,必须显式开 |

> ✅ **这张表现在是真的了(2026-10-08,D1)**:在那之前插桩没有独立开关 —— `start()` 一跑就把 `setTimeout/setInterval/rAF` 与 `appendChild/insertBefore/setAttribute` 全包上,「守夜 = 零插桩」只是文档上的话。现在插桩被拆进 `applyProbeState()`,只在 `state.deep` 打开时装(开关在**开发者详情的标签页行**与设置页 —— 它是开发者开关,不该占标题栏那一行),深录同时管精确归因(两者是「要抓全」的同一件事)。实测:默认 `instrumented: false`,点开 → `true`,点回去 → `false`,面板 `errors` 全程 0。

**明确不做**(生态里已经有人做了;重复做比谁都不做更糟,详见 [竞争与位置](docs/landscape.md)):

- 治理类特性(写盘频控、列表 publish gate、`content-visibility` 补丁)—— `@linxin666/dsh-perf` 的地盘;
- bisection 工作流(隔离 profile + 重启 + 配对 CI/Hedges' g)—— `dsh-performance-guard` 的地盘;
- 宿主侧每插件 CPU / 堆 / 磁盘 / 进程树 —— `dsh-perf-lens` 的地盘(它已有常驻 JSONL 与进程树)。

**仍然不做的事**:

- 不碰 DSH 源码,不注册服务。宿主半**启动时不监听** `session/event`:客户端在第一次成功拿到宿主数据时请求它装一次(每个页面会话一次),装没装上以宿主回执为准并写进面板与导出(`eventWatch.installed` + reason);不想要可以用 `__perfHud.hostEvents(false)` 关掉。口径是「提交(`event.time`)→ 到达监听器」的延迟,不是监听器 CPU 耗时。
- 不写任何自己的持久化状态到 profile;面板状态只进 `localStorage`。
- 不改 `cordis.patch.yml`(它只负责把本包挂进组合),不改 profile 的持久化配置行。

### 0.2 与 DSH 自带开发者工具的分工(2026-10-17)

官方开发者工具(默认关闭的 `@deepseek-ai/dsh-experimental-inspector-profile`)是前台显微镜:Host console / 断点 / Sources / 网络 / Host CPU / Cordis 树,但**没有页面渲染 trace / 堆 / 帧数据**。本插件是常开记录器:刚刚那一下多慢、是谁、能不能复盘。

三条硬性不变:① 不内嵌 DevTools、不连它的 CDP / Worker、不发布到 `ctx.inspector.publish`;② 它抓全量 fetch 含密钥,我们继续走减法脱敏;③ 它不给 Client 渲染 trace,所以 `devtools-trace` 缺失仍然成立。完整对照与三条可靠性改造见 [竞争与位置](docs/landscape.md)。

---

## 1. 仓库硬约束

- **`cordis.patch.yml` 只读**:它是"把本插件挂进 profile"的一行声明,内容变化会触发组合 reconcile,**不要把它当配置面**。插件行为一律靠 `package.json` 的 `dsh.*` 与代码里的开关。
- **禁止在没有 `confirm: true` 的情况下写 bundle 状态**:宿主半的 `setBundle` 会写 profile 的持久化选择,是唯一一个"插件会改用户环境"的操作。它必须:① 显式 `confirm`;② 拒绝改 `dsh-perf-hud` 自己与 `@deepseek-ai/dsh-session-persistence-jsonl`;③ 改动前后逐项核验并恢复。
- **宿主半不许改宿主任何原型**(离线套件有断言钉住);客户端半的原型插桩(见 §5)必须是**可还原**的,`disable()` 后 `W.setTimeout === natives.setTimeout` 等断言必须成立。
- **不许假装成功**:宿主回执、map 解析状态、事件测量是否装上,一律照实显示并写进导出件(`application` / `mapStates` / `eventWatch.installed+reason` 都是这个原则的产物)。
- **不凭记忆写 API**:本项目的每一步(路由注册形态、事件名、sourcemap 形态、DOM 钩子)都来自当场读源码或实测;记忆里"应该如此"的东西(`data-dsh-plugin`、包 `Context.emit`)都被证伪过 —— 见 [归因机制](docs/mechanisms.md) 与 [已知坑](docs/dead-ends.md)。

---

## 2. 环境与验证

**仓库一览**(先认路;顶层文件 + 四个目录各是什么。**行数是 2026-10-19 的快照**,只在"这块有多大"时参考):

| 位置 | 是什么 | 谁读 / 什么时候 |
|---|---|---|
| `client.js` | 浏览器半:采集 / 归因 / 面板状态 / `apply` + 同步包装(3,751 行) | 改客户端行为 |
| `client.*.js` | 包内分片 6 片:model 3,198 / ui 1,265 / watch 726 / i18n 431 / tools 230 / pack 135 行 | 改分片后 **`touch client.js`** 再刷新(见「改动的生效方式」);清单见下面「代码分片」 |
| `index.js` | 宿主半:事件循环与 bundle 代理两个探针 + 路由(456 行) | 改宿主行为,必须重启 |
| `cordis.patch.yml` | 把本包挂进 profile 的一行声明 | **只读**,不当配置面(§1) |
| `locale/en.json` | 插件登记信息(title / description),**不是**面板词典(中英词典都在 `client.i18n.js`) | 发版 / 改市场卡片文案 |
| `tests/` | 三套离线断言(620 条)+ 两套线上 + `fixtures/incident-real.json` | 每次改完(§3) |
| `tools/` | `cdp.mjs` 是底座;五个 `check-*.mjs` 是真页面验收器;`dead-code` / `measure-cost` / `inspect-incident` / `shots` 是人工工具 | 改渲染 / `apply` / `start` 后至少跑 `check-panel` |
| `docs/` | 七份参考文档 + `images/`(9 张 README 截图)+ `plans/`(三份档案 + 索引) | 按需查,别通读(§9) |
| `package.json` | `dsh.client` / `dsh.bundle` 两个挂载点 + `files` 发货清单 | 改挂载、发版(§10) |
| `icon.svg`、根目录六份文档 | 图标;README / README_EN / AGENTS / CONTRIBUTING / REVIEW / CHANGELOG | §9 文档地图 |

**改动的生效方式**(决定你能不能验证):

| 改动 | 生效方式 |
|---|---|
| `client.js` | HMR 轮询 mtime/size;**刷新页面**最稳 |
| `client.*.js`(包内分片) | **`touch client.js` 换掉 rev,再刷新页面**(rev 来自主文件的 mtime/size;分片正文按 URL 记一次,rev 一变就会重读)。只改分片而不动主文件 → 浏览器/宿主都还认旧 rev,看到的是旧字节。详见 [环境与验证](docs/verification.md) |
| `index.js` | **必须重启宿主**(`launchctl kickstart -k gui/$(id -u)/ai.dsh.web`) |
| `package.json` 的 `dsh.client` / `dsh.bundle` | 重装或重启 |
| 纯文档 | 无需操作 |

**代码分片**(DSH 的 package-local chunk,零构建):

| 分片 | 内容 | 何时装载 |
|---|---|---|
| `client.model.js` | 证据链 / 能力矩阵 / 可能原因 / 诊断包 / 视图模型(159 个函数) | `apply()` 与渲染前 |
| `client.watch.js` | 守夜层:observer 回调 / 事故组装 / 落盘(20 个函数) | 同上(采集前) |
| `client.ui.js` | 全部渲染 | `PerfHudGate` |
| `client.i18n.js` | 中英词典(各 405 键,纯数据) | 最前(locale 注册要用) |
| `client.pack.js` | zip(store 模式) | `PerfHudGate` |
| `client.tools.js` | 隔离实验 | 首次 `__perfHud.experiment()` |

分片用 `__ModuleLoader__.load({ id, chunk, factory })` 注册,主文件用 `require.async('./client.<name>.js')`;依赖一律**显式传入**(`createModel(deps)` / `createWatch(deps)` / `createUi(deps)` / `createToolsApi(deps)`),不做反向 import。主文件保留同名同步包装,分片没到位时抛明确错误。改分片后主文件的 `client.js` 要一起被 touch/改到,否则 rev 不变。

⚠️ **装载顺序有依赖**:`apply()` 里 `Promise.all([loadI18n(), loadModel(), loadWatch()])` 之后才 `restore()` 与 `start()` —— 守夜捕获会调模型层的 `scriptEvidence` / `packageOfScript`,`restore()` 会调 `pruneMapCache`。加新的采集期调用前先确认它所在的层已经到位。

⚠️ **重启会杀死当前会话的 bash 进程**(它在 `dsh web` 里):把重启排在报告之后,或交给用户。worktree 里的 `client.js` 浏览器看不到(profile 指向主检出)。真页面验收器要浏览器 + 本机 `dsh web`,不进 CI;改面板 / `apply()` / `start()` 后至少跑 `node tools/check-panel.mjs`。

cookie 三步、验收器清单、401/404 判据、`check-incident` 的 DOM 约定、残留 Chrome 的处置,全在 [环境与验证](docs/verification.md)。

---

## 3. 测试与门禁

**每次改完必须跑三套件**(合计 **620** 条;改文案还要顺带跑长度预算与单位一致性断言):

```sh
node tests/attribution.mjs   # 11 条:客户端脚本 URL 形状 → 包名 / bundle key
node tests/logic.mjs         # 568 条:从 client.js 与分片抽真函数进沙箱 + 静态检查 + 长度预算
node tests/host.mjs          # 41 条:用假 ctx 驱动真实 index.js(路由 / 事件循环 / confirm 安全线)
```

一条命令跑完:`npm test`。线上(先按 [环境与验证](docs/verification.md) 换 cookie):

```sh
DSH_COOKIE=… node tests/live-sourcemap.mjs   # 真实 indexed sourcemap 的分段与包名
DSH_COOKIE=… node tests/live-host.mjs        # 真实路由;退出码 3 = 宿主半还没重启加载
```

测试写法约定:

- **测线上那份代码**:`logic.mjs` 用 `new Function(source + 'return {…}')` 把真函数抽进最小环境,新增函数想被测就加进 `pieces` 列表 + 在桩里补它用到的键。**不要另写一份等价实现来测。** 诊断 / 视图模型、守夜层、词典已搬进 `client.model.js` / `client.watch.js` / `client.i18n.js`:`extract()` 是**分片优先**(同 header 在任一分片里能找到就抽那份),静态检查用 `allSource`(主文件 + 四个分片)。
- ⚠️ **`logic.mjs` 里有三个沙箱**(纯函数盒 / 导出盒 `newPieces` / 守夜盒 `watchBox`),各有自己的 `pieces` 列表与桩。往 `client.js` 加一个函数或常量之后,要把它加进**每一个用到它的盒子** —— 漏一个不会立刻报错,而是等那个盒子跑起来才 `ReferenceError`(实测:`WATCH_EVENT_MS` 只在导出盒里被 `snapshot()` 引用,守夜盒里反而先绿;`pruneIncidents` 漏在守夜盒里时,前面的断言全过、最后一个盒子才炸)。守夜盒的 `state` 是**手写桩**,新状态位还要在桩里补上。
- **口径有歧义就加断言,不要加注释**:注释不能防回归,断言能。
- **词典两条断言是一对(2026-10-13 补)**:死键那条管"词典里没人用",**反向那条**管"用了但词典里没有" —— 后者更隐蔽:`translate` 会退回 key 本身,面板 / 导出件上**直接印出** `exportPreviewCopy` / `viewIncident` 这种内部键名,而三套件与死键断言都不响(实测一次踩了 8 个)。加文案时两条都要绿。
- **静态检查必须有牙齿**:`logic.mjs` 顶部两条(① `h(Uppercase…)` 引用的组件必须声明过;② 面板渲染区里的裸函数调用必须声明过)是"整段替换吞掉相邻声明"事故的回归测试([死路](docs/dead-ends.md) 第 7 条);验证它的办法是把声明删掉看它是否报出名字。
- **宿主半可离线真跑**:`tests/host.mjs` 用假 `ctx`(含 `connection.fetch.register` / `pluginManager` / `ctx.on`)驱动真实 `index.js`,断言路由、事件循环升温、confirm 安全线。
- 断言总数写进 [README.md](README.md) 与 [REVIEW.md](REVIEW.md),**改数字要同步改文档**;CI 里有一条门禁专门核这个。

---

## 4. 提交规范

Conventional Commits,描述用中文:

```
<type>(<scope>): <描述>
```

| type | 用于 |
|---|---|
| `feat` | 新增读数 / 新增面板能力 / 新增导出段 |
| `fix` | 读数错误、口径不一致、误导读数、崩溃 |
| `refactor` | 不改外部行为的结构调整(抽纯函数以便单测也算) |
| `style` | 纯排版(面板布局、文案断行) |
| `docs` | 文档 |
| `test` | 只动测试 |
| `chore` | 构建、脚本、杂项 |

scope 用固定这几个:`client` / `host` / `attribution` / `panel` / `isolation` / `i18n` / `docs` / `tests`。

- 标题 ≤72 字符,**一句话说清"改了什么",不写"为什么"**;为什么放正文。
- 正文值得写长:本项目的正文是**设计决策档案**(为什么放弃包 `Context.emit`、为什么 resolution 收到 1ms、哪条路已证伪)。改动涉及取舍时,把"试过什么、怎么证伪的"写进去。
- 正文里不出现"用户问…/用户嫌…"这类对话转述 —— 直接写现象与结论。

---

## 5. 代码约定

> 面板的可视规则(布局 / 文案 / 交互)在这里只留"规则名 + 做法";**来历、实测数字与逐项清单**在
> [面板约定](docs/panel-rules.md) —— 改渲染 / 文案前读那一份。

**视觉与布局**

- **面板只用 theme token**:颜色只走 `--dsw-alias-*`,不 require 任何 Harness Client 包;字面色仅限插画。
- **整数 px、整数字重**:`11.5px` / `fontWeight: 650` 在 125%~150% 缩放下会合成加粗 + 重新栅格化,观感发糊 —— 用 `12px` / `700`。
- **标签不收缩、数值换行**(只作用于数据行):`label { flex: 0 0 auto; nowrap }` + `value { flex: 1 1 auto; textAlign: right }`;反过来标签会竖排(实测「宿主事件到达」)。标题栏不适用 —— 见下一条。
- **长文本用块式 + 主动断行**:可能超一行的行(概览 / 折叠摘要)用"标签独占一行 + 值左对齐 + `white-space: pre-line` 自己给 `\n`",不赌浏览器宽度。
- **标题栏是一行不换行的工具条,只有文字可以让位**:`S.head` 无 `flexWrap`,分 `headLeft`(可压缩:`minWidth: 0` + `overflow: hidden`)+ `headRight`(控件 `flex: 0 0 auto`);**不许**用某个元素上的 `margin-left: auto` 分组;文字优先级 = 标题 > 场景标签 > 其余;**新增头部控件前先量**(现在 4 个)。**面板自己不是滚动容器**:`maxHeight: 82vh` + `overflow: hidden`,正文走 `S.scroll`(`overflowY: auto`)—— 滚轮滚不走标题栏,「收起 / 关闭」永远够得着。→ 三次事故与尺寸账见 [面板约定](docs/panel-rules.md)。
- **单位一致性**:同一张表里不许一处给 `/s`、另一处给累计;任何"和邻居不同单位"的读数都要有断言。
- **宽度只有一个来源,而且随视口收**:`S.root(open, width)` 收一个 `panelWidthFor(innerWidth)` 算出来的宽度(桌面 = `PANEL_WIDTH` 396,窄屏 = 视口 − 24,下限 240)。收起态不设宽度(内容多宽就多宽,只封顶),整条读数比面板宽时靠 `minWidth` 托住、窄屏转紧凑档丢掉「检测 N 次」—— 钉死 396 会在手机上溢出、在英文下截断(实测 393px 视口:left = −15,标题被切掉一截)。

**文案**

- **能不说就不说**:同一件事不说两遍 —— 名字相同时那一行不渲染,说明文字进 `title`;相邻两行的触发条件相同时只留一处。→ 逐条口径见 [面板约定](docs/panel-rules.md)。
- **长度预算**:概览两行 / 六个折叠组摘要 / 头部视图名 / 圆环图例都有字符上限 —— **数字以 `tests/logic.mjs` 里 `长度预算` 那组断言为准,不要抄进文档**(抄过一次就漂了);改文案必须跑 `npm test`。
- **i18n 词典成对改**:`DICT.zh` / `DICT.en` 同时加键;两条断言钉住**键集合一致**与**无死键**(死键那条只认字面量 `t('…')` / `translate('…')`,要加动态取键得先放宽它);locale 服务不在时按页面语言选字典 —— 写死中文、或反转成 `DICT.en ?? key` 都错。→ 兜底写法见 [面板约定](docs/panel-rules.md)。

**交互**

- **可点 / 不可点的界线(不做假按钮)**:只有"有具体名字或对应一条真实记录"的元素可点;合计行(「其余」)与堆叠条的色段本身不可点。→ 逐项清单(可点 5 类)见 [面板约定](docs/panel-rules.md)。
- **不许挡住别人的按钮**:审批卡(composer takeover,`[data-approval-key]`)的「拒绝 / 允许一次」在卡片右下角,正压在我们这一列上 —— 卡片压过来时让到它上方并跟着收高度,上方也放不下就停左下角。→ 判定规则与实测见 [面板约定](docs/panel-rules.md)。
- **按钮按需出现,不留"点了没反应"的动作**:「全部折叠」只在 `anyGroupOpen()` 时有意义,「恢复默认布局」只在 `layoutDirty()` 为真时渲染;新加布局类按钮前先问"默认状态下点它会发生什么",不会发生就别显示。

**渲染性能**

- **折叠组默认不做昂贵分析**:`group(key, label, summary, ...children)` 支持"唯一 child 是函数"的形式,收起时连函数体都不进 —— 六个调用点全传 thunk;摘要那行即使收起也会求值,所以它只读已经算好的 `detail`。→ 嵌套代价与缓存理由见 [面板约定](docs/panel-rules.md)。

**客户端半的工程约定**

- **插桩必须可还原**:包装 `setTimeout/setInterval/rAF` 与 `appendChild/insertBefore/setAttribute` 时保存原生引用,只在"当前仍是我们那个 wrapper"时才写回(避免踩掉别人的包装)。
- **异步读取统一走 `fetchTextWithin` / `fetchJsonWithin`**(各自有命名 deadline;`stop()` abort 当前代;失败只写 `timeout` / `cancelled`)。源码里的 `fetch(` 必须带 `signal:`,有静态断言;不许再出现裸 fetch。→ deadline 数值见 [面板读数口径](docs/reading-panel.md) §7.1。
- **缓存有上限**:sourcemap 分段表只留最近 `MAP_CACHE_MAX`(8)个 rev,写满配额时先淘汰可重建的 map;内存 `bundleMaps` 同样走 LRU,别让一次长会话把旧 rev 全留住。
- **快捷键只走 `ctx.shortcuts` 可选注入**:macOS / Windows 绑 `Cmd/Ctrl+Shift+U`;Linux Web 的平台白名单不允许这个组合,不硬塞默认绑定。收起/展开**不抢焦点** —— 外壳在键盘命令之后会把焦点还给输入框,跟它抢只会让用户丢焦点。
- **改 `client.js` 一律用带锚点的小批次**:一次替换一个可唯一匹配的片段,失败即整批作废 —— 本项目有**两次**"整段替换吞掉相邻声明"的事故([死路](docs/dead-ends.md) 第 7 条)。

---

## 6. 归因机制

两条最容易踩的:① **`data-dsh-plugin` 在本版本不存在**,包名只能靠脚本 URL 与 sourcemap 分段表反推;② **四条腿覆盖是下界** —— 事件处理器 / Promise / 微任务不在调度点插桩里。

URL 形态、分段换算、四条腿边界、宿主 API、`locale/` 的 ENOENT 坑,全在 [归因机制](docs/mechanisms.md)。改归因链路前必读。

---

## 7. 面板读数口径

> 完整口径(场景标签 / 计数与留存两套 / 帧严重度 / 上下文分流 / 回放 / 拆解铁律 / 记录器可靠性三条)
> 在 [docs/reading-panel.md](docs/reading-panel.md) —— **改面板读数或渲染前必读**。

- **场景标签**(标题栏 `流式` / `空闲 Ns`)是解读所有数字的前提;空闲基线要 60 秒净增为 0 才算真的空闲。
- **帧严重度只有一个口径**:`frameSeverity(row) = max(blocking, 帧时长)`,判据 / 排序 / 标签共用同一个函数。
- **实时与历史共用视觉组件,但不许共用一个错误的上下文**:分流只在 `detailContext()` 一处。

## 8. 已知坑

最容易付代价的几条(**规则本身在 §1 / §5,这里只记症状与代价**):

1. **不凭记忆写 API**(§1)—— 每一步都来自当场读源码或实测。
2. **改 `client.js` 的纪律** —— 带锚点的小批次、插桩可还原,两条规则见 §5;违反的代价是"整段替换吞掉相邻声明"把面板整块搞没(两次),以及"按次数替换"把自计时插进了没有那个变量的 `start()`(见 [死路](docs/dead-ends.md) 的「整段替换吞掉相邻声明」与「批量替换会改到同名调用点」)。
3. **改渲染 / `apply()` / `start()` 必须真开一次页面** —— `node --check` 与三套件看不出模块作用域的裸标识符,也看不出只在该路径抛的错。
4. **改 `client.js` 时不要同时跑受控实测** —— HMR 会换实例,seq 归零。

完整清单(19 条:caret 上界静默禁用、buffered 重放、`blocking=0`、单帧尖刺、inspector 多会话、profile 采样密度…)见 [已知坑与已证伪的死路](docs/dead-ends.md)。

---

## 9. 文档地图

> 六份活文档 + 七份参考资料 + 一份历史档案。**不在根目录新增带日期的记录文档** —— 结论并进对应文档,历史进 [docs/plans/](docs/plans/) 或 [CHANGELOG.md](CHANGELOG.md)。

**活文档**(每次开发都会用到):

| 文件 | 管什么 |
|---|---|
| [README.md](README.md) | 用户视角:装什么、怎么装、读数怎么看、有什么风险 |
| [README_EN.md](README_EN.md) | 英文版(摘要式,结论与中文版一致) |
| [AGENTS.md](AGENTS.md)(本文) | 开发规则 + 边界 + 代码约定 + 测试门禁 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献流程:报 bug、提 PR、提交前自检 |
| [REVIEW.md](REVIEW.md) | 发布:对外门槛、未还的债、当前边界 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |

**参考**(按需查,不要在没事时通读):

| 文件 | 管什么 |
|---|---|
| [docs/reading-panel.md](docs/reading-panel.md) | 面板读数口径(改读数 / 渲染前必读) |
| [docs/panel-rules.md](docs/panel-rules.md) | 面板布局 / 文案 / 交互约定(改渲染 / 文案前必读) |
| [docs/verification.md](docs/verification.md) | cookie、验收器、401/404、残留 Chrome、worktree 验证 |
| [docs/mechanisms.md](docs/mechanisms.md) | 归因机制:URL / sourcemap / 四条腿 / 宿主 API |
| [docs/dead-ends.md](docs/dead-ends.md) | 19 条已知坑与已证伪的路 |
| [docs/release.md](docs/release.md) | npm 发版、staged publishing、Trusted Publisher |
| [docs/landscape.md](docs/landscape.md) | 官方开发者工具对照、竞品、市场数据 |
| [docs/plans/](docs/plans/) | 历史档案:按日期的决策与实测证据,**不是必读** |

---

## 10. npm 发版

bump `package.json.version` → 打 `vX.Y.Z` tag(与 version 一致)→ GitHub Release → `release.yml` 用 OIDC 自动 publish(幂等:已发布就跳过;查询失败照实报错)。首版 / staged publishing / Trusted Publisher 的坑见 [npm 发版](docs/release.md)。

---

## 11. 当前状态

v0.5.0 已发布(2026-10-18,OIDC,`latest → 0.5.0`);对外只剩收录 PR [#7814](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7814) 等合并、npm 搜索索引待恢复。**未还的债、上游证据、能力边界**见 [REVIEW.md](REVIEW.md);发版流水见 [CHANGELOG.md](CHANGELOG.md);历史证据见 [验收档案](docs/plans/2026-10-11-acceptance-evidence.md)。

---

## 12. 竞争与位置

`@linxin666/dsh-perf` 强在治理,按插件归因是坏的(`data-dsh-plugin` 全仓 0 命中);perf-lens 明确不做客户端 FPS / 长任务面板与 bisection。完整对照、市场数据与复核命令见 [竞争与位置](docs/landscape.md)。