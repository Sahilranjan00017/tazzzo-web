import 'server-only'
import { z } from 'zod'
import { isLoopbackHost, parseMediaBase, type MediaBase } from '@/lib/media-base'

/**
 * Server environment, validated at first use and cached. The public `/v1` API needs no credential; the one optional
 * secret is the trusted-caller credential (`TAZZZO_CALLER_*`), which only `src/server/backend/client.ts` sends and
 * which never reaches the browser. Hosts are configuration only, never hardcoded. Nothing here is exposed through
 * `NEXT_PUBLIC_*`, and a validation error names only the field, never a value.
 */
const absoluteHttpUrl = z
  .string()
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'must be http(s)')
  .refine((value) => {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash
  }, 'must not carry credentials, query or fragment')

const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    /**
     * Base of the public Tazzzo API (`/v1/**` is appended), e.g. https://api.tazzzo.com. https in production; plain
     * http only for a loopback host (a sidecar, or a local production-mode run) or outside production.
     */
    TAZZZO_API_BASE_URL: absoluteHttpUrl,
    /** Public origin of this website, for canonical and Open Graph URLs. */
    TAZZZO_SITE_URL: absoluteHttpUrl.refine(
      (v) => new URL(v).pathname === '/',
      'must be an origin (no path)',
    ),
    /** The backend's media public base URL. Optional: unset means every image shows the placeholder. */
    TAZZZO_MEDIA_BASE_URL: z.string().optional(),
    /**
     * Trusted-caller identity for the backend's admission gate (its own bucket instead of this server's IP bucket).
     * Optional; set both or neither. Sent as `X-Tazzzo-Caller` / `X-Tazzzo-Caller-Secret` on every backend read.
     * Same grammar as the backend's trusted-caller configuration (name `[a-z][a-z_]{0,19}`, secret 32-256 visible
     * ASCII characters), so a value the backend would ignore fails here instead of silently using the IP bucket.
     */
    TAZZZO_CALLER_NAME: z
      .string()
      .regex(/^[a-z][a-z_]{0,19}$/)
      .optional()
      .or(z.literal('')),
    TAZZZO_CALLER_SECRET: z
      .string()
      .regex(/^[\x21-\x7e]{32,256}$/)
      .optional()
      .or(z.literal('')),
    /**
     * Read here only for the fail-closed rule below; its values are validated with the rate limit settings
     * (`src/lib/security/rate-limit.ts`).
     */
    STOREFRONT_TRUST_PROXY: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const hasName = Boolean(env.TAZZZO_CALLER_NAME)
    const hasSecret = Boolean(env.TAZZZO_CALLER_SECRET)
    if (hasName !== hasSecret) {
      ctx.addIssue({
        code: 'custom',
        path: [hasName ? 'TAZZZO_CALLER_SECRET' : 'TAZZZO_CALLER_NAME'],
        message: 'TAZZZO_CALLER_NAME and TAZZZO_CALLER_SECRET are set together or not at all',
      })
    }
    // Fail closed: with the trusted-caller credential, every backend read is admitted on the storefront's own (large)
    // bucket, so the per-visitor limit in proxy.ts is the only thing between visitors and the backend. Without a
    // trusted proxy that limit is inactive, so production refuses this combination outright.
    if (
      env.NODE_ENV === 'production' &&
      hasName &&
      hasSecret &&
      env.STOREFRONT_TRUST_PROXY?.trim() !== 'true'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['STOREFRONT_TRUST_PROXY'],
        message: 'must be true in production when TAZZZO_CALLER_* is set',
      })
    }
    if (
      env.TAZZZO_MEDIA_BASE_URL !== undefined &&
      env.TAZZZO_MEDIA_BASE_URL.trim() !== '' &&
      parseMediaBase(env.TAZZZO_MEDIA_BASE_URL, env.NODE_ENV) === null
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['TAZZZO_MEDIA_BASE_URL'],
        message: 'must be an https base URL (http only for loopback outside production)',
      })
    }
    const api = new URL(env.TAZZZO_API_BASE_URL)
    if (
      env.NODE_ENV === 'production' &&
      api.protocol !== 'https:' &&
      !isLoopbackHost(api.hostname)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['TAZZZO_API_BASE_URL'],
        message: 'must be https in production (http only for a loopback host)',
      })
    }
    if (env.NODE_ENV === 'production' && new URL(env.TAZZZO_SITE_URL).protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        path: ['TAZZZO_SITE_URL'],
        message: 'must be https in production',
      })
    }
  })

export interface ServerEnv {
  apiBaseUrl: string
  siteUrl: string
  media: MediaBase | null
  /** The trusted-caller credential, or null when not configured. Server-only; never logged. */
  caller: { name: string; secret: string } | null
}

export function parseServerEnv(env: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(env)
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ')
    throw new Error(`invalid server environment: ${fields}`)
  }
  const data = result.data
  return {
    apiBaseUrl: data.TAZZZO_API_BASE_URL.replace(/\/+$/, ''),
    siteUrl: new URL(data.TAZZZO_SITE_URL).origin,
    media: parseMediaBase(data.TAZZZO_MEDIA_BASE_URL, data.NODE_ENV),
    caller:
      data.TAZZZO_CALLER_NAME && data.TAZZZO_CALLER_SECRET
        ? { name: data.TAZZZO_CALLER_NAME, secret: data.TAZZZO_CALLER_SECRET }
        : null,
  }
}

let cached: ServerEnv | undefined

export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env)
  return cached
}
