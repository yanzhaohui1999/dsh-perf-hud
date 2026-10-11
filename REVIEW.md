# 发布评审:门槛、验收证据、待办

> 本文是**发布这件事本身**的长期文档:对外门槛、验收判据与实测证据、还差什么。
> 装什么怎么用 → [README.md](README.md);开发规则 / 源码级机制 / 已知坑 → [AGENTS.md](AGENTS.md);
> 变更历史 → [CHANGELOG.md](CHANGELOG.md)。
> 下面的数字是 2026-10-07 与 2026-10-11 两次当场实测的;带日期的观测只当证据,不当承诺。

---

## 1. 对外门槛(不满足就发不出去 / 收录被打回)

| # | 门槛 | 现状 |
|---|---|---|
| 1 | npm 元数据完整 | ✅ `license` / `repository` / `homepage` / `bugs` / `keywords` / `main` / `engines` / `peerDependencies` / `publishConfig.access: public` 都在 |
| 2 | 包名可用 | ✅ `dsh-perf-hud` 在 npm 上 404(未被占用)—— **首发前再查一次**,名字被别人抢了就全盘皆输 |
| 3 | 声明 `dsh.bundle.patch` | ✅ 这是市场收录**最常见的被拒原因**;`cordis.patch.yml` 形态正确 |
| 4 | 公开仓库 + `dsh-plugin` topic + 创建满 1 天 | ⬜ 仓库已建(私有),待转公开、加 topic |
| 5 | 产物无死链 | ✅ README / AGENTS 链接到的文档全在 `files` 里;`release.yml` 的 Pack and inspect 逐份 grep,而且 **`tools/` 与 `locale/` 按目录核**(以后加验证器或加语言文件不会漏检),显式清单 + 目录共覆盖包内全部 **18** 个文件(含 `package.json`),漏一份就失败 |
| 6 | 门禁全绿 | ✅ 458 条离线断言;CI = 两个半边的 `node --check` + 三套件 + 「断言总数与文档一致」 |
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
| 离线断言全绿 | `npm test` | **458** 条(attribution 11 / logic 408 / host 39) |
| 面板能渲染、不自我崩 | 真实页面 `snapshot().errors` | **0**(CDP 反复打开真实页面验过;自带 `HudBoundary` 兜底) |
| 守夜层能自动抓 | `__perfHud.watch()` | 真实会话:captured **25** · coalesced 102 · dropped 18 · kept 10 |
| 守夜默认**零插桩** | `snapshot().instrumented` 在三种模式下的取值 | 默认(不插桩)档:`precise: false` / `instrumented: false`,`errors: 0` —— 守夜档仍然零插桩;点「深录」→ `true / true`;点回去 → `false / false`,`errors` 全程 0 |
| 事故落盘且活过刷新 | 抓一次 → 刷新 → `watch().restored` | restored **10**;读回条目带 `restored:true`、`env.perfOrigin` 保留,`report()` 跨会话可渲染(184 帧) |
| 留存两档并集 | 塞跨天旧事故 → 刷新 → `watch().kept[].tier` | 15 条旧事故(一天 12 条 + 另外三天各 1 条)→ **restored 13** · tier `{worst 9, daily 3, both 1}`,工具箱清单里「当天最差」出现 3 次 |
| 跨会话基线只进导出件 | `snapshot().context.sessionBaselines` | 一次会话一条(`frames 82 / p50 23.6ms`),`note` 写死「粗参照,不是回归判定」;面板不显示(静态断言钉住) |
| 拆解视图(环 / 堆叠条 / 交叉表) | 面板 DOM + `tools/check-panel.mjs` 现场量 | 环 **4 弧**(`viewBox 0 0 84 84` 里 4 个 circle);每个 scope 两条 100% 堆叠条(段 tooltip 形如 `setTimeout 240ms · 100%` / `script 209ms · 47%`);交叉表展开后 4 行 × 5 列,行 `插件批次(未按 sourcemap 拆) 371 …`、`无 URL(内联脚本) 240`、`dsh-client-modules 206`、`其余 70 19`;三处悬停联动 **已停用,而且那套辅助代码已删干净**(`hot` / `setHot` / `hotProps` / `hotStyle` 与各处的 `hot === …` 都不在了;复现尝试与结论见下面「悬停联动:真实鼠标复现尝试」一行);**点击类交互不受影响,已实测正常**;环的 4 条弧 stroke-width 恒 13;**字数**:展开面板 1360 字 / 109 行、`取证明细` 639 字 / 36 行(交叉表展开 896 / 65)。⚠️ 与改造前的 533/32 不能直接比 —— 那是另一次采样(窗口里的名字长度不同),同一份 live 数据下差值在 ±100 字量级;结构性减字是"环里不再有来源名、窗口全纯执行时少一行、其余来源并进条里",而"其余来源"的命名与交叉表表头是**加**的字 |
| 60 秒帧条与导出件同口径 | 面板 SVG + `tools/inspect-incident.mjs` 的 ASCII | 真实页面 **`width 100%`**(实测 **365×18**,`viewBox 0 0 60 18`)、`errors: 0`,每格都有 `title`(墙钟时间 + 该秒最差帧 + 点得动/点不动);`sparkPickMap` **只有那一秒真的有 LoAF 的格子可点**(点了把翻帧切过去),其余格子不给 `onClick`(不做点了没反应的假按钮);阈值一致性有静态断言(≥100 / ≥50) |
| 帧拆分:环的四段 + 脚本三种切法 / 两个分母 | 面板 SVG / `frameSplit` / `frameArcs` / `framePkgTally` / `invokerLabel` | 真实页面(**`node tools/check-panel.mjs --expr=…`**,自己造带脚本的 LoAF):环 **84×84**、`viewBox 0 0 84 84`、半径 34;一条只有单个来源的帧画出 **4 个 `<circle>`**(弧长 `175.3 / 35.1 / 0.3 / 0.1`,周长 213.6;颜色 `state-error / label-secondary / state-warn / brand` —— 任务那段是中性灰);六行块式值实测 `纯执行 260.1ms` / `未定名(未归因 1)` / `setTimeout 260ms` / `dsh-client-modules 192ms · 未定名 25` / `DOMWebSocket.onmessage 425ms · setTimeout 421ms · Response.json.then 322ms · 其余 1` / `纯执行 1353.2ms · 强制 6.4ms`;窗口那组的标题自带分母 `窗口:N 条长动画帧 · 跨 T · 平均每条脚本 Xms`(`spanText` 把跨度写成 `43分12秒`);没插桩时 `帧内未归因` 写「要深录」、`命中` 只列非零的腿、`回调归因` 与 `DOM 写入` 两行不渲染;**翻帧按钮真的换帧**(同一次实测:自动 `帧 1/16 · 530ms` → 环 `579.6ms`;按 ▶ → `2/25 · 275ms` → 环 `325ms`;再 ▶ → `3/28 · 170ms` → 环 `220.3ms`;按 ⟲ 回到 `1/… · 530ms`);**清单只收达线的帧**(同一次实测:环里 21 条 LoAF,选单只有 `帧 1/4 · 210ms · ≥100ms`,▶ 走到 `2/4`);`errors: 0`。**函数级的边界也是实测的**:`typeof Profiler === 'function'` 但 `new Profiler()` 抛 `NotAllowedError … disabled by Document Policy`(响应头实测 `null`)。⚠️ 行里"脚本那几段 `stroke-opacity` 递浅"是脚本细分还画在环上时的读数;后来环只画四段,来源/包各自搬成 100% 堆叠条、名次用压暗 overlay(见上一行) |
| 改版后整场深检(一次性 CDP,用完即删、没入库) | 面板 DOM + 真实鼠标 | 5 个组全展开渲染 **0 错误**;真实鼠标移到 5 个行级元素上(按包小表行 / 事故清单行 / 组头)**都没有被外壳停用**,0 错误 |
| 悬停联动:真实鼠标复现尝试(**2026-10-11,结论:复现不出来**) | 真页面 CDP 探针 | 真实鼠标依次扫过交叉表容器内全部 **163** 个元素(每个元素来回两次)+ 用 JS 直接派发 **153** 次 `mouseover`:面板全程存活、`errors: 0`、环数不变、控制台无输出。所以既不能证明根因、也不能证明已修好 → **保持停用**,并按"不要留半活的死代码"把这套辅助代码**删掉**。踩坑记录:探针的 console 钩子必须装在同一次 `reload` **之后**,否则钩子随旧文档一起被清掉,等于没在监听 |
| 首屏精简(控件按需出现) | 面板 DOM + 条件渲染 | 「全部折叠」只在**有组开着**时渲染(`anyGroupOpen()`);「恢复默认布局」只在 `layoutDirty()` 为真时渲染(有组开着 / 翻帧被钉住 / 手选了事故 / `scope` 不是"最差" / 挂着一次性说明);两者都无意义时**整行不渲染**。「最差事件」行新增**「最近 / 最差」切换**(`state.watch.scope`,默认最差 = 严重度最高),点击清掉手选(`selId`),状态在下行写 `自动·最差` / `自动·最近` / `已选中`,`resetLayout()` 把 scope 归位;没有新增任何排行榜 / 指标卡 / 装饰图。一次性 CDP 深检:全折叠后「全部折叠」消失而「恢复默认布局」仍在(因为还有上下文),恢复默认布局后两个按钮都消失且 scope 归位,全程 0 错误 |
| 事故链:选中 → 定位 → 取证 | `__perfHud.capture()` 造事故 + 面板 DOM | 工具箱清单行可点选 → 清单出现 `●`、首屏「最差事件」块显示「已选中」,0 错误;`revealIncident('i84')` = 选中 + 展开「取证明细」+ 把翻帧钉到该事故开始时刻最近的长动画帧(**限定在事故窗口内** —— 跨会话读回的事故离当前帧环可能几百秒,那时"最近的帧"是无关帧);定位不到会写一句如实说明(`state.pickNote`);选中存 **id** 不存下标(`state.watch.selId` + `selectedIncident()`,默认自动跟严重度最差那条,选中的被挤出留存清单就退回自动) |
| **可疑脚本**:证据 → 代码定位(本轮核心) | 面板「取证明细」组内(组折叠时不算)+ `incident.summary.topScripts[]` | 新增一块,把「事故 → 帧 → 来源 → 包 → 文件:行」落到**个体脚本**:最多 **4** 行(`EVIDENCE_MAX`)、按耗时降序;**只列能定位的行**(函数名 / 包名 / 文件至少有一个,一个都没有的行不占名额);标题写明范围(事故优先 `可疑脚本 · 事故 i84 · 窗口内`,没有事故脚本才退回 `可疑脚本 · 本帧`);每行 `<函数名> @ <包名>` + 毫秒,hover 给完整证据行、**点击复制**「函数 @ 包 · 文件(:行) · 耗时 · 来源」;底下给**分母**(`11条脚本 · 定到包 1/11`,分母按**全部**脚本算 —— 过滤不会把"没定到名"藏起来)+ 口径 + 缺口。真页面(打开「深录」,两张合并批 map 都 ready:58 包 + 16 包):证据行 **4/4** 都拿到 `包 + /plugins/…/client.js + line=text`,**0 错误**;样例行(**本轮口径**:有界面的那一条已拆成文件 + 「合并脚本行」)`函数名未记录 @ dsh-client-connection · /plugins/@deepseek-ai/dsh-client-connection/client.js · 合并脚本行 25580 · 230ms · 来源 Response.json.then · pkg=section line=text`;一条能定位的都没有时整块收敛成一行 `可疑脚本:0 条定到名(窗口内 11 条脚本)· 要深录` + 一行"缺什么"。新管线:`sectionSource` / `sectionIndex` / `sectionPath`、`scriptPosition(url,charPos)`、`scriptEvidence`、`evidenceName/Place/Line`、`incidentEvidenceLines`、`evidenceScope/Footer/ZeroText`、`locatable(rows)`。⚠️ **光有行号不算能定位**:合并批里 charPos → 行号是相对那个几十包合起来的大文件,不知道属于哪个包时它指不出任何可打开的东西(实测非深录档会出现 `line=25580` 而 `pkg` 为 null),所以 `locatable` 只认函数名 / 包名 / 文件 |
| **历史事故的证据:存下来的优先(刷新后逐字一致)** | `incidentScriptEvidence` / `incidentEvidenceAt` + 面板 DOM + 「复制摘要」 | 事故包 `summary.topScripts[]` 在**捕获那一刻**就把 `pkg` / `pkgVia` / `file` / `line` / `lineVia` / `lineScope` / `invoker` 算好写进去了,但面板原先用 `scriptEvidence()` **重新现算** —— 现算吃当前会话的 `state.precise` 与内存里的脚本文本 / 分段缓存,**刷新后两者都空**,存好的定位就变成 `null` / `还没预取`。现在面板(`evidenceScope()`)与「复制摘要」(`incidentEvidenceLines()`)走的是**同一条路**(`incidentScriptEvidence` 存下来的字段优先,老包缺失才回退现算;`incidentEvidenceAt(row, script)` 解 URL 表 + 判断要不要现算),所以不会出现"面板上有、复制出来没有"。真页面 CDP 实测(一次性脚本,用完即删):深录档抓一次(事故包存下 `pkg=section · /plugins/@deepseek-ai/dsh-client-connection/client.js · line 25580 · lineScope=bundle`)→ **把深录与精确归因都关掉**(模拟"换台机器 / 过几天再打开")→ **刷新** → 证据行与刷新前**逐字一致**(照样显示「文件 + 合并脚本行 25580」),`errors: 0`。老包(加字段之前抓的)读回时如实显示 `pkg=precise-off line=text-not-fetched`,不崩、不编 |
| **合并脚本的 file / line 口径拆开(不拼 `文件:行`)** | `scriptEvidence` 的 `lineScope` + `evidencePlace` / `evidenceLine` / `evidenceWhereText` + 静态断言 | 合并批(`plugins/??a,b`)里 `charPos → 行号` 是相对**合并后大文件**的,而 `sectionPath()` 给的是那个包**自己的源文件** —— 两个坐标系拼成 `file:line` 看着精确、实际指不到任何一行。现在 `lineScope` 分三档:`bundle`(合并批)/ `file`(单包 URL、单包组合)/ `null`;`evidencePlace()` 对 `bundle` **只给文件**,行号由 `evidenceLine()` 单独成段写成**「合并脚本行 N」**,`evidenceWhereText()` 在悬停里也分列(文件 · 合并脚本行 N · pkg/line 两个 via 档);口径文案写明**行号是脚本自己的行号,不是原始 TS/TSX 源码行**(要原始源码行得解 section 内层 `mappings` 的 VLQ,本项目没做)。实测:合并批那几行**绝不**出现 `client.js:25580` 这种串;单包 URL 那一行照旧 `client.js:455`(行号确实属于那个文件)。静态断言:合并批不拼 `file:line`、老包缺 `lineScope` 时按 `pkgVia` 现推(`section` ⇒ `bundle`,否则 `file`) |
| **事故回放(新功能,刷新生效)** | 面板「取证明细」组内(紧跟实时帧条)+ `replayScope` / `replayX` / `replaySummaryText` / `replaySplitText` | 把**选中的那条事故**那一段窗口画出来:数据**全部来自事故包**(`incident.frames` / `incident.loaf` / `summary`)→ **刷新生效、零新增采集**;与实时 60 秒帧条**刻意分开**显示(标签写明事故 id 与跨度,实测 `事故回放 · i1 · 13秒`)。内容:帧条(横轴**按时间**放 —— 按序号会把整段 rAF 挂起压成一根柱子,挂起段**留白**;档位与实时帧条共用 `sparkLevel`、颜色共用 `SPARK_COLORS`)+ 一行范围(跨度 / 帧数 / p50 / p99 / 最差帧 / 缺口数)+ 一行最差帧的四段分解(复用 `frameSplit`)+ 一行口径脚注。实测:回放块在场(标签 + `viewBox="0 0 1000 24"` 的条 + 口径脚注)、**刷新后仍可用**(数据在包里);`replayX(t,from,span,width)` 按时间线性定位、越界夹住(有断言)。⚠️ **不排帧内执行顺序** —— LoAF 不给每帧内脚本的起止时间;逐帧明细仍走「导出事故包」+ `tools/inspect-incident.mjs` |
| **REVIEW §3.4 的 `pkgZeroText` 债已还(死分支已删)** | 静态断言 + `whoRows(tally)` 数据断言 | 确认那段「0 条定到名(带分母)」**不可达**:外层要求 `window.js > 0`,而 `js > 0` 必然有脚本,脚本要么进 `top`、要么进 `byOther`(且 ms>0),两者互斥 —— 旧套件却因为**直接测那个函数**而一直绿。现在死分支与 `pkgZeroText` 一起删掉;断言改成**实际渲染的那份数据**:喂给「按包」堆叠条的就是 `whoRows(tally)`,一个包名都没定到时看到的是**按原因命名的「其余来源」段(带名字与毫秒)**,不是一行"0 条定到名";并加一条静态断言:全仓不再有 `pkgZeroText`(死代码不许回来) |
| 「复制摘要」可直接交接给另一个 AI | 工具箱「复制摘要」 | = 结论 + 口径 + 可疑脚本证据行 + 「窗口内 ≥100ms 的交互」(有才写,标明端到端、不拆帧内)+ 缺什么;目的是**能直接交给另一个 AI 接着查** |
| 组合 URL 的"文件路径"不再退化成 `/plugins/` | `scriptEvidence` 断言 + 真页面 | 真 bug:`new URL(url).pathname` 对**组合 URL**(`plugins/??…`)会把第一个 `?` 当成查询串开始,pathname 只剩 `/plugins/` → "文件路径"显示成 `/plugins/`。现在组合 URL 走正则自己拼(单包组合 ⇒ `plugins/<包>/<文件>`);断言里同时钉住 `new URL` 的 pathname 就是 `/plugins/` |
| 合并包分段表三列对齐 | `rows` 一次建成 + 一起排序 | 真 bug:`names` 数组在 `offsets.sort()` 之后**没有跟着排序**(没人读过它所以一直没暴露);加上 `paths` 之后这个错位会变成"包名 A 配文件 B"。现在 offsets/names/paths 一次建成同一张表再一起排序 |
| 可复制 + 只有一个真手型 | 按来源/按包小表行 / 堆叠条色段 | 具名行 **8/8** 有手型(可复制);点一行之后面板仍在、`errors 0`、「已复制」照实显示(`copyText` 成功/失败都照实说);堆叠条色段 **0** 个手型(假按钮已去掉) |
| 帧严重度口径统一 | `frameSeverity(row)` = `max(blocking, dur)`,`worstLoaf` / `loafRanks` / `pickList` 三处共用 | 有一条断言钉住"自动选中的那条一定在翻帧清单里"(旧口径 `worstLoaf` / `loafRanks` 只看 blocking 时会出现标签 `帧 0/N`) |
| 窗口聚合不再冻住 | `scriptPkgTally` 缓存指纹带 `resolveSeq` | 旧指纹只有 `条数\|最后一条 t`,与**异步**到位的 sourcemap 分段表 / 脚本文本无关 → 环满 200 条而一时没有新 LoAF 时,「窗口」三行与「包 × 来源」交叉表会**永久冻在**"插件批次(未按 sourcemap 拆)"(同屏「本帧」行已给真名)。现在每个 `entry.state` 写入后与 `setPrecise` 各推一次(`markResolved()`) |
| 折叠组惰性渲染 | `group(key,label,summary,...children)` + 5 个调用点 | 唯一子节点是函数时折叠连函数体都不进(detail / cross / dom / host / tools 全传 thunk),不再每个 tick 重算派生统计 |
| 严重度两样都给 | `severityLevel` + 首屏「最差事件」块 | ≥200ms `bad`(与面板判色红档同一条线)、≥100ms `warn`(守夜触发线)、其余 `ok`;面板**文字 + token 颜色两样都给**,不只靠颜色 |
| 宿主 event-loop 补 max | 面板 `hostLoopText` | p50/p99/**max** 三个都给(宿主半 `index.js` 早在采 `max`,面板一直没显示);老版本没有 `max` 字段时如实只给 p50/p99,不补 0 |
| 脚本侧按包 | 面板「本帧按包 / 脚本按包·窗口」/ `incident.packages` | 真实页面 **`dsh-api-gateway 881ms · dsh-client-connection 312ms · dsh-client-modules 208ms · 其余 1`**(v0.3.0 实测,当时是窗口聚合那一行);定不到包名的条数会跟在同一行尾巴上(`· 未定名 8`) |
| 交互延迟(页面内那一半) | `snapshot().interactions` / CDP 真实输入 | `state: on`(supported = element + event);一次真实点击 **20** 条入库,`pointerover` 那条 `ms 112 / waitMs 0.3 / handlerMs 0.4` —— 端到端长 ≠ 页面反应慢;`element` 恒 0 并解释原因 |
| 真页面验证可复跑 | `tools/check-panel.mjs` / `check-storage.mjs` / `check-interaction.mjs` | 三条都真跑过并 **ALL PASS**(面板挂上 + 渲染 0 错误 / 写 localStorage → 重新加载 → 读回 / CDP 真实输入 → event timing 交付 22 条交互);`check-panel --expr=false` 会 FAIL 且退出码 1;它们**不是离线门禁**(要真浏览器 + 本机 `dsh web`),CI 只对 `tools/*.mjs` 做 `node --check` |
| 记录器自身不冒充元凶 | 面板「归属 Top」/ `blameText` | 真页面:`PerfHud / PerfHudStress` 那条 224ms 长任务改为归到 **`RootEntry`**(真组件);只有记录器自己是唯一候选时才单列「记录器自身 N×」 |
| 记录器自己贵不贵 | 面板「记录器自身」/ `context.recorder` | 真页面读数(本轮 P3 复核):`p99 0.1ms · max 0.2ms · samples 113`(它自己的 rAF 回调,最近 600 帧环形缓冲;更早一次是 `p99 0.1ms · 峰 0.1ms · 样本 167`)。机制由断言钉住(`recordSelf` / `selfStats` / 环形上限 600);这条是**自证**口径,不是页面开销 |
| 压缩名过滤 | `usableComponentName` 断言(传**类**) | `class $c {}` / `class $w {}` → `null`,`class ChatView {}` → 通过,匿名 `class {}` → `null`;`looksLikeInfrastructure('(ChatView)')` 实测 **false**(曾经有"括号名被它挡掉"的错说法,已加断言钉死) |
| 落盘审计属性进导出件 | `snapshot().context.store` | `restored` / `trimmedByBytes` / `deduped` / `captured` / `dropped` 五个键都在(静态断言核) |
| i18n 兜底与词典 | 真实页面 `html[lang]` + 两条断言 | 兜底**跟文档语言**(实测本机 `htmlLang / navLang` 都是 `zh-CN` → 中文);两本字典各 **239** 键、键集合一致、每个键都有人引用(死键会红) |
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

## 3. 还剩什么(2026-10-08 定 · 2026-10-11 复核)

这一节只列**还没做的**。已完成那 12 条(D1 / A1 / A2 / A4 / A5 / B1 / B2 / B3 / C2 / D2 / D3 / D5)的做法与理由
进了 [CHANGELOG.md](CHANGELOG.md) 的「未发布」段,判据与实测证据在本文 §2 —— 不在这里重复一遍。
本轮 UI 改版(P0 布局可读性 / P1 可追溯诊断交互 / P2 惰性渲染)同样:做法与理由在 CHANGELOG「未发布」段,证据在 §2。
再一轮(① 证据 → 代码定位 / ② 悬停联动调查与清理 / ③ 首屏精简 / ④ 性能与口径复核)也一样:做法与理由在 CHANGELOG「未发布」段,**实测证据在 §2**,还剩下的债在 §3.4。

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

### 3.2 三条尾巴(2026-10-08 新发现)

1. **A5 的客户端一侧还没接线(排到 0.4.0)**:宿主路由已经能采(真宿主实测 `profileStart(1s)` → `profileGet`
   = 292 节点 / 223 采样 / 82KB),但**客户端没有触发它的入口**,导出件里也没有宿主 profile。**声明已经改准**:
   事故包的 `missing` 现在写"宿主 CPU 火焰图**没有自动采** + 路由怎么打",不再说"拿不到"。剩下的是接线 ——
   客户端采一次并塞进导出件,排 **0.4.0**,因为它要在宿主侧**真的花 CPU 采一段时间**,得先定触发方式
   (挂「深录」还是单独一个动作)。
2. **事故包不带记录器自身的开销(排到 0.4.0,和上面那条一起做)**:整机导出件有 `context.recorder`
   (`selfStats()`:`p99` / 峰 / 样本数),**事故包没有** —— 这跟尾巴 1 是同一个性质(**整机有、事故包没有**),
   所以放在一起做,别分两次。**它正是 `missing` 里 `recorder-cost` 那句的来源**:在 `incidentReport()` 的
   `context` 里加一行 `recorder: selfStats()` 之后,那句 `missing` 就不再是缺失项,应当一并删掉
   (现在那句已经改成实话:"没带在这份事故包里")。
3. **`__perfHud.stress()` 的结果没人看得到(明确不做,等真有人用自测时再定)**:面板不再渲染"自测结果",
   `stressText()` 在 `client.js` 里已无调用点;更要紧的是 `stress()` **什么都不返回** —— 控制台点了自测,
   **没有任何可读结果**(`PerfHudStress` / `stress()` 本身按 D4 保留,它是归因链路的自测夹具)。真要动,应该连着
   "自测结果给谁看"一起定(把结果接回面板 = 小改;或连 `stressText()` 与它引用的那些 i18n 键、8 条断言一起删)。
   现在**明确不做**,免得只清字符串把这个缺口盖住。

### 3.3 定了不做的

**三处悬停联动已停用,而且辅助代码已删干净**(`hot` / `setHot` / `hotProps` / `hotStyle` 与各处的 `hot === …`、交叉表格子的 `lit` 加粗、环的 `stroke-width 17/13` 切换、图例随 hot 加粗都不在了):环 ↔ 按来源/按包条 ↔ 交叉表。2026-10-08 真实鼠标移到交叉表行标签上会让外壳把整个条目停用(面板消失),而同期 `errors` 为空、`window.onerror` 也不响、`__perfHud.enabled` 仍是 `true` → 不是渲染期抛错,而且**它不经过自带的 `HudBoundary`**(抛点更可能在 `PerfHud()` 的函数体里),连错误原文都拿不到;2026-10-11 复现尝试**复现不出来**(真实鼠标扫过交叉表内全部 **163** 个元素 + JS 派发 **153** 次 `mouseover`,面板全程存活、`errors: 0`、环数不变、控制台无输出),所以既不能证明根因也不能证明已修好 → 保持停用。渲染区里留了一条**可执行的复现说明**(遍历 DOM 顺序 + 装 console 钩子,**钩子必须在同一次 `reload` 之后装**,并去外壳日志里 grep `slot entry crashed`)。**点击类交互不受影响,已实测正常** —— 原因与证据见 §2「拆解视图」/「悬停联动:真实鼠标复现尝试」两行。有静态断言钉住这件事(渲染区不含 `onMouseEnter`/`onMouseLeave`;全仓不再有 `hotProps(` / `hotStyle(` / `setHot(`)。

| # | 条目 | 为什么不做 |
|---|---|---|
| A3 | 合成/光栅/GPU 的拆分 | 页面内没有 API,硬做会引入"看着在测 GPU、其实在猜"的假读数 —— 比不做更糟。保持声明 + 人工检查清单(`chrome://gpu`、Paint flashing、Frame Rendering Stats) |
| C1 | 桌面端主进程取证 | 需要 Desktop 环境才能验证,而本仓库的规矩是"不凭记忆写 API"。等有环境再排 |
| D1' | 把插桩做成独立开关(而不是并进模式) | 被 D1 取代:模式比多一个设置维度更贴文档承诺 |
| D4 | 删掉撤了入口的代码 | **全留**(控制台可达):`PerfHudStress` 是归因链路的自测夹具,`marks` 便宜,`isolation` 留着当备用。死字符串照清(C2 已做)—— 但 `PerfHudStress` 这条路的进一步改动**明确不做**:见 §3.2 尾巴 2(先定"自测结果给谁看") |

另有三条页面内**没有 API、不许虚构**的,同样明确不做(声明与人工检查清单已写进 [AGENTS.md](AGENTS.md) §7 /
[README.md](README.md) 的能力边界,不在这里重复理由):**帧内脚本时间轴**(LoAF 只给每条脚本的时长,不给它在帧内的
起止)、**源码行号跳转**(生产 React 无 `_debugSource`)、**完整调用树**(JS Self-Profiling 被 Document Policy 挡)、
**交互内部"输入延迟 / 处理 / 呈现"三段拆分**(GPU / 合成分段见 A3)。

### 3.4 还存在的债(2026-10-11 复核,如实记,不美化)

- **原始源码行号与调用栈仍然拿不到**:「可疑脚本」这一层只能缩小到"哪个包的哪个文件哪一段" —— 行号是**脚本文本自己的行号**(单包 URL = 那个文件;合并批 = 合并后的大文件),**不是原始源码行**。要原始源码行得解 section 内层 `mappings` 的 VLQ,或录 Chrome trace,两者本项目都没做。调用栈与函数级耗时同样拿不到(LoAF 只给 `invoker` 与 `sourceFunctionName`)。
- **函数名经常缺失**:LoAF 的 `sourceFunctionName` 在合并/压缩脚本里常常是空 —— 面板照实写「函数名未记录」(不是 bug,不补假名)。默认档(不插桩)也看不到文件与行号(合并批的包名本身就要精确归因,那块文案会如实写"要深录";「可疑脚本」在**一条能定位的都没有**时收敛成一行带分母的说明)。
- **悬停联动停用且辅助代码已删**:`hot` / `setHot` / `hotProps` / `hotStyle` 与各处 `hot === …` 都不在了。2026-10-08 会让外壳停用整个条目,2026-10-11 在当前代码上**复现不出来**(163 个元素真实鼠标 + 153 次 JS 派发 `mouseover` 全程存活),既不能证明根因也不能证明已修好 —— **恢复前必须先能复现**(复现配方在渲染区注释里,含去外壳日志 grep `slot entry crashed`),否则不要把它当可用特性写进任何文档。
- ~~**`pkgZeroText` 那段「0 条定到名(带分母)」永远不渲染**:它的分支条件与同屏「其余来源」那行互斥 —— 走到那一步时 `byOther` 一定非空,所以面板上看不到这段文案(函数与断言都还在,套件因此是绿的)。~~ → **已删**:确认**不可达**(外层要求 `window.js > 0`,而 `js > 0` 必然有脚本,脚本要么进 `top`、要么进 `byOther` 且 ms>0,两者互斥),死分支与 `pkgZeroText` 一起删掉;断言改成**实际渲染的那份数据**(喂给「按包」堆叠条的是 `whoRows(tally)`,一个包名都没定到时看到的是按原因命名的「其余来源」段,不是一行"0 条定到名"),并加静态断言「全仓不再有 `pkgZeroText`」。证据在 §2。
- **`tallyScripts` 算出的 `unresolvedMs` 没有运行时读者**:它被算出来并写进 tally,但面板与导出件都没有任何一处读它(只有单测顺手断言了它)。
- **`stressText` / `pkgWhoText` / `invokerWhoText` 三个函数零调用点**:界面撤下入口后它们只剩单测覆盖着 —— 单测仍绿,但这条路上任何回归都不会影响用户可见行为。
- ~~**事故的**自己那段窗口**没有在面板里重放**:`incident.frames` / `incident.loaf` 是事故切片里的一份独立数据(与面板那个 `frameRing` 不是同一份),面板只做**就近定位**(`frameNearestIncident` 把翻帧钉到事故窗口内最接近的那条 LoAF)。要看事故那 13 秒的逐帧序列,只有「导出事故包」+ `tools/inspect-incident.mjs` 这一条路 —— 面板里没有"事故回放视图",要做的话得先把切片与帧环的关系定义清楚(它们的 `t` 分属两条时间轴)。~~ → **已还**:新增**事故回放**(见 §2)—— 切片与实时帧环的关系已经定义清楚(两条时间轴,**刻意分开显示**:上面是实时的 60 秒帧条,回放块写明事故 id 与跨度),数据全部来自事故包,所以刷新生效、零新增采集。**仍然成立**的只剩:回放**不排帧内执行顺序**(LoAF 不给每帧内脚本的起止时间),要看**逐帧脚本明细**仍只有「导出事故包」+ `tools/inspect-incident.mjs` 这一条路。
- **帧条点击只到"秒"这一级**:一格约 6px,一格里可能有多条 LoAF;`sparkPickMap` 只能取格里 `dur` 最大的那条。要逐帧选只能靠 ◀ ▶ / ⟲。
- **第 5 个折叠组「包 × 来源 · 窗口」的摘要没有长度预算断言**:`crossSummary` 输出 `short(包) · short(来源) Nms`,名字与来源都可能很长(`dsh-client-ui-renderer · DOMWebSocket.onmessage 1234ms` = **53** 字符),在 396px 里会折行。组数从 4 变 5 时漏了这条预算;补的时候要用真实量级的名字(见 AGENTS §8 第 13 条)。

**时机**:实现批已全部落地(证据在 §2),不再等什么 —— 发布只剩 §3.1 那三件对外动作。
