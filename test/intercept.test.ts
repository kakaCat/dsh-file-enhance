/**
 * 拦截器接线测试——用真实临时工作区跑「放行 / 自动纠偏 / 打回」三条路径，
 * 外加守护测试：随包示例规则必须能被加载器正常解析。
 * @module dsh-file-enhance/tests/intercept
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { installInterceptor } from '../src/folder-path/intercept.js'
import { RulesStore, normalizeRules } from '../src/folder-path/rules.js'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

const EXAMPLE = readFileSync(new URL('../examples/md.yaml', import.meta.url), 'utf8')

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'file-guide-'))
  mkdirSync(join(ws, '.dsh/folder-path-rules'), { recursive: true })
  writeFileSync(join(ws, '.dsh/folder-path-rules/md.yaml'), EXAMPLE, 'utf8')
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

  it('指引单不再引用已删除的插件工具（工具面归零后只指原生 write / ask_user_question / yaml）', async () => {
    const { call } = harness()
    for (const target of ['notes.md', 'docs/未分类文档.md', 'docs/not_a_category/x.md']) {
      const { decision } = await call(target)
      if (decision.kind !== 'deny') continue
      const reason = (decision as { reason: string }).reason
      for (const gone of ['file_resolve', 'file_propose', 'file_check', 'file_rules_init']) {
        expect(reason, `${target} 的指引单不该再提 ${gone}`).not.toContain(gone)
      }
      expect(reason).toContain('write')
    }
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

  it('未分类文件 → 自动纠偏：内容按规范路径落盘，原调用打回并告知（方案 A，默认）', async () => {
    const { call } = harness()
    // 现实目录里已有 docs/guides/ → 按现实惯例归位
    const { decision, nextCalled } = await call('docs/setup-guide.md', '# setup\n')
    expect(nextCalled).toBe(false)
    expect(decision.kind).toBe('deny')
    const reason = (decision as { reason: string }).reason
    expect(reason).toContain('本次 write 未执行')
    expect(reason).toContain('已按项目规范写入：docs/guides/setup-guide.md')
    expect(reason).toContain('不要再用原路径重试')
    expect(readFileSync(join(ws, 'docs/guides/setup-guide.md'), 'utf8')).toBe('# setup\n')
  })

  it('纠偏目标已存在 → 不覆盖原文件', async () => {
    const { call } = harness()
    writeFileSync(join(ws, 'docs/guides/setup-guide.md'), '# original\n', 'utf8')
    const { decision, nextCalled } = await call('docs/setup-guide.md', '# replacement\n')
    expect(nextCalled).toBe(false)
    expect(decision.kind).toBe('deny')
    expect((decision as { reason: string }).reason).toContain('为避免覆盖')
    expect(readFileSync(join(ws, 'docs/guides/setup-guide.md'), 'utf8')).toBe('# original\n')
  })

  it('方案 B（autoCorrect: false）→ 只打回并给出【正确路径】，文件不落盘', async () => {
    const { call } = harness({ autoCorrect: false })
    const { decision, nextCalled } = await call('docs/setup-guide.md', '# setup\n')
    expect(nextCalled).toBe(false)
    expect(decision.kind).toBe('deny')
    const reason = (decision as { reason: string }).reason
    expect(reason).toContain('【正确路径】docs/guides/setup-guide.md')
    expect(reason).toContain('【请重试】')
    expect(reason).toContain('现有目录习惯')
    expect(existsSync(join(ws, 'docs/guides/setup-guide.md'))).toBe(false)
  })

  it('代写端口可注入（宿主 fs 服务的替身）', async () => {
    const written: Array<{ path: string; content: string }> = []
    const store = new RulesStore({ workspaceRoot: ws })
    let listener: ((e: ToolExecution, n: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
    installInterceptor(store, (l) => { listener = l }, {
      writeFile: (p, c) => { written.push({ path: p, content: c }) },
    })
    const exec = { name: 'write', arguments: { file_path: 'docs/setup-guide.md', content: '# x\n' }, callId: 'c', agent: { id: 'a' } } as unknown as ToolExecution
    await listener!(exec, async () => ({ kind: 'allow' }))
    expect(written).toHaveLength(1)
    expect(written[0]?.path).toBe(join(ws, 'docs/guides/setup-guide.md'))
    expect(written[0]?.content).toBe('# x\n')
  })

  it('agent 用正确路径重试 → 放行', async () => {
    const { call } = harness({ autoCorrect: false })
    const first = await call('docs/setup-guide.md')
    expect(first.decision.kind).toBe('deny')
    const second = await call('docs/guides/setup-guide.md')
    expect(second.nextCalled).toBe(true)
    expect(second.decision).toEqual({ kind: 'allow' })
  })

  it('同一错误路径连续两次（方案 B）→ 第二次自由发挥放行', async () => {
    const { call } = harness({ autoCorrect: false })
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

  it('resolveRoot 端口：store 默认根错位时按解析根判定并落盘（桌面宿主场景）', async () => {
    const wrong = mkdtempSync(join(tmpdir(), 'file-guide-wrong-'))
    try {
      // 模拟桌面宿主：store 构造时的 process.cwd() 是 profile 目录（错位根、无规则）。
      const store = new RulesStore({ workspaceRoot: wrong })
      let listener: ((e: ToolExecution, n: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
      installInterceptor(store, (l) => { listener = l }, {
        resolveRoot: async () => ws, // 按 agent 解析回真实会话工作区
        writeFile: (p, c) => { writeFileSync(p, c) },
        mkdirp: (p) => { mkdirSync(p, { recursive: true }) },
      })
      const exec = { name: 'write', arguments: { file_path: 'docs/login-guide.md', content: '# g\n' }, callId: 'c', agent: { id: 'a' } } as unknown as ToolExecution
      const d = await listener!(exec, async () => ({ kind: 'allow' }))
      expect(d.kind).toBe('deny')
      expect(existsSync(join(ws, 'docs/guides/login-guide.md'))).toBe(true)     // 落在解析根下
      expect(existsSync(join(wrong, 'docs/guides/login-guide.md'))).toBe(false) // 不落错位根
    } finally {
      rmSync(wrong, { recursive: true, force: true })
    }
  })

  it('RulesStore.load 支持按调用传 root，缓存按 root 隔离', () => {
    const wrong = mkdtempSync(join(tmpdir(), 'file-guide-wrong-'))
    try {
      // fallback:false：专测「文件按 root 隔离」这条旧语义（无文件即 undefined，不看内置默认）
      const store = new RulesStore({ workspaceRoot: wrong, fallback: false })
      expect(store.load('md')).toBeUndefined()                // 默认根（错位）无规则
      const loaded = store.load('md', ws)
      expect(loaded !== undefined && 'rules' in loaded ? loaded.rules.root : undefined).toBe('docs')
      expect(store.load('md')).toBeUndefined()                // 缓存不串根
      expect(store.types(ws)).toContain('md')
      expect(store.types()).toEqual([])
    } finally {
      rmSync(wrong, { recursive: true, force: true })
    }
  })

  it('代写前内容校验端口收到解析后的工作区根（root 为第一参）', async () => {
    const seen: Array<{ root: string; abs: string }> = []
    const store = new RulesStore({ workspaceRoot: ws })
    let listener: ((e: ToolExecution, n: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
    installInterceptor(store, (l) => { listener = l }, {
      resolveRoot: async () => ws,
      validateContent: (root, abs) => { seen.push({ root, abs }); return undefined },
      writeFile: (p, c) => { writeFileSync(p, c) },
      mkdirp: (p) => { mkdirSync(p, { recursive: true }) },
    })
    const exec = { name: 'write', arguments: { file_path: 'docs/login-guide.md', content: '# g\n' }, callId: 'c', agent: { id: 'a' } } as unknown as ToolExecution
    await listener!(exec, async () => ({ kind: 'allow' }))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.root).toBe(ws)
    expect(seen[0]?.abs).toBe(join(ws, 'docs/guides/login-guide.md'))
  })

  it('落点被并发占用（EEXIST）：拒写并说清是抢占，不报成「失败」', async () => {
    const store = new RulesStore({ workspaceRoot: ws })
    let listener: ((e: ToolExecution, n: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
    installInterceptor(store, (l) => { listener = l }, {
      writeFile: () => {
        const err = new Error('EEXIST: file already exists') as NodeJS.ErrnoException
        err.code = 'EEXIST'
        throw err
      },
    })
    const exec = { name: 'write', arguments: { file_path: 'docs/指南-并发.md', content: '# x\n' }, callId: 'c', agent: { id: 'a1' } } as unknown as ToolExecution
    const decision = await listener!(exec, async () => ({ kind: 'allow' }))

    expect(decision.kind).toBe('deny')
    const reason = (decision as { reason: string }).reason
    expect(reason).toContain('占用')
    expect(reason).not.toContain('失败')
  })

  it('两个 agent 同时写同一落点：一个成功一个被拒，文件内容不被撕裂', async () => {
    const store = new RulesStore({ workspaceRoot: ws })
    let listener: ((e: ToolExecution, n: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
    installInterceptor(store, (l) => { listener = l })   // 走默认 node:fs 回落（wx 语义）
    const call = (content: string, agentId: string): Promise<PreToolDecision> => {
      const exec = { name: 'write', arguments: { file_path: 'docs/指南-并发.md', content }, callId: 'c', agent: { id: agentId } } as unknown as ToolExecution
      return listener!(exec, async () => ({ kind: 'allow' }))
    }

    const decisions = await Promise.all([call('# A\n', 'agent-a'), call('# B\n', 'agent-b')])

    // 自动纠偏成功也会 deny（原调用被拒、文件已按规范落盘），所以按回执文案区分谁真的写下去了
    const reasons = decisions.map((d) => String((d as { reason?: string }).reason ?? ''))
    expect(reasons.filter((r) => r.includes('已按项目规范写入'))).toHaveLength(1)
    expect(reasons.filter((r) => /已存在|占用/.test(r))).toHaveLength(1)
    const written = readFileSync(join(ws, 'docs/guides/指南-并发.md'), 'utf8')
    expect(['# A\n', '# B\n']).toContain(written)   // 只可能是一整份，不会两半拼一起
  })

  it('拦截记忆按 denialTtlMs 过期：窗口内第二次放行，过期后重新计一次', async () => {
    const store = new RulesStore({ workspaceRoot: ws })
    let listener: ((e: ToolExecution, n: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
    installInterceptor(store, (l) => { listener = l }, { denialTtlMs: 25 })
    const call = async (filePath: string): Promise<PreToolDecision> => {
      const exec = { name: 'write', arguments: { file_path: filePath, content: '# hi\n' }, callId: 'c', agent: { id: 'a1' } } as unknown as ToolExecution
      return listener!(exec, async () => ({ kind: 'allow' }))
    }

    expect((await call('docs/未分类文档.md')).kind).toBe('deny')   // 首次：拦下并指路
    expect((await call('docs/未分类文档.md')).kind).toBe('allow')  // 窗口内第二次：自由发挥
    await new Promise((resolve) => setTimeout(resolve, 40))        // 让记忆过期
    expect((await call('docs/未分类文档.md')).kind).toBe('deny')   // 过期后重新计一次，且过期条目已被清理
  })

  it('代写失败：打回并附指引单，不抛异常也不留半个文件', async () => {
    const store = new RulesStore({ workspaceRoot: ws })
    let listener: ((e: ToolExecution, n: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
    installInterceptor(store, (l) => { listener = l }, {
      writeFile: () => { throw new Error('EACCES: permission denied') },
    })
    const exec = { name: 'write', arguments: { file_path: 'docs/指南-代写失败.md', content: '# x\n' }, callId: 'c', agent: { id: 'a1' } } as unknown as ToolExecution
    const decision = await listener!(exec, async () => ({ kind: 'allow' }))

    expect(decision.kind).toBe('deny')
    const reason = (decision as { reason: string }).reason
    expect(reason).toContain('自动纠偏失败')
    expect(reason).toContain('EACCES')
    expect(reason).toContain('【可用分类】')                       // 失败也把指引单给全
    expect(existsSync(join(ws, 'docs/guides/指南-代写失败.md'))).toBe(false)
  })

  it('规则 dest 越界：拒写，且不会把文件写到工作区外（路径穿越）', async () => {
    writeFileSync(join(ws, '.dsh/folder-path-rules/md.yaml'), [
      'type: md',
      'root: docs',
      'categories:',
      '  guides:',
      '    folder: guides',
      '    keywords: [指南]',
      '    dest: "../../l4-escape/{slug}.md"',
    ].join('\n'), 'utf8')
    const outside = join(ws, '..', 'l4-escape')
    rmSync(outside, { recursive: true, force: true })

    const { call } = harness()
    const { decision, nextCalled } = await call('docs/指南-越界.md')

    expect(nextCalled).toBe(false)
    expect(decision.kind).toBe('deny')
    expect((decision as { reason: string }).reason).toContain('越出工作区')
    expect(existsSync(outside)).toBe(false)
  })

  it('规则 root 越界：拒写并说清原因，不跟着规则扫工作区外', async () => {
    writeFileSync(join(ws, '.dsh/folder-path-rules/md.yaml'), [
      'type: md',
      'root: ../',
      'categories:',
      '  guides:',
      '    folder: guides',
      '    keywords: [指南]',
      '    dest: "guides/{slug}.md"',
    ].join('\n'), 'utf8')

    const { call } = harness()
    const { decision } = await call('docs/指南-root越界.md')

    expect(decision.kind).toBe('deny')
    expect((decision as { reason: string }).reason).toContain('主目录越出工作区')
  })

  it('instance.pattern 写坏：规则判非法并打回一次，不抛异常', async () => {
    writeFileSync(join(ws, '.dsh/folder-path-rules/md.yaml'), [
      'type: md',
      'root: docs',
      'categories:',
      '  project:',
      '    folder: projects',
      '    kind: collection',
      '    instance:',
      '      pattern: "^PRJ-[0-9"',        // 左括号没闭合
      '    variants:',
      '      plan:',
      '        keywords: [计划]',
      '        dest: "projects/{project_id}/plan/{slug}.md"',
    ].join('\n'), 'utf8')

    const { call } = harness()
    const { decision } = await call('docs/projects/PRJ-0001/plan/计划.md')

    expect(decision.kind).toBe('deny')
    expect((decision as { reason: string }).reason).toContain('instance.pattern')
  })

  it('判定链内部异常：降级放行，不阻断写文件', async () => {
    const warnings: string[] = []
    const broken = {
      workspaceRoot: ws,
      load: () => { throw new Error('boom: 加载器炸了') },
    } as unknown as RulesStore
    let listener: ((e: ToolExecution, n: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
    installInterceptor(broken, (l) => { listener = l }, { logger: { warn: (m) => warnings.push(m) } })

    const exec = { name: 'write', arguments: { file_path: 'docs/指南-异常.md', content: '# x\n' }, callId: 'c', agent: { id: 'a1' } } as unknown as ToolExecution
    const decision = await listener!(exec, async () => ({ kind: 'allow' }))

    expect(decision).toEqual({ kind: 'allow' })
    expect(warnings.some((w) => w.includes('内部异常'))).toBe(true)
  })

  it('拦截计数按 agent 隔离：A 的第二次放行不影响 B 的首次', async () => {
    const store = new RulesStore({ workspaceRoot: ws })
    let listener: ((e: ToolExecution, n: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
    installInterceptor(store, (l) => { listener = l })
    const call = async (agentId: string, filePath: string): Promise<PreToolDecision> => {
      const exec = { name: 'write', arguments: { file_path: filePath, content: '# hi\n' }, callId: 'c', agent: { id: agentId } } as unknown as ToolExecution
      return listener!(exec, async () => ({ kind: 'allow' }))
    }
    const target = 'docs/未分类文档.md'

    expect((await call('agent-a', target)).kind).toBe('deny')
    expect((await call('agent-a', target)).kind).toBe('allow')   // A 第二次：自由发挥
    expect((await call('agent-b', target)).kind).toBe('deny')    // B 仍是首次，不吃 A 的记忆
  })

  it('规则改完即生效：mtime 热重载，无需重启插件', async () => {
    const store = new RulesStore({ workspaceRoot: ws })
    let listener: ((e: ToolExecution, n: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
    installInterceptor(store, (l) => { listener = l })
    const call = async (filePath: string): Promise<PreToolDecision> => {
      const exec = { name: 'write', arguments: { file_path: filePath, content: '# hi\n' }, callId: 'c', agent: { id: 'a1' } } as unknown as ToolExecution
      return listener!(exec, async () => ({ kind: 'allow' }))
    }

    expect((await call('NOTES.md')).kind).toBe('deny')           // 根目录不在白名单

    const path = join(ws, '.dsh/folder-path-rules/md.yaml')
    writeFileSync(path, EXAMPLE.replace('root_allow: []', 'root_allow: [NOTES.md]'), 'utf8')
    const future = new Date(Date.now() + 5000)
    utimesSync(path, future, future)                              // 保证 mtime 变了（同一毫秒内写回不算热重载）

    expect((await call('NOTES.md')).kind).toBe('allow')           // 同一条记忆下，新规则立即生效
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

  it('示例规则只剩 examples/md.yaml 这一份权威（内置副本随 file_rules_init 一起删除）', () => {
    expect(normalizeRules(yaml.load(EXAMPLE), 'md').root).toBe('docs')
  })
})

describe('时间占位符：撞名不覆盖', () => {
  it('同一天同一主题的第二次创建：打回并说清原因，原文件不动', async () => {
    const rules = [
      'type: md',
      'root: docs',
      'categories:',
      '  daily:',
      '    folder: daily',
      '    keywords: [纪要]',
      '    dest: "daily/{date}-{slug}.md"',
    ].join('\n')
    writeFileSync(join(ws, '.dsh/folder-path-rules/md.yaml'), rules, 'utf8')
    mkdirSync(join(ws, 'docs/daily'), { recursive: true })
    const d = new Date()
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const existing = join(ws, `docs/daily/${stamp}-cache.md`)
    writeFileSync(existing, '# 原内容\n', 'utf8')

    const store = new RulesStore({ workspaceRoot: ws })
    let listener: ((e: ToolExecution, n: () => Promise<PreToolDecision>) => Promise<PreToolDecision>) | undefined
    installInterceptor(store, (l) => { listener = l })
    const exec = { name: 'write', arguments: { file_path: 'docs/daily/cache.md', content: '# 新内容\n' }, callId: 'c', agent: { id: 'a1' } } as unknown as ToolExecution
    const decision = await listener!(exec, async () => ({ kind: 'allow' }))

    expect(decision.kind).toBe('deny')
    expect((decision as { reason: string }).reason).toContain('同一天同一主题')
    expect(readFileSync(existing, 'utf8')).toBe('# 原内容\n')   // 绝不覆盖
  })
})
