import { respondLocation, locationMutation } from '@/server/location/route'
import { setAddressLocation, setPinLocation } from '@/server/location/service'

/**
 * `POST /api/location` with EXACTLY one of:
 * - `{pin}`: checks the PIN with `GET /v1/serviceability` and remembers it (any visitor); an unserviceable PIN is
 *   remembered too, as "not delivering" (`serviceable: false`), so the site can say so;
 * - `{addressId}`: makes one of the signed-in customer's saved addresses the delivery location (the backend proves it
 *   is theirs: another customer's id is a 404). No customer id is accepted anywhere.
 */
type Input = { pin: string } | { addressId: string }

function parse(body: Record<string, unknown>): Input | null {
  const keys = Object.keys(body)
  if (keys.length !== 1) return null
  if (keys[0] === 'pin' && typeof body.pin === 'string') return { pin: body.pin }
  if (keys[0] === 'addressId' && typeof body.addressId === 'string') {
    return { addressId: body.addressId }
  }
  return null
}

export const POST = (request: Request) =>
  locationMutation(request, parse, async (session, input) => {
    if ('pin' in input) return respondLocation(await setPinLocation(input.pin))
    if (session === null) {
      return respondLocation({ ok: false, error: 'unauthenticated', retryAfterSeconds: null })
    }
    return respondLocation(await setAddressLocation(session, input.addressId))
  })

