import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { CartView } from '@/components/CartView'
import { loadCartForPage } from '@/server/cart/service'
import { readSession } from '@/server/session/cookies'
import { accessTokenUsable } from '@/server/session/service'

export const metadata: Metadata = { title: 'Your cart', robots: { index: false, follow: false } }

const REFRESH = '/api/auth/refresh?next=/cart'

/**
 * The signed-in customer's cart (`GET /v1/customer/cart`), rendered from the backend's own enrichment (current price,
 * stock, issues). Signed out goes to `/login` and back here; an expired or refused access token goes through
 * `/api/auth/refresh`, exactly like `/account`.
 */
export default async function CartPage() {
  const session = await readSession()
  if (session === null) redirect('/login?next=/cart')
  const outcome = await loadCartForPage(session)
  if (!outcome.ok && outcome.error === 'unauthenticated') {
    // An access token we consider expired is refreshed; one the backend refused moments after issue ends the session.
    redirect(accessTokenUsable(session) ? `${REFRESH}&rejected=1` : REFRESH)
  }
  if (!outcome.ok) {
    return (
      <section className="cart" aria-labelledby="cart-title">
        <h1 id="cart-title">Your cart</h1>
        <p role="alert" data-testid="cart-load-error">
          We could not load your cart right now. <Link href="/cart">Try again</Link>
        </p>
      </section>
    )
  }
  return <CartView initial={outcome.cart} csrfToken={session.csrf} />
}
