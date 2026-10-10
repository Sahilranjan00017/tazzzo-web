/**
 * Legal documents from `GET /v1/content/legal/{slug}` (frozen contract): `slug` is `terms` or `privacy`; a published
 * document is 200 `{ slug, title, body, effectiveDate | null, requestId }`; one that is not published is a flat 404.
 * `body` is PLAIN TEXT, paragraphs separated by blank lines. It is rendered as escaped text in `<p>` elements, never
 * as HTML.
 */
export const LEGAL_SLUGS = ['terms', 'privacy'] as const
export type LegalSlug = (typeof LEGAL_SLUGS)[number]

export function isLegalSlug(value: unknown): value is LegalSlug {
  return typeof value === 'string' && (LEGAL_SLUGS as readonly string[]).includes(value)
}

export interface LegalDocument {
  slug: LegalSlug
  title: string
  paragraphs: string[]
  /** `YYYY-MM-DD` as sent, or null. */
  effectiveDate: string | null
}

const MAX_TITLE = 200
const MAX_BODY = 200_000
const MAX_PARAGRAPHS = 2_000

/** Blank-line separated paragraphs; line breaks inside one are kept (rendered with `white-space: pre-line`). */
export function toParagraphs(body: string): string[] {
  return body
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, MAX_PARAGRAPHS)
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/

/** The effective date as `YYYY-MM-DD` when it is a real calendar date, else null (shown as nothing, never raw). */
export function parseEffectiveDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = ISO_DATE.exec(value)
  if (!m) return null
  const [, y, mo, d] = m
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
  const real =
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(mo) - 1 &&
    date.getUTCDate() === Number(d)
  return real ? `${y}-${mo}-${d}` : null
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** `2026-03-01` -> `1 March 2026` (no time zone arithmetic: the date is a calendar date). */
export function formatEffectiveDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ''} ${y}`
}

/** A well-formed published document for `slug`, or null (wrong slug, missing title or body, oversized, not text). */
export function parseLegal(raw: unknown, slug: LegalSlug): LegalDocument | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.slug !== slug) return null
  if (typeof r.title !== 'string' || typeof r.body !== 'string') return null
  const title = r.title.trim()
  if (title.length === 0 || title.length > MAX_TITLE || r.body.length > MAX_BODY) return null
  const paragraphs = toParagraphs(r.body)
  if (paragraphs.length === 0) return null
  return { slug, title, paragraphs, effectiveDate: parseEffectiveDate(r.effectiveDate) }
}
