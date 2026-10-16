/**
 * 内置检查原语——每个原语一个纯函数：ParsedDoc + 参数 → 失败列表。
 *
 * 这里没有「检查类型」概念，只有函数：规则引擎把它们注册成内置函数
 * （sectionsRequired / tableRequired / ids …），在规则的 fn 条件里调用。
 *
 * 纪律：
 *  - 只判机器能证伪的结构事实，不判散文好坏；
 *  - 每条失败给出行号；
 *  - 一次跑完全部、聚合返回，绝不第一条就停。
 * @module dsh-file-enhance/content-format/primitives
 */
import type { ParsedDoc, Severity } from './types.js'

/** 原语参数（YAML 里 fn 的 args[0]）。 */
export type CheckParams = Record<string, unknown>

/** 一条失败（消息 + 语义 key + 行号 + 严重度）。 */
export interface CheckFailure {
  message: string
  key?: string
  line?: number
  severity?: Severity
}

/** 原语签名：文档 + 参数 → 失败列表。 */
export type CheckPrimitive = (doc: ParsedDoc, params: CheckParams, templateDoc?: ParsedDoc) => CheckFailure[]

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

function failure(key: string, message: string, extra: Omit<CheckFailure, 'key' | 'message'> = {}): CheckFailure {
  return { key, message, ...extra }
}

/**
 * 标题归一化：剥掉行内 HTML 注释、`serves: …` 标注、前导编号（1. / 1.1 / 一、）、尾部括注。
 * 结构规则按归一化标题**精确匹配**——否则 `## 非功能需求` 会被 `功能需求` 的 includes 命中，
 * 节名漂移就检查不出来。
 */
export function normalizeHeading(text: string): string {
  return String(text)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\bserves\s*[:：][^\n]*$/i, ' ')
    .replace(/^\s*\d+(?:\.\d+)*[.、)）]?\s*/, '')
    .replace(/[（(][^（()）]*[)）]\s*$/, ' ')
    .replace(/[`\s]+$/g, '')
    .trim()
}

function frontmatterRequired(doc: ParsedDoc, params: CheckParams): CheckFailure[] {
  const out: CheckFailure[] = []
  for (const k of asStrings(params.keys)) {
    const val = doc.frontmatter[k]
    if (val === undefined) out.push(failure('missing:' + k, 'front-matter 缺字段：' + k))
    else if (val.trim() === '') out.push(failure('empty:' + k, 'front-matter 字段为空：' + k))
  }
  return out
}

function frontmatterEnum(doc: ParsedDoc, params: CheckParams): CheckFailure[] {
  const key = asStr(params.key)
  const values = asStrings(params.values)
  if (key === undefined) return []
  const val = doc.frontmatter[key]
  if (val === undefined || values.includes(val)) return []
  return [failure('enum:' + key + ':' + val, 'front-matter ' + key + ' 的值「' + val + '」不在允许值域')]
}

function frontmatterPattern(doc: ParsedDoc, params: CheckParams): CheckFailure[] {
  const key = asStr(params.key)
  const pattern = asStr(params.pattern)
  if (key === undefined || pattern === undefined) return []
  const val = doc.frontmatter[key]
  if (val === undefined) return []
  try {
    if (new RegExp(pattern).test(val)) return []
  } catch { return [failure('bad-pattern:' + key, 'spec 的 pattern 非法：' + pattern)] }
  return [failure('pattern:' + key, 'front-matter ' + key + ' 的值「' + val + '」不匹配 ' + pattern)]
}

function sectionsRequired(doc: ParsedDoc, params: CheckParams): CheckFailure[] {
  const out: CheckFailure[] = []
  const required = asStrings(params.headings).map((raw) => ({ raw, name: normalizeHeading(raw) }))
  const h2 = doc.headings.filter((h) => h.level === 2).map((h) => normalizeHeading(h.text))
  const idxOf = (name: string): number => h2.indexOf(name)
  for (const req of required) {
    if (idxOf(req.name) < 0) out.push(failure('missing-section:' + req.raw, '缺章节「' + req.raw + '」'))
  }
  if (params.order === true) {
    let last = -1
    for (const req of required) {
      const idx = idxOf(req.name)
      if (idx < 0) continue
      if (idx < last) out.push(failure('order:' + req.raw, '章节顺序不符：「' + req.raw + '」应在前面'))
      if (idx > last) last = idx
    }
  }
  return out
}

function sectionsForbidden(doc: ParsedDoc, params: CheckParams): CheckFailure[] {
  const out: CheckFailure[] = []
  for (const f of asStrings(params.headings)) {
    const name = normalizeHeading(f)
    const h = doc.headings.find((x) => x.level >= 2 && normalizeHeading(x.text) === name)
    if (h !== undefined) out.push(failure('forbidden-section:' + f, '出现禁止章节「' + f + '」', { line: h.line }))
  }
  return out
}

function tableRequired(doc: ParsedDoc, params: CheckParams): CheckFailure[] {
  const out: CheckFailure[] = []
  const header = asStrings(params.header)
  const under = asStr(params.under)
  const minRows = asNum(params.min_rows) ?? 1
  let tables = doc.tables
  if (under !== undefined) {
    const underName = normalizeHeading(under)
    const h = doc.headings.find((x) => normalizeHeading(x.text) === underName)
    tables = h === undefined ? [] : doc.tables.filter((t) => t.line > h.line)
  }
  // 先按范围找到「候选表」：有任何一列必需表头即算数，缺列再逐列报——
  // 否则一张表只差一列会被误报成「整张表都没有」。
  const table = header.length === 0
    ? tables[0]
    : tables.find((t) => t.header.some((c) => header.some((req) => c.includes(req))))
  if (table === undefined) {
    const where = under !== undefined ? '「' + under + '」节' : '文档'
    out.push(failure('missing-table:' + (under ?? '') + ':' + header.join(','), where + '缺表（表头需含 ' + header.join('/') + '）'))
    return out
  }
  for (const req of header) {
    if (!table.header.some((c) => c.includes(req))) {
      out.push(failure('missing-col:' + req, '表缺列「' + req + '」（第 ' + table.line + ' 行）', { line: table.line }))
    }
  }
  if (table.rows.length < minRows) {
    out.push(failure('min-rows', '表数据行不足：至少 ' + minRows + ' 行（第 ' + table.line + ' 行）', { line: table.line }))
  }
  return out
}

const ID_CELL_RE = /^([A-Z]{1,5}-\d+)$/
const ID_HEAD_RE = /^([A-Z]{1,5}-\d+)\b/

const FIELD_LABEL_RE = /^\*\*([^*]+)\*\*\s*(.*)$/

/** 把一段正文按 `**小节名**` 切成若干段（小节名不在 labels 里的行并入上一段）。 */
function splitFields(text: string, labels: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  let current: string | undefined
  let buf: string[] = []
  const flush = (): void => { if (current !== undefined) out.set(current, buf.join('\n')); buf = [] }
  for (const ln of text.split('\n')) {
    const m = FIELD_LABEL_RE.exec(ln.trim())
    if (m !== null && labels.includes(m[1])) {
      flush()
      current = m[1]
      if (m[2].trim() !== '') buf.push(m[2])
      continue
    }
    if (current !== undefined) buf.push(ln)
  }
  flush()
  return out
}

/**
 * 清单 ↔ 明细对齐：under 节之后第一张表的第一列里每个编号，都要有一个以该编号开头的标题。
 * 缺表 / 缺列由 tableRequired 负责，这里只管「清单有、明细缺」。
 *
 * 小节分两档：
 *   - fields   必填：标题必须出现，且**要有内容**（不能只写标题）。
 *   - optional 按需：不写就不写；**写了标题就必须有内容**（防止占位空壳）。
 */
function idDetails(doc: ParsedDoc, params: CheckParams): CheckFailure[] {
  const under = asStr(params.under)
  let tables = doc.tables
  if (under !== undefined) {
    const underName = normalizeHeading(under)
    const h = doc.headings.find((x) => normalizeHeading(x.text) === underName)
    tables = h === undefined ? [] : doc.tables.filter((t) => t.line > h.line)
  }
  const table = tables[0]
  if (table === undefined) return []
  const listIds: string[] = []
  for (const row of table.rows) {
    const m = ID_CELL_RE.exec(String(row[0] ?? '').trim())
    if (m !== null) listIds.push(m[1])
  }
  const detailOf = new Map<string, ParsedDoc['headings'][number]>()
  for (const h of doc.headings) {
    const m = ID_HEAD_RE.exec(h.text.trim())
    if (m !== null && !detailOf.has(m[1])) detailOf.set(m[1], h)
  }
  const lineIndex = new Map<number, number>()
  doc.bodyLineNos.forEach((n, i) => lineIndex.set(n, i))
  /** 标题到「下一个同级或更高级标题」之间的正文。 */
  const blockText = (h: ParsedDoc['headings'][number]): string => {
    const start = lineIndex.get(h.line)
    if (start === undefined) return ''
    let end = doc.bodyLines.length
    for (const other of doc.headings) {
      if (other.line <= h.line || other.level > h.level) continue
      const j = lineIndex.get(other.line)
      if (j !== undefined && j < end) end = j
    }
    return doc.bodyLines.slice(start, end).join('\n')
  }
  const fields = asStrings(params.fields)
  const optional = asStrings(params.optional)
  const labels = [...fields, ...optional]
  const out: CheckFailure[] = []
  for (const id of listIds) {
    const h = detailOf.get(id)
    if (h === undefined) { out.push(failure('detail-missing:' + id, '清单有 ' + id + '，但缺对应明细标题')); continue }
    if (labels.length === 0) continue
    const segs = splitFields(blockText(h), labels)
    for (const f of fields) {
      const seg = segs.get(f)
      if (seg === undefined) out.push(failure('detail-field:' + id + ':' + f, id + ' 的明细缺「' + f + '」小节'))
      else if (seg.trim() === '') out.push(failure('detail-empty:' + id + ':' + f, id + ' 的「' + f + '」小节是空的'))
    }
    for (const f of optional) {
      const seg = segs.get(f)
      if (seg !== undefined && seg.trim() === '') out.push(failure('detail-empty:' + id + ':' + f, id + ' 的「' + f + '」小节是空的'))
    }
  }
  return out
}

const DEF_ID_RE = /^\s*(?:[-*+]\s+)?\*{0,2}([A-Z]{1,5})-(\d+)\b/

function collectDefIds(doc: ParsedDoc, prefixes: readonly string[]): Array<{ id: string; prefix: string; num: number; line: number }> {
  const out: Array<{ id: string; prefix: string; num: number; line: number }> = []
  const push = (text: string, line: number, bold: boolean): void => {
    const m = DEF_ID_RE.exec(bold ? '**' + text : text)
    if (m === null) return
    if (prefixes.length > 0 && !prefixes.includes(m[1])) return
    out.push({ id: m[1] + '-' + m[2], prefix: m[1], num: Number(m[2]), line })
  }
  for (const h of doc.headings) push(h.text, h.line, true)
  doc.bodyLines.forEach((line, i) => push(line, doc.bodyLineNos[i] ?? 0, false))
  return out
}

function ids(doc: ParsedDoc, params: CheckParams): CheckFailure[] {
  const out: CheckFailure[] = []
  const prefixes = asStrings(params.prefixes)
  const defs = collectDefIds(doc, prefixes)
  if (params.unique === true) {
    const seen = new Map<string, number>()
    for (const d of defs) seen.set(d.id, (seen.get(d.id) ?? 0) + 1)
    for (const [id, n] of seen) if (n > 1) out.push(failure('dup:' + id, '编号重复：' + id + '（出现 ' + n + ' 次）'))
  }
  if (params.sequence === true) {
    const byPrefix = new Map<string, number[]>()
    for (const d of defs) {
      const arr = byPrefix.get(d.prefix) ?? []
      arr.push(d.num)
      byPrefix.set(d.prefix, arr)
    }
    for (const [prefix, nums] of byPrefix) {
      const uniq = [...new Set(nums)].sort((a, b) => a - b)
      for (let i = 0; i < uniq.length - 1; i++) {
        for (let missing = uniq[i] + 1; missing < uniq[i + 1]; missing++) {
          out.push(failure('gap:' + prefix + '-' + missing, '编号跳号：缺 ' + prefix + '-' + missing))
        }
      }
    }
  }
  return out
}

function forbiddenText(doc: ParsedDoc, params: CheckParams): CheckFailure[] {
  const out: CheckFailure[] = []
  for (const p of asStrings(params.patterns)) {
    doc.bodyLines.forEach((line, i) => {
      if (p !== '' && line.includes(p)) out.push(failure('forbidden:' + p + ':' + (doc.bodyLineNos[i] ?? i), '命中禁写内容「' + p + '」', { line: doc.bodyLineNos[i] }))
    })
  }
  return out
}

function requiredText(doc: ParsedDoc, params: CheckParams): CheckFailure[] {
  const out: CheckFailure[] = []
  for (const p of asStrings(params.patterns)) {
    if (p !== '' && !doc.bodyLines.some((line) => line.includes(p))) {
      out.push(failure('required:' + p, '缺必需内容「' + p + '」'))
    }
  }
  return out
}

function size(doc: ParsedDoc, params: CheckParams): CheckFailure[] {
  const out: CheckFailure[] = []
  const maxLines = asNum(params.max_lines)
  const maxChars = asNum(params.max_chars)
  if (maxLines !== undefined && doc.lineCount > maxLines) {
    out.push(failure('max-lines', '文档过长：' + doc.lineCount + ' 行 > 上限 ' + maxLines))
  }
  if (maxChars !== undefined && doc.charCount > maxChars) {
    out.push(failure('max-chars', '文档过长：' + doc.charCount + ' 字符 > 上限 ' + maxChars))
  }
  return out
}

function sectionsServes(doc: ParsedDoc): CheckFailure[] {
  const out: CheckFailure[] = []
  for (const h of doc.headings) {
    if (h.level < 2) continue
    if (!/serves\s*[:：]/i.test(h.text)) out.push(failure('serves:' + h.line + ':' + h.text, '章节「' + h.text + '」缺 serves 标注', { line: h.line }))
  }
  return out
}

function templateSections(doc: ParsedDoc, _params: CheckParams, templateDoc?: ParsedDoc): CheckFailure[] {
  if (templateDoc === undefined) return []
  const docNames = new Set(doc.headings.filter((h) => h.level === 2).map((h) => normalizeHeading(h.text)))
  const out: CheckFailure[] = []
  for (const th of templateDoc.headings) {
    if (th.level < 2) continue
    const name = normalizeHeading(th.text)
    if (!docNames.has(name)) out.push(failure('template-missing:' + name, '缺模板章节「' + name + '」'))
  }
  return out
}

/** 内置原语表：YAML 规则里用 { fn: <name> } 调用。 */
export const PRIMITIVES: Record<string, CheckPrimitive> = {
  frontmatterRequired,
  frontmatterEnum,
  frontmatterPattern,
  sectionsRequired,
  sectionsForbidden,
  sectionsServes,
  tableRequired,
  idDetails,
  ids,
  forbiddenText,
  requiredText,
  size,
  templateSections,
}
