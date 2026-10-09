import 'server-only'
import { createHash } from 'node:crypto'
import { isChallengeId, isOtp, maskPhone, normalisePhone } from '@/lib/auth/validation'
import {
  establishSession,
  logoutSession,
  refreshTokens,
  requestOtp,
  verifyOtp,
  type CustomerFailure,
} from '@/server/backend/customer'
import {
  SESSION_MAX_AGE_SECONDS,
  clearChallenge,
  clearSession,
  newCsrfToken,
  readChallenge,
  writeChallenge,
  writeSession,
  type CustomerSession,
} from '@/server/session/cookies'

/**
 * Sign-in flows over the backend contract. Everything a caller (route handler, page) may learn is a closed set of
 * outcomes (`AuthError`); backend messages, ids and tokens stay in here. Nothing in this file logs.
 */
export type AuthError =
  'invalid_phone' | 'invalid_code' | 'expired' | 'rate_limited' | 'unavailable'

export type AuthOutcome<T> =
  { ok: true; data: T } | { ok: false; error: AuthError; retryAfterSeconds: number | null }

const fail = (error: AuthError, retryAfterSeconds: number | null = null) =>
  ({ ok: false, error, retryAfterSeconds }) as const

/** Access tokens are treated as expired this long before the backend would reject them (clock skew, request time). */
export const ACCESS_SKEW_MS = 30_000
/** Tokens issued this recently and still refused mean the session is dead: refresh must not loop. */
export const FRESH_TOKEN_WINDOW_MS = 15_000

function mapFailure(failure: CustomerFailure): AuthOutcome<never> {
  switch (failure.kind) {
    case 'rate_limited':
      return fail('rate_limited', failure.retryAfterSeconds)
    case 'rejected':
      return failure.code === 'OTP_EXPIRED' ? fail('expired') : fail('invalid_code')
    case 'unauthenticated':
      return fail('invalid_code')
    default:
      return fail('unavailable')
  }
}

/** Step 1: ask the backend to text a code. The challenge id is kept in a sealed cookie, never sent to the page. */
export async function startSignIn(
  rawPhone: unknown,
  now = Date.now(),
): Promise<
  AuthOutcome<{ maskedPhone: string; expiresInSeconds: number; resendAfterSeconds: number }>
> {
  const phone = normalisePhone(rawPhone)
  if (phone === null) return fail('invalid_phone')
  const result = await requestOtp(phone)
  if (!result.ok) {
    // The backend answers a malformed phone with 400 too; the shape was checked above, so this is not the customer's typo.
    return result.kind === 'rejected' ? fail('invalid_phone') : mapFailure(result)
  }
  const maskedPhone = maskPhone(phone)
  await writeChallenge(
    {
      challengeId: result.data.challengeId,
      maskedPhone,
      expiresAt: now + result.data.expiresInSeconds * 1000,
    },
    now,
  )
  return {
    ok: true,
    data: {
      maskedPhone,
      expiresInSeconds: result.data.expiresInSeconds,
      resendAfterSeconds: result.data.resendAfterSeconds,
    },
  }
}

/** Step 2: verify the code, exchange the grant for tokens and start the session cookie. */
export async function completeSignIn(
  rawOtp: unknown,
  now = Date.now(),
): Promise<AuthOutcome<null>> {
  if (!isOtp(rawOtp)) return fail('invalid_code')
  const challenge = await readChallenge(now)
  if (challenge === null || !isChallengeId(challenge.challengeId)) return fail('expired')
  const verified = await verifyOtp(challenge.challengeId, rawOtp)
  if (!verified.ok) return mapFailure(verified)
  const established = await establishSession(verified.data.grantId)
  if (!established.ok)
    return established.kind === 'rate_limited' ? mapFailure(established) : fail('unavailable')
  const data = established.data
  await writeSession(
    {
      customerId: data.customerId,
      accessToken: data.accessToken,
      accessExpiresAt: now + data.accessTokenExpiresIn * 1000,
      refreshToken: data.refreshToken,
      csrf: newCsrfToken(),
      issuedAt: now,
      expiresAt: now + SESSION_MAX_AGE_SECONDS * 1000,
    },
    now,
  )
  await clearChallenge()
  return { ok: true, data: null }
}

export function accessTokenUsable(session: CustomerSession, now = Date.now()): boolean {
  return session.accessExpiresAt - ACCESS_SKEW_MS > now
}

const inFlight = new Map<string, Promise<RefreshOutcome>>()

export type RefreshOutcome =
  { ok: true; session: CustomerSession } | { ok: false; reason: 'invalid' | 'unavailable' }

/**
 * Rotates the refresh token. The backend kills the presented token as soon as it rotates, so concurrent requests of
 * one browser in this process share ONE backend call (keyed by a digest of the token, never the token). Requests
 * that reach different instances at once can still lose the race; the loser is told `invalid` and signs in again.
 * Does not write the cookie: the caller does, so a read-only context can still refresh.
 */
export function refreshSession(
  session: CustomerSession,
  now = Date.now(),
): Promise<RefreshOutcome> {
  const key = createHash('sha256').update(session.refreshToken).digest('hex')
  const running = inFlight.get(key)
  if (running) return running
  const attempt = doRefresh(session, now).finally(() => inFlight.delete(key))
  inFlight.set(key, attempt)
  return attempt
}

async function doRefresh(session: CustomerSession, now: number): Promise<RefreshOutcome> {
  const result = await refreshTokens(session.refreshToken)
  if (!result.ok) {
    return {
      ok: false,
      reason:
        result.kind === 'unauthenticated' || result.kind === 'rejected' ? 'invalid' : 'unavailable',
    }
  }
  return {
    ok: true,
    session: {
      ...session,
      accessToken: result.data.accessToken,
      accessExpiresAt: now + result.data.accessTokenExpiresIn * 1000,
      refreshToken: result.data.refreshToken,
      issuedAt: now,
    },
  }
}

/**
 * Ends the session: revokes it at the backend when it can (refreshing an expired access token first), then clears
 * the cookie regardless. `revoked` is false when the backend could not be told; the cookie is gone either way.
 */
export async function signOut(
  session: CustomerSession | null,
  now = Date.now(),
): Promise<{ revoked: boolean }> {
  let revoked = false
  if (session) {
    let token: string | null = session.accessToken
    if (!accessTokenUsable(session, now)) {
      const refreshed = await refreshSession(session, now)
      token = refreshed.ok ? refreshed.session.accessToken : null
    }
    if (token) {
      const result = await logoutSession(token)
      revoked = result.ok || result.kind === 'unauthenticated'
    }
  }
  await clearSession()
  await clearChallenge()
  return { revoked }
}
