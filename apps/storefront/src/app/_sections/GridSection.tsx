import { CategoryGrid } from '@/components/CategoryGrid'
import type { CategoryNode } from '@/lib/categories'
import type { CategoryGridBlock } from '@/lib/content/blocks'
import { resolveCategoryNames } from '@/server/backend/catalog'

/**
 * Server side of a CATEGORY_GRID block. Each tile is named by `GET /v1/categories/{id}` (any depth); a node that is
 * not visible, or whose read fails, is skipped, and the rest keep grid order.
 */
export async function GridSection({ block }: { block: CategoryGridBlock }) {
  const names = await resolveCategoryNames(block.ids.join(','))
  const nodes: CategoryNode[] = block.ids.flatMap((id) => {
    const name = names.get(id)
    return name ? [{ id, name }] : []
  })
  return <CategoryGrid blockId={block.blockId} title={block.title} nodes={nodes} />
}
