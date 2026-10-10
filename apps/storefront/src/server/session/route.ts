import 'server-only'
import { NextResponse } from 'next/server'
import type { AuthError } from '@/server/session/service'

/** Shared plumbing of the `/api/auth/*` route handlers: bounded JSON in, normalised `no-store` JSON out. */
const MAX_BODY_BYTES = 2_048

export type BodyResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 413 }

/**
 * Reads the body as a stream and stops at the cap: an oversized (or lying-`Content-Length`, or chunked) body is
 * refused with 413 after at most `MAX_BODY_BYTES + 1` bytes were buffered.
 */
export async function readJsonObject(request: Request): Promise<BodyResult> {
  const type = request.headers.get('content-type') ?? ''
  if (!/^application\/json\s*(;|$)/i.test(type)) return { ok: false, status: 400 }
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) return { ok: false, status: 413 }
  const chunks: Uint8Array[] = []
  let size = 0
  if (request.body) {
    const reader = request.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {})
          return { ok: false, status: 413 }
        }
        chunks.push(value)
      }
    } catch {
      return { ok: false, status: 400 }
    }
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ok: true, value: value as Record<string, unknown> }
      : { ok: false, status: 400 }
  } catch {
    return { ok: false, status: 400 }
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
export const rejectBody = (status: 400 | 413) =>
  json(status, { ok: false, error: status === 413 ? 'too_large' : 'bad_request' })
export const disabled = () =>
  json(503, { ok: false, error: 'unavailable', retryAfterSeconds: null })
