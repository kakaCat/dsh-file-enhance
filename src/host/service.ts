/**
 * Host 服务——按 profile **预置 / 读取 / 写入**文件规范。
 *
 * 定位：插件对 agent 的加强发生在「写文件被拦下」的那一刻；但上层（如 pm）需要
 * 在**动手之前**先把项目规范准备好（按 category 主动 ensure / provision），
 * 而不是只能靠触拦截器来触发冷启动垫片。
 *
 * 本模块只做三件事：把既有的 `RulesStore` / `FormatStore` 垫片能力包成可调用服务、
 * 读出当前有哪些规范、按输入原子地写入指定 profile 的文件。
 * **判定链与规则语义全部复用既有实现**——这里不复制任何 decide / validate 逻辑。
 *
 * 写盘纪律：
 *   - 已存在的文件一律不覆写（wx + 目录级预检 → skipped）；
 *   - `provision` 先校验**全部**输入再落盘，非法输入抛 `FileEnhanceError`
 *     （code=`FILE_ENHANCE_INVALID_INPUT`），一个字节都不写。
 *
 * @module dsh-file-enhance/host/service
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { RulesStore } from '../folder-path/rules.js'
import {
  FormatStore,
  SPEC_FILE,
  SPEC_FILE_ALT,
  TEMPLATE_FILE,
  EXAMPLE_FILE,
  typeDirs,
} from '../content-format/spec.js'

/** 输入非法（profile 里的 ext / name / yaml / spec 不合法）；此时零落盘。 */
export const FILE_ENHANCE_INVALID_INPUT = 'FILE_ENHANCE_INVALID_INPUT'
/** 写盘 IO 失败（非「已存在」——已存在按 skipped 语义处理）。 */
export const FILE_ENHANCE_IO_ERROR = 'FILE_ENHANCE_IO_ERROR'

/** 带稳定错误码的服务层错误。 */
export class FileEnhanceError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'FileEnhanceError'
    this.code = code
  }
}

/** 一条路径规则：`<root>/.dsh/folder-path-rules/<ext>.yaml` 的内容。 */
export interface RuleProvision {
  /** 扩展名键（文件名去点），如 `md`。 */
  ext: string
  /** 规则 YAML 全文（必须能被 js-yaml 解析）。 */
  yaml: string
}

/** 一套文档规范：`<root>/.dsh/file-format-specs/<name>/` 下的三个文件。 */
export interface FormatProvision {
  /** 类型目录名，如 `prd`。 */
  name: string
  /** spec.yaml 全文（非空）。 */
  spec: string
  /** template.md（可选）。 */
  template?: string
  /** example.md（可选）。 */
  example?: string
}

/** 一次预置要写入的规范清单；rules / formats 均可省略。 */
export interface FileEnhanceProfile {
  rules?: ReadonlyArray<RuleProvision>
  formats?: ReadonlyArray<FormatProvision>
}

/** `ensure` 的单个子系统结果。 */
export interface EnsurePart {
  dir: string
  types: string[]
  /** 本次是否真的写出了默认文件（幂等：第二次为 false）。 */
  created: boolean
}

export interface EnsureResult {
  rules: EnsurePart
  formats: EnsurePart
}

/** `status` 的单个子系统结果（只读）。 */
export interface StatusPart {
  dir: string
  types: string[]
}

export interface StatusResult {
  rules: StatusPart
  formats: StatusPart
}

export interface ProvisionResult {
  /** 本次新写入的条目，形如 `rule:md` / `format:prd`。 */
  created: string[]
  /** 因目标已存在而跳过的条目（不覆写）。 */
  skipped: string[]
}

/** Host 服务面：`ctx.provide('fileEnhance', service)` 提供的能力。 */
export interface FileEnhanceService {
  /** 预置默认规范（幂等；已有文件不覆写）。 */
  ensure(root: string): EnsureResult
  /** 读取当前规范清单（只读，不写盘）。 */
  status(root: string): StatusResult
  /** 按 profile 写入指定规范（原子校验；已存在跳过）。 */
  provision(root: string, profile: FileEnhanceProfile): ProvisionResult
}

export interface FileEnhanceServiceOptions {
  /** 未显式给 root 时的回落工作区根（与插件入口的 process.cwd() 口径一致）。 */
  workspaceRoot?: string
}

const EXT_RE = /^[a-z0-9]+$/
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

const errMsg = (err: unknown): string => String((err as Error)?.message ?? err)

/** 抛输入非法错误（provision 的校验阶段专用）。 */
function invalid(message: string): never {
  throw new FileEnhanceError(FILE_ENHANCE_INVALID_INPUT, message)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

/** 校验一条 rule profile（只做输入合法性，不做规则语义）。 */
function validateRule(rule: unknown, index: number): asserts rule is RuleProvision {
  if (rule === null || typeof rule !== 'object') invalid(`rules[${index}] 必须是对象`)
  const r = rule as Partial<RuleProvision>
  if (typeof r.ext !== 'string' || !EXT_RE.test(r.ext)) {
    invalid(`rules[${index}].ext 必须匹配 /^[a-z0-9]+$/（如 md），收到 ${JSON.stringify(r.ext)}`)
  }
  if (!isNonEmptyString(r.yaml)) invalid(`rules[${index}].yaml 必须是非空字符串`)
  try {
    yaml.load(r.yaml)
  } catch (err) {
    invalid(`rules[${index}].yaml 不是合法 YAML——${errMsg(err)}`)
  }
}

/** 校验一条 format profile（只做输入合法性，不做规范语义）。 */
function validateFormat(format: unknown, index: number): asserts format is FormatProvision {
  if (format === null || typeof format !== 'object') invalid(`formats[${index}] 必须是对象`)
  const f = format as Partial<FormatProvision>
  if (typeof f.name !== 'string' || !NAME_RE.test(f.name)) {
    invalid(`formats[${index}].name 必须匹配 /^[a-z0-9][a-z0-9_-]*$/（如 prd），收到 ${JSON.stringify(f.name)}`)
  }
  if (!isNonEmptyString(f.spec)) invalid(`formats[${index}].spec 必须是非空字符串`)
  if (f.template !== undefined && typeof f.template !== 'string') invalid(`formats[${index}].template 必须是字符串`)
  if (f.example !== undefined && typeof f.example !== 'string') invalid(`formats[${index}].example 必须是字符串`)
}

/** 写一个新文件：已存在 → false（skipped），其它 IO 失败 → 抛服务层错误。 */
function writeOnce(path: string, content: string): boolean {
  try {
    writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') return false
    throw new FileEnhanceError(FILE_ENHANCE_IO_ERROR, `写入 ${path} 失败——${errMsg(err)}`)
  }
}

/** 目录下含 spec.yaml（或 spec.yml）的类型目录名。 */
function formatTypesIn(dir: string): string[] {
  return typeDirs(dir).filter((name) => {
    const d = join(dir, name)
    return existsSync(join(d, SPEC_FILE)) || existsSync(join(d, SPEC_FILE_ALT))
  })
}

/** 目录下是否已有规范文件（同时认 spec.yml，避免重复建两套）。 */
function specExistsIn(dir: string): boolean {
  return existsSync(join(dir, SPEC_FILE)) || existsSync(join(dir, SPEC_FILE_ALT))
}

/**
 * 创建 Host 服务。所有方法都按调用时传入的 `root` 解析工作区
 * （桌面宿主的 process.cwd() 是 profile 目录，不能当工作区用）。
 */
export function createFileEnhanceService(opts: FileEnhanceServiceOptions = {}): FileEnhanceService {
  const fallbackRoot = opts.workspaceRoot ?? process.cwd()

  const baseOf = (root: string | undefined): string => resolve(root === undefined || root === '' ? fallbackRoot : root)

  return {
    ensure(root: string): EnsureResult {
      const base = baseOf(root)
      // 两个 store 都只用来复用既有垫片；判定/校验语义不在这里复刻。
      const rulesStore = new RulesStore({ workspaceRoot: base })
      const formatStore = new FormatStore({ workspaceRoot: base })

      const rulesScaffolded = rulesStore.scaffoldDefault('md', base)
      const rulesDir = rulesStore.dirOf(base)

      const formatsScaffolded = formatStore.scaffoldDefaults(base)
      const formatsDir = formatsScaffolded.dir

      return {
        rules: {
          dir: rulesDir,
          types: rulesStore.types(base),
          created: rulesScaffolded.created,
        },
        formats: {
          // scaffoldDefaults 只在首次返回 types（已存在时回空），类型清单按目录现读。
          dir: formatsDir,
          types: formatTypesIn(formatsDir),
          created: formatsScaffolded.created,
        },
      }
    },

    status(root: string): StatusResult {
      const base = baseOf(root)
      const rulesStore = new RulesStore({ workspaceRoot: base })
      const formatStore = new FormatStore({ workspaceRoot: base })
      const formatsDir = formatStore.dirOf(base)
      // 只读：不调用 FormatStore.all()（它会触发冷启动垫片），也不碰 RulesStore.scaffoldDefault。
      return {
        rules: { dir: rulesStore.dirOf(base), types: rulesStore.types(base) },
        formats: { dir: formatsDir, types: formatTypesIn(formatsDir) },
      }
    },

    provision(root: string, profile: FileEnhanceProfile): ProvisionResult {
      const base = baseOf(root)
      const rules = profile.rules ?? []
      const formats = profile.formats ?? []

      // 第一遍：校验**全部**输入（rules + formats）。任何一条非法 → 抛错且尚未落盘一个字节。
      rules.forEach((rule, i) => validateRule(rule, i))
      formats.forEach((format, i) => validateFormat(format, i))

      const created: string[] = []
      const skipped: string[] = []

      // 第二遍：落盘。目标已存在 → skipped（绝不覆写）。
      const rulesDir = new RulesStore({ workspaceRoot: base }).dirOf(base)
      if (rules.length > 0) mkdirSync(rulesDir, { recursive: true })
      for (const rule of rules) {
        const entry = `rule:${rule.ext}`
        if (writeOnce(join(rulesDir, `${rule.ext}.yaml`), rule.yaml)) created.push(entry)
        else skipped.push(entry)
      }

      const formatsDir = new FormatStore({ workspaceRoot: base }).dirOf(base)
      for (const format of formats) {
        const entry = `format:${format.name}`
        const dir = join(formatsDir, format.name)
        if (specExistsIn(dir)) {
          skipped.push(entry)
          continue
        }
        mkdirSync(dir, { recursive: true })
        if (!writeOnce(join(dir, SPEC_FILE), format.spec)) {
          // 竞态：预检后被别人写了同一份 spec —— 仍按 skipped 处理，不覆写。
          skipped.push(entry)
          continue
        }
        if (format.template !== undefined) writeOnce(join(dir, TEMPLATE_FILE), format.template)
        if (format.example !== undefined) writeOnce(join(dir, EXAMPLE_FILE), format.example)
        created.push(entry)
      }

      return { created, skipped }
    },
  }
}
