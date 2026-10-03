import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assertNoPublicSecrets, parseServerEnv } from '@/server/env'

const valid = {
  NODE_ENV: 'production',
  CMS_BASE_URL: 'https://admin.tazzzo.example',
  GOOGLE_CLIENT_ID: 'web-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-only-secret',
  GOOGLE_HOSTED_DOMAIN: 'tazzzo.example',
  TAZZZO_BACKEND_URL: 'https://backend.internal',
  SESSION_STORE_URL: 'rediss://cms-sessions.internal:6379',
  SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
}

describe('server environment (W2)', () => {
  it('accepts a complete production configuration with the documented defaults', () => {
    expect(parseServerEnv(valid)).toMatchObject({
      CMS_SESSION_MAX_SECONDS: 28_800,
      CMS_SESSION_IDLE_SECONDS: 1_800,
    })
  })

  it('requires every W2 value', () => {
    for (const name of Object.keys(valid)) {
      const env: Record<string, string> = { ...valid }
      delete env[name]
      expect(() => parseServerEnv(env), name).toThrow(name)
    }
  })

  it('validates the session encryption key as exactly 32 bytes (base64 or base64url)', () => {
    expect(() =>
      parseServerEnv({ ...valid, SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64') }),
    ).not.toThrow()
    expect(() =>
      parseServerEnv({ ...valid, SESSION_ENCRYPTION_KEY: randomBytes(16).toString('base64url') }),
    ).toThrow('SESSION_ENCRYPTION_KEY')
    expect(() => parseServerEnv({ ...valid, SESSION_ENCRYPTION_KEY: 'not base64!' })).toThrow(
      'SESSION_ENCRYPTION_KEY',
    )
  })

  it('enforces production safety: https CMS origin, Google issuer only, TLS session store', () => {
    expect(() => parseServerEnv({ ...valid, CMS_BASE_URL: 'http://admin.tazzzo.example' })).toThrow(
      'CMS_BASE_URL',
    )
    expect(() => parseServerEnv({ ...valid, GOOGLE_ISSUER: 'http://127.0.0.1:9999' })).toThrow(
      'GOOGLE_ISSUER',
    )
    expect(() =>
      parseServerEnv({ ...valid, GOOGLE_ISSUER: 'https://accounts.google.com' }),
    ).not.toThrow()
    expect(() =>
      parseServerEnv({ ...valid, SESSION_STORE_URL: 'redis://cms-sessions.internal:6379' }),
    ).toThrow('SESSION_STORE_URL')
    expect(() =>
      parseServerEnv({ ...valid, CMS_BASE_URL: 'https://admin.tazzzo.example/admin' }),
    ).toThrow('CMS_BASE_URL')
  })

  it('allows a loopback test issuer and http only outside production', () => {
    expect(() =>
      parseServerEnv({
        ...valid,
        NODE_ENV: 'test',
        CMS_BASE_URL: 'http://localhost:3000',
        GOOGLE_ISSUER: 'http://127.0.0.1:9',
      }),
    ).not.toThrow()
  })

  it('refuses secret-like NEXT_PUBLIC_ variables and never echoes values', () => {
    for (const name of [
      'NEXT_PUBLIC_GOOGLE_CLIENT_SECRET',
      'NEXT_PUBLIC_SESSION_ENCRYPTION_KEY',
      'NEXT_PUBLIC_ID_TOKEN',
    ]) {
      expect(() => assertNoPublicSecrets({ [name]: 'x' })).toThrow(name)
    }
    expect(() => parseServerEnv({ ...valid, GOOGLE_HOSTED_DOMAIN: 'Super-Secret-Value' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('Super-Secret-Value') }),
    )
  })
})
