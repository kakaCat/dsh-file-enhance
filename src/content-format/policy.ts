/**
 * 内容校验策略——普通 write/edit 与自动纠偏共用的决策层。
 *
 * 输入已经完成的校验报告，统一处理 enforce_on、mode、warning、重试预算和
 * on_exhausted；调用方只负责把 block / accept 映射到宿主钩子的返回形状。
 * @module dsh-file-enhance/content-format/policy
 */
import type { FormatReport, FormatSpec } from './types.js'
import type { AttemptStore } from './attempts.js'
import { renderFormatGuidance, type GuidanceArgs } from './report.js'

export type FormatGuidance = Omit<GuidanceArgs, 'report' | 'attempts' | 'maxAttempts' | 'sameContent' | 'advisory'>

export interface FormatPolicyInput {
  spec: FormatSpec
  report: FormatReport
  content: string
  key: string
  attempts: AttemptStore
  guidance: FormatGuidance
}

export type FormatPolicyDecision =
  | { kind: 'none' }
  | { kind: 'block'; text: string }
  | { kind: 'accept'; text: string }

function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return String(h >>> 0)
}

/** 把一份校验报告变成统一的“无反馈 / 阻断 / 放行但提示”决策。 */
export function decideFormatPolicy(input: FormatPolicyInput): FormatPolicyDecision {
  const { spec, report, content, key, attempts, guidance } = input
  if (spec.mode === 'off' || !spec.enforceOn.includes(guidance.op)) return { kind: 'none' }

  const hasErrors = report.newErrors.length > 0
  const hasWarnings = report.newWarnings.length > 0
  if (!hasErrors && !hasWarnings) {
    attempts.reset(key)
    return { kind: 'none' }
  }

  const render = (count: number, sameContent: boolean, advisory = false): string => renderFormatGuidance({
    ...guidance,
    report,
    attempts: count,
    maxAttempts: spec.maxAttempts,
    sameContent,
    advisory,
  })

  // warn 是纯提示模式，不消耗阻断预算；error 与 warning 都只回上下文。
  if (spec.mode === 'warn') {
    return { kind: 'accept', text: '⚠️ 内容规范提醒（mode=warn，不阻断）\n\n' + render(1, false, true) }
  }

  // 软门独立出现时也必须有反馈，但不能消耗 error 的重试预算。
  if (!hasErrors) {
    attempts.reset(key)
    return { kind: 'accept', text: '⚠️ 内容规范建议（不阻断）\n\n' + render(1, false, true) }
  }

  const { attempts: count, sameContent } = attempts.bump(key, hash(content))
  const text = render(count, sameContent)
  if (count <= spec.maxAttempts || spec.onExhausted === 'block') return { kind: 'block', text }
  return {
    kind: 'accept',
    text: '⚠️ 内容校验未通过，已按 on_exhausted=allow 放行\n\n' + text,
  }
}
