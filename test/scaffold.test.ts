/**
 * 冷启动垫片测试——scaffoldDefault 的触发面收窄逻辑 + 拦截器接线。
 * @module dsh-file-enhance/tests/scaffold
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { RulesStore, DEFAULT_MD_RULES_YAML, normalizeRules } from '../src/folder-path/rules.js'
import { installInterceptor } from '../src/folder-path/intercept.js'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'file-scaffold-'))
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

const RULES_PATH = () => join(ws, '.dsh/folder-path-rules/md.yaml')

describe('冷启动垫片：scaffoldDefault', () => {
  it('无规则目录 → 落默认 md.yaml，内容可被加载器解析', () => {
    const store = new RulesStore({ workspaceRoot: ws })
    const r = store.scaffoldDefault('md', ws)
    expect(r.created).toBe(true)
    expect(r.path).toBe(RULES_PATH())
    expect(existsSync(RULES_PATH())).toBe(true)
    const loaded = store.load('md', ws)
    expect(loaded !== undefined && 'rules' in loaded).toBe(true)
  })

  it('规则目录存在但为空 → 也落', () => {
    mkdirSync(join(ws, '.dsh/folder-path-rules'), { recursive: true })
    const store = new RulesStore({ workspaceRoot: ws })
    expect(store.scaffoldDefault('md', ws).created).toBe(true)
  })

  it('已有其他类型规则 → 不落（不复活被用户删掉的 md.yaml）', () => {
    mkdirSync(join(ws, '.dsh/folder-path-rules'), { recursive: true })
    writeFileSync(join(ws, '.dsh/folder-path-rules/txt.yaml'), 'type: txt\nroot: docs\ncategories: {}\n', 'utf8')
    const store = new RulesStore({ workspaceRoot: ws })
    expect(store.scaffoldDefault('md', ws).created).toBe(false)
    expect(existsSync(RULES_PATH())).toBe(false)
  })

  it('已有 md.yaml → 不覆盖用户内容', () => {
    mkdirSync(join(ws, '.dsh/folder-path-rules'), { recursive: true })
    writeFileSync(RULES_PATH(), 'type: md\nroot: notes\ncategories: {}\n', 'utf8')
    const store = new RulesStore({ workspaceRoot: ws })
    expect(store.scaffoldDefault('md', ws).created).toBe(false)
    expect(readFileSync(RULES_PATH(), 'utf8')).toContain('root: notes')
  })

  it('非 md 类型 → 不落（暂无内置默认）', () => {
    const store = new RulesStore({ workspaceRoot: ws })
    expect(store.scaffoldDefault('ts', ws).created).toBe(false)
    expect(existsSync(join(ws, '.dsh/folder-path-rules/ts.yaml'))).toBe(false)
  })

  it('落盘内容与 examples/md.yaml 逐字节一致', () => {
    const store = new RulesStore({ workspaceRoot: ws })
    store.scaffoldDefault('md', ws)
    const example = readFileSync(new URL('../examples/md.yaml', import.meta.url), 'utf8')
    expect(readFileSync(RULES_PATH(), 'utf8')).toBe(example)
  })

  it('默认规则本身能被 normalizeRules 接受', () => {
    const rules = normalizeRules(yaml.load(DEFAULT_MD_RULES_YAML), 'md')
    expect(rules.root).toBe('docs')
    expect(Object.keys(rules.categories)).toContain('adr')
  })
})

describe('加载优先级：工作区文件 > 内置默认', () => {
  it('无工作区规则 → load 回落内置默认（builtin 标记 + 五分类）', () => {
    const store = new RulesStore({ workspaceRoot: ws })
    const loaded = store.load('md', ws)
    expect(loaded !== undefined && 'rules' in loaded).toBe(true)
    expect((loaded as { builtin?: boolean }).builtin).toBe(true)
    expect(Object.keys((loaded as { rules: { categories: Record<string, unknown> } }).rules.categories)).toContain('adr')
  })

  it('工作区有文件 → 文件优先，builtin 不标记', () => {
    mkdirSync(join(ws, '.dsh/folder-path-rules'), { recursive: true })
    writeFileSync(join(ws, '.dsh/folder-path-rules/md.yaml'), 'type: md\nroot: notes\ncategories: {}\n', 'utf8')
    const store = new RulesStore({ workspaceRoot: ws })
    const loaded = store.load('md', ws)
    expect(loaded !== undefined && 'rules' in loaded).toBe(true)
    expect((loaded as { builtin?: boolean }).builtin).toBeUndefined()
    expect((loaded as { rules: { root: string } }).rules.root).toBe('notes')
  })

  it('fallback:false → 无文件时回到 undefined（旧行为）', () => {
    const store = new RulesStore({ workspaceRoot: ws, fallback: false })
    expect(store.load('md', ws)).toBeUndefined()
  })

  it('非 md 类型无内置默认 → undefined', () => {
    const store = new RulesStore({ workspaceRoot: ws })
    expect(store.load('ts', ws)).toBeUndefined()
  })
})

describe('冷启动垫片：拦截器接线', () => {
  function harness(options: { scaffold?: (root: string, extKey: string) => void; fallback?: boolean } = {}) {
    const store = new RulesStore({ workspaceRoot: ws, fallback: options.fallback })
    let listener: ((exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
    // 与 index.ts 的接线一致：scaffold 端口 = 间谍回调 + 真实落盘（store.scaffoldDefault）
    installInterceptor(store, (l) => { listener = l }, {
      scaffold: (root, ext) => {
        options.scaffold?.(root, ext)
        store.scaffoldDefault(ext, root)
      },
    })
    const call = async (filePath: string) => {
      let nextCalled = false
      const exec = { name: 'write', arguments: { file_path: filePath, content: '# hi\n' }, callId: 'c1', agent: { id: 'a1' } } as unknown as ToolExecution
      const decision = await listener!(exec, async () => { nextCalled = true; return { kind: 'allow' } })
      return { decision, nextCalled }
    }
    return { call }
  }

  it('无工作区规则 → 回落内置默认**继续判定**（根目录硬拦）+ 触发垫片落盘', async () => {
    const seen: string[] = []
    const { call } = harness({ scaffold: (root, ext) => { seen.push(`${root}|${ext}`) } })
    const { decision, nextCalled } = await call('notes.md')
    expect(nextCalled).toBe(false)
    expect(decision.kind).toBe('deny')
    expect(seen).toEqual([`${ws}|md`])
    expect(existsSync(RULES_PATH())).toBe(true) // 垫片已落盘，下一次走文件
  })

  it('第二次尝试 → 走已落盘的文件规则（与回落来源无关，根目录禁令永不豁免）', async () => {
    const { call } = harness()
    await call('notes.md') // 第一次：回落内置默认，硬拦
    const { decision } = await call('notes.md')
    expect(decision.kind).toBe('deny')
  })

  it('docs/ 下未分类 → 按内置默认纠偏（guides 关键词命中），同时落盘', async () => {
    const { call } = harness()
    const { decision } = await call('docs/login-guide.md')
    expect(decision.kind).toBe('deny') // 自动纠偏：代写后打回回执
    expect(existsSync(join(ws, 'docs/guides/login-guide.md'))).toBe(true)
    expect(existsSync(RULES_PATH())).toBe(true)
  })

  it('fallback:false + 无规则 → 静默放行（旧行为），scaffold 端口仍被调用并落盘', async () => {
    const seen: string[] = []
    const { call } = harness({ scaffold: (root, ext) => { seen.push(ext) }, fallback: false })
    const { decision, nextCalled } = await call('notes.md')
    expect(nextCalled).toBe(true)
    expect(decision).toEqual({ kind: 'allow' })
    expect(seen).toEqual(['md'])
    expect(existsSync(RULES_PATH())).toBe(true)
  })

  it('有规则时不调用 scaffold，走正常判定', async () => {
    mkdirSync(join(ws, '.dsh/folder-path-rules'), { recursive: true })
    writeFileSync(RULES_PATH(), 'type: md\nroot: docs\ncategories: {}\n', 'utf8')
    const seen: string[] = []
    const { call } = harness({ scaffold: (root, ext) => { seen.push(ext) } })
    await call('notes.md')
    expect(seen).toEqual([])
  })
})
