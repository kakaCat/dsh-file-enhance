#!/usr/bin/env node
/**
 * dist 装载冒烟——在 `pnpm build` 之后跑，防止「构建成功但装不上」。
 *
 * 构建通过只说明 tsdown 没报错；插件能不能被宿主装载，取决于四件事，本脚本逐条断言：
 *   1. package.json 声明的入口 / 类型文件真实存在（`files` 白名单里也得带上，否则 pack 漏发）；
 *   2. 产物导出的插件契约齐全（`name` / `inject` / `apply`）+ 对外 API 齐全；
 *   3. bundle patch 能被解析，插入行的 id 与包名一致（宿主按这个 id 装载插件）；
 *   4. 插件清单本地化文件合法（宿主读 `locale/en.json` 拿兜底文案，任一文件坏了都会退化成无元数据）。
 *
 * 用法：pnpm check:dist（CI 在 build 之后跑同一条）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

/** 记录一条断言结果。 */
function check(ok, message) {
  if (!ok) failures.push(message)
}

/** 相对仓库根解析路径。 */
const at = (...parts) => join(root, ...parts)

const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8'))

// ① 入口与类型在盘上；files 白名单覆盖它们。
const main = pkg.main
const types = pkg.types
check(typeof main === 'string', 'package.json 缺 main')
check(typeof types === 'string', 'package.json 缺 types')
for (const [label, rel] of [['main', main], ['types', types]]) {
  if (typeof rel !== 'string') continue
  check(existsSync(resolve(root, rel)), `${label} 指向的文件不存在：${rel}（先跑 pnpm build）`)
}
const files = Array.isArray(pkg.files) ? pkg.files : []
for (const entry of ['dist', 'locale']) {
  check(files.includes(entry), `package.json 的 files 未包含 ${entry}/，pack 会漏发`)
}

// ② 产物导出的插件契约与对外 API。
const mod = await import(pathToFileURL(resolve(root, main)).href)
check(mod.name === pkg.name, `导出的 name 与包名不一致：${String(mod.name)} ≠ ${pkg.name}`)
check(Array.isArray(mod.inject), '导出的 inject 不是数组')
check(typeof mod.apply === 'function', '导出的 apply 不是函数（宿主装载入口）')
for (const name of ['RulesStore', 'decide', 'createFileEnhanceService', 'FileEnhanceError']) {
  check(typeof mod[name] === 'function', `产物缺少对外导出：${name}`)
}

// ③ bundle patch：宿主按 patch 里的 id 装载，写错就静默不加载。
const patchPath = at('cordis.patch.yml')
check(existsSync(patchPath), '缺 cordis.patch.yml（宿主的装载清单）')
if (existsSync(patchPath)) {
  let rows
  try {
    rows = yaml.load(readFileSync(patchPath, 'utf8'))
  } catch (err) {
    failures.push(`cordis.patch.yml 不是合法 YAML：${String(err.message ?? err)}`)
  }
  const inserted = Array.isArray(rows) ? rows.flatMap((row) => (Array.isArray(row?.insert) ? row.insert : [])) : []
  const row = inserted.find((r) => r?.id === pkg.name)
  check(row !== undefined, `cordis.patch.yml 没有插入 id=${pkg.name} 的行`)
  check(row?.name === pkg.name, `patch 行 name 与包名不一致：${String(row?.name)}`)
}

// ④ 插件清单本地化：宿主的读取契约是「有 locale/en.json 才读同目录其它语言」，
//    每个文件的 meta.title / meta.description 必须是非空字符串，否则整份元数据退化。
const localeDir = at('locale')
check(existsSync(join(localeDir, 'en.json')), 'locale/en.json 缺失（宿主以它作为语言目录的锚点）')
if (existsSync(localeDir)) {
  for (const name of readdirSync(localeDir)) {
    if (!name.endsWith('.json')) continue
    const language = name.slice(0, -5)
    check(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language), `locale/${name} 文件名不是语言 id`)
    let meta
    try {
      meta = JSON.parse(readFileSync(join(localeDir, name), 'utf8'))
    } catch (err) {
      failures.push(`locale/${name} 不是合法 JSON：${String(err.message ?? err)}`)
      continue
    }
    for (const field of ['title', 'description']) {
      const value = meta?.meta?.[field]
      check(typeof value === 'string' && value.trim() !== '', `locale/${name} 的 meta.${field} 必须是非空字符串`)
    }
  }
}

if (failures.length > 0) {
  console.error('✗ dist 冒烟未通过：')
  for (const message of failures) console.error('  - ' + message)
  process.exit(1)
}

console.log(`✓ dist 冒烟通过：${pkg.name}@${pkg.version} → ${main}（插件契约、对外导出、bundle patch 均可用）`)
