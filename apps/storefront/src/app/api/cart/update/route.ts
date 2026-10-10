import { parseSet } from '@/lib/cart/validation'
import { mutation } from '@/server/cart/route'
import { setQuantity } from '@/server/cart/service'

/** `POST /api/cart/update` `{productId, quantity, version}`: sets the line to exactly `quantity` (`PUT` with `If-Match`). */
export const POST = (request: Request) =>
  mutation(request, parseSet, (session, input) =>
    setQuantity(session, input.productId, input.quantity, input.version),
  )
