/** Minimal stand-in for Next's `cookies()` store that also remembers the attributes each cookie was set with. */
export interface SetCookie {
  value: string
  options: Record<string, unknown>
}

export class CookieJar {
  readonly set_ = new Map<string, SetCookie>()

  get(name: string): { name: string; value: string } | undefined {
    const entry = this.set_.get(name)
    return entry && entry.value !== '' ? { name, value: entry.value } : undefined
  }

  set(name: string, value: string, options: Record<string, unknown> = {}): void {
    this.set_.set(name, { value, options })
  }

  clear(): void {
    this.set_.clear()
  }
}
