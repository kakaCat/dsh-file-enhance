/**
 * dsh-file-enhance —— Cordis 插件入口。
 *
 * 职责一句话：**让 agent 按项目自己的规范创建文件**。
 *
 * 三层：
 *   ① 规则（`.dsh/folder-path-rules/<ext>.yaml`，用户设计、mtime 热重载）——工作区优先；
 *      无文件时回落内置默认参与判定并落盘垫片（config.scaffoldDefault，默认开）
 *   ② 判定链（`decide.ts` 纯函数）——扩展名过滤 → 根目录白名单 → 主目录归属 →
 *      现实目录优先 → 规则兜底 → 自由发挥
 *   ③ 拦截器（`tools/pre-execute`）——规范唯一的注入时刻：合规放行，未分类自动纠偏，
 *      不合规打回并附「指引单」（正确路径 + 现有结构 + 分类菜单）
 *
 * 规范**不常驻 system prompt**：只在创建被拦下的那一刻随工具结果进入对话。
 *
 * @module dsh-file-enhance
 */
import { basename, join, relative as relativePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { RulesStore } from './folder-path/rules.js'
import { installInterceptor, type ContentValidationResult } from './folder-path/intercept.js'
import { FormatStore, readTemplate } from './content-format/spec.js'
import { AttemptStore } from './content-format/attempts.js'
import { decideFormatPolicy } from './content-format/policy.js'
import { buildSkeleton } from './content-format/skeleton.js'
import { validateDocument } from './content-format/validate.js'
import { installPostCheck } from './content-format/post-check.js'
import { extKeyOf } from './folder-path/paths.js'

export const name = 'dsh-file-enhance'

/**
 * 依赖宿主工具服务——**只用来挂 `tools/pre-execute` 与 `tools/post-execute` 监听器**，
 * 不注册任何自己的工具。
 *
 * 本插件对原生工具做的是**加强**而不是替换：`write` / `edit` 永远是宿主的；
 * 「问用户」用宿主自带的 `ask_user_question`；插件只在判定时刻介入。
 */
export const inject = ['tools']

export interface Config {
  /**
   * 自动纠偏（方案 A：插件按规范路径把内容写下去）：**默认 true**。
   * false = 方案 B：打回并在指引单里给出【正确路径】，由 agent 自己用新路径重试 write。
   */
  autoCorrect?: boolean
  /**
   * 内容格式校验（新增）：默认 true。
   * 开启后 write/edit 落盘即按 .dsh/file-format-specs/*.yaml 匹配并校验，合规零返回，不合规打回。
   */
  contentValidate?: boolean
  /**
   * 冷启动垫片：**默认 true**，对两个子系统同时生效。
   * 路径规则：工作区没有 md 规则文件时，回落**内置默认**参与判定（装完第一单就生效），
   *   同时把默认规则写入 `.dsh/folder-path-rules/md.yaml` 供修改；
   * 文档规范：`.dsh/file-format-specs/` 为空时回落内置默认校验，并写入五套默认规范。
   * 加载优先级永远是「工作区文件 > 内置默认」：文件一旦存在，内置默认立即让位（mtime 热重载）。
   */
  scaffoldDefault?: boolean
}

interface LoggerLike {
  info?: (msg: string) => void
  warn?: (msg: string) => void
  debug?: (msg: string) => void
}

/** 从工作区加载规则、挂上两个监听器（不注册任何工具）。 */
export function apply(ctx: Context, config: Config = {}): void {
  const anyCtx = ctx as unknown as {
    logger?: (n: string) => LoggerLike
    inject?: (services: string[], cb: (c: Record<string, unknown>) => void) => void
    on?: (name: string, listener: unknown) => unknown
    tools?: { register: (tool: unknown) => unknown }
  }
  const logger = anyCtx.logger?.(name)
  const store = new RulesStore({ workspaceRoot: process.cwd(), logger, fallback: config.scaffoldDefault !== false })
  const formatStore = new FormatStore({ workspaceRoot: process.cwd(), logger, scaffold: config.scaffoldDefault !== false })
  const contentEnabled = config.contentValidate !== false
  const autoCorrectAttempts = new AttemptStore()

  /**
   * 工作区根按 agent 解析：桌面宿主的 process.cwd() 是 profile 目录而非会话工作区。
   * 两个口径都支持，新宿主优先：
   *   1. dsh ≥0.2.1-alpha.2：`ctx.workingDirectory.ensure(agent, signal)`（含目录迁移恢复）；
   *   2. dsh 0.2.0-rc.x：直接读 `exec.agent.session.header.cwd`（宿主 fs 工具同一口径）；
   *   3. 都没有 → 回落 process.cwd()（CLI 直连场景 cwd 即工作区，行为不变）。
   */
  interface HostWorkingDirectory {
    ensure: (agent: unknown, signal?: AbortSignal) => Promise<string>
  }
  let workingDirectory: HostWorkingDirectory | undefined
  anyCtx.inject?.(['workingDirectory'], (c) => {
    const svc = c?.workingDirectory as HostWorkingDirectory | undefined
    if (svc !== undefined && typeof svc.ensure === 'function') {
      workingDirectory = svc
      logger?.debug?.('workingDirectory 服务在场：工作区根按 agent 解析')
    } else {
      logger?.debug?.('workingDirectory 服务不在场：尝试 session.header.cwd')
    }
  })
  const resolveRoot = async (exec: unknown): Promise<string> => {
    const e = exec as { agent?: unknown; signal?: AbortSignal } | undefined
    const agent = e?.agent
    if (agent !== undefined) {
      const svc = workingDirectory
      if (svc !== undefined) {
        try {
          return await svc.ensure(agent, e?.signal)
        } catch (err) {
          logger?.warn?.(`workingDirectory.ensure 失败，尝试 session.header.cwd：${String((err as Error)?.message ?? err)}`)
        }
      }
      const headerCwd = (agent as { session?: { header?: { cwd?: unknown } } }).session?.header?.cwd
      if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
    }
    return process.cwd()
  }

  /** 工作区相对路径（posix 分隔）；不在工作区内 → undefined。 */
  const contentRel = (root: string, abs: string): string | undefined => {
    const rel = relativePath(root, abs)
    if (rel === '' || rel.startsWith('..')) return undefined
    return rel.split(/[/\\]+/).join('/')
  }
  /** 代写前内容校验：与普通 post 校验共用策略；reason 阻断，feedback 随纠偏回执提示。 */
  const validateContentForWrite = (
    root: string,
    abs: string,
    content: string,
    attemptKey: string,
  ): ContentValidationResult | undefined => {
    if (!contentEnabled) return undefined
    const rel = contentRel(root, abs)
    if (rel === undefined) return undefined
    const spec = formatStore.match(rel, basename(abs), extKeyOf(abs), root)
    if (spec === undefined || !spec.enforceOn.includes('create')) return undefined
    const templateText = readTemplate(spec)
    const report = validateDocument(spec, content, null, templateText, { fileName: basename(abs), relPath: rel })
    const decision = decideFormatPolicy({
      spec,
      report,
      content,
      key: attemptKey,
      attempts: autoCorrectAttempts,
      guidance: {
        relPath: rel,
        specName: spec.name,
        templateRel: spec.template,
        templateText,
        skeletonText: buildSkeleton(spec),
        exampleRel: spec.example === undefined ? undefined : relativePath(root, join(spec.dir, spec.example)),
        op: 'create',
      },
    })
    if (decision.kind === 'none') return undefined
    return decision.kind === 'block' ? { reason: decision.text } : { feedback: decision.text }
  }

  // 宿主 fs 服务：自动纠偏（方案 A）优先走它——父目录由 fs.writeText 的原子写 recursive 建出，
  // 文件的策略/审计仍由宿主这一层管，插件不裸碰磁盘。服务缺失才回落到 node:fs。
  interface HostFs {
    resolve: (p: string, o?: { cwd?: string }) => Promise<unknown>
    writeText: (target: unknown, content: string) => Promise<unknown>
  }
  let hostFs: HostFs | undefined
  anyCtx.inject?.(['fs'], (c) => {
    const svc = c?.fs as HostFs | undefined
    if (svc !== undefined && typeof svc.resolve === 'function' && typeof svc.writeText === 'function') {
      hostFs = svc
      logger?.debug?.('fs 服务在场：自动纠偏经宿主 fs 写入（目录 recursive、策略参与）')
    } else {
      logger?.debug?.('fs 服务不在场：自动纠偏回落 node:fs')
    }
  })

  // 用户问答通道不由本插件提供：需要用户拍板时，agent 直接调宿主自带的 `ask_user_question`
  // （它背后是同一个 ctx.userQuestions 服务）。插件不代理这一步，也就不需要注入该服务。

  anyCtx.inject?.(['tools'], (toolsCtx) => {
    const reg = (toolsCtx as { on?: (n: string, l: unknown) => unknown }).on
    if (typeof reg !== 'function') {
      logger?.warn?.('tools 服务不可用：路径判定与内容校验均未装载')
      return
    }
    const fsSvc = hostFs
    installInterceptor(store, (listener) => reg.call(toolsCtx, 'tools/pre-execute', listener), {
      autoCorrect: config.autoCorrect,
      resolveRoot,
      validateContent: contentEnabled ? validateContentForWrite : undefined,
      ...(config.scaffoldDefault === false ? {} : {
        scaffold: (root: string, extKey: string) => {
          const r = store.scaffoldDefault(extKey, root)
          if (r.created) {
            logger?.info?.(`冷启动垫片：已生成默认规则 ${r.path}（按项目修改后 mtime 热重载即时生效）`)
          }
        },
      }),
      ...(fsSvc === undefined ? {} : {
        writeFile: async (abs: string, content: string) => {
          const target = await fsSvc.resolve(abs)
          await fsSvc.writeText(target, content)
        },
      }),
    })
    // 内容格式校验：write/edit 成功后按最终全文校验，合规零返回，不合规 block。
    if (contentEnabled) {
      installPostCheck(formatStore, (listener) => reg.call(toolsCtx, 'tools/post-execute', listener), {
        resolveRoot,
        logger,
      })
    }
    logger?.info?.(`已装载（纯监听器，无自有工具）：规则目录 ${store.dir}（${store.types().join(', ') || '暂无规则文件'}）`)
  })
}

export { RulesStore } from './folder-path/rules.js'
export { decide } from './folder-path/decide.js'
