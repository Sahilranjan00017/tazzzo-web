import 'server-only'
import { z } from 'zod'
import { decryptToken, encryptToken, type TokenCipherKeys } from '@/server/crypto/token-cipher'
import type { SessionStore } from '@/server/store/types'
import { newOpaqueId, sessionKey } from '@/server/auth/ids'
import { isOpaqueId } from '@/server/auth/cookies'

/** A session never outlives the Google ID token: it ends this long before the token's `exp`. */
export const ID_TOKEN_SAFETY_MARGIN_MS = 60_000
/** `lastSeenAt` is rewritten at most this often (bounded store writes for idle-timeout tracking). */
export const TOUCH_INTERVAL_MS = 60_000

const sessionRecordSchema = z.object({
  v: z.literal(1),
  idTokenEnc: z.string().min(1),
  createdAt: z.number(),
  expiresAt: z.number(),
  lastSeenAt: z.number(),
})

export type SessionRecord = z.infer<typeof sessionRecordSchema>

export interface SessionConfig {
  keys: TokenCipherKeys
  maxSeconds: number
  idleSeconds: number
}

export interface CreatedSession {
  sessionId: string
  expiresAt: number
}

/**
 * New session after a successful login: a fresh opaque id (never the transaction id), the ID token encrypted, and
 * expiry = min(token exp - margin, now + absolute cap). Returns null when the token is too close to expiry.
 */
export async function createSession(
  store: SessionStore,
  idToken: string,
  idTokenExpSeconds: number,
  config: SessionConfig,
  now: number,
): Promise<CreatedSession | null> {
  const expiresAt = Math.min(
    idTokenExpSeconds * 1000 - ID_TOKEN_SAFETY_MARGIN_MS,
    now + config.maxSeconds * 1000,
  )
  if (expiresAt <= now) return null
  const sessionId = newOpaqueId()
  const record: SessionRecord = {
    v: 1,
    idTokenEnc: encryptToken(idToken, config.keys),
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
  }
  await store.set(sessionKey(sessionId), JSON.stringify(record), expiresAt)
  return { sessionId, expiresAt }
}

export type SessionCheck =
  | { status: 'valid'; idToken: string; expiresAt: number }
  | { status: 'absent' }
  | { status: 'invalid' }

/**
 * Validates a session cookie value: format, record present, absolute expiry, idle timeout and decryptability.
 * An invalid record is deleted. A valid one has `lastSeenAt` refreshed at most every TOUCH_INTERVAL_MS.
 */
export async function checkSession(
  store: SessionStore,
  cookieValue: string | undefined,
  config: SessionConfig,
  now: number,
): Promise<SessionCheck> {
  if (cookieValue === undefined) return { status: 'absent' }
  if (!isOpaqueId(cookieValue)) return { status: 'invalid' }
  const key = sessionKey(cookieValue)
  const raw = await store.get(key)
  if (raw === null) return { status: 'invalid' }
  const parsed = sessionRecordSchema.safeParse(safeJson(raw))
  const record = parsed.success ? parsed.data : undefined
  if (!record || record.expiresAt <= now || now - record.lastSeenAt > config.idleSeconds * 1000) {
    await store.delete(key)
    return { status: 'invalid' }
  }
  let idToken: string
  try {
    idToken = decryptToken(record.idTokenEnc, config.keys)
  } catch {
    await store.delete(key)
    return { status: 'invalid' }
  }
  if (now - record.lastSeenAt >= TOUCH_INTERVAL_MS) {
    await store.set(key, JSON.stringify({ ...record, lastSeenAt: now }), record.expiresAt)
  }
  return { status: 'valid', idToken, expiresAt: record.expiresAt }
}

export async function endSession(
  store: SessionStore,
  cookieValue: string | undefined,
): Promise<void> {
  if (isOpaqueId(cookieValue)) await store.delete(sessionKey(cookieValue))
}

/** True when the cookie names a session that still exists (used to avoid clearing a live session's cookie). */
export async function sessionExists(
  store: SessionStore,
  cookieValue: string | undefined,
): Promise<boolean> {
  return isOpaqueId(cookieValue) && (await store.get(sessionKey(cookieValue))) !== null
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
