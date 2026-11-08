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
| 2 | 包名 | ✅ 已由本项目发布(0.4.0 / 0.5.0 / 0.6.0 / 0.7.0 / 0.8.0 / 0.9.0);**1.0.0 已于 2026-11-08 发布**(tag → GitHub Release → OIDC 自动 publish,带 provenance) |
| 3 | 声明 `dsh.bundle.patch` | ✅ `cordis.patch.yml` 形态正确 —— 这是市场收录最常见的被拒原因 |
| 4 | 公开仓库 + topic | ✅ 已公开,`dsh-plugin` 等 6 个 topic 在场 |
| 5 | 产物无死链 | ✅ 1.0.0 已发布(registry `fileCount` **38**;433.9 kB tarball / 1.18 MB unpacked;含 `tools/` 18 个、`locale/`、`skills/`);`tests/` 与 `fixtures/` 不进包;`release.yml` 逐份核(含 `tools/`、`locale/` 按目录核) |
| 6 | 门禁全绿 | ✅ **775** 条离线断言(attribution 11 / logic 697 / host 41 / compat 17 / replay 9)+ **离线渲染冒烟**(六屏 + 关闭态);CI 与 `release.yml` 都跑:两个半边的 `node --check` + 五套件 + 冒烟 + 「断言总数与文档一致」 |
| 7 | 投稿形式 | ✅ 2026-10-18 提 PR [awesome-dsh-plugin#7814](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7814)(单文件 `data/plugins/…yml`),**2026-10-19 01:29 已合并** |
| 8 | 兼容性声明 | ✅ `engines.dsh` 与三个客户端 inject 包统一 `>=0.2.0-rc.2 <0.3.0-0`;`dsh.compatibility.dshReleases` **只列真跑过的版本**(`0.2.1-rc.1` / `0.2.1-rc.3`),每条在 [1.0 验收档案](docs/plans/2026-11-07-v1-acceptance.md) 里有机器标记,`npm run pack:check` 逐条核(声明了没跑过 / 越界 / 空矩阵都红) |

**对外项已全部闭环(2026-10-19;2026-10-22 的 0.7.0 复跑一遍仍全绿)**:收录 PR 已合并;npm 文本搜索索引已恢复 —— `/-/v1/search?text=dsh-perf-hud` 第 1 条就是 `dsh-perf-hud 0.5.0`(0.5.0 发布后索引自行追上,2026-10-19 实测)。两条原来的未完成项与证据见 [验收档案](docs/plans/2026-10-11-acceptance-evidence.md)。

---

## 2. 未还的债

1. ~~**宿主 CPU profile 客户端未接线**~~ → **已还(2026-11-04)**:开发者详情「宿主与链路」有三档入口(1/5/10 秒);事故包 `context.hostCpuProfile` 带 `meta` + 自热 top(`raw` ≤512KB 时随包,超限只带汇总并写清去哪拿);`capabilities()` 与实际一致,采到后 `missing` 不再出现 `host-cpuprofile:`。真宿主实测(空闲态)1 秒 = 96 节点 / 162 采样 / 23KB。
2. ~~**事故包不带记录器自身开销**~~ → **已还(2026-11-04)**:事故包的 `context.recorder` 与整机导出件**同一个结构**(`p99` / `max` / `samples`,`selfStats()` 一份实现),`missing` 里那条 `recorder-cost:` 只在 `samples = 0`(还没采到)时照实写「这一格是空的」,有样本时不再出现。两支都有断言钉住。
3. ~~**`stress()` 没有可读结果**~~ → **已还(2026-11-04)**:`stress()` 返回可读结果(三条腿各自的 ms / 组件 / 是否命中,加 `text`);面板「工具箱」有读者,未挂载时如实回 `no-render`。
4. ~~**`tallyScripts().unresolvedMs` 没有运行时读者**~~ → **已还(2026-11-07,`296ca33`)**:选了**删**,连同类死字段 `unresolved`(条数)一起删。理由:同一个量早就有带名字的表达 —— 未定名那部分按原因 / 文件名进 `byOther`(带毫秒),渲染层 `whoRows()` 把它和 `top` 一起喂给堆叠条,每段"名字 + ms"都印在正文里;tally 再存一份汇总只会与它漂。断言换成两条:`byOther` 给出口径内的 10ms(原来只钉一个计数 1,看不出归到哪去了)+ 不变式「`top` 合计 + `byOther` 合计 = `js`」(`tests/logic.mjs` 的「D5:按包合计 + 其余来源合计 = 脚本总耗时」)。
5. ~~**`captureNow()` 语义含糊**~~ → **已还(2026-11-04)**:分成 `settled` / `pending`(已起一次、后摇没到,带 `waitMs`)/ `coalesced`(并进已有 pending)/ `not-recording` / `covered`;旧 `ok/incident` 判断路径不变。
6. ~~**手动标记的反馈**~~ → **已还(2026-11-04)**:按钮读 `capture()` 返回值并显示回执(「已记为 i42(清单第 3 条 · 最近一次)」等),未进留存也照实说。
7. ~~**`dshVersion` 恒为 `null`**~~ → **已还(2026-11-07,`c7bc488`)**:选了**客户端别读** —— 字段整个从 `manifest.json` 删掉。宿主半没有可验证的版本来源(`profileContext` 只有 `name` / `dir` / `home` / `patchPath` / `overlays` / `startedBundles`,环境变量里没有 DSH 版本),补它只能猜 API(违背 §1);而一个恒 `null` 的字段会让读包的人去追一个不存在的采集失败。宿主运行时版本没丢:采过宿主 CPU profile 时在 `context.hostCpuProfile.meta.nodeVersion`。断言「诊断包:manifest 不宣称拿不到的 DSH 版本」钉住"别读回来"。
8. ~~**跨分片共享的单一 `state` 是 99 字段、900 处引用的一大坨**~~ → **已还(2026-11-07,1.0 / S1)**:状态按视图切成四片 —— `state.ui`(23)/ `state.render`(53)/ `state.watch`(37,守夜层自己就是一整片)/ `state.host`(15);900 处引用全部改写成 `state.<片>.<字段>`,裸字段引用为 0。宿主快照字段 `host` 顺手改名 `snapshot`(`state.host.snapshot`,否则会出现 `state.host.host`)。四条离线断言钉住边界:片名只有这四个、四片字段数写死(挪字段要交代)、每处引用都命中真实的「片.字段」、**采集侧只读自己那片**(守夜层读不到面板状态,工具箱只读场景标签;model / ui 拿全四片)。真页面五个验收器全绿。仍留在原地的:测试仍抽源码文本(那是测试写法,不是状态问题);**守卫是基于正则的文本匹配,不是 AST** —— 解构 / 点号与方括号别名 / 赋值式别名 / 方括号字面量字段已覆盖,但**换一种拼法就可能绕过**(`const { frames } = state["watch"]`、`state["watch"]["frames"]`、`(state).watch`、`state .watch`、`w2 = state["watch"]` 实测全绿),**函数参数 / 对象属性携带整片**也判不出 —— 这两类都明确写成"靠评审,不靠断言"。
9. ~~**Skill 的 `missing:` 前缀漂移没有守卫**~~ → **已还(2026-11-07,`80fb093`)**:`capabilityMissing()` 产出的是自由字符串,而诊断 Skill 按 §2.6 那张前缀表分类读包 —— 客户端换措辞 / 加前缀时三套件照绿,Skill 会静默落进"其它"类。补断言「缺失声明的前缀集合与诊断 Skill §2.6 的前缀表一一对应」:两边去重集合**双向**比(代码有而表里没有 / 表里有而代码已不生成),外加"每个 `missing.push` 都真的以 `前缀:` 开头"(把前缀拼进变量会绕过前两项)。新断言一上来就抓到真实漂移:`host-snapshot:` 与 `loaf-pkg:` 从没进过 Skill 的表,已补进「采集丢了 / 还没采到」。
11. **A4 timeline 只有 fixture 重定位证据(未还)**:`incident.timeline[]` 的对齐与 64.9% 宿主占比,都是在"真 V8 profile + 同进程帧夹具"上算的 —— **真实卡顿的双端现场采集(真页面 + 真宿主同一次事故)还没做**;`check-panel` / `check-counts` / `check-incident` 都不覆盖 `incident.timeline`(它们里的 `timeline` 是旧的帧条 UI 层)。已钉住的部分:`npm test` 断言夹具对齐 = `[2, 0]`(两段真忙期、最大偏移 0 帧)且两段序列能重算；补齐条件:一次可复现的真实卡顿 + 页面侧抓到同一窗口的 profile,再按 fixture 同样的方式验。
10. ~~**`tools/inspect-incident.mjs` 读不了自家 fixture**~~ → **已还(2026-11-07,`00b4706`)**:`tests/fixtures/incident-real.json` 是 `{incident, thresholds, redaction}` 的**切片**,工具按完整包判 `kind`,于是 `kind=undefined` 退出 1 —— 仓库自带的样本自己读不了。现在按形状自动认切片(`thresholds` / `redaction` 从顶层搬进 `context`,渲染仍只有一条路),其它形状明确报错并提示 `--allow-slice`;**切片会被说出来**(没有 `context.missing`,那三段显式写"切片里没有这一栏 —— 不是没有缺口")。用法写进工具头部注释,人读的入口在 [`docs/verification.md`](docs/verification.md) §2.2。

---

## 3. 上游证据(交给上游,不在本仓库修)

- **423ms 级的 `Response.json`**:打开 / 切换一个已长大的会话时,客户端把整段会话当一个 JSON 解析。实测那个工作区单会话解压后 **6.7 / 12.0MB**(全部工作区最大 **36.7MB**)。会话大一倍就慢一倍 —— 这是「以前不卡、现在卡」的直接解释。⚠️ 2026-11-07 复核(附录 A3):DSH 0.2.1-rc.3 上这条路已改成 WS 流帧,**423ms 级 `Response.json` 不可复现**(纯解析 2–13ms);这条只能当 0.9.0 时代的观测,今天的打开慢看解析所在长任务与渲染量,见 [A3 实测](docs/plans/2026-11-07-a3-open-cost.md)。
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
