/**
 * 条件求值——规则引擎的核心：条件树在事实（+当前作用域）上求值，返回 ok / failures。
 *
 * all/any/not 组合、path 叶子比较、each/exists/count 量词、fn 调用注册函数。
 * 失败来自叶子（带具体 message），因此聚合报错天然精确。
 * @module dsh-file-enhance/content-format/rules/condition
 */
import { applyOp } from './operators.js'
import { readPath, resolveValue } from './path.js'
import type { FunctionRegistry, FnContext } from './functions.js'
import type { Cond, CondAll, CondAny, CondCount, CondEach, CondExists, CondFn, CondNot, CondPath, EvalResult, Facts, Failure } from './types.js'

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const pass = (): EvalResult => ({ ok: true, failures: [] })
function fail(message: string, node: { key?: string; severity?: Failure['severity'] } = {}): EvalResult {
  return { ok: false, failures: [{ message, ...(node.key !== undefined ? { key: node.key } : {}), ...(node.severity !== undefined ? { severity: node.severity } : {}) }] }
}

function toFailures(items: readonly unknown[]): Failure[] {
  const out: Failure[] = []
  for (const it of items) {
    if (typeof it === 'string') { out.push({ message: it }); continue }
    if (!isObj(it)) continue
    out.push({
      message: typeof it.message === 'string' ? it.message : '未通过',
      ...(typeof it.line === 'number' ? { line: it.line } : {}),
      ...(typeof it.key === 'string' ? { key: it.key } : {}),
      ...(it.severity === 'warning' ? { severity: 'warning' as const } : {}),
    })
  }
  return out
}

function derive(cond: Cond, scope: unknown, root: Facts, fns: FunctionRegistry, ctx: FnContext): EvalResult {
  if (cond === true) return pass()
  if (cond === false) return fail('恒假条件')
  if (!isObj(cond)) return fail('无法识别的条件')
  if ('all' in cond) return evalAll(cond as CondAll, scope, root, fns, ctx)
  if ('any' in cond) return evalAny(cond as CondAny, scope, root, fns, ctx)
  if ('not' in cond) return evalNot(cond as CondNot, scope, root, fns, ctx)
  if ('each' in cond) return evalEach(cond as CondEach, scope, root, fns, ctx)
  if ('exists' in cond) return evalExists(cond as CondExists, scope, root, fns, ctx)
  if ('count' in cond) return evalCount(cond as CondCount, scope, root, fns, ctx)
  if ('fn' in cond) return evalFn(cond as CondFn, scope, root, fns, ctx)
  if ('path' in cond) return evalPath(cond as CondPath, scope, root)
  return fail('无法识别的条件：' + JSON.stringify(cond))
}

/** 条件求值入口。 */
export function evaluate(cond: Cond, scope: unknown, root: Facts, fns: FunctionRegistry, ctx: FnContext): EvalResult {
  return derive(cond, scope, root, fns, ctx)
}

function evalAll(n: CondAll, scope: unknown, root: Facts, fns: FunctionRegistry, ctx: FnContext): EvalResult {
  const failures: Failure[] = []
  for (const child of n.all) failures.push(...derive(child, scope, root, fns, ctx).failures)
  if (failures.length === 0) return pass()
  return { ok: false, failures }
}

function evalAny(n: CondAny, scope: unknown, root: Facts, fns: FunctionRegistry, ctx: FnContext): EvalResult {
  const results = n.any.map((child) => derive(child, scope, root, fns, ctx))
  if (results.some((r) => r.ok)) return pass()
  const failures = n.message !== undefined
    ? [{ message: n.message, ...(n.key !== undefined ? { key: n.key } : {}), ...(n.severity !== undefined ? { severity: n.severity } : {}) }]
    : results.flatMap((r) => r.failures)
  return { ok: false, failures: failures.length > 0 ? failures : [{ message: '任一条件均未满足' }] }
}

function evalNot(n: CondNot, scope: unknown, root: Facts, fns: FunctionRegistry, ctx: FnContext): EvalResult {
  const r = derive(n.not, scope, root, fns, ctx)
  if (r.ok) return fail(n.message ?? '条件不应成立', n)
  return pass()
}

function evalPath(n: CondPath, scope: unknown, root: Facts): EvalResult {
  const actual = readPath(scope, n.path, root)
  const op = n.op ?? 'exists'
  const expected = resolveValue(n.value, scope, root)
  if (applyOp(op, actual, expected)) return pass()
  return fail(n.message ?? ('[' + n.path + ' ' + op + '] 未通过'), n)
}

function evalEach(n: CondEach, scope: unknown, root: Facts, fns: FunctionRegistry, ctx: FnContext): EvalResult {
  const arr = readPath(scope, n.each, root)
  if (!Array.isArray(arr)) return fail(n.message ?? ('each 目标不是数组：' + n.each), n)
  const failures: Failure[] = []
  for (const el of arr) {
    if (n.where !== undefined && !derive(n.where, el, root, fns, ctx).ok) continue
    const r = derive(n.require, el, root, fns, ctx)
    if (r.ok) continue
    const line = isObj(el) && typeof el.line === 'number' ? el.line : undefined
    if (r.failures.length === 0) failures.push({ message: n.message ?? '元素未通过', ...(line !== undefined ? { line } : {}) })
    else for (const f of r.failures) failures.push({ ...f, ...(f.line === undefined && line !== undefined ? { line } : {}) })
  }
  if (failures.length === 0) return pass()
  return { ok: false, failures }
}

function evalExists(n: CondExists, scope: unknown, root: Facts, fns: FunctionRegistry, ctx: FnContext): EvalResult {
  const arr = readPath(scope, n.exists, root)
  if (!Array.isArray(arr)) return fail(n.message ?? ('exists 目标不是数组：' + n.exists), n)
  const ok = arr.some((el) => n.where === undefined || derive(n.where, el, root, fns, ctx).ok)
  if (ok) return pass()
  return fail(n.message ?? ('不存在满足条件的元素：' + n.exists), n)
}

function evalCount(n: CondCount, scope: unknown, root: Facts, fns: FunctionRegistry, ctx: FnContext): EvalResult {
  const arr = readPath(scope, n.count, root)
  const list = Array.isArray(arr) ? arr : []
  const value = n.where === undefined ? list.length : list.filter((el) => derive(n.where as Cond, el, root, fns, ctx).ok).length
  if (applyOp(n.op, value, n.value)) return pass()
  return fail(n.message ?? ('count(' + n.count + ') = ' + value + ' 不满足 ' + n.op + ' ' + n.value), n)
}

function evalFn(n: CondFn, scope: unknown, root: Facts, fns: FunctionRegistry, ctx: FnContext): EvalResult {
  const args = (n.args ?? []).map((a) => resolveValue(a, scope, root))
  let result: unknown
  try {
    result = fns.call(n.fn, ctx, args)
  } catch (err) {
    return fail(n.message ?? ('函数执行失败 ' + n.fn + '：' + String((err as Error)?.message ?? err)), n)
  }
  if (Array.isArray(result)) {
    const failures = toFailures(result)
    return failures.length === 0 ? pass() : { ok: false, failures }
  }
  if (isObj(result) && typeof result.ok === 'boolean') {
    if (result.ok) return pass()
    const failures = Array.isArray(result.failures) ? toFailures(result.failures) : []
    return { ok: false, failures: failures.length > 0 ? failures : [{ message: n.message ?? '条件未通过' }] }
  }
  if (result) return pass()
  return fail(n.message ?? ('函数 ' + n.fn + ' 返回假'), n)
}
