import { parseRemove } from '@/lib/cart/validation'
import { mutation } from '@/server/cart/route'
import { removeLine } from '@/server/cart/service'

/** `POST /api/cart/remove` `{productId, version}`: removes the line (`DELETE` with `If-Match`). */
export const POST = (request: Request) =>
  mutation(request, parseRemove, (session, input) =>
    removeLine(session, input.productId, input.version),
  )
