import 'server-only'

/**
 * Minimal key-value contract for the login-transaction and session records. Production uses Valkey/Redis
 * (`redis-store.ts`); unit tests use an in-memory implementation that lives in tests/ only, so production code has
 * no in-memory fallback to drift into.
 */
export interface SessionStore {
  get(key: string): Promise<string | null>
  /** Creates or replaces `value` until the absolute epoch-millisecond `expiresAtMs` (session creation, transactions). */
  set(key: string, value: string, expiresAtMs: number): Promise<void>
  /**
   * Replaces `value` ONLY if `key` still exists (atomic; never creates). Returns false when the key is gone, e.g.
   * deleted by a concurrent logout, backend 401 or expiry: the caller must then treat the session as revoked.
   */
  touch(key: string, value: string, expiresAtMs: number): Promise<boolean>
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
