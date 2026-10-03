import { randomBytes } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '@/server/store/types'
import { startHarness, stopHarness, type Harness } from '../support/integration-env'
import { fakeIdToken } from '../support/fake-id-token'

/**
 * LOW-1 regression, on real Valkey: a request that read a session before it was deleted (logout, backend 401,
 * expiry) must neither re-create the key when it refreshes `lastSeenAt` nor be authenticated from its stale copy.
 */
let h: Harness
let redis: Redis
let store: SessionStore & { quit(): Promise<void> }
let session: typeof import('@/server/session/session')
let access: typeof import('@/server/session/admin-access')
const config = { keys: { current: randomBytes(32) }, maxSeconds: 28_800, idleSeconds: 1_800 }

beforeAll(async () => {
  h = await startHarness()
  redis = new Redis(h.redisUrl)
  const { createRedisStore } = await import('@/server/store/redis-store')
  store = createRedisStore(h.redisUrl)
  session = await import('@/server/session/session')
  access = await import('@/server/session/admin-access')
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterAll(async () => {
  await store?.quit()
  await redis?.quit()
  await stopHarness(h)
})

beforeEach(async () => {
  await redis.flushall()
  h.backend.status = 200
})

/** A store whose next read of `key` runs `between` after reading and before returning: the concurrent request. */
function pausingAfterRead(between: () => Promise<void>): SessionStore {
  let armed = true
  return {
    get: async (key) => {
      const value = await store.get(key)
      if (armed) {
        armed = false
        await between()
      }
      return value
    },
    set: (...args) => store.set(...args),
    touch: (...args) => store.touch(...args),
    take: (key) => store.take(key),
    delete: (key) => store.delete(key),
  }
}

async function freshSession(now: number) {
  const created = await session.createSession(
    store,
    fakeIdToken(),
    Math.floor(now / 1000) + 3600,
    config,
    now,
  )
  return created!.sessionId
}

const sessionKeys = () => redis.keys('cms:sess:*')

describe('conditional touch on real Valkey', () => {
  it('updates an existing key, keeps its TTL within the original expiry, and never creates a missing one', async () => {
    const expiresAt = Date.now() + 120_000
    await store.set('cms:sess:probe', 'v1', expiresAt)
    expect(await store.touch('cms:sess:probe', 'v2', expiresAt)).toBe(true)
    expect(await redis.get('cms:sess:probe')).toBe('v2')
    expect(await redis.pttl('cms:sess:probe')).toBeLessThanOrEqual(120_000)

    expect(await store.touch('cms:sess:missing', 'v', expiresAt)).toBe(false)
    expect(await redis.exists('cms:sess:missing')).toBe(0)
  })

  it('sends SET ... PX <ttl> XX on the wire (atomic, server-side existence check)', async () => {
    const monitor = await redis.monitor()
    const commands: string[][] = []
    monitor.on('monitor', (_time: string, args: string[]) => commands.push(args))
    await store.touch('cms:sess:wire', 'v', Date.now() + 60_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    monitor.disconnect()
    const touch = commands.find((c) => c[0]?.toLowerCase() === 'set' && c[1] === 'cms:sess:wire')
    expect(touch?.map((a) => a.toUpperCase())).toEqual([
      'SET',
      'CMS:SESS:WIRE',
      'V',
      'PX',
      expect.any(String),
      'XX',
    ])
  })

  it('session creation still creates a new key', async () => {
    await freshSession(Date.now())
    expect(await sessionKeys()).toHaveLength(1)
  })
})

describe('LOW-1: no resurrection, stale request fails closed', () => {
  it('touch-vs-logout: the deleted session stays deleted and the stale request is not authenticated', async () => {
    const createdAt = Date.now()
    const id = await freshSession(createdAt)
    const now = createdAt + session.TOUCH_INTERVAL_MS + 1
    expect(await sessionKeys()).toHaveLength(1)

    const racing = pausingAfterRead(() => session.endSession(store, id))
    const result = await session.checkSession(racing, id, config, now)

    expect(result.status).toBe('invalid')
    expect(await sessionKeys()).toEqual([])
    expect((await session.checkSession(store, id, config, now)).status).toBe('invalid')
  })

  it('touch-vs-backend-401: a session ended by another request is not revived by a stale refresh', async () => {
    const createdAt = Date.now()
    const id = await freshSession(createdAt)
    const now = createdAt + session.TOUCH_INTERVAL_MS + 1
    const deps = { store, config, backendUrl: h.backend.url }

    const racing = pausingAfterRead(async () => {
      h.backend.status = 401
      expect(await access.resolveAdminAccess(deps, id, now)).toEqual({
        action: 'redirect',
        to: '/api/auth/expired',
      })
      h.backend.status = 200
    })
    const stale = await access.resolveAdminAccess({ ...deps, store: racing }, id, now)

    expect(stale).toEqual({ action: 'redirect', to: '/api/auth/expired' })
    expect(await sessionKeys()).toEqual([])
  })

  it('a refresh never extends the absolute expiry', async () => {
    const createdAt = Date.now()
    const id = await freshSession(createdAt)
    const [key] = await sessionKeys()
    const before = JSON.parse((await redis.get(key!))!).expiresAt as number
    const result = await session.checkSession(
      store,
      id,
      config,
      createdAt + session.TOUCH_INTERVAL_MS + 1,
    )
    expect(result.status).toBe('valid')
    const record = JSON.parse((await redis.get(key!))!) as { expiresAt: number; lastSeenAt: number }
    expect(record.expiresAt).toBe(before)
    expect(record.lastSeenAt).toBe(createdAt + session.TOUCH_INTERVAL_MS + 1)
    expect(Date.now() + (await redis.pttl(key!))).toBeLessThanOrEqual(before + 50)
  })
})
