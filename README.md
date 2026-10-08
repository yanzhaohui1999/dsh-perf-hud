# dsh-perf-hud

> **纯客户端性能 HUD**:右下角一块浮层,回答"现在卡不卡、卡在谁身上"。
> 帧与最差帧 · Longtask(带四条腿归因)· 每插件回调速率与同步耗时 · DOM 增长与写入者 · JS 堆 ·
> 宿主 event-loop 与链路 RTT · 证据包导出 · 守夜(偶发卡顿的事后回看)·
> **守夜层:偶发卡顿自动留存最差几次,连证据一次性导出**。

<p>
<img alt="status" src="https://img.shields.io/badge/status-%E6%9C%AA%E5%8F%91%E5%B8%83%EF%BC%88%E5%87%86%E5%A4%87%E4%B8%AD%EF%BC%89-orange" />
<img alt="license" src="https://img.shields.io/badge/license-MIT-blue" />
<img alt="dsh" src="https://img.shields.io/badge/DSH-0.2.0--rc.2-4d6bfe" />
</p>

<p align="center">🌏 <b>中文</b> · <a href="./README_EN.md">English</a></p>

> ⚠️ **npm 包尚未发布**(见 [REVIEW.md](REVIEW.md)),当前只能从源码目录安装。

## 📑 目录

- [✨ 它回答什么问题](#-它回答什么问题)
- [🚀 安装](#-安装)
- [📊 面板怎么读](#-面板怎么读)
- [🛰️ 偶发卡顿:守夜层](#️-偶发卡顿守夜层)
- [🔬 四条腿归因](#-四条腿归因)
- [🧪 隔离实验(已移到控制台)](#-隔离实验已移到控制台)
- [⚠️ 风险与边界(必读)](#-风险与边界必读)
- [🧰 控制台 API 与存储键位](#-控制台-api-与存储键位)
- [🛠️ 开发与测试](#️-开发与测试)
- [🤝 参与贡献](#-参与贡献)

## ✨ 它回答什么问题

| 问题 | 面板给的答案 |
|---|---|
| 现在顺不顺? | FPS / 最差帧 / 帧内未归因;标题栏常显「流式 / 空闲 Ns」作为解读前提 |
| 卡的那一下是谁干的? | Longtask 明细 + 四条腿归属(组件名 / 包名 / DOM 写入者) |
| 哪个插件在偷偷跑? | 按插件的回调执行速率(/s)、峰值速率、同步耗时;DOM 写入次数与写入者 |
| 是插件的问题还是宿主/链路的问题? | 宿主 event-loop p50/p99/max + 链路 RTT/吞吐,附阈值判色与「链路已排除」结论 |
| 关掉某个插件到底有没有用? | 隔离实验(控制台):逐个关闭 60 秒,和紧邻基线对照,并给出噪声底 |

## 🛰️ 偶发卡顿:守夜层

面板要你盯着看;偶发卡顿恰恰发生在你没看的时候。所以插件**默认开着一层不插桩的记录器**:

- 每帧一条**帧级环形缓冲**(12000 条 ≈ 60fps 下 3.3 分钟),另加一个 LoAF 观察器(Chrome 123+);
- 一帧超过 **100ms**(或 LoAF 的 `blockingDuration` 超过 100ms)就**自动抓一次**:前 10 秒 + 后 3 秒**原样切片**,不等你反应;
- 只留最差 **10** 次;抓到了但不够差而丢掉的次数单独记(`dropped`),与"没抓到"分开;
- 事故包把脚本 URL 抽成一张表(`urls` + `scripts[].u`):同一个 combo URL 会被写几十遍,抽表之后**一份小 4 倍**(实测 116.6KB → 29.6KB),信息一点没丢;
- 留存条数上限 **10 条**(按严重度);落盘另有 **2MB** 字节上限,超了就从最弱的开始裁 —— 裁掉的条数写在常显那一行的「裁掉 N」里,内存按同一份裁(看到的永远等于刷新后还在的)。(上限原本是 512KB,但实测一个晚上就被裁了 6 次、实际只留得下 8 条):刷新页面、重启浏览器之后还在,`watch().restored` 告诉你这次读回了几条;写不进去会如实报 `persistError`,不假装存下来了;
- 标签页隐藏造成的几百秒"间隙"**不算卡顿**(rAF 被挂起),事故包里标成 `gap`;
- 这一层**不包装任何原型**:只用本来就在跑的 rAF 循环与一个 `PerformanceObserver`,所以默认开着也不改你的环境。

```js
__perfHud.watch()             // 在不在录、覆盖多少秒、LoAF 装没装上、抓到几次
__perfHud.incidents()         // 最差几次的摘要(索引 0 最差)
__perfHud.report(0)           // 完整事故包:帧序列 + LoAF 条目 + 窗口内 longtask + 环境读数
__perfHud.exportIncident(0)   // 下载成 JSON —— 把这份丢给分析的人(或 agent)就行
__perfHud.capture('切了视图')  // 手动标记"刚刚卡了一下"(自动回退 3 秒的反应时间)
__perfHud.clearIncidents()    // 只清事故;clear() 刻意不动它
```

事故包里的脚本**会定到包名**:合并批(58 个包挤在一个 URL 里)靠"字符位置 → 行号 → sourcemap 分段表"还原,单包 URL 直接从 URL 读;拿不到时写清为什么(精确归因没开 / 文本还在拉 / 越界),并按包给一份汇总 —— 这一层才是"是谁"。

导出文件名是 **`perf-hud-20261008-220358-i84.json`** —— 事故发生时刻的本地时间 + 事故 id(不是导出时刻;日期在前可排序,完整 ISO 在文件体里)。

**长动画帧的时间去哪了**:「取证明细」里有一张三段饼 —— 脚本侧(任务 + 同步 JS)/ 渲染(rAF 回调)/ 样式+布局+绘制。**这是页面内能拆到的极限**:绘制与合成在页面内分不开(要分开只能录 Chrome trace),所以第三段是"剩下的都在这儿"。

**面板上能看到:** 常显只留三块 ——「概览(现在卡不卡 + 最差那条是谁)」「回调归因 Top3(谁的锅)」「守夜(抓到几次)」;原来的「帧内未归因」搬进了**取证明细**组(数字挂在那一组的摘要上:`最差秒 186ms · 未归因 50ms · DOM 写入 3288`),因为它是「解释」不是「结论」。 常显区一行 `守夜 抓到 N 次 · 最差 X ms`(附带最近那一条的时刻与备注);工具箱里有最差几次的清单 + 「标记刚才」(手动补记,自动回退 3 秒)与「导出最近一次」两个按钮;面板折叠成小药丸时也会显示抓到几次 —— 这个数字就是"行车记录仪在工作"的那盏灯。

事故包带**会话基线**(排除本窗口之后的 p50/p90/最差,所以「比会话最差还差」这种比较才成立),还会写明**最差那一帧有没有 JS 证据**:若既没有 longtask/LoAF 与它重叠、前后又都是 60fps 的健康帧,就标成 `suspectedThrottle` —— 那种情况更像浏览器把 rAF 节流/挂起了一次(窗口被遮挡、省电),而不是页面真的忙了那么久(真实数据里出现过一帧 983.7ms,就长这样),所以能直接回答「这一段是真的比平时差,还是这台机器一直这样」;它是纯 JSON,人也能直接读;想看得舒服点:`node tools/inspect-incident.mjs <file.json>` 会渲染出帧条带(哪一格是哪个量级一眼可见)、窗口内的 longtask、LoAF 与按耗时排序的脚本。它自带 `context.missing`:这一次**没拿到什么**(没有 DevTools trace、没有宿主 CPU profile、平台不支持 LoAF……)以及怎么补 —— 缺的东西写清楚,比不写有用。它**不做归因推断**,只把当时的东西原样装好。

## 🚀 安装

发布到 npm 后:

```sh
dsh plugin --profile web add dsh-perf-hud
```

从源码/本地目录(开发用,`link:` 安装,改客户端半刷新页面即可生效):

```sh
git clone <repo> && cd dsh-perf-hud
dsh plugin --profile web add "$PWD"
```

装完刷新页面即可看到右下角浮层。改动生效方式:

| 改了什么 | 怎么生效 |
|---|---|
| `client.js`(客户端半) | 刷新页面(dev 环境下客户端 HMR 也会自动热载) |
| `index.js`(宿主半) | 必须重启宿主服务 |
| `package.json` 的 `dsh.*` | 重装或重启 |

> 宿主半是**可选**的:它没加载时面板照常工作,只是「宿主 event-loop」「宿主事件到达」两处显示不可用,并写明原因 —— 不假装成功。

## 📊 面板怎么读

面板默认分层:**常显**只留"现在顺不顺 + 谁的锅",其余四组(取证明细 / DOM 与堆 / 宿主与链路 / 工具箱)默认折叠,折叠组的标题栏自带一句话摘要。

| 读数 | 口径(面板 hover 里也有同一份) |
|---|---|
| **FPS / 最差帧** | 自己的 rAF 循环,1 秒滚动窗口。合并判色:FPS ≤50 或最差帧 ≥120ms → 黄;≤30 或 ≥200ms → 红(任一触发即降色) |
| **Longtask** | `PerformanceObserver({entryTypes:['longtask']})`,近 60 秒;命中数 = 四条腿任一给出名字的条数 / 总条数 |
| **帧内未归因** | 帧间隔里没被插桩回调解释掉的部分(样式重算、绘制、等待 vsync)。**CSS 动画只在这里现形** —— 它不经 JS 调度器 |
| **回调归因** | `x/s · 峰 y/s`:EMA(α=0.4)平滑的执行速率 / 单秒最大执行次数;hover 给该秒同步耗时 `ms/s` 与累计 `N× / Xms`。**覆盖范围是下界**:只含 `setTimeout` / `setInterval` / `rAF` 三次调度的回调,事件处理器 / Promise / 微任务 / React 自身调度不计入 |
| **DOM 写入** | 精确总次数 + 每个写入者的 `≈` 估算(每 10 次采样一次栈,命中按 10 折算)。**本 HUD 自身的写入不记账** |
| **宿主 event-loop** | `perf_hooks.monitorEventLoopDelay({resolution: 1})`,每秒 p50/p99/max,保留 300 秒 |
| **宿主事件到达** | 宿主用公开 `ctx.on('session/event')` 记「事件提交(`event.time`)→ 监听器被调用」的延迟,不是监听器的 CPU 耗时 |
| **链路 RTT** | 每 10 秒一次 1KB 同源探测(带 cache-buster),吞吐每 60 秒一次 64KB。`p99 > 300ms` 且 FPS 正常且 `n ≥ 2` 才判「疑似链路」 |

**「其余 (N)」** = 除 Top3 外还有几个归属方(名字各不相同,按累计耗时排序),行值给它们的合计速率。

**导出 JSON** 带 `context` 自描述头:场景 / 空闲秒数 / 精确归因与每个 sourcemap 分段的状态 / 宿主路由与 profile、Node、插件版本 / 实验候选与方法 / 全部判色阈值。`window.__perfHud.snapshot()` 与面板「导出 JSON」同源。

## 🔬 四条腿归因

长任务归属同时给出**不一致的两条**,不挑好看的报:

| 腿 | 机制 | 擅长 / 局限 |
|---|---|---|
| `fiber` | 从被改动节点**往祖先**走最近的具名函数组件 | 擅长增量更新;整棵子树一次性挂载时只能给到容器 |
| `子树` | 从被改动节点**往子树**走,优先 `alternate === null`(React 标记"本次新挂载") | 补"整棵挂载"的空档;有界 BFS |
| `DOM写入` | 采样 `appendChild` / `insertBefore` / `setAttribute`(1/10),在写入点抓栈并取组件名 | 提交阶段栈里没有插件帧时的主力;估算值带 `≈` |
| `包名` | 调度点插桩(setTimeout/setInterval/rAF)与长任务时间重叠 | 定时器/动画类;事件处理器、Promise、微任务**不在内** |

「精确归因」开关会按合并 bundle 自带的 **indexed sourcemap** 把单包名还原出来(懒加载,同一个 rev 只拉一次 map)。

## 🧪 隔离实验(已移到控制台)

> 面板上不再提供入口:它测的是"每个插件的固定开销",而那个方向已经明确不做(见 [AGENTS.md](AGENTS.md) §0.1);
> 它还要求**写 profile 的持久化选择**,不该放在一个"随手点"的位置。能力没删,控制台调 `__perfHud.experiment()`。

逐个关闭候选插件 60 秒 → 测量 → 恢复并逐项核验,每个候选只跟**紧邻基线**对照(A/B/A),基线漂移作为**噪声底**,Δ 小于噪声一律标「噪声内」;窗口含流式则标「不可比」且**不给结论**。

候选**从你当前的 bundle 列表里推导**,不写死任何插件名:取「已启用 + 可移除 + 非官方内核 + 不是本 HUD 自己」的社区包,按名字排序最多取 4 个(每个候选 90 秒)。列表为空时实验直接说"没有可对照的第三方插件",不拿不存在的名字空跑。

所有窗口注入同一份**合成负载**(每 250ms 燃烧 8ms,走未插桩的 `setInterval`,只烧 CPU 不动 DOM,避免污染归因表)—— 空闲下的比较本身没有意义。看「超出噪声」列才是证据。

⚠️ 它测的是**固定开销**(跑飞的时间器、常驻动画、轮询、observer),**不是**"该插件在某种用法下才贵",别当因果证明。

## ⚠️ 风险与边界(必读)

1. **默认开启**。安装后浮层默认就显示,并会插桩全局:`setTimeout` / `setInterval` / `requestAnimationFrame`,以及 `Node.prototype.appendChild` / `insertBefore`、`Element.prototype.setAttribute`(1/10 采样)。
2. **一切可还原**。面板「关闭」或 `window.__perfHud.disable()` 会把原型方法还原成原生实现,并且只在"当前仍是我们那个 wrapper"时才还原(不会踩掉别人的包装)。
3. **隔离实验会临时写 profile 的持久化 bundle 选择**(面板上已不提供入口,只在控制台调 `__perfHud.experiment()`;`__perfHud.marks()` 同理)(`pluginManager.setBundleEnabled`)。它有硬安全线:必须 `confirm`、拒绝改本插件与 `session-persistence-jsonl`、每步记宿主回执、结束后逐项核验恢复;中断也会走恢复流程。不想动配置就别点「开始实验」。
4. **宿主半只做两件事**:事件循环采样与一个 HTTP 路由(`/api/dsh-perf-hud/host`,受宿主自身鉴权保护,无 cookie 返回 401)。它不注册服务、不改宿主原型、不写插件自己的持久化状态。
5. **CSS 动画不经 JS**:鲸鱼摆动那类 `steps()` 关键帧只体现在 FPS / 最差帧 /「帧内未归因」,归因表里看不到它。
6. **命中率会被 DOM 腿抬高**:流式时几乎必然命中,必须配合「归属 Top」分布读。
7. 面板状态只进 `localStorage`;导出件在你本机生成,不发往任何地方。
8. **浏览器在另一台机器上时,「链路 RTT」高是真实的**:如果经隧道访问 `127.0.0.1:3080`,隧道本身的 RTT p50 可以是数十到数百毫秒,而本机 curl 同一路由只要几毫秒。面板为此有「疑似链路」判据和「链路已排除(宿主与隧道均正常)」结论 —— 别把这个数字当 bug。

## 🧰 控制台 API 与存储键位

`window.__perfHud`:

| 成员 | 作用 |
|---|---|
| `snapshot()` / `export()` | 导出的对象 / 触发下载 |
| `watch()` | 守夜层状态(在不在录、覆盖秒数、LoAF 状态、抓到几次) |
| `incidents()` / `incident(id)` | 最差几次的摘要 / 完整事故对象(索引 0 最差) |
| `report(id)` / `exportIncident(id)` | 事故包对象 / 触发下载 |
| `capture(note)` | 手动标记"刚刚卡了一下"(回退 3 秒反应时间) |
| `clearIncidents()` | 只清事故(`clear()` 不动事故) |
| `table()` / `ring` / `longTasks` | 归因表 / 环形缓冲 / 长任务明细 |
| `verification()` | 验收自证(四条腿计数、独立包名、空闲基线、导出段名) |
| `enable()` / `disable()` | 总开关(等价面板「开启/关闭」,会还原原型方法) |
| `precise` / `setPrecise(on)` | 精确归因开关与状态 |
| `mark(note)` | 场景标记 |
| `experiment()` / `abortExperiment()` / `baselines()` | 隔离实验启停与基线读数 |
| `stress(nodes?, burnMs?)` | 渲染型卡顿自测(显式燃烧,面板会标注"人为燃烧") |
| `hostEvents(on)` / `host()` / `link()` | 宿主事件到达延迟开关 / 宿主回执 / 链路样本 |

`localStorage` 键位(清状态时按需删):`dsh-perf-hud:ring:v1`(环形缓冲)、`:on`、`:collapsed`、`:precise`、`:groups`、`:marks`、`:map:<rev>:<len>`(按 rev 缓存的 sourcemap 分段表)。

## 🛠️ 开发与测试

```sh
node tests/attribution.mjs   # 11 条:脚本 URL 形状 → 包名 / bundle key
node tests/logic.mjs         # 256 条:从 client.js 抽真函数进沙箱 + 静态检查 + 长度预算
node tests/host.mjs          # 24 条:用假 ctx 驱动真实 index.js
# 合计 291 条断言,离线,无需 DSH 在跑
```

线上验证(需要先换 cookie,步骤见 [AGENTS.md](AGENTS.md) §2.2):

```sh
DSH_COOKIE=… node tests/live-sourcemap.mjs   # 真实 indexed sourcemap 的分段与包名
DSH_COOKIE=… node tests/live-host.mjs        # 真实路由;退出码 3 = 宿主半还未加载(需要重启)
```

开发规则、提交规范、代码约定、源码级归因机制与已证伪的死路见 [AGENTS.md](AGENTS.md)(§6 机制 / §8 坑);
贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 🤝 参与贡献

欢迎报 bug 与提 PR。提交前请跑完上面三套离线断言,并阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)。

## 📄 License

[MIT](LICENSE)
