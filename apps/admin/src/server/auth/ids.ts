import 'server-only'
import { createHash, randomBytes } from 'node:crypto'

/** 32 bytes from the CSPRNG, base64url (43 chars). Used for session and login-transaction identifiers. */
export function newOpaqueId(): string {
  return randomBytes(32).toString('base64url')
}

/** Store keys use a hash of the identifier, so a store dump holds no replayable cookie value. */
export function hashId(id: string): string {
  return createHash('sha256').update(id).digest('hex')
}

export const txKey = (txId: string) => `cms:tx:${hashId(txId)}`
export const sessionKey = (sessionId: string) => `cms:sess:${hashId(sessionId)}`
