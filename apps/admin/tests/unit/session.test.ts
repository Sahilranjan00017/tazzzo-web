import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashId, sessionKey, txKey } from '@/server/auth/ids'
import {
  consumeTransaction,
  createTransaction,
  TRANSACTION_TTL_SECONDS,
} from '@/server/auth/transaction'
import { decryptToken } from '@/server/crypto/token-cipher'
import {
  checkSession,
  createSession,
  endSession,
  ID_TOKEN_SAFETY_MARGIN_MS,
  TOUCH_INTERVAL_MS,
  type SessionConfig,
} from '@/server/session/session'
import { MemoryStore } from '../support/memory-store'
import { fakeIdToken } from '../support/fake-id-token'

const T0 = Date.parse('2026-10-03T10:00:00Z')
const TOKEN = fakeIdToken()
const config: SessionConfig = {
  keys: { current: randomBytes(32) },
  maxSeconds: 28_800,
  idleSeconds: 1_800,
}

let now = T0
let store: MemoryStore
beforeEach(() => {
  now = T0
  store = new MemoryStore(() => now)
})

const expSeconds = (msFromNow: number) => Math.floor((T0 + msFromNow) / 1000)

describe('session creation', () => {
  it('uses a fresh opaque id, a hashed key and an encrypted token', async () => {
    const created = await createSession(store, TOKEN, expSeconds(3_600_000), config, now)
    expect(created?.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const keys = [...store.data.keys()]
    expect(keys).toEqual([`cms:sess:${hashId(created!.sessionId)}`])
    expect(keys[0]).not.toContain(created!.sessionId)
    const raw = store.data.get(keys[0]!)!.value
    expect(raw).not.toContain(TOKEN)
    const record = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'idTokenEnc',
      'lastSeenAt',
      'v',
    ])
    expect(decryptToken(record.idTokenEnc as string, config.keys)).toBe(TOKEN)
  })

  it('never outlives the ID token (exp - 60s) and respects the absolute cap', async () => {
    const short = await createSession(store, TOKEN, expSeconds(3_600_000), config, now)
    expect(short!.expiresAt).toBe(expSeconds(3_600_000) * 1000 - ID_TOKEN_SAFETY_MARGIN_MS)
    const capped = await createSession(
      store,
      TOKEN,
      expSeconds(48 * 3_600_000),
      { ...config, maxSeconds: 600 },
      now,
    )
    expect(capped!.expiresAt).toBe(now + 600_000)
  })

  it('refuses a token that is already inside the safety margin', async () => {
    expect(await createSession(store, TOKEN, expSeconds(30_000), config, now)).toBeNull()
    expect(store.data.size).toBe(0)
  })
})

describe('session validation', () => {
  it('accepts a valid session and returns the decrypted token server-side', async () => {
    const created = await createSession(store, TOKEN, expSeconds(3_600_000), config, now)
    expect(await checkSession(store, created!.sessionId, config, now)).toMatchObject({
      status: 'valid',
      idToken: TOKEN,
    })
  })

  it('rejects absent, malformed and unknown cookies', async () => {
    expect(await checkSession(store, undefined, config, now)).toEqual({ status: 'absent' })
    expect(await checkSession(store, 'short', config, now)).toEqual({ status: 'invalid' })
    expect(await checkSession(store, 'A'.repeat(43), config, now)).toEqual({ status: 'invalid' })
  })

  it('rejects and deletes a session past its absolute expiry', async () => {
    const created = await createSession(store, TOKEN, expSeconds(3_600_000), config, now)
    now = created!.expiresAt + 1
    expect(await checkSession(store, created!.sessionId, config, now)).toEqual({
      status: 'invalid',
    })
    expect(store.data.size).toBe(0)
  })

  it('rejects and deletes an idle session even before absolute expiry', async () => {
    const created = await createSession(store, TOKEN, expSeconds(8 * 3_600_000), config, now)
    now = T0 + config.idleSeconds * 1000 + 1
    expect(now).toBeLessThan(created!.expiresAt)
    expect(await checkSession(store, created!.sessionId, config, now)).toEqual({
      status: 'invalid',
    })
    expect(store.data.size).toBe(0)
  })

  it('touches lastSeenAt at most once per interval, keeping an active session alive', async () => {
    const created = await createSession(store, TOKEN, expSeconds(8 * 3_600_000), config, now)
    const key = sessionKey(created!.sessionId)
    now = T0 + 10_000
    await checkSession(store, created!.sessionId, config, now)
    expect(JSON.parse(store.data.get(key)!.value).lastSeenAt).toBe(T0)
    now = T0 + TOUCH_INTERVAL_MS + 1
    await checkSession(store, created!.sessionId, config, now)
    expect(JSON.parse(store.data.get(key)!.value).lastSeenAt).toBe(now)
    now += config.idleSeconds * 1000 - 1
    expect((await checkSession(store, created!.sessionId, config, now)).status).toBe('valid')
  })

  it('deletes a session whose token cannot be decrypted (wrong key / tampering)', async () => {
    const created = await createSession(store, TOKEN, expSeconds(3_600_000), config, now)
    const wrong = { ...config, keys: { current: randomBytes(32) } }
    expect(await checkSession(store, created!.sessionId, wrong, now)).toEqual({ status: 'invalid' })
    expect(store.data.size).toBe(0)
  })

  it('ends a session on logout', async () => {
    const created = await createSession(store, TOKEN, expSeconds(3_600_000), config, now)
    await endSession(store, created!.sessionId)
    expect(await checkSession(store, created!.sessionId, config, now)).toEqual({
      status: 'invalid',
    })
  })
})

describe('login transaction', () => {
  const data = {
    state: 's'.repeat(43),
    oidcNonce: 'n'.repeat(43),
    codeVerifier: 'v'.repeat(43),
    returnTo: '/x',
  }

  it('is stored under a hashed key for 600 seconds and returns only an opaque id', async () => {
    const txId = await createTransaction(store, data, now)
    expect(txId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const entry = store.data.get(txKey(txId))!
    expect(entry.expiresAtMs).toBe(now + TRANSACTION_TTL_SECONDS * 1000)
    expect(JSON.parse(entry.value)).toEqual({
      v: 1,
      ...data,
      createdAt: now,
      expiresAt: now + 600_000,
    })
    expect([...store.data.keys()][0]).not.toContain(txId)
  })

  it('is single use and expires', async () => {
    const txId = await createTransaction(store, data, now)
    expect(await consumeTransaction(store, txId, now)).toMatchObject(data)
    expect(await consumeTransaction(store, txId, now)).toBeNull()
    const late = await createTransaction(store, data, now)
    now += 601_000
    expect(await consumeTransaction(store, late, now)).toBeNull()
  })
})
