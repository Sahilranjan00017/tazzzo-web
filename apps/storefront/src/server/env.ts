import 'server-only'
import { z } from 'zod'
import { parseMediaBase, type MediaBase } from '@/lib/media-base'

/**
 * Server environment, validated at first use and cached. The storefront holds no secrets: the public `/v1` API needs
 * no credential. Hosts are configuration only, never hardcoded. Nothing here is exposed through `NEXT_PUBLIC_*`.
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
    /** Base of the public Tazzzo API (`/v1/**` is appended), e.g. https://api.tazzzo.com. */
    TAZZZO_API_BASE_URL: absoluteHttpUrl,
    /** Public origin of this website, for canonical and Open Graph URLs. */
    TAZZZO_SITE_URL: absoluteHttpUrl.refine(
      (v) => new URL(v).pathname === '/',
      'must be an origin (no path)',
    ),
    /** The backend's media public base URL. Optional: unset means every image shows the placeholder. */
    TAZZZO_MEDIA_BASE_URL: z.string().optional(),
  })
  .superRefine((env, ctx) => {
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
  }
}

let cached: ServerEnv | undefined

export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env)
  return cached
}
