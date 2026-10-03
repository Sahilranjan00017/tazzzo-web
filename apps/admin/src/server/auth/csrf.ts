import 'server-only'

export const CSRF_HEADER = 'x-tazzzo-csrf'

/**
 * V1 CSRF rule for cookie-authenticated mutations (W2: logout only): the request must carry the custom header
 * `X-Tazzzo-CSRF: 1` (a cross-site form cannot set it; a cross-site fetch would need a CORS preflight we never allow)
 * AND its Origin must be the CMS origin (Referer used only when Origin is absent).
 */
export function isSameOriginMutation(headers: Headers, cmsBaseUrl: string): boolean {
  if (headers.get(CSRF_HEADER) !== '1') return false
  const expected = new URL(cmsBaseUrl).origin
  const origin = headers.get('origin')
  if (origin !== null) return origin === expected
  const referer = headers.get('referer')
  if (referer === null) return false
  try {
    return new URL(referer).origin === expected
  } catch {
    return false
  }
}
