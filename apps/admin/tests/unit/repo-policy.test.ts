import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Static policy checks over the repository itself: the cheapest way to keep W1's guarantees from eroding. */
const APP = join(__dirname, '..', '..')
const ROOT = join(APP, '..', '..')
const read = (...p: string[]) => readFileSync(join(...p), 'utf8')

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

const SOURCE = filesUnder(join(APP, 'src')).filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f))

describe('TypeScript strictness', () => {
  it('keeps strict mode and the extra safety flags on', () => {
    const { compilerOptions } = JSON.parse(read(APP, 'tsconfig.json')) as {
      compilerOptions: Record<string, unknown>
    }
    expect(compilerOptions).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true,
    })
  })

  it('bans explicit any in lint', () => {
    expect(read(APP, 'eslint.config.mjs')).toMatch(
      /'@typescript-eslint\/no-explicit-any':\s*'error'/,
    )
  })
})

describe('server/client boundary', () => {
  it('marks every module under src/server as server-only', () => {
    const serverFiles = SOURCE.filter((f) => relative(APP, f).startsWith(join('src', 'server')))
    expect(serverFiles.length).toBeGreaterThan(0)
    for (const f of serverFiles) {
      expect(read(f), relative(APP, f)).toMatch(/^import 'server-only'/m)
    }
  })

  it('never imports src/server from a client component', () => {
    for (const f of SOURCE.filter((f) => /^['"]use client['"]/m.test(read(f)))) {
      expect(read(f), relative(APP, f)).not.toMatch(/from ['"](@\/server|.*\/server\/)/)
    }
  })
})

describe('no fake or browser-held identity', () => {
  it('never uses browser storage or script-visible cookies', () => {
    for (const f of SOURCE) {
      expect(read(f), relative(APP, f)).not.toMatch(
        /\b(localStorage|sessionStorage|document\.cookie)\b/,
      )
    }
  })

  it('exposes no secret-like NEXT_PUBLIC_ variable in source', () => {
    for (const f of SOURCE.filter((f) => !f.endsWith(join('server', 'env.ts')))) {
      expect(read(f), relative(APP, f)).not.toMatch(
        /NEXT_PUBLIC_\w*(SECRET|PASSWORD|PRIVATE|TOKEN|SESSION|CREDENTIAL|KEY)/,
      )
    }
  })

  it('has no OAuth, session-store or HTTP-client dependency and no auth or BFF routes in W1', () => {
    const pkg = JSON.parse(read(APP, 'package.json')) as Record<string, Record<string, string>>
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    for (const banned of [
      'openid-client',
      'next-auth',
      '@auth/core',
      'redis',
      'ioredis',
      'iovalkey',
      'axios',
    ]) {
      expect(deps, banned).not.toContain(banned)
    }
    const routes = SOURCE.map((f) => relative(join(APP, 'src', 'app'), f))
    expect(routes.filter((r) => r.startsWith('api') || r.endsWith('route.ts'))).toEqual([])
  })
})

describe('toolchain pins agree', () => {
  const rootPkg = JSON.parse(read(ROOT, 'package.json')) as {
    packageManager: string
    engines: { node: string }
  }
  const nvmrc = read(ROOT, '.nvmrc').trim()
  const ci = read(ROOT, '.github', 'workflows', 'ci.yml')

  it('pins pnpm exactly and Node consistently across .nvmrc, engines and CI', () => {
    expect(rootPkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/)
    expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/)
    const major = nvmrc.split('.')[0]
    expect(rootPkg.engines.node).toBe(`>=${nvmrc} <${Number(major) + 1}`)
    expect(ci).toContain("node-version-file: '.nvmrc'")
    expect(ci).not.toMatch(/node-version:\s/)
  })

  it('installs from the lockfile only in CI', () => {
    const installs = ci.match(/pnpm install[^\n]*/g) ?? []
    expect(installs.length).toBeGreaterThan(0)
    for (const install of installs) {
      expect(install).toContain('--frozen-lockfile')
    }
  })
})
