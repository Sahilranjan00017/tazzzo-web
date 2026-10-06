import { z } from 'zod'
import type { BffResult } from './bff-client'
import { bffErrorMessage } from './bff-client'
import { PRODUCT_ID } from './products'

/** Media-set contract (backend main c3306b6, `MediaAdminController`). Client-safe. */
export const OWNER_TYPES = ['product', 'sku'] as const
export type OwnerType = (typeof OWNER_TYPES)[number]
export const CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
/** Backend default maximum upload size (configurable server-side up to 50 MiB). */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
export const MAX_ASSETS = 50

export const assetSchema = z.object({
  assetId: z.string(),
  assetKey: z.string(),
  role: z.string(),
  sortOrder: z.number().int(),
  altText: z.string().nullish(),
  width: z.number().int().nullish(),
  height: z.number().int().nullish(),
  contentType: z.string().nullish(),
})
export type MediaAsset = z.infer<typeof assetSchema>

export const mediaSetSchema = z.object({
  ownerType: z.string(),
  ownerId: z.string(),
  version: z.number().int(),
  active: z.boolean().nullish(),
  assets: z.array(assetSchema).default([]),
})
export type MediaSet = z.infer<typeof mediaSetSchema>

/** Alt text rules (backend): at most 300 characters, no angle brackets. */
export const altText = z
  .string()
  .max(300)
  .refine((v) => !/[<>]/.test(v), 'no angle brackets')

const KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/
export const assetInput = z
  .object({
    assetId: z.string().min(1).max(128),
    assetKey: z
      .string()
      .max(512)
      .regex(KEY)
      .refine((k) => !k.includes('..') && !k.includes('//'), 'unsafe key'),
    role: z.enum(['PRIMARY', 'GALLERY']),
    sortOrder: z.number().int().min(0).max(1_000_000),
    altText: altText.optional(),
    width: z.number().int().min(1).max(20000).optional(),
    height: z.number().int().min(1).max(20000).optional(),
    contentType: z.enum(CONTENT_TYPES).optional(),
  })
  .strict()
  .refine((a) => (a.width === undefined) === (a.height === undefined), {
    path: ['width'],
    message: 'width and height go together',
  })

/** Whole-set replace. Unique ids/keys/sort orders, <=50, at most one PRIMARY and it must be sortOrder 0. */
export const setInput = z
  .object({
    ownerType: z.enum(OWNER_TYPES),
    ownerId: z.string().regex(PRODUCT_ID),
    assets: z.array(assetInput).max(MAX_ASSETS),
    expectedVersion: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = new Set<string>()
    const keys = new Set<string>()
    const orders = new Set<number>()
    let primaries = 0
    v.assets.forEach((a, i) => {
      if (ids.has(a.assetId))
        ctx.addIssue({ code: 'custom', path: ['assets', i, 'assetId'], message: 'duplicate id' })
      if (keys.has(a.assetKey))
        ctx.addIssue({ code: 'custom', path: ['assets', i, 'assetKey'], message: 'duplicate key' })
      if (orders.has(a.sortOrder))
        ctx.addIssue({
          code: 'custom',
          path: ['assets', i, 'sortOrder'],
          message: 'duplicate order',
        })
      ids.add(a.assetId)
      keys.add(a.assetKey)
      orders.add(a.sortOrder)
      if (a.role === 'PRIMARY') {
        primaries += 1
        if (a.sortOrder !== 0)
          ctx.addIssue({
            code: 'custom',
            path: ['assets', i, 'sortOrder'],
            message: 'primary must be order 0',
          })
      }
    })
    if (primaries > 1)
      ctx.addIssue({ code: 'custom', path: ['assets'], message: 'only one primary' })
  })

export const uploadRequestInput = z
  .object({
    ownerType: z.enum(OWNER_TYPES),
    ownerId: z.string().regex(PRODUCT_ID),
    contentType: z.enum(CONTENT_TYPES),
    sizeBytes: z.number().int().min(1).max(52_428_800),
  })
  .strict()

/** Client-side check of a chosen file before any upload request. The backend repeats it. */
export function checkFile(file: { type: string; size: number }): string | undefined {
  if (!(CONTENT_TYPES as readonly string[]).includes(file.type))
    return 'Only JPEG, PNG or WebP images are accepted.'
  if (file.size < 1) return 'The file is empty.'
  if (file.size > DEFAULT_MAX_BYTES)
    return 'The file is larger than 5 MiB, the backend default limit.'
  return undefined
}

const CODE_COPY: Record<string, string> = {
  MEDIA_STORAGE_NOT_CONFIGURED:
    'Uploads are blocked: no media storage provider is configured on the backend yet. This is an external dependency; nothing was uploaded.',
  INVALID_MEDIA:
    'The backend rejected the media (check type, size, alt text, order and the primary image rule).',
  STALE_VERSION:
    'This media set changed since you loaded it (or it already exists / does not exist). It has been reloaded; review it and try again.',
}

export function mediaErrorMessage(result: Extract<BffResult<unknown>, { ok: false }>): string {
  if (result.code && CODE_COPY[result.code]) return CODE_COPY[result.code]!
  if (result.status === 502 || result.status === 503)
    return 'The media service is unavailable right now (storage may not be configured). Nothing was changed.'
  return bffErrorMessage(result, 'media change')
}
