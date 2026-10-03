import 'server-only'
import { z } from 'zod'
import type { BffMutationSpec } from './mutation'

/** Catalog product ids (backend `products._id` pattern `^TZP-`). Validated before they become part of a path. */
export const PRODUCT_ID = /^TZP-[A-Z0-9][A-Z0-9-]{0,39}$/

const input = z
  .object({
    productId: z.string().regex(PRODUCT_ID),
    title: z.string().trim().min(1).max(200),
    expectedVersion: z.number().int().min(0).max(2_147_483_647),
  })
  .strict()

const output = z.object({ id: z.string(), title: z.string(), version: z.number().int() })

/**
 * W3 reference mutation: rename a catalog product (backend `PATCH /api/v1/products/{id}`, `If-Match: <version>`,
 * body `{title}`). Reversible, versioned (409 STALE_VERSION) and actor-audited; the backend requires cms-writer.
 */
export const productTitleMutation: BffMutationSpec<
  z.infer<typeof input>,
  z.infer<typeof output>,
  { id: string; title: string; version: number }
> = {
  routeId: 'catalog.product.title',
  method: 'PATCH',
  input,
  backend: ({ productId, title, expectedVersion }) => ({
    path: `/api/v1/products/${encodeURIComponent(productId)}`,
    headers: { 'If-Match': String(expectedVersion) },
    body: { title },
  }),
  output,
  toClient: ({ id, title, version }) => ({ id, title, version }),
}
