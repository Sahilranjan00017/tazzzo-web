import 'server-only'
import type { NextResponse } from 'next/server'
import type { CartError } from '@/lib/cart/messages'
import type { CartOutcome } from '@/server/cart/service'
import { readSession, type CustomerSession } from '@/server/session/cookies'
import { isSameOriginMutation } from '@/server/session/csrf'
import { forbidden, json, readJsonObject, rejectBody } from '@/server/session/route'

/** Shared plumbing of the `/api/cart/*` route handlers, on top of the session routes' (`server/session/route.ts`). */
const STATUS: Record<CartError, number> = {
  unauthenticated: 401,
  forbidden: 403,
  bad_request: 400,
  conflict: 409,
  not_found: 404,
  item_limit: 422,
  quantity_limit: 422,
  rate_limited: 429,
  unavailable: 503,
}

/** The normalised answer: the cart on success; on failure a closed code, and the fresh cart when it helps the screen. */
export function respond(outcome: CartOutcome): NextResponse {
  if (outcome.ok) return json(200, { ok: true, cart: outcome.cart })
  const retry: Record<string, string> =
    outcome.retryAfterSeconds !== null ? { 'Retry-After': String(outcome.retryAfterSeconds) } : {}
  return json(
    STATUS[outcome.error],
    {
      ok: false,
      error: outcome.error,
      retryAfterSeconds: outcome.retryAfterSeconds,
      ...(outcome.cart ? { cart: outcome.cart } : {}),
    },
    retry,
  )
}

/**
 * A cart mutation (`POST`, JSON, cookie-authenticated). Order matters: the CSRF rule first (with the session's token
 * when there is one, so a forged request is a 403 whether or not a session exists), then the session, then the body
 * (bounded, exactly the expected fields), and only then the backend.
 */
export async function mutation<T>(
  request: Request,
  parse: (body: Record<string, unknown>) => T | null,
  run: (session: CustomerSession, input: T) => Promise<CartOutcome>,
): Promise<NextResponse> {
  const session = await readSession()
  if (!isSameOriginMutation(request.headers, session?.csrf ?? '1')) return forbidden()
  if (session === null)
    return respond({ ok: false, error: 'unauthenticated', retryAfterSeconds: null })
  const body = await readJsonObject(request)
  if (!body.ok) return rejectBody(body.status)
  const input = parse(body.value)
  if (input === null) return rejectBody(400)
  return respond(await run(session, input))
}
