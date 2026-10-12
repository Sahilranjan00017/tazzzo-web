// Runs the app's REAL `parseServerEnv` (apps/<app>/src/server/env.ts) with NODE_ENV=production over exactly the variables that
// will be forwarded to the runtime, so every fail-closed production rule (https, rediss, key lengths, STOREFRONT_TRUST_PROXY,
// CMS_MEDIA_* grammar, ...) fails the BUILD instead of the first request after a release. It executes the app's own vitest
// "deploy" project (tests/deploy/runtime-env.test.ts), which resolves the `@/` alias and the `server-only` stub the same way
// the app's unit tests do. The values reach the child through a 0600 temp file, never argv; failures name variables only.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function validateRuntimeEnv({ root, app, values }) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-env-'))
  const file = join(dir, 'runtime-env.json')
  try {
    writeFileSync(file, JSON.stringify(values), { mode: 0o600 })
    execFileSync(
      'pnpm',
      ['--filter', app, 'exec', 'vitest', 'run', '--project', 'deploy', '--reporter=dot'],
      {
        cwd: root,
        env: { ...process.env, AMPLIFY_RUNTIME_ENV_FILE: file },
        stdio: 'pipe',
        encoding: 'utf8',
      },
    )
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}`
    const named =
      /invalid (?:server )?environment[^\n]*|invalid rate limit configuration[^\n]*/.exec(out)
    throw new Error(
      `the ${app} production configuration is invalid: ${named ? named[0].slice(0, 300) : 'see the validator output'}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
