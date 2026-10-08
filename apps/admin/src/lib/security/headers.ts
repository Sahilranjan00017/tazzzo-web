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
  /**
   * The ONE object-storage origin the browser may PUT image bytes to (presigned upload URLs), added to `connect-src`
   * only. From `CMS_MEDIA_UPLOAD_ORIGIN`; must already be a canonical origin (see {@link parseCspOrigin}).
   */
  uploadOrigin?: string
  /** The ONE public media origin (CDN) admin thumbnails load from, added to `img-src` only (`CMS_MEDIA_PUBLIC_ORIGIN`). */
  imageOrigin?: string
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * A configured origin as a CSP source, or `undefined` when it is not exactly an origin: scheme + host (+ port), no path,
 * query, fragment, credentials or wildcard. https only; plain http is accepted only outside production and only for a
 * loopback host (local S3-compatible stores, the test fake). Pure, so the env schema and `proxy.ts` agree.
 */
export function parseCspOrigin(value: string | undefined, production: boolean): string | undefined {
  if (!value || value.includes('*')) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.origin === 'null' || url.origin !== value) return undefined
  if (url.protocol === 'https:') return url.origin
  if (url.protocol === 'http:' && !production && LOOPBACK_HOSTS.has(url.hostname)) return url.origin
  return undefined
}

/**
 * Strict, nonce-based CSP following the current Next.js App Router guidance: scripts only from this origin with the
 * request's nonce (`'strict-dynamic'` lets nonce'd bootstrap scripts load their chunks); no plugins; no framing; no
 * `<base>` hijack; forms only to this origin. Production never contains `'unsafe-inline'` or `'unsafe-eval'`.
 */
export function buildContentSecurityPolicy({
  cspNonce,
  isDev,
  uploadOrigin,
  imageOrigin,
}: CspOptions): string {
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(cspNonce)) {
    throw new Error('cspNonce must be a non-empty base64 value')
  }
  for (const origin of [uploadOrigin, imageOrigin]) {
    if (origin !== undefined && parseCspOrigin(origin, false) !== origin)
      throw new Error('CSP origins must be canonical origins')
  }
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    [
      'script-src',
      ["'self'", `'nonce-${cspNonce}'`, "'strict-dynamic'", ...(isDev ? ["'unsafe-eval'"] : [])],
    ],
    ['style-src', ["'self'", isDev ? "'unsafe-inline'" : `'nonce-${cspNonce}'`]],
    ['img-src', ["'self'", 'blob:', 'data:', ...(imageOrigin ? [imageOrigin] : [])]],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", ...(uploadOrigin ? [uploadOrigin] : [])]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ]
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ')
}
