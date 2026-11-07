# 1.0 验收档案(2026-11-07)

> **是什么**:1.0 milestone 的**机器可复核**验收记录 —— 每条都是在本机 `dsh web` 上真跑出来的,
> 命令与关键输出照抄。不是"我觉得通过了"。计划见 [1.0 里程碑](2026-11-07-v1-milestone.md),
> 当前门槛与未还的债见 [REVIEW.md](../../REVIEW.md)。
> ⚠️ 本文件是**历史记录**:它记的是"这一天、这个 DSH 版本、这台机器上"的结果,不要当口径。

## 0. 环境

| 项 | 值 |
|---|---|
| 机器 | Mac mini(Apple Silicon,arm64) |
| Node | v26.12.0 |
| DSH | **0.2.1-rc.3** |
| 浏览器 | `/Applications/Google Chrome.app`(headless,`--no-sandbox`) |
| 系统 | macOS,`TZ=Asia/Shanghai` |

## 1. 离线门禁(`npm test`)

```
740 条断言:attribution 11 / logic 676 / host 41 / compat 12
(初稿 735;S0/S1 收口补丁 +3 条后为 740)
+ tools/render-smoke.mjs(离线渲染冒烟,9 屏)
+ tools/gen-prefix-table.mjs --check(§2.6 前缀表与 capabilityMissing() 一致)
```

结论:**全绿**。`npm run docs:check`(0 断链 0 孤儿)与 `npm run pack:check`(12 份必带文件 + 3 个目录)同时全绿。

## 2. 真页面验收器(本机 `dsh web`,逐个跑)

| 验收器 | 结果 | 现场读数 |
|---|---|---|
| `node tools/check-panel.mjs` | **ALL PASS(真页面)** | 展开宽度 396 / 头部不被滚走 / 审批卡让位 / 拖动与刷新后位置恢复 / 393px 视口 369px |
| `node tools/check-incident.mjs` | **ALL PASS(真页面 · 历史事故逐帧回放)** | 自动抓 i1(i2 在刷新后)→ 历史帧 59/112 可逐帧 / 「只看异常」/ 刷新后仍停在同一条事故同一帧 |
| `node tools/check-counts.mjs` | **ALL PASS(真页面)** | 检测到 3 / 切成现场 2 / 已保存 2 / 丢失 1;真 ZIP `unzip -t` 通过(ai 143,265B / full 143,619B) |
| `node tools/check-storage.mjs` | **ALL PASS(真页面)** | 落盘 → 刷新 → 读回同一个值(阶段 1 写入 / 阶段 2 读回) |
| `node tools/check-interaction.mjs` | **ALL PASS(真页面)** | 真实输入 21 条事件;`keyup` 端到端 128ms = 输入延迟 0.4ms + 处理器 0ms |

> 交付全部落地后(HEAD `f2bcee2`)又把五个验收器复跑了一轮:**同样五个 ALL PASS**(读数随机波动属正常,例如那一轮 `check-counts` 是「检测到 2 / 切成现场 2」、真 ZIP ai 91,971B —— 与上表那次不是同一份现场)。

> ⚠️ 真页面验收器**不进 CI**(要真浏览器 + 本机 `dsh web`),这是已知取舍,见 [milestone](2026-11-07-v1-milestone.md) §5 之外的说明与 [环境与验证](../verification.md)。

## 3. 契约冻结与向后兼容

| 项 | 命令 | 结果 |
|---|---|---|
| 产方:导出键集合 == 文档清单 | `node tests/logic.mjs`(「契约冻结:…」3 条) | 绿:`manifestFor()` 双向下标一致;四份文件顺序 == `manifest.files` == 文档;三个版本号 == 清单 |
| 读方:上一版包仍可读 | `node tests/compat.mjs` | 绿:manifest v1 / incident v2 的包仍读出摘要(帧数 / p99 / 最差帧)与能力矩阵(12 叶子 + 5 条 unobserved);`inspect-incident.mjs` 退出 0 |
| 缺必需键必须拒收 | 同上(反例用例) | 绿:删 `capabilities` → `缺必需键:manifest.json.capabilities`;删 `incident` → CLI 退出 1 |
| 状态四片边界 | `node tests/logic.mjs`(「状态四片:…」4 条) | 绿:仅 ui/watch/host/render;字段数 23/53/37/15;引用全部命中「片.字段」;分片白名单无越界 |

## 4. 每个 DSH 版本上的记录(兼容矩阵的来源)

`package.json#dsh.compatibility.dshReleases` 只列**这里出现过**的版本 —— 没有记录的版本不进矩阵。

<!-- verified:dsh=0.2.1-rc.3 -->
<!-- verified:dsh=0.2.1-rc.1 -->

> 上面两行是**机器可读标记**：`tools/check-pack.mjs` 只认 `<!-- verified:dsh=<版本> -->` 这一种，
> 所以"这篇里被提到"不等于"有验收记录" —— §4 表里那条 `0.2.0-rc.2` 写着"没有记录"，
> 不会被当成通过。加一个版本的验收记录 = 在上面补一行标记 + 在 §4 表里补一行人读的说明。

| DSH 版本 | 什么时候 | 五个验收器 | 备注 |
|---|---|---|---|
| `0.2.1-rc.3` | 2026-11-07(本文件 §2) | 五个全绿 | 1.0 / S0–S5 落地后的最终一轮 |
| `0.2.1-rc.1` | 2026-10-19 ~ 2026-11-04 | 五个全绿 | 见 [REVIEW.md](../../REVIEW.md) §1 第 8 条与 [十月验收档案](2026-10-11-acceptance-evidence.md) |
| `0.2.0-rc.2` | — | **没有记录** | 从 `dshReleases` 里移除(1.0 起"声明即已验证");`engines.dsh` 仍覆盖 `>=0.2.0-rc.2 <0.3.0-0` |

## 5. 这一轮**没有**做的事(如实写)

- **没有在新的 DSH 版本上重跑 `shots.mjs` 重出截图**:这一轮 UI 只动了一处(主界面「?」按钮按需出现),
  README 的九张图仍是 0.9.0 那批;要重出就 `node tools/shots.mjs`。
- **没有发版**:1.0 的 tag / Release / npm publish 都没做([发布门](2026-11-07-v1-milestone.md) §4 的 4 号)。
- **只读 MCP 不在 1.0**(推迟到 1.1),这次没动任何 MCP 相关代码。

## 6. 复核命令(照抄就能重跑)

```sh
npm test                                   # 740 条 + 渲染冒烟
npm run docs:check && npm run pack:check   # 文档门禁 / 发货清单
npm run prefix:check                       # §2.6 前缀表无漂移
node tools/check-panel.mjs                 # 下面五个都要本机 dsh web 在跑
node tools/check-incident.mjs
node tools/check-counts.mjs
node tools/check-storage.mjs
node tools/check-interaction.mjs
```
