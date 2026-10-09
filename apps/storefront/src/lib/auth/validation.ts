/**
 * Input grammar for customer sign-in, shared by the browser form (early feedback) and the server routes (the check
 * that counts). Mirrors the backend contract (tazzzo-backend `Phone`, `OtpService`, `OpaqueIds`); the backend
 * validates again. Pure; no secrets.
 */

/** Canonical wire form: India only, `+91` and a ten digit mobile number starting 6-9 (backend `Phone`). */
const CANONICAL_PHONE = /^\+91[6-9][0-9]{9}$/
const OTP_SHAPE = /^[0-9]{6}$/
const CHALLENGE_ID = /^OTP_[A-Za-z0-9_-]{20,40}$/

/**
 * The canonical `+91XXXXXXXXXX` for what a customer typed, or null. Accepts `+91`, a bare ten digits or a single
 * leading `0` (the backend's three shapes); spaces and hyphens typed between digits are dropped, nothing else is.
 */
export function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 32) return null
  const compact = raw.trim().replace(/[ -]/g, '')
  if (CANONICAL_PHONE.test(compact)) return compact
  if (/^[6-9][0-9]{9}$/.test(compact)) return `+91${compact}`
  if (/^0[6-9][0-9]{9}$/.test(compact)) return `+91${compact.slice(1)}`
  return null
}

export function isOtp(value: unknown): value is string {
  return typeof value === 'string' && OTP_SHAPE.test(value)
}

export function isChallengeId(value: unknown): value is string {
  return typeof value === 'string' && CHALLENGE_ID.test(value)
}

/** `+919876543210` -> `+91 ******3210`: what the page may show of a phone number. */
export function maskPhone(canonical: string): string {
  return `+91 ******${canonical.slice(-4)}`
}

const SAFE_PATH = /^\/(?![/\\])[^\\\u0000-\u001f\u007f]*$/
const PROBE_ORIGIN = 'https://next.invalid'

/**
 * Where to go after signing in. Only a same-origin path is accepted: a single leading slash, no backslash or control
 * character (also after percent-decoding), nothing that resolves to another origin, no `/api/` route and not the
 * sign-in pages themselves. Anything else is `/account`.
 */
export function safeNext(raw: unknown): string {
  const fallback = '/account'
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512 || !SAFE_PATH.test(raw)) {
    return fallback
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return fallback
  }
  if (!SAFE_PATH.test(decoded)) return fallback
  const url = new URL(raw, PROBE_ORIGIN)
  if (url.origin !== PROBE_ORIGIN) return fallback
  if (url.pathname.startsWith('/api/') || url.pathname === '/login') return fallback
  return `${url.pathname}${url.search}${url.hash}`
}
