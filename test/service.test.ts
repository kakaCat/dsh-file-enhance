/**
 * Host 服务测试：ensure / status / provision 的预置、只读与原子校验。
 * @module dsh-file-enhance/tests/service
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.js'
import {
  createFileEnhanceService,
  FileEnhanceError,
  FILE_ENHANCE_INVALID_INPUT,
  type FileEnhanceService,
} from '../src/host/service.js'

const workspaces: string[] = []
afterEach(() => {
  while (workspaces.length > 0) rmSync(workspaces.pop()!, { recursive: true, force: true })
})

function makeWorkspace(prefix = 'file-enhance-service-'): string {
  const ws = mkdtempSync(join(tmpdir(), prefix))
  workspaces.push(ws)
  return ws
}

const RULES_DIR = (ws: string): string => join(ws, '.dsh/folder-path-rules')
const FORMATS_DIR = (ws: string): string => join(ws, '.dsh/file-format-specs')

/** 目录树快照（相对路径 + 类型 + mtime），用于断言「只读」。 */
function snapshot(dir: string): string {
  const out: string[] = []
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name)
      const r = rel === '' ? name : `${rel}/${name}`
      const st = statSync(p)
      out.push(`${r}|${st.isDirectory() ? 'd' : 'f'}|${st.mtimeMs}`)
      if (st.isDirectory()) walk(p, r)
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out.join('\n')
}

describe('ensure：预置默认规范', () => {
  it('冷启动生成 md 规则与默认文档规范，types 非空', () => {
    const ws = makeWorkspace()
    const svc = createFileEnhanceService({ workspaceRoot: ws })

    const r = svc.ensure(ws)

    expect(r.rules.dir).toBe(RULES_DIR(ws))
    expect(r.rules.created).toBe(true)
    expect(r.rules.types).toContain('md')
    expect(existsSync(join(RULES_DIR(ws), 'md.yaml'))).toBe(true)

    expect(r.formats.dir).toBe(FORMATS_DIR(ws))
    expect(r.formats.created).toBe(true)
    expect(r.formats.types.length).toBeGreaterThan(0)
    for (const name of r.formats.types) {
      expect(existsSync(join(FORMATS_DIR(ws), name, 'spec.yaml'))).toBe(true)
    }
  })

  it('二次 ensure 幂等：created=false，types 仍非空，内容不变', () => {
    const ws = makeWorkspace()
    const svc = createFileEnhanceService({ workspaceRoot: ws })
    const first = svc.ensure(ws)
    const rulesBefore = readFileSync(join(RULES_DIR(ws), 'md.yaml'), 'utf8')
    const specsBefore = snapshot(FORMATS_DIR(ws))

    const second = svc.ensure(ws)

    expect(second.rules.created).toBe(false)
    expect(second.formats.created).toBe(false)
    expect(second.rules.types).toEqual(first.rules.types)
    expect(second.formats.types).toEqual(first.formats.types)
    expect(second.formats.types.length).toBeGreaterThan(0)
    expect(readFileSync(join(RULES_DIR(ws), 'md.yaml'), 'utf8')).toBe(rulesBefore)
    expect(snapshot(FORMATS_DIR(ws))).toBe(specsBefore)
  })

  it('已有用户规则 → 不覆写（created=false）', () => {
    const ws = makeWorkspace()
    mkdirSync(RULES_DIR(ws), { recursive: true })
    writeFileSync(join(RULES_DIR(ws), 'md.yaml'), 'type: md\nroot: notes\ncategories: {}\n', 'utf8')

    const svc = createFileEnhanceService({ workspaceRoot: ws })
    const r = svc.ensure(ws)

    expect(r.rules.created).toBe(false)
    expect(r.rules.types).toContain('md')
    expect(readFileSync(join(RULES_DIR(ws), 'md.yaml'), 'utf8')).toContain('root: notes')
  })
})

describe('status：只读', () => {
  it('空工作区不创建 .dsh，types 为空', () => {
    const ws = makeWorkspace()
    const svc = createFileEnhanceService({ workspaceRoot: ws })

    const r = svc.status(ws)

    expect(r.rules.types).toEqual([])
    expect(r.formats.types).toEqual([])
    expect(existsSync(join(ws, '.dsh'))).toBe(false)
  })

  it('已预置后调用：目录文件集与 mtime 均不变', () => {
    const ws = makeWorkspace()
    const svc = createFileEnhanceService({ workspaceRoot: ws })
    svc.ensure(ws)
    const before = snapshot(join(ws, '.dsh'))

    const r = svc.status(ws)

    expect(snapshot(join(ws, '.dsh'))).toBe(before)
    expect(r.rules.types).toContain('md')
    expect(r.formats.types.length).toBeGreaterThan(0)
    expect(r.rules.dir).toBe(RULES_DIR(ws))
    expect(r.formats.dir).toBe(FORMATS_DIR(ws))
  })

  it('健康的规范：invalid / missing 都为空', () => {
    const ws = makeWorkspace()
    const svc = createFileEnhanceService({ workspaceRoot: ws })
    svc.ensure(ws)

    const r = svc.status(ws)

    expect(r.rules.invalid).toEqual([])
    expect(r.formats.invalid).toEqual([])
    expect(r.formats.missing).toEqual([])
    expect(r.formats.types.length).toBeGreaterThan(0)
  })

  it('规则 yaml 写坏 → 进 invalid 并给出原因（过去只静默跳过）', () => {
    const ws = makeWorkspace()
    mkdirSync(RULES_DIR(ws), { recursive: true })
    writeFileSync(join(RULES_DIR(ws), 'md.yaml'), 'type: md\nroot: docs\n', 'utf8') // 缺 categories

    const r = createFileEnhanceService({ workspaceRoot: ws }).status(ws)

    expect(r.rules.types).toEqual([])
    expect(r.rules.invalid).toHaveLength(1)
    expect(r.rules.invalid[0]?.name).toBe('md')
    expect(r.rules.invalid[0]?.reason).toContain('categories')
  })

  it('内容规范：坏 spec 进 invalid，只有目录没 spec 的进 missing', () => {
    const ws = makeWorkspace()
    mkdirSync(join(FORMATS_DIR(ws), 'prd'), { recursive: true })
    writeFileSync(join(FORMATS_DIR(ws), 'prd/spec.yaml'), 'match: []\n', 'utf8') // match 为空 → 拒绝加载
    mkdirSync(join(FORMATS_DIR(ws), 'draft-only'), { recursive: true })

    const r = createFileEnhanceService({ workspaceRoot: ws }).status(ws)

    expect(r.formats.types).toEqual([])
    expect(r.formats.invalid.map((i) => i.name)).toEqual(['prd'])
    expect(r.formats.invalid[0]?.reason).toContain('match')
    expect(r.formats.missing.map((i) => i.name)).toEqual(['draft-only'])
  })
})

describe('provision：按 profile 写入', () => {
  it('写 rules + formats，created 两条且内容逐字节正确', () => {
    const ws = makeWorkspace()
    const svc = createFileEnhanceService({ workspaceRoot: ws })
    const ruleYaml = 'type: ts\nroot: docs\ncategories: {}\n'
    const specYaml = 'match: ["*.api.md"]\n'

    const r = svc.provision(ws, {
      rules: [{ ext: 'ts', yaml: ruleYaml }],
      formats: [{ name: 'api-doc', spec: specYaml, template: '# t\n', example: '# e\n' }],
    })

    expect([...r.created].sort()).toEqual(['format:api-doc', 'rule:ts'])
    expect(r.skipped).toEqual([])
    expect(readFileSync(join(RULES_DIR(ws), 'ts.yaml'), 'utf8')).toBe(ruleYaml)
    expect(readFileSync(join(FORMATS_DIR(ws), 'api-doc/spec.yaml'), 'utf8')).toBe(specYaml)
    expect(readFileSync(join(FORMATS_DIR(ws), 'api-doc/template.md'), 'utf8')).toBe('# t\n')
    expect(readFileSync(join(FORMATS_DIR(ws), 'api-doc/example.md'), 'utf8')).toBe('# e\n')
  })

  it('同 profile 再次 provision → 全部 skipped，不覆写', () => {
    const ws = makeWorkspace()
    const svc = createFileEnhanceService({ workspaceRoot: ws })
    const profile = {
      rules: [{ ext: 'ts', yaml: 'type: ts\nroot: docs\ncategories: {}\n' }],
      formats: [{ name: 'api-doc', spec: 'match: ["*.api.md"]\n' }],
    }
    expect([...svc.provision(ws, profile).created].sort()).toEqual(['format:api-doc', 'rule:ts'])

    const again = svc.provision(ws, profile)

    expect(again.created).toEqual([])
    expect([...again.skipped].sort()).toEqual(['format:api-doc', 'rule:ts'])
    expect(readFileSync(join(RULES_DIR(ws), 'ts.yaml'), 'utf8')).toBe(profile.rules[0].yaml)
  })

  it('已存在的用户 spec → skipped，内容不被覆写（template/example 也不动）', () => {
    const ws = makeWorkspace()
    mkdirSync(join(FORMATS_DIR(ws), 'prd'), { recursive: true })
    writeFileSync(join(FORMATS_DIR(ws), 'prd/spec.yaml'), 'match: ["custom.md"]\n', 'utf8')

    const svc = createFileEnhanceService({ workspaceRoot: ws })
    const r = svc.provision(ws, {
      formats: [{ name: 'prd', spec: 'match: ["other.md"]\n', template: '# x\n' }],
    })

    expect(r.created).toEqual([])
    expect(r.skipped).toEqual(['format:prd'])
    expect(readFileSync(join(FORMATS_DIR(ws), 'prd/spec.yaml'), 'utf8')).toBe('match: ["custom.md"]\n')
    expect(existsSync(join(FORMATS_DIR(ws), 'prd/template.md'))).toBe(false)
  })
})

describe('provision：非法输入零落盘', () => {
  function expectInvalid(fn: () => unknown): void {
    try {
      fn()
    } catch (err) {
      expect(err).toBeInstanceOf(FileEnhanceError)
      expect((err as FileEnhanceError).code).toBe(FILE_ENHANCE_INVALID_INPUT)
      return
    }
    throw new Error('应当抛出 FileEnhanceError(FILE_ENHANCE_INVALID_INPUT)，但没有抛错')
  }

  it('坏 yaml → 抛 FILE_ENHANCE_INVALID_INPUT 且 .dsh 未创建', () => {
    const ws = makeWorkspace()
    const svc = createFileEnhanceService({ workspaceRoot: ws })

    expectInvalid(() => svc.provision(ws, { rules: [{ ext: 'ts', yaml: 'a: [unclosed\n' }] }))

    expect(existsSync(join(ws, '.dsh'))).toBe(false)
  })

  it('非法 ext → 抛错且零落盘', () => {
    const ws = makeWorkspace()
    const svc = createFileEnhanceService({ workspaceRoot: ws })

    for (const ext of ['MD', 'x.y', '', 'm d']) {
      expectInvalid(() => svc.provision(ws, { rules: [{ ext, yaml: 'type: x\nroot: docs\ncategories: {}\n' }] }))
    }
    expect(existsSync(join(ws, '.dsh'))).toBe(false)
  })

  it('非法 name → 抛错且零落盘', () => {
    const ws = makeWorkspace()
    const svc = createFileEnhanceService({ workspaceRoot: ws })

    for (const name of ['Bad Name', '-x', '', 'A']) {
      expectInvalid(() => svc.provision(ws, { formats: [{ name, spec: 'match: ["*.md"]\n' }] }))
    }
    expect(existsSync(join(ws, '.dsh'))).toBe(false)
  })

  it('先校验全部：一条合法 + 一条非法 → 合法的那条也不落盘', () => {
    const ws = makeWorkspace()
    const svc = createFileEnhanceService({ workspaceRoot: ws })

    expectInvalid(() => svc.provision(ws, {
      rules: [{ ext: 'ts', yaml: 'type: ts\nroot: docs\ncategories: {}\n' }],
      formats: [{ name: 'Bad Name', spec: 'match: ["*.md"]\n' }],
    }))

    expect(existsSync(join(ws, '.dsh'))).toBe(false)
  })

  it('目标目录已存在时，非法输入不新增任何文件', () => {
    const ws = makeWorkspace()
    const svc = createFileEnhanceService({ workspaceRoot: ws })
    svc.provision(ws, { rules: [{ ext: 'ts', yaml: 'type: ts\nroot: docs\ncategories: {}\n' }] })
    const before = snapshot(join(ws, '.dsh'))

    expectInvalid(() => svc.provision(ws, {
      rules: [{ ext: 'js', yaml: 'type: js\nroot: docs\ncategories: {}\n' }, { ext: 'BAD', yaml: 'root: x\n' }],
    }))

    expect(snapshot(join(ws, '.dsh'))).toBe(before)
  })
})

describe('插件接线：ctx.provide', () => {
  it('apply 后提供 fileEnhance 服务，能力可用', () => {
    const ws = makeWorkspace()
    const provided = new Map<string, unknown>()
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
      provide: (name: string, value: unknown) => { provided.set(name, value) },
    }

    apply(ctx as unknown as Context)

    const svc = provided.get('fileEnhance') as FileEnhanceService | undefined
    expect(svc).toBeDefined()
    expect(typeof svc!.ensure).toBe('function')
    expect(typeof svc!.status).toBe('function')
    expect(typeof svc!.provision).toBe('function')
    expect(listeners.has('tools/pre-execute')).toBe(true)

    const r = svc!.ensure(ws)
    expect(r.rules.types).toContain('md')
    expect(r.formats.types.length).toBeGreaterThan(0)
  })

  it('ctx 没有 provide 时 apply 不报错（旧宿主兼容）', () => {
    const ctx = {
      logger: () => ({}),
      inject: (services: string[], cb: (value: Record<string, unknown>) => void) => {
        cb(services[0] === 'tools' ? { on: () => undefined } : {})
      },
    }
    expect(() => apply(ctx as unknown as Context)).not.toThrow()
  })
})
