/**
 * Security-header policy for the Tazzzo storefront. Pure functions with no secrets, so both `next.config.ts` (static
 * headers) and `src/proxy.ts` (per-request CSP) can use them. Mirrors apps/admin's policy, with one storefront
 * difference: images may also come from the configured media (CDN) origin, and from nowhere else.
 */

/** Response headers that are identical for every response. HSTS belongs to the TLS-terminating edge, not the app. */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
})

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
  /** Origin of the media base (from `parseMediaBase`), or null when no image host is configured. */
  mediaOrigin: string | null
}

/**
 * Strict, nonce-based CSP (Next.js App Router guidance): scripts only from this origin with the request nonce, no
 * plugins, no framing, no `<base>` hijack, forms only to this origin (the search form). Images: this origin and the
 * media origin only. Production never contains `'unsafe-inline'` or `'unsafe-eval'`.
 */
export function buildContentSecurityPolicy({ cspNonce, isDev, mediaOrigin }: CspOptions): string {
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(cspNonce)) {
    throw new Error('cspNonce must be a non-empty base64 value')
  }
  if (mediaOrigin !== null && !/^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(mediaOrigin)) {
    throw new Error('mediaOrigin must be a bare origin')
  }
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    [
      'script-src',
      ["'self'", `'nonce-${cspNonce}'`, "'strict-dynamic'", ...(isDev ? ["'unsafe-eval'"] : [])],
    ],
    ['style-src', ["'self'", isDev ? "'unsafe-inline'" : `'nonce-${cspNonce}'`]],
    ['img-src', ["'self'", ...(mediaOrigin ? [mediaOrigin] : [])]],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ]
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ')
}
