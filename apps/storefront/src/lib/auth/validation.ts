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
const MAX_DECODE_ROUNDS = 5

/** Why a path is unsafe at one decoding stage: another origin, a dot segment or an encoded separator. */
function pathIsUnsafe(path: string): boolean {
  if (!SAFE_PATH.test(path)) return true
  if (/%2f|%5c/i.test(path)) return true // an encoded slash or backslash survives some decoders
  return path.split('/').some((segment) => segment === '.' || segment === '..')
}

/**
 * Where to go after signing in. Only a same-origin path is accepted: one leading slash, no backslash or control
 * character, no `.`/`..` segment and no encoded slash or backslash, checked on the path as given and after every round
 * of percent-decoding up to a fixpoint (so `/.//evil`, `/%2e//evil`, `/x/..//evil`, `%252f` and friends are refused
 * BEFORE any URL parsing could collapse them into `//evil`). The result is then rebuilt by the URL parser and must
 * still be a single-slash path on the probe origin. Not `/api/*` and not `/login`. Anything else is `/account`.
 */
export function safeNext(raw: unknown): string {
  const fallback = '/account'
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return fallback
  const path = raw.split(/[?#]/, 1)[0] ?? ''
  let stage = path
  for (let round = 0; ; round++) {
    if (pathIsUnsafe(stage)) return fallback
    let decoded: string
    try {
      decoded = decodeURIComponent(stage)
    } catch {
      return fallback
    }
    if (decoded === stage) break
    if (round >= MAX_DECODE_ROUNDS) return fallback
    stage = decoded
  }
  const url = new URL(raw, PROBE_ORIGIN)
  const result = `${url.pathname}${url.search}${url.hash}`
  if (url.origin !== PROBE_ORIGIN || !/^\/(?![/\\])/.test(result) || url.pathname !== path) {
    return fallback
  }
  if (url.pathname.startsWith('/api/') || url.pathname === '/login') return fallback
  return result
}
