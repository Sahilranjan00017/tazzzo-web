/**
 * Identifier shapes, copied from the backend's content grammar (`ContentBlock.PRODUCT_ID` / `NODE_ID`) so that every id
 * a published block can carry is routable here, and nothing else reaches a backend path.
 *
 * The canonical product-id grammar is `^TZP-[A-Za-z0-9-]{1,40}$` (full match, no case normalisation: lowercase and
 * mixed case are valid and preserved exactly; the backend enforces the same on writes).
 *
 * Both are also the public OpenAPI path patterns (`ProductId` since backend #110, `NodeId`), the one canonical grammar.
 */
export const PRODUCT_ID = /^TZP-[A-Za-z0-9-]{1,40}$/
export const NODE_ID = /^TZ[SCGV]-[0-9]{6}$/

export function isProductId(value: unknown): value is string {
  return typeof value === 'string' && PRODUCT_ID.test(value)
}

export function isNodeId(value: unknown): value is string {
  return typeof value === 'string' && NODE_ID.test(value)
}
