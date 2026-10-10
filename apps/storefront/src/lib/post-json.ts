export type PostReply<D = unknown> = {
  ok: boolean
  data?: D
  error?: string
  retryAfterSeconds?: number | null
  /** The HTTP status, when an answer arrived. */
  status?: number
  /** True when no usable JSON answer arrived (network failure, a proxy's HTML error page, a truncated body). */
  transport?: boolean
}

/** One mutation through the BFF with a CSRF token (the session's, or the literal `1` signed out). Never throws. */
export async function postJson<D = unknown>(
  path: string,
  csrfToken: string,
  body: unknown,
): Promise<PostReply<D>> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tazzzo-CSRF': csrfToken },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    })
    let reply: PostReply<D>
    try {
      reply = (await response.json()) as PostReply<D>
    } catch {
      return { ok: false, error: 'unavailable', status: response.status, transport: true }
    }
    return { ...reply, ok: response.ok && reply.ok === true, status: response.status }
  } catch {
    return { ok: false, error: 'unavailable', transport: true }
  }
}
