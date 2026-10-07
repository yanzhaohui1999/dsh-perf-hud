# dsh-perf-hud 仓库规则(AGENTS)

> 本文只含**项目全局开发规则**(面向贡献者与 agent)。
> 装什么怎么用 → [README.md](README.md);验收数字 → [ACCEPTANCE.md](ACCEPTANCE.md);
> 环境事实 / 源码级机制 / 已证伪死路 → [HANDOVER.md](HANDOVER.md);发布缺口清单 → [REVIEW.md](REVIEW.md)。

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
- **不凭记忆写 API**:本项目的每一步(路由注册形态、事件名、sourcemap 形态、DOM 钩子)都来自当场读源码或实测;记忆里"应该如此"的东西(`data-dsh-plugin`、包 `Context.emit`)都被证伪过。

---

## 2. 改动生效方式(决定你能不能验证)

| 改动 | 生效方式 |
|---|---|
| `client.js`(客户端半) | `dsh-client-hmr` 轮询 mtime/size 自动热载;**刷新页面**最稳 |
| `index.js`(宿主半) | **必须重启宿主服务**(本机 `launchctl kickstart -k gui/$(id -u)/ai.dsh.web`) |
| `package.json` 的 `dsh.client` / `dsh.bundle` | 需要重新扫描(重装或重启) |
| 纯文档(`*.md`) | 无需任何操作 |

⚠️ **重启会杀死正在跑这个插件的会话**:agent 的 bash 工具进程就在 `dsh web` 进程内(实测进程链)。改宿主半后要重启时,把重启排在报告之后(`nohup bash -c 'sleep N; launchctl kickstart …' &`)或交给用户执行,**不要在会话中途重启**。

为什么宿主插件没有文件监听:本 profile 的 `dsh-hmr` `config.root` 是 `[]`,它只在 bundle 列表或 patch 文件**内容**变化时 reconcile —— 这是机制原因,不是偷懒。

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

---

## 3. 测试与门禁

**每次改完必须跑三套件**(改文案还要顺带跑长度预算与单位一致性断言):

```sh
node tests/attribution.mjs   # 11 条:客户端脚本 URL 形状 → 包名 / bundle key
node tests/logic.mjs         # 152 条:从 client.js 抽真函数进沙箱 + 静态检查 + 长度预算
node tests/host.mjs          # 24 条:用假 ctx 驱动真实 index.js(路由 / 事件循环 / confirm 安全线)
```

线上(需要从宿主日志换 cookie,见 [HANDOVER.md](HANDOVER.md) §2):

```sh
DSH_COOKIE=… node tests/live-sourcemap.mjs   # 真实 indexed sourcemap 的分段与包名
DSH_COOKIE=… node tests/live-host.mjs        # 真实路由;退出码 3 = 宿主半还没重启加载
```

测试写法约定:

- **测线上那份代码**:`logic.mjs` 用 `new Function(source + 'return {…}')` 把 `client.js` 里的真函数抽进最小环境,新增函数想被测就加进 `pieces` 列表 + 在桩里补它用到的键。**不要另写一份等价实现来测。**
- **口径有歧义就加断言,不要加注释**:注释不能防回归,断言能。
- **静态检查必须有牙齿**:`logic.mjs` 顶部两条(① `h(Uppercase…)` 引用的组件必须声明过;② 面板渲染区里的裸函数调用必须声明过)是"整段替换吞掉相邻声明"事故的回归测试;验证它的办法是把声明删掉看它是否报出名字。
- 断言总数写进 [README.md](README.md) 与 [ACCEPTANCE.md](ACCEPTANCE.md),**改数字要同步改文档**。

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
- **标签不收缩、数值换行**:行布局是 `label { flex: 0 0 auto; nowrap }` + `value { flex: 1 1 auto; textAlign: right }`;反过来会把标签挤成"一字一行"。
- **长文本用块式 + 主动断行**:可能超一行的行(概览、折叠摘要)用"标签独占一行 + 值左对齐 + `white-space: pre-line` 自己给 `\n`",不要赌浏览器宽度。
- **长度预算**:概览两行与四个折叠组摘要都有字符上限,由 `tests/logic.mjs` 钉住。改文案必须重跑。
- **i18n 词典成对改**:`DICT.zh` 与 `DICT.en` 同时加键;兜底策略与"哪些串还没进词典"见 [REVIEW.md](REVIEW.md) §2。
- **插桩必须可还原**:包装 `setTimeout/setInterval/rAF` 与 `appendChild/insertBefore/setAttribute` 时,保存原生引用、只在"当前仍是我们那个 wrapper"时才还原(避免踩掉别人的包装)。
- **改 `client.js` 一律用带锚点的小批次**:一次替换一个可唯一匹配的片段,失败即整批作废。本项目有**两次**"整段替换吞掉相邻声明"的事故(第二次才补上静态检查)。

---

## 6. 已知坑

1. **`monitorEventLoopDelay` 的 `resolution` 默认 10ms**,会把 p50 顶到 ~10ms 的地板;本项目用 `1`(单位是纳秒)。
2. **合并包里没有 `sourceURL` 边界标记**,包名只能靠它自带的 **indexed sourcemap** 还原;`sections[i].offset.line` 是 0-based,而 V8 的 `CallSite.getLineNumber()` 是 1-based。
3. **生产 React 没有 `_debugSource`**,组件名只能靠 `type.displayName ?? type.name`;压缩名(`n5`/`Bn`)必须过滤。
4. **宿主外壳名不是答案**(`SlotOutlet` / `CenterColumn` / `*Boundary` / `*Provider` / `*Context`),走查要跳过继续找。
5. **外壳的 `SlotErrorBoundary` 会在条目渲染抛错时永久停用该条目**(只能刷新恢复),所以 `client.js` 自带 `HudBoundary`。
6. **命中率会被 DOM 腿抬高**:流式时写入窗口内几乎必然有写入,必须配合「归属 Top」分布读,不能单看命中率。
7. **隔离实验的合成负载是"恒定的额外工作"**,不是"该插件的真实负载" —— 能测固定开销,测不出"某种用法下才贵",不要当因果证明。
8. **`git push` 不会带走 `refs/original/`**,但本机改写历史后旧提交仍在 `.git` 里,要清理得显式 `reflog expire + gc`。
9. **改 `engines.dsh` / `peerDependencies` 前必须用真实 semver 验一遍**:宿主启动预检(`plugin-compatibility`)对 `@deepseek-ai/dsh` 与所有 `@deepseek-ai/dsh-*` peer 跑 `semver.satisfies(宿主版本, range, { includePrerelease: true })`,不满足就把**整行静默禁用**(只在 stderr 留一行 `disabling profile plugin …`)。两条实测结论(宿主 `0.2.0-rc.2`):
   - `>=0.2.0-rc.2 <0.3.0-0` → PASS;`^0.2.0-rc.1` → PASS;`>=0.1.5-rc.1` → PASS
   - `^0.1.5-rc.1` → **FAIL**(caret 的上界落在下一个 minor 上,且范围里没有与宿主同 `[major,minor,patch]` 元组、自带预发布标签的比较子 → 预发布版本被静默排除)。生态里 `dsh-context` 用 `>=0.1.5-rc.1` 这种**开区间**写法能过,换成 caret 就会踩这个坑。
   - 验法:`node -e "console.log(require('<dsh>/node_modules/semver').satisfies('0.2.0-rc.2', RANGE, {includePrerelease:true}))"`。
   - `peerDependenciesMeta.optional` **不豁免**这条检查;`engines.dsh` 只是声明(市场卡片按它或 lockstep peer 判),不参与预检。

---

## 7. 文档地图

| 文件 | 管什么 |
|---|---|
| [README.md](README.md) | 用户视角:装什么、怎么装、读数怎么看、有什么风险 |
| [AGENTS.md](AGENTS.md)(本文) | 开发规则:约束、门禁、提交规范、代码约定 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献流程:报 bug、提 PR、提交前自检 |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 验收判据与实测数字(含评审响应记录) |
| [HANDOVER.md](HANDOVER.md) | 环境运维事实、源码级机制、已证伪死路、控制台 API 与存储键位 |
| [REVIEW.md](REVIEW.md) | 发布就绪评审:缺口、证据、待办清单 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |

---

## 8. npm 发版

1. bump `package.json.version`,跑完 §3 的门禁并全绿。
2. 打 tag `vX.Y.Z`(**tag 必须与 `version` 一致**),在 GitHub 建 Release。
3. `.github/workflows/release.yml` 在该 Release 发布时自动 `npm publish`(用 **npm Trusted Publishing / OIDC**,不配 `NPM_TOKEN`)。
4. 首次需要在 npmjs.com 手动建包并配 Trusted Publisher(Provider: GitHub Actions;填 owner / repo / `release.yml`)。
5. 发布后核对产物:`npm pack --dry-run` 里必须带上 `index.js` / `client.js` / `cordis.patch.yml` / `icon.svg` / `locale/*.json` / `LICENSE`,以及 README 与它链接到的全部文档(`README_EN` / `CONTRIBUTING` / `CHANGELOG` / `AGENTS` / `HANDOVER` / `ACCEPTANCE` / `REVIEW`)—— 漏一份,npm 页面上就是一个死链。`release.yml` 的 Pack and inspect 步骤逐份 grep,漏了就失败。

---

## 9. 当前状态

尚未发布。代码与打包面都已就绪(`npm test` 全绿、`npm pack --dry-run` 产物完整),剩下的是对外动作:建公开仓库 → 加 `dsh-plugin` topic → npm 首发 → 提收录 PR。逐项清单与门槛见 [REVIEW.md](REVIEW.md) §5 与 §1。
