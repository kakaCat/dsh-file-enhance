/**
 * 性能基线——兑现设计文档 NFR-1：「单次校验 P95 ≤ 50ms（1000 行文档）」。
 *
 * 用随包最重的一份规范（prd：19 节 + 11 张表 + 3 个 script 函数）跑真实文档，
 * 预热一次后取 30 次采样的 P95。断言给了余量：CI 机器比开发机慢，卡死 50ms 会变成 flaky；
 * 真正的读数在失败信息里（`p95=… min=…`），回归时看它涨没涨。
 * @module dsh-file-enhance/tests/perf
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSpecDir } from '../src/content-format/spec.js'
import { validateDocument } from '../src/content-format/validate.js'

const specsDir = new URL('../examples/file-format-specs', import.meta.url).pathname
const prd = readSpecDir(specsDir).find((s) => s.name === 'prd')!

/** 拿 prd 模板当底，往「附录」里塞到 1000 行以上。 */
function thousandLineDoc(): string {
  const template = readFileSync(join(prd.dir, prd.template!), 'utf8')
  const padding = Array.from({ length: 900 }, (_, i) => `- 附注 ${i + 1}：这一行用来把文档撑到 1000 行以上。`).join('\n')
  return template.replace(/^## 附录\s*$/m, `## 附录\n\n${padding}`)
}

describe('性能基线（NFR-1：1000 行文档单次校验 P95 ≤ 50ms）', () => {
  it('prd 规范 × 1000 行文档：P95 在预算内', () => {
    const template = readFileSync(join(prd.dir, prd.template!), 'utf8')
    const doc = thousandLineDoc()
    expect(doc.split('\n').length).toBeGreaterThan(900)

    // 预热一次：别把首轮模块编译 / vm 上下文创建算进基线
    validateDocument(prd, doc, null, template, { fileName: 'prd.md', relPath: 'docs/prd.md' })

    const samples: number[] = []
    for (let i = 0; i < 30; i++) {
      const start = performance.now()
      validateDocument(prd, doc, null, template, { fileName: 'prd.md', relPath: 'docs/prd.md' })
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? 0
    const min = samples[0] ?? 0
    const max = samples[samples.length - 1] ?? 0
    // 基线读数打到 stdout：CI 上跑一次就知道这台机器的水位，回归时对比这一行。
    console.log(`[perf] prd × ${doc.split('\n').length} 行：min=${min.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`)

    expect(p95, `p95=${p95.toFixed(1)}ms min=${min.toFixed(1)}ms max=${max.toFixed(1)}ms`).toBeLessThan(50)
  })
})
