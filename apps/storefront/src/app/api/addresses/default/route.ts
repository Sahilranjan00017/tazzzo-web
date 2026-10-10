import { parseDefault } from '@/lib/address/validation'
import { makeDefault } from '@/server/address/service'
import { mutation } from '@/server/address/route'

/** `POST /api/addresses/default` `{addressId}` -> `PUT /v1/customer/addresses/{id}/default`. */
export const POST = (request: Request) =>
  mutation(request, parseDefault, (session, input) => makeDefault(session, input.addressId))
