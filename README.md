# dsh-perf-hud

> **纯客户端性能 HUD**:右下角一块浮层,回答"现在卡不卡、卡在谁身上"。
> 帧与最差帧 · Longtask(带四条腿归因)· 每插件回调速率与同步耗时 · DOM 增长与写入者 · JS 堆 ·
> 宿主 event-loop 与链路 RTT · 隔离实验(逐个关插件做对照)· 一键导出 JSON。

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
- [🔬 四条腿归因](#-四条腿归因)
- [🧪 隔离实验](#-隔离实验)
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
| 关掉某个插件到底有没有用? | 隔离实验:逐个关闭 60 秒,和紧邻基线对照,并给出噪声底 |

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

> 宿主半是**可选**的:它没加载时面板照常工作,只是「宿主 event-loop」「宿主事件到达」「隔离实验」三处显示不可用,并写明原因 —— 不假装成功。

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

## 🧪 隔离实验

逐个关闭候选插件 60 秒 → 测量 → 恢复并逐项核验,每个候选只跟**紧邻基线**对照(A/B/A),基线漂移作为**噪声底**,Δ 小于噪声一律标「噪声内」;窗口含流式则标「不可比」且**不给结论**。

候选**从你当前的 bundle 列表里推导**,不写死任何插件名:取「已启用 + 可移除 + 非官方内核 + 不是本 HUD 自己」的社区包,按名字排序最多取 4 个(每个候选 90 秒)。列表为空时实验直接说"没有可对照的第三方插件",不拿不存在的名字空跑。

所有窗口注入同一份**合成负载**(每 250ms 燃烧 8ms,走未插桩的 `setInterval`,只烧 CPU 不动 DOM,避免污染归因表)—— 空闲下的比较本身没有意义。看「超出噪声」列才是证据。

⚠️ 它测的是**固定开销**(跑飞的时间器、常驻动画、轮询、observer),**不是**"该插件在某种用法下才贵",别当因果证明。

## ⚠️ 风险与边界(必读)

1. **默认开启**。安装后浮层默认就显示,并会插桩全局:`setTimeout` / `setInterval` / `requestAnimationFrame`,以及 `Node.prototype.appendChild` / `insertBefore`、`Element.prototype.setAttribute`(1/10 采样)。
2. **一切可还原**。面板「关闭」或 `window.__perfHud.disable()` 会把原型方法还原成原生实现,并且只在"当前仍是我们那个 wrapper"时才还原(不会踩掉别人的包装)。
3. **隔离实验会临时写 profile 的持久化 bundle 选择**(`pluginManager.setBundleEnabled`)。它有硬安全线:必须 `confirm`、拒绝改本插件与 `session-persistence-jsonl`、每步记宿主回执、结束后逐项核验恢复;中断也会走恢复流程。不想动配置就别点「开始实验」。
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
node tests/logic.mjs         # 152 条:从 client.js 抽真函数进沙箱 + 静态检查 + 长度预算
node tests/host.mjs          # 24 条:用假 ctx 驱动真实 index.js
# 合计 187 条断言,离线,无需 DSH 在跑
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
