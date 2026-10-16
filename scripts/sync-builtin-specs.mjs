#!/usr/bin/env node
/**
 * 把 examples/file-format-specs/ 同步生成进 src/content-format/builtin-specs.ts——
 * 内置默认文档规范的**唯一数据源**是 examples/ 目录（人工维护），本脚本只做机械打包：
 * 插件运行时从打包产物加载，不依赖文件系统里的 examples/ 布局（宿主可能只 ship dist/）。
 *
 * 用法：pnpm sync:specs（pnpm build 的 prebuild 会自动跑）。
 * test/scaffold-specs.test.ts 有逐字节守护：改了 examples/ 没同步，测试会红。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'examples/file-format-specs')
const out = join(root, 'src/content-format/builtin-specs.ts')

const SPEC = 'spec.yaml'
const TEMPLATE = 'template.md'
const EXAMPLE = 'example.md'

const types = existsSync(src)
  ? readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort()
  : []

if (types.length === 0) {
  console.error('sync-builtin-specs: 没有找到任何类型目录（' + src + '）')
  process.exit(1)
}

const data = {}
for (const t of types) {
  const dir = join(src, t)
  const specPath = join(dir, SPEC)
  if (!existsSync(specPath)) {
    console.error(`sync-builtin-specs: ${t}/ 缺 ${SPEC}，已中止`)
    process.exit(1)
  }
  const templatePath = join(dir, TEMPLATE)
  const examplePath = join(dir, EXAMPLE)
  data[t] = {
    spec: readFileSync(specPath, 'utf8'),
    ...(existsSync(templatePath) ? { template: readFileSync(templatePath, 'utf8') } : {}),
    ...(existsSync(examplePath) ? { example: readFileSync(examplePath, 'utf8') } : {}),
  }
}

const header = [
  '/**',
  ' * GENERATED FILE——由 scripts/sync-builtin-specs.mjs 生成，请勿手改。',
  ' * 数据源：examples/file-format-specs/（改完跑 `pnpm sync:specs` 或 `pnpm build`）。',
  ' * 测试守护：test/scaffold-specs.test.ts 会比较本模块与 examples/ 逐字节一致。',
  ' */',
].join('\n')

writeFileSync(out, header + '\nexport const BUILTIN_SPECS: Record<string, { spec: string; template?: string; example?: string }> = '
  + JSON.stringify(data, null, 2) + '\n', 'utf8')
console.log(`sync-builtin-specs: ${types.length} 个类型 → ${out}（${types.join(', ')}）`)
