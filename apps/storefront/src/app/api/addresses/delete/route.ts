import { parseDelete } from '@/lib/address/validation'
import { removeAddress } from '@/server/address/service'
import { mutation } from '@/server/address/route'

/** `POST /api/addresses/delete` `{addressId, version}` -> `DELETE` with `If-Match: "address-<version>"`. */
export const POST = (request: Request) =>
  mutation(request, parseDelete, (session, input) =>
    removeAddress(session, input.addressId, input.version),
  )
