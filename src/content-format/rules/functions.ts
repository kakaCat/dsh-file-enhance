/**
 * 函数注册表——规则引擎里的具名函数（内置 + 用户自定义）。
 * @module dsh-file-enhance/content-format/rules/functions
 */
import type { Facts } from './types.js'

/** 函数执行上下文。 */
export interface FnContext {
  facts: Facts
  doc: Facts['doc']
  text: string
  fileName: string
  relPath: string
  specName: string
  templateDoc?: Facts['doc']
}

export type Fn = (ctx: FnContext, args: unknown[]) => unknown

export class FunctionRegistry {
  private readonly map = new Map<string, Fn>()
  set(name: string, fn: Fn): this { this.map.set(name, fn); return this }
  has(name: string): boolean { return this.map.has(name) }
  call(name: string, ctx: FnContext, args: unknown[]): unknown {
    const fn = this.map.get(name)
    if (fn === undefined) throw new Error('未知函数：' + name)
    return fn(ctx, args)
  }
}
