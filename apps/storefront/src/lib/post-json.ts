export type PostReply<D = unknown> = {
  ok: boolean
  data?: D
  error?: string
  retryAfterSeconds?: number | null
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
    const reply = (await response.json()) as PostReply<D>
    return { ...reply, ok: response.ok && reply.ok === true }
  } catch {
    return { ok: false, error: 'unavailable' }
  }
}
