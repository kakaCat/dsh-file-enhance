/**
 * 规则加载器——`.dsh/folder-path-rules/<ext>.yaml`，**一个文件类型一个文件**。
 *
 * 约定：文件名（不含扩展名）= 该文件类型的扩展名键（`md.yaml` 管 `*.md`）。
 * 目录里没有某类型的文件 = 该类型无规则 = 拦截器直接放行（「只拦截 md」由此实现）。
 *
 * 缓存：按 mtime 失效——用户改了 yaml，下一次判定即生效（无需重启插件）。
 *
 * @module dsh-file-enhance/folder-path/rules
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { toAbs } from './paths.js'
import type { Loaded, RuleCategory, RuleSet } from './types.js'

export const RULES_DIR_REL = '.dsh/folder-path-rules'

/**
 * 内置默认规则（md）——与 examples/md.yaml **逐字节一致**（scaffold 测试守护）。
 * 角色是**冷启动垫片**：只在工作区完全没有规则时落盘一次，落的是「一份可改的草稿」，
 * 不是「插件内置生效规则」——判定永远只读工作区 .dsh/ 里的文件，垫片落盘后 authority 即转移给工作区。
 */
export const DEFAULT_MD_RULES_YAML = `# .dsh/folder-path-rules/md.yaml —— markdown 文件的分类规范（由 dsh-file-enhance 读取）
#
# 这份文件是**唯一权威**：插件不内置任何生效中的规则，agent 创建文件时也只按它判定。
# 改完即生效（插件按 mtime 热重载），不需要重启。
#
# 本文件由插件冷启动垫片自动生成——直接按你的项目改：增删分类、改 dest 模板、调关键词。
#
# 字段说明：
#   root        该类型文件的主目录（md → docs）
#   root_allow  根目录白名单（追加在内置默认 README/CHANGELOG/CLAUDE/AGENTS… 之上）
#   categories  分类表：
#                folder    = root 下的目录名
#                keywords  = 用于把「文件主题词/描述」归位
#                naming    = 文件名风格（kebab-case / camelCase / PascalCase / snake_case / any）
#                dest      = 相对 root 的落点模板
#   dest 占位符：{slug} {folder} {root} {auto_number:4} {project_id}
#
#   kind: collection = 集合型分类：先有「实例编号文件夹」，文件放在实例里面。
#     instance.acquire: auto → file_resolve 会自动分配编号并建出 scaffold 骨架目录
type: md
root: docs
root_allow: []

categories:
  guides:
    folder: guides
    keywords: [指南, 教程, guide, tutorial, howto, 手册]
    dest: "guides/{slug}.md"

  api:
    folder: api
    keywords: [接口, api, 接口文档, endpoint]
    dest: "api/{slug}.md"

  adr:
    folder: adr
    keywords: [决策, adr, decision, 取舍, 技术选型]
    dest: "adr/{auto_number:4}-{slug}.md"

  research:
    folder: research
    keywords: [调研, research, 竞品分析, 选型报告, spike, 可行性]
    dest: "research/{slug}.md"

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

interface RawDoc { [k: string]: unknown }

/** 规则文件 → 归一化后的规则对象（缺项补默认，非法项抛错）。 */
export function normalizeRules(doc: unknown, extKey: string): RuleSet {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`规则文件 ${extKey}.yaml 顶层必须是对象`)
  }
  const d = doc as RawDoc
  const root = typeof d.root === 'string' && d.root !== '' ? d.root : ''
  if (root === '') throw new Error(`规则文件 ${extKey}.yaml 缺少 root（该类型文件的主目录，如 docs）`)
  const rawCats = d.categories
  if (rawCats === null || typeof rawCats !== 'object' || Array.isArray(rawCats) || rawCats === undefined) {
    throw new Error(`规则文件 ${extKey}.yaml 缺少 categories（分类表）`)
  }
  const categories: Record<string, RuleCategory> = {}
  for (const [key, raw] of Object.entries(rawCats as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`分类 ${key} 必须是对象`)
    const r = raw as RawDoc
    const folder = typeof r.folder === 'string' && r.folder !== '' ? r.folder : key
    const kind: RuleCategory['kind'] = r.kind === 'collection' ? 'collection' : 'simple'
    const cat: RuleCategory = {
      key,
      folder,
      kind,
      keywords: Array.isArray(r.keywords) ? r.keywords.map(String) : [],
      naming: typeof r.naming === 'string' ? r.naming : 'kebab-case',
      template: typeof r.template === 'string' ? r.template : undefined,
      dest: typeof r.dest === 'string' ? r.dest : undefined,
    }
    if (kind === 'collection') {
      const inst = (r.instance ?? {}) as RawDoc
      cat.instance = {
        param: typeof inst.param === 'string' ? inst.param : 'project_id',
        pattern: typeof inst.pattern === 'string' ? inst.pattern : undefined,
        acquire: inst.acquire === 'auto' ? 'auto' : 'none',
        scaffold: Array.isArray(inst.scaffold) ? inst.scaffold.map(String) : [],
      }
      const variants: RuleCategory['variants'] = {}
      for (const [vk, vr] of Object.entries((r.variants ?? {}) as Record<string, unknown>)) {
        if (vr === null || typeof vr !== 'object' || Array.isArray(vr)) throw new Error(`分类 ${key} 的变体 ${vk} 必须是对象`)
        const v = vr as RawDoc
        variants[vk] = {
          key: vk,
          keywords: Array.isArray(v.keywords) ? v.keywords.map(String) : [],
          naming: typeof v.naming === 'string' ? v.naming : cat.naming,
          template: typeof v.template === 'string' ? v.template : undefined,
          dest: typeof v.dest === 'string' ? v.dest : undefined,
        }
      }
      cat.variants = variants
    } else if (cat.dest === undefined) {
      throw new Error(`分类 ${key} 缺少 dest（如 "${folder}/{slug}.md"）`)
    }
    categories[key] = cat
  }
  return {
    type: typeof d.type === 'string' ? d.type : extKey,
    ext: extKey,
    root,
    rootAllow: Array.isArray(d.root_allow) ? d.root_allow.map(String) : [],
    categories,
  }
}

export interface RulesStoreOptions {
  workspaceRoot?: string
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; debug?: (m: string) => void }
  /**
   * 无工作区规则时是否**回落内置默认**（默认 true，目前仅 md 有内置默认）：
   * 加载优先级永远是「工作区 .dsh 文件 > 内置默认」——文件在就只看文件，
   * 文件不在就以内置默认参与判定（`Loaded.builtin = true`），同时由入口决定是否落盘。
   */
  fallback?: boolean
}

export class RulesStore {
  /** 回落默认根（构造时取 process.cwd()）；实际判定按调用传入的 root（宿主 workingDirectory 服务按 agent 解析）。 */
  readonly workspaceRoot: string
  private readonly cache = new Map<string, { mtimeMs: number; value: Loaded }>()
  private readonly logger?: RulesStoreOptions['logger']
  private readonly fallback: boolean
  /** 内置默认规则的解析结果（惰性一次，进程生命周期内不变）。 */
  private builtinMd: RuleSet | undefined

  constructor(options: RulesStoreOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd()
    this.logger = options.logger
    this.fallback = options.fallback !== false
  }

  /** 规则目录（绝对路径）。 */
  dirOf(root: string): string {
    return toAbs(root, RULES_DIR_REL)
  }

  /** 回落默认根下的规则目录（仅用于日志等展示；判定请走 dirOf(root)）。 */
  get dir(): string {
    return this.dirOf(this.workspaceRoot)
  }

  /** 内置默认 md 规则（DEFAULT_MD_RULES_YAML 的解析结果）。 */
  private builtinMdRules(): RuleSet {
    if (this.builtinMd === undefined) {
      this.builtinMd = normalizeRules(yaml.load(DEFAULT_MD_RULES_YAML), 'md')
    }
    return this.builtinMd
  }

  /** 规则目录里当前存在的类型键（文件名去扩展名；`_` 前缀视为草稿而跳过）。 */
  types(root?: string): string[] {
    const dir = this.dirOf(root ?? this.workspaceRoot)
    if (!existsSync(dir)) return []
    try {
      return readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f) && !f.startsWith('_'))
        .map((f) => f.replace(/\.ya?ml$/, ''))
        .sort()
    } catch {
      return []
    }
  }

  /**
   * 读某类型规则。优先级：**工作区 .dsh 文件 > 内置默认**。
   * 文件在 → 解析文件（非法 → { error }）；文件不在且允许回落（目前仅 md）→ 内置默认（{ builtin: true }）；
   * 都不满足 → undefined。缓存按 (root, extKey, mtime) 失效；内置默认恒定，不走文件缓存。
   */
  load(extKey: string, root?: string): Loaded {
    if (extKey === '') return undefined
    const base = root ?? this.workspaceRoot
    const yamlPath = join(this.dirOf(base), `${extKey}.yaml`)
    const ymlPath = join(this.dirOf(base), `${extKey}.yml`)
    const path = existsSync(yamlPath) ? yamlPath : existsSync(ymlPath) ? ymlPath : undefined
    if (path === undefined) {
      if (this.fallback && extKey === 'md') {
        this.logger?.debug?.(`rules: ${extKey} 无工作区规则，回落内置默认`)
        return { rules: this.builtinMdRules(), path: yamlPath, builtin: true }
      }
      return undefined
    }
    let mtimeMs = 0
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch { /* 读不到就当缓存失效 */ }
    const cacheKey = `${base}${extKey}`
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.value
    let value: Loaded
    try {
      value = { rules: normalizeRules(yaml.load(readFileSync(path, 'utf8')), extKey), path }
      this.logger?.debug?.(`rules: ${extKey} 已加载（${Object.keys(value.rules.categories).length} 个分类）`)
    } catch (err) {
      value = { error: String((err as Error)?.message ?? err), path }
      this.logger?.warn?.(`rules: ${extKey} 非法——${(value as { error: string }).error}`)
    }
    this.cache.set(cacheKey, { mtimeMs, value })
    return value
  }

  /**
   * 追加一条分类并回写 yaml（去重 + 补齐默认 + 清缓存使改动即时生效）。
   *
   * 预留 API。插件已无自有工具面：新增分类由 agent 征得用户同意后用**原生 write** 直接改 yaml，
   * 改动同样经 mtime 缓存失效即时生效。留着是给未来的 CLI／命令入口用——不要在工具面复活它。
   */
  appendCategory(extKey: string, key: string, category: Record<string, unknown>, root?: string): { changed: boolean; path: string } {
    const base = root ?? this.workspaceRoot
    const path = join(this.dirOf(base), `${extKey}.yaml`)
    const loaded = this.load(extKey, base)
    let baseDoc: RawDoc
    if (loaded !== undefined && !('error' in loaded)) {
      baseDoc = (yaml.load(readFileSync(loaded.path, 'utf8')) ?? {}) as RawDoc
    } else {
      baseDoc = { type: extKey, root: 'docs', root_allow: [], categories: {} }
    }
    const cats = (baseDoc.categories ?? {}) as Record<string, unknown>
    if (cats[key] !== undefined) return { changed: false, path }
    cats[key] = category
    baseDoc.categories = cats
    mkdirSync(this.dirOf(base), { recursive: true })
    writeFileSync(path, yaml.dump(baseDoc, { lineWidth: 120, noRefs: true }), 'utf8')
    this.cache.delete(`${base}${extKey}`)
    return { changed: true, path }
  }

  /**
   * 冷启动垫片：工作区**完全没有规则**时，把内置默认规则写入 `.dsh/folder-path-rules/<ext>.yaml`。
   *
   * 触发面收窄到「真·冷启动」，绝不与用户意志对抗：
   *   - 规则目录里已有任何 yaml（哪怕用户删过 md.yaml、只留着别的类型）→ 不动，不复活；
   *   - 目标文件已存在（竞态）→ wx 拒写，返回 created:false；
   *   - 非 md 类型暂无内置默认 → 不落。
   *
   * 落盘成功后清缓存：下一次创建即按新规则判定（mtime 热重载同理）。
   */
  scaffoldDefault(extKey: string, root?: string): { created: boolean; path: string } {
    const base = root ?? this.workspaceRoot
    const path = join(this.dirOf(base), `${extKey}.yaml`)
    if (extKey !== 'md') return { created: false, path }
    const dir = this.dirOf(base)
    if (existsSync(dir) && this.types(base).length > 0) return { created: false, path }
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, DEFAULT_MD_RULES_YAML, { encoding: 'utf8', flag: 'wx' })
    } catch {
      return { created: false, path }
    }
    this.cache.delete(`${base}${extKey}`)
    return { created: true, path }
  }
}
