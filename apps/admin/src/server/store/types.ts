import 'server-only'

/**
 * Minimal key-value contract for the login-transaction and session records. Production uses Valkey/Redis
 * (`redis-store.ts`); unit tests use an in-memory implementation that lives in tests/ only, so production code has
 * no in-memory fallback to drift into.
 */
export interface SessionStore {
  get(key: string): Promise<string | null>
  /** Stores `value` until the absolute epoch-millisecond `expiresAtMs`. */
  set(key: string, value: string, expiresAtMs: number): Promise<void>
  /** Atomically reads and deletes (single-use records). */
  take(key: string): Promise<string | null>
  delete(key: string): Promise<void>
}

/** Any store failure. Callers fail closed (no session, no login) and never fall back to another store. */
export class SessionStoreUnavailable extends Error {
  constructor() {
    super('session store unavailable')
    this.name = 'SessionStoreUnavailable'
  }
}
