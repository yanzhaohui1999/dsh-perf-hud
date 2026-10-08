# 贡献指南 · Contributing

感谢你愿意为 **dsh-perf-hud** 出力!报 bug、提功能、改文档、翻译都欢迎。本文说明怎样让贡献顺利合入。

English summary follows the Chinese text below.

---

## 开始之前

- 先读 [README.md](README.md) 了解面板能力与读数口径,再读 [AGENTS.md](AGENTS.md) —— 那里是**开发规则**(硬约束、门禁、提交规范、代码约定),本文不重复。
- 想知道"为什么这么设计、哪些路已经试过并证伪" → [AGENTS.md](AGENTS.md) §0.1(方向取舍)/ §6(源码级机制)/ §8(已证伪的死路);想知道发布门槛、验收证据与还差什么 → [REVIEW.md](REVIEW.md)。

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
4. 提 PR,说明动机、改动点、怎么验证的;面板/排版类改动**请附截图**(维护者常常看不到渲染结果,这也是长度预算断言存在的原因)。

### 提交前自检(必过)

```sh
node tests/attribution.mjs   # 11 条
node tests/logic.mjs         # 288 条(含静态检查与长度预算)
node tests/host.mjs          # 39 条
```

改了面板文案或读数口径时,**必须**确认 `tests/logic.mjs` 的这几类断言仍然绿:

- **长度预算**:概览两行 ≤36 / ≤60 字符,四个折叠组摘要 ≤30/30/34/24;
- **单位一致性**:同一张表里不许一处给 `/s`、另一处给累计;
- **静态检查**:`h(Uppercase…)` 引用的组件必须声明过、面板渲染区的裸函数调用必须声明过。

> 这三类断言是历史上真实事故的回归测试,不是形式主义。改断言前先确认你不是在删掉证据。

### 这个项目的几个「坑」(改动涉及对应区域时务必注意)

1. **改 `client.js` 用带锚点的小批次**,一次替换一个可唯一匹配的片段。整段替换曾两次吞掉相邻声明
   (`const signed` / `function PerfHudStress`),后果是 React 抛 `Element type is invalid`、外壳把整个条目
   **永久停用**(面板凭空消失,只能刷新)。
2. **插桩必须可还原**:包装 `setTimeout`/`setInterval`/`rAF` 与 `appendChild`/`insertBefore`/`setAttribute` 时,
   保存原生引用,并且只在"当前仍是我们那个 wrapper"时才还原。
3. **读数不许四舍五入成误导**:`0ms/s` 这类数字要显式写 `<0.1ms/s`;拿不到数据就写"未采集 / 不适用 /
   失败原因",**不要留空、不要假装成功**。
4. **i18n 成对改**:新增文案同时进 `DICT.zh` 与 `DICT.en`;实验进度与错误原因串也要进字典(见 [REVIEW.md](REVIEW.md) §2)。
5. **宿主半不许改宿主原型**,也不许在没有 `confirm: true` 的情况下写 bundle 状态(宿主套件有断言钉住)。
6. **提交信息**用 Conventional Commits,`<type>(<scope>): 描述`,scope 取 `client` / `host` / `attribution` /
   `panel` / `isolation` / `i18n` / `docs` / `tests`。正文里不要写"用户问…"这类对话转述。

## 代码风格

- 纯 ESM、无构建步骤、**零运行时依赖**(客户端只 `require('react')`,走浏览器模块表)。
- 面板视觉只用 theme token(`--dsw-alias-*`),不 require 任何 Harness Client 包。
- 注释解释**为什么**,并把"试过什么、怎么证伪的"写进去 —— 这是本项目最有价值的部分之一。
- 新增可单测的纯函数时,顺手加进 `tests/logic.mjs` 的 `pieces` 列表(它会把 `client.js` 里的**真函数**抽进沙箱,
  不是另写一份实现)。

## 文档与翻译

- 用户可见的行为变化必须同步 [README.md](README.md) 与 [README_EN.md](README_EN.md);开发规则变化同步 [AGENTS.md](AGENTS.md)。
- 断言数字(338 = 11 + 288 + 39)出现在 README / REVIEW / AGENTS / CONTRIBUTING 里,**改了要一起改**(CI 有一条门禁专门核这个)。
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
  (`node tests/{attribution,logic,host}.mjs`, 338 assertions) before pushing; attach a screenshot for any panel or
  layout change.
- **Known traps**: edit `client.js` in small anchored batches (a whole-block replacement once swallowed neighbouring
  declarations and permanently disabled the panel entry); keep instrumentation reversible; never render a misleading
  rounded number (`0ms/s`) — say "not collected" instead; add both `zh` and `en` dictionary entries; the host half
  must not patch host prototypes or write bundle state without `confirm: true`.
- **Commits**: Conventional Commits, `<type>(<scope>): description`, scopes `client` / `host` / `attribution` /
  `panel` / `isolation` / `i18n` / `docs` / `tests`.
