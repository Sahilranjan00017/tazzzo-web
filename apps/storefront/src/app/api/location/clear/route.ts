import { json } from '@/server/session/route'
import { locationMutation } from '@/server/location/route'
import { forgetLocation } from '@/server/location/service'

/** `POST /api/location/clear` `{}`: forgets the delivery location (the sealed cookie). */
export const POST = (request: Request) =>
  locationMutation(
    request,
    (body) => (Object.keys(body).length === 0 ? {} : null),
    async () => {
      await forgetLocation()
      return json(200, { ok: true, data: null })
    },
  )
