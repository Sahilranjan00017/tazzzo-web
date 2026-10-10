import 'server-only'
import { clearSession, writeSession, type CustomerSession } from '@/server/session/cookies'
import { accessTokenUsable, refreshSession } from '@/server/session/service'

/**
 * Route handlers only (they can set cookies): runs `flow` with a usable access token. An expired token is rotated
 * first; a token the backend refuses is rotated once and the flow re-run. A session the backend will not refresh is
 * ended. `outcomes` says how the caller's own result type spells "unauthenticated" and "unavailable", so the cart and
 * the addresses share one implementation. Nothing here logs.
 */
export async function withAccessToken<O extends { ok: boolean }>(
  session: CustomerSession,
  flow: (accessToken: string) => Promise<O>,
  outcomes: { unauthenticated: () => O; unavailable: () => O; isUnauthenticated: (o: O) => boolean },
): Promise<O> {
  let current = session
  let rotated = false
  const rotate = async (): Promise<O | null> => {
    const result = await refreshSession(current)
    if (!result.ok) {
      if (result.reason === 'invalid') {
        await clearSession()
        return outcomes.unauthenticated()
      }
      return outcomes.unavailable()
    }
    current = result.session
    rotated = true
    await writeSession(current)
    return null
  }
  if (!accessTokenUsable(current)) {
    const stopped = await rotate()
    if (stopped) return stopped
  }
  let outcome = await flow(current.accessToken)
  if (!outcome.ok && outcomes.isUnauthenticated(outcome) && !rotated) {
    const stopped = await rotate()
    if (stopped) return stopped
    outcome = await flow(current.accessToken)
  }
  if (!outcome.ok && outcomes.isUnauthenticated(outcome)) await clearSession()
  return outcome
}
