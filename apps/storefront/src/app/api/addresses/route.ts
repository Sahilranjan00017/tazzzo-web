import { parseCreate } from '@/lib/address/validation'
import { addAddress } from '@/server/address/service'
import { mutation } from '@/server/address/route'

/**
 * `POST /api/addresses` `{label, recipientName, recipientPhone, addressLine1, addressLine2, landmark, city, state,
 * postalCode, idempotencyKey}` -> `POST /v1/customer/addresses` with `Idempotency-Key` (a retry of the same save never
 * creates a second address). No other field is accepted; the customer is always the session's.
 */
export const POST = (request: Request) =>
  mutation(
    request,
    parseCreate,
    (session, input) => addAddress(session, input.fields, input.idempotencyKey),
    201,
  )
