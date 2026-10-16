/**
 * 判定链——本插件的**核心纯函数**。
 *
 * 冻结的判定顺序（需求讨论结论，逐条有测试守护）：
 *   ① 该扩展名有规则文件吗？没有 → 放行（「只拦截 md」由此实现）
 *   ② 根目录 → 白名单（内置 ∪ yaml.root_allow）放行；否则硬拦（永不自由发挥）
 *   ③ 在 root（如 docs/）之外 → 拦截并建议归入 root；坚持第二次起放行（自由发挥）
 *   ④ 在 root 下、已落在子目录里 → 现实目录优先（存在即放行）→ 规则分类校验命名
 *   ⑤ 在 root 下、直接落在 root（未分类）→ 现实匹配 → 规则兜底 → 都不中则自由发挥
 *
 * 「自由发挥」= 同一目标第二次尝试即放行（首次拦截只做教导）。根目录禁令不适用该豁免。
 *
 * I/O 只走注入的端口（listNames），故本模块可用假数据完整测试。
 *
 * @module dsh-file-enhance/folder-path/decide
 */
import { basename, join } from 'node:path'
import {
  BUILTIN_ROOT_ALLOW, extKeyOf, isInside, isRootLevel, matchesNaming,
  partsUnder, slugify, stemOf, toAbs,
} from './paths.js'
import type { Loaded, RuleCategory, RuleSet, RuleTarget, RuleVariant, Tree, Verdict } from './types.js'

/** `{auto_number:4}` → 该目录下一个编号（按已存在文件名里的最大数字 +1）。 */
export function nextAutoNumber(names: readonly string[], width: number): string {
  let max = 0
  for (const n of names) {
    const m = /^(\d+)/.exec(String(n))
    if (m !== null) max = Math.max(max, Number(m[1]))
  }
  return String(max + 1).padStart(width, '0')
}

export interface DestPorts {
  rootAbs?: string
  listNames?: (dirAbs: string) => string[]
}

/**
 * 渲染 dest 模板。占位符：`{root}` `{folder}` `{slug}` `{project_id}` `{auto_number:N}`。
 * `auto_number` 需要 listNames 端口（读目标目录现有文件名），目录取 dest 里它前面的路径段。
 */
export function renderDest(dest: string, vars: Record<string, string>, ports: DestPorts = {}): string {
  const out: string[] = []
  const segs = String(dest).split('/')
  for (const seg of segs) {
    let s = seg
    if (s.includes('{auto_number')) {
      const dirRel = out.join('/')
      const width = Number(/\{auto_number:(\d+)\}/.exec(s)?.[1] ?? 1)
      const dirAbs = join(ports.rootAbs ?? '.', dirRel)
      const names = ports.listNames !== undefined ? ports.listNames(dirAbs) : []
      s = s.replace(/\{auto_number(?::\d+)?\}/g, nextAutoNumber(names, width))
    }
    out.push(s.replace(/\{(root|folder|slug|project_id)\}/g, (whole, name: string) => vars[name] ?? whole))
  }
  return out.join('/')
}

/** 关键词命中打分（0 = 不命中）。 */
export function scoreKeywords(text: unknown, keywords: readonly string[]): number {
  const t = String(text ?? '').toLowerCase()
  if (t === '') return 0
  let score = 0
  for (const k of keywords) {
    const kk = String(k).toLowerCase()
    if (kk !== '' && t.includes(kk)) score += kk.length
  }
  return score
}

/** 按关键词挑最贴切分类目标（无命中 → undefined）。 */
export function bestCategory(text: string, targets: readonly RuleTarget[]): RuleTarget | undefined {
  let best: RuleTarget | undefined
  let bestScore = 0
  for (const t of targets) {
    const score = scoreKeywords(text, t.keywords)
    if (score > bestScore) { bestScore = score; best = t }
  }
  return best
}

/** 现实匹配：文件名主题词命中已存在的子目录名（含单复数）。 */
export function matchReality(tree: Tree | undefined, base: string): { name: string } | undefined {
  const tokens = slugify(stemOf(base)).split('-').filter(Boolean)
  if (tokens.length === 0) return undefined
  for (const d of tree?.dirs ?? []) {
    const dn = String(d.name).toLowerCase()
    const singular = dn.endsWith('s') ? dn.slice(0, -1) : dn
    if (tokens.includes(dn) || tokens.includes(singular)) return { name: d.name }
  }
  return undefined
}

function categoryByFolder(rules: RuleSet, folder: string): RuleCategory | undefined {
  return Object.values(rules.categories).find((c) => c.folder === folder)
}

/** 分类的所有可选目标（simple → 自身；collection → 各变体，附 parent）。 */
export function targetsOf(cat: RuleCategory): RuleTarget[] {
  if (cat.kind !== 'collection') {
    return [{ key: cat.key, folder: cat.folder, keywords: cat.keywords, naming: cat.naming, template: cat.template, dest: cat.dest, kind: 'simple', parent: cat }]
  }
  return Object.values(cat.variants ?? {}).map((v: RuleVariant) => ({
    key: v.key, folder: cat.folder, keywords: v.keywords, naming: v.naming,
    template: v.template, dest: v.dest, kind: 'variant' as const, parent: cat,
  }))
}

function variantFolderOf(cat: RuleCategory, name: string): RuleVariant | undefined {
  if (cat.kind !== 'collection') return undefined
  for (const v of Object.values(cat.variants ?? {})) {
    const segs = String(v.dest ?? '').split('/').filter((s) => s !== '')
    const fileIndex = segs.findIndex((s) => s.includes('{slug}'))
    const dirs = (fileIndex >= 0 ? segs.slice(0, fileIndex) : segs.slice(0, -1))
      .filter((s) => !s.startsWith('{'))
    if (dirs.at(-1) === name) return v
  }
  return undefined
}

export interface DecideArgs {
  /** 目标绝对路径。 */
  target: string
  workspaceRoot: string
  /** RulesStore.load(ext) 的结果（undefined = 该类型无规则）。 */
  loaded: Loaded
  /** scanReality(rootAbs) 的快照（root 不存在时传 { exists:false, empty:true, dirs:[], files:[] }）。 */
  tree?: Tree
  /** 同一目标此前被拒次数（0 = 首次）。 */
  priorDenials?: number
  /** 端口：读某目录下文件名（auto_number 用）。 */
  listNames?: (dirAbs: string) => string[]
}

/** 判定一次「新建」。返回 pass / correct / deny 三态。 */
export function decide(args: DecideArgs): Verdict {
  const { target, workspaceRoot, loaded, tree, listNames } = args
  const priorDenials = args.priorDenials ?? 0
  const base = basename(target)
  const ext = extKeyOf(target)

  // ① 类型过滤：没有该类型的规则文件 → 不管
  if (ext === '') return { kind: 'pass', code: 'no-rules-for-type' }
  if (loaded === undefined) return { kind: 'pass', code: 'no-rules-for-type' }
  if ('error' in loaded) {
    if (priorDenials >= 1) return { kind: 'pass', code: 'free-play' }
    return { kind: 'deny', code: 'rules-invalid', detail: loaded.error, rulesPath: loaded.path }
  }
  const rules = loaded.rules
  const rootAbs = toAbs(workspaceRoot, rules.root)
  const ports: DestPorts = { rootAbs, listNames }

  // ② 根目录：白名单放行，其余硬拦（不适用自由发挥豁免）
  if (isRootLevel(workspaceRoot, target)) {
    const allow = new Set([...BUILTIN_ROOT_ALLOW, ...rules.rootAllow].map((s) => s.toLowerCase()))
    if (allow.has(base.toLowerCase())) return { kind: 'pass', code: 'root-allow' }
    return { kind: 'deny', code: 'root-forbidden', target, rules, rootAbs, tree }
  }

  // ③ root 之外
  if (!isInside(rootAbs, target)) {
    if (priorDenials >= 1) return { kind: 'pass', code: 'free-play' }
    return { kind: 'deny', code: 'outside-root', target, rules, rootAbs, tree }
  }

  const parts = partsUnder(rootAbs, target)
  const first = parts[0] ?? ''
  const stem = stemOf(base)

  // ⑤ root 下直接落文件（未分类）
  if (parts.length === 1) {
    const real = matchReality(tree, base)
    if (real !== undefined) {
      const slug = matchesNaming('kebab-case', stem) ? stem : slugify(stem)
      return {
        kind: 'correct', code: 'unclassified->reality', source: 'reality',
        to: join(rootAbs, real.name, `${slug}.${ext}`),
        category: { key: real.name, folder: real.name, naming: 'kebab-case' },
        target, rules, rootAbs, tree,
      }
    }
    const allTargets = Object.values(rules.categories).flatMap((c) => targetsOf(c))
    const ruled = bestCategory(`${stem} ${base}`, allTargets)
    if (ruled !== undefined) {
      if (ruled.dest !== undefined && !ruled.dest.includes('{project_id}')) {
        const slug = matchesNaming(ruled.naming, stem) ? stem : slugify(stem)
        const rendered = renderDest(ruled.dest, { slug, folder: ruled.folder, root: rules.root }, ports)
        // dest 相对 root；{root}/... 是允许的旧写法，不能再把 root 拼第二次。
        const normalizedRendered = rendered.replace(/\\/g, '/')
        const normalizedRoot = rules.root.replace(/\\/g, '/')
        const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : normalizedRoot + '/'
        const destRel = normalizedRendered.startsWith(rootPrefix)
          ? normalizedRendered.slice(rootPrefix.length)
          : rendered
        const to = join(rootAbs, destRel)
        return { kind: 'correct', code: 'unclassified->rules', source: 'rules', to, category: { key: ruled.key, folder: ruled.folder, naming: ruled.naming }, target, rules, rootAbs, tree }
      }
      return { kind: 'deny', code: 'need-allocate', target, category: ruled.parent, rules, rootAbs, tree }
    }
    if (priorDenials >= 1) return { kind: 'pass', code: 'free-play' }
    return { kind: 'deny', code: 'unclassified', target, rules, rootAbs, tree }
  }

  // ④ 已落在某个子目录里
  const cat = categoryByFolder(rules, first)
  if (cat === undefined) {
    const realFolder = (tree?.dirs ?? []).find((d) => d.name === first)
    if (realFolder !== undefined) return { kind: 'pass', code: 'classified-reality' }
    if (priorDenials >= 1) return { kind: 'pass', code: 'free-play' }
    return { kind: 'deny', code: 'unknown-category', target, folder: first, rules, rootAbs, tree }
  }

  if (cat.kind === 'collection') {
    const inst = cat.instance
    const instanceName = parts[1]
    if (inst === undefined || instanceName === undefined) {
      return { kind: 'deny', code: 'need-allocate', target, category: cat, rules, rootAbs, tree }
    }
    if (inst.pattern !== undefined && !new RegExp(inst.pattern).test(instanceName)) {
      return { kind: 'deny', code: 'bad-instance', target, category: cat, instanceName, rules, rootAbs, tree }
    }
    const folderEntry = (tree?.dirs ?? []).find((d) => d.name === cat.folder)
    const instanceExists = folderEntry !== undefined && (folderEntry.subdirs ?? []).includes(instanceName)
    if (!instanceExists && priorDenials < 1) {
      return { kind: 'deny', code: 'need-allocate', target, category: cat, instanceName, rules, rootAbs, tree }
    }
    const variantName = parts[2]
    const variant = variantName === undefined ? undefined : variantFolderOf(cat, variantName)
    if (variant === undefined) {
      if (priorDenials >= 1) return { kind: 'pass', code: 'free-play' }
      return {
        kind: 'deny', code: 'unknown-variant', target, category: cat,
        folder: variantName, instanceName, rules, rootAbs, tree,
      }
    }
    if (!matchesNaming(variant.naming, stem) && priorDenials < 1) {
      return { kind: 'deny', code: 'naming', target, category: cat, naming: variant.naming, stem, rules, rootAbs, tree }
    }
    return { kind: 'pass', code: 'classified-rules', category: cat, variant }
  }

  if (!matchesNaming(cat.naming, stem) && priorDenials < 1) {
    return { kind: 'deny', code: 'naming', target, category: cat, naming: cat.naming, stem, rules, rootAbs, tree }
  }
  const variant = parts[1] !== undefined ? variantFolderOf(cat, parts[1]) : undefined
  return variant !== undefined
    ? { kind: 'pass', code: 'classified-rules', category: cat, variant }
    : { kind: 'pass', code: 'classified-rules', category: cat }
}
