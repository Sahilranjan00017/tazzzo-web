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
    })
  })

  it('treats an unset media base as "no images" rather than an error', () => {
    expect(parseServerEnv({ ...valid, TAZZZO_MEDIA_BASE_URL: undefined }).media).toBeNull()
    expect(parseServerEnv({ ...valid, TAZZZO_MEDIA_BASE_URL: '' }).media).toBeNull()
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
