import 'server-only'

/**
 * Cookie policy. Production (https `CMS_BASE_URL`, enforced in production by env validation): `__Host-` prefix,
 * Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. Plain-http local development cannot use `__Host-`/Secure in every
 * browser, so it uses clearly separate `*_dev` names without Secure; nothing else is relaxed. The values are opaque
 * random identifiers only: never a token, email, role or actor id.
 */
export interface CookiePolicy {
  sessionName: string
  transactionName: string
  secure: boolean
}

export function cookiePolicy(cmsBaseUrl: string): CookiePolicy {
  const secure = new URL(cmsBaseUrl).protocol === 'https:'
  return secure
    ? { sessionName: '__Host-tz_cms_session', transactionName: '__Host-tz_cms_tx', secure: true }
    : { sessionName: 'tz_cms_session_dev', transactionName: 'tz_cms_tx_dev', secure: false }
}

export const SESSION_COOKIE_NAMES = ['__Host-tz_cms_session', 'tz_cms_session_dev'] as const

export function cookieAttributes(policy: CookiePolicy, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: policy.secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
  }
}

/** Opaque identifiers are 32 random bytes, base64url: exactly 43 characters of [A-Za-z0-9_-]. */
export function isOpaqueId(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value)
}
