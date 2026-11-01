/**
 * 文件名里的时间占位符——`{date}` / `{time}` / `{datetime}`，可带 `:格式`。
 *
 * 设计见 [docs/date-prefix-design.md](../../docs/date-prefix-design.md)。三条约束：
 *   1. **纯函数**：时间由调用方注入（缺省 `new Date()`），判定链不直接读钟，测试可钉死；
 *   2. **格式 token 只认六个**：`YYYY` `MM` `DD` `HH` `mm` `ss`，其余字符原样保留
 *      （所以 `YYYY/MM` 能当目录分隔符用）；
 *   3. **命名放宽只剥前缀**，且以 `dest` 里声明的格式为准：剥不掉就走旧逻辑，
 *      不猜意图、不误杀存量文件。
 *
 * @module dsh-file-enhance/folder-path/timefmt
 */
export type TimeKind = 'date' | 'time' | 'datetime'

/** 不写格式时的默认形态。 */
export const DEFAULT_TIME_FORMAT: Record<TimeKind, string> = {
  date: 'YYYY-MM-DD',
  time: 'HHmm',
  datetime: 'YYYY-MM-DD_HHmm',
}

const pad = (n: number): string => String(n).padStart(2, '0')

// 4 位与 2 位分开存：混在一张表里时 `DD` 会先命中「4 位 token」分支，
// 格式化看着没差（都是两位数字），但转正则会变成 \d{4}。
const TOKENS4: Record<string, (d: Date) => string> = {
  YYYY: (d) => String(d.getFullYear()),
}
const TOKENS2: Record<string, (d: Date) => string> = {
  MM: (d) => pad(d.getMonth() + 1),
  DD: (d) => pad(d.getDate()),
  HH: (d) => pad(d.getHours()),
  mm: (d) => pad(d.getMinutes()),
  ss: (d) => pad(d.getSeconds()),
}

/** 按 token 格式化；非 token 字符原样保留（区分大小写：`MM` 是月，`mm` 是分）。 */
export function formatTime(date: Date, format: string): string {
  let out = ''
  for (let i = 0; i < format.length;) {
    const four = format.slice(i, i + 4)
    if (TOKENS4[four] !== undefined) { out += TOKENS4[four](date); i += 4; continue }
    const two = format.slice(i, i + 2)
    if (TOKENS2[two] !== undefined) { out += TOKENS2[two](date); i += 2; continue }
    out += format[i]
    i += 1
  }
  return out
}

const PLACEHOLDER = /\{(date|time|datetime)(?::([^}]+))?\}/g

/** 这段 dest 里有没有时间占位符。 */
export function hasTimePlaceholder(dest: string): boolean {
  PLACEHOLDER.lastIndex = 0
  return PLACEHOLDER.test(dest)
}

/** 时间占位符是否落在**文件名段**（目录段里的只影响落点，不影响命名校验）。 */
export function fileNameHasTimePlaceholder(dest: string): boolean {
  return fileNameTimePlaceholder(dest) !== undefined
}

/** dest 里**文件名段**的时间占位符（目录段里的不影响命名校验）。 */
function fileNameTimePlaceholder(dest: string): { kind: TimeKind; format: string } | undefined {
  const segments = String(dest).split('/')
  const last = segments[segments.length - 1] ?? ''
  PLACEHOLDER.lastIndex = 0
  const m = PLACEHOLDER.exec(last)
  if (m === null) return undefined
  const kind = m[1] as TimeKind
  return { kind, format: m[2] ?? DEFAULT_TIME_FORMAT[kind] }
}

/** 把格式串转成正则：token 变定长数字，其余字符转义。 */
export function formatToRegex(format: string): string {
  let out = ''
  for (let i = 0; i < format.length;) {
    const four = format.slice(i, i + 4)
    if (TOKENS4[four] !== undefined) { out += '\\d{4}'; i += 4; continue }
    const two = format.slice(i, i + 2)
    if (TOKENS2[two] !== undefined) { out += '\\d{2}'; i += 2; continue }
    out += format[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    i += 1
  }
  return out
}

/**
 * 剥掉文件名开头的时间前缀，返回剩余部分（不含分隔符）。
 *
 * 剥不掉（前缀不符合 dest 声明的格式、或剥完为空）→ `undefined`，调用方按原 naming 判。
 * 分隔符接受 `-` `_` 或没有（`20251015-会议.md` / `20251015_会议.md` / `20251015会议.md`）。
 */
export function stripTimePrefix(stem: string, dest: string): string | undefined {
  const ph = fileNameTimePlaceholder(dest)
  if (ph === undefined) return undefined
  const re = new RegExp('^(?:' + formatToRegex(ph.format) + ')(?:[-_\\s]+)?(.+)$')
  const m = re.exec(String(stem))
  if (m === null) return undefined
  const rest = m[1].trim()
  return rest === '' ? undefined : rest
}
