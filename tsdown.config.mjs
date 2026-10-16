import { defineConfig } from 'tsdown'

// Host-half build：已发布的 DSH 插件从编译产物加载，故 ship dist/index.mjs 而非 TS 源。
// .mjs 配置（非 .ts）：tsdown 的 TS 配置加载在部分 Node 版本上有已知问题，.mjs 到处都能原生加载。
//
// ★ 宿主包必须 external：内联 @deepseek-ai/dsh-tools 会打进第二份模块级调度 Symbol，
//   运行时工具派发直接坏掉（照抄 dsh-pmboard 的踩坑结论）。
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  dts: true,
  deps: { neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'] },
  target: 'node20',
  minify: false,
})
