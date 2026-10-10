import Link from 'next/link'

/** Where to go from a page that has nothing (more) to show: the same few places everywhere. */
export function HelpfulLinks({ search = false }: { search?: boolean }) {
  return (
    <nav aria-label="Where to next" className="helpful-links">
      <ul className="helpful-links__list">
        <li>
          <Link href="/">Back to home</Link>
        </li>
        {search && (
          <li>
            <Link href="/search">Try a different search</Link>
          </li>
        )}
        <li>
          <Link href="/contact">Contact us</Link>
        </li>
      </ul>
    </nav>
  )
}
