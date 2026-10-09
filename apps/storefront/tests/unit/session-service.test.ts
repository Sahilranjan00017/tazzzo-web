import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CookieJar } from '../support/cookie-jar'

/**
 * Sign-in flows against a mocked backend `fetch` and a cookie jar: what is called, with which headers and bodies,
 * which cookies are written (and how), and which closed-vocabulary outcome the customer gets.
 */
const jar = new CookieJar()
vi.mock('next/headers', () => ({ cookies: async () => jar }))

const KEY = randomBytes(32).toString('base64')
const TOKEN = 'AT.' + 'x'.repeat(60)
const REFRESH = 'SES_abcdef123.' + 'r'.repeat(30)
const REFRESH_2 = 'SES_abcdef123.' + 's'.repeat(30)
const CHALLENGE = 'OTP_' + 'c'.repeat(24)
const GRANT = 'GRANT_' + 'g'.repeat(24)
const NOW = 1_800_000_000_000

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers })

async function load(env: Record<string, string> = {}) {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('TAZZZO_API_BASE_URL', 'https://api.tazzzo.test')
  vi.stubEnv('TAZZZO_SITE_URL', 'https://www.tazzzo.test')
  vi.stubEnv('STOREFRONT_SESSION_SECRET', KEY)
  vi.stubEnv('TAZZZO_CALLER_NAME', 'storefront')
  vi.stubEnv('TAZZZO_CALLER_SECRET', 'caller-secret-for-tests-0123456789abcdef')
  vi.stubEnv('STOREFRONT_TRUST_PROXY', 'true')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return {
    service: await import('@/server/session/service'),
    cookies: await import('@/server/session/cookies'),
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

const otpRequested = { challengeId: CHALLENGE, expiresInSeconds: 300, resendAfterSeconds: 30 }
const established = {
  customerId: 'CUS_1',
  accessToken: TOKEN,
  accessTokenExpiresIn: 900,
  refreshToken: REFRESH,
}

async function signedIn() {
  const loaded = await load()
  fetchMock.mockResolvedValueOnce(reply(202, otpRequested))
  await loaded.service.startSignIn('9876543210', NOW)
  fetchMock
    .mockResolvedValueOnce(reply(200, { verified: true, grantId: GRANT }))
    .mockResolvedValueOnce(reply(200, established))
  await loaded.service.completeSignIn('123456', NOW)
  fetchMock.mockClear()
  return loaded
}

describe('startSignIn', () => {
  it('sends the canonical phone, keeps the challenge in a sealed cookie and returns only the masked phone', async () => {
    const { service } = await load()
    fetchMock.mockResolvedValueOnce(reply(202, otpRequested))
    const result = await service.startSignIn('98765 43210', NOW)
    expect(result).toEqual({
      ok: true,
      data: { maskedPhone: '+91 ******3210', expiresInSeconds: 300, resendAfterSeconds: 30 },
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.tazzzo.test/v1/auth/otp/request')
    expect(JSON.parse(String(init?.body))).toEqual({ phone: '+919876543210' })
    const challenge = jar.set_.get('__Host-tz_otp')!
    expect(challenge.value).not.toContain(CHALLENGE)
    expect(challenge.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 300,
    })
    expect(challenge.options).not.toHaveProperty('domain')
  })

  it('never calls the backend for a malformed phone', async () => {
    const { service } = await load()
    for (const bad of ['', '12345', '+449876543210', undefined, 9876543210]) {
      expect(await service.startSignIn(bad)).toEqual({
        ok: false,
        error: 'invalid_phone',
        retryAfterSeconds: null,
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      429,
      { code: 'OTP_RATE_LIMITED', retryAfterSeconds: 42 },
      { 'retry-after': '42' },
      'rate_limited',
      42,
    ],
    [503, { code: 'SERVICE_UNAVAILABLE' }, {}, 'unavailable', null],
    [500, { code: 'INTERNAL' }, {}, 'unavailable', null],
    [400, { code: 'OTP_INVALID_REQUEST' }, {}, 'invalid_phone', null],
  ])('maps backend %i to %s without leaking it', async (status, body, headers, error, retry) => {
    const { service } = await load()
    fetchMock.mockResolvedValueOnce(reply(status, body, headers))
    expect(await service.startSignIn('9876543210')).toEqual({
      ok: false,
      error,
      retryAfterSeconds: retry,
    })
    expect(jar.set_.size).toBe(0)
  })

  it('treats a malformed success body as unavailable and sets no cookie', async () => {
    const { service } = await load()
    fetchMock.mockResolvedValueOnce(reply(202, { challengeId: 'nope' }))
    expect((await service.startSignIn('9876543210')).ok).toBe(false)
    expect(jar.set_.size).toBe(0)
  })

  it('sends the trusted-caller headers and never a forwarding header or cookie', async () => {
    const { service } = await load()
    fetchMock.mockResolvedValueOnce(reply(202, otpRequested))
    await service.startSignIn('9876543210')
    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers)
    expect(headers.get('x-tazzzo-caller')).toBe('storefront')
    expect(headers.get('x-tazzzo-caller-secret')).toBeTruthy()
    for (const forbidden of [
      'x-forwarded-for',
      'x-real-ip',
      'forwarded',
      'cookie',
      'authorization',
    ]) {
      expect(headers.has(forbidden), forbidden).toBe(false)
    }
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      redirect: 'error',
      cache: 'no-store',
      method: 'POST',
    })
  })
})

describe('completeSignIn', () => {
  it('verifies the code, exchanges the grant and writes a sealed session cookie with no plain tokens', async () => {
    const { service, cookies } = await load()
    fetchMock.mockResolvedValueOnce(reply(202, otpRequested))
    await service.startSignIn('9876543210', NOW)
    fetchMock
      .mockResolvedValueOnce(reply(200, { verified: true, grantId: GRANT }))
      .mockResolvedValueOnce(reply(200, established))
    expect(await service.completeSignIn('123456', NOW)).toEqual({ ok: true, data: null })

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.tazzzo.test/v1/auth/otp/request',
      'https://api.tazzzo.test/v1/auth/otp/verify',
      'https://api.tazzzo.test/v1/auth/session',
    ])
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      challengeId: CHALLENGE,
      otp: '123456',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual({ grantId: GRANT })

    const session = jar.set_.get('__Host-tz_session')!
    expect(session.value).not.toContain(TOKEN)
    expect(session.value).not.toContain(REFRESH)
    expect(session.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    })
    expect(session.options.maxAge).toBe(30 * 24 * 60 * 60)
    expect(jar.get('__Host-tz_otp')).toBeUndefined() // challenge consumed
    const read = await cookies.readSession(NOW + 1)
    expect(read).toMatchObject({ customerId: 'CUS_1', accessToken: TOKEN, refreshToken: REFRESH })
    expect(read?.accessExpiresAt).toBe(NOW + 900_000)
  })

  it('refuses a malformed code without calling the backend', async () => {
    const { service } = await load()
    for (const bad of ['12345', 'abcdef', '', undefined, 123456]) {
      expect(await service.completeSignIn(bad)).toMatchObject({ ok: false, error: 'invalid_code' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('says "expired" when this browser has no challenge, or it has lapsed', async () => {
    const { service } = await load()
    expect(await service.completeSignIn('123456', NOW)).toMatchObject({
      ok: false,
      error: 'expired',
    })
    fetchMock.mockResolvedValueOnce(reply(202, { ...otpRequested, expiresInSeconds: 5 }))
    await service.startSignIn('9876543210', NOW)
    fetchMock.mockClear()
    expect(await service.completeSignIn('123456', NOW + 6_000)).toMatchObject({
      ok: false,
      error: 'expired',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [400, { code: 'OTP_INVALID' }, {}, 'invalid_code', null],
    [400, { code: 'OTP_EXPIRED' }, {}, 'expired', null],
    [429, { code: 'OTP_RATE_LIMITED' }, { 'retry-after': '120' }, 'rate_limited', 120],
    [503, { code: 'SERVICE_UNAVAILABLE' }, {}, 'unavailable', null],
  ])('maps a verify answer %i %j to %s', async (status, body, headers, error, retry) => {
    const { service } = await load()
    fetchMock.mockResolvedValueOnce(reply(202, otpRequested))
    await service.startSignIn('9876543210', NOW)
    fetchMock.mockResolvedValueOnce(reply(status, body, headers))
    expect(await service.completeSignIn('123456', NOW)).toEqual({
      ok: false,
      error,
      retryAfterSeconds: retry,
    })
    expect(jar.get('__Host-tz_session')).toBeUndefined()
  })

  it('writes no session when the grant cannot be exchanged', async () => {
    const { service } = await load()
    fetchMock.mockResolvedValueOnce(reply(202, otpRequested))
    await service.startSignIn('9876543210', NOW)
    fetchMock
      .mockResolvedValueOnce(reply(200, { verified: true, grantId: GRANT }))
      .mockResolvedValueOnce(reply(401, { code: 'UNAUTHENTICATED' }))
    expect(await service.completeSignIn('123456', NOW)).toMatchObject({
      ok: false,
      error: 'unavailable',
    })
    expect(jar.get('__Host-tz_session')).toBeUndefined()
  })
})

describe('session cookie reading', () => {
  it('ignores a cookie that was tampered with, sealed with another key or has expired', async () => {
    const { cookies } = await signedIn()
    const name = '__Host-tz_session'
    const good = jar.get(name)!.value
    expect(await cookies.readSession(NOW + 1)).not.toBeNull()
    expect(await cookies.readSession(NOW + 31 * 24 * 3600 * 1000)).toBeNull() // past the absolute lifetime
    jar.set(name, good.slice(0, -2) + (good.endsWith('AA') ? 'BB' : 'AA'))
    expect(await cookies.readSession(NOW + 1)).toBeNull()
    jar.set(name, 'garbage')
    expect(await cookies.readSession(NOW + 1)).toBeNull()
  })

  it('is signed out everywhere when no sealing key is configured (non-production)', async () => {
    const { cookies } = await load({
      NODE_ENV: 'development',
      STOREFRONT_SESSION_SECRET: '',
      TAZZZO_SITE_URL: 'http://localhost:3000',
    })
    expect(cookies.customerSessionsEnabled()).toBe(false)
    expect(await cookies.readSession()).toBeNull()
  })

  it('uses the plain *_dev names without Secure for an http site (local development only)', async () => {
    const { service } = await load({
      NODE_ENV: 'development',
      TAZZZO_SITE_URL: 'http://localhost:3000',
    })
    fetchMock.mockResolvedValueOnce(reply(202, otpRequested))
    await service.startSignIn('9876543210', NOW)
    expect(jar.set_.get('tz_otp_dev')!.options).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
    })
  })
})

describe('refreshSession', () => {
  it('rotates the refresh token and keeps the CSRF token', async () => {
    const { service, cookies } = await signedIn()
    const before = (await cookies.readSession(NOW + 1))!
    fetchMock.mockResolvedValueOnce(
      reply(200, {
        accessToken: TOKEN + 'new',
        accessTokenExpiresIn: 900,
        refreshToken: REFRESH_2,
      }),
    )
    const result = await service.refreshSession(before, NOW + 1_000_000)
    expect(result.ok && result.session).toMatchObject({
      accessToken: TOKEN + 'new',
      refreshToken: REFRESH_2,
      csrf: before.csrf,
      accessExpiresAt: NOW + 1_000_000 + 900_000,
      issuedAt: NOW + 1_000_000,
      expiresAt: before.expiresAt, // the absolute lifetime does not slide
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ refreshToken: REFRESH })
  })

  it('shares one backend call between concurrent requests with the same token', async () => {
    const { service, cookies } = await signedIn()
    const session = (await cookies.readSession(NOW + 1))!
    let release: (r: Response) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)))
    const a = service.refreshSession(session)
    const b = service.refreshSession(session)
    release(
      reply(200, { accessToken: TOKEN + 'n', accessTokenExpiresIn: 900, refreshToken: REFRESH_2 }),
    )
    const [ra, rb] = await Promise.all([a, b])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ra).toEqual(rb)
    // and the next refresh is a new call
    fetchMock.mockResolvedValueOnce(reply(401, { code: 'UNAUTHENTICATED' }))
    await service.refreshSession(session)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports a refused refresh token as invalid and an outage as unavailable', async () => {
    const { service, cookies } = await signedIn()
    const session = (await cookies.readSession(NOW + 1))!
    fetchMock.mockResolvedValueOnce(reply(401, { code: 'UNAUTHENTICATED' }))
    expect(await service.refreshSession(session)).toEqual({ ok: false, reason: 'invalid' })
    fetchMock.mockResolvedValueOnce(reply(503, { code: 'SERVICE_UNAVAILABLE' }))
    expect(await service.refreshSession(session)).toEqual({ ok: false, reason: 'unavailable' })
    fetchMock.mockRejectedValueOnce(new Error('network'))
    expect(await service.refreshSession(session)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('treats an access token as expired 30 seconds early', async () => {
    const { service, cookies } = await signedIn()
    const session = (await cookies.readSession(NOW + 1))!
    expect(service.accessTokenUsable(session, NOW + 800_000)).toBe(true)
    expect(service.accessTokenUsable(session, NOW + 871_000)).toBe(false)
    expect(service.accessTokenUsable(session, NOW + 901_000)).toBe(false)
  })
})

describe('signOut', () => {
  it('revokes at the backend with the bearer token, then clears both cookies', async () => {
    const { service, cookies } = await signedIn()
    const session = (await cookies.readSession(NOW + 1))!
    fetchMock.mockResolvedValueOnce(reply(204))
    expect(await service.signOut(session, NOW + 1)).toEqual({ revoked: true })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.tazzzo.test/v1/auth/logout')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(jar.get('__Host-tz_session')).toBeUndefined()
    expect(jar.set_.get('__Host-tz_session')!.options).toMatchObject({ maxAge: 0, httpOnly: true })
  })

  it('refreshes an expired access token first so the backend session can still be revoked', async () => {
    const { service, cookies } = await signedIn()
    const session = (await cookies.readSession(NOW + 1))!
    fetchMock
      .mockResolvedValueOnce(
        reply(200, {
          accessToken: TOKEN + 'new',
          accessTokenExpiresIn: 900,
          refreshToken: REFRESH_2,
        }),
      )
      .mockResolvedValueOnce(reply(204))
    expect(await service.signOut(session, NOW + 2_000_000)).toEqual({ revoked: true })
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.tazzzo.test/v1/auth/refresh',
      'https://api.tazzzo.test/v1/auth/logout',
    ])
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get('authorization')).toBe(
      `Bearer ${TOKEN}new`,
    )
  })

  it('still clears the cookie when the backend is down, and says it could not revoke', async () => {
    const { service, cookies } = await signedIn()
    const session = (await cookies.readSession(NOW + 1))!
    fetchMock.mockRejectedValueOnce(new Error('network'))
    expect(await service.signOut(session, NOW + 1)).toEqual({ revoked: false })
    expect(jar.get('__Host-tz_session')).toBeUndefined()
  })

  it('clears cookies without any backend call when there is no session', async () => {
    const { service } = await load()
    expect(await service.signOut(null)).toEqual({ revoked: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('logging', () => {
  it('never writes a phone number, code, token or cookie value to the console', async () => {
    const warn = vi.spyOn(console, 'warn')
    const info = vi.spyOn(console, 'info')
    const log = vi.spyOn(console, 'log')
    const error = vi.spyOn(console, 'error')
    const { service } = await load()
    fetchMock.mockResolvedValueOnce(
      reply(500, { code: 'INTERNAL', message: '+919876543210 123456' }),
    )
    await service.startSignIn('9876543210')
    fetchMock.mockResolvedValueOnce(reply(200, { challengeId: 'bad', token: TOKEN }))
    await service.startSignIn('9876543210')
    const output = JSON.stringify([warn, info, log, error].map((spy) => spy.mock.calls))
    for (const secret of ['9876543210', '123456', TOKEN, KEY]) expect(output).not.toContain(secret)
  })
})
