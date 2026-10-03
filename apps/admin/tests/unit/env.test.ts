import { describe, expect, it } from 'vitest'
import { assertNoPublicSecrets, parseServerEnv } from '@/server/env'

describe('server environment (W1)', () => {
  it('accepts the W1 configuration', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      expect(parseServerEnv({ NODE_ENV })).toEqual({ NODE_ENV })
    }
  })

  it('rejects a missing or malformed NODE_ENV', () => {
    expect(() => parseServerEnv({})).toThrow(/NODE_ENV/)
    expect(() => parseServerEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/)
  })

  it('does not require W2 secrets yet', () => {
    expect(() => parseServerEnv({ NODE_ENV: 'production' })).not.toThrow()
  })

  it('refuses secret-like NEXT_PUBLIC_ variables, which Next would inline into the browser bundle', () => {
    for (const name of [
      'NEXT_PUBLIC_GOOGLE_CLIENT_SECRET',
      'NEXT_PUBLIC_SESSION_ENCRYPTION_KEY',
      'NEXT_PUBLIC_ID_TOKEN',
      'NEXT_PUBLIC_API_KEY',
      'NEXT_PUBLIC_DB_PASSWORD',
    ]) {
      expect(() => assertNoPublicSecrets({ [name]: 'x' })).toThrow(name)
      expect(() => parseServerEnv({ NODE_ENV: 'production', [name]: 'x' })).toThrow(name)
    }
    expect(() => assertNoPublicSecrets({ NEXT_PUBLIC_APP_NAME: 'Tazzzo Admin' })).not.toThrow()
  })

  it('names the bad field but never echoes values', () => {
    expect(() => parseServerEnv({ NODE_ENV: 'super-secret-value' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('super-secret-value') }),
    )
  })
})
