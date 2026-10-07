# 生态与撞车矩阵(2026-10-07)

> 本文是**竞争格局与撞车分析**:谁在同一个位置、他们的势能、他们明确放弃了什么、我们还空着哪里。
> 定位与方向结论见 [DIRECTION.md](DIRECTION.md);本文只放"别人怎么样了"。
>
> **标注规则**(本文每条都带一个):
> - ✅ **本仓复核** —— 2026-10-07 当场查证,命令/文件见 §5。
> - 📄 **对手原文** —— 引其 README / docs 原句,本仓未逐条复跑其测量。
> - ⚠️ **未复核** —— 仅转述,引用前需自己查。

---

## 0. 一句话

客户端帧级归因这条赛道上**唯一在产**的是 `@linxin666/dsh-perf`(15,194 次/月),但它的"按插件"归因依赖 `data-dsh-plugin`,而该属性在上游 `0.2.1-alpha.1` 里**不存在** → 归因口径是坏的,**这是当前最大的空位**。但"守夜 / watchdog"这个**形态**已被 perf-lens 写进路线图(P1 #5),不算零占位 —— 空的是**客户端侧的事故包**与**跨进程取证**。

---

## 1. 撞车矩阵

npm 统计窗口:`2026-09-05 → 2026-10-04`;GitHub 元数据同为 2026-10-07 查询。✅

| 仓库 / 包 | 形态 | 撞我们哪块 | 势能 |
|---|---|---|---|
| `Nwflower/dsh-perf-lens` | 宿主 + 客户端 | 四条腿里的三条 + 宿主半几乎全部 | **未发 npm**;GitHub ★0,创建并最新推送 2026-10-05(新到一周) |
| `@linxin666/dsh-perf` | 宿主 + 客户端 HUD | 帧 / FPS / 长任务 / 宿主 event-loop / 内存 / 按插件归因 | **15,194 次/月**,v0.3.14;**生态第一** |
| `dsh-performance-guard`(qinshige) | 宿主 + 客户端 | 隔离实验 + 诊断报告 + 插件 A/B | 435 次/月,v0.3.0;★0,pushed 2026-08-31 |
| `dsh-perfscope`(Evhye38496) | 静态体检 | 插件健康评分(归因推到 v1.1) | 846 次/月,v0.1.1;★2 |
| `dsh-fast`(PerryLink) | 宿主只读 | 会话加载 / spill / 压缩诊断 | 3,226 次/月,v0.2.20;★8,**pushed 2026-10-07(仍在更)** |
| **`dsh-perf-hud`(本仓)** | 客户端 HUD | — | **npm 名空闲**(registry 404),未发布 |

四个对手里只有 `@linxin666/dsh-perf` 是 scope 包;其余是非 scope 名(`dsh-fast` / `dsh-perfscope` / `dsh-performance-guard`),用 `owner/name` 去 npm 查会 404。✅

---

## 2. 三个真对手,各差在哪

### 2.1 perf-lens:最像我们,技术最硬,但还没发布、★0

- ✅ `src/client/schedule-probe.ts` 确实包**七个** registrar:`setTimeout` / `setInterval` / `requestAnimationFrame` / `queueMicrotask` / `MutationObserver` / `ResizeObserver` / `IntersectionObserver`(每个出现 2 次 = 包装 + 还原)。**我们只包三个**(调度点)。
- ✅ **包名还原不拉 map,用算术**:它引用官方 `buildComboScript`(其文档点名 `index.ts:305-314`)——批体是纯拼接、剥掉 `sourceURL`/`sourceMappingURL` 尾巴并保证结尾换行,因此边界是确定性 UTF-16 偏移:`start(i+1) = start(i) + prepared(i).length + 2`。它自己写了一句:`The combo source map exists but is the wrong tool`(比 bundle 本身还贵)。→ **快,但耦合官方拼接格式**;我们是拉 12MB indexed map,通用但贵。
  - 可合并:默认走算术(便宜),算不出来(格式变了)再退回 map。见 §4。
- ✅ **它没有的**:fiber 组件名腿、子树新挂载腿、DOM 写入采样腿。它的 jank 表只到「脚本 + 强制样式布局」,并要求一个 coverage marker(`N% of long-frame script time attributed`)。
- ✅ **宿主半比我们重得多**:每插件 CPU / 采样堆 / 磁盘 / listener 数 / 进程树 + always-on JSONL 历史。它做宿主归因,我们做浏览器归因 —— **互补而非替代**。
- ✅ 路线图里**明确放弃两件事**:客户端 FPS/长任务面板(让给 `@linxin666/dsh-perf`)、bisection 工作流(让给 performance-guard)。→ 这两个方向它不会来抢。

### 2.2 @linxin666/dsh-perf:装机量最高,但按插件归因是坏的

- 📄 它的按插件归因 = `element.closest('[data-dsh-plugin]')?.getAttribute('data-dsh-plugin')` + `MutationObserver` 数新增节点(v0.3.14 tarball `lib/client.js`)。
- ✅ **而 `data-dsh-plugin` 在上游 `0.2.1-alpha.1` 的 `packages` + `apps` 全仓命中数为 0**。→ 官方外壳挂的节点拿不到名字,基本全落进 `rest=` 桶;只有自己给根节点打了这个属性的第三方插件才归因得到。
- ✅ 它的强项在**治理**不在测量(npm 描述自述"事件/写盘/渲染指标 + HUD + 写批频控");其仓库是 `zhu1090093659/dsh-web`(**★8,471**),15,194 次/月的下载坐在一个**通用插件仓**上。
- ⚠️ 宿主路由 `/api/dsh-perf/stats`,与本仓 `/api/dsh-perf-hud/host` 不撞。

### 2.3 performance-guard:隔离实验撞车,但方向相反

- 📄 隔离 = **复制 profile**(`$DSH_HOME/profiles/<profile>-perf-safe-<id>`,链接现有 `node_modules`)+ **人在终端重启** + 3/5/7 次重复 + 配对差 Student 95% CI + 偏差校正 Hedges' g + 二分收敛;**源 profile 不变**;手动 campaign 永远拿不到 `high` 置信度。
- 📄 README 原句:`does not … monkey-patch the DOM/network/timer/subprocess APIs`;`Ordinary Resource Timing cannot reliably identify an originating plugin … remains correlated rather than controlled evidence`。→ **它主动放弃了我们做的那一侧**。
- ✅ 它有客户端 ring(上限 5,000 事件 / 8 MiB),但只服务于**手动发起的 60 秒浏览器检查**(逐秒 FPS / Long Task / **Event Timing** / Layout Shift / Resource Timing / DOM size / 会话就绪),不是常驻守夜。
- 结论:它给**小时级结论、要重启、要人跑**;我们给**秒级归属、不动用户环境**。归因 vs 证明是分工。

---

## 3. 我们仍然空着的位置(诚实版)

1. **客户端渲染归因** —— 唯一在产的 `dsh-perf` 口径坏着;perf-lens 用 LoAF 拿到"脚本",并**明确否掉了组件级启发式**(理由是"DOM 根启发式测的是 DOM churn,而真正卡的是每次变更的 JS 扫描时间,DOM 计数会误排序")。本仓的 fiber / 子树 / DOM 写入三条腿仍无人做。
2. **行车记录仪 + 事故包** —— ⚠️ **不是零占位**:perf-lens 路线图 **P1 #5「Auto deep-profile on a stall」**(借 VS Code auto-profiler:阈值触发 → 自动开一段深采样 → 只给**一句结论** + 可选通知;它自述"这就是 dashboard 与 watchdog 的区别,也是 always-on JSONL 历史存在的理由")排在 **0.3.0**。但那是**宿主侧**。
   - 真正空的:**客户端侧**的"常驻 + 自动触发 + 事后切片 + 最差 N 次事件",以及**跨进程**取证(浏览器 + 宿主 + Desktop 主进程)合成一个包。
3. **桌面端** —— ✅ 上游 `0.2.1-alpha.1` 的 client 包里仍无 perf/devtools/diagnostics 包;`data-dsh-plugin` 仍不存在;Electron 侧性能面(`contentTracing` / `getAppMetrics` / `webContents.debugger`)官方 **0 命中**。

---

## 4. 可复用事实(能省一次踩坑)

- ✅📄 **Desktop(`dsh-app://`)上 LoAF 的 `scripts` 恒空**:perf-lens 在 `docs/evidence.md` §17 实测 **900 条长帧全部 `scripts.length === 0`**(`blockingDuration` 最高 352 ms),`dsh-app://` 报帧但从不报脚本。→ **桌面端不能指望 LoAF 做脚本级归因**;能走的是 V8 CallSite(其位置在 `dsh-app://app/plugins/??…:LINE:COLUMN` 里)+ 主进程侧 CDP / `contentTracing`。打包版默认**没有 `--remote-debugging-port`**(只有 `apps/desktop/scripts/dev.ts` 传)。
- 📄 **always-on `async_hooks` 不可行(有数字)**:perf-lens 实测在 promise 密集路径上 **2.3–2.6×**,因此否掉了"常驻定时器/句柄计数"。→ 守夜层绝不能挂 `async_hooks`;原型包装只在深录模式开。
- 📄 **他们的隐私红线**:设计里明确"磁盘上不留 frames / 函数名 / 文件路径",导出默认只给聚合。→ 本仓事故包会带组件名与脚本 URL,**必须显式 opt-in + 文件自述包含什么**(与官方崩溃报告的 owner-only / 有界 / 本地姿态一致)。
- ✅ **市场数据不能直接引用**:perf-lens 的 `docs/landscape-survey.md` 与 `roadmap-proposals.md` 都写 `@linxin666/dsh-perf` 是 **59,960 / "60k installs a month"**;本仓同窗口实测 **15,194**。引用它的市场结论前必须自己查一遍。

---

## 5. 复核命令(可复现)

```sh
# npm 名是否空闲(本仓预期 404)
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/dsh-perf-hud

# 窗口下载量 2026-09-05 → 2026-10-04(scope 包要 %2F 转义)
curl -s 'https://api.npmjs.org/downloads/point/2026-09-05:2026-10-04/@linxin666%2Fdsh-perf'
curl -s 'https://api.npmjs.org/downloads/point/2026-09-05:2026-10-04/dsh-fast'

# 版本 / 描述 / 仓库
curl -s https://registry.npmjs.org/dsh-fast/latest

# GitHub 元数据(★ / pushed_at / created_at)
curl -s https://api.github.com/repos/Nwflower/dsh-perf-lens

# 对手源码与文档原文(HEAD = 默认分支)
curl -s https://raw.githubusercontent.com/Nwflower/dsh-perf-lens/HEAD/src/client/schedule-probe.ts
```

---

## 6. 生态分布(顺手统计)

- 从 `awesome-dsh-plugin` 按 `perf|性能|profil|诊断|fps|jank` 过滤,**"测"的只有五个**:perf-lens / dsh-perf / performance-guard / perfscope / dsh-fast;其余是"**修**"(改渲染、打 `:has()` 补丁、注入 `content-visibility`)—— ⚠️ 其中 `dsh-webui-perf` / `dsh-plugin-polish` / `dsh-perf-suite` / `dsh-plugin-chat-performance` 在 npm 上**查不到同名包**,所以它们没有可比的装机量。
- 非 DSH 侧同轴的只有 `react-scan`(只高亮重渲染)、`react-perf-scan`、Request Metrics 类的 **RUM(SaaS)**:RUM 是"上报后看报表",与"本地一次性抓全"不同轴。
- ⚠️ `awesome-dsh-plugin` 的 ★/行数(17,993★ / 4,601 行)是转述值,未在本仓复核。
