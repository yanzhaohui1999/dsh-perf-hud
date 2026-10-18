# 归因机制(源码级事实)

> 从 [AGENTS.md](../AGENTS.md) §6 移出(2026-10-18),正文未改。改归因链路前必读。

## 6. 归因机制(源码级事实)

### 6.1 脚本 URL 形态与"包名从哪来"

| 形态 | 含义 |
|---|---|
| `plugins/??<包名>/client.js&rev=<hash>` | 单包组合,**动态装载时一个包一条** |
| `plugins/<包名>/<分片>.js?rev=<hash>` | 包内分片 |
| `plugins/??a/client.js,b/client.js&rev=<hash>` | 启动批;本版本**只 preload 不执行** |

- **LoAF 的 `scripts[]` 也能定到包名**(2026-10-07):它给的是 `sourceURL` + `sourceCharPosition`,单包 URL 直接从 URL 读出包名;多包 URL 要把字符位置换算成行号,再走同一张分段表。换算需要那段脚本文本(同源 `fetch`,浏览器内存缓存命中),所以按 URL 后台预取、只留行起始偏移(`Int32Array` 级别的开销)。**逐 UTF-16 code unit 数换行**,不能用 code point。实测:一次事故 37/37 条脚本全部定名,归到 `@deepseek-ai/dsh-api-gateway`
- **合并包里没有 `sourceURL` 边界标记**,所以包名只能靠它自带的 **indexed sourcemap**:`plugins/??a/client.js.map,b/client.js.map&rev=…` → `sections[i].offset.line`(0-based)+ `map.sources[0]` → `/plugins/<包>/…`;V8 的 `CallSite.getLineNumber()` 是 1-based,**换算要减一**。线上实测:58 sections、包名与批次 entries 顺序完全一致、116 处边界断言 0 错。按 `rev` 缓存分段表(`localStorage` 的 `dsh-perf-hud:map:<rev>:<len>`),同一个 rev 只拉一次那份 12MB 的 map。
- `window.__DSH_BOOT__ = { rev, entries, batches }`(首页内联);批次名取自 `batches[i].phase`(`application` / `bootstrap`),包数 = `batches[i].entries.length`。
- **`data-dsh-plugin` 在本版本不存在**,不能靠它归因;可用的稳定 DOM 钩子只有:`[data-chat-running]`(流式判定)、`[data-conversation-content]` / `[data-chat-flow]`(消息区)、`[data-row-key]`(会话行的 `parentElement` 当列表容器)、`[data-shell-overlay]`。
- 精确归因关闭时,合并批次只给一行标签(`application批次(58 包)`),**这是刻意的**,不展开。

### 6.2 四条腿各自的能力边界

面板会**同时给出不一致的两条**,不挑好看的报:

| 腿 | 机制 | 擅长 / 局限 |
|---|---|---|
| `fiber` | 从被改动节点**往祖先**走最近的具名函数组件 | 擅长增量更新;整棵子树一次性挂载时只能给到容器 |
| `子树` | 往**子树**走,优先 `alternate === null`(React 标记"本次新挂载") | 补"整棵挂载"空档;有界 BFS ≤200 |
| `DOM写入` | 采样 `appendChild` / `insertBefore` / `setAttribute`(1/10),在写入点抓栈 + 取组件名 | 提交阶段栈里没有插件帧时的主力;估算值带 `≈` |
| `包名` | 调度点插桩(`setTimeout` / `setInterval` / `rAF`)与长任务时间重叠 | 定时器 / 动画类;**事件处理器、Promise、微任务不在内** |

**交互延迟不走这四条腿**:`event` / `element` timing 是单独一层(守夜档就挂着,不插桩),给的是端到端时长与 `waitMs` / `handlerMs` 的**粗略两段**,只进导出件。所以"事件处理器不在四条腿里"这条依然成立 —— 别把 `context.interactions` 读成帧内拆分(那份拆分页面内没有 API,见 [已知坑](dead-ends.md))。

### 6.3 宿主外壳名 / 错误边界 / 压缩名

- 外壳组件名**不是答案**:`SlotOutlet`(槽位座)、`CenterColumn`(布局列)、`*Boundary` / `*Provider` / `*Context`、错误边界(判据:原型上有 `componentDidCatch` 或 `getDerivedStateFromError`)、生产构建压缩名(大小写 1~2 字母 + 数字,如 `n5` / `Bn`)一律跳过继续找。**这是补丁,不是根治** —— 根治靠上面四条腿交叉。
- 外壳的 `SlotErrorBoundary`(在 `dsh-client-ui-renderer`)会在条目渲染抛错时 `console.error('slot entry crashed in …')` 并**永久停用该条目**(`active: false`,只能刷新恢复)。所以 `client.js` 自带 `HudBoundary`,把错误降级成一块小面板并把错误原文写进导出件的 `errors` 段。
- 生产 React **没有** `_debugSource` / `jsxDEV` → **无法**从 fiber 直接拿到组件定义文件;组件名只能靠 `type.displayName ?? type.name`。

### 6.4 宿主侧 API 事实(本插件实际用到并验证过的)

- **挂 HTTP 路由的形态**(照抄 `dsh-context`):`ctx.inject(['connection'], c => { const reg = c.get('connection')?.fetch?.register?.bind(…); c.effect(() => reg({ path, methods: ['GET','POST'], requestBody: 'buffered', fetch: handler }), label) })`;handler 收到 Web `Request`,返回 `Response.json(…)`。
- `pluginManager`:`listBundles()` / `setBundleEnabled(name, enabled)` 是 `@Remote`(客户端可经 `ctx.remote.pluginManager` 调),**宿主半也可以直接调**(本插件就是;隔离实验正是走这条)。两者回执形状相同:`{ changed, application, stage, target, enabled, error… }`。
- `perf_hooks.monitorEventLoopDelay({ resolution })` 的 **`resolution` 默认 10ms**,会把 p50 顶到 ~10ms 的地板,看不出真实抖动;本项目用 `1`。单位是**纳秒**。宿主半每秒采 **p50 / p99 / max** 三个数下发(`index.js` 取 `histogram.max`),面板那一行照抄三个都给 —— 只给 p99 会把偶发的秒级停顿藏掉;老版本宿主半没有 `max` 字段时**如实只给 p50/p99**,不补 0。
- 客户端拿宿主数据有两条通道:客户端 `ctx.remote`(本 profile 未接通)与宿主路由 `/api/dsh-perf-hud/host`(已验证)。面板与导出都记 `via`,**不猜通道**。
- `ctx.on('session/event', (session, event) => …)` 是**公开且可用**的监听方式(与 `dsh-session-persistence-jsonl` 同一个事件);`event.time` 是提交时间戳。我们记的是「提交 → 到达监听器」的延迟,**不是**监听器的 CPU 耗时 —— 面板文案与导出字段(`mode: 'listener'`)都照这个口径写。
- **插件展示元信息**(Plugins 页那一行)由 `package.json#icon` + `locale/<lang>.json` 的 `meta.title` / `description` 提供。⚠️ 实测(`@deepseek-ai/dsh-app-boot` 的 `readPluginMeta`):宿主先解析 `<包>/locale/en.json`,**然后 `scandir` 它所在目录** —— 所以 **`locale/` 目录不能整个删掉**,目录不存在会让 Plugins 页面直接显示一条红色诊断:`Plugin metadata for <包>: Error: ENOENT: no such file or directory, scandir '<绝对路径>/locale'`(错误发生在读 icon 之前,连图标都救不了它)。`locale/en.json` 是发现基线(缺它整个目录都不读),`exports` 必须暴露 `./locale/*.json` 与 `./package.json`。**失败是静默降级 + 一条诊断**,不会拦住插件加载。
