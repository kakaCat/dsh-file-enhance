/**
 * 内置函数注册表——把内置原语与动态代码接入规则引擎。
 *
 * 规则引擎里的 fn 节点可以调用这里的函数：
 *   - 内置检查原语（primitives.ts）：sectionsRequired / tableRequired / ids / templateSections …
 *   - 通用取值助手：hasSection / sectionText / collectIds / countIds / frontmatter / length / count / matches / exists
 *   - 用户在 spec.functions 里自定义的函数（expr / script）
 *
 * 约定：函数返回失败列表 / { ok, failures } 时为精细失败；返回布尔时为真假。
 * @module dsh-file-enhance/content-format/rules/builtin
 */
import { PRIMITIVES } from '../primitives.js'
import { runUserExpr, runUserScript, SCRIPT_API } from '../script.js'
import { FunctionRegistry } from './functions.js'
import type { FormatSpec } from '../types.js'
import type { FunctionDef } from './types.js'

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v))

/** 用户 script 返回值归一化：undefined/null/true/[] = 通过；false = 未通过；string / 对象 / 数组 = 违规。 */
function toScriptResult(raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === true) return true
  if (raw === false) return false
  if (typeof raw === 'string') return [{ message: raw }]
  if (Array.isArray(raw)) return raw
  if (isObj(raw)) return [raw]
  return raw
}

/** 注册用户自定义函数（spec.functions）。 */
export function registerUserFunctions(reg: FunctionRegistry, defs: Record<string, FunctionDef> | undefined, timeoutMs: number): void {
  for (const [name, def] of Object.entries(defs ?? {})) {
    reg.set(name, (ctx, args) => {
      const named: Record<string, unknown> = {}
      if (Array.isArray(def.args)) def.args.forEach((n, i) => { named[n] = args[i] })
      const vars = {
        ...ctx.facts, args, ...named,
        doc: ctx.doc, text: ctx.text, fileName: ctx.fileName, relPath: ctx.relPath, specName: ctx.specName, api: SCRIPT_API,
      }
      if (def.script !== undefined) return toScriptResult(runUserScript(def.script, vars, timeoutMs))
      if (def.expr !== undefined) return runUserExpr(def.expr, vars, timeoutMs)
      return undefined
    })
  }
}

/** 构造一份 spec 对应的函数注册表（内置 + 用户）。 */
export function buildRegistry(spec: FormatSpec, timeoutMs: number): FunctionRegistry {
  const reg = new FunctionRegistry()

  // 内置检查原语 → 同名内置函数（args[0] 是参数对象）
  for (const [name, primitive] of Object.entries(PRIMITIVES)) {
    reg.set(name, (ctx, args) => primitive(ctx.doc, isObj(args[0]) ? args[0] : {}, ctx.templateDoc))
  }

  // 通用取值助手
  reg.set('hasSection', (ctx, args) => ctx.doc.headings.some((h) => h.level >= 2 && h.text.includes(str(args[0]))))
  reg.set('sectionText', (ctx, args) => SCRIPT_API.section(ctx.doc, str(args[0])))
  reg.set('collectIds', (ctx, args) => SCRIPT_API.collectIds(ctx.text, Array.isArray(args[0]) ? (args[0] as unknown[]).map(String) : undefined))
  reg.set('countIds', (ctx, args) => SCRIPT_API.collectIds(ctx.text, Array.isArray(args[0]) ? (args[0] as unknown[]).map(String) : undefined).length)
  reg.set('frontmatter', (ctx, args) => ctx.doc.frontmatter[str(args[0])])
  reg.set('length', (_ctx, args) => (typeof args[0] === 'string' || Array.isArray(args[0])) ? (args[0] as { length: number }).length : 0)
  reg.set('count', (_ctx, args) => (Array.isArray(args[0]) ? args[0].length : 0))
  reg.set('matches', (_ctx, args) => { try { return new RegExp(str(args[1])).test(str(args[0])) } catch { return false } })
  reg.set('exists', (_ctx, args) => args[0] !== undefined && args[0] !== null)

  registerUserFunctions(reg, spec.functions, timeoutMs)
  return reg
}
