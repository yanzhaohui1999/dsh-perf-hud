# dsh-perf-hud 仓库规则(AGENTS)

> 本文含**项目全局开发规则 + 源码级机制**(面向贡献者与 agent)。
> 装什么怎么用、读数怎么看 → [README.md](README.md);验收数字 → [ACCEPTANCE.md](ACCEPTANCE.md);
> 发布缺口与门槛 → [REVIEW.md](REVIEW.md)。

---

## 0. 项目边界

**纯客户端性能 HUD**:一个浏览器半(`client.js`,右下角浮层)+ 一个宿主半(`index.js`,只提供事件循环与 bundle 代理两个探针)。
它**测量别人的性能**,所以它自己必须便宜、可关、可还原 —— 这条决定了下面几乎所有规则。

不做的事:

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

---

## 3. 测试与门禁

**每次改完必须跑三套件**(改文案还要顺带跑长度预算与单位一致性断言):

```sh
node tests/attribution.mjs   # 11 条:客户端脚本 URL 形状 → 包名 / bundle key
node tests/logic.mjs         # 152 条:从 client.js 抽真函数进沙箱 + 静态检查 + 长度预算
node tests/host.mjs          # 24 条:用假 ctx 驱动真实 index.js(路由 / 事件循环 / confirm 安全线)
```

一条命令跑完:`npm test`。线上(先按 §2.2 换 cookie):

```sh
DSH_COOKIE=… node tests/live-sourcemap.mjs   # 真实 indexed sourcemap 的分段与包名
DSH_COOKIE=… node tests/live-host.mjs        # 真实路由;退出码 3 = 宿主半还没重启加载
```

测试写法约定:

- **测线上那份代码**:`logic.mjs` 用 `new Function(source + 'return {…}')` 把 `client.js` 里的真函数抽进最小环境,新增函数想被测就加进 `pieces` 列表 + 在桩里补它用到的键。**不要另写一份等价实现来测。**
- **口径有歧义就加断言,不要加注释**:注释不能防回归,断言能。
- **静态检查必须有牙齿**:`logic.mjs` 顶部两条(① `h(Uppercase…)` 引用的组件必须声明过;② 面板渲染区里的裸函数调用必须声明过)是"整段替换吞掉相邻声明"事故的回归测试(§8 第 7 条);验证它的办法是把声明删掉看它是否报出名字。
- **宿主半可离线真跑**:`tests/host.mjs` 用假 `ctx`(含 `connection.fetch.register` / `pluginManager` / `ctx.on`)驱动真实 `index.js`,断言路由、事件循环升温、confirm 安全线。
- 断言总数写进 [README.md](README.md) 与 [ACCEPTANCE.md](ACCEPTANCE.md),**改数字要同步改文档**;CI 里有一条门禁专门核这个。

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
- **长度预算**:概览两行与四个折叠组摘要都有字符上限(36 / 60 / 30 / 30 / 34 / 24),由 `tests/logic.mjs` 钉住 —— 本会话看不到浏览器渲染,只能靠预算把"又挤成三行"这类回归钉在测试里。改文案必须重跑。
- **单位一致性**:同一张表里不许一处给 `/s`、另一处给累计;任何"和邻居不同单位"的读数都要有断言(曾出现"上面是 /s、下面给累计")。
- **i18n 词典成对改**:`DICT.zh` 与 `DICT.en` 同时加键;兜底策略与"哪些串还没进词典"见 [REVIEW.md](REVIEW.md) §2。
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
- **帧内未归因**峰值 ≈ 最差帧(≥95%)时,面板自动给结论"该帧几乎无 JS 解释",并提示用 Rendering 面板的 Paint flashing 交叉验证。**CSS 动画只在这里现形**(它不经 JS 调度器)。
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

---

## 9. 文档地图

| 文件 | 管什么 |
|---|---|
| [README.md](README.md) | 用户视角:装什么、怎么装、读数怎么看、有什么风险 |
| [README_EN.md](README_EN.md) | 英文版(摘要式,结论与中文版一致) |
| [AGENTS.md](AGENTS.md)(本文) | 开发规则 + 源码级机制 + 已知坑 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献流程:报 bug、提 PR、提交前自检 |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 验收判据与实测数字(含评审响应记录) |
| [REVIEW.md](REVIEW.md) | 发布就绪评审:缺口、证据、待办清单 |
| [DIRECTION.md](DIRECTION.md) | 方向评审与设计讨论:为什么从"仪表盘"改成"行车记录仪 + 事故包"、官方会不会撞、理想形态 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |

---

## 10. npm 发版

1. bump `package.json.version`,跑完 §3 的门禁并全绿。
2. 打 tag `vX.Y.Z`(**tag 必须与 `version` 一致**),在 GitHub 建 Release。
3. `.github/workflows/release.yml` 在该 Release 发布时自动 `npm publish`(用 **npm Trusted Publishing / OIDC**,不配 `NPM_TOKEN`)。
4. 首次需要在 npmjs.com 手动建包并配 Trusted Publisher(Provider: GitHub Actions;填 owner / repo / `release.yml`)。
5. 发布后核对产物:`npm pack --dry-run` 里必须带上 `index.js` / `client.js` / `cordis.patch.yml` / `icon.svg` / `locale/en.json` / `LICENSE`,以及 README 链接到的全部文档(`README_EN` / `CONTRIBUTING` / `CHANGELOG` / `AGENTS` / `ACCEPTANCE` / `REVIEW`)—— 漏一份,npm 页面上就是一个死链。`release.yml` 的 Pack and inspect 步骤逐份 grep,漏了就失败。

---

## 11. 当前状态

尚未发布。代码与打包面都已就绪(`npm test` 全绿、`npm pack --dry-run` 产物完整),剩下的是对外动作:仓库已建(私有,`yanzhaohui1999/dsh-perf-hud`)→ 转公开 → npm 首发 → 提收录 PR。逐项清单与门槛见 [REVIEW.md](REVIEW.md) §5 与 §1。
