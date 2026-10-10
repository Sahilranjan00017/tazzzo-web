import { z } from 'zod'
import type { Tone } from '@/components/ui/primitives'
import type { BffResult } from './bff-client'
import { bffErrorMessage } from './bff-client'
import { istLocalToUtcIso } from './audit'

/** Content-block contract (backend main c3306b6, `ContentAdminController`). FAQs are blocks with placement HELP. */
export const BLOCK_ID = /^CB_[A-Za-z0-9_-]{16,40}$/
export const FAQ_CATEGORIES = [
  'DELIVERY',
  'PRODUCT',
  'CLUB',
  'PAYMENT',
  'REFUND',
  'ACCOUNT',
] as const
/** Legal documents (type LEGAL on placement HELP): one live document per slug; the public path is the lowercase slug. */
export const LEGAL_SLUGS = ['TERMS', 'PRIVACY'] as const
export type LegalSlug = (typeof LEGAL_SLUGS)[number]
export const LEGAL_SLUG_LABEL: Record<string, string> = { TERMS: 'Terms', PRIVACY: 'Privacy' }
export const LEGAL_BODY_MAX = 60_000
export const BLOCK_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const
export const FAQ_CATEGORY_LABEL: Record<string, string> = {
  DELIVERY: 'Delivery',
  PRODUCT: 'Product',
  CLUB: 'Club',
  PAYMENT: 'Payment',
  REFUND: 'Refund',
  ACCOUNT: 'Account',
}

export const blockSchema = z.object({
  blockId: z.string(),
  placement: z.string(),
  type: z.string(),
  title: z.string(),
  sort: z.number().int(),
  status: z.string(),
  startsAt: z.string().nullish(),
  endsAt: z.string().nullish(),
  payload: z
    .object({
      imageAssetKey: z.string().nullish(),
      link: z.string().nullish(),
      ids: z.array(z.string()).nullish(),
      faqCategory: z.string().nullish(),
      question: z.string().nullish(),
      answer: z.string().nullish(),
      legalSlug: z.string().nullish(),
      body: z.string().nullish(),
      effectiveDate: z.string().nullish(),
    })
    .default({}),
  version: z.number().int(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
})
export type ContentBlock = z.infer<typeof blockSchema>
export const blockListSchema = z.object({ items: z.array(blockSchema) })

export type EffectiveStatus = 'draft' | 'live' | 'scheduled' | 'ended' | 'archived'

/**
 * What a customer would see right now. The backend has no "scheduled/expired" status: a block is live when PUBLISHED and
 * now is within [startsAt, endsAt) by the SERVER clock. This derives it from the same fields for display, as of page load.
 * Caches (browser/CDN, `max-age=60`) can make the public API lag this by up to a minute.
 */
export function effectiveStatus(
  b: Pick<ContentBlock, 'status' | 'startsAt' | 'endsAt'>,
  nowMs: number,
): EffectiveStatus {
  if (b.status === 'ARCHIVED') return 'archived'
  if (b.status !== 'PUBLISHED') return 'draft'
  if (b.startsAt && nowMs < Date.parse(b.startsAt)) return 'scheduled'
  if (b.endsAt && nowMs >= Date.parse(b.endsAt)) return 'ended'
  return 'live'
}

export const EFFECTIVE_TONE: Record<EffectiveStatus, Tone> = {
  draft: 'neutral',
  live: 'success',
  scheduled: 'info',
  ended: 'warning',
  archived: 'neutral',
}

/** UTC instant -> IST wall time for a `datetime-local` input. */
export function utcToIstLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '' : new Date(t + 5.5 * 3600_000).toISOString().slice(0, 16)
}

const plain = (max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !/[<>]/.test(v), 'no angle brackets')

/** FAQ text rules (backend): question <=200 with no newline, answer <=2000 (newlines fine), neither may contain < or >. */
export const faqFields = z.object({
  faqCategory: z.enum(FAQ_CATEGORIES),
  question: plain(200).refine((v) => !/[\r\n]/.test(v), 'no line breaks in the question'),
  answer: plain(2000),
})

/**
 * LEGAL text rules (backend `ContentBlock.validate`): body 1..60000, already trimmed, no `<` or `>`, no control characters
 * except the line feed (so no tab or carriage return), no C1 controls and no bidirectional override/isolate characters.
 */
export function legalBodyProblem(body: string): string | undefined {
  if (body.length === 0) return 'empty'
  if (body.length > LEGAL_BODY_MAX) return 'too-long'
  if (body !== body.trim()) return 'untrimmed'
  if (/[<>]/.test(body)) return 'angle-brackets'
  for (const ch of body) {
    const c = ch.codePointAt(0)!
    if (
      (c < 0x20 && c !== 0x0a) ||
      c === 0x7f ||
      (c >= 0x80 && c <= 0x9f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    )
      return 'control'
  }
  return undefined
}

/** The paragraphs customers see: blocks of text separated by one or more blank lines. */
export function legalParagraphs(body: string): string[] {
  return body
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/** A real calendar date as yyyy-MM-dd (no times, no other shapes). */
export function validIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

export const legalFields = z
  .object({
    legalSlug: z.enum(LEGAL_SLUGS),
    body: z.string().refine((v) => legalBodyProblem(v) === undefined, 'invalid body'),
    effectiveDate: z.string().refine(validIsoDate, 'invalid date').optional(),
  })
  .strict()

const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
const version = z.number().int().min(1).max(2_147_483_647)

export const faqWriteInput = z
  .object({
    title: plain(80),
    sort: z.number().int().min(0).max(10000),
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    payload: faqFields,
  })
  .strict()
  .refine((v) => !v.startsAt || !v.endsAt || Date.parse(v.startsAt) < Date.parse(v.endsAt), {
    path: ['endsAt'],
    message: 'end must be after start',
  })

export const faqUpdateInput = faqWriteInput.safeExtend({
  blockId: z.string().regex(BLOCK_ID),
  expectedVersion: version,
})

/** Create/replace a legal document. The title is the document title customers see (unlike an FAQ's internal title). */
export const legalWriteInput = z
  .object({
    title: plain(80),
    sort: z.number().int().min(0).max(10000),
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    payload: legalFields,
  })
  .strict()
  .refine((v) => !v.startsAt || !v.endsAt || Date.parse(v.startsAt) < Date.parse(v.endsAt), {
    path: ['endsAt'],
    message: 'end must be after start',
  })

export const legalUpdateInput = legalWriteInput.safeExtend({
  blockId: z.string().regex(BLOCK_ID),
  expectedVersion: version,
})

/**
 * The document the public page serves for a slug right now: among LEGAL blocks that are live (PUBLISHED and inside the
 * window), the most recently updated, then the greater id, exactly the backend's deterministic pick. `undefined` means the
 * public page answers 404 for this slug.
 */
export function liveLegalFor(
  items: readonly ContentBlock[],
  slug: string,
  nowMs: number,
): ContentBlock | undefined {
  return items
    .filter(
      (b) =>
        b.type === 'LEGAL' && b.payload.legalSlug === slug && effectiveStatus(b, nowMs) === 'live',
    )
    .sort(
      (a, b) =>
        Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? '') ||
        b.blockId.localeCompare(a.blockId),
    )[0]
}

export const statusInput = z
  .object({
    blockId: z.string().regex(BLOCK_ID),
    to: z.enum(BLOCK_STATUSES),
    expectedVersion: version,
  })
  .strict()

export function windowToUtc(local: string): string | undefined {
  const iso = istLocalToUtcIso(local)
  return iso ? iso.replace(/\.\d{3}Z$/, '.000Z') : undefined
}

const CODE_COPY: Record<string, string> = {
  INVALID_CONTENT:
    'The backend rejected the content (check the text rules and the publication window).',
  STATE_CONFLICT:
    'That change is not allowed from the current status (an archived entry is final; the 200-entry limit may be reached). For legal documents, only one Terms and one Privacy document may be published for any period: unpublish the other one, or end its window before this one starts. It has been reloaded.',
  STALE_VERSION:
    'This entry changed since you loaded it. The latest version has been reloaded; review it and try again.',
}

export function contentErrorMessage(result: Extract<BffResult<unknown>, { ok: false }>): string {
  if (result.code && CODE_COPY[result.code]) return CODE_COPY[result.code]!
  if (result.status === 404) return 'This entry no longer exists.'
  return bffErrorMessage(result, 'content change')
}

/** Disclosed wherever publication changes visibility (decision D5). */
export const PUBLICATION_DELAY_NOTE =
  'Customers see changes within about a minute: the public API is cached for up to 60 seconds, so publishing, scheduling boundaries and even an emergency unpublish can take up to a minute to take effect.'
