/**
 * 路径与命名工具——纯函数，零 I/O（判定链的底层词汇）。
 * @module dsh-file-guide/paths
 */
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'

/** 根目录白名单的内置默认（生态约定文件；yaml 的 root_allow 在其上追加）。 */
export const BUILTIN_ROOT_ALLOW: readonly string[] = [
  'README.md', 'CHANGELOG.md', 'CLAUDE.md', 'AGENTS.md', 'AGENT.md',
  'CONTRIBUTING.md', 'LICENSE.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
]

/** 扩展名键：`docs/a.md` → `md`；无扩展名 → 空串。 */
export function extKeyOf(p: string): string {
  const e = extname(p)
  return e === '' ? '' : e.slice(1).toLowerCase()
}

/** target 是否在 root 之内（不含 root 自身）。 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** target 是否**直接**落在 root 下（即根目录的新建，如 `<ws>/notes.md`）。 */
export function isRootLevel(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && dirname(rel) === '.'
}

/** root 相对路径的分段（`docs/a/b.md` → ['a','b.md']）；不在 root 内 → 空数组。 */
export function partsUnder(root: string, target: string): string[] {
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return []
  return rel.split(/[/\\]+/).filter((s) => s !== '')
}

/** 文件名去扩展名。 */
export function stemOf(p: string): string {
  const base = p.split(/[/\\]+/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i <= 0 ? base : base.slice(0, i)
}

/** 主题词 → kebab-case（判定链与工具共用的一种命名规范化）。 */
export function slugify(s: unknown): string {
  return String(s ?? '')
    .trim()
    .replace(/[_\s]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PASCAL = /^[A-Z][A-Za-z0-9]*$/
const CAMEL = /^[a-z][A-Za-z0-9]*$/
const SNAKE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

/** 按命名风格校验（未知风格 → kebab-case）。 */
export function matchesNaming(style: string | undefined, stem: string): boolean {
  switch (style ?? 'kebab-case') {
    case 'kebab-case': return KEBAB.test(stem)
    case 'PascalCase': return PASCAL.test(stem)
    case 'camelCase': return CAMEL.test(stem)
    case 'snake_case': return SNAKE.test(stem)
    case 'any': return stem.length > 0
    default: return KEBAB.test(stem)
  }
}

/** 绝对化（相对 workspaceRoot 解析）。 */
export function toAbs(workspaceRoot: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(workspaceRoot, p)
}
