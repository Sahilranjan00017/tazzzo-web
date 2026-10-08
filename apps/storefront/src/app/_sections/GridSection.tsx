import { CategoryGrid } from '@/components/CategoryGrid'
import type { CategoryNode } from '@/lib/categories'
import type { CategoryGridBlock } from '@/lib/content/blocks'
import { resolveCategoryNames } from '@/server/backend/catalog'

/**
 * Server side of a CATEGORY_GRID block. Tiles need a name and the public API has no node-by-id read, so a node whose
 * name cannot be resolved (not visible, or deeper than a super-category's children) is skipped, in grid order.
 */
export async function GridSection({ block }: { block: CategoryGridBlock }) {
  const names = await resolveCategoryNames(block.ids.join(','))
  const nodes: CategoryNode[] = block.ids.flatMap((id) => {
    const name = names.get(id)
    return name ? [{ id, name }] : []
  })
  return <CategoryGrid blockId={block.blockId} title={block.title} nodes={nodes} />
}
