# Changelog

本项目遵循 [Conventional Commits](https://www.conventionalcommits.org/),版本号遵循 SemVer。

## [0.2.0] - 未发布

首个公开发布版本。纯客户端性能 HUD:一个浏览器半 + 一个可选的宿主半。

### 新增

- **事故落盘**:留存的事故进 `localStorage`(512KB 上限,超了丢最弱的;写失败如实报 `persistError`),刷新/重启后仍在;每条带 `env.perfOrigin`,跨会话读时 perf 毫秒能对齐墙上时间
- **常显瘦身:4 块 → 3 块**。「帧内未归因」搬进「取证明细」组(数字挂到该组摘要上:`最差秒 186ms · 未归因 50ms · DOM 写入 3288`);常显只留「概览 / 回调归因 Top3 / 守夜」。实测展开态省 2 行、折叠药丸多出「抓到 N 次」
- **落盘容量口径补齐**:原来只裁落盘那份、内存仍留 10 条 —— 面板说「抓到 10 次」刷新后可能只回来 7 条。现在内存按同一份裁,并单独记「裁掉 N」
- **守夜层上到面板**:常显区一行(`抓到 N 次 · 最差 X ms` + 最近一条的时刻与备注)、工具箱里最差几次的清单与「标记刚才」/「导出最近一次」两个按钮、折叠成小药丸时也显示抓到几次。之前只有控制台 API,等于要求人记得敲命令
- **事故包瘦身(URL 抽表,schema 2)**:实测一份事故 116.6KB 里 **75.4KB 是同一个 2.9KB 的 combo URL 重复 27 遍**(导出的缩进版 138.6KB 里还有 14.7KB 被 `topScripts` 又抄了一遍)。改成 `incident.urls` 字符串表 + `scripts[].u` 下标之后:紧凑 **29.6KB** / 导出 **51.5KB**、512KB 从放 4 条变成放 **17** 条,信息一点没丢。同时留存条数 5 → **10**
- **事故包 v2(按一次独立盲读的反馈改的)**:加 `incident.baseline`(整个帧环的分布,用来判断"这一段是不是真的比平时差"而不是只看绝对值)、`env.viewport/devicePixelRatio/hardwareConcurrency`(渲染环境)、宿主 `snapshotAgeMs`(原来那个 `lagAheadMs` 口径没定义);`howToRead` 补三个坑(frames 与 loaf 是同一信号的两个视图、`blocking=0` 不等于没卡、longTasks 不是慢帧清单);`missing` 补 compositor / 记录器自开销 / 对照基线,`howToAdd` 补零成本检查(`chrome://gpu`、Rendering 面板的 Frame Rendering Stats)
- **守夜层(默认常开、不插桩)**:帧级环形缓冲(12000 帧)+ LoAF 观察器;一帧 >100ms 自动抓「前 10 秒 + 后 3 秒」原样切片,只留最差 5 次;`__perfHud.watch() / incidents() / report() / exportIncident() / capture() / clearIncidents()`;事故包自带缺失声明(没有 DevTools trace、没有宿主 CPU profile 都照实写)
- **四条腿长任务归因**,同时给出不一致的两条:`fiber` 祖先走查 / `子树` 走查(`alternate === null`,补"整棵挂载"的空档)/ `DOM 写入` 插桩(1/10 采样,估算带 `≈`)/ `包名`(调度点插桩 × 长任务时间重叠)
- **精确归因**:按合并 bundle 自带的 indexed sourcemap 分段还原单包名(懒加载,同一个 rev 只拉一次 map)
- **隔离实验**:逐个关闭候选插件 60 秒 → 恢复并逐项核验;A/B/A 对照 + 噪声底;所有窗口注入同一份合成负载;窗口含流式时标"不可比"且不给结论
- **宿主半**:事件循环 p50/p99/max(`monitorEventLoopDelay({resolution: 1})`)、`session/event` 到达延迟(公开 `ctx.on`)、bundle 读写代理(带 `confirm` 安全线)
- **面板分层**:常显只留"现在顺不顺 + 谁的锅",四个折叠组各带一句话摘要;按显示值指纹渲染(未变则跳过重绘)
- **导出 JSON**:`timeline` / `longTasks` / `isolation` 三段 + `context` 自描述头(场景、阈值、map 状态、版本)
- **场景标记**与**渲染卡顿自测**(显式燃烧,面板标注"人为燃烧")
- 链路 RTT / 吞吐时间线;宿主事件到达延迟开关;`window.__perfHud` 控制台 API

### 修复

- 同一段窗口里的第二次触发会另立一份事故(实测一次受控卡顿裂成两份,第二份其实又碰了同一段窗口)→ 触发时刻落在上一份窗口内就不再另立,记进 `coalesced`;手动标记例外
- rAF 被挂起(标签页隐藏/系统休眠)后回来的第一帧会被当成"最差帧",面板红一整秒 —— 现在判为间隙:只进帧环并标 `gap`,不计入 FPS / 最差帧,也不触发捕获
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
- 测试:261 条离线断言(attribution 11 / logic 226 / host 24)+ 两个线上套件

### 文档

- `README.md` / `README_EN.md` / `AGENTS.md` / `CONTRIBUTING.md` / `REVIEW.md` / `CHANGELOG.md`
- `ACCEPTANCE.md`(验收判据与实测数字);源码级机制、宿主 API 事实与已证伪的死路在 [AGENTS.md](AGENTS.md) §6 / §8
- [DIRECTION.md](DIRECTION.md)(方向评审:为什么从"仪表盘"改成"行车记录仪 + 事故包"、官方会不会撞、理想形态与最小改造路径)
- [LANDSCAPE.md](LANDSCAPE.md)(生态与撞车矩阵:各家的装机量、技术硬点、他们明确放弃了什么、我们仍空着的位置;含复核命令与来源标注)

[0.2.0]: https://github.com/yanzhaohui1999/dsh-perf-hud/releases/tag/v0.2.0
