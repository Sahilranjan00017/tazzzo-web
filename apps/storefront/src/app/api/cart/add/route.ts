import { parseAdd } from '@/lib/cart/validation'
import { mutation } from '@/server/cart/route'
import { addToCart } from '@/server/cart/service'

/** `POST /api/cart/add` `{productId, quantity}`: adds to the line (read, then `PUT` the sum under the cart version). */
export const POST = (request: Request) =>
  mutation(request, parseAdd, (session, input) =>
    addToCart(session, input.productId, input.quantity),
  )
