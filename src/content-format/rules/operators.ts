/**
 * 比较算子——条件叶子（path 节点）用它判定。
 * @module dsh-file-enhance/content-format/rules/operators
 */
import type { Op } from './types.js'

function len(v: unknown): number {
  if (typeof v === 'string' || Array.isArray(v)) return v.length
  return 0
}

/** 应用一个算子。未知算子 → false。 */
export function applyOp(op: Op, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'eq': return actual === expected
    case 'ne': return actual !== expected
    case 'gt': return Number(actual) > Number(expected)
    case 'gte': return Number(actual) >= Number(expected)
    case 'lt': return Number(actual) < Number(expected)
    case 'lte': return Number(actual) <= Number(expected)
    case 'contains': return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? '').includes(String(expected))
    case 'notContains': return !applyOp('contains', actual, expected)
    case 'matches':
      try { return new RegExp(String(expected)).test(String(actual ?? '')) } catch { return false }
    case 'notMatches': return !applyOp('matches', actual, expected)
    case 'in': return Array.isArray(expected) && expected.includes(actual)
    case 'notIn': return !applyOp('in', actual, expected)
    case 'exists': return actual !== undefined && actual !== null
    case 'empty': return actual === undefined || actual === null || (typeof actual === 'string' && actual.trim() === '') || (Array.isArray(actual) && actual.length === 0)
    case 'notEmpty': return !applyOp('empty', actual, expected)
    case 'lengthGte': return len(actual) >= Number(expected)
    case 'lengthLte': return len(actual) <= Number(expected)
    default: return false
  }
}
