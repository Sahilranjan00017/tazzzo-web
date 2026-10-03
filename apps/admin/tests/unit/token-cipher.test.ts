import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptToken, encryptToken, keyId } from '@/server/crypto/token-cipher'
import { fakeIdToken } from '../support/fake-id-token'

const key = randomBytes(32)
const other = randomBytes(32)
const TOKEN = fakeIdToken()

describe('ID-token encryption (AES-256-GCM)', () => {
  it('round-trips and never contains the plaintext', () => {
    const sealed = encryptToken(TOKEN, { current: key })
    expect(sealed).not.toContain(TOKEN)
    expect(sealed).not.toContain('eyJ')
    expect(decryptToken(sealed, { current: key })).toBe(TOKEN)
    expect(JSON.parse(sealed)).toMatchObject({ v: 1, kid: keyId(key) })
  })

  it('uses a fresh IV every time', () => {
    const a = JSON.parse(encryptToken(TOKEN, { current: key })) as { iv: string; ct: string }
    const b = JSON.parse(encryptToken(TOKEN, { current: key })) as { iv: string; ct: string }
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
    expect(Buffer.from(a.iv, 'base64url')).toHaveLength(12)
  })

  it('rejects tampered ciphertext, tampered tag and the wrong key', () => {
    const sealed = JSON.parse(encryptToken(TOKEN, { current: key })) as Record<string, string>
    const flip = (v: string) => {
      const bytes = Buffer.from(v, 'base64url')
      bytes[0] = (bytes[0] ?? 0) ^ 0xff
      return bytes.toString('base64url')
    }
    expect(() =>
      decryptToken(JSON.stringify({ ...sealed, ct: flip(sealed.ct ?? '') }), { current: key }),
    ).toThrow()
    expect(() =>
      decryptToken(JSON.stringify({ ...sealed, tag: flip(sealed.tag ?? '') }), { current: key }),
    ).toThrow()
    expect(() => decryptToken(JSON.stringify(sealed), { current: other })).toThrow()
    expect(() =>
      decryptToken(JSON.stringify({ ...sealed, kid: keyId(other) }), { current: other }),
    ).toThrow()
    expect(() => decryptToken('not json', { current: key })).toThrow()
  })

  it('decrypts with the previous key during rotation and encrypts with the current one', () => {
    const old = encryptToken(TOKEN, { current: other })
    expect(decryptToken(old, { current: key, previous: other })).toBe(TOKEN)
    expect(JSON.parse(encryptToken(TOKEN, { current: key, previous: other }))).toMatchObject({
      kid: keyId(key),
    })
  })

  it('refuses keys that are not 32 bytes', () => {
    expect(() => encryptToken(TOKEN, { current: randomBytes(16) })).toThrow()
  })
})
