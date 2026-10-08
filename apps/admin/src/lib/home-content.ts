import { z } from 'zod'
import type { Tone } from '@/components/ui/primitives'
import { istLocalToUtcIso } from './audit'
import type { BffResult } from './bff-client'
import { bffErrorMessage } from './bff-client'
import { BLOCK_ID } from './content'
import { formatShortIst } from './format'
import { UPLOAD_CODE_COPY } from './media'
import { rememberMaxBytes, sizeLimitCopy, sizeLimitOf } from './upload'

/**
 * HOME content blocks (backend #102, branch feature/content-banner-model head db3623c: `ContentAdminController`,
 * `ContentBlock`, `ContentService`). Client-safe. Every rule below mirrors `ContentBlock.validate`; the backend repeats it.
 */
export const HOME_TYPES = ['BANNER', 'PRODUCT_RAIL', 'CATEGORY_GRID'] as const
export type HomeType = (typeof HOME_TYPES)[number]
export const TYPE_LABEL: Record<HomeType, string> = {
  BANNER: 'Banner',
  PRODUCT_RAIL: 'Product rail',
  CATEGORY_GRID: 'Category grid',
}

/** Who sees a block. Absent on a legacy block = BOTH (backend D1). */
export const AUDIENCES = ['APP_ONLY', 'WEB_ONLY', 'BOTH'] as const
export type Audience = (typeof AUDIENCES)[number]
export const AUDIENCE_LABEL: Record<Audience, string> = {
  APP_ONLY: 'App',
  WEB_ONLY: 'Website',
  BOTH: 'Both',
}
export const audienceOf = (a: string | null | undefined): Audience =>
  (AUDIENCES as readonly string[]).includes(a ?? '') ? (a as Audience) : 'BOTH'

export const EFFECTIVE_STATUSES = ['DRAFT', 'SCHEDULED', 'LIVE', 'EXPIRED', 'ARCHIVED'] as const
export type Effective = (typeof EFFECTIVE_STATUSES)[number]
export const EFFECTIVE_LABEL: Record<Effective, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  LIVE: 'Live',
  EXPIRED: 'Expired',
  ARCHIVED: 'Archived',
}
export const EFFECTIVE_TONE: Record<Effective, Tone> = {
  DRAFT: 'neutral',
  SCHEDULED: 'info',
  LIVE: 'success',
  EXPIRED: 'warning',
  ARCHIVED: 'neutral',
}

export const MAX_TITLE = 80
export const MAX_SUBTITLE = 120
export const MAX_ALT = 300
export const MAX_RAIL = 20
export const MAX_GRID = 12
export const MAX_SORT = 10_000

/**
 * Backend grammars (`ContentBlock.PRODUCT_ID`, `NODE_ID`, `LINK`, #102 head db3623c), full-match, Unicode-aware like Java's
 * \p{L}/\p{M}/\p{N}: combining marks are allowed so Devanagari search text (e.g. "ताज़ा आम") is valid.
 */
export const CONTENT_PRODUCT_ID = /^TZP-[A-Za-z0-9-]{1,40}$/
export const CONTENT_NODE_ID = /^TZ[SCGV]-[0-9]{6}$/
export const SEARCH_TEXT = /^[\p{L}\p{M}\p{N} ]{2,64}$/u
export const LINK =
  /^(product:TZP-[A-Za-z0-9-]{1,40}|category:TZ[SCGV]-[0-9]{6}|search:[\p{L}\p{M}\p{N} ]{2,64})$/u
export const LINK_KINDS = ['product', 'category', 'search'] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export const homeBlockSchema = z.object({
  blockId: z.string(),
  placement: z.string(),
  type: z.string(),
  title: z.string(),
  sort: z.number().int(),
  status: z.string(),
  effectiveStatus: z.string().nullish(),
  startsAt: z.string().nullish(),
  endsAt: z.string().nullish(),
  payload: z
    .object({
      imageAssetKey: z.string().nullish(),
      desktopImageAssetKey: z.string().nullish(),
      link: z.string().nullish(),
      ids: z.array(z.string()).nullish(),
      subtitle: z.string().nullish(),
      altText: z.string().nullish(),
    })
    .default({}),
  audience: z.string().nullish(),
  imageUrl: z.string().nullish(),
  desktopImageUrl: z.string().nullish(),
  version: z.number().int(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
  createdBy: z.string().nullish(),
  updatedBy: z.string().nullish(),
})
export type HomeBlock = z.infer<typeof homeBlockSchema>
export const homeListSchema = z.object({ items: z.array(homeBlockSchema) })

/**
 * The backend's derived state (`effectiveStatus`). For an older backend that does not send it, the same rule is applied
 * here to status and window (PUBLISHED: SCHEDULED before start, EXPIRED from end, LIVE in between).
 */
export function effectiveOf(
  b: Pick<HomeBlock, 'status' | 'effectiveStatus' | 'startsAt' | 'endsAt'>,
  nowMs: number,
): Effective {
  if ((EFFECTIVE_STATUSES as readonly string[]).includes(b.effectiveStatus ?? ''))
    return b.effectiveStatus as Effective
  if (b.status === 'ARCHIVED') return 'ARCHIVED'
  if (b.status !== 'PUBLISHED') return 'DRAFT'
  if (b.startsAt && nowMs < Date.parse(b.startsAt)) return 'SCHEDULED'
  if (b.endsAt && nowMs >= Date.parse(b.endsAt)) return 'EXPIRED'
  return 'LIVE'
}

/** C0 controls and DEL (`c < 0x20 || c == 0x7F`). */
const CONTROL = /[\u0000-\u001f\u007f]/
/** C1 controls and Unicode format characters (Cf: bidi overrides such as U+202E, zero-width U+200B/U+200D, U+FEFF...). */
const INVISIBLE = /[\u0080-\u009f]|\p{Cf}/u

export type TextIssue = 'required' | 'too_long' | 'control' | 'markup' | 'invisible'

/** Title: 1..80 chars, trimmed, no control characters (`ContentBlock.validate`). Markup brackets are allowed. */
export function titleIssue(v: string): TextIssue | undefined {
  if (v.trim().length === 0) return 'required'
  if (v.length > MAX_TITLE) return 'too_long'
  if (CONTROL.test(v)) return 'control'
  return undefined
}

/**
 * Banner subtitle / alt text (`ContentBlock.displayText`): plain text (no control characters, no < or >), bounded, and
 * no C1 controls or invisible/direction-control characters that could reorder or hide what a customer sees.
 */
export function displayTextIssue(v: string, max: number): TextIssue | undefined {
  if (v.trim().length === 0) return 'required'
  if (v.length > max) return 'too_long'
  if (CONTROL.test(v)) return 'control'
  if (/[<>]/.test(v)) return 'markup'
  if (INVISIBLE.test(v)) return 'invisible'
  return undefined
}

export function linkOf(kind: LinkKind, value: string): string {
  return `${kind}:${kind === 'search' ? value.trim() : value.trim().toUpperCase()}`
}

export function parseLink(link: string | null | undefined): { kind: LinkKind; value: string } {
  const m = /^(product|category|search):(.*)$/su.exec(link ?? '')
  return m ? { kind: m[1] as LinkKind, value: m[2]! } : { kind: 'product', value: '' }
}

export function linkIssue(kind: LinkKind, value: string): string | undefined {
  const v = value.trim()
  if (!v) return 'Enter where the banner leads.'
  if (kind === 'product' && !CONTENT_PRODUCT_ID.test(v.toUpperCase()))
    return 'A product link needs a product id like TZP-1001.'
  if (kind === 'category' && !CONTENT_NODE_ID.test(v.toUpperCase()))
    return 'A category link needs a taxonomy node id like TZC-000123 (TZS, TZC, TZG or TZV and 6 digits).'
  if (kind === 'search' && !SEARCH_TEXT.test(v))
    return 'A search link needs 2 to 64 letters (any script), digits or spaces, with no punctuation.'
  return undefined
}

/** Ids typed one per line or comma-separated; blanks dropped, case normalised. */
export const splitIds = (raw: string): string[] =>
  raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)

export function idsIssue(
  type: 'PRODUCT_RAIL' | 'CATEGORY_GRID',
  ids: string[],
): string | undefined {
  const rail = type === 'PRODUCT_RAIL'
  const max = rail ? MAX_RAIL : MAX_GRID
  const what = rail ? 'product' : 'category'
  if (ids.length === 0) return `Add at least one ${what} id.`
  if (ids.length > max) return `At most ${max} ${what} ids (you have ${ids.length}).`
  const bad = ids.filter((id) => !(rail ? CONTENT_PRODUCT_ID : CONTENT_NODE_ID).test(id))
  if (bad.length)
    return `Not a valid ${what} id: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? '…' : ''}.`
  if (new Set(ids).size !== ids.length) return 'Each id may appear only once.'
  return undefined
}

// ---- BFF input schemas (strict; the backend repeats every rule) -------------------------------------------------

const SAFE_KEY = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/)
  .refine(
    (k) =>
      !k.includes('..') &&
      !k.includes('//') &&
      !k.endsWith('/') &&
      k.split('/').every((s) => s.length > 0 && !/^\.+$/.test(s)),
    'unsafe key',
  )
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
const version = z.number().int().min(1).max(2_147_483_647)
const title = z.string().refine((v) => v === v.trim() && titleIssue(v) === undefined, 'title')
const display = (max: number) =>
  z.string().refine((v) => v === v.trim() && displayTextIssue(v, max) === undefined, 'text')
const unique = (ids: string[]) => new Set(ids).size === ids.length

const bannerPayload = z
  .object({
    imageAssetKey: SAFE_KEY,
    desktopImageAssetKey: SAFE_KEY.optional(),
    link: z.string().regex(LINK),
    subtitle: display(MAX_SUBTITLE).optional(),
    altText: display(MAX_ALT).optional(),
  })
  .strict()
const railPayload = z
  .object({ ids: z.array(z.string().regex(CONTENT_PRODUCT_ID)).min(1).max(MAX_RAIL) })
  .strict()
  .refine((p) => unique(p.ids), { path: ['ids'], message: 'duplicate ids' })
const gridPayload = z
  .object({ ids: z.array(z.string().regex(CONTENT_NODE_ID)).min(1).max(MAX_GRID) })
  .strict()
  .refine((p) => unique(p.ids), { path: ['ids'], message: 'duplicate ids' })

const common = {
  title,
  sort: z.number().int().min(0).max(MAX_SORT),
  startsAt: instant.optional(),
  endsAt: instant.optional(),
  audience: z.enum(AUDIENCES),
}
const windowOk = (v: { startsAt?: string; endsAt?: string }) =>
  !v.startsAt || !v.endsAt || Date.parse(v.startsAt) < Date.parse(v.endsAt)
const windowIssue = { path: ['endsAt'], message: 'end must be after start' }

export const homeWriteInput = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('BANNER'), payload: bannerPayload, ...common }).strict(),
    z.object({ type: z.literal('PRODUCT_RAIL'), payload: railPayload, ...common }).strict(),
    z.object({ type: z.literal('CATEGORY_GRID'), payload: gridPayload, ...common }).strict(),
  ])
  .refine(windowOk, windowIssue)
export type HomeWrite = z.infer<typeof homeWriteInput>

/** Update: the same shape plus the block and its version. `type` is used only to validate the payload; never sent. */
export const homeUpdateInput = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('BANNER'),
        payload: bannerPayload,
        ...common,
        blockId: z.string().regex(BLOCK_ID),
        expectedVersion: version,
      })
      .strict(),
    z
      .object({
        type: z.literal('PRODUCT_RAIL'),
        payload: railPayload,
        ...common,
        blockId: z.string().regex(BLOCK_ID),
        expectedVersion: version,
      })
      .strict(),
    z
      .object({
        type: z.literal('CATEGORY_GRID'),
        payload: gridPayload,
        ...common,
        blockId: z.string().regex(BLOCK_ID),
        expectedVersion: version,
      })
      .strict(),
  ])
  .refine(windowOk, windowIssue)
export type HomeUpdate = z.infer<typeof homeUpdateInput>

export const MAX_BLOCKS = 200
export const reorderInput = z
  .object({
    order: z
      .array(z.object({ blockId: z.string().regex(BLOCK_ID), expectedVersion: version }).strict())
      .min(1)
      .max(MAX_BLOCKS)
      .refine((o) => unique(o.map((e) => e.blockId)), 'each block once'),
  })
  .strict()
export type ReorderInput = z.infer<typeof reorderInput>

export const contentUploadInput = z
  .object({
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    sizeBytes: z.number().int().min(1).max(52_428_800),
  })
  .strict()

/**
 * The single reorder call: EVERY non-archived HOME block exactly once, in the new order, each with the version the
 * editor loaded (the backend refuses the whole reorder, 409, if any block changed or the set of blocks differs).
 */
export function buildReorder(
  blocks: Pick<HomeBlock, 'blockId' | 'status' | 'version'>[],
  orderedIds: string[],
): ReorderInput | undefined {
  const active = blocks.filter((b) => b.status !== 'ARCHIVED')
  const byId = new Map(active.map((b) => [b.blockId, b]))
  if (orderedIds.length !== active.length || new Set(orderedIds).size !== orderedIds.length)
    return undefined
  const order: ReorderInput['order'] = []
  for (const id of orderedIds) {
    const b = byId.get(id)
    if (!b) return undefined
    order.push({ blockId: b.blockId, expectedVersion: b.version })
  }
  return { order }
}

/** Moves one id within an order by `delta` (keyboard up/down, drag drop). Out-of-range moves are no-ops. */
export function move(ids: string[], from: number, to: number): string[] {
  if (from < 0 || from >= ids.length || to < 0 || to >= ids.length || from === to) return ids
  const next = [...ids]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item!)
  return next
}

// ---- preview -----------------------------------------------------------------------------------------------------

export const previewBlockSchema = z.object({
  blockId: z.string(),
  type: z.string(),
  title: z.string(),
  subtitle: z.string().nullish(),
  altText: z.string().nullish(),
  imageUrl: z.string().nullish(),
  desktopImageUrl: z.string().nullish(),
  link: z.string().nullish(),
  ids: z.array(z.string()).nullish(),
  status: z.string(),
  effectiveStatus: z.string(),
  audience: z.string().nullish(),
})
export type PreviewBlock = z.infer<typeof previewBlockSchema>
export const previewSchema = z.object({
  channel: z.string(),
  at: z.string(),
  includeDrafts: z.boolean(),
  blocks: z.array(previewBlockSchema),
})
export type HomePreview = z.infer<typeof previewSchema>

export const PREVIEW_VIEWS = ['app', 'web-desktop', 'web-mobile'] as const
export type PreviewView = (typeof PREVIEW_VIEWS)[number]
export const PREVIEW_VIEW_LABEL: Record<PreviewView, string> = {
  app: 'App (phone)',
  'web-desktop': 'Website, desktop',
  'web-mobile': 'Website, mobile',
}
export const channelOf = (view: PreviewView): 'app' | 'web' => (view === 'app' ? 'app' : 'web')

/**
 * Banner crops, matching what each client really renders:
 * - App: tazzzo-app `RemoteHomeScreen.HomeCmsBanner`, the mobile image at 528:178, centre crop.
 * - Website (storefront `BannerCarousel` + globals.css `.banner__media`, web/01-storefront @ 7ff5e3b): consecutive
 *   banners form one carousel and share one ratio. Below 768 px: the mobile image at 16:9. From 768 px: 3:1 only when
 *   EVERY banner of that carousel has a desktop image, otherwise the whole carousel stays 16:9; each banner still loads
 *   its desktop image when it has one (`<source media="(min-width: 768px)">`), else its mobile image.
 */
export type BannerCrop = 'app' | 'web-16x9' | 'web-3x1'
export const BANNER_ASPECT: Record<BannerCrop, string> = {
  app: '528 / 178',
  'web-16x9': '16 / 9',
  'web-3x1': '3 / 1',
}
export interface BannerLayout {
  crop: BannerCrop
  src?: string
}

/** Crop and image for every banner of a preview, per view (all-or-nothing desktop rule per carousel). */
export function bannerLayouts(
  view: PreviewView,
  blocks: Pick<PreviewBlock, 'blockId' | 'type' | 'imageUrl' | 'desktopImageUrl'>[],
): Map<string, BannerLayout> {
  const out = new Map<string, BannerLayout>()
  let carousel: typeof blocks = []
  const flush = () => {
    const wide = carousel.every((b) => !!b.desktopImageUrl)
    for (const b of carousel)
      out.set(b.blockId, {
        crop: wide ? 'web-3x1' : 'web-16x9',
        src: (b.desktopImageUrl || b.imageUrl) ?? undefined,
      })
    carousel = []
  }
  for (const b of blocks) {
    if (b.type !== 'BANNER') {
      if (view === 'web-desktop') flush()
      continue
    }
    if (view === 'app') out.set(b.blockId, { crop: 'app', src: b.imageUrl ?? undefined })
    else if (view === 'web-mobile')
      out.set(b.blockId, { crop: 'web-16x9', src: b.imageUrl ?? undefined })
    else carousel.push(b)
  }
  if (view === 'web-desktop') flush()
  return out
}

export interface PreviewQuery {
  view: PreviewView
  drafts: boolean
  /** IST wall time as typed (`YYYY-MM-DDTHH:mm`), kept in the URL. */
  atLocal?: string
  /** The same instant in UTC, sent to the backend. */
  atUtc?: string
  invalidAt?: boolean
}

type Raw = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim()

export function parsePreviewQuery(raw: Raw): PreviewQuery {
  const view = first(raw.view)
  const at = first(raw.at)
  const atUtc = at ? istLocalToUtcIso(at) : undefined
  return {
    view: (PREVIEW_VIEWS as readonly string[]).includes(view ?? '') ? (view as PreviewView) : 'app',
    drafts: first(raw.drafts) !== 'false',
    ...(atUtc ? { atLocal: at, atUtc } : {}),
    ...(at && !atUtc ? { invalidAt: true } : {}),
  }
}

// ---- copy --------------------------------------------------------------------------------------------------------

const CODE_COPY: Record<string, string> = {
  ...UPLOAD_CODE_COPY,
  INVALID_CONTENT:
    'The backend rejected this content: check the text rules, the link, the ids, the image (it must be an uploaded JPEG, PNG or WebP) and the schedule. Nothing was saved.',
  STATE_CONFLICT:
    'That change is not allowed from the current status (archived blocks are final; there can be at most 200 active Home blocks).',
  STALE_VERSION:
    'This Home content changed since you loaded it. Your edits are still shown; reload to see the latest version.',
}

export function homeErrorMessage(result: Extract<BffResult<unknown>, { ok: false }>): string {
  const limit = sizeLimitOf(result)
  if (limit !== undefined) {
    rememberMaxBytes(limit)
    return sizeLimitCopy(limit)
  }
  if (result.code && CODE_COPY[result.code]) return CODE_COPY[result.code]!
  if (result.status === 404) return 'This block no longer exists.'
  return bffErrorMessage(result, 'content change')
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

/**
 * The instant to send for a schedule field. A `datetime-local` box holds minutes only, so re-deriving an untouched field
 * from it would silently drop the original seconds/milliseconds: when the IST wall time still equals the loaded value,
 * the loaded instant is kept exactly; otherwise the typed IST time is converted.
 */
export function scheduleInstant(
  local: string,
  original: string | null | undefined,
  toUtc: (local: string) => string | undefined,
  toLocal: (iso: string | null | undefined) => string,
): string | undefined {
  if (!local) return undefined
  if (original && INSTANT.test(original) && toLocal(original) === local) return original
  return toUtc(local)
}

/** A block's schedule window in IST, e.g. `8 Oct 2026, 9:00 am → no end IST`. */
export function scheduleText(b: { startsAt?: string | null; endsAt?: string | null }): string {
  if (!b.startsAt && !b.endsAt) return 'Always (no window)'
  return `${b.startsAt ? formatShortIst(b.startsAt) : 'now'} → ${b.endsAt ? formatShortIst(b.endsAt) : 'no end'} IST`
}

/** Actor ids are `google:<sub>` / `service:<name>`: shown as-is (no directory lookup exists). */
export const actorLabel = (id: string | null | undefined) => id ?? 'unknown (older block)'
