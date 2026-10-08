import 'server-only'
import { z } from 'zod'
import { serverEnv } from '@/server/env'
import type { UploadTarget } from '@/lib/upload'

/** Machine code when this deployment has no `CMS_MEDIA_UPLOAD_ORIGIN` (direct upload disabled). */
export const UPLOAD_ORIGIN_NOT_CONFIGURED = 'UPLOAD_ORIGIN_NOT_CONFIGURED'

export const uploadOriginPrecondition = (): string | undefined =>
  serverEnv().CMS_MEDIA_UPLOAD_ORIGIN ? undefined : UPLOAD_ORIGIN_NOT_CONFIGURED

const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
/** Never forwarded to the browser as an instruction to send: credentials and browser-owned headers. */
const REFUSED_HEADER = /^(cookie|cookie2|authorization|proxy-.*|sec-.*|origin|referer|host)$/i

/**
 * The backend's presigned upload target (`POST .../uploads` -> 201), validated before the browser ever sees it: a PUT to
 * exactly the configured storage origin (the same origin CSP `connect-src` allows), a bounded header map with no
 * credential or browser-owned header, and a server-generated key. Anything else is refused (502), so the browser is
 * never told to send bytes, cookies or tokens anywhere unexpected.
 */
export const uploadTargetOut = z.object({
  assetKey: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/)
    .refine((k) => !k.includes('..') && !k.includes('//') && !k.endsWith('/'), 'unsafe key'),
  method: z.literal('PUT'),
  url: z
    .string()
    .max(4096)
    .refine((value) => {
      const origin = serverEnv().CMS_MEDIA_UPLOAD_ORIGIN
      try {
        const url = new URL(value)
        return origin !== undefined && url.origin === origin && !url.username && !url.password
      } catch {
        return false
      }
    }, 'upload url outside the configured storage origin'),
  headers: z
    .record(
      z.string().regex(HEADER_NAME),
      z
        .string()
        .max(2048)
        .regex(/^[^\r\n]*$/),
    )
    .refine((h) => Object.keys(h).length <= 16, 'too many headers')
    .refine((h) => !Object.keys(h).some((n) => REFUSED_HEADER.test(n)), 'refused header'),
  expiresAt: z.string().max(64).nullish(),
  maxBytes: z.number().int().min(1).max(52_428_800).nullish(),
})

export const toUploadTarget = (o: z.infer<typeof uploadTargetOut>): UploadTarget => ({
  assetKey: o.assetKey,
  method: o.method,
  url: o.url,
  headers: o.headers,
  expiresAt: o.expiresAt ?? null,
  maxBytes: o.maxBytes ?? null,
})

/**
 * `errorDetail` for 422s that may be a size refusal: the backend names its limit in the message
 * (`sizeBytes must be between 1 and N` at target time, `stored object size is outside 1..N` at reference time). Only that
 * number is passed on, as `{ reason: 'size', maxBytes }`; nothing else from the backend body reaches the browser.
 */
export function sizeLimitDetail(body: unknown): { reason: 'size'; maxBytes: number } | undefined {
  const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message
  if (typeof message !== 'string') return undefined
  const m =
    /(?:sizeBytes must be between 1 and |stored object size is outside 1\.\.)(\d{1,9})\b/.exec(
      message,
    )
  const maxBytes = m ? Number(m[1]) : Number.NaN
  return maxBytes >= 1 && maxBytes <= 52_428_800 ? { reason: 'size', maxBytes } : undefined
}
