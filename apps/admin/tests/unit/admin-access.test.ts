import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_ME_PATH, fetchAdminMe } from '@/server/backend/admin-me'
import { resolveAdminAccess } from '@/server/session/admin-access'
import { createSession, type SessionConfig } from '@/server/session/session'
import { MemoryStore } from '../support/memory-store'
import { fakeIdToken } from '../support/fake-id-token'

const TOKEN = fakeIdToken()
const BACKEND = 'https://backend.internal'
const config: SessionConfig = {
  keys: { current: randomBytes(32) },
  maxSeconds: 28_800,
  idleSeconds: 1_800,
}
const ME = {
  actorType: 'HUMAN_ADMIN',
  actorId: 'google:111',
  email: 'ops@tazzzo.test',
  roles: ['cms-writer', 'reader'],
}

type Call = { url: string; headers: Record<string, string> }
function backend(status: number, body: unknown = ME) {
  const calls: Call[] = []
  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, impl }
}

let store: MemoryStore
let sessionId: string
const now = Date.now()
beforeEach(async () => {
  store = new MemoryStore()
  sessionId = (await createSession(store, TOKEN, Math.floor(now / 1000) + 3600, config, now))!
    .sessionId
})

describe('backend /me bootstrap', () => {
  it('calls exactly GET /api/v1/admin/me with only the human bearer ID token', async () => {
    const { calls, impl } = backend(200)
    const access = await resolveAdminAccess(
      { store, config, backendUrl: BACKEND, fetchImpl: impl },
      sessionId,
      now,
    )
    expect(access).toEqual({ action: 'render', view: 'ok', me: ME })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BACKEND}${ADMIN_ME_PATH}`)
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('401: ends the session and sends the browser to re-authenticate, with no other credential tried', async () => {
    const { calls, impl } = backend(401)
    const access = await resolveAdminAccess(
      { store, config, backendUrl: BACKEND, fetchImpl: impl },
      sessionId,
      now,
    )
    expect(access).toEqual({ action: 'redirect', to: '/api/auth/expired' })
    expect(store.data.size).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('403: keeps the session and renders access denied, with no retry', async () => {
    const { calls, impl } = backend(403)
    const access = await resolveAdminAccess(
      { store, config, backendUrl: BACKEND, fetchImpl: impl },
      sessionId,
      now,
    )
    expect(access).toEqual({ action: 'render', view: 'forbidden' })
    expect(store.data.size).toBe(1)
    expect(calls).toHaveLength(1)
  })

  it('every backend call carries the session ID token, never a service credential', async () => {
    for (const status of [200, 401, 403, 500]) {
      const s = new MemoryStore()
      const id = (await createSession(s, TOKEN, Math.floor(now / 1000) + 3600, config, now))!
        .sessionId
      const { calls, impl } = backend(status)
      await resolveAdminAccess({ store: s, config, backendUrl: BACKEND, fetchImpl: impl }, id, now)
      expect(calls.map((c) => c.headers.authorization)).toEqual([`Bearer ${TOKEN}`])
    }
  })

  it('no or invalid session never reaches the backend', async () => {
    const { calls, impl } = backend(200)
    const deps = { store, config, backendUrl: BACKEND, fetchImpl: impl }
    expect(await resolveAdminAccess(deps, undefined, now)).toEqual({
      action: 'redirect',
      to: '/login',
    })
    expect(await resolveAdminAccess(deps, 'x'.repeat(43), now)).toEqual({
      action: 'redirect',
      to: '/api/auth/expired',
    })
    expect(calls).toHaveLength(0)
  })

  it('maps server errors, bad bodies and network failures to unavailable', async () => {
    expect((await fetchAdminMe(BACKEND, TOKEN, backend(500).impl)).kind).toBe('unavailable')
    expect((await fetchAdminMe(BACKEND, TOKEN, backend(200, { nope: true }).impl)).kind).toBe(
      'unavailable',
    )
    const failing = (async () => {
      throw new Error('down')
    }) as typeof fetch
    expect((await fetchAdminMe(BACKEND, TOKEN, failing)).kind).toBe('unavailable')
  })
})
