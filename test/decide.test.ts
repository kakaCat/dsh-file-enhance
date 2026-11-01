/**
 * 判定链分支覆盖——每条分支对应一次需求讨论里冻结的规则。
 * @module dsh-file-enhance/tests/decide
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { decide, renderDest, nextAutoNumber, matchReality } from '../src/folder-path/decide.js'
import { DEFAULT_MD_RULES_YAML, normalizeRules } from '../src/folder-path/rules.js'
import type { Loaded, RuleSet, Tree } from '../src/folder-path/types.js'

const WS = '/ws'
const RAW = {
  type: 'md',
  root: 'docs',
  root_allow: ['TODO.md'],
  categories: {
    guides: { folder: 'guides', keywords: ['指南', 'guide'], dest: 'guides/{slug}.md' },
    adr: { folder: 'adr', keywords: ['决策', 'adr'], dest: 'adr/{auto_number:4}-{slug}.md' },
    project: {
      folder: 'projects',
      kind: 'collection',
      keywords: ['项目'],
      instance: { param: 'project_id', pattern: '^PRJ-\\d{4}$', acquire: 'auto', scaffold: ['requirement/'] },
      variants: {
        design: { keywords: ['设计', 'design'], dest: 'projects/{project_id}/design/{slug}.md' },
      },
    },
  },
}

const RULES: RuleSet = normalizeRules(RAW, 'md')
const LOADED: Loaded = { rules: RULES, path: '/ws/.dsh/folder-path-rules/md.yaml' }

const tree = (dirs: Array<{ name: string; subdirs?: string[] }>, files: string[] = []): Tree => ({
  exists: true,
  empty: false,
  files,
  dirs: dirs.map((d) => ({ name: d.name, abs: join(WS, 'docs', d.name), fileCount: 1, samples: [], subdirs: d.subdirs ?? [] })),
})

const run = (target: string, opts: { tree?: Tree; priorDenials?: number; loaded?: Loaded } = {}) =>
  decide({
    target: join(WS, target),
    workspaceRoot: WS,
    loaded: 'loaded' in opts ? opts.loaded : LOADED,
    tree: opts.tree ?? tree([]),
    priorDenials: opts.priorDenials ?? 0,
    listNames: (dir) => (dir.endsWith('/adr') ? ['0003-old.md'] : []),
  })

describe('① 类型过滤', () => {
  it('没有该类型的规则文件 → 放行', () => {
    expect(run('docs/x.md', { loaded: undefined })).toMatchObject({ kind: 'pass', code: 'no-rules-for-type' })
    expect(run('src/app.ts', { loaded: undefined })).toMatchObject({ kind: 'pass' })
  })
})

describe('② 根目录白名单', () => {
  it('内置白名单放行', () => {
    expect(run('README.md')).toMatchObject({ kind: 'pass', code: 'root-allow' })
    expect(run('CLAUDE.md')).toMatchObject({ kind: 'pass', code: 'root-allow' })
  })
  it('yaml root_allow 放行', () => {
    expect(run('TODO.md')).toMatchObject({ kind: 'pass', code: 'root-allow' })
  })
  it('根目录非白名单 → 硬拦，且第二次仍拦（无自由发挥豁免）', () => {
    expect(run('notes.md')).toMatchObject({ kind: 'deny', code: 'root-forbidden' })
    expect(run('notes.md', { priorDenials: 1 })).toMatchObject({ kind: 'deny', code: 'root-forbidden' })
  })
})

describe('③ 主目录之外', () => {
  it('首次拦截，第二次放行（自由发挥）', () => {
    expect(run('src/notes.md')).toMatchObject({ kind: 'deny', code: 'outside-root' })
    expect(run('src/notes.md', { priorDenials: 1 })).toMatchObject({ kind: 'pass', code: 'free-play' })
  })
})

describe('⑤ 未分类（直接落在主目录下）', () => {
  it('现实目录优先：命中已存在目录 → 自动纠偏', () => {
    const v = run('docs/setup-guide.md', { tree: tree([{ name: 'guides' }]) })
    expect(v).toMatchObject({ kind: 'correct', source: 'reality' })
    expect((v as { to: string }).to).toBe(join(WS, 'docs/guides/setup-guide.md'))
  })
  it('现实匹配不到 → 规则兜底纠偏', () => {
    const v = run('docs/guide-hardware.md', { tree: tree([{ name: 'api' }]) })
    expect(v).toMatchObject({ kind: 'correct', source: 'rules' })
    expect((v as { to: string }).to).toBe(join(WS, 'docs/guides/guide-hardware.md'))
  })
  it('adr 命中规则时用 auto_number 分配编号', () => {
    const v = run('docs/adr-cache.md', { tree: tree([{ name: 'adr' }]) })
    expect(v).toMatchObject({ kind: 'correct', source: 'reality' })
  })
  it('集合型变体（需实例编号）→ 要求先分配', () => {
    const v = run('docs/login-design.md', { tree: tree([{ name: 'api' }]) })
    expect(v).toMatchObject({ kind: 'deny', code: 'need-allocate' })
  })
  it('都不命中 → 拦截；第二次放行（自由发挥）', () => {
    expect(run('docs/misc-thing.md', { tree: tree([{ name: 'api' }]) })).toMatchObject({ kind: 'deny', code: 'unclassified' })
    expect(run('docs/misc-thing.md', { tree: tree([{ name: 'api' }]), priorDenials: 1 })).toMatchObject({ kind: 'pass', code: 'free-play' })
  })
})

describe('④ 已分类（落在子目录里）', () => {
  it('现实存在的目录（无规则）→ 放行', () => {
    expect(run('docs/notes/x.md', { tree: tree([{ name: 'notes' }]) })).toMatchObject({ kind: 'pass', code: 'classified-reality' })
  })
  it('规则分类 + 命名合规 → 放行', () => {
    expect(run('docs/guides/good-name.md', { tree: tree([{ name: 'guides' }]) })).toMatchObject({ kind: 'pass', code: 'classified-rules' })
  })
  it('规则分类 + 命名违规 → 拦截；第二次放行', () => {
    expect(run('docs/guides/BadName.md', { tree: tree([{ name: 'guides' }]) })).toMatchObject({ kind: 'deny', code: 'naming' })
    expect(run('docs/guides/BadName.md', { tree: tree([{ name: 'guides' }]), priorDenials: 1 })).toMatchObject({ kind: 'pass' })
  })
  it('既非规则分类、目录也不存在 → 拦截；第二次放行', () => {
    expect(run('docs/whatever/x.md', { tree: tree([{ name: 'guides' }]) })).toMatchObject({ kind: 'deny', code: 'unknown-category' })
    expect(run('docs/whatever/x.md', { tree: tree([{ name: 'guides' }]), priorDenials: 1 })).toMatchObject({ kind: 'pass', code: 'free-play' })
  })
})

describe('集合型：实例轴', () => {
  it('实例存在 + 变体目录 → 放行', () => {
    const v = run('docs/projects/PRJ-0001/design/login-flow.md', { tree: tree([{ name: 'projects', subdirs: ['PRJ-0001'] }]) })
    expect(v).toMatchObject({ kind: 'pass', code: 'classified-rules' })
  })
  it('实例存在但变体目录未登记 → 拦截', () => {
    const v = run('docs/projects/PRJ-0001/unknown/login.md', { tree: tree([{ name: 'projects', subdirs: ['PRJ-0001'] }]) })
    expect(v).toMatchObject({ kind: 'deny', code: 'unknown-variant' })
  })
  it('实例不存在 → 要求先分配编号', () => {
    const v = run('docs/projects/PRJ-0009/design/login.md', { tree: tree([{ name: 'projects', subdirs: ['PRJ-0001'] }]) })
    expect(v).toMatchObject({ kind: 'deny', code: 'need-allocate' })
  })
  it('编号格式非法 → 拦截', () => {
    const v = run('docs/projects/xx/design/login.md', { tree: tree([{ name: 'projects', subdirs: ['xx'] }]) })
    expect(v).toMatchObject({ kind: 'deny', code: 'bad-instance' })
  })
  it('变体使用自己的 naming，而不是父分类命名', () => {
    const rules = normalizeRules({
      root: 'docs',
      categories: {
        project: {
          folder: 'projects', kind: 'collection', naming: 'kebab-case',
          instance: { param: 'project_id', pattern: '^PRJ-\\d{4}$' },
          variants: { design: { naming: 'PascalCase', dest: 'projects/{project_id}/design/{slug}.md' } },
        },
      },
    }, 'md')
    const loaded: Loaded = { rules, path: '/ws/.dsh/folder-path-rules/md.yaml' }
    const reality = tree([{ name: 'projects', subdirs: ['PRJ-0001'] }])
    expect(run('docs/projects/PRJ-0001/design/login-flow.md', { loaded, tree: reality })).toMatchObject({ kind: 'deny', code: 'naming', naming: 'PascalCase' })
    expect(run('docs/projects/PRJ-0001/design/LoginFlow.md', { loaded, tree: reality })).toMatchObject({ kind: 'pass', code: 'classified-rules' })
  })
})

describe('规则文件非法', () => {
  it('首次拦截并指名错误；第二次放行（不因坏规则卡死 agent）', () => {
    const bad: Loaded = { error: 'root 缺失', path: '/ws/.dsh/folder-path-rules/md.yaml' }
    expect(run('docs/x.md', { loaded: bad })).toMatchObject({ kind: 'deny', code: 'rules-invalid' })
    expect(run('docs/x.md', { loaded: bad, priorDenials: 1 })).toMatchObject({ kind: 'pass', code: 'free-play' })
  })
})

describe('渲染与匹配原语', () => {
  it('nextAutoNumber 取最大编号 +1 并补零', () => {
    expect(nextAutoNumber(['0003-a.md', '0011-b.md'], 4)).toBe('0012')
    expect(nextAutoNumber([], 4)).toBe('0001')
  })
  it('renderDest 支持 auto_number / slug', () => {
    expect(renderDest('adr/{auto_number:4}-{slug}.md', { slug: 'cache' }, { rootAbs: '/ws/docs', listNames: () => ['0007-x.md'] }))
      .toBe('adr/0008-cache.md')
  })
  it('dest 以 {root} 开头时不会重复拼接主目录', () => {
    const rules = normalizeRules({
      root: 'docs',
      categories: { guides: { folder: 'guides', keywords: ['guide'], dest: '{root}/guides/{slug}.md' } },
    }, 'md')
    const v = run('docs/setup-guide.md', { loaded: { rules, path: '/ws/.dsh/folder-path-rules/md.yaml' } })
    expect(v).toMatchObject({ kind: 'correct', to: join(WS, 'docs/guides/setup-guide.md') })
  })
  it('matchReality 支持单复数', () => {
    expect(matchReality(tree([{ name: 'guides' }]), 'setup-guide.md')?.name).toBe('guides')
    expect(matchReality(tree([{ name: 'api' }]), 'setup-guide.md')).toBeUndefined()
  })
})

describe('随包默认规则：PRD 与内容规范的接线', () => {
  const shipped: RuleSet = normalizeRules(yaml.load(DEFAULT_MD_RULES_YAML), 'md')
  const loaded: Loaded = { rules: shipped, path: '/ws/.dsh/folder-path-rules/md.yaml' }

  it('docs/prd-登录.md 纠偏到 docs/prd/，不再掉进 project 集合型分类', () => {
    const v = run('docs/prd-登录.md', { loaded })
    expect(v).toMatchObject({ kind: 'correct', to: join(WS, 'docs/prd/prd-登录.md') })
  })

  it('「产品需求」同样归 prd（否则会被「需求」抢进需求池）', () => {
    const v = run('docs/产品需求-登录.md', { loaded })
    expect(v).toMatchObject({ kind: 'correct', category: { key: 'prd' } })
  })

  it('两条分类不抢同一个关键词：prd 不在 project 的 keywords 里', () => {
    expect(shipped.categories.project?.keywords).not.toContain('prd')
    expect(shipped.categories.prd?.keywords).toContain('prd')
  })
})

describe('随包默认规则：docs 根下的项目级文档', () => {
  const loaded: Loaded = {
    rules: normalizeRules(yaml.load(DEFAULT_MD_RULES_YAML), 'md'),
    path: '/ws/.dsh/folder-path-rules/md.yaml',
  }

  it.each([
    'docs/test-plan.md',
    'docs/template-authoring.md',
    'docs/folder-path-rules.md',
    'docs/content-validation-design.md',
    'docs/设计-缓存方案.md',
  ])('%s 原样放行（meta 分类的 dest 就是当前位置）', (target) => {
    expect(run(target, { loaded })).toMatchObject({ kind: 'pass', code: 'already-normal' })
  })

  it('无关键词的裸文件仍然打回（附分类菜单；第二次放行）', () => {
    expect(run('docs/notes.md', { loaded })).toMatchObject({ kind: 'deny', code: 'unclassified' })
    expect(run('docs/notes.md', { loaded, priorDenials: 1 })).toMatchObject({ kind: 'pass', code: 'free-play' })
  })

  it('集合型变体不再靠关键词抢 docs 根下的文件（只按目录名匹配）', () => {
    // 变体目录内仍然按目录名认：projects/PRJ-0001/design/x.md → 放行
    const t = tree([{ name: 'projects', subdirs: ['PRJ-0001'] }])
    expect(run('docs/projects/PRJ-0001/design/cache.md', { loaded, tree: t })).toMatchObject({ kind: 'pass' })
    // 但 docs 根下的「设计」类文件不会被它抢成 need-allocate
    expect(run('docs/设计-缓存方案.md', { loaded })).not.toMatchObject({ kind: 'deny', code: 'need-allocate' })
  })
})
