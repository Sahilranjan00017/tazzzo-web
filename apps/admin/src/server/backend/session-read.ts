import 'server-only'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import type { z } from 'zod'
import { cookiePolicy } from '@/server/auth/cookies'
import { serverEnv } from '@/server/env'
import { sessionConfig } from '@/server/session/config'
import { checkSession, endSession } from '@/server/session/session'
import { EXPIRED_PATH } from '@/server/session/admin-access'
import { sessionStore } from '@/server/store/redis-store'
import type { BackendReadResult } from '@/lib/backend-result'
import { backendRead } from './read'

/**
 * Server Component entry point for a backend read as the signed-in human. Session problems and a backend 401 end the
 * CMS session and redirect to re-authentication. A backend 403 is returned (the session stays valid) so the page can
 * show a permission-denied state. The token never leaves this function.
 */
export async function readAsAdmin<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<Exclude<BackendReadResult<T>, { kind: 'unauthenticated' }>> {
  const env = serverEnv()
  const store = sessionStore()
  const cookieValue = (await cookies()).get(cookiePolicy(env.CMS_BASE_URL).sessionName)?.value
  const session = await checkSession(store, cookieValue, sessionConfig(env), Date.now())
  if (session.status === 'absent') redirect('/login')
  if (session.status === 'invalid') redirect(EXPIRED_PATH)
  const result = await backendRead(
    { backendUrl: env.TAZZZO_BACKEND_URL, idToken: session.idToken },
    path,
    schema,
  )
  if (result.kind === 'unauthenticated') {
    await endSession(store, cookieValue).catch(() => undefined)
    redirect(EXPIRED_PATH)
  }
  return result
}
