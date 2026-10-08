import { z } from 'zod'
import type { BffResult } from './bff-client'
import { bffErrorMessage } from './bff-client'
import { PRODUCT_ID } from './products'
import { DEFAULT_MAX_UPLOAD_BYTES, IMAGE_TYPES } from './upload'

/**
 * Media-set contract (backend `MediaAdminController`, PR #95 head c8f57de). Client-safe. Image roles are only PRIMARY and
 * GALLERY in the backend contract (`ImageRole`); packaging/nutrition/ingredients/lifestyle roles are a pending backend
 * decision and are deliberately not offered here.
 */
export const OWNER_TYPES = ['product', 'sku'] as const
export type OwnerType = (typeof OWNER_TYPES)[number]
export const CONTENT_TYPES = IMAGE_TYPES
/** Backend default maximum upload size (configurable server-side up to 50 MiB). */
export const DEFAULT_MAX_BYTES = DEFAULT_MAX_UPLOAD_BYTES
export const MAX_ASSETS = 50
export const IMAGE_ROLES = ['PRIMARY', 'GALLERY'] as const

export const assetSchema = z.object({
  assetId: z.string(),
  assetKey: z.string(),
  role: z.string(),
  sortOrder: z.number().int(),
  altText: z.string().nullish(),
  width: z.number().int().nullish(),
  height: z.number().int().nullish(),
  contentType: z.string().nullish(),
  /** Resolved public URL (backend #95); absent while no public media base is configured. Display only. */
  url: z.string().nullish(),
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

/**
 * Alt text rules (backend `MediaAsset`): trimmed, at most 300 characters, no angle brackets and no control characters
 * (U+0000-U+001F, U+007F). Leading/trailing whitespace is trimmed first, exactly as the backend does.
 */
export const altText = z
  .string()
  .transform((v) => v.trim())
  .pipe(
    z
      .string()
      .max(300)
      .refine((v) => !/[<>]/.test(v), 'no angle brackets')
      .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'no control characters'),
  )

const KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/
export const assetInput = z
  .object({
    assetId: z.string().min(1).max(128),
    assetKey: z
      .string()
      .max(512)
      .regex(KEY)
      .refine((k) => !k.includes('..') && !k.includes('//'), 'unsafe key'),
    role: z.enum(IMAGE_ROLES),
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

/** Upload copy shared by every image upload (media sets and home content). Never echoes backend text. */
export const UPLOAD_CODE_COPY: Record<string, string> = {
  MEDIA_STORAGE_NOT_CONFIGURED:
    'Uploads are switched off: no media storage is configured on the backend. Nothing was uploaded.',
  MEDIA_STORAGE_UNAVAILABLE:
    'Media storage is unavailable right now (an outage between the backend and storage). Nothing was saved; try again shortly.',
  UPLOAD_ORIGIN_NOT_CONFIGURED:
    'Direct upload is not enabled in this CMS deployment (no storage origin is configured). Nothing was uploaded.',
}

const CODE_COPY: Record<string, string> = {
  ...UPLOAD_CODE_COPY,
  INVALID_MEDIA:
    'The backend rejected the media: an image is missing from storage, is not the declared type, is too large, or breaks a rule (alt text, order, one primary image at order 0). Nothing was saved.',
  STALE_VERSION:
    'This media set changed since you loaded it (or it was created meanwhile). Your edits are still shown; reload to see the latest version.',
}

export function mediaErrorMessage(result: Extract<BffResult<unknown>, { ok: false }>): string {
  if (result.code && CODE_COPY[result.code]) return CODE_COPY[result.code]!
  if (result.status === 502 || result.status === 503)
    return 'The media service is unavailable right now. Nothing was changed.'
  return bffErrorMessage(result, 'media change')
}
