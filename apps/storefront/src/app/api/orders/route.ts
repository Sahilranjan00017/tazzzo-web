import { json } from '@/server/session/route'
import { orderMutation, parsePlaceBody, respondPlaceError } from '@/server/checkout/route'
import { placeOrder } from '@/server/checkout/service'

/**
 * `POST /api/orders` `{quoteId, cartVersion, addressId, slotId}`: places the Cash on Delivery order for the quote the
 * customer reviewed (`POST /v1/customer/orders`). The backend's `(customer, quoteId)` uniqueness makes a repeat safe:
 * pressing twice, retrying after a timeout or refreshing returns the SAME order. The answer is `{ok:true, data:
 * {orderId}}` or a closed error code; the customer, price, total and payment method are never taken from the request.
 */
export const POST = (request: Request) =>
  orderMutation(request, parsePlaceBody, async (session, input) => {
    const outcome = await placeOrder(session, input)
    return outcome.ok
      ? json(200, { ok: true, data: { orderId: outcome.orderId } })
      : respondPlaceError(outcome.error, outcome.retryAfterSeconds)
  })
