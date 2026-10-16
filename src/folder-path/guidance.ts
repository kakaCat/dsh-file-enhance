/**
 * 指引单渲染——拦截时交给 agent 的「该怎么建」说明书。
 *
 * 这是本插件唯一的**规范注入通道**：规范不常驻 system prompt，
 * 只在创建被拦下的那一刻，随工具结果进入对话。
 *
 * @module dsh-file-enhance/folder-path/guidance
 */
import type { DenyVerdict, RuleSet, Tree } from './types.js'

function renderTree(tree: Tree | undefined, rootLabel: string): string[] {
  if (tree === undefined || tree.exists !== true) return [`  （${rootLabel}/ 尚不存在——你的这次创建会顺势把它建出来）`]
  if (tree.empty === true) return [`  （${rootLabel}/ 是空目录）`]
  const lines: string[] = []
  for (const d of tree.dirs) {
    const samples = d.samples.length > 0 ? `，如 ${d.samples.join('、')}` : ''
    lines.push(`  - ${rootLabel}/${d.name}/  （${d.fileCount} 个文件${samples}）`)
  }
  if (tree.files.length > 0) {
    lines.push(`  - ${rootLabel}/ 直接放着：${tree.files.slice(0, 8).join('、')}`)
  }
  return lines
}

function renderMenu(rules: RuleSet | undefined): string[] {
  if (rules === undefined) return []
  const lines: string[] = []
  for (const cat of Object.values(rules.categories)) {
    const kw = cat.keywords.length > 0 ? `｜关键词：${cat.keywords.join('/')}` : ''
    if (cat.kind === 'collection') {
      const variants = Object.values(cat.variants ?? {})
        .map((v) => `      · ${v.key} → ${v.dest ?? '(缺 dest)'}`)
        .join('\n')
      lines.push(`  - ${cat.key} → ${rules.root}/${cat.folder}/（集合型）${kw}\n${variants}`)
    } else {
      lines.push(`  - ${cat.key} → ${rules.root}/${cat.dest ?? `${cat.folder}/{slug}.${rules.ext}`}${kw}`)
    }
  }
  return lines
}

const HEADLINE: Record<string, string> = {
  'root-forbidden': '根目录不允许新建该类文件',
  'outside-root': '该类文件必须放在规范目录里',
  'unclassified': '这个文件没有分类，直接放在主目录下不合规',
  'unknown-category': '目标文件夹既不是已登记的规范分类，也不存在于主目录',
  'unknown-variant': '集合型实例下没有登记这个文件分类',
  'need-allocate': '集合型分类需要先拿到实例编号（文件夹），再放文件',
  'bad-instance': '实例编号格式不符合规范',
  'naming': '文件名不符合命名规范',
  'rules-invalid': '项目的规则文件非法，无法判定',
}

export interface GuidanceOptions {
  /** 已算好的规范落点（方案 B：让 agent 用这个路径重试 write）。 */
  suggestedPath?: string
  /** 该落点的判据来源。 */
  source?: 'reality' | 'rules'
}

/** 渲染一份指引单（纯字符串，无 I/O）。 */
export function renderGuidance(v: DenyVerdict, opts: GuidanceOptions = {}): string {
  const rules = v.rules
  const rootLabel = rules?.root ?? 'docs'
  const suggested = opts.suggestedPath
  const out: string[] = []
  out.push(`⛔ 文件未创建：${v.target ?? '(未提供)'}`)
  out.push('')
  out.push(`【拦截原因】${HEADLINE[v.code] ?? v.code}`)

  if (suggested !== undefined) {
    out.push('')
    out.push(`【正确路径】${suggested}`)
    out.push(`  （判据：${opts.source === 'reality' ? '现有目录习惯' : opts.source === 'rules' ? '项目规范' : '项目规则'}）`)
    out.push('【请重试】用这个路径再调一次 write，内容原样即可：')
    out.push(`  write({ file_path: "${suggested}", content: <你刚才的内容> })`)
  }

  switch (v.code) {
    case 'root-forbidden':
      out.push(`  根目录只允许固定文件（README.md / CHANGELOG.md / CLAUDE.md / AGENTS.md …）。`)
      out.push(`  这是一份普通文档，请按下面的分类落盘；确属项目级固定文件，请让用户在 .dsh/folder-path-rules/${rules?.ext ?? 'md'}.yaml 的 root_allow 里登记。`)
      break
    case 'outside-root':
      out.push(`  ${rules?.ext ?? 'md'} 文件的规范主目录是 ${rootLabel}/。放到别处（根目录除外）第二次尝试会被放行，但不推荐。`)
      break
    case 'unclassified':
      out.push(`  它直接落在 ${rootLabel}/ 下。请选择下面的分类目录，或按关键字匹配到规范分类。`)
      break
    case 'unknown-category':
      out.push(`  ${rootLabel}/${v.folder ?? '?'}/ 不在规则里，主目录下也没有这个文件夹。`)
      break
    case 'unknown-variant': {
      const variants = Object.keys(v.category?.variants ?? {}).join('、') || '(未声明)'
      out.push(`  ${v.folder ?? '?'} 不是集合 ${v.category?.key ?? '?'} 已登记的变体；可用变体：${variants}。`)
      break
    }
    case 'need-allocate':
      out.push(`  先创建实例文件夹（编号格式 ${v.category?.instance?.pattern ?? '(未声明 pattern)'}${
        (v.category?.instance?.scaffold ?? []).length > 0 ? `，内含 ${(v.category?.instance?.scaffold ?? []).join('、')}` : ''
      }），再把文件写进去；编号规则见 .dsh/folder-path-rules/${rules?.ext ?? 'md'}.yaml 的该分类 instance 段。`)
      break
    case 'bad-instance':
      out.push(`  编号 ${v.instanceName ?? '?'} 不符合 ${v.category?.instance?.pattern ?? '(未声明 pattern)'}。`)
      out.push(`  按该 pattern 自行决定编号后，先建出实例文件夹再写入；命名口径见 yaml 的 instance.pattern。`)
      break
    case 'naming':
      out.push(`  「${v.stem ?? '?'}」不符合 ${v.naming ?? 'kebab-case'}；例如 login-design（全小写、连字符分隔）。`)
      break
    case 'rules-invalid':
      out.push(`  规则文件：${v.rulesPath ?? '(未知)'}`)
      out.push(`  错误：${v.detail ?? '(未提供)'}`)
      out.push(`  请修复 yaml 后重试；修好前这类文件不做拦截（第二次尝试放行）。`)
      break
    default:
      break
  }

  const treeLines = renderTree(v.tree, rootLabel)
  if (treeLines.length > 0) {
    out.push('')
    out.push(`【${rootLabel}/ 现状】`)
    out.push(...treeLines)
  }
  const menuLines = renderMenu(rules)
  if (menuLines.length > 0) {
    out.push('')
    out.push('【可用分类】')
    out.push(...menuLines)
  }
  out.push('')
  out.push('【下一步】')
  if (suggested !== undefined) {
    out.push('  1) 直接按上面的【正确路径】重试 write（这是最省事的一条路）')
    out.push('  2) 想换别的分类 → 从「可用分类」里挑一个，按其 dest 拼路径重试 write')
    out.push(`  3) 确认分类都不合适 → 先用 ask_user_question 问用户，同意后把新分类写进 .dsh/folder-path-rules/${rules?.ext ?? 'md'}.yaml（改完即生效，无需重启）`)
  } else if (v.code === 'root-forbidden') {
    // 根目录硬拦永不豁免：重复尝试不会放行，别给「再次即放行」的错觉。
    out.push('  1) 从「可用分类」里挑一个，按其 dest 拼路径重试 write')
    out.push(`  2) 都不合适 → 先用 ask_user_question 问用户，同意后把新分类写进 .dsh/folder-path-rules/${rules?.ext ?? 'md'}.yaml`)
    out.push(`  3) 确属项目级固定文件 → 让用户在 .dsh/folder-path-rules/${rules?.ext ?? 'md'}.yaml 的 root_allow 里登记（根目录硬拦，重复尝试不会放行）`)
  } else {
    out.push('  1) 从「可用分类」里挑一个，按其 dest 拼路径重试 write')
    out.push(`  2) 都不合适 → 先用 ask_user_question 问用户，同意后把新分类写进 .dsh/folder-path-rules/${rules?.ext ?? 'md'}.yaml，再按新分类重试`)
    out.push('  3) 确认无分类可用且用户同意 → 再次 write 同一路径即放行（自由发挥）')
  }
  return out.join('\n')
}

/** 自动纠偏后的回执（原调用被拒、内容已按规范落盘）。 */
export function renderCorrection(v: { to: string; from?: string; source: 'reality' | 'rules'; category?: { key?: string } }): string {
  return [
    '路径不合规，本次 write 未执行。',
    `该文件已按项目规范写入：${v.to}`,
    `  · 你请求的路径：${v.from ?? '(未提供)'}（未分类，已自动归位）`,
    `  · 判据来源：${v.source === 'reality' ? '现有目录习惯' : '项目规范'}${v.category?.key !== undefined ? `｜分类：${v.category.key}` : ''}`,
    `  · 不要再用原路径重试；后续同类文件请直接使用 ${v.to}`,
  ].join('\n')
}
