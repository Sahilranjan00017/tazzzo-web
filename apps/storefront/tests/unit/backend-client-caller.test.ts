import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The trusted-caller credential on backend reads. Separate from backend-client.test.ts because the server env is
 * parsed once per module instance: each case re-imports the client under its own environment.
 */
const SECRET = 'test-only-caller-secret-0123456789abcdef'

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()

async function clientWith(env: Record<string, string>) {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('TAZZZO_API_BASE_URL', 'https://api.tazzzo.test')
  vi.stubEnv('TAZZZO_SITE_URL', 'https://www.tazzzo.test')
  vi.stubEnv('STOREFRONT_TRUST_PROXY', 'true') // production requires it with a caller credential
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return import('@/server/backend/client')
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('trusted backend caller', () => {
  it('sends X-Tazzzo-Caller and X-Tazzzo-Caller-Secret on cached and uncached reads when configured', async () => {
    const client = await clientWith({
      TAZZZO_CALLER_NAME: 'storefront',
      TAZZZO_CALLER_SECRET: SECRET,
    })
    await client.getJson('/v1/categories')
    await client.getJson('/v1/search?q=rice', { cache: false })
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.headers).toEqual({
        Accept: 'application/json',
        'X-Tazzzo-Caller': 'storefront',
        'X-Tazzzo-Caller-Secret': SECRET,
      })
      expect(init?.redirect).toBe('error') // the secret cannot follow a redirect to another host
    }
    expect(client.CALLER_HEADER).toBe('X-Tazzzo-Caller')
    expect(client.CALLER_SECRET_HEADER).toBe('X-Tazzzo-Caller-Secret')
  })

  it('sends no caller headers when not configured', async () => {
    const client = await clientWith({})
    await client.getJson('/v1/categories')
    expect(fetchMock.mock.calls[0]![1]?.headers).toEqual({ Accept: 'application/json' })
  })

  it('never logs the secret, even on backend failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const client = await clientWith({
      TAZZZO_CALLER_NAME: 'storefront',
      TAZZZO_CALLER_SECRET: SECRET,
    })
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await client.getJson('/v1/categories')
    await client.getJson('/v1/content/home?channel=web')
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.flat().join(' ')).not.toContain(SECRET)
  })

  it('half a credential is a configuration error that names the field only', async () => {
    const client = await clientWith({ TAZZZO_CALLER_NAME: 'storefront' })
    await expect(client.getJson('/v1/categories')).rejects.toThrow(
      'invalid server environment: TAZZZO_CALLER_SECRET',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('production without a trusted proxy refuses to send the credential at all (fail closed)', async () => {
    const client = await clientWith({
      TAZZZO_CALLER_NAME: 'storefront',
      TAZZZO_CALLER_SECRET: SECRET,
      STOREFRONT_TRUST_PROXY: 'false',
    })
    await expect(client.getJson('/v1/categories')).rejects.toThrow(
      'invalid server environment: STOREFRONT_TRUST_PROXY',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
