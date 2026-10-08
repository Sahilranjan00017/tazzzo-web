import type { MetadataRoute } from 'next'
import { serverEnv } from '@/server/env'

export const dynamic = 'force-dynamic'

/** Crawl everything except search results; point at the sitemap on the configured public origin. */
export default function robots(): MetadataRoute.Robots {
  const site = serverEnv().siteUrl
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/search' },
    sitemap: `${site}/sitemap.xml`,
  }
}
