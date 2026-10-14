/**
 * 插件暴露给 agent 的四个工具。
 *
 * - `file_resolve`     建文件前问「该放哪、叫什么、套什么模板」（含集合型编号分配）
 * - `file_propose`     规则表没有合适分类时，提议新增一条（弹框请用户批准后写入 yaml）
 * - `file_check`       事后巡检：某个文件/整个主目录有没有野文件
 * - `file_rules_init`  冷启动：把示例规则落到 `.dsh/file-rules/md.yaml`
 *
 * @module dsh-file-guide/tools
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { bestCategory, renderDest, targetsOf } from './decide.js'
import { matchesNaming, slugify, stemOf, toAbs } from './paths.js'
import { listNames, scanReality } from './scan.js'
import type { RulesStore } from './rules.js'
import type { RuleCategory, RuleTarget } from './types.js'

export interface AskQuestion {
  id: string
  question: string
  header?: string
  options?: Array<{ label: string; description?: string }>
}
export interface AskAnswer { id: string; selected: string[]; custom?: string }
export type AskFn = (questions: AskQuestion[]) => Promise<AskAnswer[]>

export interface ToolsDeps {
  /** 用户问答通道（userQuestions 服务）；不可用时 file_propose 退化为「待批准队列」。 */
  ask?: AskFn
}

interface ResolveArgs {
  ext?: string
  description?: string
  subject?: string
  category?: string
  project_id?: string
}

const asObj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? v as Record<string, unknown> : {})
const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** 集合型编号分配：扫实例目录，取 `<PREFIX>-<n>` 的 max+1。 */
export function allocateInstance(rootAbs: string, folder: string, sample: string): string {
  const prefix = (/^([A-Za-z]+)-/.exec(sample)?.[1]) ?? 'PRJ'
  const dirAbs = join(rootAbs, folder)
  let max = 0
  for (const n of listNames(dirAbs)) {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(n)
    if (m !== null) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

export function defineFileResolveTool(store: RulesStore, deps: ToolsDeps = {}) {
  void deps
  return defineTool({
    name: 'file_resolve',
    description: [
      '创建文件前先调用：按项目规范（.dsh/file-rules/<ext>.yaml）解析出该文件的**落点路径、命名与内容模板**。',
      '用 description 描述你要写什么（自然语言），或直接给 category；集合型分类（如项目文档）可传 project_id，',
      '缺省时由插件自动分配编号并建出骨架目录。返回的 path 直接用于 write，不要自己拼路径。',
    ].join(''),
    parameters: {
      ext: { type: 'string', description: '文件类型扩展名键（默认 md）' },
      description: { type: 'string', description: '你要创建的文件是什么（自然语言，如「登录功能的设计文档」）' },
      subject: { type: 'string', description: '文件主题词（用于生成文件名，如 "login-flow"）' },
      category: { type: 'string', description: '已知的分类键或变体键（如 guides / design），可省略由 description 推断' },
      project_id: { type: 'string', description: '集合型分类的实例编号（如项目的 PRJ-0001）；缺省时按规则自动分配' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string', description: '规范落点（相对工作区）' },
          category: { type: 'string' },
          naming: { type: 'string' },
          project_id: { type: 'string' },
          template: { type: 'string', description: '内容模板全文（若规则配了 template）' },
          candidates: { type: 'array', items: { type: 'string' }, description: '候选分类（未命中时给出）' },
          message: { type: 'string' },
        },
      },
    },
    execute: async (raw: unknown) => {
      const args = asObj(raw) as ResolveArgs
      const ext = asStr(args.ext) ?? 'md'
      const loaded = store.load(ext)
      if (loaded === undefined) {
        return { ok: false, message: `本项目没有 ${ext} 的规则文件（.dsh/file-rules/${ext}.yaml），该类型文件不受约束。` }
      }
      if ('error' in loaded) return { ok: false, message: `规则文件非法：${loaded.error}（${loaded.path}）` }
      const rules = loaded.rules
      const rootAbs = toAbs(store.workspaceRoot, rules.root)
      const allTargets = Object.values(rules.categories).flatMap((c) => targetsOf(c))
      const text = [args.description, args.subject, args.category].filter((s) => typeof s === 'string').join(' ')
      let target: RuleTarget | undefined
      if (asStr(args.category) !== undefined) {
        target = allTargets.find((t) => t.key === args.category)
          ?? allTargets.find((t) => t.folder === args.category)
      }
      target ??= bestCategory(text, allTargets)
      if (target === undefined) {
        return {
          ok: false,
          candidates: allTargets.map((t) => `${t.key} → ${rules.root}/${t.folder}/`),
          message: '没有匹配的分类。请从 candidates 里选择，或调 file_propose 提议新分类。',
        }
      }

      const cat: RuleCategory = target.parent
      const slug = slugify(args.subject ?? args.description ?? 'untitled')
      const vars: Record<string, string> = { slug, folder: cat.folder, root: rules.root }

      if (cat.kind === 'collection' && cat.instance !== undefined) {
        const param = cat.instance.param
        let instance = asStr(args[param as keyof ResolveArgs]) ?? asStr(args.project_id)
        if (instance === undefined) {
          if (cat.instance.acquire !== 'auto') {
            return { ok: false, message: `该分类需要先提供 ${param}（规则未允许自动分配）。` }
          }
          instance = allocateInstance(rootAbs, cat.folder, `${param === 'project_id' ? 'PRJ' : 'ID'}-0001`)
          for (const scaffold of cat.instance.scaffold) {
            mkdirSync(join(rootAbs, cat.folder, instance, scaffold), { recursive: true })
          }
        } else if (cat.instance.pattern !== undefined && !new RegExp(cat.instance.pattern).test(instance)) {
          return { ok: false, message: `${param}「${instance}」不符合 ${cat.instance.pattern}；留空由插件分配即可。` }
        }
        vars[param] = instance
        const dest = target.dest ?? `${cat.folder}/${param === 'project_id' ? '{project_id}' : '{' + param + '}'}/{slug}.${ext}`
        const path = join(rootAbs, renderDest(dest, vars, { rootAbs, listNames }))
        return {
          ok: true,
          path: relative(store.workspaceRoot, path),
          category: `${cat.key}.${target.key}`,
          naming: target.naming,
          [param]: instance,
          template: readTemplate(store, target),
        }
      }

      const dest = target.dest ?? `${cat.folder}/{slug}.${ext}`
      const path = join(rootAbs, renderDest(dest, vars, { rootAbs, listNames }))
      return {
        ok: true,
        path: relative(store.workspaceRoot, path),
        category: target.key,
        naming: target.naming,
        template: readTemplate(store, target),
      }
    },
  } as never)
}

function readTemplate(store: RulesStore, target: RuleTarget): string | undefined {
  if (target.template === undefined) return undefined
  const abs = toAbs(store.dir, target.template)
  try {
    return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined
  } catch {
    return undefined
  }
}

interface ProposeArgs { ext?: string; key?: string; folder?: string; dest?: string; keywords?: string; reason?: string; naming?: string }

export function defineFileProposeTool(store: RulesStore, deps: ToolsDeps = {}) {
  return defineTool({
    name: 'file_propose',
    description: [
      '当现有分类都不适合时，向**用户**提议新增一条文件分类（写入 .dsh/file-rules/<ext>.yaml）。',
      '用户批准后规则立即生效，之后同类文件直接按新分类落盘。不要用它绕过已有分类。',
    ].join(''),
    parameters: {
      ext: { type: 'string', description: '文件类型扩展名键（默认 md）' },
      key: { type: 'string', description: '新分类键（如 retro）', required: true },
      folder: { type: 'string', description: '主目录下的文件夹名（缺省 = key）' },
      dest: { type: 'string', description: '落点模板（缺省 "{folder}/{slug}.<ext>"）' },
      keywords: { type: 'string', description: '关键词，逗号分隔（用于后续自动归位）' },
      naming: { type: 'string', description: '命名风格（默认 kebab-case）' },
      reason: { type: 'string', description: '为什么需要这个分类（给用户看）', required: true },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} } },
    execute: async (raw: unknown) => {
      const args = asObj(raw) as ProposeArgs
      const ext = asStr(args.ext) ?? 'md'
      const key = asStr(args.key)
      if (key === undefined) return { ok: false, message: '缺少 key' }
      const folder = asStr(args.folder) ?? key
      const category = {
        folder,
        dest: asStr(args.dest) ?? `${folder}/{slug}.${ext}`,
        keywords: (asStr(args.keywords) ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        naming: asStr(args.naming) ?? 'kebab-case',
      }
      const question = {
        id: 'file_propose',
        header: '新增文件分类',
        question: `是否新增分类「${key}」→ ${folder}/（${category.dest}）？理由：${asStr(args.reason) ?? '(未说明)'}`,
        options: [
          { label: '批准（写入规则）', description: '立即写进 .dsh/file-rules 并生效' },
          { label: '拒绝', description: '不新增，agent 需要另选分类' },
        ],
      }
      if (deps.ask === undefined) {
        return {
          ok: false,
          pending: true,
          proposal: { ext, key, ...category },
          message: '当前没有用户问答通道：请把这条提议转述给用户，用户同意后再手工写入规则，或再次调用本工具。',
        }
      }
      const answers = await deps.ask([question])
      const chosen = answers[0]?.selected?.[0] ?? answers[0]?.custom ?? ''
      if (!chosen.startsWith('批准')) return { ok: false, message: '用户未批准该分类。', answer: chosen }
      const written = store.appendCategory(ext, key, category)
      return { ok: true, written: written.changed, rules_file: relative(store.workspaceRoot, written.path), key, folder }
    },
  } as never)
}

interface CheckArgs { path?: string; ext?: string }

export function defineFileCheckTool(store: RulesStore) {
  return defineTool({
    name: 'file_check',
    description: '巡检文件是否合规：给 path 查单个文件；不给则扫主目录，列出「野文件」（不在任何分类目录里、或命名不合规的既有文件）。',
    parameters: {
      path: { type: 'string', description: '要检查的文件路径（相对工作区）；省略则扫整个主目录' },
      ext: { type: 'string', description: '文件类型扩展名键（默认 md）' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} } },
    execute: async (raw: unknown) => {
      const args = asObj(raw) as CheckArgs
      const ext = asStr(args.ext) ?? 'md'
      const loaded = store.load(ext)
      if (loaded === undefined || 'error' in loaded) {
        return { ok: false, message: loaded === undefined ? `没有 ${ext} 的规则文件` : `规则文件非法：${loaded.error}` }
      }
      const rules = loaded.rules
      const rootAbs = toAbs(store.workspaceRoot, rules.root)
      const p = asStr(args.path)
      if (p !== undefined) {
        const abs = toAbs(store.workspaceRoot, p)
        const rel = relative(rootAbs, abs)
        if (rel.startsWith('..')) {
          const inRoot = relative(store.workspaceRoot, abs)
          const atRoot = dirname(inRoot) === '.'
          return { ok: true, path: p, compliant: false, code: atRoot ? 'root-forbidden' : 'outside-root' }
        }
        const parts = rel.split(/[/\\]+/).filter(Boolean)
        const cat = Object.values(rules.categories).find((c) => c.folder === parts[0])
        const naming = cat !== undefined && parts.length >= 2 ? matchesNaming(cat.naming, stemOf(parts[parts.length - 1] ?? '')) : undefined
        return {
          ok: true, path: p, compliant: cat !== undefined && naming !== false,
          category: cat?.key, naming_ok: naming, in_root: true,
        }
      }
      const tree = scanReality(rootAbs)
      const strays: Array<Record<string, unknown>> = []
      for (const f of tree.files) {
        if (new RegExp(`\\.${ext}$`, 'i').test(f)) strays.push({ path: `${rules.root}/${f}`, code: 'unclassified' })
      }
      const knownFolders = new Set(Object.values(rules.categories).map((c) => c.folder))
      for (const d of tree.dirs) {
        if (!knownFolders.has(d.name)) {
          strays.push({ path: `${rules.root}/${d.name}/`, code: 'unknown-category', fileCount: d.fileCount })
        }
      }
      return { ok: true, root: rules.root, dirs: tree.dirs.map((d) => `${d.name}(${d.fileCount})`), strays, stray_count: strays.length }
    },
  } as never)
}

export const EXAMPLE_MD_RULES = `# .dsh/file-rules/md.yaml —— markdown 文件的分类规范（由 dsh-file-guide 读取）
#
# 字段：
#   root        该类型文件的主目录（md → docs）
#   root_allow  根目录白名单（追加在内置默认 README/CHANGELOG/CLAUDE/AGENTS… 之上）
#   categories  分类表：folder = root 下的目录名；dest = 相对 root 的落点模板
#               模板占位符：{slug} {folder} {root} {auto_number:4} {project_id}
#               kind: collection 表示「集合型」（先有实例编号文件夹，再有文件）
type: md
root: docs
root_allow: []

categories:
  guides:
    folder: guides
    keywords: [指南, 教程, guide, tutorial, howto]
    dest: "guides/{slug}.md"

  api:
    folder: api
    keywords: [接口, api, 接口文档, endpoint]
    dest: "api/{slug}.md"

  adr:
    folder: adr
    keywords: [决策, adr, decision, 取舍]
    dest: "adr/{auto_number:4}-{slug}.md"

  project:
    folder: projects
    kind: collection
    keywords: [项目, 需求, 设计, 计划, prd]
    instance:
      param: project_id
      pattern: "^PRJ-\\\\d{4}$"
      acquire: auto
      scaffold: [requirement/, design/, plan/]
    variants:
      requirement:
        keywords: [需求, requirement, prd]
        dest: "projects/{project_id}/requirement/{slug}.md"
      design:
        keywords: [设计, design, 方案]
        dest: "projects/{project_id}/design/{slug}.md"
      plan:
        keywords: [计划, plan, 拆分, 排期]
        dest: "projects/{project_id}/plan/{slug}.md"
`

export function defineFileRulesInitTool(store: RulesStore) {
  return defineTool({
    name: 'file_rules_init',
    description: '冷启动：把一份示例规则写入 .dsh/file-rules/md.yaml（已存在则不动），之后请用户按项目习惯增删分类。',
    parameters: {
      ext: { type: 'string', description: '规则类型键（默认 md）' },
      force: { type: 'boolean', description: 'true = 覆盖已存在的规则文件（危险）' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} } },
    execute: async (raw: unknown) => {
      const args = asObj(raw) as { ext?: string; force?: boolean }
      const ext = asStr(args.ext) ?? 'md'
      const path = join(store.dir, `${ext}.yaml`)
      if (existsSync(path) && args.force !== true) {
        return { ok: true, created: false, rules_file: relative(store.workspaceRoot, path), message: '规则已存在，未改动。' }
      }
      mkdirSync(store.dir, { recursive: true })
      writeFileSync(path, EXAMPLE_MD_RULES, 'utf8')
      return { ok: true, created: true, rules_file: relative(store.workspaceRoot, path), message: '示例规则已写入，请用户按项目习惯调整分类。' }
    },
  } as never)
}
