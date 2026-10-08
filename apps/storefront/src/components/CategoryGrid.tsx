import Link from 'next/link'
import type { CategoryNode } from '@/lib/categories'

/** A titled grid of category tiles linking to /c/<node>. Renders nothing when no category resolved. */
export function CategoryGrid({
  blockId,
  title,
  nodes,
}: {
  blockId: string
  title: string
  nodes: CategoryNode[]
}) {
  if (nodes.length === 0) return null
  const headingId = `grid-${blockId}`
  return (
    <section className="grid-block" aria-labelledby={headingId} data-block-id={blockId}>
      <h2 id={headingId}>{title}</h2>
      <ul className="category-grid">
        {nodes.map((node) => (
          <li key={node.id}>
            <Link href={`/c/${encodeURIComponent(node.id)}`} className="category-tile">
              {node.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
