#!/usr/bin/env node
/**
 * check-pack.mjs —— 发货清单门禁(无依赖)
 *
 * 查两件事:
 *   1. 必带文件:`docs/release.md` §5 那份清单(两个半边 + patch + 图标 + 许可证 + 五份文档
 *      + `tools/` + `locale/` + 0.9.0 起的 `skills/`)展开 `package.json#files` 之后是不是齐的;
 *   2. 反向:目录型条目(`tools` / `locale` / `skills`)里的**每个**文件是不是都进包了 ——
 *      包里新增文件却忘了登记 files,或整个目录没写进 files,这里红。
 *
 * 为什么不直接跑 `npm pack --dry-run`:那要求 npm 在 PATH 上且缓存目录可写,
 * 出了 CI(尤其带沙箱的环境里)会以 `EPERM ... _cacache` 失败,于是一个"本地检查器"
 * 反而只在它有权限的地方能跑。这里只回答"files 有没有覆盖必带清单",读 package.json
 * 再走一遍文件系统就够;真 tarball 的核对仍然归 `release.yml` 的 Pack and inspect。
 *
 * 3) 兼容矩阵(1.0 / S5):`package.json#dsh.compatibility.dshReleases` 里每个版本都必须
 *    ① 落在 `engines.dsh` 范围内;② 在 `docs/plans/*-v1-acceptance.md` 里有一条真页面验收记录。
 *    矩阵为空、版本越界、或"声明了但没跑过"都算漏项 —— 1.0 起 **声明即已验证**。
 *
 * 用法:node tools/check-pack.mjs [-q]
 * 退出码:0 = 通过;1 = 有漏项。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const QUIET = process.argv.includes('-q')
const posix = p => p.split('\\').join('/')

// ── semver 的最小实现:只支持 `>=X <Y` 这种 engines 写法 + 预发布比较 ──
// (零依赖仓库不引 semver;够用就好,范围写法由 engines 那一处固定)
function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim())
  if (m === null) return null
  return { main: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') }
}
function compareIdent(a, b) {
  const na = /^\d+$/.test(a)
  const nb = /^\d+$/.test(b)
  if (na && nb) return Number(a) - Number(b)
  if (na) return -1 // 数字标识 < 字母标识(npm 规则)
  if (nb) return 1
  return a < b ? -1 : a > b ? 1 : 0
}
function compareVersion(a, b) {
  for (let i = 0; i < 3; i += 1) if (a.main[i] !== b.main[i]) return a.main[i] - b.main[i]
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1 // 正式版 > 预发布
  if (b.pre.length === 0) return -1
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i += 1) {
    const c = compareIdent(a.pre[i], b.pre[i])
    if (c !== 0) return c
  }
  return a.pre.length - b.pre.length
}
function satisfies(version, range) {
  const clauses = String(range).trim().split(/\s+/)
  return clauses.every((clause) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(clause)
    const target = parseVersion(m[2])
    if (target === null) return false
    const c = compareVersion(version, target)
    switch (m[1] ?? '=') {
      case '>=': return c >= 0
      case '<=': return c <= 0
      case '>': return c > 0
      case '<': return c < 0
      default: return c === 0
    }
  })
}
/** docs/plans/*-v1-acceptance.md 里有没有这个版本的**验收记录**。
 *  只认机器可读标记 `<!-- verified:dsh=<版本> -->` —— "文中提到过这个版本号"不算记录
 *  (验收档案会写"某某版本没有记录",那样的句子不该被当成通过)。 */
function acceptanceFiles(version) {
  const dir = join(ROOT, 'docs', 'plans')
  const files = readdirSync(dir).filter((name) => /-v1-acceptance\.md$/.test(name))
  const marker = `<!-- verified:dsh=${version} -->`
  return files.filter((name) => readFileSync(join(dir, name), 'utf8').includes(marker))
}

/** 必带文件:`docs/release.md` §5 与 README/AGENTS 里的链接共同要求的那一份。
 *  `package.json` 不在此列 —— npm 不论 `files` 怎么写都会带上它。 */
const REQUIRED_FILES = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'LICENSE',
  'locale/en.json',
  'README.md',
  'README_EN.md',
  'CONTRIBUTING.md',
  'REVIEW.md',
  'CHANGELOG.md',
  'AGENTS.md',
]

/** 必带目录:必须是 `files` 里的目录条目,且展开后至少有文件。 */
const REQUIRED_DIRS = ['locale', 'tools', 'skills']

function walk(abs, acc = []) {
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.name === '.DS_Store') continue
    const p = join(abs, e.name)
    if (e.isDirectory()) walk(p, acc)
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

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const entries = Array.isArray(pkg.files) ? pkg.files : []
const shipped = new Set()
const dirEntries = []
const problems = []

if (!entries.length) problems.push('package.json 没有 files 数组 —— npm 会按 .gitignore 兜底发东西')

for (const entry of entries) {
  const clean = posix(entry).replace(/^\.\//, '')
  const abs = join(ROOT, clean)

  // 通配条目(现在只有 client.*.js):按 basename 通配,只匹配同层文件。
  if (clean.includes('*')) {
    const dirPart = posix(dirname(clean))
    const base = dirPart === '.' ? ROOT : join(ROOT, dirPart)
    if (!existsSync(base)) { problems.push(`files 里的通配项 ${clean} 所在目录不存在`); continue }
    const pat = globToRe(clean)
    let hit = 0
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isFile()) continue
      const rel = posix(dirPart === '.' ? e.name : join(dirPart, e.name))
      if (pat.test(rel)) { shipped.add(rel); hit += 1 }
    }
    if (!hit) problems.push(`files 里的通配项 ${clean} 一个文件都没匹配到`)
    continue
  }

  if (!existsSync(abs)) { problems.push(`files 里的 ${clean} 在磁盘上不存在`); continue }
  if (statSync(abs).isDirectory()) {
    const list = walk(abs)
    if (!list.length) problems.push(`files 里的目录 ${clean} 是空的`)
    dirEntries.push(clean)
    for (const f of list) shipped.add(posix(relative(ROOT, f)))
  } else {
    shipped.add(clean)
  }
}

// 1) 必带文件
for (const f of REQUIRED_FILES) {
  if (!shipped.has(f)) problems.push(`必带文件 ${f} 没进包(补进 package.json#files)`)
}

// 2) 必带目录:要写成 files 里的目录条目,且真的有文件
for (const d of REQUIRED_DIRS) {
  if (!dirEntries.includes(d)) problems.push(`必带目录 ${d}/ 没写进 package.json#files`)
  const inDir = [...shipped].filter(p => p.startsWith(d + '/'))
  if (!inDir.length) problems.push(`必带目录 ${d}/ 展开后一个文件都没有`)
}

// 3) 反向:磁盘上属于目录条目的每个文件都得进包(漏登记 = 悄悄少发)
for (const d of dirEntries) {
  const onDisk = walk(join(ROOT, d)).map(f => posix(relative(ROOT, f)))
  const missed = onDisk.filter(f => !shipped.has(f))
  if (missed.length) problems.push(`${d}/ 里有 ${missed.length} 个文件没进包:${missed.join(', ')}`)
}

// 4) 包内分片(client.<suffix>.js)必须随包发出,漏一个面板启动就 404
const shards = readdirSync(ROOT).filter(n => /^client\.[^.]+(?:\.[^.]+)*\.js$/.test(n) && n !== 'client.js')
for (const s of shards) {
  if (!shipped.has(s)) problems.push(`分片 ${s} 没进包(改 package.json#files 的 client.*.js 通配)`)
}

// 5) 兼容矩阵(1.0 / S5):声明"兼容"的每个 DSH 版本都要在 engines 范围内、且有真页面验收记录。
//    1.0 起 **声明即已验证** —— 没跑过的版本不列;列了就要求 docs/plans/*-v1-acceptance.md 里有那一行。
{
  const matrix = pkg.dsh?.compatibility?.dshReleases ?? {}
  const versions = Object.keys(matrix)
  if (versions.length === 0) {
    problems.push('dsh.compatibility.dshReleases 是空的 —— 1.0 起"声明即已验证",至少要列一个真跑过的版本')
  }
  for (const version of versions) {
    const parsed = parseVersion(version)
    if (parsed === null) { problems.push(`dshReleases 里的版本号看不懂:${JSON.stringify(version)}`); continue }
    if (matrix[version] !== 'compatible') {
      problems.push(`${version} 的声明值是 ${JSON.stringify(matrix[version])} —— 只认 "compatible"(不能写的版本就别列)`)
    }
    if (typeof pkg.engines?.dsh !== 'string' || !satisfies(parsed, pkg.engines.dsh)) {
      problems.push(`${version} 不在 engines.dsh 范围(${JSON.stringify(pkg.engines?.dsh ?? null)})内`)
    }
    const records = acceptanceFiles(version)
    if (records.length === 0) {
      problems.push(`${version} 声明为兼容,但 docs/plans/*-v1-acceptance.md 里没有它的真页面验收记录 —— 跑一遍再声明`)
    }
  }
  if (!QUIET && versions.length > 0) {
    console.log(`兼容矩阵:${versions.length} 个版本,都在 engines.dsh 内且有验收记录(${versions.join(' / ')})`)
  }
}

const countIn = d => [...shipped].filter(p => p.startsWith(d + '/')).length
if (!QUIET) {
  console.log(
    `发货清单:files 展开 ${shipped.size} 个文件` +
      `(tools ${countIn('tools')} / locale ${countIn('locale')} / skills ${countIn('skills')})`,
  )
}

if (problems.length) {
  console.error(`❌ 发货清单有 ${problems.length} 处漏项:`)
  for (const p of problems) console.error(`   ${p}`)
  process.exit(1)
}
if (!QUIET) console.log(`✅ 发货清单通过:必带 ${REQUIRED_FILES.length} 份文件 + ${REQUIRED_DIRS.length} 个目录齐全`)
process.exit(0)
