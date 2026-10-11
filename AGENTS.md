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
| **现场**(展开面板) | 想看一眼 | 概览(卡不卡 + 最差那条是谁)/ 回调归因 Top3 / 守夜那行;其余四组折叠 | 可忽略 |
| **深录**(显式) | 要抓全 | 才打开原型插桩(DOM 写入 1/10 采样 + 调度点抓栈)与「精确归因」 | 有代价,必须显式开 |

> ✅ **这张表现在是真的了(2026-10-08,D1)**:在那之前插桩没有独立开关 —— `start()` 一跑就把 `setTimeout/setInterval/rAF` 与 `appendChild/insertBefore/setAttribute` 全包上,「守夜 = 零插桩」只是文档上的话。现在插桩被拆进 `applyProbeState()`,只在 `state.deep`(标题栏「深录」)打开时装,深录同时管精确归因(两者是「要抓全」的同一件事)。实测:默认 `instrumented: false`,点开 → `true`,点回去 → `false`,面板 `errors` 全程 0。

**明确不做**(生态里已经有人做了;重复做比谁都不做更糟,详见 §12):

- 治理类特性(写盘频控、列表 publish gate、`content-visibility` 补丁)—— `@linxin666/dsh-perf` 的地盘;
- bisection 工作流(隔离 profile + 重启 + 配对 CI/Hedges' g)—— `dsh-performance-guard` 的地盘;
- 宿主侧每插件 CPU / 堆 / 磁盘 / 进程树 —— `dsh-perf-lens` 的地盘(它已有常驻 JSONL 与进程树)。

**仍然不做的事**:

- 不碰 DSH 源码,不注册服务,不监听 `session/event`(除非用户显式开 `watchEvents`)。
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
   ```

   ⚠️ **它们不是离线门禁**:要真浏览器 + 本机跑着 `dsh web`,所以 `npm test` 与 CI 里**没有**它们(CI 只对 `tools/*.mjs` 做 `node --check`)。`check-panel.mjs` 挡的就是"三套件全绿、浏览器里插件激活或渲染失败"那类事故,所以它跑不过就别提交。

---

## 3. 测试与门禁

**每次改完必须跑三套件**(改文案还要顺带跑长度预算与单位一致性断言):

```sh
node tests/attribution.mjs   # 11 条:客户端脚本 URL 形状 → 包名 / bundle key
node tests/logic.mjs         # 324 条:从 client.js 抽真函数进沙箱 + 静态检查 + 长度预算
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
- **能不说就不说**:「最多」与「最差那条」名字相同时整行不显示(它只是把同一句话说两遍);说明文字放 `title` 悬停,不占正文。
- **长度预算**:概览两行与四个折叠组摘要都有字符上限(36 / 60 / **26** / 30 / 34 / 24,顺序 = 概览两行 + 取证明细 / DOM 与堆 / 宿主与链路 / 工具箱),由 `tests/logic.mjs` 钉住 —— 本会话看不到浏览器渲染,只能靠预算把"又挤成三行"这类回归钉在测试里。改文案必须重跑。**这份清单以断言为准**:AGENTS 里这行曾写成 34(记的是另一组数字),对不上时改文档,不要改断言。
- **单位一致性**:同一张表里不许一处给 `/s`、另一处给累计;任何"和邻居不同单位"的读数都要有断言(曾出现"上面是 /s、下面给累计")。
- **i18n 词典成对改**:`DICT.zh` 与 `DICT.en` 同时加键 —— 两条断言钉住这件事(logic.mjs):**键集合必须一致**、**每个键都得有人引用**(撤下界面时留下的死键会被报出来;死键那条只认字面量 `t('…')` / `translate('…')`,真要加动态取键得先放宽它)。**兜底策略跟文档语言**:locale 服务不在时按 `document.documentElement.lang`(取不到退 `navigator.language`)选那本字典,不是中文就用英文 —— 写死中文会让英文用户看到中文,简单反转(`DICT.en ?? key`)又会让中文用户看到英文,两种都错。
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
- `perf_hooks.monitorEventLoopDelay({ resolution })` 的 **`resolution` 默认 10ms**,会把 p50 顶到 ~10ms 的地板,看不出真实抖动;本项目用 `1`。单位是**纳秒**。
- 客户端拿宿主数据有两条通道:客户端 `ctx.remote`(本 profile 未接通)与宿主路由 `/api/dsh-perf-hud/host`(已验证)。面板与导出都记 `via`,**不猜通道**。
- `ctx.on('session/event', (session, event) => …)` 是**公开且可用**的监听方式(与 `dsh-session-persistence-jsonl` 同一个事件);`event.time` 是提交时间戳。我们记的是「提交 → 到达监听器」的延迟,**不是**监听器的 CPU 耗时 —— 面板文案与导出字段(`mode: 'listener'`)都照这个口径写。
- **插件展示元信息**(Plugins 页那一行)由 `package.json#icon` + `locale/<lang>.json` 的 `meta.title` / `description` 提供。⚠️ 实测(`@deepseek-ai/dsh-app-boot` 的 `readPluginMeta`):宿主先解析 `<包>/locale/en.json`,**然后 `scandir` 它所在目录** —— 所以 **`locale/` 目录不能整个删掉**,目录不存在会让 Plugins 页面直接显示一条红色诊断:`Plugin metadata for <包>: Error: ENOENT: no such file or directory, scandir '<绝对路径>/locale'`(错误发生在读 icon 之前,连图标都救不了它)。`locale/en.json` 是发现基线(缺它整个目录都不读),`exports` 必须暴露 `./locale/*.json` 与 `./package.json`。**失败是静默降级 + 一条诊断**,不会拦住插件加载。

---

## 7. 面板读数口径

完整表见 [README.md](README.md) 的「面板怎么读」;开发时最容易搞错的几条(面板 hover 里也有同一份):

- **场景标签**(标题栏 `流式` / `空闲 Ns`)是解读所有数字的前提;空闲基线要 60 秒净增为 0 才算真的空闲。
- **命中 a/b** = 四条腿任一给出名字的长任务数 / 长任务总数。**它会被 DOM 腿抬高**(流式时写入窗口内几乎必然有写入),必须配合「归属 Top」分布读。
- **帧内未归因**(2026-10-07 起在「取证明细」组里,不在常显):`idle = 帧间隔 − 插桩回调耗时`,所以**没插桩时它退化成平均帧间隔**(实测 16.7ms 被当成未归因)—— 那时面板直接写「要深录」,连"该帧几乎无 JS 解释"的结论也不报(`unexplainedFrame` 先要求 `state.deep === true`;不要求的话这条结论在**每一条**长帧上都成立,等于恒报)。插桩后:峰值 ≈ 最差帧(≥95%)时给结论,并提示用 Rendering 面板的 Paint flashing 交叉验证。**CSS 动画只在这里现形**(它不经 JS 调度器)。
- **翻帧清单只收达线的帧(`pickList`)**:判据是 **`max(blocking, 帧时长) ≥ PICK_MIN_MS`**(取 `WATCH_TRIGGER_MS` = 100ms)—— ⚠️ **不能只看 `blocking`**:实测一次 45 帧的会话里 `blocking` **全部 < 100ms**(最大值 92ms),只看它会让清单退回"全部",而"帧时长"才是面板自己的严重度口径(判色 120/200ms、圆环上 `帧里花在哪` 也是它)。**标签显示的是帧时长**(与圆环同一个数,`blocking` 放在 tooltip 里),否则会出现"清单里出现 92ms"这种自相矛盾的读数。**一条都不到线时退回全部**(`filtered:false`,标签上不显示 `≥100ms`),否则按钮点了像坏的。
- **看的是哪一帧(`pickedLoaf`)**:面板默认看 `worstLoaf()`(最近 `WATCH_LOAF_MAX` 条里 blocking 最大的那条)—— **它不是按时间刷新的,而是被更差的一条顶掉才换**,所以同一条常常挂很久。上面那行 `帧 N/M ◀ ▶ ⟲` 让人翻别的帧:`loafRanks()` 按 blocking 降序出清单,`pickStep(±1)` 走一步(到头停住),`pickAuto()` 清掉选择回到自动。⚠️ 存的是**选中的 `t` 而不是下标** —— 帧环会追加新的、挤掉老的,下标会悄悄指到另一条帧上;选中的那条一旦不在环里(`pickedLoaf` 查不到 `t`),就清掉选择退回自动,不指着一个不存在的帧。翻帧会写 `state.watch.pickT` 并 `bump()` 重绘;环与「本帧」那组都吃 `pickedLoaf()`,所以它们永远说的是同一条帧。
- **帧里花在哪 / 脚本细拆 / 按来源 / 按包 / 交叉表(都在「取证明细」)**:环**只画四段**(脚本 / 任务里没归到的 / 渲染 / 尾部),它说的是"帧的时间去哪了"这**一个**维度;脚本内部的「来源」细分与「按包」各是一条 **100% 堆叠横条**(`barSegments`:Top3 + 其余;段宽按这一维度的总量算,所以条恒满格;名次靠由深到浅的透明度,与环同一套读法),条上面是**每项一行的小表**(名字左、毫秒右,等宽;超长名字省略号 + title 给全名;`其余` 那行带条数)—— 不要退回"一整块右对齐长文本":那样折行会折在名字中间(实测 `ResizeObserverCallback` / `index-5SrrfWpU.js` 被劈成两半)。每段 hover 给 `名字 毫秒 · 占比`;**条的画法有三条实测出来的硬性**:① 填充**不透明**,名次靠**压暗**(黑色 overlay `.32/.46/.58/.68`)而不是变透明 —— 两个坑都踩过:满不透明 + 近白/纯绿的 token(`rgb(249,250,251)` / `rgb(34,197,94)`)是**发光色块**,读不出占比;改成降不透明度又让整条**发灰**(实测被吐槽「更淡了」)。压亮度两头都不占:色相还在,亮度落回中间调;② 段用 `flexGrow: 毫秒` + `flexBasis: 3px`,小段也占得住 3px(以前 6% 只有 21px × 0.28),段间 1px 缝;③ 顶段 ≥ **80%** 时在条右边内联占比(`86%` / `100%`)—— 比例严重偏斜时"几乎全在一桶"要用数字说出来。条高 8px,轨道(12% 白)始终可见;再往下是**包 × 来源交叉表**(`crossTable`,`state.groups.cross` **默认收起**)—— 两个正交维度分开看是两张榜单,交叉起来才回答"哪个包的哪类回调在烧时间":只展开 Top3 × Top3,其余行列用减法补足,四块之和恒等于脚本总耗时(有断言)。三处**悬停联动**(共享 key `ring:` / `src:` / `pkg:`):指到条的一段 → 表里同名的列(来源)/ 行(包)与那些格子一起加亮、其余段压暗一档;指到环的一段 → 描边 13→17 并把图例加粗(环不与来源/包联动 —— 它们不是同一个维度)。颜色跨视图一致:来源一律 `--dsw-alias-brand-primary`、包一律 `--dsw-alias-state-success-primary`。
- **环自身的几何**:只用 LoAF 给的三个时间点(`t` / `renderStart` / `styleAndLayoutStart`),**恒定四段**(`frameArcs`:脚本红 / 任务里没归到的中性灰 / 渲染橙 / 尾部蓝)。两条硬性:① **只做分区**,四段之和恒 = `total`;② 环上不出现 CSS:颜色只给名字,由渲染那侧映射 token。**来源细分与包都不进环** —— 它们各有自己的堆叠条(理由见下面那条铁律)。**尺寸是量出来的**:48px 的环周长 126px(1% ≈ 1.3px),段一多就分不出来 → 84px、`r = 34`、`stroke-width 13`、段间 **1.4px 缝**(扣除规则:`raw > 2×缝` 才扣,小段保原长;推进量按原始长度走,缝才落在段与段之间)。**单帧里 >5ms 的脚本通常只有 1~2 条**(实测:一个任务里连着做 timer + 事件 + 微任务,LoAF 仍然只报一条 `setTimeout`),所以"块多不多"由这条帧里有几条脚本决定;真正的多来源在「·窗口」那几行。环**只画 4 段还有尺寸上的理由**:84px 周长 213.6px 里 2% ≈ 4px,段一多就只剩缝;满宽的堆叠条(372px)里 2% = 7.4px,看得见。
- **任务那一段再按 `scripts[].duration` 分成"被 LoAF 归到脚本的"与"没归到的"(后者是**差值**:短于上报阈值的脚本 + 事件派发 / 微任务 / GC),脚本那一段再按 `forcedStyleAndLayoutDuration` / `pauseDuration` 分成 纯执行 / 强制样式布局 / 暂停(**三者是 `duration` 的分区,相加 = 脚本耗时**;为 0 的两项不显示,免得把行挤成两行)。**绘制与合成分不开**(页面内没有 API,那一层在缺失声明里),所以最后一段是"剩下的都在这儿",不能读成"样式布局占比"。
- **脚本侧是同一份耗时的三种切法,六行 = 三种 × 两个分母**:① 三分(纯执行 / 强制 / 暂停);② **按包**(`packageOfScript(url, charPos)`,与 `incident.packages` 同一条 resolve 路;**只覆盖定得到包名的脚本,合计 ≤ 脚本耗时** —— 定不到插件包名的那部分**另起一段「其余来源」,而且按原因给名字**(`unresolvedLabel`),不笼统写"未定名":URL 空 → `无 URL(内联脚本)`;URL 在 `plugins/` 下但没拆 → `插件批次(未按 sourcemap 拆)`;其余有 URL 的 → **直接用文件名**(多半是应用自己的外壳 bundle,实测 `/assets/index-<hash>.js`,React 根容器上的事件处理器就来自它)。⚠️ 这一层只覆盖插件包,所以「其余来源」那段**必须写毫秒**(只写条数会和同一行的 ms 混单位,实测被读成"按包这一层只有 16ms",而那条没定名的占了 234ms);同理,只报"有名字的那部分"会让人把那 200ms 当成这一层的全部 —— 实测窗口里 1116.8ms 脚本只有 200ms 定到包。**先看「其余来源」多少毫秒,再读排行**;这一行在 `top` 与 `byOther` 都空时才退成"未定名/要深录");③ **按来源**(`invokerLabel(script)`:LoAF 的 `invoker`,归一规则 `SCRIPT[…]`→`script`、带冒号取最后一段、截 28 字符、缺失退 `invokerType`;**覆盖全部脚本,合计 = 脚本耗时**)。②③ 的合计**本来就不相等**,不要互相印证 —— 有断言钉住这件事(160 vs 150)。「本帧」= 饼图那一帧(`framePkgTally`),「窗口」= 最近 `WATCH_LOAF_MAX` 条的聚合(`scriptPkgTally`,按窗口指纹 `loaf.length|最新一条的 t` 缓存;本帧那份 ≤ `WATCH_SCRIPT_MAX` 条脚本,不缓存)。**窗口那三行必须带上它们的分母**(`windowScopeText`:条数 + 跨度 + 平均每条)—— 它们是累计,`纯执行 21623.8ms` 不写分母就会被读成"某一次执行花了 21 秒"(真被这么质疑过:200 条长帧各百来毫秒,攒起来就是二十几秒);跨度越久累计越大,所以那一行还写明"别读成越来越慢"。`tallyScripts` 因此多带 `byOther`(其余来源:文件名 / 无 URL / 插件批次,带毫秒)、`unresolvedMs`、`count` 与 `spanMs`(最后一条 t − 第一条 t),`spanText(ms)` 把它写成人读的`43分12秒`—— `group()` 的 children 是**先求值再传参**的,收起时也照样构造,不缓存就等于每 tick 重算 200×12 条脚本。
- **拆解视图的铁律(2026-10-08 定,来自成熟工具的做法)**:面板上凡是"把一份总量拆成比例"的地方,都按这三条来 ——
  ① **一张图只表达一个维度**。同一总量的**分区**(互斥、相加=100%,如帧的任务/渲染/尾)是一条 100% 堆叠条,段少(≤4)时才用环;同一总量的**另一种切法**(正交、各自相加=100%,如按包 / 按来源)**不能并列进同一张图** —— 那种错法是"一半弧按包、另一半按来源",我们**没有**这么干。环的适用边界是"≤4 段、**不带嵌套**":层级在环上只能靠同色深浅 + 缝表示,读者得 hover 才读懂,84px 里 2% 的段直接看不见。**这条债务 2026-10-08 已还**:环只画四段,来源与包各一条 100% 堆叠条,两个正交维度做成交叉表;改动的实测证据在 [REVIEW.md](REVIEW.md) §2 的"拆解视图"一行。
  ② **层级**才用火焰/冰柱图(帧 → 任务 → 脚本 → 函数);**帧内脚本时间轴做不了** —— LoAF 只给每条脚本的时长,不给它在帧内的起止。
  ③ **跨视图一致 + 自带分母 + 绝对值与占比并列**:同一个来源在环、条、表里必须同色;每条轴都要写出自己的分母(窗口那行的 `窗口:200 条长动画帧 · 跨 43分12秒 · 平均每条脚本 108.1ms` 就是范式);只给百分比不给毫秒会被读错。Sankey / 平行集**不做**:表达力换来的是可读性,面板这块地方不划算。
- **这一层的天花板(实测,不是推断)**:`invoker` 只回答"哪一类调用",函数级要采样器;页面内唯一那个是 JS Self-Profiling —— `typeof Profiler === 'function'`,但 `new Profiler({…})` 抛 `NotAllowedError: JS profiling is disabled by Document Policy.`,因为 HTML 响应**没有** `Document-Policy` 头(实测 `null`),而那个头由 DSH 服务的 HTML 决定(动它就越过 §0 的边界)。→ 函数级只剩 CDP / DevTools Performance(`missing` 里的 `devtools-trace`);宿主进程的函数级另有 A5 的 `node:inspector`。
- **脚本那几行走块式布局,并分成两个小标题**:「本帧」那组(脚本细拆 / 按来源条 / 按包条)与「窗口」那组(标题自带分母)各由一行小标题管范围 —— 行标签就不再重复"本帧 / ·窗口"(省的不是一两行,是每行三四个字)。值实测可到 352px(en 最坏),真数据下会超一行(`按来源` 39px = 两行:`DOMWebSocket.onmessage 425ms · setTimeout 421ms · …`),`S.row` 的右对齐会折成参差的两行(与 §5 那条"长文本用块式"是同一件事)。
- **面板会自己藏掉没意义的行**(字太多本身就让人读不动):没插桩时(`state.deep !== true`)不渲染 `回调归因` 那一段(否则是 `0ms/s` + 空表,还会被读成"没有开销")、不渲染 `DOM 写入(按插件) 0`;`命中` 那一行只列**非零的腿**(`hitText`;否则永远是 `245/0/0/0`),比率与概览同一口径(`ltBlamed/ltTotal`);`归属 Top` 的尾巴上不再重复「记录器自身 N×」—— 它上面就有独立一行。一个包名都没定到时,两行「按包」收敛成**一行带分母**的说明 `按包:0 条定到名(本帧 1 · 窗口 461 条脚本)· 要深录` ——「一个名都没定到」不带分母,读者会以为这一层被删了(实测被这么问过)。行距也收紧过(`S.row` marginTop 5→4、`S.sep` 10/9→8/8)。
- **帧拆分的 clamp(向下夹)**:`frameSplit` 里 `js ≤ head`、`forced + pause ≤ js`、`exec ≥ 0` —— 每条脚本的毫秒各自 `round1`,脚本多而每条约 0.05ms 时求和会反过来超过父区间(四舍五入的算术后果);不夹就会画出负长度的弧。三条都有断言。
- **60 秒帧条**:一格一秒、格值 = 该格里**最差那一帧**的间隔,`sparkLevel` 的阈值与 `tools/inspect-incident.mjs` 的 ASCII 条带**逐条对应**(logic.mjs 有一条静态断言读那个文件核阈值,改一处忘另一处会红);整格 rAF 挂起画成矮灰柱。重绘指纹里带 5 秒刻度,否则空闲时帧条会冻在展开那一刻。
- **记录器自身(A1)**:每帧给 HUD 自己的 rAF 回调自计时,留最近 `SELF_RING = 600` 帧,面板与导出件(`context.recorder`)给 `p99` / 峰 / 样本数。这条的读法是"测量工具自证没有明显改变被测对象",**不要读成页面开销**。
- **深录(D1)是唯一的插桩开关**:`applyProbeState()` 只在 `state.deep` 打开时装 `setTimeout` / `setInterval` / `rAF` 与 `appendChild` / `insertBefore` / `setAttribute` 的包装,并同步精确归因(`setDeep` 里两者互锁)。守夜与现场是**同一档采集**,只差面板收放 —— 所以"展开面板会不会改变读数"的答案是**不会**。
- **归因表行**:`cps/s · 峰 cpsPeak/s`(EMA α=0.4 平滑的执行速率 / 单秒最大执行次数);行悬停给该秒同步耗时 `ms/s` 与累计 `N× / Xms`。覆盖范围只有三次调度的回调 → 是**下界**。
- **「其余 (N)」** = 除 Top3 外还有几个归属方(名字各不相同,按累计耗时排在后面),行值给它们的**合计速率**(与上面几行同一单位)。
- **DOM 写入(按插件)**:精确总次数 + 每个写入者的 `≈` 估算(1/10 采样,命中按 10 折算);带括号的名字来自"组件兜底桶"。**本 HUD 自身的写入不记账**。
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
3. `.github/workflows/release.yml` 在该 Release 发布时自动 `npm publish`(用 **npm Trusted Publishing / OIDC**,不配 `NPM_TOKEN`)。
4. 首次需要在 npmjs.com 手动建包并配 Trusted Publisher(Provider: GitHub Actions;填 owner / repo / `release.yml`)。
5. 发布后核对产物:`npm pack --dry-run` 里必须带上 `index.js` / `client.js` / `cordis.patch.yml` / `icon.svg` / `locale/en.json` / `LICENSE`,以及 README 与 AGENTS 链接到的全部文档(`README_EN` / `CONTRIBUTING` / `REVIEW` / `CHANGELOG` / `AGENTS`)与 `tools/`(事故包渲染器 + 三个 CDP 验证器,README 让用户直接跑它们,所以必须进包)—— 漏一份,npm 页面上就是一个死链。`release.yml` 的 Pack and inspect 步骤逐份 grep,漏了就失败。

---

## 11. 当前状态

**v0.3.0 已就绪并已推到 origin**(`main` 与 `origin/main` 同步,`tag v0.3.0` 已推):`npm test` 当时 **342** 条全绿、
`npm pack --dry-run` **18 个文件**、tag 与 `version` 一致。

**v0.3.0 之后落在 `main` 上的改动**(还没 bump 版本、没打 tag):「帧里花在哪」从三段饼改成四段饼
(脚本 / 任务里没归到脚本的 / 渲染 / 样式+布局+绘制),脚本侧再拆三层并分成**本帧与窗口两个分母**;
`npm test` 现在 **374** 条(attribution 11 / logic 324 / host 39),真页面 `check-panel` 验过(见 REVIEW §2)。

**卡在哪**:`npm publish` 需要 npm 凭据,本机没有(`ENEEDAUTH`)—— 这一步等用户解锁。两条路(本机 `npm login` 后发,
或 npmjs.com 建包 + 配 Trusted Publisher 后由 Release 触发 `release.yml`)写在 [REVIEW.md](REVIEW.md) §3.1。

**仓库仍是私有**(转公开 + 加 `dsh-plugin` topic 还没做),收录 PR 还没提;三条新发现的尾巴(A5 还没接进客户端/导出件、
D4 的 `stressText()` 死代码、`locale` 的打包边界)也记在 REVIEW §3.2。已完成的验收证据在 REVIEW §2。

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
