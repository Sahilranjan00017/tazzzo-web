import { customerSessionsEnabled } from '@/server/session/cookies'
import { isSameOriginMutation } from '@/server/session/csrf'
import {
  rejectBody,
  disabled,
  failure,
  forbidden,
  json,
  readJsonObject,
} from '@/server/session/route'
import { startSignIn } from '@/server/session/service'

/** `POST /api/auth/otp/request` `{ phone }`: sends a sign-in code. The challenge id stays in a sealed cookie. */
export async function POST(request: Request) {
  if (!isSameOriginMutation(request.headers)) return forbidden()
  if (!customerSessionsEnabled()) return disabled()
  const body = await readJsonObject(request)
  if (!body.ok) return rejectBody(body.status)
  const result = await startSignIn(body.value.phone)
  if (!result.ok) return failure(result.error, result.retryAfterSeconds)
  return json(200, { ok: true, ...result.data })
}
