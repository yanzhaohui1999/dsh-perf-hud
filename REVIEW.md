# 发布就绪评审(2026-10-07)

面向"作为社区插件发布"的一次只读评审记录:结论、证据、待办。评审方法为**读源码 + 实测命令**,没有猜测项;
每条"已达成"都能在本文件给出的命令下复现。

三份文档分工:[README.md](README.md) 讲装什么怎么用 · [ACCEPTANCE.md](ACCEPTANCE.md) 是验收数字 ·
[HANDOVER.md](HANDOVER.md) 是环境与源码级机制 · 本文是**发布前的缺口清单**。

---

## 0. 一句话结论

**能装能用、测试全绿,但离"发布"还差一整层发布元数据 + 公开仓库**;另有 1 个真 bug 和一批把作者本人环境写死的代码。

---

## 1. 发布阻塞项(不解决就发不出去 / 收录被打回)

| # | 缺口 | 现状证据 | 待办 |
|---|---|---|---|
| 1 | npm 发不出去 | `package.json` 是 `"private": true`,且没有 `license` / `repository` / `homepage` / `keywords` / `engines` / `peerDependencies` | 去掉 `private`;补上述字段;把 3 个客户端 inject 的 `@deepseek-ai/*` 写进 `peerDependencies`(范围必须带**显式预发布分支**,否则静默排除 `0.2.0-rc.2`) |
| 2 | 没有公开仓库 | `git remote -v` 为空 | 建 GitHub 仓库、加 `dsh-plugin` topic、仓库需存在满 1 天 |
| 3 | README 装不了 | [README.md](README.md) 的安装行写死 `/Users/y/workspace/dsh-perf-hud` | 改成 npm 包名;本地路径作为开发装法单列 |
| 4 | npm 页面会出死链 | README 链接 `HANDOVER.md` / `ACCEPTANCE.md`,两者都不在 `files` 里(npm 只强制带 README/LICENSE/package.json) | 把这两份加进 `files`,或改为指向 GitHub 的绝对链接 |
| 5 | 包名尚未注册 | `npm view dsh-perf-hud` → 404(未被占用) | 首次发布前先占名;确认 `publishConfig.access`(非作用域包默认 public) |

### 市场收录的硬门槛(来自 awesome-dsh-plugin 的 contributing.md,均已核对)

- `package.json` 必须声明 **`dsh.bundle.patch`**(只有 `dsh.client` 是最常见的被拒原因)——**本项目已满足**,`cordis.patch.yml` 形态正确。
- 仓库有真实可跑代码、创建满 1 天、加 `dsh-plugin` topic、描述与实际代码一致(评审会逐句核对)。
- 投稿只提交**一个文件** `data/plugins/<owner>__<repo>.yml`(必填 `description.en`),一个 PR 最多 3 条。
- 官方 `@deepseek-ai/*` 包建议声明为 `peerDependencies`,且范围要带显式预发布分支。
- 可选但推荐:发布到 npm(免 `allowBuilds` 构建授权),或在 GitHub Release 挂预构建 `.tgz` 并用 `tarball:` 指向它。

---

## 2. 代码与文档里的真问题

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 6 | **宿主版本号恒为 `null`** | [index.js](index.js) 读 `new URL('../package.json', import.meta.url)` → 解析到**包外**(实测 `ENOENT: /Users/y/workspace/package.json`);装进 `node_modules` 后更会读到 profile 的 package.json | `/api/dsh-perf-hud/host` 回执里的 `pluginVersion` 永远是 null,导出件的自描述头缺一项;无断言覆盖 —— **✅ 已修**:改用 `'./package.json'`,`tests/host.mjs` 加了断言(把路径改回去即报 `got null`) |
| 7 | 作者自己的插件名写进产品代码 | `DEFAULT_CANDIDATES` 硬编码 `dsh-status-rotator` / `dsh-notify-me` / `dsh-better-sidebar` / `dsh-context`;面板「验收」区直接渲染 `✓ rotator / ✗ notify-me` | 别人装了这个 HUD,隔离实验默认那 4 个候选多半"不在 bundle 列表里",验收区永远 ✗ —— **✅ 已修**:候选改为从宿主 `listBundles` 推导(已启用 + 可移除 + 非官方 + 非自身,按名排序取前 4),面板那行改成「独立包名 N · 样本」 |
| 8 | 注释与代码互相矛盾 | [cordis.patch.yml](cordis.patch.yml) 与 [client.js](client.js) 头部都写"`index.js` 的 `apply()` 是空实现 / 宿主侧只有一行空 apply()",实际 `index.js` 是 290 行、三个宿主功能 | 评审先读注释即失真;后续接手的人会误判改动面 —— **✅ 已修**:两处注释都改成如实描述(宿主半可选,提供事件循环 / 路由 / bundle 代理) |
| 9 | i18n 只做了一半 | 85 个 `t()` 键的 zh/en 词典齐全,但兜底是**中文**(`fallback = DICT.zh`);隔离实验约 20 条进度/原因串是硬编码中文;导出的 `isolation.method` 是中文长句;面板有一处漏进字典的 `处不一致` | en 用户看到中英混杂;导出件对机器读者不友好 |
| 10 | 默认开启 + 改全局原型 | 包装 `setTimeout/setInterval/requestAnimationFrame` 与 `Node.prototype.appendChild/insertBefore`、`Element.prototype.setAttribute`;`want` 默认 `true` | 这是收录评审"源码里有没有可疑行为"最容易被点名的项;必须先写进 README 的显式警告 |
| 11 | 隔离实验会写 profile 持久化 | `pluginManager.setBundleEnabled` 改的是 profile 的 bundle 选择(不是 `cordis.patch.yml`),靠 `confirm: true` + 逐项恢复 + 恢复核验兜底 | 能力很强且危险,需要在 README 显著位置说明;可考虑默认关闭/加开关 |

---

## 3. 工程化与可移植性

| # | 问题 | 说明 |
|---|---|---|
| 12 | 验证脚本绑死本机 | [tests/verify-after-restart.sh](tests/verify-after-restart.sh) 写死 `/Users/y/...` 的 node 与仓库路径、launchd 服务名、个人日志路径 | 公开仓库里跑不了;应改为环境变量 + 自动探测 |
| 13 | 没有测试入口与 CI | 没有 `npm test` 脚本、没有 `.github/workflows/` | 三个离线套件本身很好,只差一个可移植入口 —— **CI 已补(见 §5),`npm test` 待补** |
| 14 | 没有版本兼容声明 | `engines.dsh` / `dsh.compatibility.dshReleases` 都缺 | 市场卡片只能显示"宿主要求未声明"(它按 `engines.dsh` 或 lockstep peer 判) |
| 15 | 个人运行日志进了 git | [live-verification.txt](live-verification.txt) 已跟踪(内容是 pid / 耗时 / 包名,无 cookie 值) | 公开前删除或 gitignore |
| 16 | 缺 `main` 字段 | 只有 `exports["."]`(实测 `require.resolve` 正常) | 与同类已发布插件不一致,补上更稳 |
| 17 | 缺开源仓标配 | 无 LICENSE / CONTRIBUTING / CHANGELOG / issue 模板 | ✅ LICENSE / README_EN / CONTRIBUTING / CHANGELOG / AGENTS / CI 已补,issue 模板待补 |

---

## 4. 已核验为"没问题"的(不用动)

- **测试**:`node tests/{attribution,logic,host}.mjs` = **11 + 152 + 24 = 187 条,全绿**(README 声称的 187 与实际一致)。
- **历史无密钥**:全历史 blob 扫 `sk-` / `apiKey` / `baseURL` / `Authorization` / `token=`,命中项只有 `.gitignore` 注释与 HANDOVER 里的操作步骤;**`dump-config-after.txt`(含 provider/baseURL 配置)、`backup-20261006/`、`add.log` 从未进过历史**。
- **插件形态**:`dsh.bundle.patch` + `cordis.patch.yml` + `exports["./client"]` + `dsh.client.platform/inject` 均正确;`icon.svg` 有效;`locale/{zh,en}.json` 形态与 `dsh-context` 一致(只放 `meta.title/description`)。
- **零运行时依赖**:`client.js` 只 `require('react')`(走浏览器模块表),`index.js` 只用 node 内置模块。
- **提交历史已规范**:30 条全部 `type(scope): 描述` 格式,正文中性化(无"用户/我"),见 [CHANGELOG.md](CHANGELOG.md)。
- **作者归属**:提交邮箱 `707337118@qq.com` 是 GitHub 账号 `yanzhaohui1999` 的 **Primary + Verified** 邮箱,推上去会正确挂到账号。

---

## 5. 待办清单

### 已随本批补掉(2026-10-07:文档、CI,以及 §2 里那三处代码必修)

- [x] [README.md](README.md) 重写为发布形态(装法、读数口径、四条腿、隔离实验、**风险与边界**),新增英文版 [README_EN.md](README_EN.md)
- [x] [AGENTS.md](AGENTS.md)(开发规则)/ [CONTRIBUTING.md](CONTRIBUTING.md)(贡献流程)/ [CHANGELOG.md](CHANGELOG.md)(从 30 条规范提交生成)
- [x] [LICENSE](LICENSE)(MIT)
- [x] CI:[.github/workflows/ci.yml](.github/workflows/ci.yml)(两个半边的语法检查 + 187 条离线断言 + **断言总数与文档一致性**)、[.github/workflows/release.yml](.github/workflows/release.yml)(npm Trusted Publishing / OIDC,含 tag 与版本号一致性校验、打包产物核对)
- [x] 提交历史规范化为 Conventional Commits 并把正文中性化(见 [CHANGELOG.md](CHANGELOG.md))
- [x] **代码必修三处**:`index.js` 的 `'../package.json'` → `'./package.json'`(+ 断言)、`DEFAULT_CANDIDATES` 改为按 `listBundles` 推导(+ 3 条断言)、`cordis.patch.yml` 与 `client.js` 头部的过期注释
- [x] 断言总数 183 → **187**(attribution 11 / logic 152 / host 24),README / README_EN / AGENTS / CONTRIBUTING / CHANGELOG / REVIEW / HANDOVER 与两个 workflow 里的数字全部同步
- [x] README 里把"默认开启 + 插桩全局原型 + 隔离实验会临时写 profile"写成显式警告

### 仍待办(属于打包/发布侧,本批刻意没动)

- [ ] `package.json`:去 `private`、补 `license` / `repository` / `homepage` / `bugs` / `keywords` / `engines` / `peerDependencies` / `main`,并加 `scripts.test`(CI 现在是直接列三条命令)
- [ ] i18n:兜底改英文、实验进度串进字典、`isolation.method` 出词条
- [ ] **README 引用的文档不在 npm 包里**:实测 `npm pack --dry-run` 只含 `package.json` / `README.md` / `LICENSE` / `index.js` / `client.js` / `cordis.patch.yml` / `icon.svg` / `locale/*.json`。npm 页面上的相对链接需要 `repository` 字段才可能被重写,最稳的做法是二选一:① 把 README 链接到的文档(`README_EN.md` / `CONTRIBUTING.md` / `CHANGELOG.md` / `AGENTS.md` / `HANDOVER.md` / `ACCEPTANCE.md` / `REVIEW.md`)加进 `files`;② 改成 GitHub 绝对链接。参考 `dsh-better-sidebar` 的做法:把 README / README_EN / LICENSE / icon / locale / patch 放进 `files`,`AGENTS.md` 与 `docs/` 留给 GitHub。
- [ ] [tests/verify-after-restart.sh](tests/verify-after-restart.sh) 去个人路径(改成环境变量 + 自动探测)
- [ ] 删除 [live-verification.txt](live-verification.txt)(个人运行日志)
- [ ] 建公开仓库 → 加 `dsh-plugin` topic → npm 首发 → 提收录 PR(见 §1 的硬门槛)
