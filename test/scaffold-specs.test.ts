/**
 * 文档规范冷启动垫片测试——FormatStore.scaffoldDefaults 的触发面收窄 + 内置默认与 examples/ 逐字节一致。
 * @module dsh-file-enhance/tests/scaffold-specs
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_SPECS } from '../src/content-format/builtin-specs.js'
import { FormatStore, FORMAT_DIR_REL, SPEC_FILE, TEMPLATE_FILE, EXAMPLE_FILE } from '../src/content-format/spec.js'

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'file-specs-'))
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

const SPECS_DIR = () => join(ws, FORMAT_DIR_REL)

describe('内置默认规范（builtin-specs）与 examples/ 逐字节一致', () => {
  const examplesDir = new URL('../examples/file-format-specs', import.meta.url).pathname

  it('类型集合一致', () => {
    const onDisk = readdirSync(examplesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort()
    expect(Object.keys(BUILTIN_SPECS).sort()).toEqual(onDisk)
  })

  it('每个类型的 spec/template/example 逐字节一致', () => {
    for (const [name, builtin] of Object.entries(BUILTIN_SPECS)) {
      const dir = join(examplesDir, name)
      expect(readFileSync(join(dir, SPEC_FILE), 'utf8'), name + '/' + SPEC_FILE).toBe(builtin.spec)
      if (builtin.template !== undefined) {
        expect(readFileSync(join(dir, TEMPLATE_FILE), 'utf8'), name + '/' + TEMPLATE_FILE).toBe(builtin.template)
      } else {
        expect(existsSync(join(dir, TEMPLATE_FILE)), name + ' 不应有模板').toBe(false)
      }
      if (builtin.example !== undefined) {
        expect(readFileSync(join(dir, EXAMPLE_FILE), 'utf8'), name + '/' + EXAMPLE_FILE).toBe(builtin.example)
      } else {
        expect(existsSync(join(dir, EXAMPLE_FILE)), name + ' 不应有示例').toBe(false)
      }
    }
  })
})

describe('冷启动垫片：scaffoldDefaults', () => {
  it('无规范目录 → 落全部内置类型，且 all() 立即可加载', () => {
    const store = new FormatStore({ workspaceRoot: ws })
    const r = store.scaffoldDefaults(ws)
    expect(r.created).toBe(true)
    expect(r.types.sort()).toEqual(Object.keys(BUILTIN_SPECS).sort())
    for (const name of Object.keys(BUILTIN_SPECS)) {
      expect(existsSync(join(SPECS_DIR(), name, SPEC_FILE))).toBe(true)
    }
    const specs = store.all(ws)
    expect(specs.length).toBe(Object.keys(BUILTIN_SPECS).length)
  })

  it('已落垫片后用户改文件 → 再次 scaffold 不覆盖', () => {
    const store = new FormatStore({ workspaceRoot: ws })
    store.scaffoldDefaults(ws)
    const specPath = join(SPECS_DIR(), 'prd', SPEC_FILE)
    writeFileSync(specPath, 'match: ["custom.md"]\nrules: []\n', 'utf8')
    const r = store.scaffoldDefaults(ws)
    expect(r.created).toBe(false)
    expect(readFileSync(specPath, 'utf8')).toContain('custom.md')
  })

  it('已有用户规范（哪怕一个类型）→ 不落（不复活被删类型）', () => {
    mkdirSync(join(SPECS_DIR(), 'custom'), { recursive: true })
    writeFileSync(join(SPECS_DIR(), 'custom', SPEC_FILE), 'match: ["x.md"]\nrules: []\n', 'utf8')
    const store = new FormatStore({ workspaceRoot: ws })
    const r = store.scaffoldDefaults(ws)
    expect(r.created).toBe(false)
    expect(existsSync(join(SPECS_DIR(), 'prd'))).toBe(false)
  })

  it('scaffold:false → all() 不落盘，照常返回空', () => {
    const store = new FormatStore({ workspaceRoot: ws, scaffold: false })
    expect(store.all(ws)).toEqual([])
    expect(existsSync(SPECS_DIR())).toBe(false)
  })

  it('默认开启时 all() 懒垫片：第一次调用落盘，第二次不再重写', () => {
    const store = new FormatStore({ workspaceRoot: ws })
    expect(store.all(ws).length).toBeGreaterThan(0)
    const specPath = join(SPECS_DIR(), 'prd', SPEC_FILE)
    writeFileSync(specPath, readFileSync(specPath, 'utf8') + '\n# user edit\n', 'utf8')
    store.all(ws) // 同一 store 同一根：不重复垫片
    expect(readFileSync(specPath, 'utf8')).toContain('# user edit')
  })
})
