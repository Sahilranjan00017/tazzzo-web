import 'server-only'
import * as client from 'openid-client'
import { GOOGLE_ISSUER, oidcIssuer, type ServerEnv } from '@/server/env'

export const CALLBACK_PATH = '/api/auth/google/callback'

/** The exact registered redirect URI, from CMS_BASE_URL only (never the request's Host / X-Forwarded-Host). */
export function redirectUri(env: ServerEnv): string {
  return new URL(CALLBACK_PATH, env.CMS_BASE_URL).toString()
}

let cachedConfig: Promise<client.Configuration> | undefined

/**
 * Discovered OIDC client configuration (cached). Production talks only to Google over TLS. A plain-http issuer is
 * allowed solely for a loopback test/dev issuer outside production; env validation already forbids any non-Google
 * issuer in production. ID-token JWS signatures are verified (`enableNonRepudiationChecks`) in addition to openid-client's
 * issuer/audience/expiry/nonce checks.
 */
export function oidcConfiguration(env: ServerEnv): Promise<client.Configuration> {
  cachedConfig ??= discover(env).catch((error: unknown) => {
    cachedConfig = undefined
    throw error
  })
  return cachedConfig
}

function discover(env: ServerEnv): Promise<client.Configuration> {
  const issuer = new URL(oidcIssuer(env))
  const execute: Array<(config: client.Configuration) => void> = [client.enableNonRepudiationChecks]
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(issuer.hostname)
  if (issuer.protocol === 'http:') {
    if (
      env.NODE_ENV === 'production' ||
      !loopback ||
      issuer.origin === new URL(GOOGLE_ISSUER).origin
    ) {
      throw new Error('insecure OIDC issuer refused')
    }
    execute.push(client.allowInsecureRequests)
  }
  return client.discovery(issuer, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, undefined, {
    execute,
  })
}

export interface AuthorizationRequest {
  url: URL
  state: string
  oidcNonce: string
  codeVerifier: string
}

/** Authorization-code request: response_type=code, scope `openid email`, PKCE S256, state, OIDC nonce, hd hint. */
export async function buildAuthorizationRequest(env: ServerEnv): Promise<AuthorizationRequest> {
  const config = await oidcConfiguration(env)
  const codeVerifier = client.randomPKCECodeVerifier()
  const state = client.randomState()
  const oidcNonce = client.randomNonce()
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(env),
    response_type: 'code',
    scope: 'openid email',
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce: oidcNonce,
    // UX hint only (pre-selects the Workspace account). The backend enforces the hosted domain.
    hd: env.GOOGLE_HOSTED_DOMAIN,
  })
  return { url, state, oidcNonce, codeVerifier }
}

export interface VerifiedLogin {
  idToken: string
  idTokenExpSeconds: number
}

/**
 * Completes the code exchange. openid-client validates the callback `state`, sends the PKCE verifier, and validates
 * the ID token (signature, issuer, audience, expiry, nonce). The access token is discarded here.
 */
export async function completeAuthorization(
  env: ServerEnv,
  callbackQuery: string,
  expected: { state: string; oidcNonce: string; codeVerifier: string },
): Promise<VerifiedLogin> {
  const config = await oidcConfiguration(env)
  const currentUrl = new URL(`${CALLBACK_PATH}${callbackQuery}`, env.CMS_BASE_URL)
  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: expected.codeVerifier,
    expectedState: expected.state,
    expectedNonce: expected.oidcNonce,
    idTokenExpected: true,
  })
  const claims = tokens.claims()
  if (!tokens.id_token || !claims || typeof claims.exp !== 'number') {
    throw new Error('id token missing')
  }
  return { idToken: tokens.id_token, idTokenExpSeconds: claims.exp }
}
