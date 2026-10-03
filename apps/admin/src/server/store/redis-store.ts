import 'server-only'
import { Redis } from 'ioredis'
import { serverEnv } from '@/server/env'
import { SessionStoreUnavailable, type SessionStore } from './types'

/**
 * Valkey/Redis-backed store, one shared connection per server process (cached on globalThis so dev hot reload does
 * not leak connections). Fail-closed by construction: no offline queue, bounded connect/command timeouts and a single
 * retry per request, so an unavailable store surfaces as `SessionStoreUnavailable` quickly instead of hanging.
 * `rediss://` URLs use TLS.
 */
export function createRedisStore(url: string): SessionStore & { quit(): Promise<void> } {
  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => (attempt > 3 ? null : Math.min(attempt * 200, 1_000)),
  })
  client.on('error', () => {
    // Connection errors are surfaced per operation as SessionStoreUnavailable; never log the URL (credentials).
  })

  async function run<T>(op: () => Promise<T>): Promise<T> {
    try {
      if (client.status === 'wait' || client.status === 'end') await client.connect()
      return await op()
    } catch {
      throw new SessionStoreUnavailable()
    }
  }

  return {
    get: (key) => run(() => client.get(key)),
    set: async (key, value, expiresAtMs) => {
      // Relative TTL computed here, so expiry does not depend on the store's clock agreeing with ours.
      const ttlMs = Math.floor(expiresAtMs - Date.now())
      if (ttlMs <= 0) {
        await run(() => client.del(key))
        return
      }
      await run(() => client.set(key, value, 'PX', ttlMs))
    },
    take: (key) => run(() => client.getdel(key)),
    delete: async (key) => {
      await run(() => client.del(key))
    },
    quit: async () => {
      if (client.status !== 'end' && client.status !== 'wait') await client.quit()
    },
  }
}

const globalStore = globalThis as unknown as {
  __tazzzoCmsStore?: ReturnType<typeof createRedisStore>
}

export function sessionStore(): SessionStore {
  globalStore.__tazzzoCmsStore ??= createRedisStore(serverEnv().SESSION_STORE_URL)
  return globalStore.__tazzzoCmsStore
}
