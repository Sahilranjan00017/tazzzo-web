import 'server-only'
import type { NextResponse } from 'next/server'
import type { AddressError } from '@/lib/address/messages'
import type { AddressOutcome } from '@/server/address/service'
import { readSession, type CustomerSession } from '@/server/session/cookies'
import { isSameOriginMutation } from '@/server/session/csrf'
import {
  ADDRESS_BODY_BYTES,
  forbidden,
  json,
  readJsonObject,
  rejectBody,
} from '@/server/session/route'

/** Shared plumbing of the `/api/addresses/*` route handlers, on top of the session routes' (`server/session/route.ts`). */
const STATUS: Record<AddressError, number> = {
  unauthenticated: 401,
  forbidden: 403,
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  limit_reached: 409,
  idempotency_conflict: 409,
  rate_limited: 429,
  unavailable: 503,
}

/** The normalised answer: the data on success; on failure a closed code only. */
export function respond<T>(outcome: AddressOutcome<T>, successStatus = 200): NextResponse {
  if (outcome.ok) return json(successStatus, { ok: true, data: outcome.data })
  const retry: Record<string, string> =
    outcome.retryAfterSeconds !== null ? { 'Retry-After': String(outcome.retryAfterSeconds) } : {}
  return json(
    STATUS[outcome.error],
    { ok: false, error: outcome.error, retryAfterSeconds: outcome.retryAfterSeconds },
    retry,
  )
}

/**
 * An address mutation (`POST`, JSON, cookie-authenticated). Order matters: the CSRF rule first (with the session's
 * token when there is one, so a forged request is a 403 whether or not a session exists), then the session, then the
 * body (bounded, exactly the expected fields, no customer id of any kind), and only then the backend.
 */
export async function mutation<I, T>(
  request: Request,
  parse: (body: Record<string, unknown>) => I | null,
  run: (session: CustomerSession, input: I) => Promise<AddressOutcome<T>>,
  successStatus = 200,
): Promise<NextResponse> {
  const session = await readSession()
  if (!isSameOriginMutation(request.headers, session?.csrf ?? '1')) return forbidden()
  if (session === null)
    return respond({ ok: false, error: 'unauthenticated', retryAfterSeconds: null })
  const body = await readJsonObject(request, ADDRESS_BODY_BYTES)
  if (!body.ok) return rejectBody(body.status)
  const input = parse(body.value)
  if (input === null) return rejectBody(400)
  return respond(await run(session, input), successStatus)
}
