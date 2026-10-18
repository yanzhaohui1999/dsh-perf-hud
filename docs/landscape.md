# 竞争与位置

> 从 [AGENTS.md](../AGENTS.md) §0.2 / §12 移出(2026-10-18),正文未改。评估方向与对外说法前看这里。

### 0.2 与 DSH 自带开发者工具的分工(2026-10-17)

本机 DSH `0.2.1-rc.1` 里有一个实验性的**开发者工具**组合包(`@deepseek-ai/dsh-experimental-inspector-profile`,默认关闭):
`NodeJS 诊断`(底部面板内嵌 Chrome DevTools:Host console / 断点 / Sources / Network / Performance / Memory / Cordis 树)
与`会话数据诊断`(原始 session 日志 / chat group-node 树)。它是**前台显微镜**,不是记录器;边界也很明确:
Client 侧只有 Console 求值与只读的 `lib/client.js` Sources,**没有页面渲染 trace / 堆 / 帧数据**;Performance 只采 Host CPU;
界面只有英文;Host fetch 抓包不脱敏。

两边**不重合**,也不允许互相依赖:

| 想回答 | 用 |
|---|---|
| 现在为什么慢 / 断点 / 网络 / 原始会话日志 / Cordis 树 | 官方开发者工具 |
| 刚刚那一下有多慢、是谁、能不能复盘 | 本插件 |
| 回归 / 治理 / bisection | `dsh-performance-guard` / `dsh-perf-lens` / `@linxin666/dsh-perf` |

三条硬性:① **不内嵌 DevTools、不连它的 CDP / Worker、不发布到 `ctx.inspector.publish`** —— 它是 experimental、可选、偏重,
本插件的边界是"零运行时依赖 + 默认常开便宜";② 它抓全量 fetch **含密钥**,本插件的导出件继续走"减法脱敏";③
它不给 Client 渲染 trace,所以事故包里的 `devtools-trace` 缺失**仍然成立**,不要把"装了开发者工具"写成"缺口已补"。
完整对照与本轮采纳的三条可靠性规则见 [验收档案的 2026-10-17 一节](plans/2026-10-11-acceptance-evidence.md#2026-10-17-官方开发者工具对照与三条可靠性改造) 与 [读数口径 §7.1](reading-panel.md)。

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
