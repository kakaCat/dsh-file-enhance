/**
 * 动态代码执行——yaml 里写的自定义函数/表达式/派生事实在这里跑。
 *
 * 逃生舱口：内置函数覆盖不了的判据，用户直接写 JS 补，不必改插件。
 * 用 node:vm 起干净上下文、只注入白名单全局、带超时；脚本由工作区规则作者自己写，
 * 信任层级等同项目代码。
 * @module dsh-file-enhance/content-format/script
 */
import { runInNewContext } from 'node:vm'
import type { ParsedDoc } from './types.js'

const ID_RE = /\b([A-Z]{1,5})-(\d+)\b/g

/** 注入脚本的只读工具集（api.*）。 */
export interface ScriptApi {
  violation: (message: string, extra?: Record<string, unknown>) => Record<string, unknown>
  hasSection: (doc: ParsedDoc, name: string) => boolean
  section: (doc: ParsedDoc, name: string) => string
  collectIds: (text: string, prefixes?: string[]) => string[]
  frontmatter: (doc: ParsedDoc, key: string) => string | undefined
}

export const SCRIPT_API: ScriptApi = {
  violation: (message, extra = {}) => ({ message, ...extra }),
  hasSection: (doc, name) => doc.headings.some((h) => h.level >= 2 && h.text.includes(name)),
  section: (doc, name) => {
    const start = doc.bodyLines.findIndex((l) => /^#{1,6}\s/.test(l) && l.includes(name))
    if (start < 0) return ''
    const rest = doc.bodyLines.slice(start + 1)
    const end = rest.findIndex((l) => /^#{1,6}\s/.test(l))
    return (end < 0 ? rest : rest.slice(0, end)).join('\n')
  },
  collectIds: (text, prefixes = []) => {
    const out: string[] = []
    for (const m of String(text ?? '').matchAll(ID_RE)) {
      if (prefixes.length === 0 || prefixes.includes(m[1])) out.push(m[1] + '-' + m[2])
    }
    return out
  },
  frontmatter: (doc, key) => doc.frontmatter[key],
}

function sandboxFor(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...extra,
    api: SCRIPT_API,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    JSON, Math, Object, Array, String, Number, Boolean, RegExp, Date, Map, Set, Error,
    isNaN, parseInt, parseFloat,
  }
}

/** 在注入变量后的干净上下文里执行一段「函数体」，返回其返回值。同步、带超时。 */
export function runUserScript(code: string, vars: Record<string, unknown>, timeoutMs = 1000): unknown {
  const wrapped = '(function () {\n' + code + '\n})()'
  return runInNewContext(wrapped, sandboxFor(vars), { timeout: timeoutMs, filename: 'dsh-file-enhance-check.js' })
}

/** 表达式求值（等价于 return (expr)），在注入变量后的上下文里。 */
export function runUserExpr(expr: string, vars: Record<string, unknown>, timeoutMs = 1000): unknown {
  return runUserScript('return (' + expr + '\n)', vars, timeoutMs)
}
