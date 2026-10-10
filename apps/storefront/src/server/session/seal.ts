import 'server-only'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * Sealed (encrypted and authenticated) cookie values: AES-256-GCM with a key derived from the configured secret
 * (HKDF-SHA256), a fresh 12-byte IV per value, and the cookie's purpose bound in as additional data, so a value
 * sealed for one cookie cannot be replayed as another. The expiry is inside the sealed payload and checked on
 * opening, so a stolen old cookie stops working even if the browser keeps it. Wire form: `v1.<iv>.<ciphertext+tag>`
 * (base64url). `unseal` returns null for anything that is not a currently valid value of this purpose (malformed,
 * tampered, wrong key, wrong purpose, expired) and never says which. Pure apart from randomness; nothing is logged.
 */
const VERSION = 'v1'
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_SEALED_LENGTH = 3_800 // a cookie, with its name and attributes, must stay within the 4096 byte browser limit

export type SealPurpose = 'session' | 'challenge' | 'location' | 'checkout'

function derive(secret: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'tazzzo-storefront', 'cookie-seal-v1', 32))
}

function aad(purpose: SealPurpose): Buffer {
  return Buffer.from(`tazzzo-storefront:${purpose}:${VERSION}`)
}

/** Seals `value` for `purpose`, valid until `expiresAtMs`, with the FIRST key. Throws if the result is too large. */
export function seal(
  purpose: SealPurpose,
  value: unknown,
  expiresAtMs: number,
  keys: Buffer[],
): string {
  const key = keys[0]
  if (!key) throw new Error('no session key')
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', derive(key), iv)
  cipher.setAAD(aad(purpose))
  const plain = Buffer.from(JSON.stringify({ exp: expiresAtMs, v: value }))
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  const sealed = `${VERSION}.${iv.toString('base64url')}.${body.toString('base64url')}`
  if (sealed.length > MAX_SEALED_LENGTH) throw new Error('sealed value too large')
  return sealed
}

/** Opens a sealed value with any configured key (current first). Null unless it is valid, authentic and unexpired. */
export function unseal(
  purpose: SealPurpose,
  sealed: string | undefined,
  keys: Buffer[],
  nowMs: number,
): unknown {
  if (!sealed || sealed.length > MAX_SEALED_LENGTH) return null
  const parts = sealed.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION) return null
  const iv = Buffer.from(parts[1] ?? '', 'base64url')
  const body = Buffer.from(parts[2] ?? '', 'base64url')
  if (iv.length !== IV_BYTES || body.length <= TAG_BYTES) return null
  for (const key of keys) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', derive(key), iv)
      decipher.setAAD(aad(purpose))
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES))
      const plain = Buffer.concat([
        decipher.update(body.subarray(0, body.length - TAG_BYTES)),
        decipher.final(),
      ])
      const parsed = JSON.parse(plain.toString('utf8')) as { exp?: unknown; v?: unknown }
      return typeof parsed.exp === 'number' && parsed.exp > nowMs ? (parsed.v ?? null) : null
    } catch {
      // wrong key or tampered: try the next key
    }
  }
  return null
}
