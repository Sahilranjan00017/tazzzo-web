import 'server-only'
import { z } from 'zod'
import { sendJson } from '@/server/backend/client'

/**
 * Typed calls over the customer auth contract (tazzzo-backend `OtpController`, `SessionController`,
 * `CustomerProfileController`): OTP request -> OTP verify (grant) -> session establish -> refresh / logout, and the
 * profile read. Every success body is parsed with a strict-enough schema; a body that does not match is reported as
 * `unavailable`, never passed on. Tokens exist only inside these results and the sealed session cookie.
 */
export type CustomerFailure = {
  ok: false
  kind: 'unauthenticated' | 'rejected' | 'rate_limited' | 'unavailable'
  /** The backend's public error code (`OTP_INVALID`, `OTP_EXPIRED`, ...), or null. */
  code: string | null
  retryAfterSeconds: number | null
}
export type CustomerResult<T> = { ok: true; data: T } | CustomerFailure

const token = z
  .string()
  .min(20)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/)

const otpRequested = z.object({
  challengeId: z.string().regex(/^OTP_[A-Za-z0-9_-]{20,40}$/),
  expiresInSeconds: z.number().int().min(1).max(86_400),
  resendAfterSeconds: z.number().int().min(0).max(86_400),
})
const otpVerified = z.object({
  verified: z.literal(true),
  grantId: z.string().regex(/^GRANT_[A-Za-z0-9_-]{20,40}$/),
})
const refreshToken = z.string().regex(/^SES_[A-Za-z0-9_-]{6,64}\.[A-Za-z0-9_-]{20,64}$/)
const established = z.object({
  customerId: z.string().min(1).max(128),
  accessToken: token,
  accessTokenExpiresIn: z.number().int().min(1).max(86_400),
  refreshToken,
})
const refreshed = established.omit({ customerId: true })
const profile = z.object({
  customerId: z.string().min(1).max(128),
  displayName: z.string().max(200).nullish(),
  email: z.string().max(320).nullish(),
  version: z.number().int().nonnegative().optional(),
})

export type OtpChallenge = z.infer<typeof otpRequested>
export type SessionTokens = z.infer<typeof refreshed>
export type EstablishedSession = z.infer<typeof established>
export type CustomerProfile = {
  customerId: string
  displayName: string | null
  email: string | null
}

async function call<T>(
  schema: z.ZodType<T>,
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; bearer?: string } = {},
): Promise<CustomerResult<T>> {
  const result = await sendJson(method, path, options)
  if (!result.ok) return result
  const parsed = schema.safeParse(result.data)
  if (!parsed.success) {
    console.warn(`storefront_backend_malformed path=${path}`)
    return { ok: false, kind: 'unavailable', code: null, retryAfterSeconds: null }
  }
  return { ok: true, data: parsed.data }
}

/** `POST /v1/auth/otp/request`: `phone` must already be canonical `+91XXXXXXXXXX`. */
export const requestOtp = (phone: string) =>
  call(otpRequested, 'POST', '/v1/auth/otp/request', { body: { phone } })

/** `POST /v1/auth/otp/verify`: a correct code yields a short-lived grant, not yet a session. */
export const verifyOtp = (challengeId: string, otp: string) =>
  call(otpVerified, 'POST', '/v1/auth/otp/verify', { body: { challengeId, otp } })

/** `POST /v1/auth/session`: exchanges the grant for the first access and refresh tokens. */
export const establishSession = (grantId: string) =>
  call(established, 'POST', '/v1/auth/session', { body: { grantId } })

/** `POST /v1/auth/refresh`: rotates the refresh token; the presented one is dead afterwards. */
export const refreshTokens = (refreshTokenValue: string) =>
  call(refreshed, 'POST', '/v1/auth/refresh', { body: { refreshToken: refreshTokenValue } })

/** `POST /v1/auth/logout` (bearer): revokes the backend session. Idempotent; 204. */
export const logoutSession = (accessToken: string) =>
  call(z.undefined(), 'POST', '/v1/auth/logout', { bearer: accessToken })

/** `GET /v1/customer/profile` (bearer). */
export async function getProfile(accessToken: string): Promise<CustomerResult<CustomerProfile>> {
  const result = await call(profile, 'GET', '/v1/customer/profile', { bearer: accessToken })
  if (!result.ok) return result
  const { customerId, displayName, email } = result.data
  return { ok: true, data: { customerId, displayName: displayName ?? null, email: email ?? null } }
}
