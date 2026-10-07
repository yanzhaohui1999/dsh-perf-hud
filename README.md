# dsh-perf-hud

性能 HUD:FPS / Longtask(调度方 + 渲染组件)/ 每插件回调耗时与次·秒 / DOM 增长与写入者 / JS 堆 / 宿主 event-loop / 链路 RTT;固定右下角,默认开启。
安装:`dsh plugin --profile web add /Users/y/workspace/dsh-perf-hud`(已以 `link:` 装入 web profile)。
宿主半(事件循环 p50/p99、session/event 到达延迟、bundle 读写代理)改动后必须重启一次:`launchctl kickstart -k gui/$(id -u)/ai.dsh.web`;客户端半改完由 dsh-client-hmr 自动热载,刷新页面即可。
归因三条腿:调度点插桩(setTimeout/setInterval/rAF)、DOM 写入插桩(appendChild/insertBefore/setAttribute,1/10 采样)、fiber 上溯(2 秒内被改动的节点)。
合并批次(58 包)的包名来自它自带的 indexed sourcemap:面板「精确归因」开关打开才拉 map,按 rev 存 localStorage,同 rev 只拉一次,拿不到就退回「application批次(58 包)」一行。
隔离实验:读 pluginManager 的 bundle 列表 → 逐个关闭 60 秒 → 恢复并逐项核验;客户端 `ctx.remote` 与宿主路由两条通道,面板与导出都记 `via`。
测试:`node tests/attribution.mjs`(URL)、`node tests/logic.mjs`(分段二分/fiber/分位/基线/Δ/导出)、`node tests/host.mjs`(宿主路由与安全线)、`DSH_COOKIE=… node tests/live-sourcemap.mjs`(线上真实 map)、`DSH_COOKIE=… node tests/live-host.mjs`(宿主半:退出码 3 = 还没重启)。
不做:不碰 cordis.patch.yml,不碰 profile 持久化配置行(尤其 session-persistence-jsonl),不在没有 confirm 的情况下写任何 bundle 开关。
