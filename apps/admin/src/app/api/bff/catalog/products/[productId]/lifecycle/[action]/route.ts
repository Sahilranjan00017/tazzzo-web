import { NextResponse, type NextRequest } from 'next/server'
import { LIFECYCLE_ACTIONS, type LifecycleAction } from '@/lib/products'
import { runBffMutation } from '@/server/bff/mutation'
import { lifecycleMutation } from '@/server/bff/product-actions'

/** POST only. The action is checked against the four-entry allowlist before any spec is chosen. */
export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/bff/catalog/products/[productId]/lifecycle/[action]'>,
) {
  const { productId, action } = await context.params
  if (!(LIFECYCLE_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  return runBffMutation(lifecycleMutation(action as LifecycleAction), request, { productId })
}
