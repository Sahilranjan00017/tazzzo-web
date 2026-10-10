import Link from 'next/link'

export default function OrderNotFound() {
  return (
    <section className="orders" aria-labelledby="order-title">
      <h1 id="order-title">Order not found</h1>
      <p data-testid="order-not-found">
        We could not find that order. It may not be yours, or the link may be wrong.{' '}
        <Link href="/orders">See your orders</Link>.
      </p>
    </section>
  )
}
