#!/bin/sh
# 提交前门禁:文档断链 + 孤儿文档(被 .git/hooks/pre-commit 调用)
#
# 为什么挂在这里:文档检查写在文档里就等于没人跑。这里只调用、不复写逻辑 ——
# 真正的判据在 tools/check-docs.mjs,改判据只改那一份。
#
# 装(每个 clone 一次;钩子不随 git 同步):
#   printf 'exec "$(git rev-parse --show-toplevel)/tools/git-pre-commit.sh"\n' \
#     > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
# 绕过:git commit --no-verify —— 唯一逃生口,不加开关/环境变量。
set -u
TOP="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 1
[ -n "$TOP" ] || exit 1
cd "$TOP" || exit 1
if ! node tools/check-docs.mjs -q; then
  echo "❌ 文档门禁失败 —— 排查:node tools/check-docs.mjs" >&2
  exit 1
fi
exit 0
