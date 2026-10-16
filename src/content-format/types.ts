/**
 * 格式规范领域类型——匹配、校验、反馈的公共形状。
 * @module dsh-file-enhance/content-format/types
 */

import type { Derive, FunctionDef, Rule } from './rules/types.js'

export type Severity = 'error' | 'warning'
export type SpecMode = 'block' | 'warn' | 'off'
export type EnforceOn = 'create' | 'update'
export type DiffMode = 'delta' | 'strict'
export type OnExhausted = 'allow' | 'block'

/** 一份文件格式规范（一个 file-format-specs/*.yaml）。 */
export interface FormatSpec {
  name: string
  ext?: string
  priority: number
  /** 文件名（basename）glob 模式——主匹配口径。 */
  match: string[]
  /** 可选的相对路径 glob 附加约束（与 match 同时满足）。 */
  matchPath: string[]
  template?: string
  /** 可选：同目录 example.md（填好的参考文档）。 */
  example?: string
  mode: SpecMode
  enforceOn: EnforceOn[]
  diffMode: DiffMode
  maxAttempts: number
  onExhausted: OnExhausted
  /** 规则引擎：声明式规则。 */
  rules: Rule[]
  /** 规则引擎：前向链派生事实。 */
  derive: Derive[]
  /** 规则引擎：用户自定义函数（expr / script）。 */
  functions: Record<string, FunctionDef>
  /** yaml 绝对路径。 */
  path: string
  /** spec 所在目录（模板相对此目录解析）。 */
  dir: string
}

/** 文档结构解析结果（纯结构，代码围栏已剥离）。 */
export interface ParsedDoc {
  frontmatter: Record<string, string>
  headings: Array<{ level: number; text: string; line: number }>
  tables: Array<{ header: string[]; rows: string[][]; line: number }>
  /** 非围栏正文行。 */
  bodyLines: string[]
  /** bodyLines[i] 对应的原始行号（1-based）。 */
  bodyLineNos: number[]
  lineCount: number
  charCount: number
}

/** 一条违规。key 是语义身份，用于 delta 比较（不含行号）。 */
export interface Violation {
  checkId: string
  type: string
  severity: Severity
  key: string
  line?: number
  message: string
}

/** 一次格式校验的结果。 */
export interface FormatReport {
  spec: FormatSpec
  violations: Violation[]
  errors: Violation[]
  warnings: Violation[]
  /** delta 之后归责于本次操作的新增违规。 */
  newErrors: Violation[]
  newWarnings: Violation[]
}
