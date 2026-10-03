import { Redis } from 'ioredis'
import { NextRequest, type NextResponse } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { READER_SUB, WRITER_SUB } from '../support/fake-backend'
import {
  CMS_BASE_URL,
  SESSION_COOKIE,
  startHarness,
  stopHarness,
  TX_COOKIE,
  type Harness,
} from '../support/integration-env'

/**
 * Browser -> CMS BFF route handler -> backend, over real Valkey sessions, with a backend that verifies every
 * forwarded bearer as a genuine ID token (signature/issuer/audience) and decides roles by subject.
 */
let h: Harness
let redis: Redis
let start: { GET: (r: NextRequest) => Promise<NextResponse> }
let callback: { GET: (r: NextRequest) => Promise<NextResponse> }
let route: {
  PATCH: (r: NextRequest, c: { params: Promise<{ productId: string }> }) => Promise<NextResponse>
} & Record<string, unknown>

beforeAll(async () => {
  h = await startHarness({ verifyTokens: true })
  redis = new Redis(h.redisUrl)
  start = await import('@/app/api/auth/google/start/route')
  callback = await import('@/app/api/auth/google/callback/route')
  route = await import('@/app/api/bff/catalog/products/[productId]/title/route')
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterAll(async () => {
  await redis?.quit()
  await stopHarness(h)
})

beforeEach(async () => {
  await redis.flushall()
  h.backend.reset()
})

async function signIn(sub: string): Promise<string> {
  const res = await start.GET(new NextRequest(`${CMS_BASE_URL}/api/auth/google/start`))
  const p = new URL(res.headers.get('location')!).searchParams
  const code = h.provider.issueCode({
    codeChallenge: p.get('code_challenge')!,
    redirectUri: p.get('redirect_uri')!,
    claims: {
      sub,
      email: `${sub}@tazzzo.test`,
      email_verified: true,
      hd: 'tazzzo.test',
      nonce: p.get('nonce'),
    },
  })
  const done = await callback.GET(
    new NextRequest(
      `${CMS_BASE_URL}/api/auth/google/callback?code=${code}&state=${p.get('state')}`,
      {
        headers: { cookie: `${TX_COOKIE}=${res.cookies.get(TX_COOKIE)!.value}` },
      },
    ),
  )
  return done.cookies.get(SESSION_COOKIE)!.value
}

function patch(
  sessionId: string | null,
  body: unknown,
  headers: Record<string, string> = {},
  productId = 'TZP-REF-1',
) {
  return route.PATCH(
    new NextRequest(`${CMS_BASE_URL}/api/bff/catalog/products/${productId}/title`, {
      method: 'PATCH',
      headers: {
        origin: CMS_BASE_URL,
        'x-tazzzo-csrf': '1',
        'content-type': 'application/json',
        ...(sessionId ? { cookie: `${SESSION_COOKIE}=${sessionId}; other=browser-cookie` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ productId }) },
  )
}

const sessions = async () => (await redis.keys('cms:sess:*')).length

describe('authorized human mutation', () => {
  it('a writer renames the product; the backend received the human ID token and nothing else from the browser', async () => {
    const sessionId = await signIn(WRITER_SUB)
    const res = await patch(sessionId, { title: 'Basmati Rice 5 kg', expectedVersion: 3 })
    const body = (await res.json()) as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      data: { id: 'TZP-REF-1', title: 'Basmati Rice 5 kg', version: 4 },
    })
    expect(body.backendRequestId).toMatch(/^req_[0-9a-f]{20}$/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const call = h.backend.requests.at(-1)!
    expect(call).toMatchObject({
      method: 'PATCH',
      path: '/api/v1/products/TZP-REF-1',
      sub: WRITER_SUB,
    })
    expect(call.authorization).toMatch(/^Bearer eyJ/)
    expect(call.headers.cookie).toBeUndefined()
    expect(call.headers['if-match']).toBe('3')
    expect(JSON.parse(call.body)).toEqual({ title: 'Basmati Rice 5 kg' })
    expect(JSON.stringify(body)).not.toContain(call.authorization!.slice(7))
  })

  it('a stale version is a 409 with the backend code only', async () => {
    const sessionId = await signIn(WRITER_SUB)
    const res = await patch(sessionId, { title: 'x', expectedVersion: 1 })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'conflict', code: 'STALE_VERSION' })
  })
})

describe('denials keep the right state', () => {
  it('a reader is denied by the backend (403) and keeps the session', async () => {
    const sessionId = await signIn(READER_SUB)
    const res = await patch(sessionId, { title: 'x', expectedVersion: 3 })
    expect(res.status).toBe(403)
    expect(res.headers.getSetCookie()).toEqual([])
    expect(await sessions()).toBe(1)
    expect(h.backend.products.get('TZP-REF-1')?.title).toBe('Basmati 5 kg')
  })

  it('a backend 401 ends the session and expires the cookie', async () => {
    const sessionId = await signIn(WRITER_SUB)
    h.backend.mutationOverride = { status: 401 }
    const res = await patch(sessionId, { title: 'x', expectedVersion: 3 })
    expect(res.status).toBe(401)
    expect(res.headers.getSetCookie().join()).toMatch(/__Host-tz_cms_session=;.*Max-Age=0/i)
    expect(await sessions()).toBe(0)
  })

  it('a cookie without a stored session cannot mutate and never reaches the backend', async () => {
    const res = await patch('f'.repeat(43), { title: 'x', expectedVersion: 3 })
    expect(res.status).toBe(401)
    expect(h.backend.requests).toEqual([])
  })

  it('cross-origin or header-less requests are refused before the backend', async () => {
    const sessionId = await signIn(WRITER_SUB)
    expect(
      (
        await patch(
          sessionId,
          { title: 'x', expectedVersion: 3 },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403)
    expect(
      (await patch(sessionId, { title: 'x', expectedVersion: 3 }, { 'x-tazzzo-csrf': '' })).status,
    ).toBe(403)
    expect(h.backend.requests.filter((r) => r.method === 'PATCH')).toEqual([])
  })

  it('is PATCH only', () => {
    expect(Object.keys(route).filter((k) => /^(GET|POST|PUT|DELETE)$/.test(k))).toEqual([])
  })
})
