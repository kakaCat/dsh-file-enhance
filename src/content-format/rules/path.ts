/**
 * 事实取值——点路径解析（`$` = 根事实，无前缀 = 当前作用域）。
 * @module dsh-file-enhance/content-format/rules/path
 */
import type { Facts } from './types.js'

function resolve(scope: unknown, path: string): unknown {
  let cur: unknown = scope
  for (const seg of path.split('.')) {
    if (seg === '') continue
    if (cur === null || cur === undefined) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** 读路径：`$` / `$.a.b` 从根事实取；其余从当前作用域取。 */
export function readPath(scope: unknown, path: string, root: Facts): unknown {
  if (path === '$' || path === '') return root
  if (path.startsWith('$.')) return resolve(root, path.slice(2))
  return resolve(scope, path)
}

/** 解析参数值：`{ ref: path }` 取值，其余当字面量。 */
export function resolveValue(value: unknown, scope: unknown, root: Facts): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'ref' in (value as Record<string, unknown>)) {
    return readPath(scope, String((value as { ref: unknown }).ref), root)
  }
  return value
}
