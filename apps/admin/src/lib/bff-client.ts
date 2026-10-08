/**
 * Browser-side caller for the CMS BFF (same-origin JSON, CSRF header). It never talks to the backend. Results are a
 * closed union so UI code handles every outcome; mutations are NEVER retried here (no backend idempotency keys).
 */
export type BffResult<T> =
  | { ok: true; data: T; correlationId?: string; backendRequestId?: string }
  | {
      ok: false
      status: number
      error: string
      code?: string
      fields?: string[]
      /** Sanitized, route-specific detail (e.g. import row errors) supplied by the BFF spec; never raw backend data. */
      detail?: unknown
      correlationId?: string
      backendRequestId?: string
      retryAfterSeconds?: number
    }

export async function callBff<T = unknown>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<BffResult<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Tazzzo-CSRF': '1' },
      body: JSON.stringify(body ?? {}),
      redirect: 'error',
      cache: 'no-store',
    })
  } catch {
    return { ok: false, status: 0, error: 'network' }
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const trace = {
    correlationId: str(json.correlationId),
    backendRequestId: str(json.backendRequestId),
  }
  if (response.ok) return { ok: true, data: json.data as T, ...trace }
  const retry = Number(response.headers.get('retry-after'))
  return {
    ok: false,
    status: response.status,
    error: str(json.error) ?? 'error',
    code: str(json.code),
    ...(json.detail !== undefined ? { detail: json.detail } : {}),
    fields: Array.isArray(json.fields)
      ? json.fields.filter((f) => typeof f === 'string')
      : undefined,
    ...trace,
    ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
  }
}

/** Operator-friendly text for a failed BFF call. Never includes backend messages or stack data. */
export function bffErrorMessage(
  result: Extract<BffResult<unknown>, { ok: false }>,
  subject = 'change',
): string {
  switch (result.status) {
    case 0:
      return 'Could not reach the CMS. Check your connection and try again. The change was not confirmed, so check before repeating it.'
    case 400:
    case 422:
      return result.code
        ? `The backend rejected this ${subject} (${result.code}). Review the values and try again.`
        : `The ${subject} was rejected as invalid. Review the values and try again.`
    case 401:
      return 'Your session has ended. Please sign in again.'
    case 403:
      return `Your role is not permitted to make this ${subject}.`
    case 404:
      return 'This item no longer exists.'
    case 409:
      return result.code === 'STALE_VERSION'
        ? 'Someone else changed this since you loaded it. The latest version has been reloaded; review it and try again.'
        : result.code === 'STATE_CONFLICT'
          ? 'The item is not in a state that allows this action. The latest version has been reloaded.'
          : `This ${subject} conflicts with the current data (${result.code ?? 'conflict'}).`
    case 413:
      return 'The request is too large.'
    case 429:
      return result.retryAfterSeconds
        ? `Too many requests. Try again in ${result.retryAfterSeconds} seconds.`
        : 'Too many requests. Try again shortly.'
    default:
      return `The ${subject} could not be completed right now. It was not retried; check the current state before repeating it.`
  }
}
