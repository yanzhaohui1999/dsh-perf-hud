# 1.0.0 发布验收(2026-11-08)

> **是什么**:1.0.0 **发布门**(见 [milestone](2026-11-07-v1-milestone.md) §4)在本机的实际执行记录 ——
> 每条命令与关键输出照抄,不是"我觉得通过了"。前置验收(1.0 交付本身)在
> [2026-11-07-v1-acceptance.md](2026-11-07-v1-acceptance.md);当前门槛与未还的债看 [REVIEW.md](../../REVIEW.md)。
> ⚠️ 本文件是**历史记录**:记的是"这一天、这个 DSH 版本、这台机器"的结果。

## 0. 环境

| 项 | 值 |
|---|---|
| 机器 | Mac mini(Apple Silicon,arm64) |
| Node | v26.12.0 |
| DSH | **0.2.1-rc.3**(`dsh web` 在 `127.0.0.1:3080`) |
| 浏览器 | `/Applications/Google Chrome.app`(headless,`--no-sandbox`) |
| 插件版本 | **1.0.0**(`package.json`,本地 tag `v1.0.0`) |

## 1. 发布门前置检查

| 检查 | 命令 | 结果 |
|---|---|---|
| 兼容矩阵每个版本都有验收记录 | `npm run pack:check` | ✅ `兼容矩阵:2 个版本,都在 engines.dsh 内且有验收记录(0.2.1-rc.1 / 0.2.1-rc.3)` |
| 文档键清单 == `manifestFor()` 实际输出 | `npm test`(logic「契约冻结」4 条) | ✅ 双向一致;16 个块的 `required ∪ optional` == 样本并集 |
| CHANGELOG 无"破坏性变更" | 人工 + `grep 破坏性 CHANGELOG.md` | ✅ 1.0.0 段写明**破坏性变更:无**;两处"看起来像"的改动逐条说明(`manifest.dshVersion` 恒 `null`、状态四片是内部结构) |

## 2. 离线门禁

```
763 条断言:attribution 11 / logic 685 / host 41 / compat 17 / replay 9
+ tools/render-smoke.mjs(离线渲染冒烟,六屏 + 关闭态)
+ tools/gen-prefix-table.mjs --check(§2.6 前缀表与 capabilityMissing() 一致)
```

`npm run docs:check`(0 断链 0 孤儿)、`npm run pack:check`、`npm run prefix:check` 同时全绿。

## 3. 真 0.9.0 导出包(发布门第 3 条)

**做法**(不是手写):

```sh
mkdir /tmp/hud-090 && cd /tmp/hud-090
npm_config_cache=/tmp/hud-090/.npm-cache npm pack dsh-perf-hud@0.9.0   # → dsh-perf-hud-0.9.0.tgz
tar xzf dsh-perf-hud-0.9.0.tgz
# 用包里的 client.model.js 原样 createModel(),喂真事故行 tests/fixtures/incident-real.json,
# 调它的 buildPack('i3') 生成四份文件 → tests/fixtures/pack-0.9.0/
```

- 生成的 manifest:`schemaVersion 2` / `pluginVersion 0.9.0` / `complete true` / `files` 四份 / 能力矩阵 12 叶子 + 5 unobserved;
  incident:`schema 3` / `id i3` / `p99 137.1` / `74 帧`。
- `tests/compat.mjs` 12 → **17 条**:真包喂当前读方(摘要 / 能力矩阵 / 缺失声明)、真发货的
  `tools/inspect-incident.mjs` 退出 0、删必需键 `capabilities` 必红、`dshVersion`(0.9.0 里还在,恒 `null`)被当未知键忽略。

## 4. 真页面验收器(本机 `dsh web`,逐个跑)

| 验收器 | 结果 |
|---|---|
| `node tools/check-panel.mjs` | **ALL PASS(真页面)**(393px 视口 369px / 面板 396 / 拖动与刷新恢复) |
| `node tools/check-incident.mjs` | **ALL PASS(真页面 · 历史事故逐帧回放)** |
| `node tools/check-counts.mjs` | **ALL PASS(真页面)**(真 ZIP ai 63,620B / full 63,976B,`unzip -t` 通过) |
| `node tools/check-storage.mjs` | **ALL PASS(真页面)**(写 → 刷新 → 读回同一个值) |
| `node tools/check-interaction.mjs` | **ALL PASS(真页面)**(真实输入;click 端到端 168ms = 8.8ms 输入延迟 + 160.1ms 处理器) |
| `node tools/check-timeline.mjs` | **PASS**(夹具对齐 0 帧;真事故重定位宿主占比 64.9%;两段原始序列 530 / 15 条) |

> ⚠️ 第一轮 `check-counts` 在连续跑验收器时碰到一次 `processTimers` 超时(CDP 等待),**同一命令立刻重跑即 ALL PASS**;
> 其余五个一次通过。真页面验收器不进 CI(要真浏览器 + 本机 `dsh web`),这是已知取舍。

## 5. 包内容

`npm pack --dry-run`: **38 个文件 / 433,893 B tarball / 1,179,648 B unpacked**;
含 `tools/` 18 个、`locale/`、`skills/`;**`tests/` 与 `fixtures/` 不进包**(`tools/make-timeline-fixture.mjs` 是夹具生成器,不是夹具数据)。

## 6. 版本与本地 tag

- `package.json#version` = **1.0.0**;CHANGELOG 的 `[Unreleased]` 收成 `## [1.0.0] - 2026-11-08`。
- 本地提交与 tag:`git tag -a v1.0.0 -m "1.0.0: 导出包契约冻结"`(提交号见 `git tag -n v1.0.0`)。
- **已发布(2026-11-08)**:push `main` + tag → GitHub Release → `release.yml`(OIDC)自动 publish;registry 上 `latest = 1.0.0`、`fileCount 38`、`dist.attestations` 是 SLSA provenance。Release:<https://github.com/yanzhaohui1999/dsh-perf-hud/releases/tag/v1.0.0>。

## 7. 未结项(如实写)

- **A4 timeline 的"真实卡顿双端现场采集"仍未做**(REVIEW §2 第 11 条):现有的是 fixture 重定位证据,不是同一次现场采集。
- `shots.mjs` 未重出截图(UI 自 0.9.0 起只动了一处「?」按钮按需出现,README 图仍是 0.9.0 那批)。
- 跨机器时钟偏差未校正(timeline 只承诺同机 ≤1 帧)。

## 8. 复核命令(照抄就能重跑)

```sh
npm test                                   # 763 条 + 渲染冒烟
npm run docs:check && npm run pack:check
npm run prefix:check
node tools/check-panel.mjs                 # 五个真页面验收器要本机 dsh web 在跑
node tools/check-incident.mjs
node tools/check-counts.mjs
node tools/check-storage.mjs
node tools/check-interaction.mjs
node tools/check-timeline.mjs              # 离线:夹具对齐 + 真事故重定位
npm pack --dry-run                          # 38 个文件,fixtures 不进包
```
