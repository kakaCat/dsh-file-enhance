/**
 * 规则加载器——`.dsh/file-rules/<ext>.yaml`，**一个文件类型一个文件**。
 *
 * 约定：文件名（不含扩展名）= 该文件类型的扩展名键（`md.yaml` 管 `*.md`）。
 * 目录里没有某类型的文件 = 该类型无规则 = 拦截器直接放行（「只拦截 md」由此实现）。
 *
 * 缓存：按 mtime 失效——用户改了 yaml，下一次判定即生效（无需重启插件）。
 *
 * @module dsh-file-guide/rules
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { toAbs } from './paths.js'
import type { Loaded, RuleCategory, RuleSet } from './types.js'

export const RULES_DIR_REL = '.dsh/file-rules'

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
}

export class RulesStore {
  readonly workspaceRoot: string
  private readonly cache = new Map<string, { mtimeMs: number; value: Loaded }>()
  private readonly logger?: RulesStoreOptions['logger']

  constructor(options: RulesStoreOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd()
    this.logger = options.logger
  }

  get dir(): string {
    return toAbs(this.workspaceRoot, RULES_DIR_REL)
  }

  /** 规则目录里当前存在的类型键（文件名去扩展名；`_` 前缀视为草稿而跳过）。 */
  types(): string[] {
    const dir = this.dir
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

  /** 读某类型规则；无文件 → undefined；文件非法 → { error }。 */
  load(extKey: string): Loaded {
    if (extKey === '') return undefined
    const yamlPath = join(this.dir, `${extKey}.yaml`)
    const ymlPath = join(this.dir, `${extKey}.yml`)
    const path = existsSync(yamlPath) ? yamlPath : existsSync(ymlPath) ? ymlPath : undefined
    if (path === undefined) return undefined
    let mtimeMs = 0
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch { /* 读不到就当缓存失效 */ }
    const cached = this.cache.get(extKey)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.value
    let value: Loaded
    try {
      value = { rules: normalizeRules(yaml.load(readFileSync(path, 'utf8')), extKey), path }
      this.logger?.debug?.(`rules: ${extKey} 已加载（${Object.keys(value.rules.categories).length} 个分类）`)
    } catch (err) {
      value = { error: String((err as Error)?.message ?? err), path }
      this.logger?.warn?.(`rules: ${extKey} 非法——${(value as { error: string }).error}`)
    }
    this.cache.set(extKey, { mtimeMs, value })
    return value
  }

  /** 全部类型的规则概览（给指引单 / 工具用）。 */
  overview(): Array<{ ext: string; ok: boolean; root?: string; error?: string; categories?: Array<{ key: string; folder: string; kind: string; keywords: string[] }> }> {
    return this.types().map((ext) => {
      const loaded = this.load(ext)
      if (loaded === undefined) return { ext, ok: false, error: '规则文件缺失' }
      if ('error' in loaded) return { ext, ok: false, error: loaded.error }
      return {
        ext,
        ok: true,
        root: loaded.rules.root,
        categories: Object.values(loaded.rules.categories).map((c) => ({
          key: c.key, folder: c.folder, kind: c.kind, keywords: c.keywords,
        })),
      }
    })
  }

  /** 追加一条分类并回写 yaml（file_propose 获用户批准后调用）。 */
  appendCategory(extKey: string, key: string, category: Record<string, unknown>): { changed: boolean; path: string } {
    const path = join(this.dir, `${extKey}.yaml`)
    const loaded = this.load(extKey)
    let base: RawDoc
    if (loaded !== undefined && !('error' in loaded)) {
      base = (yaml.load(readFileSync(loaded.path, 'utf8')) ?? {}) as RawDoc
    } else {
      base = { type: extKey, root: 'docs', root_allow: [], categories: {} }
    }
    const cats = (base.categories ?? {}) as Record<string, unknown>
    if (cats[key] !== undefined) return { changed: false, path }
    cats[key] = category
    base.categories = cats
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(path, yaml.dump(base, { lineWidth: 120, noRefs: true }), 'utf8')
    this.cache.delete(extKey)
    return { changed: true, path }
  }

  /** 落一份初始规则（file_rules_init；只在文件不存在时写）。 */
  initFrom(sourceYaml: string, extKey = 'md'): { created: boolean; path: string } {
    const path = join(this.dir, `${extKey}.yaml`)
    if (existsSync(path)) return { created: false, path }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(path, sourceYaml, 'utf8')
    this.cache.delete(extKey)
    return { created: true, path }
  }
}
