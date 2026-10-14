/**
 * 领域类型——判定链、规则表、扫描快照的公共形状。
 * @module dsh-file-guide/types
 */

/** 集合型分类下的一个变体（如 projects/{project_id}/design/{slug}.md 的 design）。 */
export interface RuleVariant {
  key: string
  keywords: string[]
  naming: string
  template?: string
  dest?: string
}

/** 集合型的实例声明（项目编号一类的「实例轴」）。 */
export interface RuleInstance {
  param: string
  pattern?: string
  acquire: 'auto' | 'none'
  scaffold: string[]
}

/** 一个分类：`folder` 是它在 root 下的目录名，`dest` 是相对 root 的落点模板。 */
export interface RuleCategory {
  key: string
  folder: string
  kind: 'simple' | 'collection'
  keywords: string[]
  naming: string
  template?: string
  dest?: string
  instance?: RuleInstance
  variants?: Record<string, RuleVariant>
}

/** 分类的可选目标：simple 分类即自身；集合型分类的每个变体各算一个目标。 */
export interface RuleTarget {
  key: string
  folder: string
  keywords: string[]
  naming: string
  template?: string
  dest?: string
  kind: 'simple' | 'variant'
  parent: RuleCategory
}

/** 一个文件类型的一份规则（= 一个 `.dsh/file-rules/<ext>.yaml`）。 */
export interface RuleSet {
  type: string
  ext: string
  root: string
  rootAllow: string[]
  categories: Record<string, RuleCategory>
}

/** RulesStore.load 的成功/失败/缺失三态。 */
export interface LoadedRules { rules: RuleSet; path: string }
export interface LoadedRulesError { error: string; path: string }
export type Loaded = LoadedRules | LoadedRulesError | undefined

/** 目录一览里的一个子目录。 */
export interface DirEntry {
  name: string
  abs: string
  fileCount: number
  samples: string[]
  subdirs: string[]
}

/** root 目录的现实快照（「当前目录情况」）。 */
export interface Tree {
  exists: boolean
  empty: boolean
  dirs: DirEntry[]
  files: string[]
  names?: string[]
}

/** 判定结果：放行 / 自动纠偏 / 拦截。 */
export interface PassVerdict { kind: 'pass'; code: string; category?: RuleCategory; variant?: RuleVariant }
export interface CorrectVerdict {
  kind: 'correct'
  code: string
  source: 'reality' | 'rules'
  to: string
  category: { key: string; folder: string; naming?: string }
  target?: string
  rules?: RuleSet
  rootAbs?: string
  tree?: Tree
}
export interface DenyVerdict {
  kind: 'deny'
  code: string
  target?: string
  detail?: string
  rulesPath?: string
  folder?: string
  instanceName?: string
  naming?: string
  stem?: string
  category?: RuleCategory
  rules?: RuleSet
  rootAbs?: string
  tree?: Tree
}
export type Verdict = PassVerdict | CorrectVerdict | DenyVerdict
