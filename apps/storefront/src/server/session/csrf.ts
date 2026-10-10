import 'server-only'
import { timingSafeEqual } from 'node:crypto'

export const CSRF_HEADER = 'x-tazzzo-csrf'

/**
 * CSRF rule for every state-changing customer route (all are `POST`, JSON, cookie-authenticated or about to set the
 * cookie). A request passes only if ALL hold:
 * - it carries `X-Tazzzo-CSRF` with the expected value: the literal `1` before sign-in, the per-session token after
 *   (a cross-site form cannot set a header, and a cross-site `fetch` would need a CORS preflight, which no route
 *   answers);
 * - `Sec-Fetch-Site`, when the browser sends it, is `same-origin` (not `same-site`: a sibling subdomain is not us);
 * - `Origin` is present and its host is the host this request was addressed to. The browser, not the page, writes
 *   both, so a page on another origin cannot make them agree. Comparing with the Host header (not a configured URL)
 *   keeps this correct behind the load balancer, which preserves Host.
 * `SameSite=Lax` on the cookie is a further, independent layer.
 */
export function isSameOriginMutation(headers: Headers, expectedToken = '1'): boolean {
  const presented = headers.get(CSRF_HEADER)
  if (presented === null || !constantTimeEqual(presented, expectedToken)) return false
  const fetchSite = headers.get('sec-fetch-site')
  if (fetchSite !== null && fetchSite !== 'same-origin') return false
  const origin = headers.get('origin')
  const host = headers.get('host')
  if (origin === null || host === null) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * A top-level navigation to a side-effecting `GET` (the refresh redirect) must come from this site or from nowhere
 * (typed URL, bookmark). `Sec-Fetch-Site: cross-site` / `same-site` is refused.
 */
export function isSameSiteNavigation(headers: Headers): boolean {
  const fetchSite = headers.get('sec-fetch-site')
  return fetchSite === null || fetchSite === 'same-origin' || fetchSite === 'none'
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
