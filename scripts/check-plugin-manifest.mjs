#!/usr/bin/env node
/**
 * check-plugin-manifest.mjs —— DSH 插件清单门禁(零依赖,三个插件仓库共用同一份)
 *
 * 这个脚本回答一个 npm 自己**不查**的问题:包发得出去,不等于 DSH 挂得起来。
 * `package.json#dsh` 里写的 patch / client / icon 都只是字符串,DSH 在挂载时才去
 * 解析它们 —— 路径写错、文件忘了进 `files`、`exports["./client"]` 指了个空,
 * `npm publish` 一路绿灯,用户装完才发现面板 404 或 profile 起不来。
 *
 * 两种模式:
 *
 *   1) 只查清单(不需要 npm 打包):
 *        node scripts/check-plugin-manifest.mjs
 *      按 @deepseek-ai/dsh-package-manifest 的 `DshManifest` 类型(runtime 真读的那份)
 *      核形状,并把每个被引用的路径落到磁盘上验证存在。
 *
 *   2) 加查真实打包产物(需要先 `npm pack --dry-run --json > pack.json`):
 *        node scripts/check-plugin-manifest.mjs --pack pack.json
 *      a. 清单引用的每个文件都必须真在 tarball 里 —— 这条**不**改写成自己实现的
 *         `files` glob 匹配器:谁真正决定发什么,就以谁的输出为准(npm 的语义里
 *         `files` 目录展开、`.npmignore` 覆盖、隐式必带项都很绕,仿写一份迟早和 npm 走叉)。
 *      b. 反向:包里不许出现 node_modules / .e2e / 截图 / 日志 —— 这些是「本机能跑、
 *         发出去就成垃圾」的东西,而且截图常带私有台账与真名。
 *
 * 退出码:0 = 通过;1 = 有漏项。
 * 用法:node scripts/check-plugin-manifest.mjs [--pack <file>] [-q]
 */
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const QUIET = argv.includes('-q') || argv.includes('--quiet')

function argValue(name) {
  const i = argv.indexOf(name)
  if (i === -1) return undefined
  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} 需要跟一个文件路径`)
    process.exit(2)
  }
  return value
}

const packPath = argValue('--pack')
const posix = p => p.split(sep).join('/')
const problems = []
const bad = message => problems.push(message)

/** package.json#files 之外的隐式必带项:npm 不论 files 怎么写都会带上它们。
 *  (只用于 `--pack` 模式下判断"这个文件该在包里",不用于正向展开 files) */
const ALWAYS_SHIPPED = new Set(['package.json', 'README.md', 'README', 'LICENSE', 'LICENCE', 'CHANGELOG.md'])

let pkg
try {
  pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
} catch (err) {
  console.error(`❌ 读不到 package.json:${err.message}`)
  process.exit(1)
}

// ── 身份 ────────────────────────────────────────────────────────────
if (typeof pkg.name !== 'string' || pkg.name.trim() === '') bad('package.json#name 是空的')
if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  bad(`package.json#version 不是 semver:${JSON.stringify(pkg.version ?? null)}`)
}
if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
  bad('package.json#files 缺省或为空 —— npm 会退回按 .gitignore 兜底,发出去是什么没人说得准')
}

// ── 被清单引用的路径:统一攒成 {label, 相对路径} 列表,两种模式共用 ──
/** @type {{label: string, rel: string}[]} */
const referenced = []
/** 记录一条相对包的引用;绝对路径 / 越界路径当场判死(装到用户机器上一定会解析到包外)。 */
function reference(label, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    bad(`${label} 不是非空字符串:${JSON.stringify(value)}`)
    return
  }
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    bad(`${label} 用了绝对路径 ${JSON.stringify(value)} —— 必须相对包根`)
    return
  }
  const rel = posix(relative(ROOT, resolve(ROOT, value)))
  if (rel.startsWith('../')) {
    bad(`${label} 指到包根之外:${JSON.stringify(value)}`)
    return
  }
  referenced.push({ label, rel })
}

const dsh = pkg.dsh
if (dsh === undefined || dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) {
  bad('package.json#dsh 缺失或不是对象 —— 这不是一个能被 DSH 认出的插件包')
} else {
  // manifestVersion 可省;写了就必须是 1(格式版本,不是包版本)
  if (dsh.manifestVersion !== undefined && dsh.manifestVersion !== 1) {
    bad(`dsh.manifestVersion 只认 1,这里是 ${JSON.stringify(dsh.manifestVersion)}`)
  }

  // bundle:profile launcher 消费的那层 patch。一个文件,或按序叠加的数组。
  if (dsh.bundle !== undefined) {
    const bundle = dsh.bundle
    if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
      bad('dsh.bundle 必须是对象')
    } else if (bundle.patch === undefined) {
      bad('dsh.bundle.patch 缺失 —— 没有 patch 的 bundle 挂载时不生效')
    } else if (Array.isArray(bundle.patch)) {
      if (bundle.patch.length === 0) bad('dsh.bundle.patch 是空数组')
      bundle.patch.forEach((entry, i) => reference(`dsh.bundle.patch[${i}]`, entry))
    } else {
      reference('dsh.bundle.patch', bundle.patch)
    }
  }

  // client:浏览器半边。platform 必填;inject / external / immediately 是可选开关。
  if (dsh.client !== undefined) {
    const client = dsh.client
    if (client === null || typeof client !== 'object' || Array.isArray(client)) {
      bad('dsh.client 必须是对象')
    } else {
      if (typeof client.platform !== 'string' || client.platform.trim() === '') {
        bad('dsh.client.platform 缺失 —— client-modules 按它选平台(Web 侧认 "web")')
      }
      for (const key of ['inject', 'external']) {
        if (client[key] === undefined) continue
        if (!Array.isArray(client[key]) || client[key].some(x => typeof x !== 'string' || x.trim() === '')) {
          bad(`dsh.client.${key} 必须是非空字符串数组`)
        }
      }
      if (client.immediately !== undefined && typeof client.immediately !== 'boolean') {
        bad('dsh.client.immediately 必须是布尔值')
      }
      // 真读方是 @deepseek-ai/dsh-client-modules:它只认 exports["./client"],
      // 接受字符串或 { default: 字符串 }。这里照它的规则核,别自创约定。
      const exported = pkg.exports?.['./client']
      const target = typeof exported === 'string'
        ? exported
        : (exported !== null && typeof exported === 'object' && typeof exported.default === 'string' ? exported.default : undefined)
      if (target === undefined) {
        bad('声明了 dsh.client,但 exports["./client"] 不是字符串也不是 { default: 字符串 } —— client-modules 会直接抛错')
      } else {
        reference('exports["./client"]', target)
      }
    }
  }

  // profile:组合声明。三个插件都不是 profile,但类型里有,写了就核一下。
  if (dsh.profile !== undefined) {
    const profile = dsh.profile
    if (profile !== null && typeof profile === 'object' && profile.bundles !== undefined) {
      if (!Array.isArray(profile.bundles) || profile.bundles.some(x => typeof x !== 'string' || x.trim() === '')) {
        bad('dsh.profile.bundles 必须是非空字符串数组')
      }
    }
  }
}

// 入口:装完 import 的就是它。
if (pkg.main !== undefined) reference('package.json#main', pkg.main)
if (typeof pkg.exports?.['.'] === 'string') reference('exports["."]', pkg.exports['.'])

// 图标:DSH 会把它读成 data URL,类型注释写明 ≤256 KiB 且 realpath 必须落在包根内。
if (pkg.icon !== undefined) {
  reference('package.json#icon', pkg.icon)
  const iconAbs = resolve(ROOT, String(pkg.icon))
  if (existsSync(iconAbs)) {
    const size = statSync(iconAbs).size
    if (size > 256 * 1024) bad(`icon 超过 256 KiB(${size} 字节)`)
    try {
      if (!posix(realpathSync(iconAbs)).startsWith(posix(realpathSync(ROOT)) + '/')) {
        bad(`icon 解析符号链接后跑出了包根:${pkg.icon}`)
      }
    } catch {
      /* realpath 失败留给下面的存在性检查报 */
    }
  }
}

// ── 模式 1:文件存在性 ─────────────────────────────────────────────
if (packPath === undefined) {
  for (const { label, rel } of referenced) {
    if (!existsSync(join(ROOT, rel))) bad(`${label} 指向的 ${rel} 在磁盘上不存在`)
  }
}

// ── 模式 2:真 tarball ─────────────────────────────────────────────
let packed
if (packPath !== undefined) {
  let raw
  try {
    raw = JSON.parse(readFileSync(resolve(packPath), 'utf8'))
  } catch (err) {
    console.error(`❌ 读不到 pack 产物 ${packPath}:${err.message}`)
    console.error('   先在仓库根跑:npm pack --dry-run --json > pack.json')
    process.exit(1)
  }
  const entry = Array.isArray(raw) ? raw[0] : raw
  if (entry === undefined || !Array.isArray(entry.files)) {
    console.error('❌ pack 产物里没有 files 数组 —— 不是 `npm pack --json` 的输出?')
    process.exit(1)
  }
  packed = entry.files.map(f => posix(String(f.path)))
  if (packed.length === 0) bad('tarball 是空的')

  const shipped = new Set(packed)
  for (const { label, rel } of referenced) {
    if (shipped.has(rel) || ALWAYS_SHIPPED.has(rel)) continue
    bad(`${label} 指向的 ${rel} 没进 tarball —— 补进 package.json#files,否则用户装完解析不到`)
  }

  // 反向:本机能跑、发出去就是垃圾/泄露的东西。
  // 截图最危险 —— 往往带着真实台账、会话标题、系统路径。
  const FORBIDDEN = [
    { test: p => p.split('/').includes('node_modules'), why: 'node_modules 不该进包(装的时候会重新装)' },
    { test: p => p.split('/').includes('.e2e'), why: '.e2e 是本地冒烟现场' },
    { test: p => /\.(png|jpe?g|webp)$/i.test(p), why: '截图不该进包(常带私有台账与路径;图标请用 svg)' },
    { test: p => /\.log$/i.test(p), why: '日志不该进包' },
    { test: p => p.split('/').includes('.DS_Store'), why: '.DS_Store 是 macOS 垃圾' },
  ]
  for (const path of packed) {
    for (const rule of FORBIDDEN) {
      if (rule.test(path)) bad(`tarball 里有 ${path} —— ${rule.why}`)
    }
  }
}

// ── 输出 ──────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error(`❌ 插件清单有 ${problems.length} 处问题:`)
  for (const problem of problems) console.error(`   ${problem}`)
  process.exit(1)
}
if (!QUIET) {
  const patches = dsh?.bundle?.patch === undefined ? [] : [].concat(dsh.bundle.patch)
  const bundle = patches.length === 0 ? '无' : patches.map(p => posix(String(p))).join(' + ')
  const client = dsh?.client === undefined ? '无' : String(dsh.client.platform)
  console.log(`✅ 插件清单通过:${pkg.name}@${pkg.version} bundle=${bundle} client=${client}`)
  if (packPath !== undefined) {
    console.log(`✅ 包内容通过:${packed.length} 个文件,清单引用的 ${referenced.length} 处全在包里,无 node_modules/.e2e/截图/日志`)
  }
}
process.exit(0)
