import type { NextRequest } from 'next/server'
import { serverEnv } from '@/server/env'
import { cookieAttributes, cookiePolicy } from '@/server/auth/cookies'
import { buildAuthorizationRequest } from '@/server/auth/oidc'
import { safeReturnTo } from '@/server/auth/return-to'
import { createTransaction, TRANSACTION_TTL_SECONDS } from '@/server/auth/transaction'
import { sessionStore } from '@/server/store/redis-store'
import { logAuthEvent, redirectTo } from '@/server/http/responses'

/**
 * GET login start (a plain navigation, so the strict `form-action 'self'` CSP is never involved). Stores
 * state, OIDC nonce, PKCE verifier and return path server-side and sends the browser to the provider with only an
 * opaque transaction cookie.
 */
export async function GET(request: NextRequest) {
  const env = serverEnv()
  const policy = cookiePolicy(env.CMS_BASE_URL)
  try {
    const authorization = await buildAuthorizationRequest(env)
    const txId = await createTransaction(
      sessionStore(),
      {
        state: authorization.state,
        oidcNonce: authorization.oidcNonce,
        codeVerifier: authorization.codeVerifier,
        returnTo: safeReturnTo(request.nextUrl.searchParams.get('returnTo')),
      },
      Date.now(),
    )
    const response = redirectTo(env.CMS_BASE_URL, authorization.url.toString(), 302)
    response.cookies.set(
      policy.transactionName,
      txId,
      cookieAttributes(policy, TRANSACTION_TTL_SECONDS),
    )
    return response
  } catch {
    logAuthEvent('cms_login_start_failed', 'unavailable')
    return redirectTo(env.CMS_BASE_URL, '/login?error=unavailable')
  }
}
