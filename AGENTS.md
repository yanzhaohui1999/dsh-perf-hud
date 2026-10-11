# dsh-perf-hud 仓库规则(AGENTS)

> 本文含**项目全局开发规则 + 源码级机制 + 方向取舍**(面向贡献者与 agent)。
> 装什么怎么用、读数怎么看 → [README.md](README.md);发布门槛与验收证据 → [REVIEW.md](REVIEW.md);
> 变更历史 → [CHANGELOG.md](CHANGELOG.md)。

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
| **现场**(展开面板) | 想看一眼 | 概览(卡不卡 + 最差那条是谁)/ 回调归因 Top3 / 守夜那行;其余五组折叠(`state.groups` = `detail` / `cross` / `dom` / `host` / `tools`) | 可忽略 |
| **深录**(显式) | 要抓全 | 才打开原型插桩(DOM 写入 1/10 采样 + 调度点抓栈)与「精确归因」 | 有代价,必须显式开 |

> ✅ **这张表现在是真的了(2026-10-08,D1)**:在那之前插桩没有独立开关 —— `start()` 一跑就把 `setTimeout/setInterval/rAF` 与 `appendChild/insertBefore/setAttribute` 全包上,「守夜 = 零插桩」只是文档上的话。现在插桩被拆进 `applyProbeState()`,只在 `state.deep`(标题栏「深录」)打开时装,深录同时管精确归因(两者是「要抓全」的同一件事)。实测:默认 `instrumented: false`,点开 → `true`,点回去 → `false`,面板 `errors` 全程 0。

**明确不做**(生态里已经有人做了;重复做比谁都不做更糟,详见 §12):

- 治理类特性(写盘频控、列表 publish gate、`content-visibility` 补丁)—— `@linxin666/dsh-perf` 的地盘;
- bisection 工作流(隔离 profile + 重启 + 配对 CI/Hedges' g)—— `dsh-performance-guard` 的地盘;
- 宿主侧每插件 CPU / 堆 / 磁盘 / 进程树 —— `dsh-perf-lens` 的地盘(它已有常驻 JSONL 与进程树)。

**仍然不做的事**:

- 不碰 DSH 源码,不注册服务。宿主半**启动时不监听** `session/event`:客户端在第一次成功拿到宿主数据时请求它装一次(每个页面会话一次),装没装上以宿主回执为准并写进面板与导出(`eventWatch.installed` + reason);不想要可以用 `__perfHud.hostEvents(false)` 关掉。口径是「提交(`event.time`)→ 到达监听器」的延迟,不是监听器 CPU 耗时。
- 不写任何自己的持久化状态到 profile;面板状态只进 `localStorage`。
- 不改 `cordis.patch.yml`(它只负责把本包挂进组合),不改 profile 的持久化配置行。

---

## 1. 仓库硬约束

- **`cordis.patch.yml` 只读**:它是"把本插件挂进 profile"的一行声明,内容变化会触发组合 reconcile,**不要把它当配置面**。插件行为一律靠 `package.json` 的 `dsh.*` 与代码里的开关。
- **禁止在没有 `confirm: true` 的情况下写 bundle 状态**:宿主半的 `setBundle` 会写 profile 的持久化选择,是唯一一个"插件会改用户环境"的操作。它必须:① 显式 `confirm`;② 拒绝改 `dsh-perf-hud` 自己与 `@deepseek-ai/dsh-session-persistence-jsonl`;③ 改动前后逐项核验并恢复。
- **宿主半不许改宿主任何原型**(离线套件有断言钉住);客户端半的原型插桩(见 §5)必须是**可还原**的,`disable()` 后 `W.setTimeout === natives.setTimeout` 等断言必须成立。
- **不许假装成功**:宿主回执、map 解析状态、事件测量是否装上,一律照实显示并写进导出件(`application` / `mapStates` / `eventWatch.installed+reason` 都是这个原则的产物)。
- **不凭记忆写 API**:本项目的每一步(路由注册形态、事件名、sourcemap 形态、DOM 钩子)都来自当场读源码或实测;记忆里"应该如此"的东西(`data-dsh-plugin`、包 `Context.emit`)都被证伪过 —— 见 §6 与 §8。

---

## 2. 环境与改动生效方式(决定你能不能验证)

基线环境:DSH **`0.2.0-rc.2`**,profile 目录 `~/.dsh/profiles/web`,本仓库以 `link:` 装进该 profile
(`dsh plugin --profile web add /Users/y/workspace/dsh-perf-hud`)—— **宿主加载的就是这个检出**,所以下面这张表直接决定"你改的东西什么时候真的在跑":

| 改动 | 生效方式 |
|---|---|
| `client.js`(客户端半) | `dsh-client-hmr` 轮询 mtime/size 自动热载;**刷新页面**最稳 |
| `index.js`(宿主半) | **必须重启宿主服务**(本机 `launchctl kickstart -k gui/$(id -u)/ai.dsh.web`) |
| `package.json` 的 `dsh.client` / `dsh.bundle` | 需要重新扫描(重装或重启) |
| 纯文档(`*.md`) | 无需任何操作 |

⚠️ **重启会杀死正在跑这个插件的会话**:agent 的 bash 工具进程就在 `dsh web` 进程内(实测进程链)。改宿主半后要重启时,把重启排在报告之后(`nohup bash -c 'sleep N; launchctl kickstart …' &`)或交给用户执行,**不要在会话中途重启**。

为什么宿主插件没有文件监听:本 profile 的 `dsh-hmr` `config.root` 是 `[]`,它只在 bundle 列表或 patch 文件**内容**变化时 reconcile —— 这是机制原因,不是偷懒。

两条容易踩的环境事实:

- `dsh --profile web --dump-config` 会**写** `~/.dsh/profiles/web/cordis.yml`(`prepareProfile`),因此需要 profile 写权限;沙箱下会以 `EPERM: open '…/cordis.yml'` 失败 —— 那是权限,不是命令坏了。
- 如果浏览器在另一台机器上、经隧道访问 `127.0.0.1:3080`,面板里的**链路 RTT 高是真实的**:隧道本身的 RTT p50 可以是数十到数百毫秒,而本机 curl 同一路由只要 ~3ms。别把它当 bug —— 面板为此有「疑似链路」判据和「链路已排除」结论。

### 2.1 并行开发:worktree 放 `.worktrees/`

需要同时开两条互不干扰的改动、或让主检出始终保持可运行版本时,用 git worktree,目录固定在 `.worktrees/<slug>/`(已写进 `.gitignore`,不会进 git):

```sh
git worktree add .worktrees/i18n -b fix/i18n-fallback   # 带新分支的槽位
git worktree add --detach .worktrees/scratch HEAD       # 只想跑一遍测试
git worktree list
git worktree remove .worktrees/i18n                     # 收工;分支若不要了再 git branch -d
```

**本仓库零运行时依赖、无构建步骤,所以 worktree 里不需要 `pnpm install`,建好就能 `npm test` / `node tests/*.mjs`**(实测:三套件在 worktree 里直接全绿)。

⚠️ **但宿主加载的不是 worktree**:profile 里本包是 `link:/Users/y/workspace/dsh-perf-hud`(主检出),`dsh-client-hmr` 轮询的也是那个路径下的文件。所以在 worktree 里改 `client.js`,**浏览器里看不到**。要在浏览器里验证 worktree 的改动,只有三条路:

1. **改完先合回主检出**(推荐,最省事);
2. 临时把 profile 指过去:`dsh plugin --profile web add "$PWD/.worktrees/i18n"`,验完再指回主检出 —— 注意这改的是 **profile 的持久化依赖行**,验完务必指回来;
3. 干脆在主检出上改。

单线程开发(目前的模式)不需要 worktree;它解决的是"两条改动同时开着"和"主检出要保持能跑"这两件事。参考仓 `dsh-better-sidebar` 用同一套约定(它的 `.worktrees/` 也是走 `.gitignore`;注意它 AGENTS.md 里写的是 `.git/info/exclude`,实测那条不在 exclude 文件里 —— 用 gitignore 才对,exclude 不会被 clone 带走)。

### 2.2 没有浏览器时怎么验证

1. **cookie 三步**(完整步骤见 `~/.dsh/dsh-api.md`):从宿主启动日志里取 `token=…` → `curl -H "Host: 127.0.0.1:3080" "http://127.0.0.1:3080/?token=$TOKEN"` 拿 `Set-Cookie` → 之后 `/api/*` 都带这个 cookie。**token 每次重启都换**,所以换 cookie 必须在重启**之后**做(踩过一次:拿旧 token 一路 401)。
2. **401 与 404 的区别**:`/api/dsh-perf-hud/host` 无 cookie → **401**;路由根本没注册(宿主半未加载)→ **404**。线上脚本用 404 判定"宿主半还没加载"(退出码 3),与"实现有 bug"区分开。
3. **Cordis inspect**(不需要 cookie,走已连接的页面):
   - Client `Slots` → `listSubTree(root: 'shell.overlay')`:能看到本插件条目,**`active: false` 就是"渲染抛错被外壳停用"的硬证据**;
   - Client `Builtin.listBuiltins`:动态客户端半能用的符号(`ctx` / `React` / `host` / `styles` / `console`)。
4. **重启后要跑的验证器必须起在独立进程组**:它会被重启的 launchd 进程组一起带走,所以用 `setsid`(`python3 -c "os.fork(); os.setsid(); os.execv(...)"`)启动。原来那个封装脚本(`tests/verify-after-restart.sh`)写死了本机 node 与仓库路径,已删 —— 教训留在这一条里,要用时照上面重写几行即可。
5. **查工作区别走 `workspace/list`**(该端点 404):读 `~/.dsh/storages/workspace.json` 的 `tables.workspaces` + `global.workspaceIds`;细节见 `~/.dsh/dsh-api.md`。
6. **改完面板 / `apply()` / `start()` 路径之后跑哪个**(§8 第 14 条那条规矩的可执行版本;三个脚本自己起 headless Chrome,零依赖,token 从 `~/Library/Logs/ai.dsh.web.log` 取,共用底座 `tools/cdp.mjs`):

   ```sh
   node tools/check-panel.mjs                     # 面板渲染 0 错误 + 目标元素在场(默认断言面板标题)
   node tools/check-panel.mjs --expr="!!document.querySelector('svg[viewBox=\"0 0 60 18\"]')"
   node tools/check-storage.mjs                   # 写 localStorage → 重新加载 → 读回(落盘/跨会话基线)
   node tools/check-interaction.mjs               # CDP 发真实输入 → 验 event timing 真的交付
   node tools/check-incident.mjs                  # 抓一条真事故 → 逐帧回看 / 切回实时 / 刷新后仍能打开
   node tools/check-counts.mjs                    # 计数跨刷新 + 口径不虚报 + 导出件里没有凭据(真 location 里塞 token)
   ```

   **什么时候必须跑 `check-incident.mjs`**:改完**历史事故回放 / 取证明细的上下文切换**就跑它 —— 它挡的是"上面历史事故、下面另一条实时帧"和"刷新后历史事故打不开"这类离线套件结构上盖不到的事故。它依赖两个 DOM 约定:根节点 `id="dsh-perf-hud-root"`(控件态样式的作用域)与详情区第一行的 `data-ctx-bar="1"`(验收器靠它读"现在是哪个上下文")—— **改这两个名字等于改验收器**,改之前先看 `tools/check-incident.mjs`。

   ⚠️ **它们不是离线门禁**:要真浏览器 + 本机跑着 `dsh web`,所以 `npm test` 与 CI 里**没有**它们(CI 只对 `tools/*.mjs` 做 `node --check`)。`check-panel.mjs` 挡的就是"三套件全绿、浏览器里插件激活或渲染失败"那类事故,所以它跑不过就别提交。

---

## 3. 测试与门禁

**每次改完必须跑三套件**(改文案还要顺带跑长度预算与单位一致性断言):

```sh
node tests/attribution.mjs   # 11 条:客户端脚本 URL 形状 → 包名 / bundle key
node tests/logic.mjs         # 511 条:从 client.js 抽真函数进沙箱 + 静态检查 + 长度预算
node tests/host.mjs          # 39 条:用假 ctx 驱动真实 index.js(路由 / 事件循环 / confirm 安全线)
```

一条命令跑完:`npm test`。线上(先按 §2.2 换 cookie):

```sh
DSH_COOKIE=… node tests/live-sourcemap.mjs   # 真实 indexed sourcemap 的分段与包名
DSH_COOKIE=… node tests/live-host.mjs        # 真实路由;退出码 3 = 宿主半还没重启加载
```

测试写法约定:

- **测线上那份代码**:`logic.mjs` 用 `new Function(source + 'return {…}')` 把 `client.js` 里的真函数抽进最小环境,新增函数想被测就加进 `pieces` 列表 + 在桩里补它用到的键。**不要另写一份等价实现来测。**
- ⚠️ **`logic.mjs` 里有三个沙箱**(纯函数盒 / 导出盒 `newPieces` / 守夜盒 `watchBox`),各有自己的 `pieces` 列表与桩。往 `client.js` 加一个函数或常量之后,要把它加进**每一个用到它的盒子** —— 漏一个不会立刻报错,而是等那个盒子跑起来才 `ReferenceError`(实测:`WATCH_EVENT_MS` 只在导出盒里被 `snapshot()` 引用,守夜盒里反而先绿;`pruneIncidents` 漏在守夜盒里时,前面的断言全过、最后一个盒子才炸)。守夜盒的 `state` 是**手写桩**,新状态位还要在桩里补上。
- **口径有歧义就加断言,不要加注释**:注释不能防回归,断言能。
- **静态检查必须有牙齿**:`logic.mjs` 顶部两条(① `h(Uppercase…)` 引用的组件必须声明过;② 面板渲染区里的裸函数调用必须声明过)是"整段替换吞掉相邻声明"事故的回归测试(§8 第 7 条);验证它的办法是把声明删掉看它是否报出名字。
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

- **面板只用 theme token**(`--dsw-alias-*`),不 require 任何 Harness Client 包;颜色只用 token,字面色仅限插画。
- **整数 px、整数字重**:`11.5px` / `fontWeight: 650` 在 125%~150% 显示缩放下会触发合成加粗 + 重新栅格化,观感发糊。用 `12px` / `700`。
- **标签不收缩、数值换行**:行布局是 `label { flex: 0 0 auto; nowrap }` + `value { flex: 1 1 auto; textAlign: right }`;反过来会把标签挤成"一字一行"(实测「宿主事件到达」竖排过)。
- **长文本用块式 + 主动断行**:可能超一行的行(概览、折叠摘要)用"标签独占一行 + 值左对齐 + `white-space: pre-line` 自己给 `\n`",不要赌浏览器宽度(曾断在 `最多` 后面,把 `ChatView 22×` 甩到下一行)。
- **能不说就不说**:「最多」与「最差那条」名字相同时整行不显示(它只是把同一句话说两遍);说明文字放 `title` 悬停,不占正文。概览两行同理:`overviewLine1()` **已删掉 `(最差那条:未归因)` 后缀** —— 它与紧接着的 `overviewLine2()` 里 `最差那条:<归属>` 的**触发条件完全相同**(都是 `primaryBlame(worst) === null`),相邻两行必然把同一句话说两遍;现在第一行只给 `帧 Xms · LT Yms · 命中 a/b`,「最差那条是谁」只由第二行给,两个口径本该分开读的提醒由第二行自己的标签承担(断言:第一行不含 `未归因`、第二行含)。「最差事件」块同理:`eventValueText(row)` 一行说清三种状态(未开录 → `未开录`;没有事故 → `还没抓到(≥100ms)` —— 阈值写在这一行里,不再另起一行重复;有事故 → `严重/警告 326ms`),`watchFlagText()` 只在"读回 / 裁掉 / 落盘失败"这类**还有话要说**时才返回第二行,未开录与"还没抓到"都不重复。两个一次性说明(`state.copyNote` / `state.pickNote`)由 `resetLayout()` 一并清掉 —— 布局都回到默认了还挂着旧说明,只会让人以为又出错了。
- **长度预算**:概览两行与**四个**折叠组摘要都有字符上限(36 / 60 / **26** / 30 / 34 / 24,顺序 = 概览两行 + 取证明细 / DOM 与堆 / 宿主与链路 / 工具箱),由 `tests/logic.mjs` 钉住 —— 本会话看不到浏览器渲染,只能靠预算把"又挤成三行"这类回归钉在测试里。改文案必须重跑。**这份清单以断言为准**:AGENTS 里这行曾写成 34(记的是另一组数字),对不上时改文档,不要改断言。⚠️ **第五组「包 × 来源 · 窗口」的摘要(`crossSummary`)没有预算断言** —— 组数从 4 变 5 时漏掉了它;它的名字与来源都可能很长(`dsh-client-ui-renderer · DOMWebSocket.onmessage 1234ms` 实测 **53** 字符,在 396px 里会折行),这是已知的债(见 [REVIEW.md](REVIEW.md) §3.4)。补断言时要拿**真实量级**的名字(见 §8 第 13 条)。
- **单位一致性**:同一张表里不许一处给 `/s`、另一处给累计;任何"和邻居不同单位"的读数都要有断言(曾出现"上面是 /s、下面给累计")。
- **折叠组默认不做昂贵分析,现在由 `group()` 的 thunk 保证**:`group(key, label, summary, ...children)` 支持"唯一一个 child 且是个函数"的形式,折叠时**连函数体都不进**;五个调用点(`detail` / `cross` / `dom` / `host` / `tools`)全传 thunk,所以「取证明细」收起时脚本按包 / 交叉表 / 帧条一次都不算。代价要记住:`cross` 那一层仍嵌套在「取证明细」的 thunk 里 —— 一展开「取证明细」,调用方就先构造 `crossTable(scriptPkgTally())` 与 `kids` 数组(4×5 格,代价低),所以窗口聚合那份缓存不能省。
- **可点 / 不可点的界线(不要做假按钮)**:可点 = 「按来源 / 按包」小表的**具名行**(→ `copyText` 复制「名字 + 毫秒」,成功/失败都照实写进 `state.copyNote`)、工具箱事故清单行(→ 选中)、帧条**有 LoAF 的格子**(→ 钉住那一帧)、组头(→ 折叠)、**可疑脚本的每一行**(→ 复制那条证据行);**不可点** = 堆叠条的**色段**本身(`cursor` 是 `default`)、「其余」那一行(它是合计数,没有单个名字可复制)。
- **按钮按需出现,不留"点了没反应"的动作**:「全部折叠」只在**有组开着**时渲染(`anyGroupOpen()`),「恢复默认布局」只在 `layoutDirty()` 为真时渲染(有组开着 / 翻帧被钉住 / 手选了事故 / `scope` 不是 `worst` / 挂着一次性说明);两者都无意义时整行不渲染。新加"布局类"按钮前先问:默认状态下点它会发生什么?什么都不会发生就别显示。
- **i18n 词典成对改**:`DICT.zh` 与 `DICT.en` 同时加键(现在中英各 **325** 键)—— 两条断言钉住这件事(logic.mjs):**键集合必须一致**、**每个键都得有人引用**(撤下界面时留下的死键会被报出来;死键那条只认字面量 `t('…')` / `translate('…')`,真要加动态取键得先放宽它)。**兜底策略跟文档语言**:locale 服务不在时按 `document.documentElement.lang`(取不到退 `navigator.language`)选那本字典,不是中文就用英文 —— 写死中文会让英文用户看到中文,简单反转(`DICT.en ?? key`)又会让中文用户看到英文,两种都错。
- **插桩必须可还原**:包装 `setTimeout/setInterval/rAF` 与 `appendChild/insertBefore/setAttribute` 时,保存原生引用、只在"当前仍是我们那个 wrapper"时才还原(避免踩掉别人的包装)。
- **改 `client.js` 一律用带锚点的小批次**:一次替换一个可唯一匹配的片段,失败即整批作废。本项目有**两次**"整段替换吞掉相邻声明"的事故(§8 第 7 条)。

---

## 6. 归因机制(源码级事实)

### 6.1 脚本 URL 形态与"包名从哪来"

| 形态 | 含义 |
|---|---|
| `plugins/??<包名>/client.js&rev=<hash>` | 单包组合,**动态装载时一个包一条** |
| `plugins/<包名>/<分片>.js?rev=<hash>` | 包内分片 |
| `plugins/??a/client.js,b/client.js&rev=<hash>` | 启动批;本版本**只 preload 不执行** |

- **LoAF 的 `scripts[]` 也能定到包名**(2026-10-07):它给的是 `sourceURL` + `sourceCharPosition`,单包 URL 直接从 URL 读出包名;多包 URL 要把字符位置换算成行号,再走同一张分段表。换算需要那段脚本文本(同源 `fetch`,浏览器内存缓存命中),所以按 URL 后台预取、只留行起始偏移(`Int32Array` 级别的开销)。**逐 UTF-16 code unit 数换行**,不能用 code point。实测:一次事故 37/37 条脚本全部定名,归到 `@deepseek-ai/dsh-api-gateway`
- **合并包里没有 `sourceURL` 边界标记**,所以包名只能靠它自带的 **indexed sourcemap**:`plugins/??a/client.js.map,b/client.js.map&rev=…` → `sections[i].offset.line`(0-based)+ `map.sources[0]` → `/plugins/<包>/…`;V8 的 `CallSite.getLineNumber()` 是 1-based,**换算要减一**。线上实测:58 sections、包名与批次 entries 顺序完全一致、116 处边界断言 0 错。按 `rev` 缓存分段表(`localStorage` 的 `dsh-perf-hud:map:<rev>:<len>`),同一个 rev 只拉一次那份 12MB 的 map。
- `window.__DSH_BOOT__ = { rev, entries, batches }`(首页内联);批次名取自 `batches[i].phase`(`application` / `bootstrap`),包数 = `batches[i].entries.length`。
- **`data-dsh-plugin` 在本版本不存在**,不能靠它归因;可用的稳定 DOM 钩子只有:`[data-chat-running]`(流式判定)、`[data-conversation-content]` / `[data-chat-flow]`(消息区)、`[data-row-key]`(会话行的 `parentElement` 当列表容器)、`[data-shell-overlay]`。
- 精确归因关闭时,合并批次只给一行标签(`application批次(58 包)`),**这是刻意的**,不展开。

### 6.2 四条腿各自的能力边界

面板会**同时给出不一致的两条**,不挑好看的报:

| 腿 | 机制 | 擅长 / 局限 |
|---|---|---|
| `fiber` | 从被改动节点**往祖先**走最近的具名函数组件 | 擅长增量更新;整棵子树一次性挂载时只能给到容器 |
| `子树` | 往**子树**走,优先 `alternate === null`(React 标记"本次新挂载") | 补"整棵挂载"空档;有界 BFS ≤200 |
| `DOM写入` | 采样 `appendChild` / `insertBefore` / `setAttribute`(1/10),在写入点抓栈 + 取组件名 | 提交阶段栈里没有插件帧时的主力;估算值带 `≈` |
| `包名` | 调度点插桩(`setTimeout` / `setInterval` / `rAF`)与长任务时间重叠 | 定时器 / 动画类;**事件处理器、Promise、微任务不在内** |

**交互延迟不走这四条腿**:`event` / `element` timing 是单独一层(守夜档就挂着,不插桩),给的是端到端时长与 `waitMs` / `handlerMs` 的**粗略两段**,只进导出件。所以"事件处理器不在四条腿里"这条依然成立 —— 别把 `context.interactions` 读成帧内拆分(那份拆分页面内没有 API,见 §8)。

### 6.3 宿主外壳名 / 错误边界 / 压缩名

- 外壳组件名**不是答案**:`SlotOutlet`(槽位座)、`CenterColumn`(布局列)、`*Boundary` / `*Provider` / `*Context`、错误边界(判据:原型上有 `componentDidCatch` 或 `getDerivedStateFromError`)、生产构建压缩名(大小写 1~2 字母 + 数字,如 `n5` / `Bn`)一律跳过继续找。**这是补丁,不是根治** —— 根治靠上面四条腿交叉。
- 外壳的 `SlotErrorBoundary`(在 `dsh-client-ui-renderer`)会在条目渲染抛错时 `console.error('slot entry crashed in …')` 并**永久停用该条目**(`active: false`,只能刷新恢复)。所以 `client.js` 自带 `HudBoundary`,把错误降级成一块小面板并把错误原文写进导出件的 `errors` 段。
- 生产 React **没有** `_debugSource` / `jsxDEV` → **无法**从 fiber 直接拿到组件定义文件;组件名只能靠 `type.displayName ?? type.name`。

### 6.4 宿主侧 API 事实(本插件实际用到并验证过的)

- **挂 HTTP 路由的形态**(照抄 `dsh-context`):`ctx.inject(['connection'], c => { const reg = c.get('connection')?.fetch?.register?.bind(…); c.effect(() => reg({ path, methods: ['GET','POST'], requestBody: 'buffered', fetch: handler }), label) })`;handler 收到 Web `Request`,返回 `Response.json(…)`。
- `pluginManager`:`listBundles()` / `setBundleEnabled(name, enabled)` 是 `@Remote`(客户端可经 `ctx.remote.pluginManager` 调),**宿主半也可以直接调**(本插件就是;隔离实验正是走这条)。两者回执形状相同:`{ changed, application, stage, target, enabled, error… }`。
- `perf_hooks.monitorEventLoopDelay({ resolution })` 的 **`resolution` 默认 10ms**,会把 p50 顶到 ~10ms 的地板,看不出真实抖动;本项目用 `1`。单位是**纳秒**。宿主半每秒采 **p50 / p99 / max** 三个数下发(`index.js` 取 `histogram.max`),面板那一行照抄三个都给 —— 只给 p99 会把偶发的秒级停顿藏掉;老版本宿主半没有 `max` 字段时**如实只给 p50/p99**,不补 0。
- 客户端拿宿主数据有两条通道:客户端 `ctx.remote`(本 profile 未接通)与宿主路由 `/api/dsh-perf-hud/host`(已验证)。面板与导出都记 `via`,**不猜通道**。
- `ctx.on('session/event', (session, event) => …)` 是**公开且可用**的监听方式(与 `dsh-session-persistence-jsonl` 同一个事件);`event.time` 是提交时间戳。我们记的是「提交 → 到达监听器」的延迟,**不是**监听器的 CPU 耗时 —— 面板文案与导出字段(`mode: 'listener'`)都照这个口径写。
- **插件展示元信息**(Plugins 页那一行)由 `package.json#icon` + `locale/<lang>.json` 的 `meta.title` / `description` 提供。⚠️ 实测(`@deepseek-ai/dsh-app-boot` 的 `readPluginMeta`):宿主先解析 `<包>/locale/en.json`,**然后 `scandir` 它所在目录** —— 所以 **`locale/` 目录不能整个删掉**,目录不存在会让 Plugins 页面直接显示一条红色诊断:`Plugin metadata for <包>: Error: ENOENT: no such file or directory, scandir '<绝对路径>/locale'`(错误发生在读 icon 之前,连图标都救不了它)。`locale/en.json` 是发现基线(缺它整个目录都不读),`exports` 必须暴露 `./locale/*.json` 与 `./package.json`。**失败是静默降级 + 一条诊断**,不会拦住插件加载。

---

## 7. 面板读数口径

完整表见 [README.md](README.md) 的「面板怎么读」;开发时最容易搞错的几条(面板 hover 里也有同一份):

- **场景标签**(标题栏 `流式` / `空闲 Ns`)是解读所有数字的前提;空闲基线要 60 秒净增为 0 才算真的空闲。
- **发生频次与留存份数是两套数据(2026-10-12 起)**:`state.watch.captured/coalesced/dropped/trimmedByBytes/deduped` 是**本次会话**的计数器(刷新即归零,只进导出件的 `context.store` / `watch`);`state.tally` 是**跨刷新**的时间桶(`LS_TALLY` = `dsh-perf-hud:tally:v1`,分钟桶 `TALLY_MINUTES`=1440 ≈ 24h + 日汇总 `TALLY_DAYS`=30,桶是 `TALLY_FIELDS` 那 7 元数组)。口径只有一个:**检测到 = triggered**(一次卡顿一串触发只算一次;被 `triggerCapture` 并进 pending、或落在 `coveredUntil` 里的触发**不算新的一次**)/ **coalesced 是同串密度,不是次数**(把两者相加会把一次停顿记成十几次,实测踩过)/ **已保存现场 = `incidents.length`** / **丢失 = (triggered − captured) + dropped + trimmed + failed**。为什么必须两套:留存清单受容量限制(最差 10 + 每天 1),拿它回答"最近一小时几次"会系统性少报 —— 被挤掉的卡顿不是没发生。三条不许越界:① 折叠药丸那一格说的是**检测到**(24h、跨刷新),不是留存份数;② `clearIncidents()` **不清**计数桶(清掉的是证据,不是事实),要清频次得显式 `clearTally()`;③ 窗口边界落在**分钟桶**上,`tallyWindow()` 把 `coveredFromMs/coveredToMs` 一起给出来,写范围时用它,不许吹成"正好 24 小时"。落盘走 2 秒合并定时器(`markTallyDirty`):一次卡顿里 `coalesced` 每帧都会加,不能每帧写盘;读回时形状不对的桶**整桶丢掉**并把原因记进 `tally.loadError`,不静默当成 0。
- **能力矩阵与诊断包各只有一处来源(2026-10-12 起)**:`capabilities()` 是"哪一层采到了 / 哪一层没有 / 为什么 / 属于哪一档出处"的**唯一事实来源**(叶子形如 `{ state, provenance, reason }`,state ∈ on/degraded/off/unsupported,provenance ∈ measured/inferred/unknown);事故包那串 `missing:` / `howToAdd` **由 `capabilityMissing(row)` 从它推出来**,不再是手写的一串 `if` —— 但每一行的 `前缀:` 形状必须保留(线上与离线都按前缀断言)。`causeCandidates(row)` 是"可能原因"的**唯一生成处**(面板与诊断包读同一份),三条不许越界:① 每条候选都带 `limits`,而且限制里一定有那句"不等于已定位根因";② `worstFrameJs === 'none'` 时不给节流结论,只有 `summary.suspectedThrottle` 成立才写成"更像…";③ `basis` 全部来自已采到的字段。`buildPack` / `manifestFor` / `diagnosticSummary` / `packPreview` 是**纯函数**(不碰 DOM),所以离线套件能直接断言格式 —— 摘要按固定五段(摘要 / 假设 / 缺失 / 下一步 / 元信息),`incident.json` 与面板「导出事故包」同源,包内不含聊天正文 / 提示词 / Cookie / Token / 请求头(本来就没采,不是筛掉的)。⚠️ 加正文文案时注意:摘要里**借用**的 `missing` 行本身带 markdown 记号(那是给 .md 读的),而**面板正文**仍不许带(有断言钉住 `VISIBLE_PLAIN_KEYS`)。
- **命中 a/b** = 四条腿任一给出名字的长任务数 / 长任务总数。**它会被 DOM 腿抬高**(流式时写入窗口内几乎必然有写入),必须配合「归属 Top」分布读。
- **帧内未归因**(2026-10-07 起在「取证明细」组里,不在常显):`idle = 帧间隔 − 插桩回调耗时`,所以**没插桩时它退化成平均帧间隔**(实测 16.7ms 被当成未归因)—— 那时面板直接写「要深录」,连"该帧几乎无 JS 解释"的结论也不报(`unexplainedFrame` 先要求 `state.deep === true`;不要求的话这条结论在**每一条**长帧上都成立,等于恒报)。插桩后:峰值 ≈ 最差帧(≥95%)时给结论,并提示用 Rendering 面板的 Paint flashing 交叉验证。**CSS 动画只在这里现形**(它不经 JS 调度器)。
- **帧严重度只有一个口径:`frameSeverity(row) = max(blocking, 帧时长)`** —— 判据、排序、标签**同一个函数**(以前 `worstLoaf` / `loafRanks` 只看 `blocking`、`pickList` 看 `max`,于是"自动选中的那条"可能不在清单里,标签显示 `帧 0/N`)。⚠️ **不能只看 `blocking`**:实测一次 45 帧的会话里 `blocking` **全部 < 100ms**(最大值 92ms),只看它会让清单退回"全部",而"帧时长"才是面板自己的严重度口径(判色 120/200ms、圆环上 `帧里花在哪` 也是它)。
- **翻帧清单只收达线的帧(`pickList`)**:判据是 `frameSeverity(row) ≥ PICK_MIN_MS`(取 `WATCH_TRIGGER_MS` = 100ms)。**标签显示的是帧时长**(与圆环同一个数,`blocking` 放在 tooltip 里),否则会出现"清单里出现 92ms"这种自相矛盾的读数。**一条都不到线时退回全部**(`filtered:false`,标签上不显示 `≥100ms`),否则按钮点了像坏的。
- **看的是哪一帧(`pickedLoaf`)**:面板默认看 `worstLoaf()`(最近 `WATCH_LOAF_MAX` 条里 `frameSeverity` 最大的那条)—— **它不是按时间刷新的,而是被更差的一条顶掉才换**,所以同一条常常挂很久。上面那行 `帧 N/M ◀ ▶ ⟲` 让人翻别的帧:`loafRanks()` 按 `frameSeverity` 降序出清单,`pickStep(±1)` 走一步(到头停住),`pickAuto()` 清掉选择回到自动。⚠️ 存的是**选中的 `t` 而不是下标** —— 帧环会追加新的、挤掉老的,下标会悄悄指到另一条帧上;选中的那条一旦不在环里(`pickedLoaf` 查不到 `t`),就清掉选择退回自动,不指着一个不存在的帧。翻帧会写 `state.watch.pickT` 并 `bump()` 重绘;环与「本帧」那组都吃 `pickedLoaf()`,所以它们永远说的是同一条帧。⚠️ **`t` 是 `entry.startTime`(页面时间轴),所以任何跨度的上界都是"页面已打开多久"** —— 跨度不该超过它;超过了就说明环里混进了旧页面的条目。清帧环只有两条路:**硬刷新**(环只在内存),或 `__perfHud.clear()`(它**也**清 `watch.loaf`,`clearIncidents()` 只清事故留存 —— 二者刻意分开)。
- **事故选中的是「事故 id」不是下标(`state.watch.selId`)**:新事故按严重度重排,存下标会悄悄指到别的条目上。`selectedIncident()` 返回 `{ row, auto }`:默认自动跟 `incidents[0]`(留存清单按严重度降序),用户点过就跟用户选的那条,**选中的一旦被挤出留存清单就退回自动**。三处共享同一份上下文:首屏「最差事件」块、工具箱清单的 `●` 标记、`watchSelectedText()`。`selectIncident(id)` 只选中;`revealIncident(id)` = 选中 + 展开「取证明细」+ 把翻帧钉到最近那条 LoAF。
- **事故 ⇒ 帧不再「就近定位」(2026-10-11 删掉 `frameNearestIncident`)**:以前是"在实时帧环里找一条离事故最近、且落在窗口内的帧" —— 跨会话读回时它只能给 `null`,而且会把一条**无关的实时帧**当成这条事故的证据(正是"上下文混用"的另一半)。现在历史帧直接来自事故包自己的 `incident.frames`(见上面那条 bullet),**"定位不到"这件事在结构上消失了**。`state.pickNote` 只在"老包里一条帧记录都没有"时留一句如实说明 —— 不允许"按钮点了像没反应",但也不假装有帧可看。
- **严重度必须「文字 + 颜色」两样给**:`severityLevel(ms)` → `bad`(≥200ms,与判色红档同一条线)/ `warn`(≥100ms,守夜触发线)/ `ok` / `none`;配 `severityText` + `severityColor` 一起用。只给颜色在灰度截图 / 色盲下等于丢信息。
- **宿主 event-loop 那一行给 p50 / p99 / max 三个数**(宿主半每秒采三个数下发;README 早就写了 max,代码这次才跟上)。老版本宿主半没有 `max` 字段时**如实只给 p50/p99**,不补 0 —— 只给 p99 会把偶发的秒级停顿藏掉。
- **可疑脚本(证据 → 代码,「取证明细」里的最后一块)**:把「**事故 → 帧 → 来源 → 包 → 文件:行**」落到**个体脚本**上 —— 上面几块回答"时间花在哪个包、哪类调用"(排行),这一块回答"打开哪个文件、哪个函数"(定位)。最多 `EVIDENCE_MAX = 4` 行(按耗时降序),范围写在标题上,**范围随上下文走**(`evidenceScope`):历史事故里优先给**选中那一帧自己**的脚本(`可疑脚本 · 事故 i12 · 历史帧`;脚本与定位在捕获时存下来,**跨会话读回仍在**),这一帧没有记录时才退回 `可疑脚本 · 事故 i12 · 窗口内`(块首写明"不是这一帧的",`frameEvidenceMissing`);实时上下文才给 `可疑脚本 · 本帧`。**绝不从另一个上下文顶上**;每行 `<函数名> @ <包>` + 毫秒,悬停给完整证据行,**点击复制**那条证据行;底下一行**只给分母 + 一句悬停提示**(`4/11条脚本 · 定到包 1/11 · 悬停看口径与缺口`),口径与缺口全文进 `title`(`evidenceFooterTitle`,与「复制摘要」共用同一份纯文本措辞)。⚠️ **面板是纯文本渲染,不是 markdown**:`**` 与反引号摊在正文里只会变成噪声(实测被吐槽"这段文字很丑陋"),所以**会显示在正文里的文案,词典值不许出现 markdown 记号** —— 有一条断言逐个键核这件事(`VISIBLE_PLAIN_KEYS`),新加正文文案时先看它。一条名字都没拿到时收敛成一行 `可疑脚本:0 条定到名(窗口内 11条脚本)· 要深录`(不摆一列"函数名未记录 @ 包未定名"),同样悬停给口径与缺口。
  **口径必须按三档读**(这也是这块存在的意义):
  ① **直接测量** = 函数名(`sourceFunctionName`)与毫秒(`duration`)是 LoAF 给的;
  ② **归因推断** = 包名 / 文件路径 / 行号由 URL 与 sourcemap 分段表推出来(`viaText` 压成五档:直接读出来 / 分段推断 / 不是插件脚本 / 解析失败 / 还没到位;原始 via 码进悬停与导出件);
  ③ **尚无法确认** = 原始源码(TS/TSX)行号、调用栈、函数级耗时 —— 都拿不到。⚠️ **行号是"脚本文本自己的行号"**(单包 URL = 那个文件;合并批 = 合并后的大文件),**不是原始源码行** —— 要那个得解 section 内层 `mappings` 的 VLQ,本项目没做。所以这一层能缩小到"哪个包的哪个文件哪一段",**不能直接指出根因**;它也不承诺"跳到源码某一行"。
  **函数名经常缺失**:合并/压缩后的脚本里 LoAF 常常不给 `sourceFunctionName`,面板照实写「函数名未记录」。**默认档(不插桩)看不到文件与行号** —— 合并批的包名本身就要精确归因,那一块会如实写"要深录"。
  ⚠️ **组合 URL 的坑(实测踩过)**:`new URL('http://h/plugins/??pkg/client.js').pathname` **只剩 `/plugins/`** —— `??` 的第一个 `?` 被当成查询串开始。所以组合 URL 的文件路径要自己拼(单包组合 ⇒ `plugins/<包>/<文件>`);有断言把这个坑钉住。另一半:单包组合(`??<一个包>/client.js`)以前**不预取脚本文本**(旧判据是 `indexOf(',') !== -1`,只看多包),于是它的 `charPos` 永远换不成行号 —— 现在只要 URL 是 `plugins/??` 就预取。
  **事故那一侧优先用"存下来的定位"**(`incidentScriptEvidence` + `incidentEvidenceAt`):包 / 文件 / 行号在**捕获那一刻**就写进了 `summary.topScripts[]`,面板与「复制摘要」都读这份,只有老包缺字段时才回退现算。为什么必须这样:现算依赖**当前会话**的 `state.precise` 与内存里的脚本文本 / 分段缓存 —— **刷新之后两者都空**,现算会把存好的 pkg/file/line 变成 `null` / `还没预取`,历史事故的定位就丢了(实测:深录档抓一次 → 关掉深录再刷新 → 证据行与刷新前**逐字一致**)。两条路共用同一个函数,所以不会出现"面板上有、复制出来没有"。
  **文件与行号是两个坐标系,不许拼**:`lineScope` 分三档 —— `file`(单包 URL / 单包组合:行号就是那个文件里的行,照旧 `文件:行`)/ `bundle`(合并批:行号是**合并后大文件**里的行,而文件只回答"这段代码属于哪个包的那个文件" → **只给文件**,行号单独写成「合并脚本行 N」)/ `null`(没拿到)。老包没有 `lineScope` 时按 `pkgVia === 'section'` 现推。
  数据来源与导出:`summary.topScripts[]` 多带 `invoker` / `file` / `line` / `lineVia` / `lineScope`(`file` 取自 section 的 `sources`;`paths` 是后加字段,**老 localStorage 缓存没有它 → 文件留空,不为它重下那份 12MB 的 map**);`复制摘要` 也带上证据行 + 「窗口内 ≥100ms 的交互」(端到端,只进交接件)+ 缺什么,目的是**能直接交给另一个 AI 接着查**。
- **诊断上下文:取证明细一次只服务一个上下文(2026-10-11 起,本次改版的核心)** —— `live`=实时帧环里的当前帧,`incident`=选中事故里的一条**历史帧**;由 `state.watch.mode` 决定,**分流只发生在 `detailContext()` 一处**,渲染那侧只读它的返回值(有断言钉住"历史那一支不出现 `pickedLoaf` / `scriptPkgTally` / `frameRing`")。为什么必须这样:以前「取证明细」里帧条/翻帧/饼图吃实时 `pickedLoaf()`,而事故卡片与回放吃 `selectedIncident()`,于是"上面是历史事故、下面是另一条实时帧的编号与饼图"必然出现 —— 实时与历史可以**共用视觉组件**(`ringBlock` / `scriptBreakdownRows` / `evidenceBlock` / `crossBlock`),但**不许共用一个错误的上下文**。上下文落盘在 `LS_WATCHUI`(只存 `mode` / `selId` / `frameT` / `scope`,不存数据),读回时 id 或帧 `t` 找不到就退回自动、没有事故就退回实时;所以**刷新之后仍能打开同一条事故的同一帧**(`tools/check-incident.mjs` 真页面验过)。实时那一侧的 `pickT` 在切换上下文时**不动**,切回来还是原来那条。
- **历史帧的逐帧回看(「取证明细」的历史事故那一支)**:帧来自**事故包自己**(`incident.frames`),不再从实时帧环里"就近定位"(`frameNearestIncident` 已删 —— 那个启发式在跨会话读回时只能给 null,还会把无关的实时帧当成这条事故的证据)。`gap === true` 不是帧(整段 rAF 被挂起):不参与序号、选中与翻帧,只在帧条上留白。帧**存 `t` 不存下标**(与实时翻帧同一条规矩);默认选中最差那一帧(严重度按**帧间隔**,与事故严重度同一口径)。四个方向:**上一帧 / 下一帧按时间序**(与帧条方向一致),**上一异常帧 / 下一异常帧**按守夜触发线(`PICK_MIN_MS`)筛(**判据只有帧间隔**,不混 LoAF 的 `blocking` —— 实时那一侧的清单用的是 `max(blocking, LoAF 时长)`,两个上下文各自在自己那份数据上有定义,刻意不互相借用);没有下一条就**禁用**按钮,不留"点了没反应"(⚠️ React 18 的状态更新排在微任务里,验禁用态必须**分两次 evaluate** 读 DOM,同一次同步执行里读到的还是旧 DOM —— 验收器踩过这个坑)。
- **历史帧条是导航器,不是装饰图(`replayColumns` / `replayX` / `replayCellTitle`)**:事故窗口按**时间**切成 `REPLAY_COLS`(240)列,每列取该列里**最差的那一帧**(尖刺不会被平均掉),并把**那一帧的引用**留在格子里 —— 点击 / 选中 / 高亮全部映射回 `incident.frames` 里真实存在的记录,不合成帧(有断言:每个非空格子的 `frame` 都在原数组里)。整段 rAF 被挂起 / 采样缺失的地方**留白**(那一列没有可点的帧),不补桩 —— 按序号放会把缺口压成一根柱子 = 说谎。档位用实时帧条**同一个** `sparkLevel`、颜色共用 `SPARK_COLORS`;选中帧是**一条蓝色竖线**(`--dsw-alias-state-business-primary`),柱子的颜色仍然表达它自己的档位。240 列是绘制量上限(一列一个 DOM 节点),900 帧的窗口也不会把面板压垮(有断言)。**代价要记住**:同一列里更轻的那些帧**点不到**(它们仍是真实记录,用 ◀ ▶ 能走到)—— 想"任意帧都能点"就得放弃这个上限,而一条 13 秒窗口在 60fps 下有几百帧,一帧一个节点会把画条子变成面板自己的开销。横轴的墙钟用**事故包自带的 `env.perfOrigin`**(`incidentWallClock`),不是当前页面的 `wallClock()` —— 否则跨会话读回的事故会被算成"今天的某个时刻"。
- **一帧的分解与证据都只吃那一帧**(`incidentLoafAt` / `incidentFrameTally` / `incidentFrameEvidenceRows` / `incidentLongTasksAt`):与这一帧**时间重叠**的那条 `incident.loaf`(多条取最重的)提供时间分解与脚本证据;这一帧的脚本聚合走 `tallyScripts`(与实时同一套口径),但 `pkg` / `pkgVia` **优先用捕获时存下来的** —— 刷新之后当前会话的 sourcemap 缓存是空的,现算会把历史事故的包名全算成"未定名"。**没有就是没有**:这一帧没有 LoAF 就写"这一帧没有长动画帧记录"(`frameNoLoaf`),不回退去拿最差那一帧、更不拿实时帧;脚本证据退回**事故窗口内**的切片时,块首会写明"不是这一帧的"(`frameEvidenceMissing`),并且零证据那一行的分母范围按上下文说(历史帧 / 本帧 / 窗口内三档,不许一律写"窗口内")。long task 只给**与这一帧时间重叠**的那几条(窗口里有但不重叠的不算)。
- **归因状态三档(§五,`incidentVerdict`)**:`confirmed`(有 JS 阻塞证据 **且** 窗口里定到了包)/ `suspected`(有 JS 证据但没定到包;或满足 `suspectedThrottle` 的检测条件)/ `unattributed`(其余)。三条不许越界:① **不**把"没有 JS 证据"说成"浏览器节流 / rAF 被挂起" —— 那只是可能,只有 `summary.suspectedThrottle`(≥500ms + 无 JS 重叠 + 前后帧中位健康)成立时才提,而且写成"更像…";`jsNo` 的文案也改回"无(longtask/LoAF 都不与它重叠)",不再带结论;② **不**把"窗口里耗时最高的包"宣称成根因,已确认那一档自己写着"这只缩小到哪个包,不等于已定位根因";③ 未归因给的是那句校准过的说明("未观察到足以解释该帧的 JS 阻塞证据;请结合前后帧和时间间隙检查 rAF 挂起或浏览器节流")。档位**文字 + 档位色**两样一起给(`verdictColor`),面板与「复制摘要」读同一个函数。
- **帧条里的「Long Task」与「其余」**:`longTaskBlock` 只列与选中帧重叠的 long task(owner / component / source),`frameLtWindow` 给窗口内总条数做分母;证据块 / 交叉表在两支上下文里共用,只是喂进去的 tally 与范围标签不同(`crossIncidentHint` 说清历史那一支的范围是**整份事故包**)。
- **帧里花在哪 / 脚本细拆 / 按来源 / 按包 / 交叉表(都在「取证明细」)**:环**只画四段**(脚本 / 任务里没归到的 / 渲染 / 尾部),它说的是"帧的时间去哪了"这**一个**维度;脚本内部的「来源」细分与「按包」各是一条 **100% 堆叠横条**(`barSegments`:Top3 + 其余;段宽按这一维度的总量算,所以条恒满格;名次靠由深到浅的透明度,与环同一套读法),条上面是**每项一行的小表**(名字左、毫秒右,等宽;超长名字省略号 + title 给全名;`其余` 那行带条数)—— 不要退回"一整块右对齐长文本":那样折行会折在名字中间(实测 `ResizeObserverCallback` / `index-5SrrfWpU.js` 被劈成两半)。每段 hover 给 `名字 毫秒 · 占比`;**条的画法有三条实测出来的硬性**:① 填充**不透明**,名次靠**压暗**(黑色 overlay `.32/.46/.58/.68`)而不是变透明 —— 两个坑都踩过:满不透明 + 近白/纯绿的 token(`rgb(249,250,251)` / `rgb(34,197,94)`)是**发光色块**,读不出占比;改成降不透明度又让整条**发灰**(实测被吐槽「更淡了」)。压亮度两头都不占:色相还在,亮度落回中间调;② 段用 `flexGrow: 毫秒` + `flexBasis: 3px`,小段也占得住 3px(以前 6% 只有 21px × 0.28),段间 1px 缝;③ 顶段 ≥ **80%** 时在条右边内联占比(`86%` / `100%`)—— 比例严重偏斜时"几乎全在一桶"要用数字说出来。条高 8px,轨道(12% 白)始终可见;再往下是**包 × 来源交叉表**(`crossTable`,组标题 `包 × 来源 · 窗口`,`state.groups.cross` **默认收起**;它跟上面「·窗口」那三行吃的是**同一份 `scriptPkgTally()`、同一个范围 —— 累计**,hint 里写明这一点)—— 两个正交维度分开看是两张榜单,交叉起来才回答"哪个包的哪类回调在烧时间":只展开 Top3 × Top3,其余行列用减法补足,四块之和恒等于脚本总耗时(有断言)。三处**悬停联动**(共享 key `ring:` / `src:` / `pkg:`)**整体停用,而且辅助代码已删干净**(`hot` / `setHot` / `hotProps` / `hotStyle` 与各处的 `hot === …` 都不在了)。历史:2026-10-08 真实鼠标移到交叉表行标签上会让外壳把**整个条目停用**(面板消失、`errors` 为空、`window.onerror` 不响、`__perfHud.enabled` 仍是 `true`)—— 它**不经过 `HudBoundary`**(那个边界是 `PerfHud()` 返回的树的一部分,抛点更可能在函数体里),所以连错误原文都拿不到。2026-10-11 复核:**在当前代码上复现不出来**(真实鼠标扫过交叉表内 163 个元素 + 153 次 JS 派发 `mouseover`,全程存活、`errors: 0`、控制台无输出),所以既不能证明根因、也不能证明已修好 —— 按"稳定优先于观感"保持停用。**要重新尝试**:照渲染区那条注释搭探针(遍历 DOM 顺序 + 装 console 钩子,**钩子必须在 reload 之后装**,否则随旧文档一起被清掉),同时 grep 外壳日志里的 `slot entry crashed in …`;复现出来之前不要再往渲染里加 per-element 鼠标状态(有一条静态断言钉住"渲染区不含 `onMouseEnter/Leave`")。**点击(onClick)类交互不受影响,已实测**。颜色跨视图一致:来源一律 `--dsw-alias-brand-primary`、包一律 `--dsw-alias-state-success-primary`。
- **环自身的几何**:只用 LoAF 给的三个时间点(`t` / `renderStart` / `styleAndLayoutStart`),**恒定四段**(`frameArcs`:脚本红 / 任务里没归到的中性灰 / 渲染橙 / 尾部蓝)。两条硬性:① **只做分区**,四段之和恒 = `total`;② 环上不出现 CSS:颜色只给名字,由渲染那侧映射 token。**来源细分与包都不进环** —— 它们各有自己的堆叠条(理由见下面那条铁律)。**尺寸是量出来的**:48px 的环周长 126px(1% ≈ 1.3px),段一多就分不出来 → 84px、`r = 34`、`stroke-width 13`、段间 **1.4px 缝**(扣除规则:`raw > 2×缝` 才扣,小段保原长;推进量按原始长度走,缝才落在段与段之间)。**单帧里 >5ms 的脚本通常只有 1~2 条**(实测:一个任务里连着做 timer + 事件 + 微任务,LoAF 仍然只报一条 `setTimeout`),所以"块多不多"由这条帧里有几条脚本决定;真正的多来源在「·窗口」那几行。环**只画 4 段还有尺寸上的理由**:84px 周长 213.6px 里 2% ≈ 4px,段一多就只剩缝;满宽的堆叠条(372px)里 2% = 7.4px,看得见。
- **任务那一段再按 `scripts[].duration` 分成"被 LoAF 归到脚本的"与"没归到的"(后者是**差值**:短于上报阈值的脚本 + 事件派发 / 微任务 / GC),脚本那一段再按 `forcedStyleAndLayoutDuration` / `pauseDuration` 分成 纯执行 / 强制样式布局 / 暂停(**三者是 `duration` 的分区,相加 = 脚本耗时**;为 0 的两项不显示,免得把行挤成两行)。**绘制与合成分不开**(页面内没有 API,那一层在缺失声明里),所以最后一段是"剩下的都在这儿",不能读成"样式布局占比"。
- **脚本侧是同一份耗时的三种切法,六行 = 三种 × 两个分母**:① 三分(纯执行 / 强制 / 暂停);② **按包**(`packageOfScript(url, charPos)`,与 `incident.packages` 同一条 resolve 路;**只覆盖定得到包名的脚本,合计 ≤ 脚本耗时** —— 定不到插件包名的那部分**另起一段「其余来源」,而且按原因给名字**(`unresolvedLabel`),不笼统写"未定名":URL 空 → `无 URL(内联脚本)`;URL 在 `plugins/` 下但没拆 → `插件批次(未按 sourcemap 拆)`;其余有 URL 的 → **直接用文件名**(多半是应用自己的外壳 bundle,实测 `/assets/index-<hash>.js`,React 根容器上的事件处理器就来自它)。⚠️ 这一层只覆盖插件包,所以「其余来源」那段**必须写毫秒**(只写条数会和同一行的 ms 混单位,实测被读成"按包这一层只有 16ms",而那条没定名的占了 234ms);同理,只报"有名字的那部分"会让人把那 200ms 当成这一层的全部 —— 实测窗口里 1116.8ms 脚本只有 200ms 定到包。**先看「其余来源」多少毫秒,再读排行**;这一行在 `top` 与 `byOther` 都空时才退成"未定名/要深录");③ **按来源**(`invokerLabel(script)`:LoAF 的 `invoker`,归一规则 `SCRIPT[…]`→`script`、带冒号取最后一段、截 28 字符、缺失退 `invokerType`;**覆盖全部脚本,合计 = 脚本耗时**)。②③ 的合计**本来就不相等**,不要互相印证 —— 有断言钉住这件事(160 vs 150)。「本帧」= 饼图那一帧(`framePkgTally`),「窗口」= 最近 `WATCH_LOAF_MAX` 条的聚合(`scriptPkgTally`,按窗口指纹 `loaf.length|最新一条的 t|resolveSeq` 缓存;本帧那份 ≤ `WATCH_SCRIPT_MAX` 条脚本,不缓存)。**窗口那三行必须带上它们的分母**(`windowScopeText`:条数 + 跨度 + **平均每帧脚本**)—— 它们是累计,`纯执行 21623.8ms` 不写分母就会被读成"某一次执行花了 21 秒"(真被这么质疑过:200 条长帧各百来毫秒,攒起来就是二十几秒);跨度越久累计越大,所以那一行还写明"别读成越来越慢"。⚠️ **指纹里的 `resolveSeq` 是修掉的真 bug**:以前指纹只有 `条数|最后一条 t`,与**异步**到位的 sourcemap 分段表 / 脚本文本无关 → 环满 200 条而一时没有新 LoAF 时,「窗口」三行与交叉表**永久冻在**"插件批次(未按 sourcemap 拆)",而同屏「本帧」行(不缓存)已经给出真名,打开深录也不刷新。现在 `markResolved()` 推进 `resolveSeq` —— 每个 `entry.state = 'ready'/'failed'` 之后、以及 `setPrecise()` 里各推一次;**加新的"解析完成"路径时也必须推一次,否则又会冻住**。`tallyScripts` 因此多带 `byOther`(其余来源:文件名 / 无 URL / 插件批次,带毫秒)、`unresolvedMs`、`count` 与 `spanMs`(最后一条 t − 第一条 t),`spanText(ms)` 把它写成人读的`43分12秒`。
- **拆解视图的铁律(2026-10-08 定,来自成熟工具的做法)**:面板上凡是"把一份总量拆成比例"的地方,都按这三条来 ——
  ① **一张图只表达一个维度**。同一总量的**分区**(互斥、相加=100%,如帧的任务/渲染/尾)是一条 100% 堆叠条,段少(≤4)时才用环;同一总量的**另一种切法**(正交、各自相加=100%,如按包 / 按来源)**不能并列进同一张图** —— 那种错法是"一半弧按包、另一半按来源",我们**没有**这么干。环的适用边界是"≤4 段、**不带嵌套**":层级在环上只能靠同色深浅 + 缝表示,读者得 hover 才读懂,84px 里 2% 的段直接看不见。**这条债务 2026-10-08 已还**:环只画四段,来源与包各一条 100% 堆叠条,两个正交维度做成交叉表;改动的实测证据在 [REVIEW.md](REVIEW.md) §2 的"拆解视图"一行。
  ② **层级**才用火焰/冰柱图(帧 → 任务 → 脚本 → 函数);**帧内脚本时间轴做不了** —— LoAF 只给每条脚本的时长,不给它在帧内的起止。
  ③ **跨视图一致 + 自带分母 + 绝对值与占比并列**:同一个来源在环、条、表里必须同色;每条轴都要写出自己的分母(窗口那行的 `窗口:200 条长动画帧 · 跨 43分12秒 · 平均每帧脚本 108.1ms` 就是范式);只给百分比不给毫秒会被读错。Sankey / 平行集**不做**:表达力换来的是可读性,面板这块地方不划算。
- **这一层的天花板(实测,不是推断)**:`invoker` 只回答"哪一类调用",函数级要采样器;页面内唯一那个是 JS Self-Profiling —— `typeof Profiler === 'function'`,但 `new Profiler({…})` 抛 `NotAllowedError: JS profiling is disabled by Document Policy.`,因为 HTML 响应**没有** `Document-Policy` 头(实测 `null`),而那个头由 DSH 服务的 HTML 决定(动它就越过 §0 的边界)。→ 函数级只剩 CDP / DevTools Performance(`missing` 里的 `devtools-trace`);宿主进程的函数级另有 A5 的 `node:inspector`。
- **脚本那几行走块式布局,并分成两个小标题**:「本帧」那组(脚本细拆 / 按来源条 / 按包条)与「窗口」那组(标题自带分母)各由一行小标题管范围 —— 行标签就不再重复"本帧 / ·窗口"(省的不是一两行,是每行三四个字)。值实测可到 352px(en 最坏),真数据下会超一行(`按来源` 39px = 两行:`DOMWebSocket.onmessage 425ms · setTimeout 421ms · …`),`S.row` 的右对齐会折成参差的两行(与 §5 那条"长文本用块式"是同一件事)。
- **面板会自己藏掉没意义的行**(字太多本身就让人读不动):**`回调归因` 那一块总在** —— 未插桩时降级成一行 `回调归因(耗时·下界)` + 值 `要深录`(**绝不写 `0ms/s`**,那会被读成"没有开销";插桩之后 `0ms/s` 才是真的,确实没有回调跑过),未插桩时 `top` / `其余 N` 行不渲染(免得是空表);以前整段不渲染,首屏就根本没有"回调归因"这一层,读者分不清"没采"还是"采了是空的"。标签就叫 `回调归因(耗时·下界)` / 英文 `attribution (time · lower bound)`,呼应"它是调度点包装能观察到的回调下界"。没插桩时不渲染 `DOM 写入(按插件) 0`;`命中` 那一行只列**非零的腿**(`hitText`;否则永远是 `245/0/0/0`),比率与概览同一口径(`ltBlamed/ltTotal`);`归属 Top` 的尾巴上不再重复「记录器自身 N×」—— 它上面就有独立一行。⚠️ **"一个包名都没定到"时看到的是什么**(这条记过一次教训):曾经有一段 `pkgZeroText` 想收敛成一行 `按包:0 条定到名(本帧 1 · 窗口 461 条脚本)· 要深录`,但它的分支**永远渲染不到**(外层要求 `window.js > 0`,而 `js > 0` 必然有脚本,脚本要么进 `top`、要么进 `byOther` 且 ms>0 —— 两个条件互斥),而套件当时**直接测那个函数**,于是一直绿。现在死分支与函数都**删了**,断言改成**实际渲染的那份数据**:喂给「按包」堆叠条的就是 `whoRows(tally)`,一个包名都没定到时看到的是**按原因命名的「其余来源」段(带名字与毫秒)**——`插件批次(未按 sourcemap 拆)` / `无 URL(内联脚本)` / 外壳文件名。行距也收紧过(`S.row` marginTop 5→4、`S.sep` 10/9→8/8)。
- **帧拆分的 clamp(向下夹)**:`frameSplit` 里 `js ≤ head`、`forced + pause ≤ js`、`exec ≥ 0` —— 每条脚本的毫秒各自 `round1`,脚本多而每条约 0.05ms 时求和会反过来超过父区间(四舍五入的算术后果);不夹就会画出负长度的弧。三条都有断言。
- **60 秒帧条(兼帧导航)**:一格一秒、格值 = 该格里**最差那一帧**的间隔;每格还多记一个 `t`(那一秒最差帧的 perf 毫秒),`sparkPickMap(now)` 给出"格 → 那一秒 `dur` 最大的 LoAF",`sparkCellTitle(cell, pick)` 给每格 `title`(墙钟时间 + 该秒最差帧 + **点得动 / 点不动**)。**只有那一秒真的有 LoAF 的格子才给 `onClick`** —— 帧条是按 `frameRing` 画的(每个 rAF 一条),翻帧却只在 `state.watch.loaf` 里翻,点一个没有 LoAF 的格子会"什么也没发生",那就是假按钮;点得动的格子把翻帧钉到那一秒的 LoAF。它铺满一行(`width: 100%`,实测 365px、一格约 6px;以前是 100px 宽的右对齐窄条,一格 1.7px 根本点不中),并挪到「取证明细」**最前面**。`sparkLevel` 的阈值与 `tools/inspect-incident.mjs` 的 ASCII 条带**逐条对应**(logic.mjs 有一条静态断言读那个文件核阈值,改一处忘另一处会红);整格 rAF 挂起画成矮灰柱。重绘指纹里带 5 秒刻度,否则空闲时帧条会冻在展开那一刻。
- **记录器自身(A1)**:每帧给 HUD 自己的 rAF 回调自计时,留最近 `SELF_RING = 600` 帧,面板与导出件(`context.recorder`)给 `p99` / 峰 / 样本数。这条的读法是"测量工具自证没有明显改变被测对象",**不要读成页面开销**。
- **深录(D1)是唯一的插桩开关**:`applyProbeState()` 只在 `state.deep` 打开时装 `setTimeout` / `setInterval` / `rAF` 与 `appendChild` / `insertBefore` / `setAttribute` 的包装,并同步精确归因(`setDeep` 里两者互锁)。守夜与现场是**同一档采集**,只差面板收放 —— 所以"展开面板会不会改变读数"的答案是**不会**。
- **归因表行**:`cps/s · 峰 cpsPeak/s`(EMA α=0.4 平滑的执行速率 / 单秒最大执行次数);行悬停给该秒同步耗时 `ms/s` 与累计 `N× / Xms`。覆盖范围只有三次调度的回调 → 是**下界**。
- **「其余 (N)」** = 除 Top3 外还有几个归属方(名字各不相同,按累计耗时排在后面),行值给它们的**合计速率**(与上面几行同一单位)。
- **DOM 写入(按插件)**:精确总次数 + 每个写入者的 `≈` 估算(1/10 采样,命中按 10 折算);带括号的名字来自"组件兜底桶"。**本 HUD 自身的写入不记账**。它现在在**「DOM 与堆」组**里(改版从「取证明细」挪过来:写入者属于 DOM,不属于"这一帧的时间去哪了"),且只有插桩时才有意义。
- **合并判色**:`fps ≤50` 或 `最差帧 ≥120ms` → 黄;`≤30` 或 `≥200ms` → 红(**任一触发即降色**;原来只看 fps,54.2fps 的绿点掩盖了同期 130ms 的帧)。
- **判色阈值同时写进导出 JSON 的 `context.thresholds`**;导出件还带场景 / 空闲秒数 / 精确归因与每个 map 的状态 / 宿主路由与 profile、Node、插件版本 / 实验候选与方法 —— 这是"文件离开现场后仍能自证口径"的设计,改读数口径时**必须同步改它**。
- **隔离实验**:所有窗口注入同一份合成负载(每 250ms 燃烧 8ms,走未插桩的 `natives.setInterval`,只烧 CPU 不动 DOM 以免污染归因表);每个候选只跟**紧邻基线**对照(A/B/A),**噪声底** = 基线↔基线漂移的最大绝对值,Δ 小于它一律标「噪声内」;窗口含流式标「不可比」且**不给结论**。它测的是**固定开销**,不是"该插件在某种用法下才贵"。

---

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
4. **`launchctl submit` 在本机被拒**(Bad request / 服务未登记)。→ 排队重启用 `nohup … &`,验证器用 `setsid` 起独立进程组(§2.2)。
5. **靠节点数凑 50ms 长任务**:12000 个离屏节点 React 提交仅 ~15ms,20000 个 ~28ms;而且**布局可能被推迟到下一帧**,任务里只剩十几毫秒。→ 必须用 `flushSync` 强制同步提交 + 在任务里强制布局(读 `offsetHeight`),仍不稳就**显式燃烧**(面板标注"含人为燃烧",不冒充自然卡顿)。
6. **`require('react-dom')` 意外可用**:实测能拿到,`flushSync` 能强制同步提交(自测结果里的"(同步)"就是它)——别以为模块表里没有它。
7. **`h(undefined, …)` 这类"引用了没声明"靠 `node --check` 拦不住**(语法合法)。实测事故:一次"整段替换样式块"把紧跟在 `const S` 之后的 `const signed` 与 `function PerfHudStress` 一起吞掉 → 文件里 `h(PerfHudStress, …)` 还在、定义没了 → React 抛 `Element type is invalid` → 外壳停用条目(面板凭空消失,只能刷新)。这就是 §3 那两条静态检查存在的原因。
8. **名字黑名单是补丁**(§6.3):靠枚举宿主命名追不上宿主改名与压缩,真正的答案是四条腿交叉。
9. **通知类插件可能整个会话零回调**:`dsh-notify-me` 实测从未出现在归因表里 —— 这是"它没干活",不是"没认出"。要验它,得先让它真的做点什么。
10. **LoAF 的 `blockingDuration` 会是 0,哪怕这一帧确实很重**:受控实测(CDP 触发 `stress(8000, 200)`)那一帧帧间隔 **325.6ms**、窗口里 43 帧 >100ms,但同窗口 **116 条 LoAF 的 blocking 全是 0**;而既有的 longtask 表如实给出了 `223ms · 组件 PerfHud · 子树腿/DOM 写入腿 PerfHudStress`。所以:① **不要把 `blocking = 0` 读成"没有阻塞"**,它只说明这一帧里没有*被归因到*的长任务;② 事故的严重度以**帧间隔**为准,LoAF 的 blocking 只当补充。这次的 200ms 燃烧是经 CDP 触发的,所以不能反推"所有同步 JS 都不计"(可能只是没有 TaskAttribution)。**真人交互下的实测(2026-10-07,Windows Chrome,13 秒窗口)blocking 是 143.5 / 5.5 / 2.1ms —— 不是 0**:那条"全 0"是 headless/CDP 环境的产物,结论(blocking=0 不能读成没卡)不变。
11. **单帧尖刺不能用 p50 基线判,而且基线必须排除本窗口**:真实数据里有一帧 **983.7ms**,而它前后都是 **16.7ms(正好 60fps)**、窗口里没有一条 longtask/LoAF 与它重叠 —— 这一帧恰好卡在 1 秒间隙线**下面**(983.7 < 1000),所以被当成"真卡顿"抓了下来。三条改法:① `baseline` 改成 `frameRing.stats(from, to)`(排除本窗口),否则"比会话最差还差"永远不成立;② 额外交 `worstFrameJs`(最差帧有没有 JS 重叠)与 `suspectedThrottle`(≥500ms + 无 JS + 前后帧中位 <100ms);③ 判"是不是真的变差"要看**最差帧的倍数**,不是 p50 —— 同一份包原先给出"与本会话平时基本一致(×1.00)",把 983ms 的尖刺判成了正常。
12. **`PerformanceObserver.observe({ buffered: true })` 会把已经采过的 LoAF 再放一遍**:每次重新挂观察器(`disable→enable`、HMR 重载、重新 `apply`)都会重放最近 200 条 —— 同一个 `startTime` 于是被**重新触发**,同一次卡顿裂成多条不同 id 的事故。实测面板上同时出现 `i2 / i29 / i31`,三条的时间戳一模一样(298ms @ 23:30:18)。修法:去掉 `buffered: true`(挂上之前的帧我们本来也没采);另外按 `at|cause` 去重兜底 —— 但**缺这两个字段的条目不能参与去重**,否则会把真事故当成重复吃掉(单测里踩过)。
13. **长度预算的桩数据必须是真实量级**:`detailSummary` 的预算一直是 30~34,而桩里的数字全是 0/个位数,于是"最差秒 152ms · 未归因 17ms · DOM 写入 36250"在 396px 面板里被挤成两行这件事**从来没被断言发现**。现在桩里塞五位数,并把摘要砍到只留结论对。
14. **批量替换(按次数替换)会改到同名调用点,而且文件本身还是"语法正确"的**:给 `frame()` 的 rAF 循环插一句自计时,锚点 `state.fpsLoop = natives.requestAnimationFrame(frame);` 在 `frame()` 与 `start()` 里**各有一处**,按次数替换就把 `selfStarted` 插进了 `start()` —— 那里没有这个变量,于是**插件激活直接失败**(外壳日志 `web boot: 1 entry did not activate / dsh-perf-hud: failed`),面板整块消失,而 `node --check` 与三套件**全绿**(单测只抽纯函数,不跑 `apply`)。教训:替换后要 `grep -c` 确认命中数;凡是插进"只在浏览器里跑"的路径(apply / start / 渲染),必须真的打开页面看一眼。
15. **改 `client.js` 时不要同时跑"受控实测"**:`dsh-client-hmr` 会热载新代码,正在跑的采集会**换到新实例**(seq 归零、状态重置),实验结果直接作废。实测踩过一次:边写落盘功能边跑受控捕获,拿到的 id 与时间戳全对不上。要采集就先把代码定下来。
16. **`node:inspector` 的同进程会话总能连上,而且允许多会话并存**(Node v25.9.0 实测,A5 采宿主 CPU profile 时撞到):`new Session().connect()` 不需要 `--inspect`(连上后 `inspector.url()` 是 `undefined`);**另一个会话正在采时再 `Profiler.start` 也不报错** —— 后来的那个直接接手采样,两个会话各自 `Profiler.stop` 都能拿到 profile。所以「宿主已经开着别的 inspector,所以我们会失败」是**错的**:真正防止两段采样互相踩的是我们自己的单飞(`running` 标志),不是 V8。错误分支实际挡的是:inspector 不可用 / 会话未连接或已断开(`post` 没 connect → `Session is not connected`;同一会话重复 `connect()` → `The inspector session is already connected`)/ `Profiler.*` 自身报错。**不管哪种都要把错误原文回给调用方,不许假装成功。**
17. **V8 CPU profile 的采样密度远低于标称**:`Profiler.start` 的默认间隔是 1000µs,但实测只有 **~180~250 次/秒**(V8 只在"可采样点"取栈,原生/GC 期间取不到)。所以一段 **5 秒** `.cpuprofile` 只有 ~1000 个采样、**约 10~13KB**(轻负载 11.5KB / 重负载 12.5KB / 边解析 5.5MB JSON 10.3KB),体积由**不同调用栈的数量**决定、不由时长决定 —— "profile 会很大所以别常开"里的**体积**不是理由,常开的代价在采样本身。反过来:回包体积从来不是问题,别为此加压缩/分片。

---

## 9. 文档地图

> 只有这六份。**不再新增带日期的记录文档** —— 结论并进这里的对应小节,历史进 [CHANGELOG.md](CHANGELOG.md)。

| 文件 | 管什么 |
|---|---|
| [README.md](README.md) | 用户视角:装什么、怎么装、读数怎么看、有什么风险 |
| [README_EN.md](README_EN.md) | 英文版(摘要式,结论与中文版一致) |
| [AGENTS.md](AGENTS.md)(本文) | 开发规则 + 源码级机制 + 已知坑 + 方向取舍(§0.1)+ 竞争位置(§12) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献流程:报 bug、提 PR、提交前自检 |
| [REVIEW.md](REVIEW.md) | 发布:对外门槛、验收判据与实测证据、还剩什么(只列没做的) |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |

---

## 10. npm 发版

1. bump `package.json.version`,跑完 §3 的门禁并全绿。
2. 打 tag `vX.Y.Z`(**tag 必须与 `version` 一致**),在 GitHub 建 Release。
3. `.github/workflows/release.yml` 在该 Release 发布时自动 `npm publish`(用 **npm Trusted Publishing / OIDC**,不配 `NPM_TOKEN`)。它对该版本**幂等**:发布前先 `npm view` 查 registry,查到就跳过发布并写 notice(所以给手工首发那一版建 Release 不会发失败,只会跳过);**查询失败照实报错退出**,不当成"没发过"。
4. **第一个版本**:OIDC **直接** `npm publish` 发不了首版(npmjs.com 要到包已经存在之后才能配 Trusted Publisher,上游 [npm/cli#8544](https://github.com/npm/cli/issues/8544) 仍 open)。0.4.0 实测走的是 **staged publishing**:`npm stage publish`(registry 见到包还不存在,先建一个占位版本 `0.0.0-stage` 把包名占住)→ 维护者在 npmjs.com 的 **Staged Packages** 页点 Approve,或 `npm stage approve <stage-id>`,用 **2FA approve** 之后才公开。
   ⚠️ **打包/发布用的不是 homebrew 那套 npm**:本机 `/opt/homebrew/bin/npm` 是 11.12.1,**没有 `stage` 子命令**;发布用的是 `/Users/y/tools/node-v24.19.0-darwin-arm64` 里的 npm **11.17.0 / Node 24.19.0**。只有它的 `lib/commands/publish.js` 有 `stage: true` 那条路,`npm publish` 仍然走 `otplease`(当场要 OTP)。同一份内容被两套 npm 打出来的 tarball **字节不同、内容相同** —— 别拿 shasum 不等当"发错东西"的证据,要比逐文件 sha256。
   首发之后再去包设置页配 Trusted Publisher(Provider: GitHub Actions;填 owner / repo / `release.yml`):⚠️ **Allowed actions** 决定以后怎么走 —— `npm stage publish` 永远允许,而"直接 `npm publish`"要**显式勾选**;只勾 staged 的话 `release.yml` 得改成 `npm stage publish`,而且每版都要人工 approve。⚠️ 新建配置**必须在 2 天内完成一次成功发布**,否则作废且无法编辑(给一个已经在 npm 上的版本建 Release **不算**验证)。
5. 发布后核对产物:`npm pack --dry-run` 里必须带上 `index.js` / `client.js` / `cordis.patch.yml` / `icon.svg` / `locale/en.json` / `LICENSE`,以及 README 与 AGENTS 链接到的全部文档(`README_EN` / `CONTRIBUTING` / `REVIEW` / `CHANGELOG` / `AGENTS`)与 `tools/`(事故包渲染器 + 三个 CDP 验证器,README 让用户直接跑它们,所以必须进包)—— 漏一份,npm 页面上就是一个死链。`release.yml` 的 Pack and inspect 步骤逐份 grep,漏了就失败。

---

## 11. 当前状态

**v0.4.0 已发布到 npm**(2026-10-11,`latest → 0.4.0`):`npm test` **458** 条全绿(attribution 11 / logic 408 / host 39)、
`npm pack --dry-run` **18 个文件**、`tag v0.4.0` == registry 的 `gitHead` == `dbcd8f3`(线上 tarball 与本机 `npm pack` **逐文件 sha256 全等**)。
首发走的是 **staged publishing**,不是直接 `npm publish`:`npm stage publish`(npm **11.17.0** / Node 24.19.0;registry 先建占位版本 `0.0.0-stage` 占住包名)→ 维护者 2FA **approve**。OIDC **直接** publish 发不了首版(npmjs.com 要到包已存在才能配 Trusted Publisher,上游 [npm/cli#8544](https://github.com/npm/cli/issues/8544) 仍 open);下一个版本起走 Release 触发 `release.yml`,要不要每版人工 approve 取决于 Trusted Publisher 的 **Allowed actions**(见 §10 第 4 条)。

**0.4.0 收进的改动**:「帧里花在哪」从三段饼改成四段饼
(脚本 / 任务里没归到脚本的 / 渲染 / 样式+布局+绘制),脚本侧再拆三层并分成**本帧与窗口两个分母**;
随后一轮 UI 改版:折叠组变五组(新增「包 × 来源 · 窗口」`cross`,默认收起;`group()` 的 children 改成 thunk,
收起时不算)、60 秒帧条铺满一行并挪到「取证明细」最前、可作帧导航、事故与帧改成按 id / 就近定位共享一个选中上下文
(其中「就近定位」那一半 **2026-10-11 已被替换**:历史帧直接来自事故包自己的 `incident.frames`,`frameNearestIncident` 删除 —— 见 §7 的「诊断上下文 / 历史帧的逐帧回看」两条)、
DOM 写入挪进「DOM 与堆」、`回调归因` 未插桩时降级成一行 `要深录`;
再一轮「证据 → 代码」完善:新增「可疑脚本」块(函数名 / 包 / 文件 / 行号 + 直接测量 vs 归因推断 vs 无法确认三档口径 + 一键复制),
`summary.topScripts[]` 多带 `invoker`/`file`/`line`/`lineVia`;顺手修掉组合 URL 的 `pathname` 截断(文件路径显示成 `/plugins/`)与
分段表 `names` 未跟 `offsets` 一起排序两个真 bug;首屏的布局按钮改成按需出现、新增「最近 / 最差」scope 切换;
悬停联动**停用且把辅助代码删干净**(复现不出来,详见 §7)。
又一轮诊断链完善:**历史事故改为用捕获时存下来的定位**(`incidentScriptEvidence` / `incidentEvidenceAt`,面板与复制摘要共用一条路 —— 以前现算,刷新后缓存空了就把存好的 pkg/file/line 丢掉);
合并脚本的「文件」与「行号」拆开显示(`lineScope`,`合并脚本行 N`,不再拼成看着精确的 `file:line`);新增**事故回放**(只用事故包里的 frames/loaf,刷新生效、零新增采集,且不排帧内执行顺序);
删掉 REVIEW §3.4 记的不可达分支 `pkgZeroText`(连同它的函数),断言改成实际渲染的数据。
**2026-10-11(第二轮):历史事故逐帧诊断 + 双上下文隔离(未发布)** —— 取证明细只服务一个上下文(`live` / `incident`),
分流点只有 `detailContext()` 一处;历史帧条是**导航器**(240 列,每列取该列最差的一帧,点击映射回 `incident.frames` 里的真实记录,
rAF 挂起的区间留白),四个方向翻帧(没有下一条就禁用),选中帧的分解 / 脚本 / long task / 证据全部只吃那一帧(缺就是缺,不回退);
归因状态收敛成**已确认 / 可疑 / 未归因**三档并去掉"更像 rAF 被节流"这类把可能写成结论的说法;诊断上下文落盘 `LS_WATCHUI`,
刷新后仍停在同一条事故的同一帧。`npm test` 现在 **561** 条(attribution 11 / logic 511 / host 39),CI 门禁与文档同步成 `-eq 561`;
真页面验收:`check-panel` / `check-storage` / `check-interaction` / **新增 `tools/check-incident.mjs`** 四个验证器 **ALL PASS**(见 REVIEW §2)。

**仍然存在的债(套件是绿的 ≠ 它们没问题)**:

- ~~`pkgZeroText` 的「0 条定到名(带分母)」分支实际不可达~~ → **已还**:死分支与函数都删了,断言改成实际渲染的数据(见 §7)。
- `tallyScripts` 算出的 `unresolvedMs` **全仓没有读者**(只有定义处与测试断言引用它)。
- `stressText` / `pkgWhoText` / `invokerWhoText` 三个函数**零调用点**,却被 `tests/logic.mjs` 覆盖着 —— 这正是"套件绿"与"代码没死"之间的差距:断言只证明函数还算得对,不证明面板还会调它。**2026-10-11 起 `replaySplitText` 也进了这一类**(历史那一支改用逐帧的 `frameSplit` + 时间轴之后,它只剩定义处与一条断言还在引用),要么给它找回落点,要么连同断言一起删。
- 悬停联动**停用且辅助代码已删干净**(`hot`/`setHot`/`hotProps`/`hotStyle` 都没了):2026-10-08 会让外壳停用整个条目,2026-10-11 在当前代码上**复现不出来**(163 个元素真实鼠标 + 153 次 JS 派发 `mouseover` 全程存活),既不能证明根因也不能证明已修好 —— 恢复前必须先复现出来(配方在 §7),不要把它当可用特性写进任何文档。
- **原始源码行号 / 调用栈 / 函数级耗时仍然拿不到**:要解 section 内层 `mappings`(VLQ)或录 Chrome trace。「可疑脚本」只能缩小到"哪个包的哪个文件哪一段"。
- **函数名经常缺失**:LoAF 的 `sourceFunctionName` 在合并/压缩脚本里常常是空 —— 面板照实写「函数名未记录」,这不是 bug。

**卡在哪**:没有了 —— 0.4.0 已经发出去。**下一次发版前**只剩两件对外动作(细节在 [REVIEW.md](REVIEW.md) §3.1):
① 在 npm 包设置页配 Trusted Publisher(Provider `GitHub Actions`,owner `yanzhaohui1999` / repo `dsh-perf-hud` / Workflow filename `release.yml`)
—— ⚠️ 新建配置**必须在 2 天内完成一次成功发布**,否则作废且无法编辑,所以**别提前配**;
② 收录 PR 还没提。
`release.yml` 对"该版本已在 npm 上"幂等(发布前查 registry,查到就跳过;查询失败照实报错),所以给手工首发那一版建 Release 只会走"跳过"分支,不会再发一次。
三条新发现的尾巴(A5 还没接进客户端/导出件、D4 的 `stressText()` 死代码、`locale` 的打包边界)也记在 REVIEW §3.2。已完成的验收证据在 REVIEW §2。

---

## 12. 竞争与位置(2026-10-07 复核)

数值是 2026-10-07 当场查的(npm 窗口 `2026-09-05` → `2026-10-04`),**会过期,要用就自己重跑**
(命令在本节末尾)。判断三家时只用了两样东西:他们自己的源码/文档原文,和我当场查到的数字。

| 包 / 仓库 | 形态 | 撞我们哪块 | 势能 |
|---|---|---|---|
| `@linxin666/dsh-perf` | 宿主 + 客户端 HUD | 帧 / FPS / 长任务 / 宿主 event-loop / 内存 / 按插件归因 | **15,194 次/月**(生态第一,v0.3.14);仓库是通用插件仓 `zhu1090093659/dsh-web`(★8,471) |
| `dsh-fast`(PerryLink) | 宿主只读 | 会话加载 / spill / 压缩诊断 | 3,226 次/月 |
| `dsh-perfscope`(Evhye38496) | 静态体检 | 插件健康评分 | 846 次/月 |
| `dsh-performance-guard`(qinshige) | 宿主 + 客户端 | 隔离实验 + 诊断报告 | 435 次/月 |
| `Nwflower/dsh-perf-lens` | 宿主 + 客户端 | 四条腿里的三条 + 宿主半 | **未发 npm**,★0,创建 2026-10-05 |

三条最有用的结论:

1. **`@linxin666/dsh-perf` 的"按插件"归因是坏的**:它靠 `element.closest('[data-dsh-plugin]')`,
   而这个属性在上游 `0.2.1-alpha.1` 全仓 **0 命中** —— 官方外壳挂的节点拿不到名字,基本全落进
   `rest` 桶。它的强项在治理(写盘频控、列表 publish gate),不在测量。
2. **perf-lens 明确放弃了两块,正好是我们的位置**:它的路线图「What not to build」写着不做
   **客户端 FPS/长任务面板**(让给 dsh-perf)与 **bisection**(让给 performance-guard);它自己把
   jank 视图收到了 LoAF 的"脚本 + 强制样式布局",没有组件级归因(它明确否掉了 DOM 根启发式,
   理由是"测的是 DOM churn、真正的卡是每次变更的 JS 扫描时间")。
3. **它的市场数据是错的**:`docs/landscape-survey.md` 与 `roadmap-proposals.md` 都写
   `@linxin666/dsh-perf` 是 59,960 /「60k installs a month」,实测同窗口是 **15,194** ——
   引用任何人的市场结论前自己查一遍。

**一条桌面端的硬事实**(来自 perf-lens 的 `docs/evidence.md` §17,实测 900 条长帧):
`dsh-app://` 上 `PerformanceObserver` 照常交付长帧,但 **`scripts` 恒为空** —— LoAF 的脚本级归因
只在 http(s) 源有效;桌面端能走的是 V8 CallSite 与主进程侧 CDP / `contentTracing`,而打包版
默认**不带** `--remote-debugging-port`。

复核命令:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/dsh-perf-hud   # 404 = 名字还空着
curl -s 'https://api.npmjs.org/downloads/point/2026-09-05:2026-10-04/@linxin666%2Fdsh-perf'
curl -s https://api.github.com/repos/Nwflower/dsh-perf-lens
curl -s https://raw.githubusercontent.com/Nwflower/dsh-perf-lens/HEAD/docs/roadmap-proposals.md
```

---
