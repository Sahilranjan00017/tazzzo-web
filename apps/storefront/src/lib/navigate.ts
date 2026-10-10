/**
 * A full page load of one of our own paths. Used where the next page must be rendered from scratch: after an order is
 * placed (the header's cart count and the checkout cookies have changed) and when a session has ended.
 */
export function hardNavigate(path: string): void {
  window.location.assign(path)
}
