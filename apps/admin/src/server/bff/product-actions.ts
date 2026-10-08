import 'server-only'
import { z } from 'zod'
import { createInput } from '@/lib/product-create'
import { PRODUCT_ID, type LifecycleAction } from '@/lib/products'
import type { BffMutationSpec } from './mutation'

const version = z.number().int().min(0).max(2_147_483_647)
const productOut = z.object({
  id: z.string(),
  lifecycle: z.string(),
  title: z.string(),
  version: z.number().int(),
})
type ProductOut = z.infer<typeof productOut>
const toClient = ({ id, lifecycle, title, version }: ProductOut) => ({
  id,
  lifecycle,
  title,
  version,
})
type ProductClient = ReturnType<typeof toClient>

const lifecycleInput = z
  .object({
    productId: z.string().regex(PRODUCT_ID),
    expectedVersion: version,
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .strict()

/**
 * One narrow spec per lifecycle action (`POST /api/v1/products/{id}/{activate|retire|revive|archive}`, `If-Match`).
 * Only `retire` takes a body (optional reason). The backend enforces legality (409 STATE_CONFLICT) and the version.
 */
export function lifecycleMutation(
  action: LifecycleAction,
): BffMutationSpec<z.infer<typeof lifecycleInput>, ProductOut, ProductClient> {
  return {
    routeId: `catalog.product.${action}`,
    method: 'POST',
    input: lifecycleInput,
    backend: ({ productId, expectedVersion, reason }) => ({
      path: `/api/v1/products/${encodeURIComponent(productId)}/${action}`,
      headers: { 'If-Match': String(expectedVersion) },
      body: action === 'retire' && reason ? { reason } : undefined,
    }),
    output: productOut,
    toClient,
  }
}

/**
 * `POST /api/v1/products`: single-SKU draft creation only (variant packs and bundles need component products, which
 * this CMS does not model yet). The backend does not verify vertical/release existence on single create and has no
 * idempotency key: a replay returns 409 IDENTITY_COLLISION, and the UI never retries automatically.
 */
export const createProductMutation: BffMutationSpec<
  z.infer<typeof createInput>,
  ProductOut,
  ProductClient
> = {
  routeId: 'catalog.product.create',
  method: 'POST',
  input: createInput,
  backend: (input) => ({ path: '/api/v1/products', body: input }),
  output: productOut,
  toClient,
}
