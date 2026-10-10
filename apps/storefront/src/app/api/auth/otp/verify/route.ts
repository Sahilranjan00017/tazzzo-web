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
import { completeSignIn } from '@/server/session/service'

/** `POST /api/auth/otp/verify` `{ otp }`: verifies the code for this browser's challenge and starts the session. */
export async function POST(request: Request) {
  if (!isSameOriginMutation(request.headers)) return forbidden()
  if (!customerSessionsEnabled()) return disabled()
  const body = await readJsonObject(request)
  if (!body.ok) return rejectBody(body.status)
  const result = await completeSignIn(body.value.otp)
  if (!result.ok) return failure(result.error, result.retryAfterSeconds)
  return json(200, { ok: true })
}
