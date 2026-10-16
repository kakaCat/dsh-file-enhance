/**
 * 格式规范加载器——.dsh/file-format-specs/<type>/，**一个文档类型一个文件夹**。
 *
 * 每个类型目录：spec.yaml（规范）+ template.md（骨架，可选）。
 * name 默认取目录名；template 默认取同目录 template.md（存在时）。
 * 缓存按目录内各文件 mtime 签名失效，改文件即生效。
 * @module dsh-file-enhance/content-format/spec
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import { toAbs } from '../folder-path/paths.js'
import { matchSpec } from './match.js'
import { BUILTIN_SPECS } from './builtin-specs.js'
import type { DiffMode, EnforceOn, FormatSpec, OnExhausted, SpecMode } from './types.js'
import type { Derive, FunctionDef, Rule } from './rules/types.js'

export const FORMAT_DIR_REL = '.dsh/file-format-specs'
export const SPEC_FILE = 'spec.yaml'
export const SPEC_FILE_ALT = 'spec.yml'
export const TEMPLATE_FILE = 'template.md'
/** 预留：填好的参考文档（约定文件名，尚未接入打回文本）。 */
export const EXAMPLE_FILE = 'example.md'

interface LoggerLike { info?: (m: string) => void; warn?: (m: string) => void; debug?: (m: string) => void }

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 规则引擎字段归一化（缺项补默认，非法项丢弃）。 */
function normalizeRuleField(raw: unknown, specName: string, i: number): Rule {
  const r = isObj(raw) ? raw : {}
  const id = typeof r.id === 'string' && r.id !== '' ? r.id : specName + ':rule-' + (i + 1)
  const rule: Rule = { id, assert: (r.assert ?? r.require ?? true) as Rule['assert'] }
  if (typeof r.enabled === 'boolean') rule.enabled = r.enabled
  if (r.severity === 'warning') rule.severity = 'warning'
  if (r.when !== undefined) rule.when = r.when as Rule['when']
  if (typeof r.message === 'string') rule.message = r.message
  if (typeof r.key === 'string') rule.key = r.key
  if (typeof r.priority === 'number') rule.priority = r.priority
  return rule
}

function normalizeRulesField(raw: unknown, specName: string): Rule[] {
  return Array.isArray(raw) ? raw.map((r, i) => normalizeRuleField(r, specName, i)) : []
}

function normalizeDeriveField(raw: unknown): Derive[] {
  if (!Array.isArray(raw)) return []
  const out: Derive[] = []
  for (const item of raw) {
    if (!isObj(item) || typeof item.fact !== 'string' || item.fact === '') continue
    const d: Derive = { fact: item.fact }
    if (typeof item.fn === 'string') d.fn = item.fn
    if (Array.isArray(item.args)) d.args = item.args
    if (typeof item.expr === 'string') d.expr = item.expr
    if (typeof item.script === 'string') d.script = item.script
    if ('value' in item) d.value = item.value
    out.push(d)
  }
  return out
}

function normalizeFunctionsField(raw: unknown): Record<string, FunctionDef> {
  if (!isObj(raw)) return {}
  const out: Record<string, FunctionDef> = {}
  for (const [name, def] of Object.entries(raw)) {
    if (!isObj(def)) continue
    const f: FunctionDef = {}
    if (typeof def.expr === 'string') f.expr = def.expr
    if (typeof def.script === 'string') f.script = def.script
    if (Array.isArray(def.args)) f.args = def.args.map(String)
    out[name] = f
  }
  return out
}

/** 目录名等外部来源补的默认值。 */
export interface SpecDefaults {
  /** 类型目录名 → name。 */
  name?: string
  /** 同目录 template.md 存在时自动填。 */
  template?: string
  /** 同目录 example.md 存在时自动填。 */
  example?: string
}

/** yaml 文档 → 归一化 spec（缺项补默认，非法项抛错）。 */
export function normalizeSpec(doc: unknown, path: string, defaults: SpecDefaults = {}): FormatSpec {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('顶层必须是对象')
  const d = doc as Record<string, unknown>
  const name = typeof d.name === 'string' && d.name !== '' ? d.name : defaults.name
  if (name === undefined) throw new Error('缺少 name（也没能从类型目录名推断）')
  if (d.checks !== undefined) throw new Error('checks 字段已移除：请改用 rules，内置原语用 { fn: <name> } 调用')
  const rawMatch = d.match
  const match = Array.isArray(rawMatch) ? rawMatch.map(String) : typeof rawMatch === 'string' ? [rawMatch] : []
  const rawMatchPath = d.match_path
  const matchPath = Array.isArray(rawMatchPath) ? rawMatchPath.map(String) : typeof rawMatchPath === 'string' ? [rawMatchPath] : []
  if (match.length === 0 && matchPath.length === 0) {
    throw new Error('缺少 match（文件名模式，如 "requirement.md"）或 match_path（相对路径模式，如 "**/design/**/*.md"）')
  }

  const rules = normalizeRulesField(d.rules, name)
  const derive = normalizeDeriveField(d.derive)
  const functions = normalizeFunctionsField(d.functions)

  const mode: SpecMode = d.mode === 'warn' || d.mode === 'off' ? d.mode : 'block'
  const rawEnforce = d.enforce_on
  const enforceOn: EnforceOn[] = Array.isArray(rawEnforce)
    ? rawEnforce.map(String).filter((x): x is EnforceOn => x === 'create' || x === 'update')
    : ['create', 'update']
  const diffMode: DiffMode = d.diff_mode === 'strict' ? 'strict' : 'delta'
  const maxAttempts = typeof d.max_attempts === 'number' && d.max_attempts > 0 ? Math.floor(d.max_attempts) : 3
  const onExhausted: OnExhausted = d.on_exhausted === 'block' ? 'block' : 'allow'
  const template = typeof d.template === 'string' && d.template !== '' ? d.template : defaults.template
  const example = typeof d.example === 'string' && d.example !== '' ? d.example : defaults.example

  return {
    name,
    ext: typeof d.ext === 'string' && d.ext !== '' ? d.ext : undefined,
    priority: typeof d.priority === 'number' ? d.priority : 0,
    match,
    matchPath,
    template,
    example,
    mode,
    enforceOn: enforceOn.length > 0 ? enforceOn : ['create', 'update'],
    diffMode,
    maxAttempts,
    onExhausted,
    rules,
    derive,
    functions,
    path,
    dir: dirname(path),
  }
}

export interface FormatStoreOptions {
  workspaceRoot?: string
  logger?: LoggerLike
  /**
   * 冷启动垫片：**默认 true**。规范目录完全为空时，把内置默认规范（BUILTIN_SPECS，
   * 与 examples/file-format-specs/ 逐字节一致）写入 `.dsh/file-format-specs/<type>/`。
   * 工作区一旦有了自己的规范（哪怕只保留一个类型）→ 绝不复活被删的类型、绝不覆盖。
   */
  scaffold?: boolean
}

/** 规范目录下的类型子目录名（_ 前缀 = 草稿，跳过）。 */
export function typeDirs(specsDir: string): string[] {
  if (!existsSync(specsDir)) return []
  try {
    return readdirSync(specsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort()
  } catch { return [] }
}

function specFileIn(dir: string): string | undefined {
  for (const f of [SPEC_FILE, SPEC_FILE_ALT]) {
    const p = join(dir, f)
    if (existsSync(p)) return p
  }
  return undefined
}

/** 读一个规范目录：每个类型子目录一份 spec（+ 约定的 template.md）。非法类型跳过并告警。 */
export function readSpecDir(specsDir: string, logger?: LoggerLike): FormatSpec[] {
  const out: FormatSpec[] = []
  for (const name of typeDirs(specsDir)) {
    const dir = join(specsDir, name)
    const specPath = specFileIn(dir)
    if (specPath === undefined) { logger?.warn?.('format spec ' + name + '/ 缺 ' + SPEC_FILE + '，已跳过'); continue }
    const template = existsSync(join(dir, TEMPLATE_FILE)) ? TEMPLATE_FILE : undefined
    const example = existsSync(join(dir, EXAMPLE_FILE)) ? EXAMPLE_FILE : undefined
    try {
      out.push(normalizeSpec(yaml.load(readFileSync(specPath, 'utf8')), specPath, { name, template, example }))
    } catch (err) {
      logger?.warn?.('format spec ' + name + '/ 非法——' + String((err as Error)?.message ?? err))
    }
  }
  return out
}

export class FormatStore {
  /** 回落默认根（构造时取 process.cwd()）；实际匹配按调用传入的 root（宿主 workingDirectory 服务按 agent 解析）。 */
  readonly workspaceRoot: string
  private readonly logger?: LoggerLike
  private readonly scaffold: boolean
  private cache = new Map<string, { signature: string; specs: FormatSpec[] }>()
  /** 已确认/已垫片的工作区根（每根一次：垫片失败或用户已自有规范都不会反复尝试）。 */
  private scaffoldSeen = new Set<string>()

  constructor(options: FormatStoreOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd()
    this.logger = options.logger
    this.scaffold = options.scaffold !== false
  }

  /** 规范目录（绝对路径）。 */
  dirOf(root: string): string {
    return toAbs(root, FORMAT_DIR_REL)
  }

  /** 回落默认根下的规范目录（仅用于展示；匹配请走 dirOf(root)）。 */
  get dir(): string {
    return this.dirOf(this.workspaceRoot)
  }

  /**
   * 冷启动垫片：规范目录**完全为空**时写入内置默认规范。
   *
   * 与路径子系统同一套边界：目录里已有任何类型（哪怕用户删过其中几个）→ 不动，不复活；
   * 单文件写入用 wx，竞态/已存在不覆盖。垫片失败静默（校验照常按空规范放行）。
   */
  scaffoldDefaults(root?: string): { created: boolean; dir: string; types: string[] } {
    const base = root ?? this.workspaceRoot
    const dir = this.dirOf(base)
    const types: string[] = []
    if (existsSync(dir) && typeDirs(dir).length > 0) return { created: false, dir, types }
    try {
      for (const [name, builtin] of Object.entries(BUILTIN_SPECS)) {
        const d = join(dir, name)
        mkdirSync(d, { recursive: true })
        writeFileSync(join(d, SPEC_FILE), builtin.spec, { encoding: 'utf8', flag: 'wx' })
        if (builtin.template !== undefined) writeFileSync(join(d, TEMPLATE_FILE), builtin.template, { encoding: 'utf8', flag: 'wx' })
        if (builtin.example !== undefined) writeFileSync(join(d, EXAMPLE_FILE), builtin.example, { encoding: 'utf8', flag: 'wx' })
        types.push(name)
      }
    } catch {
      return { created: false, dir, types }
    }
    this.cache.delete(base)
    this.logger?.info?.(`冷启动垫片：已生成默认文档规范 ${dir}（${types.join(', ')}）——按项目修改后 mtime 热重载即时生效`)
    return { created: true, dir, types }
  }

  /** 每个根至多垫片/确认一次；用户删了整个目录也不会在本进程内反复重写。 */
  private ensureScaffolded(base: string): void {
    if (!this.scaffold || this.scaffoldSeen.has(base)) return
    this.scaffoldSeen.add(base)
    this.scaffoldDefaults(base)
  }

  private signature(dirs: readonly string[], base: string): string {
    return dirs.map((name) => {
      const dir = join(this.dirOf(base), name)
      const parts = [SPEC_FILE, SPEC_FILE_ALT, TEMPLATE_FILE, EXAMPLE_FILE].map((f) => {
        try { return f + ':' + statSync(join(dir, f)).mtimeMs } catch { return f + ':-' }
      })
      return name + '[' + parts.join(',') + ']'
    }).join('|')
  }

  /** 全部合法 spec；非法类型目录跳过并告警，不因一份坏规则阻断校验。 */
  all(root?: string): FormatSpec[] {
    const base = root ?? this.workspaceRoot
    this.ensureScaffolded(base)
    const dirs = typeDirs(this.dirOf(base))
    const signature = this.signature(dirs, base)
    const cached = this.cache.get(base)
    if (cached !== undefined && cached.signature === signature) return cached.specs
    const specs = readSpecDir(this.dirOf(base), this.logger)
    this.logger?.debug?.('format specs 已加载：' + (specs.map((s) => s.name).join(', ') || '无'))
    this.cache.set(base, { signature, specs })
    return specs
  }

  /** 按文件名（+可选相对路径）匹配 spec（无命中 → undefined）。 */
  match(relPath: string, fileName: string, ext: string, root?: string): FormatSpec | undefined {
    return matchSpec(this.all(root), relPath, fileName, ext)
  }
}

/** 读 spec 的模板正文（相对 spec 目录）。 */
export function readTemplate(spec: FormatSpec): string | undefined {
  if (spec.template === undefined) return undefined
  const abs = join(spec.dir, spec.template)
  try {
    return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined
  } catch {
    return undefined
  }
}
