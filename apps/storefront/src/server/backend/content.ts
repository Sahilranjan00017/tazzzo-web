import 'server-only'
import { cache } from 'react'
import { parseFaqs, type Faq } from '@/lib/content/faqs'
import { isLegalSlug, parseLegal, type LegalDocument, type LegalSlug } from '@/lib/content/legal'
import { NO_SUPPORT, parseSupport, type SupportContacts } from '@/lib/support'
import { getJson } from '@/server/backend/client'

/**
 * Static-ish public content for the help pages. Same transport and 60 s data cache as every other read
 * (`client.ts`): one backend call per URL per minute per instance. Slugs are checked against the closed list before a
 * path is built; nothing from the request reaches a backend path or query.
 */

/** `GET /v1/content/faqs` (the whole live FAQ, no filter). */
export const getFaqs = cache(
  async (): Promise<{ ok: true; faqs: Faq[] } | { ok: false; reason: 'unavailable' }> => {
    const result = await getJson('/v1/content/faqs')
    if (!result.ok) return { ok: false, reason: 'unavailable' }
    const faqs = parseFaqs(result.data)
    if (faqs === null) {
      console.warn('storefront_backend_malformed path=/v1/content/faqs')
      return { ok: false, reason: 'unavailable' }
    }
    return { ok: true, faqs }
  },
)

export type LegalResult =
  | { ok: true; document: LegalDocument }
  /** The backend has no published document for this slug (flat 404). */
  | { ok: false; reason: 'unpublished' }
  | { ok: false; reason: 'unavailable' }

/** `GET /v1/content/legal/{slug}` for `terms` or `privacy`. */
export const getLegal = cache(async (slug: LegalSlug): Promise<LegalResult> => {
  if (!isLegalSlug(slug)) return { ok: false, reason: 'unpublished' }
  const result = await getJson(`/v1/content/legal/${slug}`)
  if (!result.ok)
    return { ok: false, reason: result.kind === 'not_found' ? 'unpublished' : 'unavailable' }
  const document = parseLegal(result.data, slug)
  if (document === null) {
    console.warn(`storefront_backend_malformed path=/v1/content/legal/${slug}`)
    return { ok: false, reason: 'unavailable' }
  }
  return { ok: true, document }
})

/**
 * `GET /v1/app-config`, read only for the support contacts (already validated by `parseSupport`). `null` when the
 * config cannot be read at all, so the page can say the details are not available.
 */
export const getSupportContacts = cache(async (): Promise<SupportContacts | null> => {
  const result = await getJson('/v1/app-config')
  if (!result.ok) return null
  return parseSupport(result.data) ?? NO_SUPPORT
})
