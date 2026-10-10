import { parseUpdate } from '@/lib/address/validation'
import { editAddress } from '@/server/address/service'
import { mutation } from '@/server/address/route'

/** `POST /api/addresses/update` `{addressId, version, ...the nine address fields}` -> `PATCH` with `If-Match: "address-<version>"`. */
export const POST = (request: Request) =>
  mutation(request, parseUpdate, (session, input) =>
    editAddress(session, input.addressId, input.version, input.fields),
  )
