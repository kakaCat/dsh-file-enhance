/**
 * 现实结构扫描——「当前目录情况」这一层判据的数据来源。
 *
 * 只读、有界：深度与条目数都设上限，防大目录把指引单炸掉。
 *
 * @module dsh-file-enhance/folder-path/scan
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DirEntry, Tree } from './types.js'

const IGNORE = new Set(['node_modules', '.git', '.DS_Store'])

export interface ScanOptions {
  /** 子目录条目上限（默认 40）。 */
  maxDirs?: number
  /** 每个子目录抽样文件数（默认 3）。 */
  samples?: number
}

/** 扫一个目录的「一览」：直接子目录（含文件数与抽样文件名）+ 直接子文件。 */
export function scanDir(rootAbs: string, options: ScanOptions = {}): Tree {
  const maxDirs = options.maxDirs ?? 40
  const samples = options.samples ?? 3
  if (!existsSync(rootAbs)) return { exists: false, empty: true, dirs: [], files: [] }
  let entries
  try {
    entries = readdirSync(rootAbs, { withFileTypes: true })
  } catch {
    return { exists: false, empty: true, dirs: [], files: [] }
  }
  const dirs: DirEntry[] = []
  const files: string[] = []
  for (const e of entries) {
    if (IGNORE.has(e.name) || e.name.startsWith('.')) continue
    if (e.isDirectory()) {
      if (dirs.length >= maxDirs) continue
      const abs = join(rootAbs, e.name)
      let children: string[] = []
      let subdirs: string[] = []
      try {
        const kids = readdirSync(abs, { withFileTypes: true })
        children = kids.filter((c) => c.isFile() && !c.name.startsWith('.')).map((c) => c.name)
        subdirs = kids.filter((c) => c.isDirectory() && !c.name.startsWith('.')).map((c) => c.name)
      } catch { /* 读不到就当空目录 */ }
      dirs.push({
        name: e.name, abs, fileCount: children.length,
        samples: children.slice(0, samples), subdirs: subdirs.slice(0, 10),
      })
    } else if (e.isFile()) {
      files.push(e.name)
    }
  }
  return { exists: true, empty: dirs.length === 0 && files.length === 0, dirs, files }
}

/** 一次性给出「该类型主目录」的现实快照（判定链的 tree 入参）。 */
export function scanReality(rootAbs: string, options?: ScanOptions): Tree {
  const tree = scanDir(rootAbs, options)
  return { ...tree, names: tree.dirs.map((d) => d.name) }
}

/** 目录里的文件名（给 auto_number 用）。目录不存在 → 空数组。 */
export function listNames(dirAbs: string): string[] {
  if (!existsSync(dirAbs)) return []
  try {
    if (!statSync(dirAbs).isDirectory()) return []
    return readdirSync(dirAbs)
  } catch {
    return []
  }
}
