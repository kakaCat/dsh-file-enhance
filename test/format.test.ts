/**
 * 格式规范：匹配 / 解析 / 检查 / delta / post-execute 集成。
 * @module dsh-file-enhance/tests/format
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globToRegExp, matchSpec } from '../src/content-format/match.js'
import { parseDocument } from '../src/content-format/parse.js'
import { PRIMITIVES } from '../src/content-format/primitives.js'
import { validateDocument } from '../src/content-format/validate.js'
import { FormatStore, normalizeSpec, readSpecDir } from '../src/content-format/spec.js'
import { installPostCheck } from '../src/content-format/post-check.js'
import { buildSkeleton } from '../src/content-format/skeleton.js'
import { renderFormatGuidance } from '../src/content-format/report.js'
import type { FormatSpec, ParsedDoc } from '../src/content-format/types.js'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'

describe('匹配：glob → 正则', () => {
  it('** 跨目录、* 段内、? 单字符', () => {
    expect(globToRegExp('**/requirement.md').test('docs/requirements/PRJ-0001/requirement.md')).toBe(true)
    expect(globToRegExp('**/requirement.md').test('requirement.md')).toBe(true)
    expect(globToRegExp('docs/design/**/*.md').test('docs/design/a/b/c.md')).toBe(true)
    expect(globToRegExp('docs/design/*.md').test('docs/design/a/b.md')).toBe(false)
    expect(globToRegExp('**/prd-?.md').test('x/prd-1.md')).toBe(true)
  })
})

describe('匹配：优先级与首个命中', () => {
  const mk = (name: string, priority: number, match: string[], matchPath: string[] = []): FormatSpec =>
    ({ name, priority, match, matchPath, mode: 'block', enforceOn: ['create', 'update'], diffMode: 'delta', maxAttempts: 3, onExhausted: 'allow', rules: [], derive: [], functions: {}, path: '', dir: '' })
  it('priority 大者先；无命中返回 undefined', () => {
    const a = mk('generic', 0, ['**/*.md'])
    const b = mk('special', 10, ['**/special.md'])
    expect(matchSpec([a, b], 'x/special.md', 'special.md', 'md')?.name).toBe('special')
    expect(matchSpec([a], 'x/special.md', 'special.md', 'md')?.name).toBe('generic')
    expect(matchSpec([b], 'x/other.md', 'other.md', 'md')).toBeUndefined()
  })
  it('按文件名匹配，路径不同也命中', () => {
    const s = mk('prd', 0, ['prd.md'])
    expect(matchSpec([s], 'a/b/c/prd.md', 'prd.md', 'md')?.name).toBe('prd')
    expect(matchSpec([s], 'a/b/c/other.md', 'other.md', 'md')).toBeUndefined()
  })
  it('match_path 作为附加约束', () => {
    const s = mk('d', 0, [], ['**/design/**/*.md'])
    expect(matchSpec([s], 'x/design/a.md', 'a.md', 'md')?.name).toBe('d')
    expect(matchSpec([s], 'x/other/a.md', 'a.md', 'md')).toBeUndefined()
  })
  it('关键词匹配：无 glob 元字符时按包含，大小写不敏感，连字符可有可无', () => {
    const s = mk('prd', 0, ['prd'])
    expect(matchSpec([s], 'a/prd.md', 'prd.md', 'md')?.name).toBe('prd')
    expect(matchSpec([s], 'a/prd-需求.md', 'prd-需求.md', 'md')?.name).toBe('prd')
    expect(matchSpec([s], 'a/prd需求.md', 'prd需求.md', 'md')?.name).toBe('prd')
    expect(matchSpec([s], 'a/需求-prd.md', '需求-prd.md', 'md')?.name).toBe('prd')
    expect(matchSpec([s], 'a/PRD.md', 'PRD.md', 'md')?.name).toBe('prd')
    expect(matchSpec([s], 'a/product.md', 'product.md', 'md')).toBeUndefined()
  })
  it('中文关键词匹配', () => {
    const s = mk('req', 0, ['需求文档'])
    expect(matchSpec([s], 'a/需求文档.md', '需求文档.md', 'md')?.name).toBe('req')
    expect(matchSpec([s], 'a/需求文档-登录.md', '需求文档-登录.md', 'md')?.name).toBe('req')
    expect(matchSpec([s], 'a/产品需求.md', '产品需求.md', 'md')).toBeUndefined()
  })
  it('glob 模式大小写不敏感', () => {
    const s = mk('g', 0, ['PRD-*.md'])
    expect(matchSpec([s], 'a/prd-需求.md', 'prd-需求.md', 'md')?.name).toBe('g')
  })
})

describe('解析：跳过代码围栏', () => {
  it('围栏内的井号与竖线不算结构', () => {
    const lines = ['# 标题', '', '```', '## 假标题', '| a | b |', '| - | - |', '```', '', '## 真标题']
    const doc = parseDocument(lines.join('\n'))
    expect(doc.headings.map((h) => h.text)).toEqual(['标题', '真标题'])
    expect(doc.tables).toHaveLength(0)
  })
})

describe('内置原语', () => {
  const doc = (text: string): ParsedDoc => parseDocument(text)
  it('sectionsRequired 报缺失与顺序', () => {
    const v = PRIMITIVES.sectionsRequired(doc('## 目标\n## 背景\n'), { headings: ['背景', '目标', '验收'], order: true })
    const msgs = v.map((x) => x.message).join('\n')
    expect(msgs).toContain('缺章节「验收」')
    expect(msgs).toContain('章节顺序不符')
  })
  it('frontmatterRequired 报缺失', () => {
    const v = PRIMITIVES.frontmatterRequired(doc('---\ntitle: x\n---\n# a\n'), { keys: ['title', 'status'] })
    expect(v).toHaveLength(1)
    expect(v[0].message).toContain('status')
  })
  it('tableRequired 报缺列与行数不足', () => {
    const v = PRIMITIVES.tableRequired(doc('## 需求清单\n\n| 编号 | 需求 |\n|---|---|\n| R-1 | a |\n'), { under: '需求清单', header: ['编号', '优先级'], min_rows: 2 })
    const msgs = v.map((x) => x.message).join('\n')
    expect(msgs).toContain('缺列「优先级」')
    expect(msgs).toContain('数据行不足')
  })
  it('ids 报跳号与重复', () => {
    const v = PRIMITIVES.ids(doc('**FR-1: a**\n**FR-3: c**\n**FR-3: again**\n'), { prefixes: ['FR'], unique: true, sequence: true })
    const msgs = v.map((x) => x.message).join('\n')
    expect(msgs).toContain('缺 FR-2')
    expect(msgs).toContain('编号重复')
  })
  it('idDetails：核心必填、条件按需、条件写了不能空', () => {
    const head = '## 功能需求\n\n| 编号 | 需求 | 优先级 | 验收判据 |\n|---|---|---|---|\n| FR-1 | x | Must | y |\n\n'
    const params = { under: '功能需求', fields: ['描述', '验收标准'], optional: ['业务规则'] }
    const minimal = PRIMITIVES.idDetails(doc(head + '#### FR-1 x\n\n**描述**\n\n做点什么\n\n**验收标准**\n\n- AC-1.1 G/W/T\n'), params)
    expect(minimal).toHaveLength(0)
    const emptyOptional = PRIMITIVES.idDetails(doc(head + '#### FR-1 x\n\n**描述**\n\n做点什么\n\n**业务规则**\n\n**验收标准**\n\n- AC-1.1 G/W/T\n'), params)
    expect(emptyOptional.some((x) => x.message.includes('业务规则'))).toBe(true)
  })
})

describe('内置原语（补集）', () => {
  const doc = (text: string): ParsedDoc => parseDocument(text)

  it('frontmatterPattern：不匹配才报，pattern 非法自成一条', () => {
    const ok = PRIMITIVES.frontmatterPattern(doc('---\nid: PRJ-0001\n---\n'), { key: 'id', pattern: '^PRJ-\\d{4}$' })
    expect(ok).toHaveLength(0)
    const bad = PRIMITIVES.frontmatterPattern(doc('---\nid: PRJ-1\n---\n'), { key: 'id', pattern: '^PRJ-\\d{4}$' })
    expect(bad[0]?.message).toContain('不匹配')
    const broken = PRIMITIVES.frontmatterPattern(doc('---\nid: x\n---\n'), { key: 'id', pattern: '([' })
    expect(broken[0]?.message).toContain('pattern 非法')
  })

  it('sectionsForbidden：出现即报，带行号；只认结构节不认正文里的同名文字', () => {
    const v = PRIMITIVES.sectionsForbidden(doc('# t\n\n## 附录\n\n正文里提到「免责声明」不算\n'), { headings: ['附录', '免责声明'] })
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('附录')
    expect(v[0]?.line).toBe(3)
  })

  it('sectionsServes：每个 H2 都要有 serves；H3 不在此列', () => {
    const v = PRIMITIVES.sectionsServes(doc('## 摘要 serves: 全文\n\n## 背景\n\n### 小节\n'), {})
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('背景')
    expect(PRIMITIVES.sectionsServes(doc('## 摘要 serves: FR-1\n\n## 背景  serves：全文\n'), {})).toHaveLength(0)
  })

  it('forbiddenText / requiredText：按行命中与缺失', () => {
    const text = '# t\n\n这里写了 TODO\n'
    const hit = PRIMITIVES.forbiddenText(doc(text), { patterns: ['TODO'] })
    expect(hit).toHaveLength(1)
    expect(hit[0]?.line).toBe(3)
    expect(PRIMITIVES.requiredText(doc(text), { patterns: ['验收标准'] })[0]?.message).toContain('缺必需内容')
    expect(PRIMITIVES.requiredText(doc(text), { patterns: ['TODO'] })).toHaveLength(0)
  })

  it('size：行数与字符数上限各自生效', () => {
    const long = Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 行`).join('\n')
    expect(PRIMITIVES.size(doc(long), { max_lines: 5 })[0]?.message).toContain('行')
    expect(PRIMITIVES.size(doc(long), { max_chars: 5 })[0]?.message).toContain('字符')
    expect(PRIMITIVES.size(doc(long), { max_lines: 100, max_chars: 10000 })).toHaveLength(0)
  })

  it('templateSections：文档缺模板里的 H2 节', () => {
    const tpl = doc('## 摘要\n\n## 验收\n')
    const v = PRIMITIVES.templateSections(doc('## 摘要\n'), {}, tpl)
    expect(v.map((x) => x.message).join()).toContain('缺模板章节「验收」')
    expect(PRIMITIVES.templateSections(doc('## 摘要\n'), {}, undefined)).toHaveLength(0)
  })
})

describe('delta：只拦新增违规', () => {
  const spec = normalizeSpec({
    name: 'x', match: ['*.md'], diff_mode: 'delta',
    rules: [{ id: 's', assert: { fn: 'sectionsRequired', args: [{ headings: ['背景', '验收'] }] } }],
  }, '/ws/.dsh/file-format-specs/x.yaml')
  it('before 已有的违规不重报', () => {
    const r = validateDocument(spec, '## 背景\n## 验收\n', '## 背景\n')
    expect(r.newErrors).toHaveLength(0)
  })
  it('新建（before=null）等价 strict', () => {
    const r = validateDocument(spec, '## 背景\n', null)
    expect(r.newErrors.map((v) => v.checkId)).toContain('s')
  })
})

describe('动态代码：expr / script（spec.functions）', () => {
  const s = (functions: Record<string, unknown>, rules: unknown[]): FormatSpec =>
    normalizeSpec({ name: 'x', match: ['*.md'], functions, rules }, '/ws/.dsh/file-format-specs/x.yaml')
  it('expr 函数：通过 / 不通过', () => {
    const spec = s({ atLeastOneFr: { expr: 'api.collectIds(text, ["FR"]).length > 0' } }, [{ id: 'fr', assert: { fn: 'atLeastOneFr', message: '至少一条 FR' } }])
    expect(validateDocument(spec, '**FR-1: a**', null).errors).toHaveLength(0)
    const r = validateDocument(spec, '# 无编号', null)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].message).toContain('至少一条 FR')
  })
  it('script 函数：返回对象数组，带行号，undefined 视为通过', () => {
    const spec = s({ bg: { script: 'const m = []; if (!api.hasSection(doc, "背景")) m.push({ message: "缺背景", key: "bg", line: 1 }); return m' } }, [{ id: 'bg', assert: { fn: 'bg' } }])
    const r = validateDocument(spec, '# t', null)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].message).toBe('缺背景')
    expect(r.errors[0].line).toBe(1)
    const ok = s({ ok: { script: 'return' } }, [{ id: 'ok', assert: { fn: 'ok' } }])
    expect(validateDocument(ok, '# t', null).errors).toHaveLength(0)
  })
  it('脚本抛错 → 一条错误，不崩', () => {
    const spec = s({ boom: { script: 'return notDefined.x' } }, [{ id: 'boom', assert: { fn: 'boom' } }])
    const r = validateDocument(spec, '# t', null)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].message).toContain('函数执行失败')
  })
  it('死循环被超时截断', () => {
    const spec = s({ loop: { script: 'while(true){}' } }, [{ id: 'loop', assert: { fn: 'loop' } }])
    const r = validateDocument(spec, '# t', null, undefined, { scriptTimeoutMs: 80 })
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].message).toContain('函数执行失败')
  })
  it('白名单边界：脚本里看不到 process / require / fs（能看到就说明注入口子开大了）', () => {
    const probe = [
      'const leaks = ["process", "require", "fs"]',
      '  .filter((name) => typeof globalThis[name] !== "undefined")',
      '  .map((name) => ({ message: "白名单泄漏：" + name }))',
      'return leaks',
    ].join('\n')
    const spec = s({ noLeak: { script: probe } }, [{ id: 'noLeak', assert: { fn: 'noLeak' } }])
    expect(validateDocument(spec, '# t', null).errors).toHaveLength(0)
    // 承诺过的上下文仍然可用（doc / text / api）
    const usable = s({ hasApi: { expr: 'typeof api === "object" && typeof doc === "object" && typeof text === "string"' } },
      [{ id: 'hasApi', assert: { fn: 'hasApi' } }])
    expect(validateDocument(usable, '# t', null).errors).toHaveLength(0)
  })
})

describe('打回指引：目标模板与骨架', () => {
  it('spec 有 template 时展示模板全文', () => {
    const s = normalizeSpec({ name: 'x', match: ['x.md'], template: 'x.md', rules: [{ id: 's', assert: { fn: 'sectionsRequired', args: [{ headings: ['背景'] }] } }] }, '/ws/.dsh/file-format-specs/x.yaml')
    const report = validateDocument(s, '# t\n', null, '## 背景\n')
    const text = renderFormatGuidance({ relPath: 'x.md', specName: 'x', templateRel: 'x.md', report, attempts: 1, maxAttempts: 3, templateText: '## 背景\n', exampleRel: '.dsh/file-format-specs/x/example.md', op: 'create', sameContent: false })
    expect(text).toContain('【目标模板')
    expect(text).toContain('## 背景')
    expect(text).toContain('【填写参考】.dsh/file-format-specs/x/example.md')
  })
  it('无 template 时从规则推骨架', () => {
    const s = normalizeSpec({ name: 'x', match: ['x.md'], rules: [
      { id: 'fm', assert: { fn: 'frontmatterRequired', args: [{ keys: ['title', 'status'] }] } },
      { id: 's', assert: { fn: 'sectionsRequired', args: [{ headings: ['背景', '需求清单'] }] } },
      { id: 't', assert: { fn: 'tableRequired', args: [{ under: '需求清单', header: ['编号', '需求'] }] } },
    ] }, '/ws/.dsh/file-format-specs/x.yaml')
    const sk = buildSkeleton(s) ?? ''
    expect(sk).toContain('title: ')
    expect(sk).toContain('status: ')
    expect(sk).toContain('## 背景')
    expect(sk).toContain('## 需求清单')
    expect(sk).toContain('| 编号 | 需求 |')
    const report = validateDocument(s, '# t\n', null, undefined)
    const text = renderFormatGuidance({ relPath: 'x.md', specName: 'x', report, attempts: 1, maxAttempts: 3, skeletonText: sk, op: 'create', sameContent: false })
    expect(text).toContain('【目标结构')
  })
})

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'file-format-'))
  mkdirSync(join(ws, '.dsh/file-format-specs/prd'), { recursive: true })
  writeFileSync(join(ws, '.dsh/file-format-specs/prd/spec.yaml'), [
    'ext: md', 'match:', '  - "prd.md"', 'mode: block',
    'rules:', '  - id: sections', '    assert:', '      fn: sectionsRequired', '      args:', '        - headings: ["背景", "验收标准"]',
  ].join('\n'), 'utf8')
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

function harness(logs: string[] = []): { call: (name: string, rel: string, content: string, before?: string | null) => Promise<PostToolDecision> } {
  const store = new FormatStore({ workspaceRoot: ws })
  let listener: any
  installPostCheck(store, (l) => { listener = l }, {
    workspaceRoot: ws,
    logger: {
      debug: (m) => logs.push('debug:' + m),
      info: (m) => logs.push('info:' + m),
      warn: (m) => logs.push('warn:' + m),
    },
  })
  const call = (name: string, rel: string, content: string, before: string | null = null): Promise<PostToolDecision> => {
    const exec = { name, arguments: { file_path: rel, content }, agent: { id: 'a1' } }
    const result = { isError: false, value: { path: join(ws, rel), operation: 'create', before, after: content }, content: [] }
    return listener(exec, result, async () => ({ kind: 'accept' }))
  }
  return { call }
}

describe('post-execute 集成', () => {
  it('匹配不上 → 放行', async () => {
    const { call } = harness()
    expect(await call('write', 'docs/other.md', '随便')).toEqual({ kind: 'accept' })
  })
  it('命中且合规 → accept 零返回', async () => {
    const { call } = harness()
    const d = await call('write', 'docs/prd.md', '# 背景\n\n## 背景\n\n## 验收标准\n')
    expect(d).toEqual({ kind: 'accept' })
  })
  it('命中且违规 → block 且一次报全', async () => {
    const { call } = harness()
    const d = await call('write', 'docs/prd.md', '# 缺章节\n')
    expect(d.kind).toBe('block')
    const text = (d as { feedback: Array<{ text: string }> }).feedback[0].text
    expect(text).toContain('内容未通过格式规范')
    expect(text).toContain('缺章节「背景」')
    expect(text).toContain('缺章节「验收标准」')
    expect(text).toContain('【目标结构')
    expect(text).toContain('## 背景')
    expect(text).toContain('## 验收标准')
  })
  it('mode=warn → accept 附提醒，不阻断', async () => {
    writeFileSync(join(ws, '.dsh/file-format-specs/prd/spec.yaml'), [
      'match: ["prd.md"]',
      'mode: warn',
      'rules:',
      '  - id: sections',
      '    assert: { fn: sectionsRequired, args: [{ headings: ["背景"] }] }',
    ].join('\n'), 'utf8')
    const { call } = harness()
    const d = await call('write', 'docs/prd.md', '# 缺章节\n')
    expect(d.kind).toBe('accept')
    const text = (d as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain('mode=warn')
    expect(text).toContain('缺章节「背景」')
    expect(text).not.toContain('【还有】')
  })
  it('只有 warning → accept 且保留建议反馈', async () => {
    writeFileSync(join(ws, '.dsh/file-format-specs/prd/spec.yaml'), [
      'match: ["prd.md"]',
      'rules:',
      '  - id: sections',
      '    severity: warning',
      '    assert: { fn: sectionsRequired, args: [{ headings: ["背景"] }] }',
    ].join('\n'), 'utf8')
    const { call } = harness()
    const d = await call('write', 'docs/prd.md', '# 缺章节\n')
    expect(d.kind).toBe('accept')
    const text = (d as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain('不阻断')
    expect(text).toContain('【建议（不阻断）】')
  })
  it('超预算且 on_exhausted=allow → accept 附警告', async () => {
    const { call } = harness()
    let last: PostToolDecision = { kind: 'accept' }
    for (let i = 0; i < 5; i++) last = await call('write', 'docs/prd.md', '# 缺章节\n')
    expect(last.kind).toBe('accept')
    const text = (last as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain('已按 on_exhausted=allow 放行')
  })
  it('打回时记一条结构化日志（spec / 文件 / 规则 / 违规数 / 次数）', async () => {
    const logs: string[] = []
    const { call } = harness(logs)
    await call('write', 'docs/prd.md', '# 缺章节\n')
    const warn = logs.find((l) => l.startsWith('warn:'))
    expect(warn, logs.join('\n')).toBeDefined()
    expect(warn).toContain('spec=prd')
    expect(warn).toContain('file=docs/prd.md')
    expect(warn).toContain('rules=sections')
    expect(warn).toContain('errors=2')
    expect(warn).toContain('attempt=1/3')
  })
  it('未命中规范不静默：记一条 debug', async () => {
    const logs: string[] = []
    const { call } = harness(logs)
    await call('write', 'docs/other.md', '随便')
    expect(logs.some((l) => l.startsWith('debug:') && l.includes('未命中'))).toBe(true)
  })
  it('预算用尽放行时，日志能区分「预算用尽」与 warn 模式', async () => {
    const logs: string[] = []
    const { call } = harness(logs)
    for (let i = 0; i < 5; i++) await call('write', 'docs/prd.md', '# 缺章节\n')
    expect(logs.some((l) => l.startsWith('info:') && l.includes('预算用尽'))).toBe(true)
  })
  it('edit：只拦本次新增违规（delta），旧文件的历史问题不背锅', async () => {
    const { call } = harness()
    const bad = '# 缺章节\n'
    expect((await call('write', 'docs/prd.md', bad, null)).kind).toBe('block')  // 新建：等价 strict
    // 原样改一遍：before 里已有的两条违规不算本次新增 → 放行
    expect((await call('edit', 'docs/prd.md', bad, bad)).kind).toBe('accept')
  })
  it('校验内部异常：降级放行，不阻断已落盘的文件', async () => {
    const logs: string[] = []
    const broken = { match: () => { throw new Error('boom: 匹配器炸了') } } as unknown as FormatStore
    let listener: any
    installPostCheck(broken, (l) => { listener = l }, {
      workspaceRoot: ws,
      logger: { warn: (m: string) => logs.push('warn:' + m) },
    })
    const exec = { name: 'write', arguments: { file_path: 'docs/prd.md' }, agent: { id: 'a1' } }
    const result = { isError: false, value: { path: join(ws, 'docs/prd.md'), operation: 'create', before: null, after: '# x\n' } }
    const decision = await listener(exec, result, async () => ({ kind: 'accept' }))

    expect(decision).toEqual({ kind: 'accept' })
    expect(logs.some((l) => l.includes('内部异常'))).toBe(true)
  })

  it('mode: off → 零返回放行（连提示都不给）', async () => {
    writeFileSync(join(ws, '.dsh/file-format-specs/prd/spec.yaml'), [
      'match: ["prd.md"]',
      'mode: off',
      'rules:',
      '  - id: sections',
      '    assert: { fn: sectionsRequired, args: [{ headings: ["背景"] }] }',
    ].join('\n'), 'utf8')
    const { call } = harness()
    expect(await call('write', 'docs/prd.md', '# 缺章节\n')).toEqual({ kind: 'accept' })
  })

  it('diff_mode: strict → 改写时历史违规照报（与 delta 相反）', async () => {
    writeFileSync(join(ws, '.dsh/file-format-specs/prd/spec.yaml'), [
      'match: ["prd.md"]',
      'diff_mode: strict',
      'rules:',
      '  - id: sections',
      '    assert: { fn: sectionsRequired, args: [{ headings: ["背景"] }] }',
    ].join('\n'), 'utf8')
    const { call } = harness()
    const bad = '# 缺章节\n'
    expect((await call('write', 'docs/prd.md', bad, null)).kind).toBe('block')
    // 内容一个字没改：delta 会放行，strict 必须继续拦
    const again = await call('edit', 'docs/prd.md', bad, bad)
    expect(again.kind).toBe('block')
  })

  it('on_exhausted: block → 预算用尽后继续拦，不放行', async () => {
    writeFileSync(join(ws, '.dsh/file-format-specs/prd/spec.yaml'), [
      'match: ["prd.md"]',
      'max_attempts: 2',
      'on_exhausted: block',
      'rules:',
      '  - id: sections',
      '    assert: { fn: sectionsRequired, args: [{ headings: ["背景"] }] }',
    ].join('\n'), 'utf8')
    const { call } = harness()
    for (let i = 0; i < 5; i++) {
      expect((await call('write', 'docs/prd.md', '# 缺章节\n')).kind).toBe('block')
    }
  })

  it('同一份不合规内容再交一次 → 附「内容与你上次被拒的一致」提醒', async () => {
    const { call } = harness()
    const first = await call('write', 'docs/prd.md', '# 缺章节\n')
    expect((first as { feedback: Array<{ text: string }> }).feedback[0].text).not.toContain('上次被拒')
    const second = await call('write', 'docs/prd.md', '# 缺章节\n')
    expect((second as { feedback: Array<{ text: string }> }).feedback[0].text).toContain('上次被拒')
  })
})

describe('示例规范守护', () => {
  const dir = new URL('../examples/file-format-specs', import.meta.url)
  const specs = readSpecDir(dir.pathname)
  it('全部示例类型可加载，且至少有 match 或 match_path', () => {
    expect(specs.length).toBeGreaterThan(0)
    for (const s of specs) {
      expect(s.name.length).toBeGreaterThan(0)
      expect(s.match.length + s.matchPath.length).toBeGreaterThan(0)
    }
  })
  it('每份声明 template 的示例，模板文件都真实存在', () => {
    for (const s of specs) {
      if (s.template !== undefined) expect(existsSync(join(s.dir, s.template)), s.name + ' 缺模板 ' + s.template).toBe(true)
    }
  })
  it('每份示例模板都通过它自己的 spec（零 error）', () => {
    for (const s of specs) {
      if (s.template === undefined) continue
      const abs = join(s.dir, s.template)
      if (!existsSync(abs)) continue
      const text = readFileSync(abs, 'utf8')
      const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
      expect(r.errors.map((e) => e.message), s.name).toHaveLength(0)
    }
  })
  it('owner_team 可替代 owner（frontmatterRequired 不硬要 owner）', () => {
    const s = specs.find((x) => x.name === 'prd')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace(/^owner:.*$/m, 'owner_team: 平台组')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.map((e) => e.message)).toHaveLength(0)
  })
  it('status 值域受约束', () => {
    const s = specs.find((x) => x.name === 'prd')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace(/^status:.*$/m, 'status: 随便乱写')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('允许值域'))).toBe(true)
  })
  it('清单有编号但缺明细会被拦', () => {
    const s = specs.find((x) => x.name === 'prd')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace(/^#### FR-1.*$/m, '')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('缺对应明细'))).toBe(true)
  })
  it('需求明细缺核心小节会被拦（描述 / 验收标准）', () => {
    const s = specs.find((x) => x.name === 'prd')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace(/^\*\*描述\*\*$/m, '**说明**')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('缺「描述」'))).toBe(true)
  })
  it('每份 example 都是合规文档（零 error）', () => {
    for (const s of specs) {
      if (s.example === undefined) continue
      const abs = join(s.dir, s.example)
      if (!existsSync(abs)) continue
      const text = readFileSync(abs, 'utf8')
      const r = validateDocument(s, text, null, text, { fileName: 'example.md' })
      expect(r.errors.map((e) => e.message), s.name + ' example').toHaveLength(0)
    }
  })
  it('design 的 script 函数确实会跑', () => {
    const spec = specs.find((s) => s.name === 'design')
    expect(spec).toBeDefined()
    const r = validateDocument(spec!, '## 架构\n', null, undefined, { fileName: 'a.md', relPath: 'docs/design/a.md' })
    expect(r.errors.some((x) => x.message.includes('serves'))).toBe(true)
  })
  it('design：H2 缺 serves 会被拦', () => {
    const s = specs.find((x) => x.name === 'design')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace(/^## 摘要.*$/m, '## 摘要')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('缺 serves 标注'))).toBe(true)
  })
  it('design：接口清单有 IF 编号但缺明细会被拦', () => {
    const s = specs.find((x) => x.name === 'design')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace(/^#### IF-2.*$/m, '')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('缺对应明细'))).toBe(true)
  })
  it('design：接口明细缺「错误码」会被拦', () => {
    const s = specs.find((x) => x.name === 'design')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace(/^\*\*错误码\*\*$/m, '**失败处理**')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('缺「错误码」'))).toBe(true)
  })
  it('design：一个 IF 编号都没有会被拦', () => {
    const s = specs.find((x) => x.name === 'design')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace(/IF-([12])/g, 'XX-$1')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('至少一条编号'))).toBe(true)
  })
  it('requirement：优先级不在 MoSCoW 词表会被拦', () => {
    const s = specs.find((x) => x.name === 'requirement')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace('| Must |', '| 高 |')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('MoSCoW 词表'))).toBe(true)
  })
  it('requirement：清单有 R 编号但缺明细会被拦', () => {
    const s = specs.find((x) => x.name === 'requirement')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace(/^#### R-1.*$/m, '')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('缺对应明细'))).toBe(true)
  })
  it('requirement：需求明细缺「来源与证据」会被拦', () => {
    const s = specs.find((x) => x.name === 'requirement')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace(/^\*\*来源与证据\*\*$/m, '**出处**')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('缺「来源与证据」'))).toBe(true)
  })

  it('research：模板与示例都零 error / 零 warning', () => {
    const s = specs.find((x) => x.name === 'research')!
    for (const f of ['template.md', 'example.md']) {
      const text = readFileSync(join(s.dir, f), 'utf8')
      const r = validateDocument(s, text, null, text, { fileName: f })
      expect(r.errors.map((e) => e.message), f).toHaveLength(0)
      expect(r.warnings.map((e) => e.message), f).toHaveLength(0)
    }
  })
  it('research：结论的立场列不在词表会被拦', () => {
    const s = specs.find((x) => x.name === 'research')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace('| 采纳 |', '| 建议采纳 |')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('不在词表（采纳'))).toBe(true)
  })
  it('research：证据缺来源分级会被拦', () => {
    const s = specs.find((x) => x.name === 'research')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace('| E-4 | <判断与经验> | D |', '| E-4 | <判断与经验> |  |')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('缺来源分级'))).toBe(true)
  })
  it('research：只有 C / D 级证据会被拦', () => {
    const s = specs.find((x) => x.name === 'research')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8')
      .replace(/\| E-1 \| <证据一句话：出处 \+ 关键内容，不写"文档里说了"> \| A \|/, '| E-1 | <证据一句话> | C |')
      .replace(/\| E-2 \| <实测> \| B \|/, '| E-2 | <实测> | C |')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('至少要有 1 条 A 级'))).toBe(true)
  })
  it('research：调研问题没引用证据会被拦', () => {
    const s = specs.find((x) => x.name === 'research')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace('E-1（<证据一句话>）、E-2（<证据一句话>）。', '见前述实测结果。')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('没有引用任何证据编号'))).toBe(true)
  })
  it('research：证据没人用会被拦（双向追溯）', () => {
    const s = specs.find((x) => x.name === 'research')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace('）、E-4（<证据一句话>）。', '）。')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('E-4 没有被任何调研问题引用'))).toBe(true)
  })
  it('research：只有一条证据不成立（至少要两条）', () => {
    const s = specs.find((x) => x.name === 'research')!
    // 与模板同构的最小文档，只留 E-1 —— 用来验证 evidenceCount 的下限判据
    const text = [
      '---', 'title: 调研', 'status: draft', 'owner: 我', '---', '',
      '| 编号 | 证据 | 来源分级 | 获取方式与日期 |', '|---|---|---|---|',
      '| E-1 | 一条证据 | A | 2026-10-15 |', '',
      '## 摘要', 'x', '',
      '## 背景与调研问题', '',
      '| 编号 | 调研问题 | 决策影响 | 影响程度 |', '|---|---|---|---|',
      '| Q-1 | 问题一 | D-1 | 高 |', '',
      '#### Q-1 问题一', '', '**调研问题**', '问题一？', '', '**决策影响**', 'D-1。', '', '**调研与证据**', 'E-1。', '',
      '## 调研方法与范围界定', 'x', '',
      '## 决策与结论', '',
      '| 决策编号 | 要做的决定 | 决策人 | 截止 |', '|---|---|---|---|',
      '| D-1 | 决定 | 我 | 2026-10-16 |', '',
      '## 证据索引', '',
      '| 编号 | 证据 | 来源分级 | 获取方式与日期 |', '|---|---|---|---|',
      '| E-1 | 一条证据 | A | 2026-10-15 |', '',
      '## 关键发现', '',
      '| 编号 | 发现 | 支撑证据 | 事实或推断 | 可信度 |', '|---|---|---|---|---|',
      '| F-1 | 一条发现 | E-1 | 事实 | 高 |', '',
      '## 方案对比矩阵', '',
      '| 评估维度 | 权重 | A | B | C | 标注 |', '|---|---|---|---|---|---|',
      '| 一 | 50% | 1 | 2 | 3 | E-1 |', '| 二 | 50% | 1 | 2 | 3 | E-1 |',
      '| 三 | 0% | 1 | 2 | 3 | E-1 |', '| 四 | 0% | 1 | 2 | 3 | E-1 |', '',
      '## 结论与建议', '',
      '| 决策编号 | 结论 | 立场 | 成立条件 | 翻转条件 |', '|---|---|---|---|---|',
      '| D-1 | 结论 | 采纳 | 条件 | 翻转 |', '',
      '## 风险与不确定性', '',
      '| 信息缺口 | 影响哪个结论 | 获取成本 | 处理方式 |', '|---|---|---|---|',
      '| 缺口 | D-1 | 1 人日 | 下次补 |', '',
      '## 开放问题', '',
      '| 问题 | 选项 | 负责人 | 截止 |', '|---|---|---|---|',
      '| 问题 | 选项 | 我 | 已决 |', '',
      '## 附录', 'x', '',
    ].join('\n')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.map((e) => e.message).filter((m) => !m.includes('证据索引至少两条编号'))).toHaveLength(0)
    expect(r.errors.some((e) => e.message.includes('证据索引至少两条编号'))).toBe(true)
  })
  it('research：缺「证据索引」章节会被拦', () => {
    const s = specs.find((x) => x.name === 'research')!
    const text = readFileSync(join(s.dir, s.template!), 'utf8').replace(/^## 证据索引.*$/m, '## 材料来源')
    const r = validateDocument(s, text, null, text, { fileName: 'template.md' })
    expect(r.errors.some((e) => e.message.includes('缺章节「证据索引」'))).toBe(true)
  })
})
