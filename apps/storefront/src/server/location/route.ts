import 'server-only'
import type { NextResponse } from 'next/server'
import type { LocationError } from '@/lib/location/messages'
import type { LocationOutcome } from '@/server/location/service'
import { readSession, type CustomerSession } from '@/server/session/cookies'
import { isSameOriginMutation } from '@/server/session/csrf'
import { forbidden, json, readJsonObject, rejectBody } from '@/server/session/route'

/** Shared plumbing of the `/api/location*` and `/api/checkout/*` route handlers. */
const STATUS: Record<LocationError, number> = {
  invalid_pin: 400,
  unauthenticated: 401,
  forbidden: 403,
  bad_request: 400,
  not_found: 404,
  rate_limited: 429,
  unavailable: 503,
}

export function respondLocation<T>(
  outcome: LocationOutcome<T> | { ok: false; error: string; retryAfterSeconds: number | null },
): NextResponse {
  if (outcome.ok) return json(200, { ok: true, data: outcome.data })
  const retry: Record<string, string> =
    outcome.retryAfterSeconds !== null ? { 'Retry-After': String(outcome.retryAfterSeconds) } : {}
  return json(
    STATUS[outcome.error as LocationError] ?? 400,
    { ok: false, error: outcome.error, retryAfterSeconds: outcome.retryAfterSeconds },
    retry,
  )
}

/**
 * A location mutation (`POST`, JSON). Same order as the cart's: the CSRF rule first (with the session's token when
 * there is one, else the literal `1` as before sign-in), then the body (bounded, exactly the expected fields), then
 * the work. `needsSession`: the route needs a signed-in customer (401 otherwise, after the CSRF rule).
 */
export async function locationMutation<I>(
  request: Request,
  parse: (body: Record<string, unknown>) => I | null,
  run: (session: CustomerSession | null, input: I) => Promise<NextResponse>,
  needsSession = false,
): Promise<NextResponse> {
  const session = await readSession()
  if (!isSameOriginMutation(request.headers, session?.csrf ?? '1')) return forbidden()
  if (needsSession && session === null) {
    return respondLocation({ ok: false, error: 'unauthenticated', retryAfterSeconds: null })
  }
  const body = await readJsonObject(request)
  if (!body.ok) return rejectBody(body.status)
  const input = parse(body.value)
  if (input === null) return rejectBody(400)
  return run(session, input)
}
