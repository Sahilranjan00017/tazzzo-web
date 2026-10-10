/**
 * The browser-side memory of an order attempt with an unknown outcome (the answer never arrived, or was not ours).
 * `sessionStorage` of this tab only; unreadable storage reads as "nothing pending". Entries older than 30 minutes (the
 * life of the checkout choice) are ignored.
 */
const KEY = 'tz_pending_order'
const MAX_AGE_MS = 30 * 60 * 1000
const EVENT = 'tz-pending-order'

const announce = () => window.dispatchEvent(new Event(EVENT))

/** For `useSyncExternalStore`: the marker changed in this tab (or another). */
export function subscribePendingOrder(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

export function markPendingOrder(quoteId: string): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ quoteId, at: Date.now() }))
  } catch {
    // storage blocked: the server-side marker and the on-screen message still apply
  }
  announce()
}

export function readPendingOrder(): { quoteId: string } | null {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { quoteId?: unknown; at?: unknown }
    if (typeof parsed.quoteId !== 'string' || typeof parsed.at !== 'number') return null
    return Date.now() - parsed.at <= MAX_AGE_MS ? { quoteId: parsed.quoteId } : null
  } catch {
    return null
  }
}

export function clearPendingOrder(): void {
  try {
    window.sessionStorage.removeItem(KEY)
  } catch {
    // nothing to clear
  }
  announce()
}
