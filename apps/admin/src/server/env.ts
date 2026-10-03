import 'server-only'
import { z } from 'zod'

/**
 * Server environment, validated at first use and cached. W1 needs no secrets: OAuth, session-store and backend
 * variables are added (and required) with the features that use them in W2. Never expose a server value through a
 * `NEXT_PUBLIC_*` variable: Next inlines those into the browser bundle.
 */
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
})

export type ServerEnv = z.infer<typeof serverEnvSchema>

/** Names that must never be browser-public, whatever their value. */
const SECRET_LIKE = /(SECRET|PASSWORD|PRIVATE|TOKEN|SESSION|CREDENTIAL|_KEY$|^KEY$|API_KEY)/

export function assertNoPublicSecrets(env: Record<string, string | undefined>): void {
  const leaked = Object.keys(env).filter(
    (name) =>
      name.startsWith('NEXT_PUBLIC_') && SECRET_LIKE.test(name.slice('NEXT_PUBLIC_'.length)),
  )
  if (leaked.length > 0) {
    throw new Error(`secret-like variables must not be NEXT_PUBLIC_: ${leaked.join(', ')}`)
  }
}

export function parseServerEnv(env: Record<string, string | undefined>): ServerEnv {
  assertNoPublicSecrets(env)
  const result = serverEnvSchema.safeParse(env)
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ')
    throw new Error(`invalid server environment: ${fields}`)
  }
  return result.data
}

let cached: ServerEnv | undefined

export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env)
  return cached
}
