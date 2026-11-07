/**
 * 包契约清单的解析器:`docs/pack-schema.md` 里那些 ```schema 代码块就是门禁的输入。
 *
 * 为什么要单独一个文件:`tests/logic.mjs`(产方)与 `tests/compat.mjs`(读方)要按**同一份**
 * 清单核同一件事。两边各写一份解析器,迟早会出现"逻辑套件绿、兼容套件红"这种自相矛盾的场面。
 *
 * 块格式:
 *
 *   ```schema manifest.json v2 required
 *   schemaVersion
 *   kind
 *   ```
 *
 * 行首 `#` 是注释、空行忽略。同名块按 required / optional 各最多一个 —— 同一个键两边都写
 * 视为写错(直接抛,不静默取交集)。
 */
import { readFileSync } from 'node:fs'

export const SCHEMA_DOC = new URL('../docs/pack-schema.md', import.meta.url)

const OPEN = /^```schema[ \t]+(\S+)[ \t]+v(\d+)[ \t]+(required|optional)[ \t]*$/
const CLOSE = /^```[ \t]*$/

/**
 * 从 markdown 文本里抽清单。返回 `Map<名字, { name, version, required, optional }>`。
 * 语法错误一律抛 —— 这份文件是门禁的输入,写歪了不该"看起来没块"。
 */
export function parseSchemaBlocks(text, where = 'docs/pack-schema.md') {
	const lines = String(text).split('\n')
	const blocks = new Map()
	for (let i = 0; i < lines.length; i += 1) {
		const open = OPEN.exec(lines[i])
		if (open === null) continue
		const [, name, version, kind] = open
		const keys = []
		let closed = false
		for (let j = i + 1; j < lines.length; j += 1) {
			if (CLOSE.test(lines[j])) { closed = true; i = j; break }
			const line = lines[j].trim()
			if (line === '' || line.startsWith('#')) continue
			keys.push(line)
		}
		if (closed === false) throw new Error(`${where}:${i + 1} 的 \`\`\`schema ${name} 块没有闭合`)
		const block = blocks.get(name) ?? { name, version: null, required: [], optional: [] }
		if (block.version !== null && block.version !== Number(version)) {
			throw new Error(`${where}:${i + 1} 的 ${name} 版本号前后不一致(${block.version} vs ${version})`)
		}
		block.version = Number(version)
		if (block[kind].length > 0) throw new Error(`${where}:${i + 1} 的 ${name} 出现了第二个 ${kind} 块`)
		block[kind] = keys
		blocks.set(name, block)
	}
	for (const block of blocks.values()) {
		const both = block.required.filter((key) => block.optional.includes(key))
		if (both.length > 0) throw new Error(`${where}: ${block.name} 的键同时写成必需与可选:${both.join(' / ')}`)
		const dupes = block.required.filter((key, index) => block.required.indexOf(key) !== index)
		if (dupes.length > 0) throw new Error(`${where}: ${block.name} 的必需键重复:${dupes.join(' / ')}`)
	}
	return blocks
}

/**
 * 读仓库里的那份清单,给出断言要用的几个视图:
 *   `version(name)`        版本号
 *   `required(name)`       必需键(缺了就是坏包)
 *   `optional(name)`       老包可能没有的键
 *   `keys(name)`           必需 + 可选(= 当前代码应当产出的键集合)
 */
export function loadPackSchema() {
	const blocks = parseSchemaBlocks(readFileSync(SCHEMA_DOC, 'utf8'))
	const get = (name) => {
		const block = blocks.get(name)
		if (block === undefined) throw new Error(`docs/pack-schema.md 里没有 \`\`\`schema ${name} 块`)
		return block
	}
	return {
		blocks,
		names: () => [...blocks.keys()],
		version: (name) => get(name).version,
		required: (name) => get(name).required.slice(),
		optional: (name) => get(name).optional.slice(),
		keys: (name) => [...get(name).required, ...get(name).optional],
	}
}
