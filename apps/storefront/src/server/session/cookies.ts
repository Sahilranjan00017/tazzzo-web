import 'server-only'
import { randomBytes } from 'node:crypto'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { serverEnv } from '@/server/env'
import { isAddressId, isPin, isSlotId } from '@/lib/location/validation'
import { seal, unseal, type SealPurpose } from '@/server/session/seal'

/**
 * Customer cookies. Both are sealed (see `seal.ts`), so the browser holds ciphertext only: the backend access and
 * refresh tokens never reach client JavaScript or the page.
 * - session: tokens + a per-session CSRF token; `HttpOnly; SameSite=Lax; Path=/`, `Secure` and the `__Host-` prefix
 *   whenever the site URL is https (production enforces https), no Domain, `Max-Age` = remaining session lifetime;
 * - challenge: the pending OTP challenge id (so it is bound to this browser), same attributes, lives as long as the
 *   code is valid;
 * - location: the delivery location (PIN, whether it is serviceable and, for a signed-in customer who picked a saved
 *   address, that address's id with the customer it belongs to), same attributes, 90 days. Signed-out visitors have one too;
 * - checkout: the delivery address and slot a signed-in customer picked, kept for the order step (30 minutes).
 * Plain-http local development cannot use `__Host-`/`Secure` in every browser, so it uses separate `*_dev` names
 * without `Secure`; nothing else is relaxed (the admin app follows the same rule).
 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60 // the backend's default session lifetime; it ends it earlier if shorter

export const LOCATION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60
export const CHECKOUT_CHOICE_MAX_AGE_SECONDS = 30 * 60

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

export interface LocationCookie {
  pin: string
  /** The backend's answer when the PIN was checked; null when it could not tell. */
  serviceable: boolean | null
  /** A saved address chosen as the delivery location. Only honoured for `customerId` (see `locationFor`). */
  addressId?: string
  customerId?: string
  expiresAt: number
}

const locationSchema = z.object({
  pin: z.string().refine(isPin),
  serviceable: z.boolean().nullable(),
  addressId: z.string().refine(isAddressId).optional(),
  customerId: z.string().min(1).max(128).optional(),
  expiresAt: z.number().int(),
})

export interface CheckoutChoice {
  customerId: string
  addressId: string
  slotId: string
  expiresAt: number
}

const checkoutSchema = z.object({
  customerId: z.string().min(1).max(128),
  addressId: z.string().refine(isAddressId),
  slotId: z.string().refine(isSlotId),
  expiresAt: z.number().int(),
})

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url')
}

function policy() {
  const secure = new URL(serverEnv().siteUrl).protocol === 'https:'
  return secure
    ? {
        session: '__Host-tz_session',
        challenge: '__Host-tz_otp',
        location: '__Host-tz_loc',
        checkout: '__Host-tz_checkout',
        secure,
      }
    : {
        session: 'tz_session_dev',
        challenge: 'tz_otp_dev',
        location: 'tz_loc_dev',
        checkout: 'tz_checkout_dev',
        secure,
      }
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
  name: 'session' | 'challenge' | 'location' | 'checkout',
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

/** The stored delivery location, or null (none, tampered, expired). Never calls the backend. */
export function readLocation(now = Date.now()): Promise<LocationCookie | null> {
  return read('location', 'location', locationSchema, now)
}

/** Route handlers only. The cookie lives `LOCATION_MAX_AGE_SECONDS` from `now`. */
export async function writeLocation(
  location: Omit<LocationCookie, 'expiresAt'>,
  now = Date.now(),
): Promise<void> {
  const keys = serverEnv().sessionKeys
  if (!keys) throw new Error('customer sessions are not configured')
  const expiresAt = now + LOCATION_MAX_AGE_SECONDS * 1000
  const sealed = seal('location', { ...location, expiresAt }, expiresAt, keys)
  const p = policy()
  ;(await cookies()).set(p.location, sealed, attributes(p.secure, LOCATION_MAX_AGE_SECONDS))
}

export async function clearLocation(): Promise<void> {
  const p = policy()
  ;(await cookies()).set(p.location, '', attributes(p.secure, 0))
}

/** Keeps the PIN but forgets the saved address (sign-out, the address was deleted). No-op without a location. */
export async function unbindLocationAddress(): Promise<void> {
  const current = await readLocation()
  if (current?.addressId === undefined) return
  await writeLocation({ pin: current.pin, serviceable: current.serviceable })
}

export function readCheckoutChoice(now = Date.now()): Promise<CheckoutChoice | null> {
  return read('checkout', 'checkout', checkoutSchema, now)
}

export async function writeCheckoutChoice(
  choice: Omit<CheckoutChoice, 'expiresAt'>,
  now = Date.now(),
): Promise<void> {
  const keys = serverEnv().sessionKeys
  if (!keys) throw new Error('customer sessions are not configured')
  const expiresAt = now + CHECKOUT_CHOICE_MAX_AGE_SECONDS * 1000
  const sealed = seal('checkout', { ...choice, expiresAt }, expiresAt, keys)
  const p = policy()
  ;(await cookies()).set(p.checkout, sealed, attributes(p.secure, CHECKOUT_CHOICE_MAX_AGE_SECONDS))
}

export async function clearCheckoutChoice(): Promise<void> {
  const p = policy()
  ;(await cookies()).set(p.checkout, '', attributes(p.secure, 0))
}
