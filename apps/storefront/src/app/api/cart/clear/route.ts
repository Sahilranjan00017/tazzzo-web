import { parseClear } from '@/lib/cart/validation'
import { mutation } from '@/server/cart/route'
import { emptyCart } from '@/server/cart/service'

/** `POST /api/cart/clear` `{version}`: empties the cart (`DELETE` with `If-Match`). */
export const POST = (request: Request) =>
  mutation(request, parseClear, (session, input) => emptyCart(session, input.version))
