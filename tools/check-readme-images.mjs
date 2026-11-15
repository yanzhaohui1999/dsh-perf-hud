#!/usr/bin/env node
/**
 * check-readme-images.mjs —— npm 页面截图门禁(无依赖)
 *
 * 背景:npm 的包页面只渲染**根 `README.md`**,而 `docs/` 不在 `package.json#files` 里。
 * 相对路径(如 `docs/images/01-main.png`)= 图随包缺 → npm 页面上裂图;GitHub 因为是仓库
 * 视图,同样的相对路径反而正常 —— 只看 GitHub 是可骗过眼睛的。
 *
 * 门禁只看一件事:**README 里引用的每一张图,要么是绝对 URL,要么真的在打包清单里**
 * (`package.json#files` 展开后的文件集合)。两种修法都支持:
 *   A. 把图片目录写进 `files`(图随包发布)
 *   B. README 里用绝对 URL(`https://raw.githubusercontent.com/...`,包不变大)
 * 现在的选择是 B;哪天改回 A,这里也照样绿。
 *
 * 解析两种写法:`<img src="…">` 与 Markdown `![alt](…)`。`https:` / `data:` 视为绝对。
 *
 * 用法:node tools/check-readme-images.mjs [-q]
 * 退出码:0 = 通过;1 = 有裂图风险。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const QUIET = process.argv.includes('-q')
const posix = p => p.split('\\').join('/')

/** npm 页面与仓库首页真正会渲染的 README;两个都核,英文版也在包里。 */
const README_FILES = ['README.md', 'README_EN.md']

function walk(abs, acc = []) {
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue
    const p = join(abs, entry.name)
    if (entry.isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}

function globToRe(glob) {
  let re = ''
  for (const ch of glob) {
    re += ch === '*' ? '[^/]*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$')
}

/** 与 tools/check-pack.mjs 同一个口径:把 `files` 展开成"包里会有的文件"集合。 */
function shippedFiles(pkg) {
  const shipped = new Set()
  for (const raw of pkg.files ?? []) {
    const entry = posix(String(raw)).replace(/^\.\//, '')
    const abs = join(ROOT, entry)
    if (entry.includes('*')) {
      const dirPart = posix(dirname(entry))
      const base = dirPart === '.' ? ROOT : join(ROOT, dirPart)
      if (!existsSync(base)) continue
      const pattern = globToRe(entry)
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (!e.isFile()) continue
        const rel = posix(dirPart === '.' ? e.name : join(dirPart, e.name))
        if (pattern.test(rel)) shipped.add(rel)
      }
      continue
    }
    if (!existsSync(abs)) continue
    if (statSync(abs).isDirectory()) {
      for (const f of walk(abs)) shipped.add(posix(relative(ROOT, f)))
    } else {
      shipped.add(entry)
    }
  }
  return shipped
}

function imageRefs(text) {
  const refs = []
  const html = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi
  for (const m of text.matchAll(html)) refs.push({ src: m[1].trim(), syntax: '<img src>' })
  const md = /!\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g
  for (const m of text.matchAll(md)) refs.push({ src: m[1].replace(/^<|>$/g, '').trim(), syntax: '![]()' })
  return refs
}

const isAbsolute = src => /^(?:https?:|data:)/i.test(src)

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const shipped = shippedFiles(pkg)
const problems = []
let total = 0
let absolute = 0
let packed = 0

for (const file of README_FILES) {
  const abs = join(ROOT, file)
  if (!existsSync(abs)) {
    problems.push(`${file} 不存在 —— 包里的 README 少了`)
    continue
  }
  const refs = imageRefs(readFileSync(abs, 'utf8'))
  refs.forEach((ref, index) => {
    total += 1
    if (isAbsolute(ref.src)) {
      absolute += 1
      return
    }
    const clean = ref.src.replace(/[?#].*$/, '')
    const rel = posix(relative(ROOT, resolve(ROOT, clean)))
    if (rel.startsWith('../')) {
      problems.push(`${file} 第 ${index + 1} 张图指向仓库外:${ref.src}`)
    } else if (!shipped.has(rel)) {
      const hint = existsSync(join(ROOT, clean))
        ? `文件在磁盘上但不在 package.json#files 里,所以不随包发布`
        : `文件根本不存在`
      problems.push(`${file} 第 ${index + 1} 张图是相对路径 ${ref.src}:${hint} —— 换绝对 URL,或把它加进 files`)
    } else {
      packed += 1
    }
  })
}

if (problems.length) {
  console.error(`❌ README 图片有 ${problems.length} 处会在 npm 页面上裂开:`)
  for (const p of problems) console.error(`   ${p}`)
  process.exit(1)
}
if (!QUIET) {
  console.log(`✅ README 图片:${total} 张(${absolute} 张绝对 URL,${packed} 张随包发布),npm 页面上都能显示`)
}
process.exit(0)
