# dsh-perf-hud 交接文档

本文件记录**只存在于开发对话里、代码注释与验收单没写全**的东西:环境运维事实、源码级机制、
已证伪的死路、读数口径、验证手法、已知缺口。三份文档的分工:

| 文件 | 管什么 |
|---|---|
| `README.md` | 装什么、怎么装、有哪些能力(用户视角,10 行) |
| `ACCEPTANCE.md` | 验收数字、方法、评审响应、设计取舍 |
| `HANDOVER.md`(本文) | 接手的人**必须先知道**的环境事实、机制、死路与工作规则 |

---

## 1. 环境与运维事实(直接影响操作)

- DSH **0.2.0-rc.2**;profile 目录 `~/.dsh/profiles/web`;本仓库以 `link:` 装入该 profile
  (`dsh plugin --profile web add /Users/y/workspace/dsh-perf-hud`)。
- 服务由 launchd 托管:`ai.dsh.web`。重启命令 `launchctl kickstart -k gui/$(id -u)/ai.dsh.web`。
- ⚠️ **重启会杀死正在跑这个插件的会话**:已用 `libproc`(`proc_pidinfo`)实测进程链,agent 的
  bash 工具进程 → `node`(**就是 ai.dsh.web 自己**,第一次重启时 pid 6870,第二次 2848 → 7664)。
  所以"改宿主半 → 重启"这件事**不能在会话中途做**,会连本回合一起收掉;正确做法是把重启排在
  报告之后(`nohup bash -c 'sleep N; launchctl kickstart …' &`)或交给用户执行。
- **改哪个文件要做什么**:
  | 改动 | 生效方式 |
  |---|---|
  | `client.js`(客户端半) | `dsh-client-hmr` 轮询它的 mtime/size → 自动热载;**刷新页面**最稳 |
  | `index.js`(宿主半) | **必须** `kickstart` 重启服务 |
  | `package.json` 的 `dsh.client` / `dsh.bundle` | 需要重新扫描(重装或重启) |
- `dsh-hmr` 在本 profile 的 `config.root` 是 **`[]`**(见 `dsh --profile web --dump-config`)→
  **宿主插件文件根本没有文件监听**;它只在 profile 的 bundle 列表或 patch 文件**内容**变化时
  reconcile。这就是"宿主改动必须重启"的机制原因,不是偷懒。
- `dsh --profile web --dump-config` 会**写** `~/.dsh/profiles/web/cordis.yml`(`prepareProfile`),
  因此需要 profile 写权限;沙箱下会以 `EPERM: open '…/cordis.yml'` 失败。
- 浏览器在 **Windows**,经 SSH 隧道访问 Mac 的 `127.0.0.1:3080`。这条链路是 **RTT p50 数十到
  300ms 级**的真实隧道,而本机 curl 同一路由只要 ~2.6ms —— 面板里「链路 RTT」高是**真实**的,
  不要当成 bug(见「疑似链路」判定)。

## 2. 没有浏览器时怎么验证(本项目的主要验证手段)

1. **cookie 三步**(完整步骤见 `~/.dsh/dsh-api.md`):从 `~/Library/Logs/ai.dsh.web.log` 取 `token=…`
   → `curl -H "Host: 127.0.0.1:3080" "http://127.0.0.1:3080/?token=$TOKEN"` 拿 `Set-Cookie`
   → 之后 `/api/*` 都带这个 cookie。**token 每次重启都换**,换 cookie 必须在重启**之后**做
   (第一版 `tests/verify-after-restart.sh` 就是踩了这个坑:`cookie len=0` → 一路 401)。
2. 鉴权行为:`/api/dsh-perf-hud/host` 无 cookie → **401**;路由未注册(宿主半没加载)→ **404**。
   所以脚本用 `http==404` 判定"宿主半未加载"(退出码 3,与"实现有 bug"区分开)。
3. Cordis inspect(无需 cookie,走已连接页面):`cordis_inspect_query`
   - Client `Slots` → `listSubTree(root: 'shell.overlay')`:能看到本插件条目。
     **`active: false` 就是"渲染抛错被外壳停用"的硬证据**(实测过一次,见 §3 的边界条目)。
   - Host `Config.listConfigs(name: 'dsh-perf-hud')` → 行是否注册(`status: absent` 是正常的,
     因为宿主半没有 `Config`)。
   - Client `Builtin.listBuiltins` → 动态客户端半能用的符号(`ctx/React/host/styles/console`)。
4. 可复用的脚本(都在 `tests/`):
   `attribution.mjs`(URL 解析)、`logic.mjs`(纯逻辑 + 静态检查)、`host.mjs`(宿主半离线)、
   `live-sourcemap.mjs`(线上真实 sourcemap)、`live-host.mjs`(线上宿主半)、
   `verify-after-restart.sh`(重启后自动跑前两个,`setsid` 起在**独立进程组**才能活过重启)。

## 3. 客户端捆绑与归因机制(源码级事实,决定归因怎么做)

- 客户端脚本的 URL 形态(来自 `dsh-client-modules@0.2.0-rc.2`):
  - 单包组合:`plugins/??<包名>/client.js&rev=<hash>` — **动态装载时一个包一条**
  - 包内分片:`plugins/<包名>/<分片>.js?rev=<hash>`
  - 启动批:`plugins/??a/client.js,b/client.js&rev=<hash>` — 本版本**只 preload 不执行**
    (实测 application 批 58 包,rev 会随文件 mtime/size 变)
- **合并包里没有 `sourceURL` 边界标记**,包名只能靠它自带的 **indexed sourcemap**:
  `plugins/??a/client.js.map,b/client.js.map&rev=<hash>` → `sections[i].offset.line`(0-based)
  + `map.sources[0]` → `/plugins/<包>/…`;V8 的 `CallSite.getLineNumber()` 是 1-based,换算减一。
  线上实测:58 sections、包名与批次 `entries` **顺序完全一致**、116 处边界断言 0 错。
- `window.__DSH_BOOT__` = `{ rev, entries, batches }`(首页内联);批次的 `phase` 用它取名
  (`application` / `bootstrap`),包数 = `batches[i].entries.length`。
- **`data-dsh-plugin` 在本版本不存在**(不能靠它归因);可用的稳定 DOM 钩子只有:
  `[data-chat-running]`(流式判定)、`[data-conversation-content]`/`[data-chat-flow]`(消息区)、
  `[data-row-key]`(会话行的 `parentElement` 当会话列表容器)、`[data-shell-overlay]`。
- 归因有四条腿,**各有能力边界**(面板会同时给出不一致的两条,不挑好看的报):
  | 腿 | 机制 | 擅长 / 局限 |
  |---|---|---|
  | `fiber` | 从被改动节点**往祖先**走最近的具名函数组件 | 擅长增量更新;整棵子树一次性挂载时只能给到容器 |
  | `子树` | 从被改动节点**往子树**走,优先 `alternate === null`(React 标记"本次新挂载") | 补"整棵挂载"空档(切视图实测);有界 BFS ≤200 |
  | `DOM写入` | 采样 `appendChild/insertBefore/setAttribute`(1/10),在写入点抓栈 + 取组件名 | 提交阶段栈里没有插件帧时的主力;估算值带 `≈` |
  | `包名` | 调度点插桩(`setTimeout/setInterval/rAF`)与长任务时间重叠 | 定时器/动画类;事件处理器、Promise、微任务**不在内** |
- 宿主外壳组件名**不是答案**:`SlotOutlet`(槽位座)、`CenterColumn`(布局列)、
  `*Boundary/Provider/Context`、错误边界(靠 `componentDidCatch` 原型判断)、生产构建压缩名
  (`n5`/`Bn`,大小写 1~2 字母+数字)一律跳过继续找。**这是补丁,不是根治**;根治靠上面四条腿交叉。
- 外壳的 `SlotErrorBoundary`(在 `dsh-client-ui-renderer`)会在条目渲染抛错时
  `console.error('slot entry crashed in …')` 并**永久停用该条目**(`active: false`),只能刷新恢复。
  所以 `client.js` 里有自带的 `HudBoundary`,把错误降级成一块小面板并写进导出的 `errors` 段。
- 生产 React **没有** `_debugSource` / `jsxDEV` → **无法**从 fiber 直接拿到组件定义文件,
  组件名只能靠 `type.displayName ?? type.name`。

### 3.1 面板排版规则(都是被吐槽后定下来的)

- **只用 theme token**(`--dsw-alias-*`),不 require 任何 Harness Client 包(`dsh-client-ui-primitives`
  一律不碰);颜色只用 token,字面色仅限插画。
- **整数 px、整数字重**:`11.5px` / `fontWeight: 650` 在 125%~150% 显示缩放下会触发**合成加粗 +
  重新栅格化**,观感发糊(实测被吐槽"糊糊的")。用 `12px` / `700`。
- **标签不收缩、数值换行**:行布局是 `label { flex: 0 0 auto; nowrap }` +
  `value { flex: 1 1 auto; textAlign: right }`。反例:标签用 `flex: 1 1 auto` 时会被长数值挤成
  "一字一行"(实测「宿主事件到达」竖排过)。
- **长文本用块式**:长度可能超一行的行(概览、折叠组摘要)用"标签独占一行 + 值左对齐换行"的
  `S.block`,**不要塞进右对齐的 flex 行**——否则换行参差得像段落。
- **主动断行**:值节点用 `white-space: pre-line`,自己给 `\n`;不要赌浏览器宽度
  (曾断在 `最多` 后面、把 `ChatView 22×` 甩到下一行)。
- **能不说就不说**:`最多` 与 `最差那条` 名字相同时整行不显示;说明文字放 `title` 悬停,
  不占正文(见 ACCEPTANCE.md 的评审响应)。
- **长度预算**:概览两行 ≤36/60 字符,四个折叠组摘要 ≤30/30/34/24 —— 有断言钉住(`tests/logic.mjs`)。

## 4. 宿主侧 API 事实(本插件实际用到/验证过的)

- 挂 HTTP 路由的形态(照抄 `dsh-context`):
  `ctx.inject(['connection'], c => { const reg = c.get('connection')?.fetch?.register?.bind(...); c.effect(() => reg({ path, methods: ['GET','POST'], requestBody: 'buffered', fetch: handler }), label) })`。
  handler 收到 Web `Request`,返回 `Response.json(...)`。
- `pluginManager`:`listBundles()` / `setBundleEnabled(name, enabled)` 是 `@Remote`(客户端可经
  `ctx.remote.pluginManager` 调),但**宿主半可以直接调**(本插件就是);两者回执形状相同
  (`{ changed, application, stage, target, enabled, error… }`)。
  ⚠️ **它会写 profile 的 bundle 选择(持久化)** —— 隔离实验因此必须"先读原始列表 → 每步恢复 →
  结束逐项核验",并显式拒绝动 `dsh-perf-hud` 与 `@deepseek-ai/dsh-session-persistence-jsonl`。
- `perf_hooks.monitorEventLoopDelay({ resolution })` 的 **`resolution` 默认 10ms,会把 p50 顶到
  ~10ms 的地板**,看不出真实抖动;本项目用 `1`。单位是**纳秒**。
- 客户端拿宿主数据的两条通道:客户端 `ctx.remote`(本 profile 未接通,面板显示
  `通道 宿主路由 /api/dsh-perf-hud/host`)与宿主路由(已验证)。面板/导出都记 `via`。
- `ctx.on('session/event', (session, event) => …)` 是**公开且可用**的监听方式
  (与 `dsh-session-persistence-jsonl` 同一个事件);`event.time` 是提交时间戳。

## 5. 已证伪的死路(不要重试)

1. **包 `Context.emit` 抓不到 `session/event`**:DSH 该事件走**作用域过滤派发**。证据:装了 120 秒、
   期间一个子代理跑完整回合,`stats` 始终 `{}`。→ 改用 `ctx.on(...)`,口径改成"提交→到达延迟"。
2. **靠 URL 字符串猜合并批次的包名**:合并包里没有边界标记(用户已证实)。→ 用 indexed sourcemap。
3. **靠 `data-dsh-plugin` 归因**:本版本客户端不打这个属性。
4. **`launchctl submit`**:本机被拒(Bad request / 服务未登记)。→ 用 `nohup … &` 排队 +
   `setsid`(Python `os.setsid()`)起独立进程组的验证器。
5. **靠节点数凑 50ms 长任务**:12000 个离屏节点 React 提交仅 ~15ms,20000 个 ~28ms;而且**布局
   可能被推迟到下一帧**,任务里只剩十几毫秒。→ 必须 `flushSync` 强制同步提交 + 在任务里
   **强制布局**(读 `offsetHeight`),仍不稳就**显式燃烧**(面板标注"含人为燃烧")。
6. **期望 `require('react-dom')` 不可用**:实测**可用**,`flushSync` 能强制同步提交
   (自测结果里的 `(同步)` 就是它)。
7. **`h(undefined, …)` 这类"引用了没声明"靠 `node --check` 拦住**:拦不住(语法合法)。
   实测事故:一次"整段替换样式块"把 `PerfHudStress` 与 `signed` 的声明吞掉 → React 抛
   `Element type is invalid` → 外壳停用条目(面板凭空消失,只能刷新)。→ 见 §7 的静态检查。
8. **`workspace/list`**:该端点 404(见 `~/.dsh/dsh-api.md`);查工作区要读
   `~/.dsh/storages/workspace.json` 的 `tables.workspaces` + `global.workspaceIds`。

## 6. 面板读数口径(用户反复问过,已写进面板 hover)

- **场景标签**(标题栏):`流式` / `空闲 Ns` —— 解读所有数字的前提。
- **概览**:`帧 Xms · LT Yms · 命中 a/b[(最差那条:未归因)]`,第二行 `最差那条:<名字>`,
  第三行仅在"整窗最多"与"最差那条"**名字不同**时出现(`整窗最多:X N×`)。
- **命中 a/b** = 四条腿任一给出名字的长任务数 / 长任务总数。**它容易被 DOM 腿抬高**(流式时
  几乎必然命中),所以必须配合「归属 Top」分布读。
- **每条长任务的"来源"**:`owner`=调度方包名、`component`=祖先方向组件、`subtreeComponent`=子树方向、
  `domComponent`=DOM 写入方向;面板用 `/` 并列给出不一致的两条。
- **归因表行**:`cps/s · 峰 cpsPeak/s`(EMA α=0.4 平滑的执行速率 / 单秒最大执行次数);
  行悬停给该秒同步耗时 `ms/s` 与累计 `N× / Xms`。**覆盖范围**:只有
  `setTimeout/setInterval/rAF` 三次调度的回调;事件处理器/Promise/微任务/React 自身调度**不计入**
  → 是**下界**。`其余 (N)` = 除 Top3 外还有 N 个归属方(按**累计耗时**排序),行值给它们的合计速率。
- **DOM 写入(按插件)**:精确总次数 + 每个写入者的 `≈` 估算(1/10 采样,命中按 10 折算);
  带括号的名字来自"组件兜底桶"(拿不到插件归属时按组件名记)。**本 HUD 自身的写入不记账**。
- **帧内未归因** = 帧间隔里没被 JS 回调解释掉的部分(样式/绘制/vsync);**峰值 ≈ 最差帧**
  (≥95%)时面板自动给结论"该帧几乎无 JS 解释",并提示用 Rendering 面板的 Paint flashing 交叉验证。
- **宿主与链路**:宿主 p99 / RTT p99 给阈值色(50/200ms、100/300ms),两者正常时直接写
  `链路已排除(宿主与隧道均正常)`。判色阈值同时写进导出 JSON 的 `context.thresholds`。
- **合并判色**:`fps ≤50` 或 `最差帧 ≥120ms` → 黄;`≤30` 或 `≥200ms` → 红(**任一触发即降色**)。
- **隔离实验**:所有窗口注入同一份**合成负载**(每 250ms 燃烧 8ms,走未插桩的
  `natives.setInterval`,只烧 CPU 不动 DOM 以免污染归因表);每个候选只跟**紧邻基线**对照(A/B/A),
  **噪声底** = 基线↔基线漂移的最大绝对值,Δ 小于它一律标「噪声内」;窗口含流式则标「不可比」
  且**不给结论**。看「超出噪声」列才是证据。

## 7. 测试与验证手法(以及为什么这么写)

- **从 `client.js` 抽真实函数进沙箱**:`tests/logic.mjs` 用 `new Function(source + 'return {...}')`
  把真函数装进最小环境(state/location/localStorage/performance 桩)。好处:测的就是线上那份代码,
  不存在"测的是另一份"。新增函数想被测,只需加进 `pieces` 列表 + 桩里补它用到的键。
- **静态检查(两条,见 `logic.mjs` 顶部)**:① `h(Uppercase…)` 引用的组件必须声明过;
  ② 面板渲染区里的裸函数调用必须声明过。**这就是 §5.7 那次事故的回归测试**;
  验证它有牙齿的办法:把声明删掉看它是否报出名字。
- **长度预算断言**:概览两行与四个折叠组摘要都有字符上限(36/60/30/30/34/24)。
  理由:本会话**看不到浏览器渲染**,只能把"又挤成三行"这类排版回归钉在测试里。
- **单位一致性断言**:任何"和邻居不同单位"的读数都加断言(曾出现"上面是 /s、下面给累计")。
- **宿主半可离线真跑**:`tests/host.mjs` 用假 `ctx`(含 `connection.fetch.register`、
  `pluginManager`、`ctx.on`)驱动真实 `index.js`,断言路由、事件循环升温、confirm 安全线。
- **`setsid` 验证器**:`tests/verify-after-restart.sh` 必须在新进程组里启动
  (`python3 -c "os.fork(); os.setsid(); os.execv('/bin/bash', …)"`),否则会被 launchd 的
  进程组击杀一起带走。
- 跑法:`node tests/attribution.mjs`、`node tests/logic.mjs`、`node tests/host.mjs`(离线,共 183 条断言);
  `DSH_COOKIE=… node tests/live-sourcemap.mjs`、`… node tests/live-host.mjs`(线上)。

## 8. 已知缺口 / 未做 / 观察到的线索

- **`dsh-notify-me` 整个会话零回调** → 它从未出现在归因表里。这是"不存在",不是"没认出";
  若哪天要验它,得先让它真的做点什么。
- **宿主外壳名黑名单是补丁**(§3):靠名字枚举追不上宿主命名。真正的答案是四条腿交叉。
- **合并批次在精确归因关闭时只给一行标签**(`application批次(58 包)`),不展开;这是刻意的。
- **`dsh-cost-meter`**:客户端有 7 个 `setInterval`(10s×2、30s×4、60s×1 + 1 个配置驱动刷新),
  无 rAF、不订阅 `session/event`(读 store 快照)。稳态合计 ≈0.35/s;观察到的
  `0.1/s → 0.9/s(峰 2.3/s)` 与"配置驱动的刷新在回合期间变活跃"一致。**尚未确认**它到底
  在哪个设置里,(线索:`config.sidebarModels.refreshSecond` 一类)。
- **需要人点一次才能有的面板实证**(机制都已程序化验证):
  ① 「精确归因」开关 → 归因表出现单包名;② 「自测:渲染卡顿」→ 115ms 长任务 + `PerfHudStress`;
  ③ 「导出 JSON」→ 三段 + `context` 自描述头(已实际做过一次,见 ACCEPTANCE.md 的导出实测)。
- **隔离实验的合成负载是"恒定的额外工作"**,不是"该插件的真实负载"——它能测出**固定开销**,
  测不出"该插件在某种用法下才贵"。别把它当因果证明(方法文案也这么写)。

## 9. 工作规则(本项目的血泪教训)

1. **改 `client.js` 一律用带锚点的小批次**(一次替换一个可唯一匹配的片段,失败即整批作废)。
   本项目有**两次**"整段替换吞掉相邻声明"的事故(§5.7),第二次才补上静态检查。
2. **每次改完必须跑三套件**;改了面板文案要顺带跑长度预算与单位一致性断言。
3. **口径有歧义就加断言,不要加注释** —— 注释不能防回归,断言能。
4. **不要凭记忆写 API**:本项目的每一步(路由注册形态、事件名、工作区 API、rev/sourcemap 形态)
   都来自当场读源码或实测;记忆里"应该如此"的东西(如 `data-dsh-plugin`、`Context.emit`)都被证伪过。
5. **不许假装成功**:宿主回执、map 解析状态、事件测量是否装上,一律照实显示并写进导出
   (`application`、`mapStates`、`eventWatch.installed/reason` 都是这个原则的产物)。

---

## 10. 控制台 API 与 localStorage 键位(重置/自动化时需要)

`window.__perfHud`(模块级,热更新后指向最新实例):

| 成员 | 作用 |
|---|---|
| `snapshot()` / `export()` | 导出的对象 / 触发下载(与面板「导出 JSON」同源) |
| `table()` / `ring` / `longTasks` | 归因表 / 环形缓冲(500 条) / 长任务明细 |
| `verification()` | 验收自证(四条腿计数、独立包名、空闲基线、导出段名、`hostEvents`) |
| `enable()` / `disable()` | 总开关(等价面板「开启/关闭」,会把原型方法还原) |
| `precise` / `setPrecise(on)` | 精确归因开关与状态 |
| `mark(note)` | 场景标记(等价面板「标记」) |
| `experiment()` / `abortExperiment()` / `baselines()` | 隔离实验的启停与基线读数 |
| `stress(nodes?, burnMs?)` | 渲染型卡顿自测(默认 8000 节点 + 燃烧 80ms;可传参改) |
| `hostEvents(on)` | 宿主 `session/event` 到达延迟的开关 |
| `host()` / `link()` | 宿主回执 / 链路样本 |

localStorage 键位(**清状态时按需删**):

| 键 | 内容 |
|---|---|
| `dsh-perf-hud:ring:v1` | 每秒采样环形缓冲(500 条) |
| `dsh-perf-hud:on` | 总开关(`'0'` 为关) |
| `dsh-perf-hud:collapsed` | 面板是否折叠 |
| `dsh-perf-hud:precise` | 精确归因开关 |
| `dsh-perf-hud:groups` | 四个折叠组的展开状态 |
| `dsh-perf-hud:marks` | 场景标记(最近 100 条) |
| `dsh-perf-hud:map:<rev>:<len>` | 每个合并批次的分段表(按 rev 缓存,同 rev 只拉一次 12MB map) |

**profile 侧被临时改过的状态**:隔离实验期间 `dsh.profile.bundles` 的**启用标记**会被
`pluginManager.setBundleEnabled` 改动(它写的是 profile 的持久化选择,不是 `cordis.patch.yml`);
实验结束会逐项恢复并核验(`isolation.restored.ok`)。中断(点「中止并恢复」或关掉 HUD)也会走恢复流程。
人工核对:`dsh --profile web --dump-config` 里 13 个 bundle 是否与实验前一致。
