import Link from 'next/link'
import { getRootCategories } from '@/server/backend/catalog'

/** Popular categories: the super-categories from the one cached `GET /v1/categories`; nothing when it cannot be read. */
export async function PopularCategories() {
  const roots = await getRootCategories()
  if (roots === 'unavailable' || roots.length === 0) return null
  return (
    <nav aria-label="Browse categories" className="helpful-links" data-testid="popular-categories">
      <h2>Browse categories</h2>
      <ul className="chips">
        {roots.slice(0, 12).map((node) => (
          <li key={node.id}>
            <Link href={`/c/${encodeURIComponent(node.id)}`} className="chip">
              {node.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
