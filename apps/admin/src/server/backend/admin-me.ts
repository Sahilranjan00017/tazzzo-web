import 'server-only'
import { z } from 'zod'

const adminMeSchema = z.object({
  actorType: z.string(),
  actorId: z.string(),
  email: z.string().optional(),
  roles: z.array(z.string()),
})

export type AdminMe = z.infer<typeof adminMeSchema>

export type AdminMeResult =
  | { kind: 'ok'; me: AdminMe }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' }

export const ADMIN_ME_PATH = '/api/v1/admin/me'

/**
 * `GET /api/v1/admin/me` with the human's Google ID token, server to server. The backend is the authorization
 * boundary: 401 means the identity is no longer accepted, 403 means identity proven but no admin access. There is
 * deliberately no other credential here: a human request is never retried as a service account.
 */
export async function fetchAdminMe(
  backendUrl: string,
  idToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AdminMeResult> {
  let response: Response
  try {
    response = await fetchImpl(new URL(ADMIN_ME_PATH, backendUrl), {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}`, Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    return { kind: 'unavailable' }
  }
  if (response.status === 401) return { kind: 'unauthenticated' }
  if (response.status === 403) return { kind: 'forbidden' }
  if (!response.ok) return { kind: 'unavailable' }
  const parsed = adminMeSchema.safeParse(await response.json().catch(() => undefined))
  return parsed.success ? { kind: 'ok', me: parsed.data } : { kind: 'unavailable' }
}

export const CMS_WRITER_ROLE = 'cms-writer'
