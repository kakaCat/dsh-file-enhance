/**
 * 校验编排——构建事实 → 跑规则引擎 → delta 归责。
 *
 * 内置原语与动态代码都只是引擎里的函数；spec 只声明 rules / derive / functions。
 * @module dsh-file-enhance/content-format/validate
 */
import { parseDocument } from './parse.js'
import { buildRegistry } from './rules/builtin.js'
import { runEngine } from './rules/engine.js'
import type { Facts } from './rules/types.js'
import type { FormatReport, FormatSpec, ParsedDoc, Violation } from './types.js'

export interface ValidateOptions {
  fileName?: string
  relPath?: string
  scriptTimeoutMs?: number
}

/** 把文档解析结果铺成规则引擎的初始事实。 */
function factsFor(spec: FormatSpec, text: string, options: ValidateOptions, templateDoc: ParsedDoc | undefined): Facts {
  const doc = parseDocument(text)
  return {
    text,
    fileName: options.fileName ?? '',
    relPath: options.relPath ?? '',
    specName: spec.name,
    doc,
    frontmatter: doc.frontmatter,
    headings: doc.headings,
    tables: doc.tables,
    bodyLines: doc.bodyLines,
    bodyLineNos: doc.bodyLineNos,
    templateDoc,
  }
}

function evaluateText(spec: FormatSpec, text: string, options: ValidateOptions, templateDoc: ParsedDoc | undefined): Violation[] {
  const timeoutMs = options.scriptTimeoutMs ?? 1000
  const facts = factsFor(spec, text, options, templateDoc)
  const functions = buildRegistry(spec, timeoutMs)
  const rules = spec.rules
  return runEngine({ facts, rules, derive: spec.derive, functions, scriptTimeoutMs: timeoutMs })
}

/**
 * 校验一次操作后的文档。
 *
 * delta 语义：diffMode='delta' 且 before 存在时，只保留「after 有、before 没有」的违规，
 * 不把旧文件的历史问题算到本次操作头上。before 为空（新建）时等价 strict。
 */
export function validateDocument(
  spec: FormatSpec,
  after: string,
  before: string | null,
  templateText?: string,
  options: ValidateOptions = {},
): FormatReport {
  const templateDoc = templateText !== undefined ? parseDocument(templateText) : undefined
  const afterViolations = evaluateText(spec, after, options, templateDoc)

  let newViolations: Violation[] = afterViolations
  if (spec.diffMode === 'delta' && before !== null) {
    const beforeKeys = new Set(evaluateText(spec, before, options, templateDoc).map((v) => v.key))
    newViolations = afterViolations.filter((v) => !beforeKeys.has(v.key))
  }

  return {
    spec,
    violations: afterViolations,
    errors: afterViolations.filter((v) => v.severity === 'error'),
    warnings: afterViolations.filter((v) => v.severity === 'warning'),
    newErrors: newViolations.filter((v) => v.severity === 'error'),
    newWarnings: newViolations.filter((v) => v.severity === 'warning'),
  }
}
