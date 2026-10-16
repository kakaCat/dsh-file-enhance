/**
 * 文档守护：本仓库 docs/ 下的真实文稿必须符合它自己的规范集。
 *
 * 与 test/format.test.ts 的「示例规范守护」互补：那边守模板/示例，这边守**实际交付给用户的文稿**
 * ——规范写得再对，也不该出现"自己的方案稿过不了自己的 spec"。
 * @module dsh-file-enhance/tests/docs
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { matchSpec } from '../src/content-format/match.js'
import { readSpecDir } from '../src/content-format/spec.js'
import { validateDocument } from '../src/content-format/validate.js'

const specsDir = new URL('../examples/file-format-specs', import.meta.url).pathname
const specs = readSpecDir(specsDir)

/** 仓库内已交付的文稿（相对工作区根）。新增文稿时在此登记。 */
const DOCUMENTS = [
  'docs/research/研发设计调研报告-文档模板类插件分工与集成方案.md',
]

describe('文档守护：docs/ 下的真实文稿', () => {
  it('每份登记文稿都能被某个 spec 按文件名匹配命中（不是野文件）', () => {
    for (const rel of DOCUMENTS) {
      const abs = new URL('../' + rel, import.meta.url).pathname
      if (!existsSync(abs)) continue
      const hit = matchSpec(specs, rel, basename(rel), 'md')
      expect(hit?.name, rel + ' 未命中任何 spec').toBeTruthy()
    }
  })

  it('每份登记文稿符合它匹配到的 spec（零 error）', () => {
    for (const rel of DOCUMENTS) {
      const abs = new URL('../' + rel, import.meta.url).pathname
      if (!existsSync(abs)) continue
      const spec = matchSpec(specs, rel, basename(rel), 'md')
      if (spec === undefined) continue
      const text = readFileSync(abs, 'utf8')
      const template = spec.template !== undefined ? readFileSync(join(spec.dir, spec.template), 'utf8') : undefined
      const r = validateDocument(spec, text, null, template, { fileName: basename(rel), relPath: rel })
      expect(r.errors.map((e) => e.message), rel).toHaveLength(0)
    }
  })
})
