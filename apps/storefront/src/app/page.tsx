import type { Metadata } from 'next'
import { BannerCarousel } from '@/components/BannerCarousel'
import { Unavailable } from '@/components/Unavailable'
import { groupSections } from '@/lib/content/blocks'
import { getHomeBlocks } from '@/server/backend/catalog'
import { GridSection } from './_sections/GridSection'
import { RailSection } from './_sections/RailSection'

export async function generateMetadata(): Promise<Metadata> {
  const home = await getHomeBlocks()
  const banner = home.ok
    ? home.blocks.find((b) => b.type === 'BANNER' && b.imageUrl !== null)
    : undefined
  const ogImage = banner?.type === 'BANNER' ? (banner.desktopImageUrl ?? banner.imageUrl) : null
  return {
    title: { absolute: 'Tazzzo' },
    alternates: { canonical: '/' },
    openGraph: {
      url: '/',
      images:
        ogImage && banner?.type === 'BANNER' ? [{ url: ogImage, alt: banner.altText }] : undefined,
    },
  }
}

/**
 * Home: exactly the blocks `GET /v1/content/home?channel=web` returned, in that order. Consecutive banners form one
 * carousel; only the first banner on the page loads eagerly. There is no hardcoded or fallback merchandising: if the
 * backend is unavailable the page says so.
 */
export default async function HomePage() {
  const home = await getHomeBlocks()
  const sections = home.ok ? groupSections(home.blocks) : []
  return (
    <>
      <h1 className="visually-hidden">Tazzzo</h1>
      {!home.ok && <Unavailable what="today's offers" />}
      {home.ok && sections.length === 0 && (
        <div className="notice" role="status">
          <p>Nothing to show here yet. Use search to find products.</p>
        </div>
      )}
      {sections.map((section, i) => {
        switch (section.kind) {
          case 'banners':
            return (
              <BannerCarousel
                key={section.key}
                slides={section.banners}
                priority={sections.findIndex((s) => s.kind === 'banners') === i}
              />
            )
          case 'rail':
            return <RailSection key={section.key} block={section.block} />
          case 'grid':
            return <GridSection key={section.key} block={section.block} />
        }
      })}
    </>
  )
}
