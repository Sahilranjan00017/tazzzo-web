import 'server-only'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Application-layer encryption of the Google ID token before it is written to the session store (defense in depth on
 * top of store TLS/at-rest encryption). AES-256-GCM from Node's crypto, 96-bit random IV per encryption, 128-bit tag,
 * fixed associated data. Versioned envelope: `{ v, kid, iv, ct, tag }` (base64url fields) serialized as JSON.
 *
 * Rotation: encrypt with the current key; decrypt with the key whose `kid` matches (current, else previous).
 */
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const AAD = Buffer.from('tazzzo-cms-session-id-token:v1')

export interface TokenCipherKeys {
  current: Buffer
  previous?: Buffer
}

interface Envelope {
  v: 1
  kid: string
  iv: string
  ct: string
  tag: string
}

/** Non-secret key identifier: a short prefix of the key's SHA-256 (lets decryption pick the right key). */
export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('token cipher key must be 32 bytes')
}

export function encryptToken(plaintext: string, keys: TokenCipherKeys): string {
  assertKey(keys.current)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, keys.current, iv)
  cipher.setAAD(AAD)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const envelope: Envelope = {
    v: 1,
    kid: keyId(keys.current),
    iv: iv.toString('base64url'),
    ct: ct.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  }
  return JSON.stringify(envelope)
}

/** Throws on any tampering, wrong key, unknown version or malformed envelope. */
export function decryptToken(serialized: string, keys: TokenCipherKeys): string {
  const envelope = JSON.parse(serialized) as Partial<Envelope>
  if (envelope.v !== 1 || !envelope.kid || !envelope.iv || !envelope.ct || !envelope.tag) {
    throw new Error('malformed token envelope')
  }
  const key = [keys.current, keys.previous].find(
    (k) => k !== undefined && keyId(k) === envelope.kid,
  )
  if (!key) throw new Error('no key for token envelope')
  assertKey(key)
  const iv = Buffer.from(envelope.iv, 'base64url')
  const tag = Buffer.from(envelope.tag, 'base64url')
  if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error('malformed token envelope')
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 })
  decipher.setAAD(AAD)
  decipher.setAuthTag(tag)
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}
