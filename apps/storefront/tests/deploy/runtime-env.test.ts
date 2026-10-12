import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseServerEnv } from '@/server/env'
import { parseRateLimitConfig } from '@/lib/security/rate-limit'

/**
 * Not part of `pnpm test`: the "deploy" vitest project, run by scripts/amplify/validate-runtime-env.mjs during the Amplify
 * build. It applies the production rules of the real parsers to the variables about to be forwarded to the runtime. Skipped
 * unless AMPLIFY_RUNTIME_ENV_FILE is set. Failure messages name variables only.
 */
const file = process.env.AMPLIFY_RUNTIME_ENV_FILE
describe.skipIf(!file)('forwarded runtime environment', () => {
  it('satisfies the production server environment rules', () => {
    const values = JSON.parse(readFileSync(file as string, 'utf8')) as Record<string, string>
    const input = { ...values, NODE_ENV: 'production' }
    let failure: string | undefined
    try {
      parseServerEnv(input)
      parseRateLimitConfig(input)
    } catch (error) {
      failure = (error as Error).message
    }
    if (failure !== undefined) expect.fail(failure)
  })
})
