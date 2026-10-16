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

function harness(): { call: (name: string, rel: string, content: string, before?: string | null) => Promise<PostToolDecision> } {
  const store = new FormatStore({ workspaceRoot: ws })
  let listener: any
  installPostCheck(store, (l) => { listener = l }, { workspaceRoot: ws })
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
