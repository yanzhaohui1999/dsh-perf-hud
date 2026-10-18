# npm 发版

> 从 [AGENTS.md](../AGENTS.md) §10 移出(2026-10-18),正文未改。发版前按这里的步骤。

## 10. npm 发版

1. bump `package.json.version`,跑完 [测试与门禁](../AGENTS.md#3-测试与门禁) 并全绿。
2. 打 tag `vX.Y.Z`(**tag 必须与 `version` 一致**),在 GitHub 建 Release。
3. `.github/workflows/release.yml` 在该 Release 发布时自动 `npm publish`(用 **npm Trusted Publishing / OIDC**,不配 `NPM_TOKEN`)。它对该版本**幂等**:发布前先 `npm view` 查 registry,查到就跳过发布并写 notice(所以给手工首发那一版建 Release 不会发失败,只会跳过);**查询失败照实报错退出**,不当成"没发过"。
4. **第一个版本**:OIDC **直接** `npm publish` 发不了首版(npmjs.com 要到包已经存在之后才能配 Trusted Publisher,上游 [npm/cli#8544](https://github.com/npm/cli/issues/8544) 仍 open)。0.4.0 实测走的是 **staged publishing**:`npm stage publish`(registry 见到包还不存在,先建一个占位版本 `0.0.0-stage` 把包名占住)→ 维护者在 npmjs.com 的 **Staged Packages** 页点 Approve,或 `npm stage approve <stage-id>`,用 **2FA approve** 之后才公开。
   ⚠️ **打包/发布用的不是 homebrew 那套 npm**:本机 `/opt/homebrew/bin/npm` 是 11.12.1,**没有 `stage` 子命令**;发布用的是 `/Users/y/tools/node-v24.19.0-darwin-arm64` 里的 npm **11.17.0 / Node 24.19.0**。只有它的 `lib/commands/publish.js` 有 `stage: true` 那条路,`npm publish` 仍然走 `otplease`(当场要 OTP)。同一份内容被两套 npm 打出来的 tarball **字节不同、内容相同** —— 别拿 shasum 不等当"发错东西"的证据,要比逐文件 sha256。
   首发之后再去包设置页配 Trusted Publisher(Provider: GitHub Actions;填 owner / repo / `release.yml`):⚠️ **Allowed actions** 决定以后怎么走 —— `npm stage publish` 永远允许,而"直接 `npm publish`"要**显式勾选**;只勾 staged 的话 `release.yml` 得改成 `npm stage publish`,而且每版都要人工 approve。⚠️ 新建配置**必须在 2 天内完成一次成功发布**,否则作废且无法编辑(给一个已经在 npm 上的版本建 Release **不算**验证)。
5. 发布后核对产物:`npm pack --dry-run` 里必须带上 `index.js` / `client.js` / `cordis.patch.yml` / `icon.svg` / `locale/en.json` / `LICENSE`,以及 README 与 AGENTS 链接到的全部文档(`README_EN` / `CONTRIBUTING` / `REVIEW` / `CHANGELOG` / `AGENTS`)与 `tools/`(事故包渲染器 + 三个 CDP 验证器,README 让用户直接跑它们,所以必须进包)—— 漏一份,npm 页面上就是一个死链。`release.yml` 的 Pack and inspect 步骤逐份 grep,漏了就失败。
