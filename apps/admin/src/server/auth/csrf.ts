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

/**
 * CSRF rule for the few cookie-authenticated BFF READS (JSON GETs fetched by our own pages): the custom header
 * `X-Tazzzo-CSRF: 1` is required (a cross-site page cannot set it without a CORS preflight, which is never allowed), and an
 * `Origin`, when the browser sends one, must be the CMS origin. Same-origin GET fetches carry no `Origin`, so unlike a
 * mutation a missing Origin is accepted here. File downloads (plain navigations) use no such rule: they cannot carry the
 * header, return only the signed-in human's own data as an attachment, and nothing cross-origin can read the response.
 */
export function isSameOriginRead(headers: Headers, cmsBaseUrl: string): boolean {
  if (headers.get(CSRF_HEADER) !== '1') return false
  const origin = headers.get('origin')
  return origin === null || origin === new URL(cmsBaseUrl).origin
}
