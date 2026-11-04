# 2026-11-05 0.9.0 发版复核

> 复核对象:`v0.9.0`,tag 与 commit 都是 `1b53d20`(2026-11-04 23:53 本地建 tag / 建 Release)。
> 每条结论后面标了证据来源;§1 里有一条 `⚠️` 是数据源自相矛盾,不是猜测。
> 复核用 npm:`/Users/y/tools/node-v24.19.0-darwin-arm64/bin/npm`(11.17.0 / Node 24.19.0,即
> [npm 发版](../release.md) §5 指定的那一套)。

## 1. 两条 workflow 的结果

### 1.1 Release:**已成功发布**(但 GitHub 的状态说它在排队)

| 判据 | 值 |
|---|---|
| run | `41862375471`,`event=release`,`head=v0.9.0` / `1b53d20` |
| REST API 报的状态 | `queued`,`run_attempt=1`,`run_started_at = created_at = 15:53:42Z` |
| npm 上 0.9.0 的发布时刻 | `2026-11-04T15:55:43Z`(run 创建后 **2 分钟**) |
| 谁发的 | provenance 的 `invocationId` = `…/actions/runs/41862375471/attempts/1` |
| 打包环境 | `_npmVersion` 12.2.1 / `_nodeVersion` 24.22.2(`npm install -g npm@latest` 的结果) |
| 产物 | `dist.fileCount` 32、`unpackedSize` 1,114,261 |

**失败的 step:没有。**

⚠️ **两边矛盾,以 npm 为准。** GitHub 侧现在正处于故障:官方 incident
「Incident with Actions and Pages」于 `2026-11-04T16:05:31Z` 起 `investigating`,
`Actions` / `Pages` 均为 `degraded_performance`(见 [状态页](https://www.githubstatus.com/) 与
[incident](https://stspg.io/pjgptg3cfc6n))。故障期间 run 状态的写入不可信 —— 能证伪"没发出去"的
全在 npm 一侧:发布时间、`gitHead = 1b53d20`、provenance 的 `invocationId` 指向本 run、
tarball 与我从 `1b53d20` 干净 worktree 打出的**字节完全相同**(见 §2)。
所以结论取**已发布**;那个 `queued` 是平台侧记录问题,不是还有活没干。

**等平台恢复后再复核一次**(`gh run list`)。若那时它仍停在 `queued`,**rerun 一次即可**:
它会走 [`Check whether this version is already on the registry`](../../.github/workflows/release.yml#L96)
→ 查到 0.9.0 已存在 → 跳过 `Publish` 并写 notice。**不会重复发布、也不会因为"already exists"变红。**
连续重试没有意义(平台恢复前点几次都是排队)。

### 1.2 CI:状态也取不到,但内容可离线复核为绿

| run | 触发 | 结论来源 |
|---|---|---|
| `41862347550` | push / `1b53d20` | API 停在 `queued`,拿不到结论 |
| `41862263854` | push / `d9ef25b` | 同上 |

`gh` 轮询 12 分钟(00:00 → 00:11)三条 run 一直是 `queued` —— 与 §1.1 同一个平台侧故障。
可复核的是**它跑的那几件事**在本机逐项通过:

| CI 的那一步 | 本机复核 | 结果 |
|---|---|---|
| `node tests/*.mjs`(`ci.yml:43`) | `npm test` | 714/714(11 + 662 + 41) |
| 断言总数门禁(`ci.yml:60`) | `test "$total" -eq 714` | 通过 |
| 五份文档含 `714`(`ci.yml:64`) | README / README_EN / REVIEW / AGENTS / CONTRIBUTING | 五份都在 |
| `node --check`(`ci.yml:35`) | 用 pin 的 Node **24.19.0** 跑 `index.js`、`client.js`、`tools/*.mjs` | 全通过 |

另一条间接证据:Release 那个 run 在 publish 之前跑的正是同一组离线套件
([`Offline suites`](../../.github/workflows/release.yml#L57)),它走通了 —— 所以 tag 上的三套件是绿的。

> 早上要做的事:等平台恢复后 `gh run list` 看一眼。registry 上 0.9.0 已经在(发布时间
> `15:55:43Z`),所以这两条 run 的 `queued` **不影响任何人装到 0.9.0**;要补一份绿记录就
> 各 rerun 一次,不补也不欠什么。**不需要改任何代码。**

### 1.3 上一次发版的失败长什么样(用来判断下一版)

`v0.8.0` 的第一次 Release(`40161119762`)红在 `Offline suites (655 assertions)`,根因是
**测试沙箱漏搬函数**,不是发布机制:

```
<anonymous_script>:2718
  if (ev === null || ev === undefined || !((ev.count ?? 1) > 1)) return withShellSource(ev, evidenceLine(ev));
                                                                  ^
ReferenceError: withShellSource is not defined
    at evidenceGroupLine (eval at <anonymous> (.../tests/logic.mjs:777:13))
    at incidentEvidenceLines → incidentSummaryText → tests/logic.mjs:1438
##[error]Process completed with exit code 1.
```

修法是补沙箱(commit `test: 沙箱补 withShellSource 与空命中表`),重跑后同一 tag 于 04:20:15 发成功。
`--log-failed` 只吐出 `Offline suites` 这一个 step,共 228 行 —— 即**唯一红的一步**。

## 2. npm 包内容核对

打法是两边对照:**本地**在 `1b53d20` 的干净 detached worktree 里 `npm pack`,
**线上**从 registry 下载 `dsh-perf-hud-0.9.0.tgz`。

```sh
# 沙箱里 npm 默认缓存目录不可写(EPERM ~/.npm/_cacache),把缓存挪进仓库即可
npm_config_cache="$PWD/.tmp/npm-cache" /Users/y/tools/node-v24.19.0-darwin-arm64/bin/npm pack --dry-run
```

| 项 | 在不在 | 证据(大小 = 本地 pack,亦即线上 tarball) |
|---|---|---|
| `index.js` | ✅ | 17.3 kB |
| `client.js` | ✅ | 214.3 kB |
| `client.*.js` 分片(6 个) | ✅ | i18n 72.7 / model 218.6 / ui 98.3 / watch 38.2 / tools 10.0 / pack 5.4 kB |
| `cordis.patch.yml` | ✅ | 655 B |
| `icon.svg` | ✅ | 461 B |
| `locale/en.json` | ✅ | 265 B |
| `LICENSE` | ✅ | 1.1 kB |
| `README.md` | ✅ | 63.5 kB |
| `README_EN.md` | ✅ | 45.3 kB |
| `CONTRIBUTING.md` | ✅ | 5.6 kB |
| `REVIEW.md` | ✅ | 6.4 kB |
| `CHANGELOG.md` | ✅ | 131.1 kB |
| `AGENTS.md` | ✅ | 24.5 kB |
| `package.json` | ✅ | 3.1 kB(npm 必带,与 `files` 无关) |
| `tools/` | ✅ | 12 个文件(0.9.0 时点) |
| **`skills/`(0.9.0 新增)** | ✅ | `skills/dsh-perf-diagnosis/SKILL.md` 32.3 kB |

**漏项:0 项。**

字节级证据(比 `fileCount` 更硬):

```
本地(1b53d20 worktree,npm 11.17.0)  421,745 B  sha1 9de76d2614f1665864c87a97a714b6b4b586e617
线上(registry 下载)                 421,745 B  sha1 9de76d2614f1665864c87a97a714b6b4b586e617
cmp → 完全相同;32 个文件逐文件 sha256 全部相同
```

0.4.0 当时两套 npm 打的 tarball **字节不同**(见 [npm 发版](../release.md) §4);这次打包者
npm 12.2.1、我这边 11.17.0,连字节都没漂。

包内**没有** `docs/` / `tests/` / `preview/` / `.github/` —— 与 `package.json#files` 一致;
[docs/plans/README.md](README.md) 也写明档案不进包。

## 3. release.yml 的缺口

### 3.1 三个直接问到的点

| 问 | 答 | 位置 |
|---|---|---|
| 有没有检查 tarball 内容 | **有**。`npm pack --dry-run` 落 `/tmp/pack.txt`,逐份 grep 根文件与分片,再按目录核 `tools/`、`locale/` | [`Pack and inspect`](../../.github/workflows/release.yml#L70)(改前在原 67 行) |
| `skills/` 写进 grep 清单了吗 | **没有**(改前)。目录循环只有 `tools locale` | 原 `release.yml:80` |
| 版本号与 tag 一致性检查在不在 | **在**。`tag="${GITHUB_REF_NAME#v}"` 必须逐字等于 `package.json.version` | [`Verify tag matches package version`](../../.github/workflows/release.yml#L49) |

### 3.2 已补的三处(只动 `Pack and inspect`,不改发版逻辑)

1. **目录核缺 `skills/`** —— [release.yml:83](../../.github/workflows/release.yml#L83):
   `for dir in tools locale` → `for dir in tools locale skills`。
   这是 0.9.0 里**唯一**没被任何一条门禁覆盖的发货项。
2. **目录核只匹配一层** —— [release.yml:88](../../.github/workflows/release.yml#L88):
   原来的 `for f in "$dir"/*` 对 `skills/` 只能拿到目录名 `skills/dsh-perf-diagnosis`;
   grep 到**这个名字**就放行,而它在 tarball 里出现与否证明不了 `SKILL.md` 在不在。
   改成 `while read < <(find "$dir" -type f | sort)` 递归展开。
3. **`grep -q` 是 BRE,路径里的 `.` 当通配符** —— 同文件:
   `grep -q "$f"` → `grep -qF "$f"`(`tools/cdp.mjs` 原来能匹配 `tools/cdpXmjs`)。

### 3.3 有牙齿的证明(本地实跑,不是推断)

```
# 把 skills 从 package.json#files 删掉,跑改动后那个 step 的同款 shell
  目录 tools:核了 13 个文件
  目录 locale:核了 1 个文件
打包产物缺 skills/dsh-perf-diagnosis/SKILL.md        → exit 1
# 同一份 /tmp/pack.txt 跑改动前的循环
OLD-STYLE CHECK PASSED(漏检 skills)                 → exit 0
```

### 3.4 没补、建议下次补的两处(动的是发版路径,半夜没擅自加)

4. **`release.yml` 缺「断言总数 = 文档」门禁**。`ci.yml:51-65` 有(`test "$total" -eq 714`
   + 核五份文档),`release.yml` **一条都没有**;步骤名里的
   `Offline suites (714 assertions)` 只是纯文本,不参与判定。
   后果:**CI 红而 Release 照发**。补法:把 `ci.yml:51-65` 那段抄到 `Pack and inspect` 之前。
5. **`release.yml` 缺 `node --check`**(`ci.yml:35-39` 有)。六个 `client.*.js` 分片只在浏览器里
   执行,语法错全靠 CI 兜。补法:抄 `ci.yml:35-39`。

### 3.5 另加一个仓库内可复跑的检查器

`tools/check-pack.mjs` + `npm run pack:check`:把"必带文件清单"从 release.yml 里的 shell 变成
可复跑检查,判据是 **`package.json#files` 展开后有没有覆盖必带清单**(正查必带文件、
反查目录里每个文件都进包、再查分片),不依赖 npm、不写缓存,沙箱里也能跑。

```
发货清单:files 展开 32 个文件(tools 13 / locale 1 / skills 1)
✅ 发货清单通过:必带 12 份文件 + 3 个目录齐全
```

(32 是 npm 的 33 减去 `package.json` —— npm 不论 `files` 怎么写都会带上它,所以不进必带清单。)

## 4. 下次发版的 checklist

1. bump `package.json.version`,跑完 `npm test` **714/714**。
2. 断言数变了就同步 5 份文档里的数字 + `ci.yml:60` 的 `714`(release.yml 步骤名里那个也要跟)。
3. `npm run docs:check` 与 `npm run pack:check` 都绿 —— 前者查断链/孤儿,后者查 `files` 有没有漏目录(`skills/` 就是这么漏的)。
4. 打 tag `vX.Y.Z`(与 version 逐字相同),**确认 Release 不是 draft** —— draft 不触发 `release: published`,整条流水不会跑,而且没有任何红灯。
5. 建 Release 后先查 **registry**(`npm view dsh-perf-hud@X.Y.Z` 有时间戳没有),再查 Actions 状态;状态页会骗人(§1.1),registry 不会。
6. 发布后核 `dist.fileCount` 应等于本地 `npm pack` 的总文件数、`gitHead` 应等于发版 commit。
7. 文件数变了就把 `REVIEW.md` §5 与 `AGENTS.md` §11 的数字一起改(它们现在写的是 0.8.0 的 31)。
8. 包里加了新目录(像这次的 `skills/`)时,**同时**改三处:`package.json#files`、`release.yml` 的 `for dir` 列表、`tools/check-pack.mjs` 的 `REQUIRED_DIRS`。

## 5. 下一版最可能挂在哪

**最可能:`Offline suites`**([release.yml:57](../../.github/workflows/release.yml#L57))。
理由不是"通常如此",而是本项目唯一的实测记录就红在这一步:`0.8.0` 的第一次 Release 因为
`logic.mjs` 沙箱漏搬 `withShellSource` 直接炸(§1.3);而 [AGENTS.md](../../AGENTS.md) §3 记着
同一个坑踩过不止一次("往 `client.js` 加函数要加进**每一个**用到它的盒子")。它的近亲是
"断言总数与五份文档不同步" —— 那条只由 CI 判,`release.yml` 不判(§3.4 第 4 条)。

**次可能:`Publish`**([release.yml:115](../../.github/workflows/release.yml#L115))。
它是整条流水里唯一依赖仓库外东西的一步:OIDC Trusted Publishing 的配置状态 +
`npm install -g npm@latest` 拉来的**浮动** npm 版本(0.9.0 实际用的是 12.2.1,而文档的判据
只写到"需要 ≥ 11.21.0")。其余 step 的输入全在仓库内,刚被这次复核覆盖过。

**意外项:Release 建成 draft**。它不会"失败",而是**根本不触发** —— 没有红灯,只有 npm 上
迟迟不出现新版本。这条比任何红的失败都更难发现,所以写进了 checklist 第 4 条。
