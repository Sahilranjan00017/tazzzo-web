/**
 * Security-header policy for Tazzzo Admin. Pure functions with no secrets, so both `next.config.ts` (static headers)
 * and `src/proxy.ts` (per-request CSP) can use them.
 *
 * Naming: `cspNonce` is the per-request CONTENT SECURITY POLICY nonce. It is unrelated to the future OIDC login
 * `nonce` (W2), which binds a Google ID token to a login transaction. Never reuse one for the other.
 */

/** Response headers that are identical for every response (pages, assets, future route handlers). */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
})

/** `Cache-Control` for responses that must never be stored (authenticated pages and auth routes, from W2). */
export const NO_STORE_CACHE_CONTROL = 'no-store'

const NONCE_BYTES = 16

/** A fresh, unpredictable CSP nonce: 16 random bytes, base64-encoded. Generated once per request. */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export interface CspOptions {
  cspNonce: string
  /** Development only: React needs `'unsafe-eval'` for debugging, and dev styles are injected inline. */
  isDev: boolean
}

/**
 * Strict, nonce-based CSP following the current Next.js App Router guidance: scripts only from this origin with the
 * request's nonce (`'strict-dynamic'` lets nonce'd bootstrap scripts load their chunks); no plugins; no framing; no
 * `<base>` hijack; forms only to this origin. Production never contains `'unsafe-inline'` or `'unsafe-eval'`.
 */
export function buildContentSecurityPolicy({ cspNonce, isDev }: CspOptions): string {
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(cspNonce)) {
    throw new Error('cspNonce must be a non-empty base64 value')
  }
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    [
      'script-src',
      ["'self'", `'nonce-${cspNonce}'`, "'strict-dynamic'", ...(isDev ? ["'unsafe-eval'"] : [])],
    ],
    ['style-src', ["'self'", isDev ? "'unsafe-inline'" : `'nonce-${cspNonce}'`]],
    ['img-src', ["'self'", 'blob:', 'data:']],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ]
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ')
}
