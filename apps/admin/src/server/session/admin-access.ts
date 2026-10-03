import 'server-only'
import { fetchAdminMe, type AdminMe } from '@/server/backend/admin-me'
import type { SessionStore } from '@/server/store/types'
import { checkSession, endSession, type SessionConfig } from './session'

export const EXPIRED_PATH = '/api/auth/expired'

export type AdminAccess =
  | { action: 'render'; view: 'ok'; me: AdminMe }
  | { action: 'render'; view: 'forbidden' }
  | { action: 'render'; view: 'unavailable' }
  | { action: 'redirect'; to: string }

/**
 * The decision behind every protected page, kept free of Next request APIs so it is testable end to end:
 * no/invalid session -> login (via the cookie-clearing route); backend 401 -> end the session and re-login;
 * backend 403 -> keep the session, show access denied. Only a backend-approved identity reaches the app.
 */
export async function resolveAdminAccess(
  deps: {
    store: SessionStore
    config: SessionConfig
    backendUrl: string
    fetchImpl?: typeof fetch
  },
  cookieValue: string | undefined,
  now: number,
): Promise<AdminAccess> {
  const session = await checkSession(deps.store, cookieValue, deps.config, now)
  if (session.status === 'absent') return { action: 'redirect', to: '/login' }
  if (session.status === 'invalid') return { action: 'redirect', to: EXPIRED_PATH }
  const result = await fetchAdminMe(deps.backendUrl, session.idToken, deps.fetchImpl)
  if (result.kind === 'unauthenticated') {
    await endSession(deps.store, cookieValue)
    return { action: 'redirect', to: EXPIRED_PATH }
  }
  if (result.kind === 'forbidden') return { action: 'render', view: 'forbidden' }
  if (result.kind === 'unavailable') return { action: 'render', view: 'unavailable' }
  return { action: 'render', view: 'ok', me: result.me }
}
