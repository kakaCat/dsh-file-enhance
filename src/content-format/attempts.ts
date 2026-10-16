/**
 * 内容校验尝试计数——按 agent + 目标路径独立记，不复用路径判定的 free-play 豁免。
 * @module dsh-file-enhance/content-format/attempts
 */
interface Entry { count: number; at: number; hash: string }

export class AttemptStore {
  private readonly map = new Map<string, Entry>()
  private readonly ttlMs: number

  constructor(ttlMs = 30 * 60 * 1000) {
    this.ttlMs = ttlMs
  }

  private live(key: string): Entry | undefined {
    const e = this.map.get(key)
    if (e === undefined) return undefined
    if (Date.now() - e.at > this.ttlMs) { this.map.delete(key); return undefined }
    return e
  }

  count(key: string): number {
    return this.live(key)?.count ?? 0
  }

  /** 记录一次失败；sameContent 表示与上次被拒内容一致（用于「内容未变」提示）。 */
  bump(key: string, hash: string): { attempts: number; sameContent: boolean } {
    const prev = this.live(key)
    const sameContent = prev !== undefined && prev.hash === hash
    const count = (prev?.count ?? 0) + 1
    this.map.set(key, { count, at: Date.now(), hash })
    return { attempts: count, sameContent }
  }

  reset(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }
}
