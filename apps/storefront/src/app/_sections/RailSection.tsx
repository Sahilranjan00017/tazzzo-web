import { ProductRail } from '@/components/ProductRail'
import type { ProductRailBlock } from '@/lib/content/blocks'
import { getRailProducts } from '@/server/backend/catalog'

/** Server side of a PRODUCT_RAIL block: resolves its product ids (missing ones skipped) and renders the rail. */
export async function RailSection({ block }: { block: ProductRailBlock }) {
  const products = await getRailProducts(block.ids)
  return <ProductRail blockId={block.blockId} title={block.title} products={products} />
}
