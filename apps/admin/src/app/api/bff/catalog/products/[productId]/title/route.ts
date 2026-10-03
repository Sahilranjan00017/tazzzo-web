import type { NextRequest } from 'next/server'
import { runBffMutation } from '@/server/bff/mutation'
import { productTitleMutation } from '@/server/bff/product-title'

/** PATCH only (other methods: Next returns 405). The id is validated by the route's strict schema. */
export async function PATCH(
  request: NextRequest,
  context: RouteContext<'/api/bff/catalog/products/[productId]/title'>,
) {
  const { productId } = await context.params
  return runBffMutation(productTitleMutation, request, { productId })
}
