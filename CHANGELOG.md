# Changelog

本项目遵循 [Conventional Commits](https://www.conventionalcommits.org/),版本号遵循 SemVer。

## [0.2.0] - 未发布

首个公开发布版本。纯客户端性能 HUD:一个浏览器半 + 一个可选的宿主半。

### 新增

- **四条腿长任务归因**,同时给出不一致的两条:`fiber` 祖先走查 / `子树` 走查(`alternate === null`,补"整棵挂载"的空档)/ `DOM 写入` 插桩(1/10 采样,估算带 `≈`)/ `包名`(调度点插桩 × 长任务时间重叠)
- **精确归因**:按合并 bundle 自带的 indexed sourcemap 分段还原单包名(懒加载,同一个 rev 只拉一次 map)
- **隔离实验**:逐个关闭候选插件 60 秒 → 恢复并逐项核验;A/B/A 对照 + 噪声底;所有窗口注入同一份合成负载;窗口含流式时标"不可比"且不给结论
- **宿主半**:事件循环 p50/p99/max(`monitorEventLoopDelay({resolution: 1})`)、`session/event` 到达延迟(公开 `ctx.on`)、bundle 读写代理(带 `confirm` 安全线)
- **面板分层**:常显只留"现在顺不顺 + 谁的锅",四个折叠组各带一句话摘要;按显示值指纹渲染(未变则跳过重绘)
- **导出 JSON**:`timeline` / `longTasks` / `isolation` 三段 + `context` 自描述头(场景、阈值、map 状态、版本)
- **场景标记**与**渲染卡顿自测**(显式燃烧,面板标注"人为燃烧")
- 链路 RTT / 吞吐时间线;宿主事件到达延迟开关;`window.__perfHud` 控制台 API

### 修复

- 长任务三个计数判定与窗口不一致(命中口径漏了 DOM 腿、名字分布与累计命中分属两个窗口、`clear()` 未清近因窗口)
- 宿主外壳名被当成归属:`SlotOutlet` / `CenterColumn` / `*Boundary` / `*Provider` / `*Context` 与生产构建压缩名(`n5` / `Bn`)一律跳过
- 误导读数:`0ms/s` 改为 `<0.1ms/s`;归因行峰值速率补单位;「其余」行改用与上面同一套单位
- 空闲基线点名改用窗口增量(原来用累计写入表,空窗口里也会点名)
- 自测四连修:竞态(定时器比渲染间隔短)/ 无反馈 / React 时间切片导致无长任务 / 布局未落在同一任务,最终改为显式燃烧
- 面板条目渲染抛错会让外壳**永久停用**该条目 → 自带 `HudBoundary` 降级并把错误写进导出件

### 调整

- 概览改块式左对齐 + 主动断行(名字相同时整行不显示);补长度预算断言(36/60/30/30/34/24)
- 隔离实验主指标改用「每帧未归因残差」,并收窄口径为"空闲筛查,不是因果证明"
- 合并判色:FPS ≤50 或最差帧 ≥120ms → 黄;≤30 或 ≥200ms → 红(任一触发即降色)
- 测试:187 条离线断言(attribution 11 / logic 152 / host 24)+ 两个线上套件

### 文档

- `README.md` / `README_EN.md` / `AGENTS.md` / `CONTRIBUTING.md` / `REVIEW.md` / `CHANGELOG.md`
- `ACCEPTANCE.md`(验收判据与实测数字);源码级机制、宿主 API 事实与已证伪的死路在 [AGENTS.md](AGENTS.md) §6 / §8
- [DIRECTION.md](DIRECTION.md)(方向评审:为什么从"仪表盘"改成"行车记录仪 + 事故包"、官方会不会撞、理想形态与最小改造路径)
- [LANDSCAPE.md](LANDSCAPE.md)(生态与撞车矩阵:各家的装机量、技术硬点、他们明确放弃了什么、我们仍空着的位置;含复核命令与来源标注)

[0.2.0]: https://github.com/yanzhaohui1999/dsh-perf-hud/releases/tag/v0.2.0
