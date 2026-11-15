#!/usr/bin/env node
/**
 * check-readme-links.mjs —— npm 页面链接与截图门禁(无依赖)
 *
 * 背景:npm 的包页面只渲染**根 `README.md`**,而 `docs/` 不在 `package.json#files` 里。
 * 相对路径(如 `docs/images/01-main.png`)在 GitHub 上正常(仓库视图能解析),
 * 在 npm 页面上就是裂图 / 死链 —— 只看 GitHub 是可骗过眼睛的。
 *
 * 判据(README 里每条链接与每张图,不留第三种):
 *   - 图片:绝对 URL(`https:` / `data:`),或真的在打包清单里(`package.json#files` 展开);
 *   - 链接:绝对 URL(`https:` / `mailto:`)、页内锚点 `#…`(必须有同名标题),
 *          或真的在打包清单里。
 * 相对路径指向"仓库里有、包里没有"的文件会直接红 —— 那正是 npm 上看不见的那一类。
 *
 * 解析写法:`<img src>` / `<a href>` / Markdown `![alt](…)` / `[text](…)`;
 * 代码围栏与行内代码里的内容不算链接。
 *
 * 用法:node tools/check-readme-links.mjs [-q]
 * 退出码:0 = 通过;1 = 有裂图 / 死链风险。
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

/** 把代码块与行内代码换成空格(保留换行,行号不变),避免把示例当链接。 */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
}

/** GitHub / npm 的标题锚点:小写、去标点、空格变连字符;中文原样保留。 */
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

const IMG_HTML = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi
const IMG_MD = /!\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g
const A_HTML = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi
const A_MD = /(?<!!)\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g

const isHttp = src => /^(?:https?:|mailto:)/i.test(src)
const isImageAbsolute = src => /^(?:https?:|data:)/i.test(src)

/** 本项目自己仓库的绝对 URL:能还原成仓库内路径,顺手核一下文件还在不在(防改名 / 手滑)。 */
const REPO = 'yanzhaohui1999/dsh-perf-hud'
const OWN_URL = [
  new RegExp(`^https://raw\\.githubusercontent\\.com/${REPO}/main/([^?#]+)`),
  new RegExp(`^https://github\\.com/${REPO}/(?:blob|tree)/main/([^?#]+)`),
]
const ownRepoPath = (url) => {
  for (const re of OWN_URL) {
    const m = re.exec(url)
    if (m) return decodeURIComponent(m[1]).replace(/\/+$/, '')
  }
  return null
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const shipped = shippedFiles(pkg)
const problems = []
const warnings = []
const totals = { images: 0, imagesAbsolute: 0, imagesPacked: 0, links: 0, linksAbsolute: 0, linksAnchor: 0, linksPacked: 0 }

for (const file of README_FILES) {
  const abs = join(ROOT, file)
  if (!existsSync(abs)) {
    problems.push(`${file} 不存在 —— 包里的 README 少了`)
    continue
  }
  const raw = readFileSync(abs, 'utf8')
  const cleaned = stripCode(raw)
  const lines = cleaned.split('\n')

  // 页内锚点先收标题,再逐条核 —— 锚点写错时 GitHub 与 npm 都只是"点了没反应"。
  const anchors = new Set()
  for (const m of cleaned.matchAll(/^#{1,6}[ \t]+(.+?)\s*#*\s*$/gm)) anchors.add(slug(m[1]))

  const checkOwn = (url, kind, at) => {
    const path = ownRepoPath(url)
    if (path !== null && !existsSync(join(ROOT, path))) {
      problems.push(`${file}:${at} ${kind}指向仓库内不存在的路径:${url}`)
    }
  }

  const relativeRef = (src, kind, at) => {
    const clean = src.replace(/[?#].*$/, '')
    const rel = posix(relative(ROOT, resolve(ROOT, clean)))
    if (rel.startsWith('../')) {
      problems.push(`${file}:${at} ${kind} 指向仓库外:${src}`)
      return
    }
    if (!shipped.has(rel)) {
      const hint = existsSync(join(ROOT, clean))
        ? '文件在磁盘上但不在 package.json#files 里,不随包发布'
        : '文件根本不存在'
      problems.push(`${file}:${at} ${kind}是相对路径 ${src} —— ${hint};改绝对 URL,或把它加进 files`)
      return
    }
    if (kind === '链接') warnings.push(`${file}:${at} 的链接 ${src} 指向包内文件(npm 页面可能解析不到相对路径,建议改绝对 URL)`)
  }

  lines.forEach((line, i) => {
    const at = i + 1
    for (const m of line.matchAll(IMG_HTML)) {
      totals.images += 1
      if (isImageAbsolute(m[1])) {
        totals.imagesAbsolute += 1
        checkOwn(m[1], '图片', at)
      } else {
        totals.imagesPacked += 1
        relativeRef(m[1], '图片', at)
      }
    }
    for (const m of line.matchAll(IMG_MD)) {
      totals.images += 1
      const src = m[1].replace(/^<|>$/g, '')
      if (isImageAbsolute(src)) {
        totals.imagesAbsolute += 1
        checkOwn(src, '图片', at)
      } else {
        totals.imagesPacked += 1
        relativeRef(src, '图片', at)
      }
    }
    for (const m of line.matchAll(A_HTML)) {
      totals.links += 1
      const src = m[1]
      if (isHttp(src)) {
        totals.linksAbsolute += 1
        checkOwn(src, '链接', at)
      } else if (src.startsWith('#')) {
        totals.linksAnchor += 1
        if (!anchors.has(src.slice(1))) problems.push(`${file}:${at} 页内锚点 ${src} 没有同名标题`)
      } else {
        totals.linksPacked += 1
        relativeRef(src, '链接', at)
      }
    }
    for (const m of line.matchAll(A_MD)) {
      totals.links += 1
      const src = m[1].replace(/^<|>$/g, '')
      if (isHttp(src)) {
        totals.linksAbsolute += 1
        checkOwn(src, '链接', at)
      } else if (src.startsWith('#')) {
        totals.linksAnchor += 1
        if (!anchors.has(src.slice(1))) problems.push(`${file}:${at} 页内锚点 ${src} 没有同名标题`)
      } else {
        totals.linksPacked += 1
        relativeRef(src, '链接', at)
      }
    }
  })
}

if (problems.length) {
  console.error(`❌ README 里有 ${problems.length} 处会在 npm 页面上裂开 / 点不动:`)
  for (const p of problems) console.error(`   ${p}`)
  process.exit(1)
}
for (const w of warnings) console.warn(`⚠️  ${w}`)
if (!QUIET) {
  console.log(
    `✅ README 图片:${totals.images} 张(${totals.imagesAbsolute} 绝对 URL,${totals.imagesPacked} 随包发布)`,
  )
  console.log(
    `✅ README 链接:${totals.links} 条(${totals.linksAbsolute} 绝对 URL,${totals.linksAnchor} 页内锚点,${totals.linksPacked} 随包文件)`,
  )
}
process.exit(0)
