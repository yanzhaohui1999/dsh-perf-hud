# 环境与验证

> 从 [AGENTS.md](../AGENTS.md) §2 移出(2026-10-18),正文未改。改代码前后按这里的步骤验证。

## 2. 环境与改动生效方式(决定你能不能验证)

基线环境:DSH **`0.2.1-rc.1`**,profile 目录 `~/.dsh/profiles/web`,本仓库以 `link:` 装进该 profile
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
6. **改完面板 / `apply()` / `start()` 路径之后跑哪个**([死路](dead-ends.md) 第 14 条那条规矩的可执行版本;三个脚本自己起 headless Chrome,零依赖,token 从 `~/Library/Logs/ai.dsh.web.log` 取,共用底座 `tools/cdp.mjs`):

   ```sh
   node tools/check-panel.mjs                     # 面板渲染 0 错误 + 目标元素在场(默认断言面板标题)
   node tools/check-panel.mjs --expr="!!document.querySelector('svg[viewBox=\"0 0 60 18\"]')"
   node tools/check-storage.mjs                   # 写 localStorage → 重新加载 → 读回(落盘/跨会话基线)
   node tools/check-interaction.mjs               # CDP 发真实输入 → 验 event timing 真的交付
   node tools/check-incident.mjs                  # 抓一条真事故 → 逐帧回看 / 切回实时 / 刷新后仍能打开
   node tools/check-counts.mjs                    # 计数跨刷新 + 口径不虚报 + 导出件里没有凭据(真 location 里塞 token)
   node tools/shots.mjs                           # 改完**界面结构 / 文案**之后重出一遍 README 的九张截图(写进 docs/images/)
   ```

   **什么时候必须跑 `check-incident.mjs`**:改完**历史事故回放 / 取证明细的上下文切换**就跑它 —— 它挡的是"上面历史事故、下面另一条实时帧"和"刷新后历史事故打不开"这类离线套件结构上盖不到的事故。它依赖两个 DOM 约定:根节点 `id="dsh-perf-hud-root"`(控件态样式的作用域)与详情区第一行的 `data-ctx-bar="1"`(验收器靠它读"现在是哪个上下文")—— **改这两个名字等于改验收器**,改之前先看 `tools/check-incident.mjs`。

   ⚠️ **验收器被强杀会留下 headless Chrome 占着 `--user-data-dir` 与调试端口,后续跑会"挂死"**(2026-10-13 踩过):症状是 `waitForHud` 之后的第一次 `evaluate` 永不返回(不是超时报错,是**一直等**),因为新实例连上的是那个残留实例。处置:`pkill -f 'remote-debugging-port=93' && rm -rf /tmp/dsh-perf-hud-chrome-*` 再跑。别花时间怀疑被测代码 —— 先看 `pgrep -fl 'remote-debugging-port=93'`。
   ⚠️ **它们不是离线门禁**:要真浏览器 + 本机跑着 `dsh web`,所以 `npm test` 与 CI 里**没有**它们(CI 只对 `tools/*.mjs` 做 `node --check`)。`check-panel.mjs` 挡的就是"三套件全绿、浏览器里插件激活或渲染失败"那类事故,所以它跑不过就别提交。
