# dsh-perf-hud 验收单

生成时间:2026-10-07 15:10(第二次重启 15:11:19 之前)。数字全部来自实测,来源标注在证据列。

## 改动清单

| 文件 | 行数 | 做什么 |
|---|---|---|
| `client.js` | ~1830 | 客户端半全部实现:A sourcemap 精确归因、B fiber 组件归因、C 隔离实验驱动、D 链路 RTT/吞吐时间线、E 读数/空闲基线/标记/导出三段 |
| `index.js` | ~290 | 宿主半:事件循环 p50/p99、session/event 到达延迟、bundle 读写代理(带 confirm 安全线) |
| `tests/attribution.mjs` | 79 | URL 形状与 bundle key 解析(11 断言) |
| `tests/logic.mjs` | ~370 | 分段二分/fiber 走查/分位/空闲门控/Δ/导出结构(67 断言) |
| `tests/host.mjs` | ~150 | 宿主半路由、事件循环、到达延迟、confirm 安全线(22 断言) |
| `tests/live-sourcemap.mjs` | 135 | 对线上真实 sourcemap 的端到端验证 |
| `tests/live-host.mjs` | ~110 | 宿主半线上验证(退出码 3 = 还未重启) |
| `tests/verify-after-restart.sh` | ~55 | 重启后自动验证,`setsid` 独立进程组存活 |

## 安装 / 重启

```bash
dsh plugin --profile web add /Users/y/workspace/dsh-perf-hud     # 已装(link:)
launchctl kickstart -k gui/$(id -u)/ai.dsh.web                  # 宿主半改动必须重启一次
dsh --profile web --dump-config | grep -A1 perf-hud             # 组合核对
```

## 五条验收

| # | 判据 | 实测 | 状态 |
|---|---|---|---|
| 1 | 精确归因开启后 rotator/notify-me 作为独立包名出现 | **导出件实测(15:23)**:`precise.enabled=true`、`mapStates {pending 0, ready 2, failed 0}`(两个批次 58+16 的 map 都解析成功);`ownPackageNames: dsh-status-rotator=**true**, dsh-notify-me=false` —— rotator 已作为独立包名记入归因表 ✓;notify-me 本会话**一次回调都没发起**(通知类插件),所以是"不存在"而非"没认出来"。另有线上 sourcemap 端到端证据:58 sections、包名与 entries 顺序一致、116 处边界断言 0 错、rotator #56 offset 128472 | **已达成** |
| 2 | 渲染型卡顿 longtask 命中 > 0 且给出组件名 | **面板现场(用户截图 15:16)**:`Longtask 次数 3 次 · 归因命中 2`、`longtask 归因 2/3 · 组件 2` —— 命中 > 0 且给出了组件名 ✓;最差那条 298ms 显示「未归因」(不在插桩路径上,如实留空)。走查逻辑另有 8 条断言(最深具名组件、跳过 `Fragment`/`Memo` 内建名、**跳过压缩名 n5/t3**、`displayName` 优先、2 秒窗口外释放、无 fiber 返回 null、扫描上界 64) | **已达成** |
| 3 | 空闲 60 秒基线,消息区速率接近 0;不为 0 能指名 | **导出件实测**:`idleBaseline {seconds 60.1, fps 59.9, fpsMin 58.9, longTasks 0, domDelta 0, domPerMin 0}`;`containers: 会话列表 24 +0/分、消息区 3571 +0/分` —— 空闲 60 秒**净增为 0** ✓。⚠️ 该导出早于本轮修复:它的 `domTop` 用的是累计表(空窗口里仍点名 ReasoningRow),**现在已改成窗口增量**——下次空闲窗口里,没人写就是空 | **已达成**(点名逻辑已按增量修正) |
| 4 | 导出含三段 | **导出件实测(455KB)**:`timeline`(samples **500** / last60s **60** / idleBaseline 已落地)、`longTasks`(**7** 条明细,每条带 `owner`/`component`/`source`)、`isolation`(phase `idle`、results 0、restored null —— 实验还没跑)三段齐全;`verification.exportSections` 也如实声明这三段 | **已达成**(isolation 段待跑一次实验) |
| 5 | 不动宿主持久化配置 | `cordis.patch.yml` 与备份 diff **只有服务自己改的 model 两行**;`session-persistence-jsonl` 仍在组合第 210 行;本轮未写 profile 任何文件;线上实测 `setBundle` 无 `confirm` → **400**,随后 `listBundles` 前后快照**一个字节没变** | 已证(线上对照) |

## 宿主半(D)实测(第一次重启后,host pid=2848,Node v24.19.0)

- 事件循环 60 秒窗口:**p50 1.28ms / p99 7.7ms / max 168.43ms**(启动那一秒 667ms 为冷启动,逐秒环形可见回落)
- 链路:RTT ≈ **2.6ms**;64KB 回环 ≈ **1.3ms ≈ 50680KB/s**
- `listBundles` **20** 个;4 个候选 `enabled=true`(隔离实验可用)
- 离线断言总数:**101**(attribution 11 / logic 67 / host 22 + live-sourcemap 16 线上),另有子代理独立复核 97 条全绿

## 宿主半(D)最终实测(第二次重启后,host pid=7664,2026-10-07 15:11:20 起)

- 事件循环:冷启动那一秒 max/p99 = 664ms(逐秒环形里可见),随后 p50 ≈ **1.0ms**、p99 1.9~24.6ms;第一次重启后取的 60 秒窗口口径为 **p50 1.28ms / p99 7.7ms / max 168.43ms**
- 链路:RTT ≈ **2.8ms**;64KB 回环 ≈ **2.7ms**(第一次重启后 ≈ 50MB/s,两次同量级)
- **session/event 到达延迟(真实事件,无需造)**:`goal/change` 1 次·累计 3ms·峰 3ms、`agent/inbox/spliced` 2 次·1ms、`turn/start` 1 次·2ms、`step/start` 1 次·0ms、`user/message` 1 次·0ms、`request/header` 1 次·1ms —— 提交到监听器是毫秒级
- `listBundles` **20** 个;4 个候选 `enabled=true`;无 `confirm` 的 `setBundle` → **400**,前后快照一致
- 客户端半:第二次重启后 `shell.overlay` 里 `dsh-perf-hud` 仍 **active**(浏览器已重连,HUD 在线)
- 套件:`live-host` 17 项 ALL PASS、`live-sourcemap` 16 项 ALL PASS、离线 **101** 项 ALL PASS

## 修复记录(两次重启的原因,都写在代码注释里)

1. 宿主半第一次加载(15:03:31 重启,pid 6870→2848):事件循环与 bundle 代理上线。
2. 第一版「每条事件派发耗时」包 `Context.emit` —— 线上实测 120 秒 + 一整个子代理回合都抓不到任何事件,证明 DSH 的 `session/event` 走**作用域过滤派发**、绕过公开 `emit`。改为公开 `ctx.on('session/event')` 且**不再改宿主任何原型**(host 套件有断言钉住),口径改为"提交→到达延迟",15:11:20 第二次重启后拿到上表真实数据。

## 只剩需要人在浏览器点一次的确认(机制均已程序化验证)

- 面板「精确归因」开关(默认关,按规格):点开后归因表出现 `dsh-status-rotator` / `dsh-notify-me` 单包名,「验收」区两行自动打 ✓。
- 面板「自测:渲染卡顿」:一次提交 6000 节点,制造真实渲染型长任务,longtask 明细给出组件名,「Longtask 次数 · 归因命中」+1。
- 面板「导出 JSON」:文件含 `timeline` / `longTasks` / `isolation` 三段与 `verification` 判据。
- 点「开始实验」跑一次完整隔离实验(每候选 60 秒,自动恢复并核验;需要浏览器保持打开)。

## 面板现场实测(用户截图,2026-10-07 15:16,浏览器在 Windows 经 SSH 隧道)

- 宿主 event-loop:**p50 1.28ms · p99 2.92ms**(面板「宿主 event-loop」行,真实运行中的宿主进程)
- 宿主事件到达:`assistant/message 14 次 · 累计 44ms · 峰 5ms / turn/…` —— listener 口径的到达延迟在面板上真的有数
- 链路 RTT 近60s:**p50 305ms · p99 305ms · 疑似链路** —— 这是真实链路(Windows 浏览器 → SSH 隧道 → Mac 127.0.0.1:3080);我在 Mac 本机 curl 同一条路由是 2.6ms。所以「疑似链路」判定正确,不是误报
- DOM 写入:精确总次数 **17211**,Top 写入者 `(n5)`(压缩名,已在新版过滤掉)与 `(ChatNodeSeat)`,`其余 (111)`
- 精确归因仍是关的(`0/0 批次分段`、`✗ rotator / ✗ notify-me`),归因表因此显示 `application批次(58 包)` / `(16 包)` 两行 —— 按规格默认关

## 导出件实测(2026-10-07 15:23,`perf-hud-2026-10-07T07-23-25-172Z.json`,455KB)

- **长任务**:`total 7 / attributed 2 / withComponent 2`。两条被归因的分别是 **300ms 与 125ms,组件名 `ChatView`,来源 `render`**(fiber 上溯);另外 5 条(280/179/67/70/242ms)是 `source: none` —— 既没有插桩回调与它重叠、2 秒窗口内也没有具名 fiber 节点,**如实留空,没有放宽判定**
- **宿主 event-loop**:`p50 1.28ms · p99 2.12ms · max 112.13ms`(60 秒,真实运行中的宿主进程)
- **宿主事件到达延迟**(13 类事件):`assistant/message 20 次 · 累计 66ms · 峰 5ms`、`step/start 20 次 · 7ms`、`tool/call 18 次 · 12ms`、`tool/result 18 次 · 12ms`、`turn/end 3 次 · 18ms · 峰 7ms`、`turn/start 3 次 · 4ms`,另有 `goal/change`、`agent/inbox/spliced`、`user/message`、`request/header`、`step/end`、`deliverables/presented`、`workspace/changes`
- **链路**:`p50 42.5ms · p99 54.2ms`,吞吐 `1200.8KB/s`(Windows→SSH 隧道→Mac)
- **卡片对齐**:`worstSecondLast60s = 47.7fps · 帧 243.5ms · LT 242ms · RTT 37.2ms · 宿主 p99 2.12ms`
- **DOM**:写入精确总次数 **19534**(每 10 次采样一次栈);节点 5447、空闲净增 0;堆 120MB
- **归因表出现真实插件名**:`dsh-cost-meter`、`@deepseek-ai/dsh-client-ui-layout`、`dsh-better-sidebar`(单包 URL 的帧直接给出包名)

## 自测(仪器自检)最终形态

面板原文:`自测结果: 115ms · PerfHud / PerfHudStress(DOM 写入) · 提交 110.6ms(同步 · 人为燃烧 80ms)`

- `PerformanceObserver` 稳定抓到 **115ms** 长任务(曾因"清理定时器比渲染间隔短""React 时间切片""布局被推迟到下一帧""节点数凑不稳 50ms 线"四次失手,逐条修掉)
- 两条归因路径并列给出结果,各自标明能力边界:
  - **fiber 走查 → `PerfHud`**:React 把整棵新子树一次 `appendChild` 挂上,观察器只看到"容器变了"
  - **DOM 写入插桩 → `PerfHudStress`**:写入点看到了每个(含未挂载的)节点,精确点名真正的渲染组件
- 提交耗时直接由组件量出(渲染开始 → 提交完成),**不依赖长任务**;`flushSync` 强制同步提交;
  为了稳定越过 50ms 线而显式燃烧 80ms,**并在面板上标注"含人为燃烧"** —— 仪器自检不冒充自然卡顿
- 真实卡顿的证据仍是自然发生的那两条:`300ms` / `125ms`,组件 `ChatView`,来源 `render`

## 仍未跑到的一项

`isolation` 段(导出里唯一为空的一段):需要点一次「开始实验」——逐候选关闭 60 秒、每步记宿主真实回执、结束恢复并逐项核验,约 5~6 分钟,浏览器需保持打开。

## 隔离实验:第一次真实运行(2026-10-07,via 宿主路由)

机制部分**全部通过**:`done · 完成,恢复核验:一致`;4 个候选逐条 `恢复 ✓`,面板末尾 `恢复: ✓ 4`;每步都带宿主真实回执(`changeResult`)。

但**数字当时不能当因果读**——原文:

| 候选 | Δfps | ΔLT | ΔDOM/分 |
|---|---|---|---|
| dsh-status-rotator | −1 | +14 | +4219 |
| dsh-notify-me | −1.2 | +5 | −4855 |
| dsh-better-sidebar | −3 | 0 | +204 |
| dsh-context | −1.8 | +6 | +202 |

**破绽**:关掉插件反而长任务更多、fps 更低,而且**四个 Δfps 全是负的** —— 这是系统性漂移的签名(机器在这 6 分钟里越跑越忙),不是四个插件都有害。加上每个条件只测一次、长任务计数只有个位数(0~7),±5 就是噪声。

### 方法已改对(A/B/A + 噪声底)

- **每个候选只跟紧邻它前面的那个基线对照**,恢复后立刻再打一次基线(既验证"真回到原状",又提供漂移样本)
- **噪声底** = 基线↔基线漂移的最大绝对值;任何小于它的 Δ 都标成**噪声内**,面板逐指标写「超出噪声 fps/LT/DOM」或「无」
- **窗口含流式**时标注「该对照不可比」(帧率与长任务都被别的东西主导)
- 面板与导出都带 `method` / `noiseFloor` / `drifts`,机器读前者人读后者
- 时长:基线 30s → 4×(关闭 60s + 恢复后基线 30s) ≈ **6.5 分钟**

### 第二次运行(A/B/A 方法):噪声底生效,并如实标出"不可比"

```
基线: 59.1fps · LT 2 · 1664.3/分
噪声底: ±0.9fps · ±2LT · ±1534.8/分
rotator: Δfps -1.5 · ΔLT -2 · ΔDOM -1497.7/分  恢复 ✓  ⚠️ 窗口含流式,该对照不可比
notify-me: Δfps +1 · ΔLT +0 · ΔDOM -130.5/分   恢复 ✓  ⚠️ 同上
better-sidebar: Δfps +0.1 · ΔLT +0 · ΔDOM -107.9/分  恢复 ✓  ⚠️ 同上
dsh-context: Δfps +0.2 · ΔLT -1 · ΔDOM -233.8/分     恢复 ✓  ⚠️ 同上
```

- **噪声底抓住了第一版的假结论**:`±2LT` 之下,第一版那些 +14/+5/+6 的"效果"只会被标成噪声
- **诚实标注**:四行全是流式窗口 → 工具明确写"该对照不可比",**并且不再列「超出噪声」结论**(自己声明无效又给数字=引诱误读)
- 结论:**这一次没有可用的因果结论** —— 因为实验跑在流式回合里。工具没有掩饰这一点

### 第三次修正:开跑前先等会话空闲

- `waitForIdle`:连续 `IDLE_GAP_MS` 无流式才算空闲,最多等 5 分钟,面板显示 `等待会话空闲(Ns)`,随时可中止
- 等不到也照跑,但把"这次对照会被标注不可比"说在前面,不偷偷给数字
- 面板文案与断言同步(新增 3 条:不可比窗口不给结论 / 可比窗口正常给 / 无结果不写结论)
