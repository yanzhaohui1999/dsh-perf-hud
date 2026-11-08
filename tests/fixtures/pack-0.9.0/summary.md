# 性能事故诊断摘要

## 1. 摘要
- 严重度:警告 · 标记时刻 137ms
- 最差事件:2026-10-17T09:15:30.263Z · fixture: real capture, sanitized
- 窗口:13000ms · 74 帧
- 归因状态:已确认

## 2. 最可能的假设(最多 3 条,每条都带支持与限制)
### 假设 1:脚本耗时最高的包 · @deepseek-ai/dsh-client-modules —— 线索中等
- 支持:@deepseek-ai/dsh-client-modules · 231ms · 1条脚本 / 定到包 1/10
- 限制:这只缩小到"哪个包",不等于已定位根因 / 9条脚本没定到包名
- 出处:归因推断

### 假设 2:长任务归属 · AnimatedRows —— 线索较弱
- 支持:AnimatedRows · 91ms / 累计 1 次
- 限制:这只缩小到"哪个包",不等于已定位根因 / 四条腿只覆盖三次调度的回调与 DOM 写入,事件处理器 / Promise / 微任务不在内(所以这是下界)
- 出处:归因推断

## 3. 缺失的证据
- loaf-pkg:9/10 条脚本没定到包名(precise-off×8 · not-plugin×1)
- instrumentation:四条腿的归因(没插桩就没有 DOM 写入与调度点包名)
- precise:合并批次里的单包名 —— 也包含 LoAF 脚本的 scripts[].pkg(需要精确归因,会拉那份 12MB 的 map)
- devtools-trace:完整的 Chrome trace(页面内录不了)
- interaction-timing:这个窗口里没有 ≥100ms 的交互(阈值以下的事件不记;长时间没有真人操作也会是 0)
- interaction-breakdown:单次交互内部"输入延迟 / 处理 / 呈现"的拆分 —— 页面内没有 API,这里只有端到端时长与 processingStart/End
- compositor:帧时间到底花在合成 / 光栅 / GPU 的哪一段(这一层只看得到主线程侧)
- recorder-cost:记录器自身的开销**这一格是空的**(samples = 0:自计时只在 HUD 开启后每帧跑一次,现在还没采到;context.recorder 照实给 p99 / max / samples,不编数字)
- baseline:跨机器 / 跨浏览器的对照基线 —— context.sessionBaselines 只来自同一个浏览器 profile,而且只是粗参照
- host-cpuprofile:宿主进程的 CPU 火焰图还没拿到(还没采过)—— 它是**按需**采的(采样本身有开销,不常开),不会自动出现在每份事故包里;要补就打开「宿主与链路 → 宿主 CPU 采样」点一下(或 __perfHud.cpuProfile(5)),采完这份包会带 context.hostCpuProfile
- host-snapshot:这份宿主快照是事故**后** 2818ms采的(每 10 秒一次),未必覆盖卡顿瞬间;别把它当"宿主没问题"的证据

## 4. 下一步验证
- 打开 HUD(面板「开启」或 __perfHud.enable())
- 面板「深录」(它同时打开精确归因)或 __perfHud.setPrecise(true) —— 只能改善之后抓到的事故,这一条不会重放
- 复现时真的点几下(≥100ms 的交互才会进环形缓冲),再导出
- 要拆交互的三段:DevTools → Performance 录制,Hover 到 Interactions 轨道上那一下,看 Input delay / Processing / Presentation
- DevTools → Performance → 录制(勾 include script source maps)→ Save trace → Perfetto 打开
- 零成本、当场可做:chrome://gpu 看是不是落到了软件渲染;DevTools → Rendering 打开 Frame Rendering Stats(FPS 表)与 Paint flashing —— 页面完全静止时帧率是否也上不去
- 判定"主线程之外":Performance 面板录 5 秒,看 Main 轨道自身的忙碌时间是否远小于墙钟 —— 注意 blocking=0 / scripts 为空**不能**当证据(见上面的读取说明),要看 Main 轨道本身
- 宿主火焰图:面板「宿主与链路 → 宿主 CPU 采样」点一下(或 __perfHud.cpuProfile(5)),采完这份包就会带 context.hostCpuProfile(汇总 + 自热 top);要逐帧看再点「下载 .cpuprofile」用 speedscope / Chrome DevTools 打开。等价的手动路径:带宿主 cookie(见 docs/verification.md)POST /api/dsh-perf-hud/host {op:"profileStart", seconds:5},再 POST {op:"profileGet"} 取回标准 .cpuprofile;退一步也可以 kill -USR1 <dsh web pid> → chrome://inspect → Performance → Record

## 5. 元信息
- plugin:dsh-perf-hud v0.9.0
- 采集档位:守夜
- exportedAt:2026-11-08T01:20:14.516Z
- schemaVersion:2
- 主要归属:@deepseek-ai/dsh-client-modules · 231ms
