import { json } from '@/server/session/route'
import { orderMutation, respondPlaceError } from '@/server/checkout/route'
import { renewReview } from '@/server/checkout/service'

/**
 * `POST /api/checkout/refresh` `{}`: asks for a new order review after the last one ended (an expired quote). It only
 * replaces the seed of the next quote's idempotency key in the sealed checkout cookie; it calls no backend and places
 * nothing.
 */
export const POST = (request: Request) =>
  orderMutation(
    request,
    (body) => (Object.keys(body).length === 0 ? {} : null),
    async (session) =>
      (await renewReview(session))
        ? json(200, { ok: true, data: null })
        : respondPlaceError('choice_changed', null),
  )
