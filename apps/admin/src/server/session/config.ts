import 'server-only'
import { decodeKey, type ServerEnv } from '@/server/env'
import type { SessionConfig } from './session'

export function sessionConfig(env: ServerEnv): SessionConfig {
  const current = decodeKey(env.SESSION_ENCRYPTION_KEY)
  if (!current) throw new Error('invalid session encryption key')
  const previous = env.SESSION_ENCRYPTION_PREVIOUS_KEY
    ? decodeKey(env.SESSION_ENCRYPTION_PREVIOUS_KEY)
    : undefined
  return {
    keys: previous ? { current, previous } : { current },
    maxSeconds: env.CMS_SESSION_MAX_SECONDS,
    idleSeconds: env.CMS_SESSION_IDLE_SECONDS,
  }
}
