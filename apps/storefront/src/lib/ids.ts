/**
 * Identifier shapes, copied from the backend's content grammar (`ContentBlock.PRODUCT_ID` / `NODE_ID`) so that every id
 * a published block can carry is routable here, and nothing else reaches a backend path.
 *
 * Note: the OpenAPI `ProductId` path pattern (`^TZP-[0-9]+$`) is narrower than the content grammar; the served
 * `GET /v1/products/{id}` does not enforce it, so the wider content shape is accepted (recorded as a backend finding).
 */
export const PRODUCT_ID = /^TZP-[A-Za-z0-9-]{1,40}$/
export const NODE_ID = /^TZ[SCGV]-[0-9]{6}$/

export function isProductId(value: unknown): value is string {
  return typeof value === 'string' && PRODUCT_ID.test(value)
}

export function isNodeId(value: unknown): value is string {
  return typeof value === 'string' && NODE_ID.test(value)
}
