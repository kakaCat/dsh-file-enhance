/**
 * 内容校验监听器——tools/post-execute。
 *
 * write / edit 成功后，用结果里带回的最终全文 after 做匹配 + 校验：
 *   符合 → accept（**零返回**，agent 无感）
 *   不符合 → block（一次报全违规 + 模板），agent 改完重试
 *
 * 为什么在后钩子：edit 的最终全文只有执行完才知道；且结果自带 before/after，不用读盘。
 * @module dsh-file-enhance/content-format/post-check
 */
import { basename, isAbsolute, join, relative } from 'node:path'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { extKeyOf, toAbs } from '../folder-path/paths.js'
import { AttemptStore } from './attempts.js'
import { decideFormatPolicy } from './policy.js'
import { readTemplate, type FormatStore } from './spec.js'
import { buildSkeleton } from './skeleton.js'
import { validateDocument } from './validate.js'

const FORMAT_TOOLS = new Set(['write', 'edit'])

interface LoggerLike { info?: (m: string) => void; warn?: (m: string) => void; debug?: (m: string) => void }

export type PostRegister = (
  listener: (exec: ToolExecution, result: ToolExecutionResult, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>,
) => unknown

export interface PostCheckDeps {
  /**
   * 工作区根解析端口：**每次调用按 agent 解析**（宿主 workingDirectory 服务），
   * 因为桌面宿主的 process.cwd() 是 profile 目录而非会话工作区。缺省回落 workspaceRoot。
   */
  resolveRoot?: (exec: ToolExecution) => Promise<string>
  /** 回落默认根（构造时的 process.cwd()；CLI 直连场景正确）。 */
  workspaceRoot?: string
  logger?: LoggerLike
  attemptTtlMs?: number
}

/** 安装内容校验；返回卸载函数。 */
export function installPostCheck(store: FormatStore, register: PostRegister, deps: PostCheckDeps): () => void {
  const attempts = new AttemptStore(deps.attemptTtlMs)
  const textBlock = (text: string): { type: 'text'; text: string } => ({ type: 'text', text })

  const listener = async (
    exec: ToolExecution,
    result: ToolExecutionResult,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    if (!FORMAT_TOOLS.has(exec.name)) return next()
    if (result.isError) return next()
    const value = result.value as { path?: unknown; before?: unknown; after?: unknown; operation?: unknown } | undefined
    if (value === undefined || typeof value.after !== 'string') return next()

    const rawPath = typeof value.path === 'string' ? value.path : undefined
    if (rawPath === undefined || rawPath === '') return next()
    const workspaceRoot = deps.resolveRoot !== undefined
      ? await deps.resolveRoot(exec)
      : deps.workspaceRoot ?? process.cwd()
    const abs = toAbs(workspaceRoot, rawPath)
    const rel = relative(workspaceRoot, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return next()

    const spec = store.match(rel.split(/[/\\]+/).join('/'), basename(abs), extKeyOf(abs), workspaceRoot)

    if (spec === undefined) return next()

    const op: 'create' | 'update' = exec.name === 'edit' ? 'update' : value.operation === 'create' ? 'create' : 'update'
    if (!spec.enforceOn.includes(op)) return next()

    const before = typeof value.before === 'string' ? value.before : null
    const templateText = readTemplate(spec)
    const skeletonText = buildSkeleton(spec)
    const exampleRel = spec.example === undefined ? undefined : relative(workspaceRoot, join(spec.dir, spec.example))
    const relPosix = rel.split(/[/\\]+/).join('/')
    const report = validateDocument(spec, value.after, before, templateText, { fileName: basename(abs), relPath: relPosix })
    const key = (exec.agent?.id ?? 'agent') + ':' + abs
    const decision = decideFormatPolicy({
      spec,
      report,
      content: value.after,
      key,
      attempts,
      guidance: {
        relPath: relPosix,
        specName: spec.name,
        templateRel: spec.template,
        templateText,
        skeletonText,
        exampleRel,
        op,
      },
    })

    if (decision.kind === 'none') return next()
    if (decision.kind === 'block') return { kind: 'block', feedback: [textBlock(decision.text)] }
    return { kind: 'accept', content: [textBlock(decision.text)] }
  }

  register(listener)
  return () => { attempts.clear() }
}
