import { Redis } from 'ioredis'
import { NextRequest, type NextResponse } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CMS_BASE_URL,
  SESSION_COOKIE,
  startHarness,
  stopHarness,
  TX_COOKIE,
  type Harness,
} from '../support/integration-env'

type RouteModule = {
  GET?: (r: NextRequest) => Promise<NextResponse>
  POST?: (r: NextRequest) => Promise<NextResponse>
}

let h: Harness
let redis: Redis
let start: RouteModule
let callback: RouteModule
let logout: RouteModule & Record<string, unknown>
let expired: RouteModule
let access: typeof import('@/server/session/admin-access')
let deps: () => Parameters<typeof import('@/server/session/admin-access').resolveAdminAccess>[0]
const logs: string[] = []

beforeAll(async () => {
  h = await startHarness()
  redis = new Redis(h.redisUrl)
  start = await import('@/app/api/auth/google/start/route')
  callback = await import('@/app/api/auth/google/callback/route')
  logout = await import('@/app/api/auth/logout/route')
  expired = await import('@/app/api/auth/expired/route')
  access = await import('@/server/session/admin-access')
  const { sessionStore } = await import('@/server/store/redis-store')
  const { sessionConfig } = await import('@/server/session/config')
  const { serverEnv } = await import('@/server/env')
  deps = () => ({
    store: sessionStore(),
    config: sessionConfig(serverEnv()),
    backendUrl: h.backend.url,
  })
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(
      (...args: unknown[]) => void logs.push(args.map(String).join(' ')),
    )
  }
})

afterAll(async () => {
  await redis?.quit()
  await stopHarness(h)
})

beforeEach(async () => {
  await redis.flushall()
  h.backend.status = 200
  h.backend.requests.length = 0
})

const SUB = '110000000000000000001'

async function beginLogin(query = '', headers: Record<string, string> = {}) {
  const res = await start.GET!(
    new NextRequest(`${CMS_BASE_URL}/api/auth/google/start${query}`, { headers }),
  )
  const location = new URL(res.headers.get('location') ?? 'about:blank')
  return { res, location, params: location.searchParams, txId: res.cookies.get(TX_COOKIE)?.value }
}

function authorize(
  params: URLSearchParams,
  claims: Record<string, unknown> = {},
  extra: { signWithForeignKey?: boolean; challenge?: string } = {},
) {
  return h.provider.issueCode({
    codeChallenge: extra.challenge ?? params.get('code_challenge') ?? '',
    redirectUri: params.get('redirect_uri') ?? '',
    claims: {
      sub: SUB,
      email: 'ops@tazzzo.test',
      email_verified: true,
      hd: 'tazzzo.test',
      nonce: params.get('nonce'),
      ...claims,
    },
    signWithForeignKey: extra.signWithForeignKey,
  })
}

function finishLogin(code: string, state: string | null, txId: string | undefined) {
  const query = new URLSearchParams({ code, ...(state === null ? {} : { state }) })
  return callback.GET!(
    new NextRequest(`${CMS_BASE_URL}/api/auth/google/callback?${query}`, {
      headers: txId ? { cookie: `${TX_COOKIE}=${txId}` } : {},
    }),
  )
}

async function login(returnTo?: string) {
  const begin = await beginLogin(returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '')
  const code = authorize(begin.params)
  const res = await finishLogin(code, begin.params.get('state'), begin.txId)
  return { begin, code, res, sessionId: res.cookies.get(SESSION_COOKIE)?.value }
}

async function storedKeys() {
  return (await redis.keys('cms:*')).sort()
}

describe('login start', () => {
  it('redirects to the provider with code flow, S256 PKCE, state, OIDC nonce, exact redirect URI and openid email', async () => {
    const { res, location, params, txId } = await beginLogin()
    expect(res.status).toBe(302)
    expect(location.origin).toBe(h.provider.issuer)
    expect(location.pathname).toBe('/authorize')
    expect(params.get('response_type')).toBe('code')
    expect(params.get('scope')?.split(' ').sort()).toEqual(['email', 'openid'])
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(params.get('state')).toBeTruthy()
    expect(params.get('nonce')).toBeTruthy()
    expect(params.get('redirect_uri')).toBe(`${CMS_BASE_URL}/api/auth/google/callback`)
    expect(params.get('hd')).toBe('tazzzo.test')
    expect(params.get('client_id')).toBe(h.provider.clientId)
    expect(params.has('access_type')).toBe(false)
    expect(params.has('code_verifier')).toBe(false)
    expect(txId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined()
  })

  it('stores the transaction server-side under a hashed key with a 600 s TTL; the cookie holds only its id', async () => {
    const { params, txId, res } = await beginLogin()
    const keys = await storedKeys()
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^cms:tx:[0-9a-f]{64}$/)
    expect(keys[0]).not.toContain(txId)
    const pttl = await redis.pttl(keys[0]!)
    expect(pttl).toBeGreaterThan(590_000)
    expect(pttl).toBeLessThanOrEqual(600_000)
    const record = JSON.parse((await redis.get(keys[0]!))!) as Record<string, unknown>
    expect(record).toMatchObject({
      v: 1,
      state: params.get('state'),
      oidcNonce: params.get('nonce'),
      returnTo: '/',
    })
    expect(record.codeVerifier).not.toBe(params.get('code_challenge'))
    const setCookie = res.headers.getSetCookie().join('\n')
    expect(setCookie).toContain(`${TX_COOKIE}=${txId}`)
    expect(setCookie).not.toContain(params.get('state')!)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/Secure/i)
    expect(setCookie).toMatch(/SameSite=lax/i)
    expect(setCookie).toMatch(/Max-Age=600/i)
    expect(setCookie).not.toMatch(/Domain=/i)
  })

  it('builds the redirect URI from CMS_BASE_URL, never the request Host or X-Forwarded-Host', async () => {
    const res = await start.GET!(
      new NextRequest('https://attacker.example/api/auth/google/start', {
        headers: {
          host: 'attacker.example',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'http',
        },
      }),
    )
    const params = new URL(res.headers.get('location')!).searchParams
    expect(params.get('redirect_uri')).toBe(`${CMS_BASE_URL}/api/auth/google/callback`)
  })

  it('sanitises the return path before storing it', async () => {
    for (const [given, stored] of [
      ['/catalog?x=1', '/catalog?x=1'],
      ['https://evil.com', '/'],
      ['//evil.com', '/'],
      ['/%2F%2Fevil.com', '/'],
      ['/.//evil.com', '/'],
      ['/x/..//evil.com', '/'],
      ['/%2e//evil.com', '/'],
      ['/%2e%2e//evil.com', '/'],
    ] as const) {
      await redis.flushall()
      await beginLogin(`?returnTo=${encodeURIComponent(given)}`)
      const [key] = await storedKeys()
      expect(JSON.parse((await redis.get(key!))!).returnTo, given).toBe(stored)
    }
  })
})

describe('callback', () => {
  it('creates a fresh, opaque, production-attribute session and redirects at once to the return path', async () => {
    const { begin, res, sessionId } = await login('/catalog')
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${CMS_BASE_URL}/catalog`)
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(sessionId).not.toBe(begin.txId)
    const setCookie = res.headers.getSetCookie()
    const session = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
    expect(session).toMatch(/HttpOnly/i)
    expect(session).toMatch(/Secure/i)
    expect(session).toMatch(/SameSite=lax/i)
    expect(session).toMatch(/Path=\//)
    expect(session).not.toMatch(/Domain=/i)
    expect(setCookie.find((c) => c.startsWith(`${TX_COOKIE}=`))).toMatch(/Max-Age=0/)
  })

  it('never redirects off-origin whatever return path the login started with (open-redirect sink)', async () => {
    for (const hostile of [
      '/.//evil.com',
      '/x/..//evil.com',
      '/%2e//evil.com',
      '/%2e%2e//evil.com',
    ]) {
      await redis.flushall()
      const { res } = await login(hostile)
      expect(res.status, hostile).toBe(303)
      expect(res.headers.get('location'), hostile).toBe(`${CMS_BASE_URL}/`)
    }
  })

  it('stores the session under a hashed key with the ID token encrypted, never plaintext', async () => {
    const { sessionId } = await login()
    const keys = await storedKeys()
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^cms:sess:[0-9a-f]{64}$/)
    expect(keys[0]).not.toContain(sessionId)
    const raw = (await redis.get(keys[0]!))!
    expect(raw).not.toContain('eyJ')
    const record = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'idTokenEnc',
      'lastSeenAt',
      'v',
    ])
    expect(await redis.pttl(keys[0]!)).toBeLessThanOrEqual(3_600_000 - 60_000)
  })

  it('never exposes the ID token, access token or code in the response, cookies or URL', async () => {
    const { res, code } = await login()
    const visible = [
      res.headers.get('location') ?? '',
      ...res.headers.getSetCookie(),
      await res.text(),
    ].join('\n')
    expect(visible).not.toContain('eyJ')
    expect(visible).not.toContain(code)
    expect(visible).not.toMatch(/at-[0-9a-f]{16}/)
  })

  it('wrong state: fails closed, no session, transaction consumed', async () => {
    const begin = await beginLogin()
    const res = await finishLogin(authorize(begin.params), 'not-the-state', begin.txId)
    expect(res.headers.get('location')).toBe(`${CMS_BASE_URL}/login?error=signin_failed`)
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined()
    expect(await storedKeys()).toEqual([])
  })

  it('missing state or missing transaction cookie: fails closed', async () => {
    const begin = await beginLogin()
    expect(
      (await finishLogin(authorize(begin.params), null, begin.txId)).cookies.get(SESSION_COOKIE),
    ).toBeUndefined()
    const again = await beginLogin()
    expect(
      (
        await finishLogin(authorize(again.params), again.params.get('state'), undefined)
      ).cookies.get(SESSION_COOKIE),
    ).toBeUndefined()
  })

  it('replay: a transaction can be used once only', async () => {
    const begin = await beginLogin()
    const first = await finishLogin(authorize(begin.params), begin.params.get('state'), begin.txId)
    expect(first.cookies.get(SESSION_COOKIE)?.value).toBeTruthy()
    const replay = await finishLogin(authorize(begin.params), begin.params.get('state'), begin.txId)
    expect(replay.headers.get('location')).toBe(`${CMS_BASE_URL}/login?error=signin_failed`)
    expect(replay.cookies.get(SESSION_COOKIE)).toBeUndefined()
  })

  it('PKCE: a code bound to a different verifier is refused by the token endpoint', async () => {
    const begin = await beginLogin()
    const code = authorize(begin.params, {}, { challenge: 'A'.repeat(43) })
    const res = await finishLogin(code, begin.params.get('state'), begin.txId)
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined()
    expect(await storedKeys()).toEqual([])
  })

  it('OIDC nonce mismatch, expired ID token, foreign signature, wrong audience or issuer: no session', async () => {
    const now = Math.floor(Date.now() / 1000)
    const cases: Array<[string, Record<string, unknown>, { signWithForeignKey?: boolean }]> = [
      ['nonce', { nonce: 'another-nonce' }, {}],
      ['expired', { iat: now - 7200, exp: now - 3600 }, {}],
      ['signature', {}, { signWithForeignKey: true }],
      ['audience', { aud: 'someone-else', azp: 'someone-else' }, {}],
      ['issuer', { iss: 'https://accounts.google.com' }, {}],
    ]
    for (const [name, claims, extra] of cases) {
      const begin = await beginLogin()
      const res = await finishLogin(
        authorize(begin.params, claims, extra),
        begin.params.get('state'),
        begin.txId,
      )
      expect(res.cookies.get(SESSION_COOKIE), name).toBeUndefined()
      expect(res.headers.get('location'), name).toBe(`${CMS_BASE_URL}/login?error=signin_failed`)
    }
    expect((await storedKeys()).filter((k) => k.startsWith('cms:sess:'))).toEqual([])
  })
})

describe('session + backend /me bootstrap', () => {
  it('a valid session calls GET /api/v1/admin/me with the ID token as bearer, and renders the identity', async () => {
    const { sessionId } = await login()
    const result = await access.resolveAdminAccess(deps(), sessionId, Date.now())
    expect(result).toMatchObject({
      action: 'render',
      view: 'ok',
      me: { actorId: 'google:111', roles: ['cms-writer', 'reader'] },
    })
    expect(h.backend.requests).toHaveLength(1)
    expect(h.backend.requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/admin/me' })
    const auth = h.backend.requests[0]!.authorization ?? ''
    expect(auth).toMatch(/^Bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/)
    const payload = JSON.parse(Buffer.from(auth.split('.')[1]!, 'base64url').toString()) as Record<
      string,
      unknown
    >
    expect(payload).toMatchObject({ sub: SUB, aud: h.provider.clientId })
  })

  it('backend 401: session deleted, sent to the cookie-clearing route, which then expires the cookie', async () => {
    const { sessionId } = await login()
    h.backend.status = 401
    expect(await access.resolveAdminAccess(deps(), sessionId, Date.now())).toEqual({
      action: 'redirect',
      to: '/api/auth/expired',
    })
    expect(await storedKeys()).toEqual([])
    expect(h.backend.requests).toHaveLength(1)
    const res = await expired.GET!(
      new NextRequest(`${CMS_BASE_URL}/api/auth/expired`, {
        headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
      }),
    )
    expect(res.headers.get('location')).toBe(`${CMS_BASE_URL}/login?error=expired`)
    expect(res.headers.getSetCookie().join()).toMatch(
      new RegExp(`${SESSION_COOKIE}=;.*Max-Age=0`, 'i'),
    )
  })

  it('backend 403: session kept, access denied rendered, no retry', async () => {
    const { sessionId } = await login()
    h.backend.status = 403
    expect(await access.resolveAdminAccess(deps(), sessionId, Date.now())).toEqual({
      action: 'render',
      view: 'forbidden',
    })
    expect((await storedKeys()).filter((k) => k.startsWith('cms:sess:'))).toHaveLength(1)
    expect(h.backend.requests).toHaveLength(1)
  })

  it('the cookie-clearing route never clears a live session (a hostile link cannot log anyone out)', async () => {
    const { sessionId } = await login()
    const res = await expired.GET!(
      new NextRequest(`${CMS_BASE_URL}/api/auth/expired`, {
        headers: { cookie: `${SESSION_COOKIE}=${sessionId}` },
      }),
    )
    expect(res.headers.get('location')).toBe(`${CMS_BASE_URL}/`)
    expect(res.headers.getSetCookie()).toEqual([])
    expect((await storedKeys()).filter((k) => k.startsWith('cms:sess:'))).toHaveLength(1)
  })
})

describe('logout', () => {
  const post = (sessionId: string, headers: Record<string, string>) =>
    logout.POST!(
      new NextRequest(`${CMS_BASE_URL}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, ...headers },
      }),
    )

  it('a same-origin POST with the CSRF header deletes the session, expires the cookie and returns to /login', async () => {
    const { sessionId } = await login()
    const res = await post(sessionId!, { origin: CMS_BASE_URL, 'x-tazzzo-csrf': '1' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${CMS_BASE_URL}/login`)
    expect(res.headers.getSetCookie().join()).toMatch(
      new RegExp(`${SESSION_COOKIE}=;.*Max-Age=0`, 'i'),
    )
    expect(await storedKeys()).toEqual([])
    expect((await access.resolveAdminAccess(deps(), sessionId, Date.now())).action).toBe('redirect')
  })

  it('wrong Origin or missing CSRF header: 403 and the session survives', async () => {
    const { sessionId } = await login()
    expect(
      (await post(sessionId!, { origin: 'https://evil.example', 'x-tazzzo-csrf': '1' })).status,
    ).toBe(403)
    expect((await post(sessionId!, { origin: CMS_BASE_URL })).status).toBe(403)
    expect((await post(sessionId!, {})).status).toBe(403)
    expect((await storedKeys()).filter((k) => k.startsWith('cms:sess:'))).toHaveLength(1)
  })

  it('is POST only (no GET logout)', () => {
    expect(Object.keys(logout).filter((k) => /^(GET|PUT|PATCH|DELETE|HEAD)$/.test(k))).toEqual([])
  })
})

describe('logs', () => {
  it('never contain codes, state, nonces, tokens or identifiers from any flow above', async () => {
    const { begin, code, sessionId } = await login()
    await finishLogin(authorize(begin.params), 'bad-state', begin.txId)
    const output = logs.join('\n')
    for (const secret of [
      code,
      begin.params.get('state')!,
      begin.params.get('nonce')!,
      begin.txId!,
      sessionId!,
      'eyJ',
      h.provider.clientSecret,
    ]) {
      expect(output).not.toContain(secret)
    }
    expect(output).toContain('cms_login_failed')
  })
})
