/**
 * 规则引擎类型——事实、条件树、规则、函数。
 * @module dsh-file-enhance/content-format/rules/types
 */
import type { ParsedDoc, Severity } from '../types.js'

/** 事实（工作内存）：文档被解析成的事实集合，规则在其上求值。 */
export interface Facts {
  text: string
  fileName: string
  relPath: string
  specName: string
  doc: ParsedDoc
  frontmatter: Record<string, string>
  headings: ParsedDoc['headings']
  tables: ParsedDoc['tables']
  bodyLines: string[]
  bodyLineNos: number[]
  [key: string]: unknown
}

/** 一条失败原因（叶子条件的判定结果）。 */
export interface Failure {
  message: string
  line?: number
  key?: string
  severity?: Severity
}

export interface EvalResult { ok: boolean; failures: Failure[] }

/** 比较算子。 */
export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'notContains' | 'matches' | 'notMatches' | 'in' | 'notIn' | 'exists' | 'empty' | 'notEmpty' | 'lengthGte' | 'lengthLte'

interface CondBase { message?: string; key?: string; severity?: Severity }
export interface CondAll extends CondBase { all: Cond[] }
export interface CondAny extends CondBase { any: Cond[] }
export interface CondNot extends CondBase { not: Cond }
export interface CondPath extends CondBase { path: string; op?: Op; value?: unknown }
export interface CondEach extends CondBase { each: string; where?: Cond; require: Cond }
export interface CondExists extends CondBase { exists: string; where?: Cond }
export interface CondCount extends CondBase { count: string; where?: Cond; op: Op; value: number }
export interface CondFn extends CondBase { fn: string; args?: unknown[] }

/** 条件树：all / any / not / path / each / exists / count / fn。 */
export type Cond = boolean | CondAll | CondAny | CondNot | CondPath | CondEach | CondExists | CondCount | CondFn

/** 一条校验规则：when 为真且 assert 不成立 → 违规。 */
export interface Rule {
  id: string
  enabled?: boolean
  severity?: Severity
  when?: Cond
  assert: Cond
  message?: string
  key?: string
  priority?: number
}

/** 前向链：从已有事实派生出新事实。 */
export interface Derive {
  fact: string
  fn?: string
  args?: unknown[]
  expr?: string
  script?: string
  value?: unknown
}

/** 用户自定义函数（expr 或 script 二选一）。 */
export interface FunctionDef { expr?: string; script?: string; args?: string[] }
