import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seal, unseal } from '@/server/session/seal'

const keyA = randomBytes(32)
const keyB = randomBytes(32)
const NOW = 1_800_000_000_000
const value = { customerId: 'CUS_1', accessToken: 'AT.secret-access-token', n: 7 }

describe('sealed cookie values', () => {
  it('round-trips a value and does not contain it in the clear', () => {
    const sealed = seal('session', value, NOW + 60_000, [keyA])
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(sealed).not.toContain('secret-access-token')
    expect(Buffer.from(sealed.split('.')[2]!, 'base64url').toString('latin1')).not.toContain(
      'secret',
    )
    expect(unseal('session', sealed, [keyA], NOW)).toEqual(value)
  })

  it('uses a fresh IV, so the same value never seals to the same text', () => {
    expect(seal('session', value, NOW + 1, [keyA])).not.toBe(
      seal('session', value, NOW + 1, [keyA]),
    )
  })

  it('rejects a tampered value at every part', () => {
    const sealed = seal('session', value, NOW + 60_000, [keyA])
    const [version, iv, body] = sealed.split('.') as [string, string, string]
    const flip = (text: string, at: number) =>
      text.slice(0, at) + (text[at] === 'A' ? 'B' : 'A') + text.slice(at + 1)
    for (const forged of [
      `${version}.${flip(iv, 2)}.${body}`,
      `${version}.${iv}.${flip(body, 0)}`,
      `${version}.${iv}.${flip(body, body.length - 3)}`, // the authentication tag
      `${version}.${iv}.${body.slice(0, -4)}`,
      `v2.${iv}.${body}`,
      `${iv}.${body}`,
      `${sealed}.x`,
    ]) {
      expect(unseal('session', forged, [keyA], NOW), forged).toBeNull()
    }
  })

  it('rejects absent, empty, oversized and non-base64 input without throwing', () => {
    for (const bad of [undefined, '', 'v1..', 'v1.a.b', 'x'.repeat(5000), 'v1.%%%.%%%']) {
      expect(unseal('session', bad, [keyA], NOW)).toBeNull()
    }
  })

  it('rejects a value after its expiry, even though it still decrypts', () => {
    const sealed = seal('session', value, NOW + 1_000, [keyA])
    expect(unseal('session', sealed, [keyA], NOW + 999)).toEqual(value)
    expect(unseal('session', sealed, [keyA], NOW + 1_000)).toBeNull()
    expect(unseal('session', sealed, [keyA], NOW + 86_400_000)).toBeNull()
  })

  it('rejects another key and another purpose', () => {
    const sealed = seal('session', value, NOW + 60_000, [keyA])
    expect(unseal('session', sealed, [keyB], NOW)).toBeNull()
    expect(unseal('challenge', sealed, [keyA], NOW)).toBeNull()
  })

  it('rotates keys: seals with the first, still opens what the previous key sealed', () => {
    const old = seal('session', value, NOW + 60_000, [keyA])
    expect(unseal('session', old, [keyB, keyA], NOW)).toEqual(value)
    const fresh = seal('session', value, NOW + 60_000, [keyB, keyA])
    expect(unseal('session', fresh, [keyB], NOW)).toEqual(value)
    expect(unseal('session', fresh, [keyA], NOW)).toBeNull()
  })

  it('refuses to seal without a key or beyond the cookie size', () => {
    expect(() => seal('session', value, NOW + 1, [])).toThrow()
    expect(() => seal('session', { big: 'x'.repeat(4000) }, NOW + 1, [keyA])).toThrow()
  })
})
