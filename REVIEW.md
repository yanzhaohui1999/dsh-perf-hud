# 发布评审:门槛、未还的债、边界

> 这里只放**现在仍然有效**的东西。历史决策与实测证据已归档到
> [docs/plans/2026-10-11-acceptance-evidence.md](docs/plans/2026-10-11-acceptance-evidence.md) ——
> **不是必读**,只在复查某条结论时翻。
> 装什么怎么用 → [README.md](README.md);开发规则 / 源码级机制 → [AGENTS.md](AGENTS.md);变更历史 → [CHANGELOG.md](CHANGELOG.md)。

---

## 1. 对外门槛

| # | 门槛 | 现状 |
|---|---|---|
| 1 | npm 元数据完整 | ✅ `license` / `repository` / `homepage` / `bugs` / `keywords` / `main` / `engines` / `peerDependencies` / `publishConfig.access: public` 都在 |
| 2 | 包名 | ✅ 已由本项目发布(0.4.0 / 0.5.0 / 0.6.0),不再有被抢注风险 |
| 3 | 声明 `dsh.bundle.patch` | ✅ `cordis.patch.yml` 形态正确 —— 这是市场收录最常见的被拒原因 |
| 4 | 公开仓库 + topic | ✅ 已公开,`dsh-plugin` 等 6 个 topic 在场 |
| 5 | 产物无死链 | ✅ 0.6.0 `npm pack` **29 个文件**(0.5.0 的 23 + 6 个 `client.*.js` 分片);`release.yml` 逐份核(含 `tools/`、`locale/` 按目录核) |
| 6 | 门禁全绿 | ✅ **635** 条离线断言(attribution 11 / logic 583 / host 41);CI = 两个半边的 `node --check` + 三套件 + 「断言总数与文档一致」 |
| 7 | 投稿形式 | ✅ 2026-10-18 提 PR [awesome-dsh-plugin#7814](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7814)(单文件 `data/plugins/…yml`),**2026-10-19 01:29 已合并** |
| 8 | 兼容性声明 | ✅ `engines.dsh` 与三个客户端 inject 包统一 `>=0.2.0-rc.2 <0.3.0-0`;本机 `0.2.1-rc.1` 下五个真页面验收器全绿 |

**对外项已全部闭环(2026-10-19)**:收录 PR 已合并;npm 文本搜索索引已恢复 —— `/-/v1/search?text=dsh-perf-hud` 第 1 条就是 `dsh-perf-hud 0.5.0`(0.5.0 发布后索引自行追上,2026-10-19 实测)。两条原来的未完成项与证据见 [验收档案](docs/plans/2026-10-11-acceptance-evidence.md)。

---

## 2. 未还的债

1. **宿主 CPU profile 客户端未接线**:路由已能采(`profileStart` / `profileGet`,真宿主实测 1 秒 = 292 节点 / 223 采样 / 82KB),客户端没有入口,事故包也不含宿主火焰图。`capabilities()` 里照实写「客户端还没接线」。
2. **事故包不带记录器自身开销**:整机导出件有 `context.recorder`,事故包没有;`missing` 里还列着 `recorder-cost`。
3. **`stress()` 没有可读结果**:控制台自测能给 longtask / fiber / DOM 写入三条腿造受控输入,但不返回结果;`state.stress` 的记账是留给「接回面板」的钩子。
4. **`tallyScripts().unresolvedMs` 没有运行时读者**:算出来、写进 tally、只有单测断言它。要么给它消费者,要么删。
5. **`captureNow()` 语义含糊**:把「已起了一次、还没结算」和「被并进 pending」都回成 `coalesced`;产品语义未改。
6. **手动标记的反馈**:标记的 severity 是 0,以前会被「最差 10 + 每天 1」挤掉;现在有「最近 3 次」档兜底,标记一定进清单 —— 剩下的债是按钮仍不看返回值(留下的是哪一条,界面上没有回执)。
7. **`dshVersion` 恒为 `null`**:客户端读 `state.host.dshVersion`,`index.js` 从未下发。要么宿主补(要重启),要么客户端别读。
8. **跨分片共享的 94 字段 `state` 仍是单一对象**:`client.js` 已从 8,595 收到 3,751 行(1 主 + 6 片,`createModel` / `createWatch` / `createUi` 显式收依赖),但状态没有按视图归拢 —— 7 个文件里共 794 处 `state.` 引用,测试仍抽源码文本。拆分已落地,状态切分仍按 `docs/plans/2026-10-13-code-review.md` §5(P2-10) 记着。

---

## 3. 上游证据(交给上游,不在本仓库修)

- **423ms 级的 `Response.json`**:打开 / 切换一个已长大的会话时,客户端把整段会话当一个 JSON 解析。实测那个工作区单会话解压后 **6.7 / 12.0MB**(全部工作区最大 **36.7MB**)。会话大一倍就慢一倍 —— 这是「以前不卡、现在卡」的直接解释。
- **侧栏每条消息都重渲染**:13 秒窗口里 15 条 `DOMWebSocket.onmessage`(每条 ~50ms)+ `ProjectRowItem` ×5、`SidebarRoot` ×3(各 ~50ms);N 个子代理并行就是 N 倍。

本仓库只能把这两条做成上游能直接用的证据(事故包的 `packages` 已指向具体包与调用点),以及自己这侧不重复它们。

---

## 4. 当前能力边界

- **页面内没有 API,不许虚构**:帧内脚本时间轴、原始源码行号、完整调用树、交互内部「输入延迟 / 处理 / 呈现」三段拆分、合成 / 光栅 / GPU 拆分。要这些只能走 Chrome trace 或 DevTools。
- **四条腿覆盖是下界**:事件处理器 / Promise / 微任务不在调度点插桩里;**命中率会被 DOM 写入腿抬高**,必须配合名字分布读。
- **默认档(不插桩)看不到文件与行号**:合并批的包名本身就要精确归因;「可疑脚本」会如实写「要深录」。
- **原始源码行号与调用栈拿不到**:证据只能缩到「哪个包的哪个文件哪一段」;行号是脚本文本自己的行号,不是 TS/TSX 源码行。

完整的读数口径见 [README.md](README.md),开发侧的边界与已证伪的路见 [docs/mechanisms.md](docs/mechanisms.md) / [docs/dead-ends.md](docs/dead-ends.md)。

---

## 5. 历史档案

- [2026-10-11 验收证据与阶段决策](docs/plans/2026-10-11-acceptance-evidence.md) —— 10-07 ~ 10-18 的方向决定、67 条实测证据(原本文 §2 / §3.1 / §3.6)。
- [2026-10-12 下一阶段实施计划](docs/plans/2026-10-12-next-phase-plan.md) —— 0.4.0 时代的产品计划与文件清单。
- [2026-10-13 代码审计](docs/plans/2026-10-13-code-review.md) —— 12 条建议,10 条已落地;余下两条(P2-10 拆分 = 已拆成 1 主 + 6 片、P2-12 `dshVersion`)记在上面 §2。
