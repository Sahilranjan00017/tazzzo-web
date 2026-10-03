import 'server-only'
import { NextResponse } from 'next/server'
import { NO_STORE_CACHE_CONTROL } from '@/lib/security/headers'

/** Redirect to a path on the CMS origin (absolute URL built from CMS_BASE_URL, never the request Host). */
export function redirectTo(
  cmsBaseUrl: string,
  path: string,
  status: 302 | 303 = 303,
): NextResponse {
  const response = NextResponse.redirect(new URL(path, cmsBaseUrl), status)
  response.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL)
  return response
}

/** Bounded, non-sensitive auth event log (reason codes only: never codes, tokens, ids, subjects or emails). */
export function logAuthEvent(event: string, reason: string): void {
  console.warn(JSON.stringify({ event, reason }))
}
