import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CMS_BASE_URL,
  SESSION_COOKIE,
  startHarness,
  stopHarness,
  TX_COOKIE,
  type Harness,
} from '../support/integration-env'

let h: Harness

beforeAll(async () => {
  // Nothing listens on port 1: the session store is unavailable for this whole file.
  h = await startHarness({ redisUrl: 'redis://127.0.0.1:1' })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterAll(async () => {
  await stopHarness(h)
})

describe('session store unavailable: fail closed, no fallback', () => {
  it('login start issues no transaction and does not send the browser to the provider', async () => {
    const { GET } = await import('@/app/api/auth/google/start/route')
    const res = await GET(new NextRequest(`${CMS_BASE_URL}/api/auth/google/start`))
    expect(res.headers.get('location')).toBe(`${CMS_BASE_URL}/login?error=unavailable`)
    expect(res.cookies.get(TX_COOKIE)).toBeUndefined()
  })

  it('callback creates no session', async () => {
    const { GET } = await import('@/app/api/auth/google/callback/route')
    const res = await GET(
      new NextRequest(`${CMS_BASE_URL}/api/auth/google/callback?code=c&state=s`, {
        headers: { cookie: `${TX_COOKIE}=${'a'.repeat(43)}` },
      }),
    )
    expect(res.headers.get('location')).toBe(`${CMS_BASE_URL}/login?error=signin_failed`)
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined()
  })

  it('protected pages cannot validate a session (rejects, never treated as valid)', async () => {
    const { resolveAdminAccess } = await import('@/server/session/admin-access')
    const { sessionStore } = await import('@/server/store/redis-store')
    const { sessionConfig } = await import('@/server/session/config')
    const { serverEnv } = await import('@/server/env')
    await expect(
      resolveAdminAccess(
        { store: sessionStore(), config: sessionConfig(serverEnv()), backendUrl: h.backend.url },
        'a'.repeat(43),
        Date.now(),
      ),
    ).rejects.toThrow('session store unavailable')
    expect(h.backend.requests).toEqual([])
  })
})
