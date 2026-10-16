/**
 * 目标结构骨架——spec 没有 template 文件时，从声明式规则反推「文档该长什么样」。
 *
 * 只认结构类内置原语（frontmatterRequired / sectionsRequired / tableRequired）：
 * 骨架只描述形状，不重复全部判据（编号、禁写文本等仍由规则报错）。
 * @module dsh-file-enhance/content-format/skeleton
 */
import type { FormatSpec } from './types.js'

interface Shape {
  frontmatter: string[]
  sections: string[]
  tables: Array<{ under?: string; header: string[] }>
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

/** 在条件树里找结构类 fn 节点；只下钻 all（any/not 是分支，画不出唯一骨架）。 */
function collect(cond: unknown, shape: Shape): void {
  if (!isObj(cond)) return
  if (Array.isArray(cond.all)) {
    for (const child of cond.all) collect(child, shape)
    return
  }
  if (typeof cond.fn !== 'string') return
  const args = Array.isArray(cond.args) ? cond.args : []
  const p = isObj(args[0]) ? args[0] : undefined
  if (p === undefined) return
  if (cond.fn === 'frontmatterRequired') {
    for (const k of asStrings(p.keys)) if (!shape.frontmatter.includes(k)) shape.frontmatter.push(k)
  } else if (cond.fn === 'sectionsRequired') {
    for (const h of asStrings(p.headings)) if (!shape.sections.includes(h)) shape.sections.push(h)
  } else if (cond.fn === 'tableRequired') {
    shape.tables.push({ under: typeof p.under === 'string' ? p.under : undefined, header: asStrings(p.header) })
  }
}

function tableLines(header: string[]): string[] {
  if (header.length === 0) return ['（此处放表格）']
  return [
    '| ' + header.join(' | ') + ' |',
    '| ' + header.map(() => '---').join(' | ') + ' |',
    '| ' + header.map(() => '   ').join(' | ') + ' |',
  ]
}

/** 从 spec.rules 生成目标骨架；推不出结构时返回 undefined。 */
export function buildSkeleton(spec: FormatSpec): string | undefined {
  const shape: Shape = { frontmatter: [], sections: [], tables: [] }
  for (const rule of spec.rules) collect(rule.assert, shape)
  if (shape.frontmatter.length === 0 && shape.sections.length === 0 && shape.tables.length === 0) return undefined

  const lines: string[] = []
  if (shape.frontmatter.length > 0) {
    lines.push('---')
    for (const k of shape.frontmatter) lines.push(k + ': ')
    lines.push('---', '')
  }
  lines.push('# <标题>', '')
  const used = new Set<number>()
  for (const s of shape.sections) {
    lines.push('## ' + s, '')
    shape.tables.forEach((t, i) => {
      if (t.under !== undefined && s.includes(t.under)) { lines.push(...tableLines(t.header), ''); used.add(i) }
    })
  }
  shape.tables.forEach((t, i) => { if (!used.has(i)) lines.push(...tableLines(t.header), '') })
  return lines.join('\n').trimEnd() + '\n'
}
