// Runtime environment contract for the two Amplify (UAT) apps. NAMES ONLY: no value of any kind lives in this file.
//
// Amplify Hosting does not hand its console environment variables to the SSR/compute runtime; they exist at BUILD time
// only. `package-compute.mjs` therefore copies exactly the variables listed here from the build environment into the
// compute bundle (`runtime-env.json`, never into the static directory or any client bundle) and `index.js` loads them
// before the Next server starts. A variable that is not listed here is NOT forwarded, so adding one to an app's
// `serverEnv()` also needs a line here (the unit test fails if an `env.ts` name is missing from this contract).

/** @typedef {{ required: string[], optional: string[], secret: string[] }} EnvContract */

/** @type {Record<string, EnvContract>} */
export const CONTRACT = {
  // apps/storefront/src/server/env.ts + src/lib/security/rate-limit.ts
  storefront: {
    required: ['TAZZZO_API_BASE_URL', 'TAZZZO_SITE_URL'],
    optional: [
      'TAZZZO_MEDIA_BASE_URL',
      'TAZZZO_CALLER_NAME',
      'STOREFRONT_TRUST_PROXY',
      'STOREFRONT_TRUSTED_PROXY_HOPS',
      'STOREFRONT_ORDER_CANCEL_WINDOW_SECONDS',
      'STOREFRONT_RATE_LIMIT_PER_MINUTE',
      'STOREFRONT_RATE_LIMIT_BURST',
      'STOREFRONT_RATE_LIMIT_EXPENSIVE_PER_MINUTE',
      'STOREFRONT_RATE_LIMIT_EXPENSIVE_BURST',
      'STOREFRONT_RATE_LIMIT_MAX_CLIENTS',
    ],
    // STOREFRONT_SESSION_SECRET is optional for the schema outside production but REQUIRED in production, which is what a
    // deployed UAT is (NODE_ENV=production), so it is listed as required below via `requiredSecrets`.
    secret: [
      'STOREFRONT_SESSION_SECRET',
      'STOREFRONT_SESSION_SECRET_PREVIOUS',
      'TAZZZO_CALLER_SECRET',
    ],
  },
  // apps/admin/src/server/env.ts + src/proxy.ts. GOOGLE_ISSUER is a test seam and is deliberately NOT forwardable.
  admin: {
    required: ['CMS_BASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_HOSTED_DOMAIN', 'TAZZZO_BACKEND_URL'],
    optional: [
      'CMS_SESSION_MAX_SECONDS',
      'CMS_SESSION_IDLE_SECONDS',
      'CMS_MEDIA_UPLOAD_ORIGIN',
      'CMS_MEDIA_PUBLIC_ORIGIN',
    ],
    // SESSION_STORE_URL carries the Redis password inside the URL, so it is a secret.
    secret: [
      'GOOGLE_CLIENT_SECRET',
      'SESSION_STORE_URL',
      'SESSION_ENCRYPTION_KEY',
      'SESSION_ENCRYPTION_PREVIOUS_KEY',
    ],
  },
}

/** Secrets that must be present for a deployed (NODE_ENV=production) app to answer requests at all. */
export const REQUIRED_SECRETS = {
  storefront: ['STOREFRONT_SESSION_SECRET'],
  admin: ['GOOGLE_CLIENT_SECRET', 'SESSION_STORE_URL', 'SESSION_ENCRYPTION_KEY'],
}

const SECRET_LIKE = /(SECRET|PASSWORD|PRIVATE|TOKEN|SESSION|CREDENTIAL|_KEY$|^KEY$|API_KEY)/

/** Same rule as apps/admin `assertNoPublicSecrets`: a secret-like NEXT_PUBLIC_ name would be inlined into the browser bundle. */
export function assertNoPublicSecrets(env) {
  const leaked = Object.keys(env).filter(
    (name) =>
      name.startsWith('NEXT_PUBLIC_') && SECRET_LIKE.test(name.slice('NEXT_PUBLIC_'.length)),
  )
  if (leaked.length > 0) {
    throw new Error(`secret-like variables must not be NEXT_PUBLIC_: ${leaked.join(', ')}`)
  }
}

const HTTPS_URL = new Set([
  'TAZZZO_API_BASE_URL',
  'TAZZZO_SITE_URL',
  'TAZZZO_MEDIA_BASE_URL',
  'CMS_BASE_URL',
  'TAZZZO_BACKEND_URL',
  'CMS_MEDIA_UPLOAD_ORIGIN',
  'CMS_MEDIA_PUBLIC_ORIGIN',
])

/**
 * Selects the variables an app may receive at runtime. Throws an Error that names VARIABLES only (never a value) when a
 * required one is missing or a URL is not https. Empty strings count as unset.
 * @returns {{ values: Record<string, string>, secretNames: string[] }}
 */
export function selectRuntimeEnv(app, env) {
  const contract = CONTRACT[app]
  if (!contract) throw new Error(`unknown app: ${app}`)
  assertNoPublicSecrets(env)
  const present = (name) => typeof env[name] === 'string' && env[name] !== ''
  const missing = [...contract.required, ...REQUIRED_SECRETS[app]].filter((name) => !present(name))
  if (missing.length > 0) throw new Error(`missing required variables: ${missing.join(', ')}`)

  const allowed = [...contract.required, ...contract.optional, ...contract.secret]
  /** @type {Record<string, string>} */
  const values = {}
  for (const name of allowed) if (present(name)) values[name] = env[name]

  const bad = []
  for (const name of HTTPS_URL) {
    if (values[name] === undefined) continue
    try {
      if (new URL(values[name]).protocol !== 'https:') bad.push(name)
    } catch {
      bad.push(name)
    }
  }
  if (app === 'admin' && values.SESSION_STORE_URL !== undefined) {
    // Same rule as apps/admin env.ts in production (rediss:// or loopback). Loopback is unreachable from Amplify compute.
    if (!values.SESSION_STORE_URL.startsWith('rediss://')) bad.push('SESSION_STORE_URL')
  }
  if (bad.length > 0)
    throw new Error(`variables must be https (rediss for the session store): ${bad.join(', ')}`)

  return { values, secretNames: contract.secret.filter((name) => values[name] !== undefined) }
}
