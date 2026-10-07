# dsh-perf-hud

纯客户端性能 HUD:帧/长任务(带归属)/ 每插件回调速率与耗时 / DOM 增长与写入者 / JS 堆 / 宿主 event-loop / 链路 RTT;固定右下角,默认开启,标题栏常显「流式 / 空闲 Ns」。
安装:`dsh plugin --profile web add /Users/y/workspace/dsh-perf-hud`(已以 `link:` 装入 web profile;客户端改动刷新页面即可)。
宿主半改动才需要重启:`launchctl kickstart -k gui/$(id -u)/ai.dsh.web`;核对组合:`dsh --profile web --dump-config | grep -A1 perf-hud`。
验证:面板按显示值指纹渲染(数值未变则跳过,2 秒兜底);「导出 JSON」带 `context` 自描述头(场景/精确归因与 map 状态/版本/判色阈值);`__perfHud.snapshot()` 同源。
归因四条腿(同时给出不一致的两条):fiber 祖先走查 / 子树走查(`alternate===null`) / DOM 写入插桩(1/10 采样,估算带 `≈`) / 调度点插桩(setTimeout·setInterval·rAF,优先非核心包帧)。
边界:CSS 动画(鲸鱼摆动的 `steps()` 关键帧)不经 JS 调度器,只体现在 FPS / 最差帧 /「帧内未归因」;命中率会被 DOM 腿抬高,要配「归属 Top」分布读。
隔离实验:逐个关闭候选 60 秒 → 恢复并逐项核验;所有窗口注入同一份合成负载,每个候选只跟紧邻基线对照,基线漂移作为噪声底。
测试:`node tests/{attribution,logic,host}.mjs`(离线 183 条断言)+ `DSH_COOKIE=… node tests/{live-sourcemap,live-host}.mjs`(线上;后者退出码 3 = 还没重启)。
不做:不碰 cordis.patch.yml,不碰 profile 持久化配置行(尤其 session-persistence-jsonl),不在没有 confirm 的情况下写任何 bundle 开关。
交接见 [HANDOVER.md](HANDOVER.md)(环境运维事实 / 源码级机制 / 已证伪死路 / 读数口径 / 工作规则);验收数字见 [ACCEPTANCE.md](ACCEPTANCE.md)。
