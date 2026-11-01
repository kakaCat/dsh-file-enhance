#!/usr/bin/env node
/**
 * 默认规则的「杀伤面」校准——拿一批真实仓库的 docs/ 跑判定链，回答两个问题：
 *
 *   1. 已存在的文档会被怎么判？（会不会一装就满屏打回）
 *   2. 新建一份典型文档会被归到哪？（换个项目，规则还准不准）
 *
 * 判定用的是**随包内置默认**（不读这些仓库自己的 .dsh/，否则测的就不是默认值了）。
 * 之所以要「现实目录树」：判定链第一原则是目录现状优先，不给 tree 会把所有已存在的
 * 子目录误判成未知分类——第一版脚本就是这么错的。
 *
 * 用法（需先 pnpm build，脚本从 dist 取判定链）：
 *   node scripts/calibrate-defaults.mjs ../dsh-pmboard ../dsh-dataforge
 *   node scripts/calibrate-defaults.mjs --new ../dsh-pmboard      # 只跑「新建典型文档」这一半
 *
 * 结果只用于校准默认值，不进测试断言：仓库内容会变，数字会漂。
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RulesStore, decide } from '../dist/index.mjs'

const IGNORE = new Set(['node_modules', '.git', '.DS_Store'])
const args = process.argv.slice(2)
const onlyNew = args.includes('--new')
const repos = args.filter((a) => !a.startsWith('--')).map((p) => resolve(p))
if (repos.length === 0) {
  console.error('用法：node scripts/calibrate-defaults.mjs [--new] <仓库根…>')
  process.exit(1)
}

// 与 src/folder-path/scan.ts 的 scanReality 同构：还原「docs/ 现状」
function scanReality(rootAbs) {
  let entries
  try { entries = readdirSync(rootAbs, { withFileTypes: true }) } catch {
    return { exists: false, empty: true, dirs: [], files: [] }
  }
  const dirs = []
  const files = []
  for (const e of entries) {
    if (IGNORE.has(e.name) || e.name.startsWith('.')) continue
    if (e.isDirectory()) {
      const abs = join(rootAbs, e.name)
      let kids = []
      try { kids = readdirSync(abs, { withFileTypes: true }) } catch { /* 空目录 */ }
      const children = kids.filter((c) => c.isFile() && !c.name.startsWith('.')).map((c) => c.name)
      const subdirs = kids.filter((c) => c.isDirectory() && !c.name.startsWith('.')).map((c) => c.name)
      dirs.push({ name: e.name, abs, fileCount: children.length, samples: children.slice(0, 3), subdirs: subdirs.slice(0, 10) })
    } else if (e.isFile()) {
      files.push(e.name)
    }
  }
  return { exists: true, empty: dirs.length === 0 && files.length === 0, dirs, files, names: dirs.map((d) => d.name) }
}

const walk = (dir, out = []) => {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (IGNORE.has(e.name) || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p)
  }
  return out
}

const store = new RulesStore({ workspaceRoot: process.cwd(), fallback: true })
// 用一个不存在的工作区取「内置默认」：load 会回落到 DEFAULT_MD_RULES_YAML
const builtin = store.load('md', join(process.cwd(), '__no_such_workspace__', '.dsh'))
const listNames = (dir) => { try { return readdirSync(dir) } catch { return [] } }

/** 典型的新建文档名：覆盖产品 / 指南 / 设计 / 决策 / 调研 / 接口 / 无主题词。 */
const SAMPLE_NAMES = [
  'prd-登录优化.md', '产品需求-订单.md',
  '指南-部署.md', 'guide-deploy.md',
  '设计-缓存方案.md', 'adr-0007-选型.md',
  '调研-竞品分析.md', 'research-选型.md',
  'api-支付接口.md',
  'notes.md', 'meeting-2026-11-01.md',
]

/** 新文件模拟用的「已存在 docs 结构」：guides / adr / research 三个真实目录。 */
const sampleTree = (root) => ({
  exists: true, empty: false, files: ['README.md'], names: ['guides', 'adr', 'research'],
  dirs: ['guides', 'adr', 'research'].map((name) => ({
    name, abs: join(root, 'docs', name), fileCount: 2, samples: [], subdirs: [],
  })),
})

if (!onlyNew) {
  let T = { total: 0, pass: 0, correct: 0, deny: 0 }
  for (const root of repos) {
    const docsDir = join(root, 'docs')
    try { statSync(docsDir) } catch { continue }
    const tree = scanReality(docsDir)
    const s = { total: 0, pass: 0, correct: 0, deny: 0, codes: {} }
    for (const abs of walk(docsDir)) {
      s.total++
      const v = decide({ target: abs, workspaceRoot: root, loaded: builtin, tree, priorDenials: 0, listNames })
      if (v.kind === 'pass') s.pass++
      else if (v.kind === 'correct') { s.correct++; s.codes[v.code] = (s.codes[v.code] ?? 0) + 1 }
      else { s.deny++; s.codes[v.code] = (s.codes[v.code] ?? 0) + 1 }
    }
    T.total += s.total; T.pass += s.pass; T.correct += s.correct; T.deny += s.deny
    const pct = (n) => `${String(Math.round((n / Math.max(1, s.total)) * 100)).padStart(3)}%`
    console.log(`${relative(process.cwd(), root).padEnd(22)} ${String(s.total).padStart(5)} 份｜放行 ${pct(s.pass)} 纠偏 ${pct(s.correct)} 打回 ${pct(s.deny)}  ${JSON.stringify(s.codes)}`)
  }
  const pct = (n) => `${String(Math.round((n / Math.max(1, T.total)) * 100)).padStart(3)}%`
  console.log('-'.repeat(96))
  console.log(`合计 ${T.total} 份已存在文档：放行 ${pct(T.pass)}｜会被纠偏 ${pct(T.correct)}｜会被打回 ${pct(T.deny)}`)
}

if (!onlyNew || args.includes('--new')) {
  const root = repos[0]
  const tree = sampleTree(root)
  console.log(`\n新建典型文档（${relative(process.cwd(), root)}）：`)
  for (const name of SAMPLE_NAMES) {
    const v = decide({ target: join(root, 'docs', name), workspaceRoot: root, loaded: builtin, tree, priorDenials: 0, listNames })
    const where = v.kind === 'correct'
      ? v.to.replace(root + '/', '')
      : v.kind === 'deny' ? `✗ ${v.code}` : '✓ 原样放行'
    console.log(`  ${name.padEnd(22)} ${where}`)
  }
}
