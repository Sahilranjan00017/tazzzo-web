import type { MetadataRoute } from 'next'
import { getRootCategories } from '@/server/backend/catalog'
import { serverEnv } from '@/server/env'

export const dynamic = 'force-dynamic'

/**
 * Minimal sitemap: the home page and the super-categories (one cached `GET /v1/categories`). Products are not listed:
 * the public API has no product enumeration outside category paging. Backend unavailable means home only.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = serverEnv().siteUrl
  const roots = await getRootCategories()
  const categories = roots === 'unavailable' ? [] : roots
  return [
    { url: `${site}/`, changeFrequency: 'hourly' },
    ...categories.map((node) => ({
      url: `${site}/c/${node.id}`,
      changeFrequency: 'daily' as const,
    })),
  ]
}
