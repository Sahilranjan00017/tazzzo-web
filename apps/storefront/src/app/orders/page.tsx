import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { OrderList } from '@/components/OrderList'
import { isOrderCursor } from '@/lib/orders/model'
import { pageOrders } from '@/server/orders/service'
import { readSession } from '@/server/session/cookies'
import { accessTokenUsable } from '@/server/session/service'

export const metadata: Metadata = { title: 'Your orders', robots: { index: false, follow: false } }

const REFRESH = '/api/auth/refresh?next=/orders'

function first(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * The signed-in customer's order history (`GET /v1/customer/orders`, newest first, ownership by the bearer token
 * alone). `?cursor=` is the backend's own paging cursor; one that is not in its shape is dropped, not forwarded.
 */
export default async function OrdersPage({ searchParams }: PageProps<'/orders'>) {
  const params = await searchParams
  const asked = first(params.cursor)
  const cursor = isOrderCursor(asked) ? asked : null
  if (asked !== null && cursor === null) redirect('/orders')
  const session = await readSession()
  if (session === null) redirect('/login?next=/orders')
  const outcome = await pageOrders(session, cursor)
  if (!outcome.ok && outcome.error === 'unauthenticated') {
    redirect(accessTokenUsable(session) ? `${REFRESH}&rejected=1` : REFRESH)
  }
  if (!outcome.ok && outcome.error === 'bad_request' && cursor !== null) redirect('/orders')
  if (!outcome.ok) {
    return (
      <section className="orders" aria-labelledby="orders-title">
        <h1 id="orders-title">Your orders</h1>
        <p role="alert" data-testid="orders-load-error">
          We could not load your orders right now.{' '}
          <Link href={cursor ? `/orders?cursor=${encodeURIComponent(cursor)}` : '/orders'}>
            Try again
          </Link>
        </p>
      </section>
    )
  }
  return <OrderList page={outcome.data} first={cursor === null} />
}
