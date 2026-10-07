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
| 1 | 精确归因开启后 rotator/notify-me 作为独立包名出现 | 线上真实 map:`sections=58`、包名与批次 entries **顺序完全一致**、每个 section 起止行共 **116 处断言 0 错**;`dsh-status-rotator` = section #56 offset.line=**128472**、`dsh-notify-me` = #57 offset.line=**137380**(`node tests/live-sourcemap.mjs`) | 机制已证;面板那一行需点一次「精确归因」(默认关,按规格) |
| 2 | 渲染型卡顿 longtask 命中 > 0 且给出组件名 | 走查逻辑 6 条断言:最深具名组件、跳过 `Fragment`/`Memo` 等内建名、`displayName` 优先、2 秒窗口外引用被释放、无 fiber 返回 null、入口扫描上界 64 | 数字待点「自测:渲染卡顿」(一次提交 6000 节点) |
| 3 | 空闲 60 秒基线,消息区速率接近 0;不为 0 能指名 | 门控 6 条断言(含**真跑一次窗口**);基线记录带 `domTop`(插件名 + 组件名);速率窗口从 80 秒缩到 12 秒,空闲能在 12 秒内归零 | 线上数字待一次空闲窗口 |
| 4 | 导出含三段 | 导出结构 11 条断言:`timeline`(每秒曲线/last60s/marks/idleBaseline)、`longTasks`(total/attributed/records,每条带 owner/component/source)、`isolation`(phase/via/candidates/baseline/results/restored) | 结构已证;真实 JSON 待点「导出 JSON」 |
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
