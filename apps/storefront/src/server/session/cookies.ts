import 'server-only'
import { randomBytes } from 'node:crypto'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { serverEnv } from '@/server/env'
import { seal, unseal, type SealPurpose } from '@/server/session/seal'

/**
 * Customer cookies. Both are sealed (see `seal.ts`), so the browser holds ciphertext only: the backend access and
 * refresh tokens never reach client JavaScript or the page.
 * - session: tokens + a per-session CSRF token; `HttpOnly; SameSite=Lax; Path=/`, `Secure` and the `__Host-` prefix
 *   whenever the site URL is https (production enforces https), no Domain, `Max-Age` = remaining session lifetime;
 * - challenge: the pending OTP challenge id (so it is bound to this browser), same attributes, lives as long as the
 *   code is valid.
 * Plain-http local development cannot use `__Host-`/`Secure` in every browser, so it uses separate `*_dev` names
 * without `Secure`; nothing else is relaxed (the admin app follows the same rule).
 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60 // the backend's default session lifetime; it ends it earlier if shorter

export interface CustomerSession {
  customerId: string
  accessToken: string
  /** When the access token stops being accepted (ms since epoch). */
  accessExpiresAt: number
  refreshToken: string
  /** Per-session CSRF token the page hands to the logout call; not an authenticator by itself. */
  csrf: string
  /** When these tokens were issued (sign-in or last refresh), ms. Guards against refresh loops. */
  issuedAt: number
  /** Absolute end of the session, ms. */
  expiresAt: number
}

const sessionSchema = z.object({
  customerId: z.string().min(1).max(128),
  accessToken: z.string().min(1).max(4096),
  accessExpiresAt: z.number().int(),
  refreshToken: z.string().min(1).max(256),
  csrf: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
})

export interface PendingChallenge {
  challengeId: string
  maskedPhone: string
  expiresAt: number
}

const challengeSchema = z.object({
  challengeId: z.string().regex(/^OTP_[A-Za-z0-9_-]{20,40}$/),
  maskedPhone: z.string().max(32),
  expiresAt: z.number().int(),
})

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url')
}

function policy() {
  const secure = new URL(serverEnv().siteUrl).protocol === 'https:'
  return secure
    ? { session: '__Host-tz_session', challenge: '__Host-tz_otp', secure }
    : { session: 'tz_session_dev', challenge: 'tz_otp_dev', secure }
}

function attributes(secure: boolean, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
  }
}

/** False when no sealing key is configured (non-production only): sign-in is then unavailable. */
export function customerSessionsEnabled(): boolean {
  return serverEnv().sessionKeys !== null
}

async function read<T>(
  name: 'session' | 'challenge',
  purpose: SealPurpose,
  schema: z.ZodType<T>,
  now: number,
): Promise<T | null> {
  const keys = serverEnv().sessionKeys
  if (!keys) return null
  const raw = (await cookies()).get(policy()[name])?.value
  const parsed = schema.safeParse(unseal(purpose, raw, keys, now))
  return parsed.success ? parsed.data : null
}

/** The current session, or null (no cookie, tampered, wrong key, expired). Never calls the backend. */
export function readSession(now = Date.now()): Promise<CustomerSession | null> {
  return read('session', 'session', sessionSchema, now)
}

export function readChallenge(now = Date.now()): Promise<PendingChallenge | null> {
  return read('challenge', 'challenge', challengeSchema, now)
}

/** Route handlers and server actions only (a server component cannot set cookies). */
export async function writeSession(session: CustomerSession, now = Date.now()): Promise<void> {
  const keys = serverEnv().sessionKeys
  if (!keys) throw new Error('customer sessions are not configured')
  const sealed = seal('session', session, session.expiresAt, keys)
  const p = policy()
  ;(await cookies()).set(p.session, sealed, attributes(p.secure, (session.expiresAt - now) / 1000))
}

export async function writeChallenge(challenge: PendingChallenge, now = Date.now()): Promise<void> {
  const keys = serverEnv().sessionKeys
  if (!keys) throw new Error('customer sessions are not configured')
  const sealed = seal('challenge', challenge, challenge.expiresAt, keys)
  const p = policy()
  ;(await cookies()).set(
    p.challenge,
    sealed,
    attributes(p.secure, (challenge.expiresAt - now) / 1000),
  )
}

export async function clearSession(): Promise<void> {
  const p = policy()
  ;(await cookies()).set(p.session, '', attributes(p.secure, 0))
}

export async function clearChallenge(): Promise<void> {
  const p = policy()
  ;(await cookies()).set(p.challenge, '', attributes(p.secure, 0))
}
