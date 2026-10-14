/**
 * 拦截器——`tools/pre-execute` 监听：**规范唯一的注入时刻**。
 *
 * 只管「新建」（目标文件不存在）且只匹配 `.md`（= `.dsh/file-rules/md.yaml` 存在时）。
 * 判定结果三态：
 *   - pass     → 放行，原生 write 照常执行（合规路径零打扰）
 *   - deny     → 打回，reason = 指引单（agent 拿到正确路径与分类菜单）
 *   - correct  → 插件**代写到规范路径**，再打回原调用并告知实际落点（宿主不允许改工具参数，
 *                故「改路径」只能由监听器自己完成写盘）
 *
 * @module dsh-file-guide/intercept
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { decide } from './decide.js'
import { extKeyOf, toAbs } from './paths.js'
import { renderCorrection, renderGuidance } from './guidance.js'
import { scanReality, listNames } from './scan.js'
import type { RulesStore } from './rules.js'
import type { DenyVerdict } from './types.js'

/** 哪些工具算「新建文件」。MVP 只认 write（str_replace_editor 的 create 不在第一版范围）。 */
const WRITE_TOOLS = new Set(['write'])

interface Denial { count: number; at: number }

export interface InterceptorDeps {
  /** 同一目标的拦截记忆保留时长（默认 10 分钟）——超时视为新的一次尝试。 */
  denialTtlMs?: number
  /** 自动纠偏（把未分类文件代写到规范路径）：默认开。 */
  autoCorrect?: boolean
  /** 写盘端口（测试可注入假实现）。 */
  writeFile?: (path: string, content: string, encoding?: 'utf8') => void
  exists?: (path: string) => boolean
  mkdirp?: (path: string) => void
}

/** 安装拦截器；返回卸载函数（cordis 的 ctx.on 亦会随纤维自动卸载）。 */
export function installInterceptor(
  store: RulesStore,
  register: (listener: (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) => unknown,
  deps: InterceptorDeps = {},
): () => void {
  const ttl = deps.denialTtlMs ?? 10 * 60 * 1000
  const autoCorrect = deps.autoCorrect !== false
  const writeFile = deps.writeFile ?? ((p: string, c: string) => writeFileSync(p, c, 'utf8'))
  const exists = deps.exists ?? existsSync
  const mkdirp = deps.mkdirp ?? ((p: string) => { mkdirSync(p, { recursive: true }) })
  const denials = new Map<string, Denial>()

  const bump = (key: string): number => {
    const now = Date.now()
    const prev = denials.get(key)
    const count = prev !== undefined && now - prev.at < ttl ? prev.count + 1 : 1
    denials.set(key, { count, at: now })
    return count
  }
  const priorOf = (key: string): number => {
    const prev = denials.get(key)
    if (prev === undefined) return 0
    return Date.now() - prev.at < ttl ? prev.count : 0
  }

  const listener = async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (!WRITE_TOOLS.has(exec.name)) return next()
    const args = exec.arguments as { file_path?: unknown; content?: unknown } | undefined
    const rawPath = args?.file_path
    if (typeof rawPath !== 'string' || rawPath === '') return next()

    const workspaceRoot = store.workspaceRoot
    const target = toAbs(workspaceRoot, rawPath)
    if (exists(target)) return next() // 改旧文件不归本插件管

    const loaded = store.load(extKeyOf(target))
    if (loaded === undefined) return next() // 该类型无规则 → 不管

    const rules = 'rules' in loaded ? loaded.rules : undefined
    const rootAbs = rules !== undefined ? toAbs(workspaceRoot, rules.root) : undefined
    const tree = rootAbs !== undefined ? scanReality(rootAbs) : undefined
    const key = `${exec.agent?.id ?? 'agent'}:${target}`
    const verdict = decide({
      target, workspaceRoot, loaded, tree,
      priorDenials: priorOf(key), listNames,
    })

    if (verdict.kind === 'pass') {
      denials.delete(key)
      return next()
    }
    if (verdict.kind === 'deny') {
      bump(key)
      return { kind: 'deny', reason: renderGuidance(verdict) }
    }

    // correct：宿主不允许改工具参数，故由监听器自己按规范路径写盘，再向 agent 回执实际落点。
    if (!autoCorrect) {
      bump(key)
      return { kind: 'deny', reason: renderGuidance({ ...(verdict as unknown as DenyVerdict), kind: 'deny', code: 'unclassified' }) }
    }
    try {
      mkdirp(dirname(verdict.to))
      writeFile(verdict.to, typeof args?.content === 'string' ? args.content : '', 'utf8')
      denials.delete(key)
      return {
        kind: 'deny',
        reason: renderCorrection({
          to: relative(workspaceRoot, verdict.to),
          from: rawPath,
          source: verdict.source,
          category: verdict.category,
        }),
      }
    } catch (err) {
      bump(key)
      return {
        kind: 'deny',
        reason: `自动纠偏失败（${String((err as Error)?.message ?? err)}），请手动改用规范路径重试。\n\n`
          + renderGuidance({ ...(verdict as unknown as DenyVerdict), kind: 'deny', code: 'unclassified' }),
      }
    }
  }

  register(listener)
  return () => { denials.clear() }
}
