import { readSession } from '@/server/session/cookies'
import { respond } from '@/server/cart/route'
import { viewCart } from '@/server/cart/service'

/** `GET /api/cart`: the current cart (`GET /v1/customer/cart`) for a signed-in customer; `401` otherwise. Read-only. */
export async function GET() {
  const session = await readSession()
  if (session === null)
    return respond({ ok: false, error: 'unauthenticated', retryAfterSeconds: null })
  return respond(await viewCart(session))
}
