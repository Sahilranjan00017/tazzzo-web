import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { CheckoutBlocked } from '@/components/CheckoutBlocked'
import { CheckoutReview } from '@/components/CheckoutReview'
import { RefreshReview } from '@/components/RefreshReview'
import { REVIEW_UNAVAILABLE, placeErrorMessage } from '@/lib/checkout/messages'
import { reviewCheckout } from '@/server/checkout/service'
import { readSession } from '@/server/session/cookies'

export const metadata: Metadata = {
  title: 'Review your order',
  robots: { index: false, follow: false },
}

const REFRESH = '/api/auth/refresh?next=/checkout'

/**
 * The order review. Rendered on the server on every request from the backend's own answers: the cart, the saved
 * address, the slot and a fresh checkout QUOTE (`POST /v1/customer/checkout/quote`; an unchanged attempt gets the same
 * quote back). Nothing on this page comes from the browser except the session. Signed out goes to `/login` and back;
 * an empty cart goes to `/cart`, a missing or no longer valid address or slot to `/checkout/delivery`; an expired or
 * refused access token goes through `/api/auth/refresh`.
 */
export default async function CheckoutPage() {
  const session = await readSession()
  if (session === null) redirect('/login?next=/checkout')
  const review = await reviewCheckout(session)
  switch (review.kind) {
    case 'redirect':
      redirect(review.to)
    case 'unauthenticated':
      redirect(review.rejected ? `${REFRESH}&rejected=1` : REFRESH)
    case 'expired':
      return <RefreshReview csrfToken={session.csrf} />
    case 'blocked':
      return <CheckoutBlocked lines={review.lines} />
    case 'unavailable':
      return (
        <section className="panel" aria-labelledby="checkout-title">
          <h1 id="checkout-title">Review your order</h1>
          <p role="alert" data-testid="checkout-load-error">
            {review.rateLimited
              ? placeErrorMessage('rate_limited', review.retryAfterSeconds)
              : REVIEW_UNAVAILABLE}{' '}
            <Link href="/checkout">Try again</Link>
          </p>
        </section>
      )
    case 'ready':
      return <CheckoutReview view={review.view} csrfToken={session.csrf} />
  }
}
