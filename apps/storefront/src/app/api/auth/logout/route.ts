import { readSession } from '@/server/session/cookies'
import { isSameOriginMutation } from '@/server/session/csrf'
import { forbidden, json } from '@/server/session/route'
import { signOut } from '@/server/session/service'

/**
 * `POST /api/auth/logout`: revokes the backend session (best effort) and clears the cookie. With a session, the
 * request must carry that session's CSRF token; without one there is nothing to protect and the cookie is cleared
 * anyway.
 */
export async function POST(request: Request) {
  const session = await readSession()
  if (!isSameOriginMutation(request.headers, session?.csrf ?? '1')) return forbidden()
  const { revoked } = await signOut(session)
  return json(200, { ok: true, revoked })
}
