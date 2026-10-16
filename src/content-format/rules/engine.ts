/**
 * 规则引擎——前向链派生事实，然后按规则求值产出违规。
 *
 * 执行序：
 *   ① 载入初始事实（文档解析结果）
 *   ② derive：逐条派生新事实（后一条可见前一条）
 *   ③ rules：按 priority 降序求值；when 过关才看 assert，assert 不成立 → 违规（聚合）
 * @module dsh-file-enhance/content-format/rules/engine
 */
import { runUserExpr, runUserScript } from '../script.js'
import { evaluate } from './condition.js'
import { resolveValue } from './path.js'
import type { FunctionRegistry, FnContext } from './functions.js'
import type { Derive, Facts, Rule } from './types.js'
import type { Violation } from '../types.js'

export interface EngineInput {
  facts: Facts
  rules: Rule[]
  derive?: Derive[]
  functions: FunctionRegistry
  scriptTimeoutMs?: number
}

/** 跑一次规则引擎，返回聚合后的违规。 */
export function runEngine(input: EngineInput): Violation[] {
  const { facts, functions } = input
  const timeoutMs = input.scriptTimeoutMs ?? 1000
  const ctx: FnContext = {
    facts, doc: facts.doc, text: facts.text, fileName: facts.fileName, relPath: facts.relPath, specName: facts.specName,
    templateDoc: facts.templateDoc as Facts['doc'] | undefined,
  }

  const out: Violation[] = []

  // ① 前向链：派生事实（后一条能看到前一条 set 进去的）。单项失败只记违规，不拖垮整个钩子。
  for (const d of input.derive ?? []) {
    try {
      let value: unknown
      if (d.fn !== undefined) value = functions.call(d.fn, ctx, (d.args ?? []).map((a) => resolveValue(a, facts, facts)))
      else if (d.expr !== undefined) value = runUserExpr(d.expr, { ...facts }, timeoutMs)
      else if (d.script !== undefined) value = runUserScript(d.script, { ...facts }, timeoutMs)
      else value = d.value
      facts[d.fact] = value
    } catch (err) {
      const message = `派生事实 ${d.fact} 执行失败：${String((err as Error)?.message ?? err)}`
      out.push({
        checkId: `derive:${d.fact}`,
        type: 'derive',
        severity: 'error',
        key: `derive:${d.fact}|execution`,
        message,
      })
    }
  }

  // ③ 规则求值（priority 降序，稳定保序）
  const ordered = input.rules
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ((b.r.priority ?? 0) - (a.r.priority ?? 0)) || (a.i - b.i))
    .map((x) => x.r)
  for (const rule of ordered) {
    if (rule.enabled === false) continue
    if (rule.when !== undefined && !evaluate(rule.when, facts, facts, functions, ctx).ok) continue
    const res = evaluate(rule.assert, facts, facts, functions, ctx)
    if (res.ok) continue
    const failures = res.failures.length > 0 ? res.failures : [{ message: rule.message ?? '规则未通过' }]
    for (const f of failures) {
      out.push({
        checkId: rule.id,
        type: 'rule',
        severity: f.severity ?? rule.severity ?? 'error',
        key: rule.id + '|' + (f.key ?? rule.key ?? f.message),
        message: f.message,
        ...(f.line !== undefined ? { line: f.line } : {}),
      })
    }
  }
  return out
}
