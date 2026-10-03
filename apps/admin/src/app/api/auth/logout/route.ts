import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { serverEnv } from '@/server/env'
import { cookieAttributes, cookiePolicy } from '@/server/auth/cookies'
import { isSameOriginMutation } from '@/server/auth/csrf'
import { endSession } from '@/server/session/session'
import { sessionStore } from '@/server/store/redis-store'
import { redirectTo } from '@/server/http/responses'
import { NO_STORE_CACHE_CONTROL } from '@/lib/security/headers'

/**
 * POST logout (CSRF: same Origin + `X-Tazzzo-CSRF: 1`). Deletes the server-side session and expires the cookie.
 * No global Google sign-out. Other methods get Next's 405.
 */
export async function POST(request: NextRequest) {
  const env = serverEnv()
  if (!isSameOriginMutation(request.headers, env.CMS_BASE_URL)) {
    return NextResponse.json(
      { error: 'forbidden' },
      { status: 403, headers: { 'Cache-Control': NO_STORE_CACHE_CONTROL } },
    )
  }
  const policy = cookiePolicy(env.CMS_BASE_URL)
  try {
    await endSession(sessionStore(), request.cookies.get(policy.sessionName)?.value)
  } catch {
    return NextResponse.json(
      { error: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': NO_STORE_CACHE_CONTROL } },
    )
  }
  const response = redirectTo(env.CMS_BASE_URL, '/login')
  response.cookies.set(policy.sessionName, '', cookieAttributes(policy, 0))
  return response
}
