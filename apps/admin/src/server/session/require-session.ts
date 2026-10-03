import 'server-only'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { serverEnv } from '@/server/env'
import { cookiePolicy } from '@/server/auth/cookies'
import { sessionStore } from '@/server/store/redis-store'
import { SessionStoreUnavailable } from '@/server/store/types'
import { sessionConfig } from './config'
import { checkSession } from './session'
import { EXPIRED_PATH, resolveAdminAccess, type AdminAccess } from './admin-access'

async function sessionCookieValue(): Promise<string | undefined> {
  const env = serverEnv()
  return (await cookies()).get(cookiePolicy(env.CMS_BASE_URL).sessionName)?.value
}

/**
 * Server Component guard for every protected page (deduplicated per request). Validates the server-side session
 * and bootstraps the backend identity via `/me`; redirects away otherwise. Never returns the ID token to callers.
 * Cookie presence alone is never trusted: the full check runs here, in the Node runtime.
 */
export const requireAdmin = cache(
  async (): Promise<Exclude<AdminAccess, { action: 'redirect' }>> => {
    const env = serverEnv()
    let access: AdminAccess
    try {
      access = await resolveAdminAccess(
        { store: sessionStore(), config: sessionConfig(env), backendUrl: env.TAZZZO_BACKEND_URL },
        await sessionCookieValue(),
        Date.now(),
      )
    } catch (error) {
      if (error instanceof SessionStoreUnavailable) return { action: 'render', view: 'unavailable' }
      throw error
    }
    if (access.action === 'redirect') redirect(access.to)
    return access
  },
)

/** For /login: true only for a fully valid session (cookie presence alone is not enough). */
export async function hasValidSession(): Promise<boolean> {
  const env = serverEnv()
  try {
    const check = await checkSession(
      sessionStore(),
      await sessionCookieValue(),
      sessionConfig(env),
      Date.now(),
    )
    return check.status === 'valid'
  } catch {
    return false
  }
}

export { EXPIRED_PATH }
