# 发布评审:门槛、验收证据、待办

> 本文是**发布这件事本身**的长期文档:对外门槛、验收判据与实测证据、还差什么。
> 装什么怎么用 → [README.md](README.md);开发规则 / 源码级机制 / 已知坑 → [AGENTS.md](AGENTS.md);
> 变更历史 → [CHANGELOG.md](CHANGELOG.md)。
> 下面的数字都是 2026-10-07 当场实测的;带日期的观测只当证据,不当承诺。

---

## 1. 对外门槛(不满足就发不出去 / 收录被打回)

| # | 门槛 | 现状 |
|---|---|---|
| 1 | npm 元数据完整 | ✅ `license` / `repository` / `homepage` / `bugs` / `keywords` / `main` / `engines` / `peerDependencies` / `publishConfig.access: public` 都在 |
| 2 | 包名可用 | ✅ `dsh-perf-hud` 在 npm 上 404(未被占用)—— **首发前再查一次**,名字被别人抢了就全盘皆输 |
| 3 | 声明 `dsh.bundle.patch` | ✅ 这是市场收录**最常见的被拒原因**;`cordis.patch.yml` 形态正确 |
| 4 | 公开仓库 + `dsh-plugin` topic + 创建满 1 天 | ⬜ 仓库已建(私有),待转公开、加 topic |
| 5 | 产物无死链 | ✅ README / AGENTS 链接到的文档全在 `files` 里;`release.yml` 的 Pack and inspect 逐份 grep,漏一份就失败 |
| 6 | 门禁全绿 | ✅ 293 条离线断言;CI = 两个半边的 `node --check` + 三套件 + 「断言总数与文档一致」 |
| 7 | 投稿形式 | ⬜ 只提**一个文件** `data/plugins/<owner>__<repo>.yml`(必填 `description.en`),一个 PR 最多 3 条 |
| 8 | 兼容性声明 | ✅ 三个客户端 inject 包与 `engines.dsh` 统一 `>=0.2.0-rc.2 <0.3.0-0`(按预检口径 `satisfies(host, range, {includePrelease:true})` 实测 PASS) |

其余来自 awesome-dsh-plugin contributing.md 的核对项:仓库要有真实可跑代码、描述与实际代码一致(评审逐句核对);
官方 `@deepseek-ai/*` 建议声明为 `peerDependencies` 且范围带显式预发布分支(已在 §8 行覆盖);
可选但推荐发到 npm(免 `allowBuilds` 构建授权)或在 Release 挂预构建 `.tgz` 用 `tarball:` 指过去。

---

## 2. 验收判据与实测证据

**怎么验**:离线三套件 + 线上脚本 + 用 CDP 打开真实页面(只读)取面板现场读数。
本机是 Apple Silicon Mac,DSH `0.2.0-rc.2`;真实会话指用户在 Windows 浏览器上经隧道访问的那个。

| 判据 | 怎么验 | 最新实测 |
|---|---|---|
| 离线断言全绿 | `npm test` | **293** 条(attribution 11 / logic 258 / host 24) |
| 面板能渲染、不自我崩 | 真实页面 `snapshot().errors` | **0**(CDP 反复打开真实页面验过;自带 `HudBoundary` 兜底) |
| 守夜层能自动抓 | `__perfHud.watch()` | 真实会话:captured **25** · coalesced 102 · dropped 18 · kept 10 |
| 事故落盘且活过刷新 | 抓一次 → 刷新 → `watch().restored` | restored **10**;读回条目带 `restored:true`、`env.perfOrigin` 保留,`report()` 跨会话可渲染(184 帧) |
| 落盘容量如实 | `watch().trimmedByBytes` / `deduped` | 512KB 上限时真实会话显示「裁掉 6」→ 已提到 **2MB**;同一 id / 同一 `at|cause` 去重后被去掉的条数也单独计数 |
| 事故包可导出、可解析、自描述 | `exportIncident(0)` + `tools/inspect-incident.mjs` | 41KB / schema 2;渲染出 ASCII 帧条带 + longtask / LoAF / 脚本三张表 + 缺失声明 |
| 事故包不虚胖 | 身材回归断言 + 实测 | 同一份内容 URL 抽表前 **116.6KB** → 抽表后 **29.6KB**(导出缩进 138.6 → 51.5KB) |
| 长任务四条腿归因 | `verification()` / 面板 | 真实会话 命中 **35/49** · 组件 35 · 独立包名 **90** |
| 精确归因(单包名) | 打开「精确」后归因表出现单包名 | 2/2 批次分段 ready;线上 sourcemap 58 sections、116 处边界 **0 错** |
| **LoAF 脚本 → 包名** | `incident.packages` / `summary.pkgCoverage` | 实测一次事故 **37/37** 条脚本全部定名(全部 `via: section`),归到 **`@deepseek-ai/dsh-api-gateway`** —— 同一份数据在这条路之前只能显示"58 个包的合并批 URL" |
| 假象能被识别 | `incident.summary.suspectedThrottle` | 真实那次 983.7ms 帧:`worstFrameJs: none` + 前后帧中位 16.7ms → 标成**疑似 rAF 节流**,不冒充真卡顿 |
| 基线可比 | `incident.baseline`(排除本窗口)+ `busyMs` | 真实会话 basline 5156 帧 / 在跑 86s → **60fps**(旧口径会被 22.7s 挂起拉成 43fps) |
| 宿主半可用 | `/api/dsh-perf-hud/host` | 无 cookie **401**;宿主半未加载 **404**;真实会话宿主 p99 **5.72ms** |
| 隔离实验能恢复 | `isolation.restored.ok` | 4 个候选逐项恢复 ✓;窗口含流式时明确写「不可比」且不给结论 |
| 插桩可还原 | `disable()` 后原型比对 | `tests/host.mjs` 有断言钉住 |
| 不碰用户环境 | profile diff / `setBundle` 协议 | 未改 `cordis.patch.yml`;无 `confirm` 的 `setBundle` → **400**,前后快照零变化 |

已知的**能力边界**(不是 bug,写在 README / AGENTS):归因覆盖是下界(事件处理器 / Promise / 微任务不在调度点插桩里);
命中率会被 DOM 腿抬高,必须配合名字分布读;隔离实验测的是固定开销,不是因果证明。

---

## 3. 待做清单(2026-10-08 逐条定过)

每条都在讨论里过了优劣,下面是结论本身;"理由"只留一句,细节在 [CHANGELOG.md](CHANGELOG.md) 与本文历史里。

### 3.0 不是本仓库能修的(要报给上游)

- **423ms 级的 `Response.json`**:打开/切换一个已长大的会话时,客户端把整段会话当一个 JSON 解析。实测那个
  工作区单会话解压后 **6.7 / 12.0MB**(全部工作区最大 **36.7MB**)。会话大一倍就慢一倍 —— 这是"以前不卡、现在卡"的直接解释。
- **侧栏每条消息都重渲染**:13 秒窗口里 15 条 `DOMWebSocket.onmessage`(每条 ~50ms)+ `ProjectRowItem` ×5、`SidebarRoot` ×3(各 ~50ms);N 个子代理并行就是 N 倍。

本仓库只能把这两条做成上游能直接用的证据(事故包的 `packages` 已指向具体包与调用点),以及自己这侧不重复它们。

### 3.1 定了要做的(**状态 2026-10-08 晚**)

图例:✅ 已落地 · 🔶 部分/待补验 · ⬜ 还没动

| # | 条目 | 状态 | 备注 |
|---|---|---|---|
| D1 | 三种模式(守夜/现场/深录) | 🔶 `b79853e` | 代码已落地(`applyProbeState` 只在地録装插桩,标题栏按钮改「深录」);**待补验**:点开前后 `instrumented` 是否真的 false→true —— 上一轮的读数表达式取错了字段路径(`snapshot().environment.*` 那一层没取对),下次先打印一次 `snapshot()` 的键再断言 |
| A1 | 记录器自身开销 | 🔶 `b79853e` | `recordSelf`/`selfStats`/面板一行/导出 `context.recorder` 都在;**待补**:在真实页面读一次 p99 的真实数字并记进 §2 |
| A2 | 跨会话基线 | ⬜ | 每个会话落盘一份分布(保留最近约 20 个),只进导出件 |
| A4 | Chrome trace | ⬜ | 人工录指引(已有)+ 页面内准 trace(event/element timing)|
| A5 | 宿主进程火焰图 | ⬜ | `node:inspector` 同进程按需采 **`.cpuprofile`**;**要改 `index.js` → 需要重启宿主,重启前必须问过用户** |
| B1 | 记录器自身被当元凶 | ⬜ | 标注 + 汇总单列;`primaryBlame` 跳过它 |
| B2 | 压缩名过滤 | ⬜ | 代码改法:`usableComponentName` 里 `name.startsWith('$')` → `return null`。**坑**:`usableComponentName(type)` 第一行是 `if (typeof type !== 'function') return null` —— 断言必须传**类/函数**(`class ChatView {}`),传 `{ name: 'ChatView' }` 会全返回 null(上一轮就是这么把提交写坏的,已回退 `cd65639`/`add0632`)。另外 `(ChatView)` 这种括号名根本进不到这里,更早被 `looksLikeInfrastructure` 挡掉 |
| B3 | 落盘计数进导出件 | ⬜ | 导出 `context` 加一段 `store`: `restored` / `trimmedByBytes` / `deduped` / `captured` / `dropped` |
| C2 | i18n 英文兜底 | ⬜ | 兜底改成"跟文档语言,取不到才英文";先清面板撤下后遗留的死字符串 |
| D2 | 60 秒时间条 | ⬜ | 放进「取证明细」,与导出件 ASCII 条带同口径 |
| D3 | 留存策略 | ⬜ | 最差 10 条 + "每天最差 1 条"(最多 7 天)|
| D5 | 饼图二级 | ⬜ | 脚本侧展开成按包分布;另给纯 JS vs 强制样式布局(`forcedStyleAndLayoutDuration`)|

**跑这些改动时的两条硬规矩**(都是踩过的):① 替换 `client.js` 之后要 `grep -c` 确认命中数 —— 锚点在 `frame()` 与 `start()` 各有一处的坑已经踩过一次(见 [AGENTS.md](AGENTS.md) §8 第 14 条);② 凡是插进 `apply` / `start` / 渲染路径的改动,**必须真的打开页面看一眼**,因为离线三套件只抽纯函数、不跑 `apply`。

### 3.1.1 原清单

| # | 条目 | 结论与做法 |
|---|---|---|
| A1 | 记录器自身开销 | **做**。在 rAF 回调里自计时,导出件给 `recorder.p99/max`,并断言自身回调 p99 在阈值内 —— 测量工具必须自证没有明显改变被测对象 |
| A2 | 跨会话基线 | **做**。每个会话落盘一份 `{p50,p90,p99,最差,帧数,时刻}`(保留最近约 20 个),**只进导出件**,标注"粗参照,不是回归判定" |
| A4 | Chrome trace | **两条都要**:保留"人工录 trace"的指引,另做页面内的**准 trace**(`event` / `element` timing 补交互延迟;不承诺帧内拆分) |
| A5 | 宿主进程火焰图 | **做**,排在 A1/A2 之后。宿主半用内置 `node:inspector` 在同进程内按需采 `.cpuprofile`(不开调试端口);profile 有开销,只在事故后采最近若干秒 |
| B1 | 记录器自身被当成元凶 | **标注,不静默剔除**:命中本包的名字后加「记录器自身」,汇总里单列一行;`primaryBlame` 跳过它 |
| B2 | 压缩名过滤 | **做,带边界**:`$` 开头必挡;`(x)` 形态只在没有更好候选时隐藏 |
| B3 | 落盘计数进导出件 | **做**:`trimmedByBytes` / `deduped` / `restored` 进导出件的 context |
| C2 | i18n 英文兜底 | **做**,兜底改成"跟文档语言,取不到才英文";先清掉面板撤下后遗留的死字符串 |
| D1 | 三种模式 | **做**。守夜(默认,只挂 rAF + `PerformanceObserver`)/ 现场(展开面板,仍零插桩)/ 深录(插桩 + 精确归因)。**只给两档采集**:守夜与现场同一档,区别只在面板收放 |
| D2 | 60 秒时间条 | **做**,放进「取证明细」组(不占常显),与导出件的 ASCII 条带同一口径 |
| D3 | 留存策略 | **做混合**:最差 10 条不变,另加"每天最差 1 条"槽位(最多 7 天)—— 实测 `捕获 40 · 归并 505 · 丢弃 38`,最差 10 条会全挤在同一小时里 |
| D5 | 饼图二级 | **做**:一级三段(结论:"不是渲染"),脚本侧展开成**按包**的分布;另给"纯 JS vs 强制样式布局"(`forcedStyleAndLayoutDuration`) |

### 3.2 定了不做的

| # | 条目 | 为什么不做 |
|---|---|---|
| A3 | 合成/光栅/GPU 的拆分 | 页面内没有 API,硬做会引入"看着在测 GPU、其实在猜"的假读数 —— 比不做更糟。保持声明 + 人工检查清单(`chrome://gpu`、Paint flashing、Frame Rendering Stats) |
| C1 | 桌面端主进程取证 | 需要 Desktop 环境才能验证,而本仓库的规矩是"不凭记忆写 API"。等有环境再排 |
| D1' | 把插桩做成独立开关(而不是并进模式) | 被 D1 取代:模式比多一个设置维度更贴文档承诺 |
| D4 | 删掉撤了入口的代码 | **全留**(控制台可达):`PerfHudStress` 是归因链路的自测夹具,`marks` 便宜,`isolation` 留着当备用。死字符串仍然清(A3/C2 直接相关) |

### 3.3 对外动作

- [ ] 仓库转公开 → 加 `dsh-plugin` topic(**动手前单独问一次**)
- [ ] npm 首发(先确认名字仍空闲;`release.yml` 用 Trusted Publishing / OIDC)
- [ ] 提收录 PR(一个 `data/plugins/<owner>__<repo>.yml`)

**时机**:**等 A/B 批做完再发** —— 一次给出完整的东西(记录器 + 事故包 + 三种模式),避免"发了又改读数口径"。
