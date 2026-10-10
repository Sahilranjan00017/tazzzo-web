import Link from 'next/link'
import { ImagePlaceholder } from '@/components/ImagePlaceholder'
import { SafeImage } from '@/components/SafeImage'
import { ITEM_REASON_TEXT, type BlockedLine } from '@/lib/checkout/model'

/**
 * The review page when the backend refuses the cart as it stands: the lines it names and why. No order can be placed
 * until the cart is fixed, so the only way on is back to the cart (remove the line or lower the quantity).
 */
export function CheckoutBlocked({ lines }: { lines: BlockedLine[] }) {
  return (
    <section className="panel" aria-labelledby="checkout-title">
      <h1 id="checkout-title">Review your order</h1>
      <p role="alert" data-testid="checkout-blocked">
        {lines.length === 1 ? '1 item' : 'Some items'} in your cart cannot be ordered right now. No
        order was placed.
      </p>
      {lines.length > 0 && (
        <ul className="checkout-lines" aria-label="Items that cannot be ordered">
          {lines.map((line) => (
            <li
              key={line.productId}
              className="checkout-line cart-line--blocked"
              data-product-id={line.productId}
            >
              <div className="checkout-line__media">
                {line.imageUrl ? (
                  <SafeImage
                    src={line.imageUrl}
                    alt=""
                    width={64}
                    height={64}
                    className="cart-line__image"
                  />
                ) : (
                  <ImagePlaceholder label="" className="cart-line__image" />
                )}
              </div>
              <div className="checkout-line__body">
                <p className="checkout-line__title">{line.title ?? 'This item'}</p>
                <p className="cart-note cart-note--blocking">
                  <span className="visually-hidden">Problem: </span>
                  {ITEM_REASON_TEXT[line.reason]}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <Link href="/cart" className="button-link" data-testid="checkout-fix-cart">
          Go to your cart
        </Link>
      </div>
    </section>
  )
}
