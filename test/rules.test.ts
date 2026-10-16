/**
 * 规则引擎：条件树 / 量词 / fn / derive 前向链 / 用户函数 / 内置原语。
 * @module dsh-file-enhance/tests/rules
 */
import { describe, expect, it } from 'vitest'
import { normalizeSpec } from '../src/content-format/spec.js'
import { validateDocument } from '../src/content-format/validate.js'
import type { FormatReport } from '../src/content-format/types.js'

const spec = (doc: Record<string, unknown>) => normalizeSpec(doc, '/ws/.dsh/file-format-specs/x.yaml')
const run = (doc: Record<string, unknown>, text: string): FormatReport => validateDocument(spec(doc), text, null)

describe('规则引擎：条件树', () => {
  it('path 叶子报具体 message', () => {
    const r = run({ name: 'x', match: ['x.md'], rules: [{ id: 'need-status', assert: { path: 'frontmatter.status', op: 'notEmpty', message: '缺 status' } }] }, '# t\n')
    expect(r.errors.map((v) => v.message)).toContain('缺 status')
  })
  it('each + where：每个 H2 必须 serves', () => {
    const doc = { name: 'x', match: ['x.md'], rules: [{ id: 'serves', assert: { each: 'headings', where: { path: 'level', op: 'gte', value: 2 }, require: { path: 'text', op: 'matches', value: 'serves\\s*[:：]', message: 'H2 缺 serves' } } }] }
    const r = run(doc, '# t\n\n## 架构\n\n## 数据 serves: FR-1\n')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].message).toBe('H2 缺 serves')
    expect(r.errors[0].line).toBe(3)
  })
  it('not / any 组合', () => {
    const r = run({ name: 'x', match: ['x.md'], rules: [{ id: 'no-done', assert: { not: { path: 'frontmatter.status', op: 'eq', value: 'done' }, message: '不允许 done' } }] }, '---\nstatus: done\n---\n')
    expect(r.errors[0].message).toBe('不允许 done')
  })
  it('count 量词', () => {
    const r = run({ name: 'x', match: ['x.md'], rules: [{ id: 'cnt', assert: { count: 'headings', where: { path: 'level', op: 'eq', value: 2 }, op: 'gte', value: 2, message: '至少两个 H2' } }] }, '## a\n')
    expect(r.errors[0].message).toBe('至少两个 H2')
  })
  it('fn 调内置函数 hasSection', () => {
    const r = run({ name: 'x', match: ['x.md'], rules: [{ id: 'bg', assert: { fn: 'hasSection', args: ['背景'], message: '缺背景' } }] }, '# t\n')
    expect(r.errors[0].message).toBe('缺背景')
  })
})

describe('规则引擎：前向链与自定义函数', () => {
  it('derive + 用户 expr 函数', () => {
    const doc = {
      name: 'x', match: ['x.md'],
      functions: { frCount: { expr: "api.collectIds(text, ['FR']).length" } },
      derive: [{ fact: 'frCount', fn: 'frCount' }],
      rules: [{ id: 'at-least-2', assert: { path: 'frCount', op: 'gte', value: 2, message: '至少两条 FR' } }],
    }
    const r = run(doc, '**FR-1: a**\n')
    expect(r.errors[0].message).toBe('至少两条 FR')
    const valid = run(doc, '**FR-1: a**\n**FR-2: b**\n')
    expect(valid.errors).toHaveLength(0)
  })
  it('derive 动态代码抛错 → 记录违规且不向外抛异常', () => {
    const r = run({
      name: 'x', match: ['x.md'],
      derive: [{ fact: 'broken', expr: 'notDefined.x' }],
      rules: [],
    }, '# t\n')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].message).toContain('派生事实 broken 执行失败')
  })
  it('derive 用内置 countIds + 用户 script 函数', () => {
    const doc = {
      name: 'x', match: ['x.md'],
      functions: { wordCount: { script: 'return text.split(/\\s+/).filter(Boolean).length' } },
      derive: [{ fact: 'wc', fn: 'wordCount' }, { fact: 'ids', fn: 'countIds', args: [['FR']] }],
      rules: [
        { id: 'short', severity: 'warning', assert: { path: 'wc', op: 'gte', value: 999, message: '字数偏少' } },
        { id: 'has-id', assert: { path: 'ids', op: 'gte', value: 1, message: '缺编号' } },
      ],
    }
    const r = run(doc, '**FR-1: a**\n')
    expect(r.warnings.map((v) => v.message)).toContain('字数偏少')
    expect(r.errors).toHaveLength(0)
  })
})

describe('规则引擎：内置原语与 when 守卫', () => {
  it('规则里调用内置原语 frontmatterRequired', () => {
    const r = run({ name: 'x', match: ['x.md'], rules: [{ id: 'title', assert: { fn: 'frontmatterRequired', args: [{ keys: ['title'] }] } }] }, '---\nstatus: x\n---\n')
    expect(r.errors.map((v) => v.message).join()).toContain('title')
  })
  it('when 为假则跳过规则', () => {
    const doc = { name: 'x', match: ['x.md'], rules: [{ id: 'gated', when: { path: 'frontmatter.category', op: 'eq', value: 'feature' }, assert: { path: 'frontmatter.owner', op: 'exists', message: '缺 owner' } }] }
    expect(run(doc, '---\ncategory: doc\n---\n').errors).toHaveLength(0)
    expect(run(doc, '---\ncategory: feature\n---\n').errors).toHaveLength(1)
  })
})
