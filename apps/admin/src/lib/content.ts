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
    'That change is not allowed from the current status (an archived entry is final; the 200-entry limit may be reached). It has been reloaded.',
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
