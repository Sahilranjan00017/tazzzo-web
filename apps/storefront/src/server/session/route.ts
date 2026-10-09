import 'server-only'
import { NextResponse } from 'next/server'
import type { AuthError } from '@/server/session/service'

/** Shared plumbing of the `/api/auth/*` route handlers: bounded JSON in, normalised `no-store` JSON out. */
const MAX_BODY_BYTES = 2_048

export type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false }

export async function readJsonObject(request: Request): Promise<BodyResult> {
  const type = request.headers.get('content-type') ?? ''
  if (!/^application\/json\s*(;|$)/i.test(type)) return { ok: false }
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) return { ok: false }
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) return { ok: false }
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ok: true, value: value as Record<string, unknown> }
      : { ok: false }
  } catch {
    return { ok: false }
  }
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

const STATUS: Record<AuthError, number> = {
  invalid_phone: 400,
  invalid_code: 400,
  expired: 400,
  rate_limited: 429,
  unavailable: 503,
}

export function failure(error: AuthError, retryAfterSeconds: number | null): NextResponse {
  const retry: Record<string, string> =
    retryAfterSeconds !== null ? { 'Retry-After': String(retryAfterSeconds) } : {}
  return json(STATUS[error], { ok: false, error, retryAfterSeconds }, retry)
}

export const forbidden = () => json(403, { ok: false, error: 'forbidden' })
export const badRequest = () => json(400, { ok: false, error: 'bad_request' })
export const disabled = () =>
  json(503, { ok: false, error: 'unavailable', retryAfterSeconds: null })
