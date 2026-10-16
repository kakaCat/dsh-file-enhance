/**
 * 内容指引单渲染——唯一的内容规范注入文本。
 *
 * 打回时给三样东西：不符合清单、**目标结构**（模板文件优先，没有就从规则推骨架）、怎么改。
 * @module dsh-file-enhance/content-format/report
 */
import type { FormatReport } from './types.js'

export interface GuidanceArgs {
  relPath: string
  specName: string
  templateRel?: string
  report: FormatReport
  attempts: number
  maxAttempts: number
  /** spec.template 指向的模板正文（存在时优先展示）。 */
  templateText?: string
  /** 无模板文件时，由规则推出的目标结构骨架。 */
  skeletonText?: string
  /** 同目录 example.md 的工作区相对路径（可选，只给指针不内联）。 */
  exampleRel?: string
  op: 'create' | 'update'
  sameContent: boolean
  /** 纯提示模式：不展示阻断次数与“剩余机会”。 */
  advisory?: boolean
}

function line(v: { line?: number }): string {
  return v.line !== undefined ? '（第 ' + v.line + ' 行）' : ''
}

function targetBlock(a: GuidanceArgs): { label: string; text: string } | undefined {
  if (a.templateText !== undefined && a.templateText.trim() !== '') {
    return { label: '【目标模板（把文档改成这个结构）】', text: a.templateText.trimEnd() }
  }
  if (a.skeletonText !== undefined && a.skeletonText.trim() !== '') {
    return { label: '【目标结构（按规范应长这样，照此补齐）】', text: a.skeletonText.trimEnd() }
  }
  return undefined
}

/** 渲染一张内容指引单（纯字符串，无 IO）。 */
export function renderFormatGuidance(a: GuidanceArgs): string {
  const out: string[] = []
  const opLabel = a.op === 'create' ? '新建' : '修改'
  const advisory = a.advisory === true
  out.push((advisory ? '⚠️ 内容规范提醒：' : '⛔ 内容未通过格式规范：') + a.relPath)
  out.push('    匹配到的规范：' + a.specName + (a.templateRel !== undefined ? '（模板 ' + a.templateRel + '）' : ''))
  const total = a.report.newErrors.length + a.report.newWarnings.length
  out.push('【符合情况】' + total + ' 项不符合' + (advisory ? '' : '（第 ' + a.attempts + ' 次，最多 ' + a.maxAttempts + ' 次）'))
  out.push('')

  out.push('【不符合清单】')
  a.report.newErrors.forEach((v, i) => out.push('  ' + (i + 1) + '. [' + v.checkId + '] ' + v.message + line(v)))
  if (a.report.newWarnings.length > 0) {
    out.push('【建议（不阻断）】')
    a.report.newWarnings.forEach((v, i) => out.push('  ' + (i + 1) + '. [' + v.checkId + '] ' + v.message + line(v)))
  }

  const target = targetBlock(a)
  if (target !== undefined) {
    out.push('')
    out.push(target.label)
    out.push(target.text)
  }
  if (a.exampleRel !== undefined && a.exampleRel !== '') {
    out.push('')
    out.push('【填写参考】' + a.exampleRel + '（一份填好的同类文档，可用 read 打开）')
  }

  const remaining = Math.max(0, a.maxAttempts - a.attempts)
  out.push('')
  if (a.sameContent) out.push('【提醒】本次内容与你上次被拒的内容一致，仍不符合——请先改内容再重试。')
  out.push('【怎么改】把文档改成上面的目标结构，并逐条修正不符合项；用 write 或 edit 修同一文件（本次' + opLabel + '，已一次报全）')
  if (advisory) out.push('【处理】以上仅为规范提醒，不阻断本次写入；仍建议按清单修正。')
  else out.push('【还有】' + remaining + ' 次机会；用尽后按 on_exhausted 放行或继续拦截')
  return out.join('\n')
}
