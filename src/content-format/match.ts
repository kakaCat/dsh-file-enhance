/**
 * 文件匹配——**文件名**（basename）+ 可选相对路径，按有序匹配表 → spec。
 *
 * 主口径是文件名：requirement.md / prd-*.md 这类「这是哪种文档」的判据天然长在文件名上。
 * 需要「某目录下的所有 md」时，用可选的 match_path 加一层路径约束。
 * 借鉴 pm 插件 ArtifactSpec.ts 的 kindForRelPath：有序表、首个命中即定。
 * @module dsh-file-enhance/content-format/match
 */
import type { FormatSpec } from './types.js'

/** glob → 正则。支持 **（跨目录）、*（段内）、?；锚定整串。 */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else { re += '.*' }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$', 'iu')
}

/**
 * 一条模式是否命中文本。
 *
 * - 含 glob 元字符（* ?）→ 当 glob 用（大小写不敏感）
 * - 否则 → 当**关键词**，文本包含即命中（大小写不敏感；中文天然可用）
 *
 * 于是 `prd` 能同时命中 prd.md / prd-需求.md / prd需求.md / 需求-prd.md，
 * `需求文档` 能命中中文文件名。刻意宽容：文件名是给人看的，分隔符不该成为门槛。
 */
export function patternMatches(pattern: string, text: string): boolean {
  const p = pattern.trim()
  if (p === '') return false
  if (/[*?]/.test(p)) return globToRegExp(p).test(text)
  return text.toLowerCase().includes(p.toLowerCase())
}

/**
 * 按 priority 降序（同级按 name 稳定）逐个试，首个命中即返回。
 *
 * 命中条件：match（文件名）与 matchPath（相对路径）里给出的那些全部满足；
 * 两者同时为空视为配置错误，已在加载时拒绝，这里再兜底跳过（绝不匹配一切）。
 */
export function matchSpec(
  specs: readonly FormatSpec[],
  relPath: string,
  fileName: string,
  ext: string,
): FormatSpec | undefined {
  const ordered = [...specs].sort((a, b) => (b.priority - a.priority) || a.name.localeCompare(b.name))
  for (const spec of ordered) {
    if (spec.mode === 'off') continue
    if (spec.ext !== undefined && spec.ext !== ext) continue
    const nameOk = spec.match.length === 0 ? undefined : spec.match.some((p) => patternMatches(p, fileName))
    const pathOk = spec.matchPath.length === 0 ? undefined : spec.matchPath.some((p) => patternMatches(p, relPath))
    if (nameOk === undefined && pathOk === undefined) continue
    if ((nameOk ?? true) && (pathOk ?? true)) return spec
  }
  return undefined
}
