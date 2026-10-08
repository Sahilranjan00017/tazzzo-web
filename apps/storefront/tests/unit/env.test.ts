import { describe, expect, it } from 'vitest'
import { parseServerEnv } from '@/server/env'

const valid = {
  NODE_ENV: 'production',
  TAZZZO_API_BASE_URL: 'https://api.tazzzo.test/',
  TAZZZO_SITE_URL: 'https://www.tazzzo.test',
  TAZZZO_MEDIA_BASE_URL: 'https://cdn.tazzzo.test/assets',
}

describe('parseServerEnv', () => {
  it('parses a production configuration', () => {
    expect(parseServerEnv(valid)).toEqual({
      apiBaseUrl: 'https://api.tazzzo.test',
      siteUrl: 'https://www.tazzzo.test',
      media: { base: 'https://cdn.tazzzo.test/assets', origin: 'https://cdn.tazzzo.test' },
      caller: null,
    })
  })

  const SECRET = 'a'.repeat(31) + '!~' // 33 visible ASCII characters

  /** Production with the caller credential requires a trusted proxy (fail closed, see the tests below). */
  const trusted = { ...valid, STOREFRONT_TRUST_PROXY: 'true' }

  it('reads the optional trusted-caller credential when both parts are set', () => {
    expect(
      parseServerEnv({ ...trusted, TAZZZO_CALLER_NAME: 'storefront', TAZZZO_CALLER_SECRET: SECRET })
        .caller,
    ).toEqual({ name: 'storefront', secret: SECRET })
    const longest = {
      TAZZZO_CALLER_NAME: 'web_store_'.repeat(2),
      TAZZZO_CALLER_SECRET: 'c'.repeat(256),
    }
    expect(parseServerEnv({ ...trusted, ...longest }).caller?.name).toBe('web_store_web_store_')
    expect(
      parseServerEnv({ ...trusted, TAZZZO_CALLER_NAME: '', TAZZZO_CALLER_SECRET: '' }).caller,
    ).toBeNull()
  })

  it.each([
    [{ TAZZZO_CALLER_NAME: 'storefront' }, 'TAZZZO_CALLER_SECRET'],
    [{ TAZZZO_CALLER_SECRET: SECRET }, 'TAZZZO_CALLER_NAME'],
    [{ TAZZZO_CALLER_NAME: 'Store Front', TAZZZO_CALLER_SECRET: SECRET }, 'TAZZZO_CALLER_NAME'],
    [{ TAZZZO_CALLER_NAME: 'store-front', TAZZZO_CALLER_SECRET: SECRET }, 'TAZZZO_CALLER_NAME'],
    [{ TAZZZO_CALLER_NAME: 'a'.repeat(21), TAZZZO_CALLER_SECRET: SECRET }, 'TAZZZO_CALLER_NAME'],
    [
      { TAZZZO_CALLER_NAME: 'storefront', TAZZZO_CALLER_SECRET: 'b'.repeat(257) },
      'TAZZZO_CALLER_SECRET',
    ],
    [{ TAZZZO_CALLER_NAME: 'storefront', TAZZZO_CALLER_SECRET: 'short' }, 'TAZZZO_CALLER_SECRET'],
    [
      { TAZZZO_CALLER_NAME: 'storefront', TAZZZO_CALLER_SECRET: `${SECRET} with space` },
      'TAZZZO_CALLER_SECRET',
    ],
    [
      { TAZZZO_CALLER_NAME: 'storefront', TAZZZO_CALLER_SECRET: `${SECRET}\r\nX-Evil: 1` },
      'TAZZZO_CALLER_SECRET',
    ],
  ])('rejects caller config %#, naming only the field and never the value', (override, field) => {
    let message = ''
    try {
      parseServerEnv({ ...trusted, ...override })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toBe(`invalid server environment: ${field}`)
    expect(message).not.toContain('aaaa')
  })

  it('treats an unset media base as "no images" rather than an error', () => {
    expect(parseServerEnv({ ...trusted, TAZZZO_MEDIA_BASE_URL: undefined }).media).toBeNull()
    expect(parseServerEnv({ ...trusted, TAZZZO_MEDIA_BASE_URL: '' }).media).toBeNull()
  })

  describe('fail closed: production never relays unlimited visitor traffic into the caller bucket', () => {
    const credential = { TAZZZO_CALLER_NAME: 'storefront', TAZZZO_CALLER_SECRET: SECRET }

    it.each([undefined, '', 'false', 'TRUE', '1', 'yes'])(
      'rejects the credential in production with STOREFRONT_TRUST_PROXY=%j, naming only that variable',
      (trust) => {
        let message = ''
        try {
          parseServerEnv({ ...valid, ...credential, STOREFRONT_TRUST_PROXY: trust })
        } catch (error) {
          message = (error as Error).message
        }
        expect(message).toBe('invalid server environment: STOREFRONT_TRUST_PROXY')
        expect(message).not.toContain(SECRET)
      },
    )

    it('accepts the credential in production behind a trusted proxy', () => {
      for (const trust of ['true', ' true ']) {
        expect(
          parseServerEnv({ ...valid, ...credential, STOREFRONT_TRUST_PROXY: trust }).caller,
        ).toEqual({ name: 'storefront', secret: SECRET })
      }
    })

    it('does not require a trusted proxy without the credential, or outside production', () => {
      expect(parseServerEnv(valid).caller).toBeNull() // the untrusted default stays valid
      expect(parseServerEnv({ ...valid, STOREFRONT_TRUST_PROXY: 'false' }).caller).toBeNull()
      for (const NODE_ENV of ['development', 'test']) {
        expect(parseServerEnv({ ...valid, ...credential, NODE_ENV }).caller?.name).toBe(
          'storefront',
        )
      }
    })
  })

  it.each([
    [{ TAZZZO_API_BASE_URL: undefined }, 'TAZZZO_API_BASE_URL'],
    [{ TAZZZO_API_BASE_URL: 'ftp://api.tazzzo.test' }, 'TAZZZO_API_BASE_URL'],
    [{ TAZZZO_API_BASE_URL: 'https://u:p@api.tazzzo.test' }, 'TAZZZO_API_BASE_URL'],
    [{ TAZZZO_API_BASE_URL: 'http://api.tazzzo.test' }, 'TAZZZO_API_BASE_URL'],
    [{ TAZZZO_API_BASE_URL: 'http://10.0.3.7:8080' }, 'TAZZZO_API_BASE_URL'],
    [{ TAZZZO_API_BASE_URL: 'http://127.0.0.1.evil.example' }, 'TAZZZO_API_BASE_URL'],
    [{ TAZZZO_SITE_URL: 'http://www.tazzzo.test' }, 'TAZZZO_SITE_URL'],
    [{ TAZZZO_SITE_URL: 'https://www.tazzzo.test/shop' }, 'TAZZZO_SITE_URL'],
    [{ TAZZZO_MEDIA_BASE_URL: 'http://127.0.0.1:9000' }, 'TAZZZO_MEDIA_BASE_URL'],
    [{ TAZZZO_MEDIA_BASE_URL: 'http://cdn.tazzzo.test' }, 'TAZZZO_MEDIA_BASE_URL'],
    [{ NODE_ENV: 'staging' }, 'NODE_ENV'],
  ])('rejects %j, naming only the field', (override, field) => {
    expect(() => parseServerEnv({ ...valid, ...override })).toThrow(
      `invalid server environment: ${field}`,
    )
  })

  it('allows a plain-http API only on a loopback host in production', () => {
    for (const api of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080']) {
      expect(parseServerEnv({ ...valid, TAZZZO_API_BASE_URL: api }).apiBaseUrl).toBe(api)
    }
  })

  it('allows a plain-http API anywhere outside production', () => {
    expect(
      parseServerEnv({
        ...valid,
        NODE_ENV: 'development',
        TAZZZO_API_BASE_URL: 'http://api.internal.test:8080',
      }).apiBaseUrl,
    ).toBe('http://api.internal.test:8080')
  })

  it('allows plain-http loopback hosts in development', () => {
    const env = parseServerEnv({
      NODE_ENV: 'development',
      TAZZZO_API_BASE_URL: 'http://127.0.0.1:8080',
      TAZZZO_SITE_URL: 'http://localhost:3000',
      TAZZZO_MEDIA_BASE_URL: 'http://127.0.0.1:9000/media',
    })
    expect(env.media?.origin).toBe('http://127.0.0.1:9000')
  })
})
