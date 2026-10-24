#!/usr/bin/env node
/**
 * check-docs.mjs —— 文档入口与链接门禁(无依赖)
 *
 * 查两件事:
 *   1. 断链:每篇 md 里的相对链接/图片是否指向存在的文件;
 *   2. 孤儿:docs/ 下的 md 是否至少被另一篇 md 链接(自链接不算)。
 *
 * 为什么要有它:文档写出来很容易"没人链" —— 目录里躺着,没人知道它在。
 * 入口页(docs/README.md)登记过就不算孤儿;漏登记会在这里红。
 *
 * 用法:node tools/check-docs.mjs [-q]
 * 退出码:0 = 通过;1 = 有断链或孤儿。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative, extname, posix } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const QUIET = process.argv.includes('-q')
const SKIP = new Set(['.git', 'node_modules', '.worktrees', 'dist', 'coverage', '.cache', '.venv'])

function walk(dir, acc = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (extname(e.name).toLowerCase() === '.md') acc.push(p)
  }
  return acc
}

const files = walk(ROOT)
const fileSet = new Set(files)
const LINK = /\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g
const broken = []
const inbound = new Map(files.map(f => [f, 0]))

for (const f of files) {
  const text = readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '')
  let m
  LINK.lastIndex = 0
  while ((m = LINK.exec(text))) {
    let target = m[1]
    if (/^(https?:|mailto:|tel:|data:|\/\/)/i.test(target) || target.startsWith('#')) continue
    target = target.split('#')[0].split('?')[0]
    if (!target) continue
    let decoded = target
    try { decoded = decodeURIComponent(target) } catch { /* 保持原样 */ }
    const abs = decoded.startsWith('/') ? join(ROOT, decoded) : resolve(dirname(f), decoded)
    if (!existsSync(abs)) {
      broken.push(`${relative(ROOT, f)} -> ${target}`)
      continue
    }
    if (fileSet.has(abs)) inbound.set(abs, (inbound.get(abs) ?? 0) + 1)
  }
}

const docsDir = join(ROOT, 'docs')
const orphans = files
  .filter(f => relative(ROOT, f).startsWith('docs' + posix.sep) || relative(ROOT, f).startsWith('docs/'))
  .filter(f => (inbound.get(f) ?? 0) === 0)
  .map(f => relative(ROOT, f))

if (!QUIET) {
  console.log(`文档门禁:扫描 ${files.length} 篇 md,链接 ${[...inbound.values()].reduce((a, b) => a + b, 0)} 条`)
}
if (broken.length) {
  console.error(`❌ 断链 ${broken.length} 条:`)
  for (const b of broken) console.error(`   ${b}`)
}
if (orphans.length) {
  console.error(`❌ 孤儿文档 ${orphans.length} 篇(没有任何 md 链接指向它):`)
  for (const o of orphans) console.error(`   ${o} —— 在 docs/README.md 登记一行`)
}
if (broken.length || orphans.length) process.exit(1)
if (!QUIET) console.log('✅ 文档门禁通过:0 断链、0 孤儿')
process.exit(0)
