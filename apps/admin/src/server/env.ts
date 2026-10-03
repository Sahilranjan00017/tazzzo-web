import 'server-only'
import { z } from 'zod'

/**
 * Server environment, validated at first use and cached. Never expose a server value through a `NEXT_PUBLIC_*`
 * variable: Next inlines those into the browser bundle.
 *
 * CROSS-REPO INVARIANT: `GOOGLE_CLIENT_ID` must equal the backend's `tazzzo.admin.oidc.audience` in the same
 * environment. The backend accepts only ID tokens whose single audience (and `azp`) is that client id; a mismatch
 * makes every human request fail with 401.
 */
export const GOOGLE_ISSUER = 'https://accounts.google.com'

const base64Key32 = z
  .string()
  .refine(
    (value) => decodeKey(value)?.length === 32,
    'must be 32 bytes, base64 or base64url encoded',
  )

export function decodeKey(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return undefined
  const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  return bytes.length > 0 ? bytes : undefined
}

const absoluteHttpUrl = z
  .string()
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'must be http(s)')

const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    CMS_BASE_URL: absoluteHttpUrl.refine(
      (v) => new URL(v).pathname === '/',
      'must be an origin (no path)',
    ),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GOOGLE_HOSTED_DOMAIN: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
    /** Test/dev seam only: must be unset or Google's issuer in production (enforced below). */
    GOOGLE_ISSUER: absoluteHttpUrl.optional(),
    TAZZZO_BACKEND_URL: absoluteHttpUrl,
    SESSION_STORE_URL: z
      .string()
      .refine((v) => /^rediss?:\/\//.test(v), 'must be a redis:// or rediss:// URL'),
    SESSION_ENCRYPTION_KEY: base64Key32,
    SESSION_ENCRYPTION_PREVIOUS_KEY: base64Key32.optional(),
    CMS_SESSION_MAX_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),
    CMS_SESSION_IDLE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1_800),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return
    if (new URL(env.CMS_BASE_URL).protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        path: ['CMS_BASE_URL'],
        message: 'must be https in production',
      })
    }
    if (env.GOOGLE_ISSUER !== undefined && env.GOOGLE_ISSUER !== GOOGLE_ISSUER) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_ISSUER'],
        message: 'only Google in production',
      })
    }
    if (!env.SESSION_STORE_URL.startsWith('rediss://') && !isLoopbackRedis(env.SESSION_STORE_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_STORE_URL'],
        message: 'must use TLS (rediss://)',
      })
    }
  })

function isLoopbackRedis(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
  } catch {
    return false
  }
}

export type ServerEnv = z.infer<typeof serverEnvSchema>

/** Names that must never be browser-public, whatever their value. */
const SECRET_LIKE = /(SECRET|PASSWORD|PRIVATE|TOKEN|SESSION|CREDENTIAL|_KEY$|^KEY$|API_KEY)/

export function assertNoPublicSecrets(env: Record<string, string | undefined>): void {
  const leaked = Object.keys(env).filter(
    (name) =>
      name.startsWith('NEXT_PUBLIC_') && SECRET_LIKE.test(name.slice('NEXT_PUBLIC_'.length)),
  )
  if (leaked.length > 0) {
    throw new Error(`secret-like variables must not be NEXT_PUBLIC_: ${leaked.join(', ')}`)
  }
}

export function parseServerEnv(env: Record<string, string | undefined>): ServerEnv {
  assertNoPublicSecrets(env)
  const result = serverEnvSchema.safeParse(env)
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ')
    throw new Error(`invalid server environment: ${fields}`)
  }
  return result.data
}

let cached: ServerEnv | undefined

export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env)
  return cached
}

/** The OIDC issuer actually used: Google, unless a non-production test/dev issuer is configured. */
export function oidcIssuer(env: ServerEnv): string {
  return env.GOOGLE_ISSUER ?? GOOGLE_ISSUER
}
