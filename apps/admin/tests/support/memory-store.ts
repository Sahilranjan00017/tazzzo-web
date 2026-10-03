import type { SessionStore } from '@/server/store/types'

/** Unit-test-only store honouring absolute expiry against an injectable clock. Never used by production code. */
export class MemoryStore implements SessionStore {
  readonly data = new Map<string, { value: string; expiresAtMs: number }>()
  constructor(private readonly clock: () => number = Date.now) {}

  private live(key: string) {
    const entry = this.data.get(key)
    if (entry && entry.expiresAtMs <= this.clock()) {
      this.data.delete(key)
      return undefined
    }
    return entry
  }
  async get(key: string) {
    return this.live(key)?.value ?? null
  }
  async set(key: string, value: string, expiresAtMs: number) {
    this.data.set(key, { value, expiresAtMs })
  }
  async take(key: string) {
    const value = this.live(key)?.value ?? null
    this.data.delete(key)
    return value
  }
  async delete(key: string) {
    this.data.delete(key)
  }
}
