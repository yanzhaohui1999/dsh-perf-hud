# docs/ · 文档入口

> 给人看的入口:每份文档一句话职责 + 什么时候读。**给 agent 的规则**在根 [AGENTS.md](../AGENTS.md) §9,那里只留"改代码前必读哪几份";完整地图在本页。
> 新增 / 移动 / 改名任何文档:**先改本页**,再跑 `npm run docs:check` —— 没人链接的文档会报错。

## 按场景找

| 你在做什么 | 读这篇 |
|---|---|
| 改面板读数口径 / 渲染 | [reading-panel.md](reading-panel.md) · [panel-rules.md](panel-rules.md) |
| 改归因链路(URL / sourcemap / 四条腿) | [mechanisms.md](mechanisms.md) |
| 改代码前准备环境、改完验证 | [verification.md](verification.md) |
| 发版、staged publishing | [release.md](release.md) |
| 动手之前查"是不是踩过的坑" | [dead-ends.md](dead-ends.md) |
| 对外说法、跟官方开发者工具比 | [landscape.md](landscape.md) |

## 根目录的活文档

| 文件 | 管什么 |
|---|---|
| [README.md](../README.md) | 用户视角:装什么、怎么装、读数怎么看、有什么风险 |
| [README_EN.md](../README_EN.md) | 英文版(摘要式,结论与中文版一致) |
| [AGENTS.md](../AGENTS.md) | 开发规则、边界、代码约定、测试门禁、提交规范 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 贡献流程:报 bug、提 PR、提交前自检 |
| [REVIEW.md](../REVIEW.md) | 发布:对外门槛、未还的债、当前边界 |
| [CHANGELOG.md](../CHANGELOG.md) | 版本变更 |

## 参考(按需查,不通读)

| 文件 | 管什么 | 什么时候读 |
|---|---|---|
| [reading-panel.md](reading-panel.md) | 面板读数口径 | 改读数 / 渲染前 |
| [panel-rules.md](panel-rules.md) | 布局 / 文案 / 交互约定 | 改渲染 / 文案前 |
| [verification.md](verification.md) | cookie、验收器、401/404、残留 Chrome、worktree 验证 | 改代码前后 |
| [mechanisms.md](mechanisms.md) | 归因机制:URL / sourcemap / 四条腿 / 宿主 API | 改归因链路前 |
| [dead-ends.md](dead-ends.md) | 19 条已知坑与已证伪的死路 | 动手前 |
| [release.md](release.md) | npm 发版、staged publishing、Trusted Publisher | 发版前 |
| [landscape.md](landscape.md) | 官方开发者工具对照、竞品、市场数据 | 定方向 / 对外说法前 |

## 历史档案

| 文件 | 是什么 |
|---|---|
| [plans/README.md](plans/README.md) | 按日期归档的决策与实测证据(**只增不改,不是当前行为说明,不必读**) |
| [plans/2026-10-11-acceptance-evidence.md](plans/2026-10-11-acceptance-evidence.md) | 2026-10-07 ~ 10-18 阶段决策 + 67 条实测证据 |
| [plans/2026-10-12-next-phase-plan.md](plans/2026-10-12-next-phase-plan.md) | 0.4.0 时代的产品计划(已基本执行完) |
| [plans/2026-10-13-code-review.md](plans/2026-10-13-code-review.md) | 2026-10-13 代码审计:12 条建议,10 条已落地 |

---

## 文档类型与生命周期

- **承重**:被代码注释、测试或别的文档按路径引用 —— 改了必须同步,**路径不许动**。
- **参考**:解释"为什么这么定"的口径与依据 —— 平时不读,改之前读;事实变了要同步。
- **计划**:尚未落地的下一步 —— 落地后结论并入规格或归档,不留两份并行的同一件事。
- **历史**:已归档的决策与实测证据 —— 只记"当时是什么",不照它执行。
- **入口**:`README.md` 与 `AGENTS.md` 各一份,一个给人、一个给 agent —— 两份都不复述地图,只指路。

## 维护本页

1. 新增文档:先在本页登记,再 `npm run docs:check`。
2. 移动 / 改名:改引用 → 跑 `npm run docs:check`(断链会报错)。
3. 提交时钩子自动跑同一检查(`tools/git-pre-commit.sh`),红了就改,别 `--no-verify`。
   新 clone 装一次:`printf 'exec "$(git rev-parse --show-toplevel)/tools/git-pre-commit.sh"\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`
4. 归档判据:文中明确写了"已完成 / 已实现 / 结论已定"才进 `plans/`;拿不准的留在原位并标状态。
