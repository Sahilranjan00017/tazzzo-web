import Link from 'next/link'
import { HelpfulLinks } from '@/components/StaticPageNav'
import { PopularCategories } from '@/app/_sections/PopularCategories'

export default function NotFound() {
  return (
    <section className="listing prose" aria-labelledby="notfound-title">
      <h1 id="notfound-title">Page not found</h1>
      <p>
        This page doesn&apos;t exist or is no longer available. Check the address, or{' '}
        <Link href="/search">search for what you need</Link>.
      </p>
      <HelpfulLinks />
      <PopularCategories />
    </section>
  )
}
