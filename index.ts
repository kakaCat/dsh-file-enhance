/**
 * dsh-file-guide —— Cordis 插件入口。
 *
 * 职责一句话：**让 agent 按项目自己的规范创建文件**。
 *
 * 三层：
 *   ① 规则（`.dsh/file-rules/<ext>.yaml`，用户设计、mtime 热重载）——唯一权威
 *   ② 判定链（`decide.ts` 纯函数）——扩展名过滤 → 根目录白名单 → 主目录归属 →
 *      现实目录优先 → 规则兜底 → 自由发挥
 *   ③ 拦截器（`tools/pre-execute`）——规范唯一的注入时刻：合规放行，未分类自动纠偏，
 *      不合规打回并附「指引单」（正确路径 + 现有结构 + 分类菜单）
 *
 * 规范**不常驻 system prompt**：只在创建被拦下的那一刻随工具结果进入对话。
 *
 * @module dsh-file-guide
 */
import type { Context } from '@deepseek-ai/cordis'
import { RulesStore } from './src/rules.js'
import { installInterceptor } from './src/intercept.js'
import {
  defineFileCheckTool, defineFileProposeTool, defineFileResolveTool, defineFileRulesInitTool,
  type AskAnswer, type AskFn, type ToolsDeps,
} from './src/tools.js'

export const name = 'dsh-file-guide'

/** 依赖宿主工具服务（注册工具 + 监听 pre-execute）。 */
export const inject = ['tools']

export interface Config {
  /**
   * 自动纠偏（方案 A：插件代写到规范路径）：**默认 false**。
   * false = 方案 B：打回并在指引单里给出【正确路径】，由 agent 自己用新路径重试 write
   * （宿主原生 write 依旧是文件的写者）。
   */
  autoCorrect?: boolean
}

interface LoggerLike {
  info?: (msg: string) => void
  warn?: (msg: string) => void
  debug?: (msg: string) => void
}

/** 从工作区加载规则、接线拦截器与工具。 */
export function apply(ctx: Context, config: Config = {}): void {
  const anyCtx = ctx as unknown as {
    logger?: (n: string) => LoggerLike
    inject?: (services: string[], cb: (c: Record<string, unknown>) => void) => void
    on?: (name: string, listener: unknown) => unknown
    tools?: { register: (tool: unknown) => unknown }
  }
  const logger = anyCtx.logger?.(name)
  const store = new RulesStore({ workspaceRoot: process.cwd(), logger })
  const toolsDeps: ToolsDeps = {}

  // 用户问答通道（file_propose 的批准弹框）：服务可能缺失（无 UI / 子代理）——
  // 缺失时 file_propose 退化为「把提议转述给用户」，绝不伪造批准。
  anyCtx.inject?.(['userQuestions'], (c) => {
    const svc = c?.userQuestions as { ask?: (req: unknown) => Promise<{ answers?: AskAnswer[] }> } | undefined
    const askFn = svc?.ask
    if (askFn === undefined) {
      logger?.debug?.('userQuestions 不在场：file_propose 将退化为文字提议')
      return
    }
    toolsDeps.ask = (async (questions) => {
      const res = await askFn.call(svc, { questions })
      return res?.answers ?? []
    }) as AskFn
    logger?.debug?.('userQuestions ready（file_propose 弹框可用）')
  })

  anyCtx.inject?.(['tools'], (toolsCtx) => {
    const reg = (toolsCtx as { on?: (n: string, l: unknown) => unknown }).on
    if (typeof reg === 'function') {
      installInterceptor(store, (listener) => reg.call(toolsCtx, 'tools/pre-execute', listener), {
        autoCorrect: config.autoCorrect,
      })
    }
    const tools = (toolsCtx as { tools?: { register: (t: unknown) => unknown } }).tools
    if (tools === undefined || typeof tools.register !== 'function') {
      logger?.warn?.('tools 服务不可用：file_resolve / file_propose / file_check 未注册')
      return
    }
    tools.register(defineFileResolveTool(store, toolsDeps))
    tools.register(defineFileProposeTool(store, toolsDeps))
    tools.register(defineFileCheckTool(store))
    tools.register(defineFileRulesInitTool(store))
    logger?.info?.(`已装载：规则目录 ${store.dir}（${store.types().join(', ') || '暂无规则文件'}）`)
  })
}

export { RulesStore } from './src/rules.js'
export { decide } from './src/decide.js'
export { EXAMPLE_MD_RULES } from './src/tools.js'
