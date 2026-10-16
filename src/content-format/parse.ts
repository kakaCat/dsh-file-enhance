/**
 * 文档结构解析——纯函数，零 IO。
 *
 * 关键约束：**跳过代码围栏块**（借鉴 pm 插件 content-gates/doc-parse 的实测教训）——
 * 文档里贴一段代码就可能出现行首井号或竖线，那都不是结构。
 * @module dsh-file-enhance/content-format/parse
 */
import type { ParsedDoc } from './types.js'

const FENCE_RE = /^\s*(`{3,}|~{3,})/
const HEADING_RE = /^(#{1,6})\s+(.+)$/
const FM_DELIM_RE = /^---\s*$/
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/
const TABLE_SEP_RE = /^\s*\|[\s:|-]+\|\s*$/

/** 标记每一行是否处于代码围栏内（含围栏行本身）。 */
export function markCodeFences(lines: readonly string[]): boolean[] {
  const inFence = new Array<boolean>(lines.length).fill(false)
  let open: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i])
    if (open === undefined) {
      if (m !== null) { open = m[1][0]; inFence[i] = true }
    } else {
      inFence[i] = true
      if (m !== null && m[1][0] === open) open = undefined
    }
  }
  return inFence
}

function splitCells(line: string): string[] {
  const m = TABLE_ROW_RE.exec(line)
  if (m === null) return []
  return m[1].split('|').map((s) => s.trim())
}

/** 解析文档为结构（纯函数）。 */
export function parseDocument(text: string): ParsedDoc {
  const lines = String(text ?? '').split(/\r?\n/)
  const inFence = markCodeFences(lines)
  const frontmatter: Record<string, string> = {}
  let start = 0
  if (lines.length > 0 && FM_DELIM_RE.test(lines[0])) {
    for (let i = 1; i < lines.length; i++) {
      if (FM_DELIM_RE.test(lines[i])) { start = i + 1; break }
      const idx = lines[i].indexOf(':')
      if (idx > 0) {
        const k = lines[i].slice(0, idx).trim()
        const v = lines[i].slice(idx + 1).trim()
        if (k.length > 0) frontmatter[k] = v
      }
    }
  }
  const headings: ParsedDoc['headings'] = []
  const tables: ParsedDoc['tables'] = []
  const bodyLines: string[] = []
  const bodyLineNos: number[] = []
  for (let i = start; i < lines.length; i++) {
    if (inFence[i]) continue
    bodyLines.push(lines[i])
    bodyLineNos.push(i + 1)
    const h = HEADING_RE.exec(lines[i])
    if (h !== null) headings.push({ level: h[1].length, text: h[2].trim(), line: i + 1 })
    if (TABLE_ROW_RE.test(lines[i])) {
      const next = lines[i + 1]
      if (next !== undefined && !inFence[i + 1] && TABLE_SEP_RE.test(next)) {
        const rows: string[][] = []
        let j = i + 2
        while (j < lines.length && !inFence[j] && TABLE_ROW_RE.test(lines[j])) { rows.push(splitCells(lines[j])); j++ }
        tables.push({ header: splitCells(lines[i]), rows, line: i + 1 })
        i = j - 1
      }
    }
  }
  return { frontmatter, headings, tables, bodyLines, bodyLineNos, lineCount: lines.length, charCount: text.length }
}
