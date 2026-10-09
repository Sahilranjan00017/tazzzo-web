import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CookieJar } from '../support/cookie-jar'

/** The `/api/auth/*` route handlers end to end over a mocked backend `fetch` and a cookie jar. */
const jar = new CookieJar()
vi.mock('next/headers', () => ({ cookies: async () => jar }))

const KEY = randomBytes(32).toString('base64')
const TOKEN = 'AT.' + 'x'.repeat(60)
const REFRESH = 'SES_abcdef123.' + 'r'.repeat(30)
const REFRESH_2 = 'SES_abcdef123.' + 's'.repeat(30)
const CHALLENGE = 'OTP_' + 'c'.repeat(24)
const GRANT = 'GRANT_' + 'g'.repeat(24)

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers })

const SITE = 'https://www.tazzzo.test'
const good = (extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  'x-tazzzo-csrf': '1',
  origin: SITE,
  host: 'www.tazzzo.test',
  'sec-fetch-site': 'same-origin',
  ...extra,
})
const post = (path: string, body: unknown, headers: Record<string, string> = good()) =>
  new Request(`${SITE}${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

async function routes() {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('TAZZZO_API_BASE_URL', 'https://api.tazzzo.test')
  vi.stubEnv('TAZZZO_SITE_URL', SITE)
  vi.stubEnv('STOREFRONT_SESSION_SECRET', KEY)
  vi.stubEnv('STOREFRONT_TRUST_PROXY', 'true')
  return {
    request: await import('@/app/api/auth/otp/request/route'),
    verify: await import('@/app/api/auth/otp/verify/route'),
    logout: await import('@/app/api/auth/logout/route'),
    refresh: await import('@/app/api/auth/refresh/route'),
  }
}

beforeEach(() => {
  jar.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function signIn(r: Awaited<ReturnType<typeof routes>>) {
  fetchMock.mockResolvedValueOnce(
    reply(202, { challengeId: CHALLENGE, expiresInSeconds: 300, resendAfterSeconds: 30 }),
  )
  await r.request.POST(post('/api/auth/otp/request', { phone: '9876543210' }))
  fetchMock
    .mockResolvedValueOnce(reply(200, { verified: true, grantId: GRANT }))
    .mockResolvedValueOnce(
      reply(200, {
        customerId: 'CUS_1',
        accessToken: TOKEN,
        accessTokenExpiresIn: 900,
        refreshToken: REFRESH,
      }),
    )
  const response = await r.verify.POST(post('/api/auth/otp/verify', { otp: '123456' }))
  fetchMock.mockClear()
  return response
}

describe('POST /api/auth/otp/request', () => {
  it('answers 200 with the masked phone, no challenge id, no-store', async () => {
    const r = await routes()
    fetchMock.mockResolvedValueOnce(
      reply(202, { challengeId: CHALLENGE, expiresInSeconds: 300, resendAfterSeconds: 30 }),
    )
    const response = await r.request.POST(post('/api/auth/otp/request', { phone: '+919876543210' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({
      ok: true,
      maskedPhone: '+91 ******3210',
      expiresInSeconds: 300,
      resendAfterSeconds: 30,
    })
    expect(text).not.toContain(CHALLENGE)
  })

  it('refuses a cross-site, header-less or origin-less request before doing anything', async () => {
    const r = await routes()
    const bad: Array<Record<string, string>> = [
      good({ origin: 'https://evil.example' }),
      good({ 'sec-fetch-site': 'cross-site' }),
      { 'content-type': 'application/json', origin: SITE, host: 'www.tazzzo.test' }, // no CSRF header
      { 'content-type': 'application/json', 'x-tazzzo-csrf': '1', host: 'www.tazzzo.test' }, // no Origin
    ]
    for (const headers of bad) {
      const response = await r.request.POST(
        post('/api/auth/otp/request', { phone: '9876543210' }, headers),
      )
      expect(response.status).toBe(403)
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(jar.set_.size).toBe(0)
  })

  it('refuses non-JSON, oversized, malformed and non-object bodies with 400', async () => {
    const r = await routes()
    const cases: Array<[string, Record<string, string>]> = [
      ['{"phone":"9876543210"}', good({ 'content-type': 'text/plain' })],
      ['{"phone":"9876543210"}', good({ 'content-type': 'application/x-www-form-urlencoded' })],
      ['{not json', good()],
      ['[]', good()],
      ['"9876543210"', good()],
    ]
    for (const [body, headers] of cases) {
      const response = await r.request.POST(post('/api/auth/otp/request', body, headers))
      expect(response.status, body.slice(0, 20)).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caps the body by streaming: 413 for a chunked oversize body and for a lying Content-Length', async () => {
    const r = await routes()
    const chunk = new TextEncoder().encode('x'.repeat(1_000))
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        if (pulled > 50) return controller.close()
        controller.enqueue(chunk)
      },
    })
    const chunked = new Request(`${SITE}/api/auth/otp/request`, {
      method: 'POST',
      headers: good(),
      body: stream,
      duplex: 'half',
    } as RequestInit)
    const response = await r.request.POST(chunked)
    expect(response.status).toBe(413)
    expect(pulled).toBeLessThan(10) // stopped reading near the cap, did not buffer all 50 KB
    const lying = await r.request.POST(
      post('/api/auth/otp/request', '{}', good({ 'content-length': '999999' })),
    )
    expect(lying.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a bad phone without calling the backend, 429 with Retry-After, 503 on outage', async () => {
    const r = await routes()
    const bad = await r.request.POST(post('/api/auth/otp/request', { phone: '12345' }))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ ok: false, error: 'invalid_phone', retryAfterSeconds: null })
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValueOnce(
      reply(429, { code: 'OTP_RATE_LIMITED', retryAfterSeconds: 42 }, { 'retry-after': '42' }),
    )
    const limited = await r.request.POST(post('/api/auth/otp/request', { phone: '9876543210' }))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('42')
    expect(await limited.json()).toEqual({
      ok: false,
      error: 'rate_limited',
      retryAfterSeconds: 42,
    })

    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.1.2.3:8080'))
    const down = await r.request.POST(post('/api/auth/otp/request', { phone: '9876543210' }))
    expect(down.status).toBe(503)
    expect(JSON.stringify(await down.json())).not.toMatch(/ECONNREFUSED|10\.1\.2\.3/)
  })

  it('answers 503 when no sealing key is configured (non-production)', async () => {
    const r = await routes()
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('STOREFRONT_SESSION_SECRET', '')
    vi.stubEnv('TAZZZO_SITE_URL', 'http://localhost:3000')
    const dev = await import('@/app/api/auth/otp/request/route')
    const response = await dev.POST(
      post(
        '/api/auth/otp/request',
        { phone: '9876543210' },
        good({ origin: 'http://localhost:3000', host: 'localhost:3000' }),
      ),
    )
    expect(response.status).toBe(503)
    expect(r).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/auth/otp/verify', () => {
  it('starts the session: 200, a sealed HttpOnly cookie, and no token in the body', async () => {
    const r = await routes()
    const response = await signIn(r)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    const cookie = jar.set_.get('__Host-tz_session')!
    expect(cookie.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    })
    expect(cookie.value).not.toMatch(/AT\.|SES_/)
  })

  it('answers wrong and expired codes distinctly, without any session', async () => {
    const r = await routes()
    fetchMock.mockResolvedValueOnce(
      reply(202, { challengeId: CHALLENGE, expiresInSeconds: 300, resendAfterSeconds: 30 }),
    )
    await r.request.POST(post('/api/auth/otp/request', { phone: '9876543210' }))
    fetchMock.mockResolvedValueOnce(reply(400, { code: 'OTP_INVALID' }))
    const wrong = await r.verify.POST(post('/api/auth/otp/verify', { otp: '111111' }))
    expect(wrong.status).toBe(400)
    expect((await wrong.json()).error).toBe('invalid_code')
    fetchMock.mockResolvedValueOnce(reply(400, { code: 'OTP_EXPIRED' }))
    const expired = await r.verify.POST(post('/api/auth/otp/verify', { otp: '111111' }))
    expect((await expired.json()).error).toBe('expired')
    expect(jar.get('__Host-tz_session')).toBeUndefined()
  })

  it('needs the CSRF header like every mutation', async () => {
    const r = await routes()
    const response = await r.verify.POST(
      post('/api/auth/otp/verify', { otp: '123456' }, good({ origin: 'https://evil.example' })),
    )
    expect(response.status).toBe(403)
  })
})

describe('POST /api/auth/logout', () => {
  it('needs the per-session token: the literal "1" no longer works once signed in', async () => {
    const r = await routes()
    await signIn(r)
    const response = await r.logout.POST(post('/api/auth/logout', {}))
    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(jar.get('__Host-tz_session')).toBeDefined()
  })

  it('revokes and clears with the right token', async () => {
    const r = await routes()
    await signIn(r)
    const { readSession } = await import('@/server/session/cookies')
    const session = (await readSession())!
    fetchMock.mockResolvedValueOnce(reply(204))
    const response = await r.logout.POST(
      post('/api/auth/logout', {}, good({ 'x-tazzzo-csrf': session.csrf })),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, revoked: true })
    expect(jar.get('__Host-tz_session')).toBeUndefined()
  })

  it('with no session just clears (nothing to protect), but still refuses a cross-site request', async () => {
    const r = await routes()
    expect((await r.logout.POST(post('/api/auth/logout', {}))).status).toBe(200)
    expect(
      (await r.logout.POST(post('/api/auth/logout', {}, good({ origin: 'https://evil.example' }))))
        .status,
    ).toBe(403)
  })
})

describe('GET /api/auth/refresh', () => {
  const get = (
    query: string,
    headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' },
  ) => new Request(`${SITE}/api/auth/refresh${query}`, { headers })

  it('rotates, rewrites the cookie and redirects to the sanitised next', async () => {
    const r = await routes()
    await signIn(r)
    fetchMock.mockResolvedValueOnce(
      reply(200, { accessToken: TOKEN + 'n', accessTokenExpiresIn: 900, refreshToken: REFRESH_2 }),
    )
    const response = await r.refresh.GET(get('?next=/account'))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/account')
    const { readSession } = await import('@/server/session/cookies')
    expect((await readSession())?.refreshToken).toBe(REFRESH_2)
  })

  it('never redirects off site', async () => {
    const r = await routes()
    await signIn(r)
    for (const next of [
      'https://evil.example',
      '//evil.example',
      '/%2F%2Fevil.example',
      '/\\evil.example',
      'javascript:1',
    ]) {
      fetchMock.mockResolvedValueOnce(
        reply(200, { accessToken: TOKEN, accessTokenExpiresIn: 900, refreshToken: REFRESH_2 }),
      )
      const response = await r.refresh.GET(get(`?next=${encodeURIComponent(next)}`))
      expect(response.headers.get('location'), next).toBe('/account')
    }
  })

  it('ends the session and sends the customer to sign in when the refresh token is refused', async () => {
    const r = await routes()
    await signIn(r)
    fetchMock.mockResolvedValueOnce(reply(401, { code: 'UNAUTHENTICATED' }))
    const response = await r.refresh.GET(get('?next=/account'))
    expect(response.headers.get('location')).toBe('/login?next=%2Faccount&reason=expired')
    expect(jar.get('__Host-tz_session')).toBeUndefined()
  })

  it('keeps the session and reports an outage when the backend is down', async () => {
    const r = await routes()
    await signIn(r)
    fetchMock.mockRejectedValueOnce(new Error('down'))
    const response = await r.refresh.GET(get('?next=/account'))
    expect(response.headers.get('location')).toBe('/login?next=%2Faccount&reason=unavailable')
    expect(jar.get('__Host-tz_session')).toBeDefined()
  })

  it('does not loop: tokens refused right after being issued end the session without a backend call', async () => {
    const r = await routes()
    await signIn(r)
    const response = await r.refresh.GET(get('?next=/account&rejected=1'))
    expect(response.headers.get('location')).toBe('/login?next=%2Faccount&reason=expired')
    expect(jar.get('__Host-tz_session')).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a cross-site navigation and a request without a session', async () => {
    const r = await routes()
    await signIn(r)
    const cross = await r.refresh.GET(get('?next=/account', { 'sec-fetch-site': 'cross-site' }))
    expect(cross.headers.get('location')).toBe('/')
    expect(fetchMock).not.toHaveBeenCalled()
    jar.clear()
    const anonymous = await r.refresh.GET(get('?next=/account'))
    expect(anonymous.headers.get('location')).toBe('/login?next=%2Faccount')
  })
})
