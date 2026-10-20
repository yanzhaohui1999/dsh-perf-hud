# 贡献指南 · Contributing

感谢你愿意为 **dsh-perf-hud** 出力!报 bug、提功能、改文档、翻译都欢迎。本文说明怎样让贡献顺利合入。

English summary follows the Chinese text below.

---

## 开始之前

- 先读 [README.md](README.md) 了解面板能力与读数口径,再读 [AGENTS.md](AGENTS.md) —— 那里是**开发规则**(硬约束、门禁、提交规范、代码约定),本文不重复。
- 想知道"为什么这么设计、哪些路已经试过并证伪" → [AGENTS.md](AGENTS.md) §0.1(方向取舍)/ [docs/mechanisms.md](docs/mechanisms.md)(源码级机制)/ [docs/dead-ends.md](docs/dead-ends.md)(已证伪的死路);想知道发布门槛、未还的债与还差什么 → [REVIEW.md](REVIEW.md);想看历史决策与实测证据 → [docs/plans/](docs/plans/)(不是必读)。

## 报告 Bug

开 issue 时请尽量包含:

1. **环境**:dsh-perf-hud 版本、DSH 版本、Node 版本、操作系统与浏览器;
2. **场景**:填的是流式还是空闲(标题栏那个标签)、有没有点「精确归因」或「开始实验」;
3. **复现步骤**:从干净状态到出错的最小步骤;
4. **现象与期望**:实际看到什么、期望看到什么;
5. **证据**:**优先附「导出 JSON」**(它带 `context` 自描述头:场景、阈值、map 状态、插件版本)。面板渲染出错时,错误原文也在导出件的 `errors` 段里。

> 一个带导出件和复现步骤的 issue,通常当天就能定位。

## 提交功能 / 修复(PR)

1. **较大改动先开 issue 讨论**,确认方向再动手,避免返工。
2. 从最新 `main` 切主题分支(`feat/*` / `fix/*` / `docs/*` / `test/*` / `chore/*`)。
3. 本地自检通过(见下「提交前自检」)。
4. 提 PR,说明动机、改动点、怎么验证的;面板/排版类改动**请把 `node tools/check-panel.mjs` 的输出贴上来**(它真开一次页面 + 断言面板渲染 0 错误;维护者常常看不到渲染结果,这也是长度预算断言存在的原因)。

### 提交前自检(必过)

- **`npm test`** —— **638** 条(11 / 586 / 41)。三套件、三个沙箱与门禁细节见 [AGENTS.md](AGENTS.md) §3。
- 改了面板文案或读数口径:长度预算 / 单位一致性 / 静态检查由 `npm test` 一起跑,规则见 [AGENTS.md](AGENTS.md) §5(来历与逐项清单见 [docs/panel-rules.md](docs/panel-rules.md));**改断言前先确认不是在删证据**。
- 改到面板渲染 / `apply()` / `start()`:按 [docs/verification.md](docs/verification.md) 跑真页面验收器(`check-panel` 必跑,`check-incident` / `check-counts` 视改动)。它们**不是离线门禁**(要真浏览器 + 本机 `dsh web`),PR 里附输出即可。

### 硬规则不在这里重复

改 `client.js` 的锚点小批次、插桩还原、读数不造假、i18n 成对、宿主半安全线,都是 [AGENTS.md](AGENTS.md) §1 / §4 / §5 里的硬规则;最高频的坑(整段替换吞声明、模块作用域裸标识符、HMR 热载换实例)见 [docs/dead-ends.md](docs/dead-ends.md)。

## 代码风格

- 纯 ESM、无构建步骤、**零运行时依赖**(客户端只 `require('react')`,走浏览器模块表)。
- 面板视觉只用 theme token(`--dsw-alias-*`),不 require 任何 Harness Client 包。
- 注释解释**为什么**,并把"试过什么、怎么证伪的"写进去 —— 这是本项目最有价值的部分之一。
- 新增可单测的纯函数时,顺手加进 `tests/logic.mjs` 的 `pieces` 列表(它会把 `client.js` 里的**真函数**抽进沙箱,
  不是另写一份实现)。

## 文档与翻译

- 用户可见的行为变化必须同步 [README.md](README.md) 与 [README_EN.md](README_EN.md);开发规则变化同步 [AGENTS.md](AGENTS.md)。
- 断言数字(638 = 11 + 586 + 41)出现在 README / REVIEW / AGENTS / CONTRIBUTING 里,**改了要一起改**(CI 有一条门禁专门核这个)。
- 英文版可以只覆盖主路径,但**不要写与中文不一致的结论**。

## 行为准则

- 就事论事,针对代码不针对人;review 里说清"哪条断言/哪个读数因此失真"比说"这样不好"有用得多。

---

## Contributing (English summary)

Read [AGENTS.md](AGENTS.md) first — it holds the hard constraints, the test gates and the commit conventions.
This file covers the workflow.

- **Bug reports**: include DSH / Node / browser versions, the scenario (streaming vs idle), minimal steps, and —
  most usefully — the panel's **Export JSON**, which carries a self-describing `context` header and any panel
  render errors in its `errors` section.
- **PRs**: open an issue first for anything non-trivial; branch off the latest `main`; run the three offline suites
  (`node tests/{attribution,logic,host}.mjs`, 638 assertions) before pushing; for any panel, `apply()` or `start()`
  change also run `node tools/check-panel.mjs` (it opens a real page and asserts the panel renders with zero errors —
  these tools are **not** part of the offline gate) and paste its output instead of a screenshot.
- **Known traps**: edit `client.js` in small anchored batches (a whole-block replacement once swallowed neighbouring
  declarations and permanently disabled the panel entry); keep instrumentation reversible; never render a misleading
  rounded number (`0ms/s`) — say "not collected" instead; add both `zh` and `en` dictionary entries; the host half
  must not patch host prototypes or write bundle state without `confirm: true`.
- **Commits**: Conventional Commits, `<type>(<scope>): description`, scopes `client` / `host` / `attribution` /
  `panel` / `isolation` / `i18n` / `docs` / `tests`.
