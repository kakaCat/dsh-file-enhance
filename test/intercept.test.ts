/**
 * 拦截器接线测试——用真实临时工作区跑「放行 / 自动纠偏 / 打回」三条路径，
 * 外加守护测试：随包示例规则必须能被加载器正常解析。
 * @module dsh-file-guide/tests/intercept
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { installInterceptor } from '../src/intercept.js'
import { RulesStore, normalizeRules } from '../src/rules.js'
import { EXAMPLE_MD_RULES } from '../src/tools.js'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

const EXAMPLE = readFileSync(new URL('../examples/md.yaml', import.meta.url), 'utf8')

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'file-guide-'))
  mkdirSync(join(ws, '.dsh/file-rules'), { recursive: true })
  writeFileSync(join(ws, '.dsh/file-rules/md.yaml'), EXAMPLE, 'utf8')
  mkdirSync(join(ws, 'docs/guides'), { recursive: true })
  writeFileSync(join(ws, 'docs/guides/existing.md'), '# existing\n', 'utf8')
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

function harness(options: { autoCorrect?: boolean } = {}) {
  const store = new RulesStore({ workspaceRoot: ws })
  let listener: ((exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
  installInterceptor(store, (l) => { listener = l }, options)
  const call = async (filePath: string, content = '# hi\n'): Promise<{ decision: PreToolDecision; nextCalled: boolean }> => {
    let nextCalled = false
    const exec = { name: 'write', arguments: { file_path: filePath, content }, callId: 'c1', agent: { id: 'a1' } } as unknown as ToolExecution
    const decision = await listener!(exec, async () => { nextCalled = true; return { kind: 'allow' } })
    return { decision, nextCalled }
  }
  return { call }
}

describe('拦截器', () => {
  it('未配置该类型规则时完全不介入', async () => {
    const store = new RulesStore({ workspaceRoot: ws })
    let listener: ((e: ToolExecution, n: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
    installInterceptor(store, (l) => { listener = l })
    const exec = { name: 'write', arguments: { file_path: 'a.ts' }, callId: 'c', agent: { id: 'a' } } as unknown as ToolExecution
    let nextCalled = false
    const d = await listener!(exec, async () => { nextCalled = true; return { kind: 'allow' } })
    expect(nextCalled).toBe(true)
    expect(d).toEqual({ kind: 'allow' })
  })

  it('根目录非白名单 → 打回并附指引单', async () => {
    const { call } = harness()
    const { decision, nextCalled } = await call('notes.md')
    expect(nextCalled).toBe(false)
    expect(decision.kind).toBe('deny')
    const reason = (decision as { reason: string }).reason
    expect(reason).toContain('根目录不允许新建')
    expect(reason).toContain('【可用分类】')
  })

  it('白名单文件（README.md）→ 放行', async () => {
    const { call } = harness()
    const { decision, nextCalled } = await call('README.md')
    expect(nextCalled).toBe(true)
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('合规路径 → 静默放行', async () => {
    const { call } = harness()
    const { decision, nextCalled } = await call('docs/guides/new-note.md')
    expect(nextCalled).toBe(true)
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('未分类文件 → 打回并给出【正确路径】，文件不落盘（方案 B，默认）', async () => {
    const { call } = harness()
    const { decision, nextCalled } = await call('docs/setup-guide.md', '# setup\n')
    expect(nextCalled).toBe(false)
    expect(decision.kind).toBe('deny')
    const reason = (decision as { reason: string }).reason
    expect(reason).toContain('【正确路径】docs/guides/setup-guide.md')
    expect(reason).toContain('【请重试】')
    expect(reason).toContain('现有目录习惯')
    // 方案 B：插件不代写，文件仍不存在（等 agent 用新路径重试）
    expect(existsSync(join(ws, 'docs/guides/setup-guide.md'))).toBe(false)
  })

  it('方案 A（autoCorrect）→ 插件代写到规范路径并回执落点', async () => {
    const { call } = harness({ autoCorrect: true })
    const { decision, nextCalled } = await call('docs/setup-guide.md', '# setup\n')
    expect(nextCalled).toBe(false)
    expect((decision as { reason: string }).reason).toContain('已按规范创建')
    expect(readFileSync(join(ws, 'docs/guides/setup-guide.md'), 'utf8')).toBe('# setup\n')
  })

  it('agent 用正确路径重试 → 放行', async () => {
    const { call } = harness()
    const first = await call('docs/setup-guide.md')
    expect(first.decision.kind).toBe('deny')
    const second = await call('docs/guides/setup-guide.md')
    expect(second.nextCalled).toBe(true)
    expect(second.decision).toEqual({ kind: 'allow' })
  })

  it('同一错误路径连续两次 → 第二次自由发挥放行', async () => {
    const { call } = harness()
    const first = await call('docs/mystery-note.md')
    expect(first.decision.kind).toBe('deny')
    const second = await call('docs/mystery-note.md')
    expect(second.nextCalled).toBe(true)
  })

  it('改旧文件不拦（目标已存在）', async () => {
    const { call } = harness()
    const { decision, nextCalled } = await call('docs/guides/existing.md', '# updated\n')
    expect(nextCalled).toBe(true)
    expect(decision).toEqual({ kind: 'allow' })
  })
})

describe('守护：随包示例规则可被加载器解析', () => {
  it('examples/md.yaml 解析通过且分类自洽', () => {
    const rules = normalizeRules(yaml.load(EXAMPLE), 'md')
    expect(rules.root).toBe('docs')
    const keys = Object.keys(rules.categories)
    expect(keys).toContain('guides')
    expect(keys).toContain('project')
    for (const cat of Object.values(rules.categories)) {
      if (cat.kind === 'simple') expect(cat.dest, `分类 ${cat.key} 缺 dest`).toBeTruthy()
      if (cat.kind === 'collection') {
        expect(Object.keys(cat.variants ?? {}).length).toBeGreaterThan(0)
        for (const v of Object.values(cat.variants ?? {})) expect(v.dest, `变体 ${v.key} 缺 dest`).toBeTruthy()
      }
    }
  })

  it('file_rules_init 内置文本与 examples/md.yaml 语义一致（同一份规则）', () => {
    const a = normalizeRules(yaml.load(EXAMPLE_MD_RULES), 'md')
    const b = normalizeRules(yaml.load(EXAMPLE), 'md')
    expect(JSON.stringify(Object.keys(a.categories).sort())).toBe(JSON.stringify(Object.keys(b.categories).sort()))
    expect(a.root).toBe(b.root)
  })
})
