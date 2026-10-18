# 下一阶段实施计划:默认界面回答问题、证据可交付、AI 可消费

> 输入:`dsh-perf-hud-next-phase-product-plan.md`(产品计划)+ `dsh_perf_hud_ui_overview.png`(UI 概念图)。
> 本文件是**给代码 AI 的实施计划与文件清单**(产品计划 §8 要的那一份),不是新需求文档。
> 基线(写这份计划时):`main` @ 0.4.0,三套件 **497** 条全绿(attribution 11 / logic 447 / host 39),`DICT.zh` = `DICT.en` = 283 键。
>
> **归档(2026-10-18)**:本文是当时的实施计划,不是当前行为说明;计划已基本执行完,现行规则见 [AGENTS.md](../../AGENTS.md),当前状态见 [REVIEW.md](../../REVIEW.md)。

### 本轮进度(2026-10-12)

| 落地 | 提交 | 证据 |
|---|---|---|
| 导出脱敏(最优先:凭据不进导出件) | `fd0a23b` | 断言 497 → 514;真页面把 `token` / `api_key` 塞进真 `location` 后四个文件拼起来一个都不含 |
| P0.1 捕获频次独立于留存 | `1e1f1a8` | 断言 514 → 539;真页面现场 `检测到 3(triggered 3 · 切成现场 2 · 同串触发 29)· 已保存现场 2 · 丢失 1` |
| P0.2 能力矩阵 + P0.3 诊断包 | `c970042` | 断言 539 → **561**;真页面 `pack()` 四文件 / 五段摘要 / manifest 带能力矩阵 |
| 计划文档 | `b28cb54` | 本文件 |

**本轮做出来的口径**(已在代码、断言与文档三处一致):`检测到 = triggered`、`同串触发 = coalesced`(密度不是次数)、`已保存现场 = incidents.length`、`丢失 = (triggered − captured) + dropped + trimmed + failed`;`capabilities()` 是能力状态的唯一事实来源;`causeCandidates()` 是"可能原因"的唯一生成处。

| P0.4–P0.6 界面重构(方案 1) | `16dbae6` | 断言 561 → **574**;真页面:`check-incident` 走完 主界面 → 卡顿详情 → 刷新 → 返回 → 开发者详情 5 标签页 → 回到实时 → 设置 |

**下一轮(收尾)**:方案 1 已经落地(见上表):四个视图 + 开发者详情五标签页 + 设置,**现有能力一个都没删**。仍然留给下一轮的是:
- **导出对话**:现在导出入口在「原始数据」标签页(整机 JSON / 事故包 / 诊断包 + 预览),概念图里那种"两个卡片 + 导出前预览"的独立对话**没做** —— 它要一次下载多个文件,而自研 store-only zip 两个都要用,两件事一起做更划算;
- **P1**:~~自研 store-only zip(零依赖 + CRC32)~~ → **已落地**(`f92399e`,断言 591 → 603;`exportPack(id)` 现在一次下载一个 `-ai` / `-full` zip,预览给压缩包总大小)。~~黄金样本~~ → **已落地**(`tests/fixtures/incident-real.json`:真页面 capture → report → 脱敏切片 + 形状/完整性断言;当前总数 604)。仍然待做:可移植 Agent Skill(`skills/dsh-perf-diagnosis/`);
- **P2**:只读 MCP(等真实需求;`capabilities()` 与 `manifest.schemaVersion` 就是留给它的接口)。

---

## 0. 结论先说

产品计划里 8 项(P0 五项 + P1 四项)不是一回事,要先分清**哪些是"改界面"、哪些是"补数据"**:

| 产品计划条目 | 本质 | 现有基础 | 工作量 |
|---|---|---|---|
| ① 简化默认 UI,技术数据进"开发者详情" | 前端信息架构重排 | 现有 5 个折叠组 + 双上下文隔离 | **大**(纯前端,零采集改动) |
| ② 版本化诊断包 schema | 导出件重构 | `incidentReport()` schema 2 已存在 | 中 |
| ③ 真实捕获数 / 详细保留数 / 淘汰数分离 | **新增数据层** | `captured/coalesced/dropped/trimmed/deduped` **只在内存,刷新即归零** | 中 |
| ④ 导出预览 + 隐私脱敏 | 导出件重构 + **一处真缺陷** | 无 | 小~中 |
| ⑤ Desktop/Web 能力标注 | 能力矩阵 | `missing` / `howToAdd` 两个字符串数组是雏形 | 小 |
| P1 Skill / 摘要 / 样本 | 新交付物 | `tools/inspect-incident.mjs` 可复用 | 中 |
| P2 MCP | 新服务 | 无 | **本轮不做**(见 §6) |

**一句话路线**:先把「计数」和「能力/出处」这两件**数据**补齐(它们决定界面能不能说人话),再重排界面;`summary.md` + `manifest.json` + 脱敏是**纯函数**、离线可测、不依赖浏览器,所以先做、单独提交。

---

## 1. 现状矩阵(照产品计划 §8 要求先列)

### 1.1 采集与数据源(能用 / 不能用)

| 数据源 | 现状 | 出处 | 面板可见 | 导出件可见 |
|---|---|---|---|---|
| 帧环(12000 帧 ≈ 3.3 分钟) | 常开 | 自有 rAF 循环 | 帧条 / 帧数 | 否(只有每秒聚合) |
| LoAF(LoAF 观察器) | 常开(Chrome 123+) | `PerformanceObserver` | 「本帧 / 窗口」 | 是 |
| Long Task(四条腿归因) | 常开 | `PerformanceObserver` + 插桩 | 回调归因 Top3 | 是 |
| 调度点插桩(包名) | **深录才装** | 包 `setTimeout/setInterval/rAF` | 深录后 | 是 |
| DOM 写入者 | **深录才装** | 包 `appendChild/insertBefore/setAttribute`(1/10 采样) | 深录后 | 是 |
| 源映射分包名(合并批) | 深录 + 按需拉 12MB map | indexed sourcemap 分段表 | 「按包」 | 是(`pkg` / `file` 为推断) |
| 交互延迟(event timing) | 常开,只进导出件 | `PerformanceObserver({type:'event'})` | **否** | 是 |
| element timing | 恒 0(DSH DOM 无 `elementtiming`) | — | 否 | 是(照实记 0) |
| 宿主 event-loop p50/p99/max | 宿主半加载后 | 宿主路由 | 「宿主与链路」 | 是 |
| 宿主事件到达延迟 | 首次拿到宿主数据后请求装一次 | `ctx.on('session/event')` | 是 | 是 |
| 链路 RTT / 吞吐 | 常开 | `fetch` 自测 | 是 | 是 |
| 宿主 Node CPU Profile | 路由能采,**客户端没接线** | 宿主 `profileStart/profileGet` | 否 | 否 |
| 原始源码行号 / 调用栈 / 函数级耗时 | **拿不到** | — | 照实写缺失 | 是(写进 `missing`) |
| GPU / 合成 / Electron 主进程 | **不观测** | — | 否 | 是(写进 `missing`) |

### 1.2 计数与留存(产品计划 §3.A 的问题点,已核实)

`state.watch` 里有这些计数:**`captured` / `coalesced` / `dropped` / `trimmedByBytes` / `deduped` / `restored`** —— 六个都在,口径也是对的。**问题是它们只在内存**:

- `restoreIncidents()` 只读回 `incidents[]`,**六个计数一个都不读回** → 刷新后从 0 开始;
- 没有时间桶 → 回答不了"最近 1 小时几次""有没有变频繁";
- 面板折叠态那一行写的是 `${t('watchCaught')} ${state.watch.incidents.length}${t('times')}`(`client.js:6415`)—— **把"留存份数"当"抓到次数"显示**,正是产品计划点名要拆开的那个混淆。

### 1.3 导出件

- `snapshot()`(整机,`client.js:3203`)与 `incidentReport()`(单事故,schema 2,`client.js:3374`)都是**一次性 JSON 下载**,无摘要、无 manifest、无预览、无脱敏。
- `incidentReport()` 已有 `context.missing` / `howToAdd` / `howToRead`(各十几条),这是能力矩阵与"缺失原因"的**雏形**,但以自然语言句子形式散在代码里,不是结构化字段。
- **隐私缺陷(已核实)**:`snapshot().page` 与 `context.page` 都直接写 `location.href`;DSH 首屏是 `http://127.0.0.1:3080/?token=…` 进入的,`location.href` **可能带 token**。导出件还有两处**自由文本**:事故的 `note`(`captureNow(note)`)与 `timeline.marks[].note`(用户手输)。

### 1.4 UI 现状(`client.js:6318` `PerfHud()`)

- 折叠药丸(常显 fps / 最差帧 / LT / 抓到次数)+ 展开面板;
- 展开后顺序:概览两行(60 秒)→ 最差事件块(3 个按钮)→ 回调归因 Top3 → 布局工具行 → 5 个折叠组(`detail` / `dom` / `host` / `tools`,`cross` 嵌在 `detail` 里);
- 「取证明细」内部已实现**双上下文隔离**(`detailContext()` 一处分流:实时帧环 ⇄ 历史事故帧)、**240 列可点时间轴**、**四个方向翻帧**、按包/按来源堆叠条、交叉表、三档归因;
- 文案 283 键中英成对,4 组摘要长度预算已断言(第 5 组 `crossSummary` **无预算**,是已知债)。

**结论:「卡顿详情」这一屏(概念图第 2 块)≈ 已有组件的重新编排,不是新建能力。真正要新写的是"主界面"和"数据层"。**

### 1.5 硬约束(动手前必须记住的)

1. 单文件 6663 行的 `client.js`,**无构建步骤、零运行时依赖**;`index.js`(宿主半)改动必须重启宿主 → **本计划不动宿主半**。
2. `logic.mjs` 有**三个沙箱**(纯函数盒 / 导出盒 `newPieces` / 守夜盒 `watchBox`),各有 `pieces` 列表与桩;**新增函数要加进每一个用到它的盒子**,新状态位要补进守夜盒的手写 `state` 桩。
3. `DICT.zh` / `DICT.en` **成对改**;键集合一致 + 无死键 + 正文不许带 markdown 三条断言在跑。
4. 长度预算断言(概览两行 + 4 组摘要)**改文案必跑**。
5. **渲染区不许加 per-element 鼠标事件**(静态断言钉着)。
6. 宿主半不许改宿主原型;客户端插桩必须可还原。
7. 改 `client.js` 用**带锚点的小批次**,一次一个唯一片段(有两次"整段替换吞掉相邻声明"的事故)。
8. 断言总数写进 README / AGENTS / REVIEW + `ci.yml` + `release.yml`,改数字要同步。
9. 真页面验收器(`tools/check-*.mjs`)不是离线门禁,但**面板/apply 改动后必须跑**。
10. `files` 白名单发布:`skills/` 要进包就得加进 `package.json#files`。

---

## 2. 概念图里**不能照做**的三处(先对齐,免得白写)

| 概念图 | 冲突 | 处理 |
|---|---|---|
| 设置里「深度记录:异常时自动加深」 | 与产品计划 §7 P3「不要默认自动开启深录」+ 本项目「深录是唯一的插桩开关,必须显式开」直接冲突 | **默认关**。P2 之后做成显式 opt-in(带成本说明 + 状态可见),不进 P0 |
| 主界面「可能原因」直接给一个插件 | 产品计划 §2.1 验收 #3「任何可能原因都能展开看到支持证据与不确定性」 | 每张候选卡必须自带**支持 / 限制 / 出处三档**,并保留"尚未确认"档位;没有证据时不许指人 |
| 「8 份已保留现场」与「3 次检测到卡顿」并列 | 两者不是同一件事(留存 vs 发生) | 必须**分别标注口径**("检测到"/"已保存现场"/"因容量丢失"),这正是 §3.A 要补的数据 |

概念图里的**数值全部是示意**(产品计划已声明),实现时一律绑真数据。

---

## 3. 实施方案

### 设计决定(先定这几个,后面才有稳定的文件清单)

**DEC-1 视图模型**:`state.view: 'main' | 'incident' | 'dev' | 'settings'`,`dev` 再带 `state.devTab: 'frames' | 'scripts' | 'domhost' | 'link' | 'raw'`。落盘 `dsh-perf-hud:view:v1`(**只存视图名与标签页,不存数据**)。折叠药丸不变。理由:概念图第 2、3 块是**独立屏**("← 返回"),不是同屏折叠;而折叠组留给 `dev` 内部用(保留全部能力 = 产品计划验收 #6)。
**DEC-2 主界面只读四个纯函数**:`healthVerdict()`(正不正常)、`lastIncidentSummary(row)`(最近一次多久/何时/严重度)、`causeCandidates(row)`(≤3 条候选 + 线索强度 + 支持/限制/出处)、`trendSummary(window)`(1h/24h 次数 + 最长 + 重复线索)。**界面只排版,不推断** —— 与 `detailContext()` 同一条规矩。
**DEC-3 计数与留存分离**:新增 `LS_TALLY`(稀疏分钟桶,最近 24h)+ 每日汇总(最近 30 天);口径写死并断言:
 `检测到 = captured + coalesced`(同一串卡顿里被并掉的触发也是"检测到一次");`已保存现场 = incidents.length`;`丢失 = dropped + trimmedByBytes + persistFailed`。
**DEC-4 诊断包是数据,不是界面文案**:`buildPack(row)` 产出 `[{name, text}]`(纯函数),UI 只负责下载。`schemaVersion` 独立于面板文案 → 产品计划验收 #7 落地。
**DEC-5 脱敏在**打包时**做,不在采集时做**:采集保留原文(现场调试不受影响),包内 `manifest.redaction` 如实写"脱了什么"。
**DEC-6 先 JSON 后 ZIP**:P0 交付"摘要 + JSON(两个下载)";P1 加**自研 store-only ZIP 写入器**(TEXT + CRC32,约 70 行,不违反零依赖),一次点击给 `summary.md + incident.json + manifest.json + README.md`。

### 文件清单

**新增**
| 文件 | 内容 |
|---|---|
| `NEXT-PHASE-PLAN.md` | 本文件 |
| `skills/dsh-perf-diagnosis/SKILL.md` | Agent Skill:诊断工作流(SKILL 只写流程,不写实现细节) |
| `skills/dsh-perf-diagnosis/references/incident-schema.md` | 字段字典(schema v3),与 `buildPack` 输出**漂移断言**绑定 |
| `skills/dsh-perf-diagnosis/references/diagnosis-rules.md` | 测量/推断/未知的分界 + 报告固定形态 + 禁止事项 |
| `skills/dsh-perf-diagnosis/examples/*.json` | 7 个黄金样本(标注 `synthetic: true`,场景覆盖产品计划 §5) |
| `tools/check-redesign.mjs` | 真页面验收器:主界面 / 详情 / 开发者详情 / 设置 / 导出预览 |
| `docs/design/ui-concept-not-real-data.png` | 概念图存档(文件名自带"非真实数据"警示) |

**修改**
| 文件 | 改动 |
|---|---|
| `client.js` | 数据层(tally / capabilities / provenance)、纯函数(diagnosticSummary / manifestFor / buildPack / redact* / zipStore / causeCandidates / healthVerdict)、视图层(4 个视图)、设置与导出对话框、`location.href` 脱敏、折叠药丸计数口径 |
| `tests/logic.mjs` | 新函数的 `pieces` 列表 + 新断言(计数一致性 / 脱敏 / 出处三档 / schema 完整性 / zip CRC / 候选不得宣称根因)+ `crossSummary` 长度预算(还 §3.4 的债) |
| `tests/host.mjs` | 只在改了 `index.js` 时才需要 —— **本计划预期不动** |
| `README.md` / `README_EN.md` / `AGENTS.md` / `REVIEW.md` / `CHANGELOG.md` | 面板怎么读改版、断言数与词典键数、"还没做"清单(如实记 MCP 未做) |
| `.github/workflows/ci.yml` / `release.yml` | 断言总数门禁 + `Offline suites (…)` 标题数字 |
| `package.json` | `files` 加 `skills`(仅当要随包发布 Skill);版本号按提交性质走 |
| `cordis.patch.yml` | **不动**(只读) |

---

## 4. 提交计划(小步,每步可验证)

### P0 —— 产品与数据基础

| # | 提交 | 内容 | 验证 |
|---|---|---|---|
| P0.1 | `feat(client): 捕获计数独立于留存,配 24h 分钟桶` | `tallyBuckets` / `bumpTally` / `tallyWindow(ms)` / 落盘 `LS_TALLY`(稀疏桶 + 7~30 天汇总);`triggerCapture` / `settleCapture` / `saveIncidents` 里接线;折叠药丸改用 `tallyWindow()` 的真实次数 | `logic.mjs`:口径断言(检测到 = captured + coalesced;日汇总 = 当日分钟桶之和;越界不进桶;损坏 JSON 不炸)+ `tools/check-storage.mjs` |
| P0.2 | `feat(client): 能力矩阵与证据出处三档` | `capabilities()`(renderer / host / link / unobserved,每项 `{state, reason, provenance}`);`provenance(kind)`;`incidentReport().context.missing/howToAdd` 改为**由 capabilities 生成**(保持字符串兼容) | `logic.mjs`:能力矩阵在"深录关""宿主半没加载""LoAF 不支持"三种桩下给出正确 `state` + `reason`;`missing` 里不再出现空原因 |
| P0.3 | `feat(client): 诊断包(manifest + summary.md + 脱敏 + 预览)` | `manifestFor(row)` / `diagnosticSummary(row)` / `redactUrl` / `redactPath` / `redactUserAgent` / `packPreview(files)` / `buildPack(row)`;**`page` 改成脱敏后的 origin+path**;自由文本字段(`note` / `marks[].note`)进 `redaction.freeText` 并可在预览里排除 | `logic.mjs`:① 包内**不含** `token=`、真实用户名路径、`document.cookie`;② `manifest.schemaVersion` / 插件版本 / 平台 / 档位 / 范围齐全;③ 摘要含五段固定结构;④ 出处三档在摘要里可见;⑤ 缺证据时摘要写"证据不足"而**不**写"浏览器节流" |
| P0.4 | `feat(panel): 默认主界面先回答问题` | `healthVerdict()` / `lastIncidentSummary()` / `causeCandidates()` / `trendSummary()` + `view='main'` 渲染;空状态、监测受限、现场未保存三种状态各有独立文案 | `logic.mjs`:候选生成只吃真字段(`packages` / `topScripts` / `longTasks` / `worstFrameJs` / `suspectedThrottle` / host / link);`worstFrameJs==='none'` 时**不出**节流结论;无证据时给 unknown 档;长度预算 | 
| P0.5 | `feat(panel): 卡顿详情与开发者详情(标签页)` | `view='incident'`:`timelineBlock` + 候选卡 + 「这一帧发生了什么」+ 四向导航(复用);`view='dev'`:5 个标签页承载现有全部折叠组;`view='settings'`:记录模式 / 数据保留 / 隐私与脱敏;`view='export'`:两个选项 + 预览 | `node tools/check-redesign.mjs`(新)+ `tools/check-incident.mjs`(回归)+ `tools/check-panel.mjs` |
| P0.6 | `test/docs: 断言数、词典键数、验收器、文档同步` | 4 处数字同步;`README`「面板怎么读」按新界面重写;`REVIEW` 记下新债 | `npm test` 全绿 + CI 门禁数字对得上 |

### P1 —— AI 可消费

| # | 提交 | 内容 | 验证 |
|---|---|---|---|
| P1.1 | `feat(client): 一次点击导出诊断包(zip)` | `zipStore(files)`(store-only + CRC32,无依赖);导出对话框"生成并导出 ZIP" | `logic.mjs`:CRC32 对已知向量;zip 结构与 `unzip -t` 对齐(离线测字节结构);真页面下载一次 |
| P1.2 | `feat(skills): 可移植诊断 Skill` | `SKILL.md` + 两份 references + 复用 `tools/inspect-incident.mjs`(不复制解析器) | 新断言:schema 文档与 `buildPack`/`incidentReport` 输出的**键集合**一致(文档漂移守卫) |
| P1.3 | `test(skills): 黄金样本 + 分析质量清单` | 7 个场景样本 + `diagnosis-rules.md` 的"每次改 schema/摘要都拿样本过一遍"清单 | 断言:每个样本都能被 `inspect-incident.mjs` 解析;样本一律带 `synthetic` 或 `sanitized` 标记 |

### P2 / P3 —— 明确排后
只读 MCP、相似事故聚类、修复前后对比、自动建议采集档位:**本轮不做**。理由见 §6。P0.2 的 `capabilities()` + P0.3 的 `manifest.schemaVersion` 就是留给它们的**稳定数据接口**。

---

## 5. 验收(与产品计划 §2.1 的 8 条逐条对应)

| 产品计划验收 | 本计划的对应证据 |
|---|---|
| 1. 不懂 LoAF/p99/RTT 也能回答五问 | 主界面四块 + `tools/check-redesign.mjs` 断言这四块在场且文案不含技术术语黑名单 |
| 2. 默认不出现技术术语 / 包名排行 / 原始计数器 | 静态断言:主视图渲染区不引用 `pluginTable` / `crossTable` / `byOther`;文案键黑名单 |
| 3. 可能原因可展开看支持与不确定性 | `causeCandidates()` 每条自带 `basis` / `limits` / `provenance`,断言非空 |
| 4. 切历史事故后详情区全用该事故数据 | 现有 `detailContext()` 隔离断言**保持绿** + 新视图复用同一分流 |
| 5. 时间轴空白=真实缺口、点击选中真实帧 | 现有断言保持绿(`replayColumns` 不合成帧) |
| 6. 开发者功能不丢 | `dev` 五个标签页逐一断言存在;`npm test` 497 → 更多,不减少 |
| 7. 导出件不依赖 UI 文案、不含未授权敏感数据 | `buildPack` 纯函数 + 脱敏断言 + 无 token 断言 |
| 8. 不可用 / 证据不足 / 保存失败都照实说 | `capabilities()` 三态 + 空状态文案断言 + "丢失 = dropped + trimmed + persistFailed" |

**每次改完必跑**:`npm test` →(面板/apply 改动)`node tools/check-panel.mjs` →(事故回放改动)`node tools/check-incident.mjs` →(新增 LS 键)`node tools/check-storage.mjs`。
**不能跑的**:受控实测期间不要同时改 `client.js`(HMR 会换实例,实验结果作废)。

---

## 6. 风险、代价与"不做"

**风险**
1. **单文件 6663 行 + 4 视图重排 = 最大的回归面**。缓解:P0.4/P0.5 只做"重排 + 新增视图",**不改任何采集口径**;折叠组函数原样搬进 `dev` 标签页;渲染区保存静态检查(未声明引用)在跑。
2. **`logic.mjs` 三沙箱漏加函数**是已知事故模式(漏一个不会立刻报错)。缓解:每加一个纯函数,**三个盒子的 `pieces` 逐个过一遍** + 守夜盒 `state` 桩补新状态位。
3. **计数口径是"检测到"不是"卡顿次数"**。同一串卡顿会被 `coalesced` 并成一次 —— 文案必须写"检测到 N 次(同一串卡顿算一次)",否则又是一次新的误导。断言钉住 `检测到 = captured + coalesced`。
4. **24h 分钟桶的 localStorage 体积**:用稀疏对象(只存非零桶),空转时近乎 0 字节;断言"空闲 1 小时后写入 < 2KB"。
5. **ZIP 自研**:只做 store(不压缩),不碰 deflate —— 省掉一整类兼容性问题;P0 不依赖它。
6. **脱敏是"减法"不是"保证"**:包内必须写明"脱敏只做了 X/Y/Z",不许写成"已匿名化"。`manifest.redaction.redacted[]` / `kept[]` 两个数组如实给。

**不做**
- 不做 MCP(P2):真实需求未出现,而且它要求一个常驻服务 + 权限模型;先把 `schemaVersion` / `capabilities` 定稳。
- 不做内置 AI 聊天。
- 不采 GPU / 合成 / Electron 主进程 / 原始源码行号 —— 只在 `capabilities().unobserved` 里如实标注。
- 不把宿主 Node CPU Profile 说成 Electron 主进程 Profile;客户端接线 `profileStart/profileGet` 放 P2(它要动宿主半 = 要重启,排在报告之后)。
- 不做"异常时自动加深"(概念图那一格):默认关,只留显式开关。
- 不新增 per-element 鼠标事件、不新增依赖、不改 `cordis.patch.yml`。

---

## 7. 需要先定的四件事(会影响文件清单与提交顺序)

1. **P0 一次做完,还是先做 P0.1~P0.3(数据层,界面不动)?** 数据层单独交付就能让导出件立刻可用(P1 的 Skill 依赖它),而且**零界面风险**。
2. ~~**`crossSummary` 没有长度预算**(REVIEW §3.4 的债)—— 顺路还掉,还是单开一个 `test` 提交?~~ → **已还**(`clipName()` 截到 14 / 15 字符 + 真实量级名字的预算断言,见 CHANGELOG「未发布 · 修复」)。
3. ~~**`replaySplitText` / `stressText` / `pkgWhoText` / `invokerWhoText` 四个零调用点函数**(REVIEW §3.4)—— 这轮重排会决定它们是"找到回落点"还是"连断言一起删"。~~ → **已还**:连同另外六个零调用点函数一起删了(函数 + `extract` / `pieces` / 断言 + 只被它们引用的 13 个词典键);`node tools/dead-code.mjs` 现在 0 个候选。
4. **Skill 的落点**:只放仓库 `skills/`(随包发布),还是同时在 `~/.dsh/skills/` 装一份(要写进 README,不能偷偷装)?
