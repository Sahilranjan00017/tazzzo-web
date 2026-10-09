import { NextResponse } from 'next/server'
import { safeNext } from '@/lib/auth/validation'
import { clearSession, readSession, writeSession } from '@/server/session/cookies'
import { isSameSiteNavigation } from '@/server/session/csrf'
import { FRESH_TOKEN_WINDOW_MS, accessTokenUsable, refreshSession } from '@/server/session/service'

/**
 * `GET /api/auth/refresh?next=/path`: rotates the backend tokens, rewrites the cookie and redirects to `next`. Pages
 * cannot set cookies, so a page that finds the access token expired (or refused) sends the browser here. Only a
 * same-site navigation is served, `next` is reduced to a same-origin path, and a page that reports (`rejected=1`) tokens
 * the backend refused moments after they were issued ends the session instead of looping.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const next = safeNext(params.get('next'))
  const to = (path: string) =>
    new NextResponse(null, {
      status: 303,
      headers: { Location: path, 'Cache-Control': 'no-store' },
    })
  const login = (reason?: string) =>
    to(`/login?next=${encodeURIComponent(next)}${reason ? `&reason=${reason}` : ''}`)
  if (!isSameSiteNavigation(request.headers)) return to('/')
  const session = await readSession()
  if (session === null) return login()
  if (Date.now() - session.issuedAt < FRESH_TOKEN_WINDOW_MS && params.get('rejected') === '1') {
    await clearSession()
    return login('expired')
  }
  const result = await refreshSession(session)
  // Tokens that are already unusable the moment they are issued would send the page straight back here.
  if (result.ok && accessTokenUsable(result.session)) {
    await writeSession(result.session)
    return to(next)
  }
  if (result.ok || result.reason === 'invalid') {
    await clearSession()
    return login('expired')
  }
  return login('unavailable')
}
