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
| 5 | 产物无死链 | ✅ README / AGENTS 链接到的文档全在 `files` 里;`release.yml` 的 Pack and inspect 逐份 grep,而且 **`tools/` 与 `locale/` 按目录核**(以后加验证器或加语言文件不会漏检),显式清单 + 目录共覆盖包内全部 **18** 个文件(含 `package.json`),漏一份就失败 |
| 6 | 门禁全绿 | ✅ 342 条离线断言;CI = 两个半边的 `node --check` + 三套件 + 「断言总数与文档一致」 |
| 7 | 投稿形式 | ⬜ 只提**一个文件** `data/plugins/<owner>__<repo>.yml`(必填 `description.en`),一个 PR 最多 3 条 |
| 8 | 兼容性声明 | ✅ 三个客户端 inject 包与 `engines.dsh` 统一 `>=0.2.0-rc.2 <0.3.0-0`(按预检口径 `satisfies(host, range, {includePrelease:true})` 实测 PASS) |

其余来自 awesome-dsh-plugin contributing.md 的核对项:仓库要有真实可跑代码、描述与实际代码一致(评审逐句核对);
官方 `@deepseek-ai/*` 建议声明为 `peerDependencies` 且范围带显式预发布分支(已在 §8 行覆盖);
可选但推荐发到 npm(免 `allowBuilds` 构建授权)或在 Release 挂预构建 `.tgz` 用 `tarball:` 指过去。

---

## 2. 验收判据与实测证据

**怎么验**:离线三套件 + 线上脚本 + 用 CDP 打开真实页面(只读)取面板现场读数。后两类现在都有可复跑的实现:
`tests/live-*.mjs`(线上路由 / sourcemap)与 `tools/check-*.mjs`(真面板渲染 / 落盘 / 交互,见本表「真页面验证可复跑」一行)。
本机是 Apple Silicon Mac,DSH `0.2.0-rc.2`;真实会话指用户在 Windows 浏览器上经隧道访问的那个。

| 判据 | 怎么验 | 最新实测 |
|---|---|---|
| 离线断言全绿 | `npm test` | **342** 条(attribution 11 / logic 292 / host 39) |
| 面板能渲染、不自我崩 | 真实页面 `snapshot().errors` | **0**(CDP 反复打开真实页面验过;自带 `HudBoundary` 兜底) |
| 守夜层能自动抓 | `__perfHud.watch()` | 真实会话:captured **25** · coalesced 102 · dropped 18 · kept 10 |
| 守夜默认**零插桩** | `snapshot().instrumented` 在三种模式下的取值 | 面板打开、HUD 开着:`instrumented: false / deep: false`;点「深录」→ `true / true`;点回去 → `false / false`,`errors` 全程 0 |
| 事故落盘且活过刷新 | 抓一次 → 刷新 → `watch().restored` | restored **10**;读回条目带 `restored:true`、`env.perfOrigin` 保留,`report()` 跨会话可渲染(184 帧) |
| 留存两档并集 | 塞跨天旧事故 → 刷新 → `watch().kept[].tier` | 15 条旧事故(一天 12 条 + 另外三天各 1 条)→ **restored 13** · tier `{worst 9, daily 3, both 1}`,工具箱清单里「当天最差」出现 3 次 |
| 跨会话基线只进导出件 | `snapshot().context.sessionBaselines` | 一次会话一条(`frames 82 / p50 23.6ms`),`note` 写死「粗参照,不是回归判定」;面板不显示(静态断言钉住) |
| 60 秒帧条与导出件同口径 | 面板 SVG + `tools/inspect-incident.mjs` 的 ASCII | 真实页面 100×18 / `viewBox 0 0 60 18`,`errors: 0`;阈值一致性有静态断言(≥100 / ≥50) |
| 脚本侧按包 | 面板「脚本按包」/ `incident.packages` | 真实页面 **`dsh-api-gateway 881ms · dsh-client-connection 312ms · dsh-client-modules 208ms · 其余 1`**;「纯 JS / 强制布局」= `1655.3ms / 18.9ms` |
| 交互延迟(页面内那一半) | `snapshot().interactions` / CDP 真实输入 | `state: on`(supported = element + event);一次真实点击 **20** 条入库,`pointerover` 那条 `ms 112 / waitMs 0.3 / handlerMs 0.4` —— 端到端长 ≠ 页面反应慢;`element` 恒 0 并解释原因 |
| 真页面验证可复跑 | `tools/check-panel.mjs` / `check-storage.mjs` / `check-interaction.mjs` | 三条都真跑过并 PASS(`check-panel --expr=false` 会 FAIL 且退出码 1);它们**不是离线门禁**(要真浏览器 + 本机 `dsh web`),CI 只对 `tools/*.mjs` 做 `node --check` |
| 记录器自身不冒充元凶 | 面板「归属 Top」/ `blameText` | 真页面:`PerfHud / PerfHudStress` 那条 224ms 长任务改为归到 **`RootEntry`**(真组件);只有记录器自己是唯一候选时才单列「记录器自身 N×」 |
| 记录器自己贵不贵 | 面板「记录器自身」/ `context.recorder` | 真页面读数:`p99 0.1ms · 峰 0.1ms · 样本 167`(它自己的 rAF 回调,最近 600 帧环形缓冲)。机制由断言钉住(`recordSelf` / `selfStats` / 环形上限 600);这条是**自证**口径,不是页面开销 |
| 压缩名过滤 | `usableComponentName` 断言(传**类**) | `class $c {}` / `class $w {}` → `null`,`class ChatView {}` → 通过,匿名 `class {}` → `null`;`looksLikeInfrastructure('(ChatView)')` 实测 **false**(曾经有"括号名被它挡掉"的错说法,已加断言钉死) |
| 落盘审计属性进导出件 | `snapshot().context.store` | `restored` / `trimmedByBytes` / `deduped` / `captured` / `dropped` 五个键都在(静态断言核) |
| i18n 兜底与词典 | 真实页面 `html[lang]` + 两条断言 | 兜底**跟文档语言**(实测本机 `htmlLang / navLang` 都是 `zh-CN` → 中文);两本字典各 **134** 键、键集合一致、每个键都有人引用(死键会红) |
| 落盘容量如实 | `watch().trimmedByBytes` / `deduped` | 512KB 上限时真实会话显示「裁掉 6」→ 已提到 **2MB**;同一 id / 同一 `at|cause` 去重后被去掉的条数也单独计数 |
| 事故包可导出、可解析、自描述 | `exportIncident(0)` + `tools/inspect-incident.mjs` | 41KB / schema 2;渲染出 ASCII 帧条带 + longtask / LoAF / 脚本三张表 + 缺失声明 |
| 事故包不虚胖 | 身材回归断言 + 实测 | 同一份内容 URL 抽表前 **116.6KB** → 抽表后 **29.6KB**(导出缩进 138.6 → 51.5KB) |
| 长任务四条腿归因 | `verification()` / 面板 | 真实会话 命中 **35/49** · 组件 35 · 独立包名 **90** |
| 精确归因(单包名) | 打开「深录」后归因表出现单包名 | 2/2 批次分段 ready;线上 sourcemap 58 sections、116 处边界 **0 错** |
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

## 3. 还剩什么(2026-10-08 收敛)

这一节只列**还没做的**。已完成那 12 条(D1 / A1 / A2 / A4 / A5 / B1 / B2 / B3 / C2 / D2 / D3 / D5)的做法与理由
进了 [CHANGELOG.md](CHANGELOG.md) 的「未发布」段,判据与实测证据在本文 §2 —— 不在这里重复一遍。

### 3.0 不是本仓库能修的(要报给上游)

- **423ms 级的 `Response.json`**:打开/切换一个已长大的会话时,客户端把整段会话当一个 JSON 解析。实测那个
  工作区单会话解压后 **6.7 / 12.0MB**(全部工作区最大 **36.7MB**)。会话大一倍就慢一倍 —— 这是"以前不卡、现在卡"的直接解释。
- **侧栏每条消息都重渲染**:13 秒窗口里 15 条 `DOMWebSocket.onmessage`(每条 ~50ms)+ `ProjectRowItem` ×5、`SidebarRoot` ×3(各 ~50ms);N 个子代理并行就是 N 倍。

本仓库只能把这两条做成上游能直接用的证据(事故包的 `packages` 已指向具体包与调用点),以及自己这侧不重复它们。

### 3.1 对外动作(卡在仓库可见性与 npm 凭据上)

- [ ] **仓库转公开 + 加 `dsh-plugin` topic**(§1 #4)。**动手前单独问一次。**
- [ ] **npm 首发** —— 现在卡在**凭据**:本机 `npm publish` 报 `ENEEDAUTH`(0.3.0 已 bump、tag 已打、已推 origin,包没发出去)。两条路选一条:
  - **① 本机发**:`npm login` 之后在 main 上 `npm publish`(发之前 `npm pack --dry-run` 应为 **18 个文件**);
  - **② 纯 CI 发**:npmjs.com 建包 → 配 Trusted Publisher(Provider = GitHub Actions,填 owner / repo / `release.yml`)→ 仓库转公开 → 建 Release,`release.yml` 自动 `npm publish`(不配 `NPM_TOKEN`)。
  两条路之前都再查一次包名是否仍空闲(§1 #2)。
- [ ] **提收录 PR**:只提**一个文件** `data/plugins/<owner>__<repo>.yml`(必填 `description.en`),一个 PR 最多 3 条(§1 #7)。

### 3.2 两条尾巴(2026-10-08 新发现)

1. **A5 的客户端一侧还没接线(排到 0.4.0)**:宿主路由已经能采(真宿主实测 `profileStart(1s)` → `profileGet`
   = 292 节点 / 223 采样 / 82KB),但**客户端没有触发它的入口**,导出件里也没有宿主 profile。**声明已经改准**:
   事故包的 `missing` 现在写"宿主 CPU 火焰图**没有自动采** + 路由怎么打",不再说"拿不到"。剩下的是接线 ——
   客户端采一次并塞进导出件,排 **0.4.0**,因为它要在宿主侧**真的花 CPU 采一段时间**,得先定触发方式
   (挂「深录」还是单独一个动作)。
2. **`__perfHud.stress()` 的结果没人看得到(明确不做,等真有人用自测时再定)**:面板不再渲染"自测结果",
   `stressText()` 在 `client.js` 里已无调用点;更要紧的是 `stress()` **什么都不返回** —— 控制台点了自测,
   **没有任何可读结果**(`PerfHudStress` / `stress()` 本身按 D4 保留,它是归因链路的自测夹具)。真要动,应该连着
   "自测结果给谁看"一起定(把结果接回面板 = 小改;或连 `stressText()` 与它引用的那些 i18n 键、8 条断言一起删)。
   现在**明确不做**,免得只清字符串把这个缺口盖住。

### 3.3 定了不做的

| # | 条目 | 为什么不做 |
|---|---|---|
| A3 | 合成/光栅/GPU 的拆分 | 页面内没有 API,硬做会引入"看着在测 GPU、其实在猜"的假读数 —— 比不做更糟。保持声明 + 人工检查清单(`chrome://gpu`、Paint flashing、Frame Rendering Stats) |
| C1 | 桌面端主进程取证 | 需要 Desktop 环境才能验证,而本仓库的规矩是"不凭记忆写 API"。等有环境再排 |
| D1' | 把插桩做成独立开关(而不是并进模式) | 被 D1 取代:模式比多一个设置维度更贴文档承诺 |
| D4 | 删掉撤了入口的代码 | **全留**(控制台可达):`PerfHudStress` 是归因链路的自测夹具,`marks` 便宜,`isolation` 留着当备用。死字符串照清(C2 已做)—— 但 `PerfHudStress` 这条路的进一步改动**明确不做**:见 §3.2 尾巴 2(先定"自测结果给谁看") |

**时机**:实现批已全部落地(证据在 §2),不再等什么 —— 发布只剩 §3.1 那三件对外动作。
