import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { OrderDetail } from '@/components/OrderDetail'
import { isOrderId } from '@/lib/orders/model'
import { cancelOfferedFor, pageOrder } from '@/server/orders/service'
import { readSession } from '@/server/session/cookies'
import { accessTokenUsable } from '@/server/session/service'

export const metadata: Metadata = { title: 'Your order', robots: { index: false, follow: false } }

/**
 * One order (`GET /v1/customer/orders/{id}`) and, with `?placed=1`, the confirmation the customer lands on right after
 * placing it. The id is checked against the backend's grammar before it goes anywhere near a path; ownership is the
 * bearer token alone, so another customer's order is the backend's 404 and reads exactly like an unknown id.
 */
export default async function OrderPage({ params, searchParams }: PageProps<'/orders/[id]'>) {
  const { id } = await params
  if (!isOrderId(id)) notFound()
  const query = await searchParams
  const placed = query.placed === '1'
  const here = `/orders/${id}${placed ? '?placed=1' : ''}`
  const session = await readSession()
  if (session === null) redirect(`/login?next=${encodeURIComponent(here)}`)
  const refresh = `/api/auth/refresh?next=${encodeURIComponent(here)}`
  const outcome = await pageOrder(session, id)
  if (!outcome.ok && outcome.error === 'unauthenticated') {
    redirect(accessTokenUsable(session) ? `${refresh}&rejected=1` : refresh)
  }
  if (!outcome.ok && outcome.error === 'not_found') notFound()
  if (!outcome.ok) {
    return (
      <section className="orders" aria-labelledby="order-title">
        <h1 id="order-title">Your order</h1>
        <p role="alert" data-testid="order-load-error">
          We could not load this order right now. If you just placed it, it is safe: check{' '}
          <Link href="/orders">your orders</Link> or <Link href={here}>try again</Link>.
        </p>
      </section>
    )
  }
  return (
    <OrderDetail
      order={outcome.data}
      placed={placed}
      cancelOffered={cancelOfferedFor(outcome.data)}
      csrfToken={session.csrf}
    />
  )
}
