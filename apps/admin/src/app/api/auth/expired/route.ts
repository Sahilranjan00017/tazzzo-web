import type { NextRequest } from 'next/server'
import { serverEnv } from '@/server/env'
import { cookieAttributes, cookiePolicy } from '@/server/auth/cookies'
import { sessionExists } from '@/server/session/session'
import { sessionStore } from '@/server/store/redis-store'
import { redirectTo } from '@/server/http/responses'

/**
 * Server Components cannot set cookies, so a protected page that finds its session invalid (and has already deleted
 * it) sends the browser here to expire the cookie. Harmless as a GET: a cookie whose session still exists is never
 * cleared, so a hostile link cannot log anyone out.
 */
export async function GET(request: NextRequest) {
  const env = serverEnv()
  const policy = cookiePolicy(env.CMS_BASE_URL)
  const value = request.cookies.get(policy.sessionName)?.value
  try {
    if (await sessionExists(sessionStore(), value)) return redirectTo(env.CMS_BASE_URL, '/')
  } catch {
    return redirectTo(env.CMS_BASE_URL, '/login?error=unavailable')
  }
  const response = redirectTo(env.CMS_BASE_URL, '/login?error=expired')
  if (value !== undefined) response.cookies.set(policy.sessionName, '', cookieAttributes(policy, 0))
  return response
}
