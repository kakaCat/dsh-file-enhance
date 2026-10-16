/**
 * 插件入口接线：自动纠偏的代写前内容校验必须复用完整 spec 策略。
 * @module dsh-file-enhance/tests/index
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.js'

type PreListener = (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>

const workspaces: string[] = []
afterEach(() => {
  while (workspaces.length > 0) rmSync(workspaces.pop()!, { recursive: true, force: true })
})

const REQUIRED_SECTION = [
  'rules:',
  '  - id: sections',
  '    assert: { fn: sectionsRequired, args: [{ headings: [背景] }] }',
].join('\n')

function harness(specYaml: string) {
  const ws = mkdtempSync(join(tmpdir(), 'file-enhance-index-'))
  workspaces.push(ws)
  mkdirSync(join(ws, '.dsh/folder-path-rules'), { recursive: true })
  writeFileSync(join(ws, '.dsh/folder-path-rules/md.yaml'), [
    'root: docs',
    'categories:',
    '  guides:',
    '    folder: guides',
    '    keywords: [guide]',
    '    dest: "guides/{slug}.md"',
  ].join('\n'), 'utf8')
  mkdirSync(join(ws, '.dsh/file-format-specs/x'), { recursive: true })
  writeFileSync(join(ws, '.dsh/file-format-specs/x/spec.yaml'), 'match: ["*.md"]\n' + specYaml, 'utf8')

  const listeners = new Map<string, unknown>()
  const ctx = {
    logger: () => ({}),
    inject: (services: string[], cb: (value: Record<string, unknown>) => void) => {
      if (services[0] === 'tools') {
        cb({ on: (event: string, listener: unknown) => { listeners.set(event, listener) } })
      } else {
        cb({})
      }
    },
  }
  apply(ctx as unknown as Context, { autoCorrect: true })
  const listener = listeners.get('tools/pre-execute') as PreListener

  const call = async (content = '# 缺章节\n'): Promise<PreToolDecision> => {
    const exec = {
      name: 'write',
      arguments: { file_path: 'docs/setup-guide.md', content },
      agent: { id: 'a1', session: { header: { cwd: ws } } },
    } as unknown as ToolExecution
    return listener(exec, async () => ({ kind: 'allow' }))
  }
  return { ws, call }
}

describe('自动纠偏代写前内容策略', () => {
  it('enforce_on=[update] 不错误阻断新建', async () => {
    const { ws, call } = harness('enforce_on: [update]\n' + REQUIRED_SECTION)
    const decision = await call()
    expect(decision.kind).toBe('deny') // 原 write 被纠偏回执替代
    expect(existsSync(join(ws, 'docs/guides/setup-guide.md'))).toBe(true)
  })

  it('max_attempts 用尽后按 on_exhausted=allow 代写并附提醒', async () => {
    const { ws, call } = harness('max_attempts: 1\non_exhausted: allow\n' + REQUIRED_SECTION)
    const first = await call()
    expect(first.kind).toBe('deny')
    expect(existsSync(join(ws, 'docs/guides/setup-guide.md'))).toBe(false)

    const second = await call()
    expect(second.kind).toBe('deny')
    expect((second as { reason: string }).reason).toContain('on_exhausted=allow')
    expect(readFileSync(join(ws, 'docs/guides/setup-guide.md'), 'utf8')).toBe('# 缺章节\n')
  })

  it('mode=warn 时代写仍执行，并随纠偏回执返回提醒', async () => {
    const { ws, call } = harness('mode: warn\n' + REQUIRED_SECTION)
    const decision = await call()
    expect(decision.kind).toBe('deny')
    expect((decision as { reason: string }).reason).toContain('mode=warn')
    expect(existsSync(join(ws, 'docs/guides/setup-guide.md'))).toBe(true)
  })
})
