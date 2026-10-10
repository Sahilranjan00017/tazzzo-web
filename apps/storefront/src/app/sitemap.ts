import type { MetadataRoute } from 'next'
import { LEGAL_SLUGS } from '@/lib/content/legal'
import { getRootCategories } from '@/server/backend/catalog'
import { getLegal } from '@/server/backend/content'
import { serverEnv } from '@/server/env'

export const dynamic = 'force-dynamic'

/**
 * Minimal sitemap: the home page, the super-categories (one cached `GET /v1/categories`) and the help pages (FAQ,
 * contact, and each legal document that is published; an unpublished one is `noindex`, so it is not listed). Products
 * are not listed: the public API has no product enumeration outside category paging. Backend unavailable means home
 * and the static help pages only.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = serverEnv().siteUrl
  const roots = await getRootCategories()
  const categories = roots === 'unavailable' ? [] : roots
  const legal = await Promise.all(
    LEGAL_SLUGS.map(async (slug) => ((await getLegal(slug)).ok ? slug : null)),
  )
  return [
    { url: `${site}/`, changeFrequency: 'hourly' },
    { url: `${site}/faq`, changeFrequency: 'weekly' as const },
    { url: `${site}/contact`, changeFrequency: 'monthly' as const },
    ...legal.flatMap((slug) =>
      slug ? [{ url: `${site}/${slug}`, changeFrequency: 'monthly' as const }] : [],
    ),
    ...categories.map((node) => ({
      url: `${site}/c/${node.id}`,
      changeFrequency: 'daily' as const,
    })),
  ]
}
