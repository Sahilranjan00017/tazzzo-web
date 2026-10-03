import type { NextRequest } from 'next/server'
import { serverEnv } from '@/server/env'
import { cookieAttributes, cookiePolicy, isOpaqueId } from '@/server/auth/cookies'
import { completeAuthorization } from '@/server/auth/oidc'
import { consumeTransaction } from '@/server/auth/transaction'
import { sessionConfig } from '@/server/session/config'
import { createSession } from '@/server/session/session'
import { sessionStore } from '@/server/store/redis-store'
import { logAuthEvent, redirectTo } from '@/server/http/responses'

/**
 * OAuth callback: consume the single-use transaction, let openid-client validate state, PKCE, nonce and the ID token,
 * then create a fresh server-side session and redirect at once (no page renders here, so the code never reaches a
 * Referer or third-party asset). Any failure: no session, transaction gone, transaction cookie expired.
 */
export async function GET(request: NextRequest) {
  const env = serverEnv()
  const policy = cookiePolicy(env.CMS_BASE_URL)
  const store = sessionStore()
  const now = Date.now()

  const fail = (reason: string) => {
    logAuthEvent('cms_login_failed', reason)
    const response = redirectTo(env.CMS_BASE_URL, '/login?error=signin_failed')
    response.cookies.set(policy.transactionName, '', cookieAttributes(policy, 0))
    return response
  }

  const txId = request.cookies.get(policy.transactionName)?.value
  if (!isOpaqueId(txId)) return fail('missing_transaction')
  try {
    const transaction = await consumeTransaction(store, txId, now)
    if (!transaction) return fail('unknown_transaction')
    let login
    try {
      login = await completeAuthorization(env, request.nextUrl.search, transaction)
    } catch {
      return fail('oidc_validation')
    }
    const session = await createSession(
      store,
      login.idToken,
      login.idTokenExpSeconds,
      sessionConfig(env),
      now,
    )
    if (!session) return fail('token_expiring')
    const response = redirectTo(env.CMS_BASE_URL, transaction.returnTo)
    response.cookies.set(policy.transactionName, '', cookieAttributes(policy, 0))
    response.cookies.set(
      policy.sessionName,
      session.sessionId,
      cookieAttributes(policy, (session.expiresAt - now) / 1000),
    )
    return response
  } catch {
    return fail('unavailable')
  }
}
