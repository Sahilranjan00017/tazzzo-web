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

  it('uses only the ratified auth/session libraries and exposes only the declared auth and narrow BFF routes (no proxy)', () => {
    const pkg = JSON.parse(read(APP, 'package.json')) as Record<string, Record<string, string>>
    const runtime = Object.keys(pkg.dependencies ?? {})
    expect(runtime).toContain('openid-client')
    expect(runtime).toContain('ioredis')
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    for (const banned of ['next-auth', '@auth/core', 'axios', 'redis', 'iovalkey']) {
      expect(deps, banned).not.toContain(banned)
    }
    const routes = SOURCE.map((f) => relative(join(APP, 'src', 'app'), f)).filter(
      (r) => r.startsWith('api') || r.endsWith('route.ts'),
    )
    expect(routes.sort()).toEqual(
      [
        join('api', 'auth', 'expired', 'route.ts'),
        join('api', 'auth', 'google', 'callback', 'route.ts'),
        join('api', 'auth', 'google', 'start', 'route.ts'),
        join('api', 'auth', 'logout', 'route.ts'),
        join('api', 'bff', 'content', 'app-config', 'route.ts'),
        join('api', 'bff', 'content', 'blocks', '[blockId]', 'route.ts'),
        join('api', 'bff', 'content', 'blocks', '[blockId]', 'status', 'route.ts'),
        join('api', 'bff', 'content', 'faqs', 'route.ts'),
        join('api', 'bff', 'delivery', 'service-areas', '[pincode]', '[action]', 'route.ts'),
        join('api', 'bff', 'delivery', 'service-areas', '[pincode]', 'route.ts'),
        join(
          'api',
          'bff',
          'delivery',
          'slots',
          '[serviceAreaId]',
          '[windowId]',
          '[action]',
          'route.ts',
        ),
        join('api', 'bff', 'delivery', 'slots', '[serviceAreaId]', '[windowId]', 'route.ts'),
        join('api', 'bff', 'imports', '[kind]', 'route.ts'),
        join('api', 'bff', 'media', '[ownerType]', '[ownerId]', 'route.ts'),
        join('api', 'bff', 'media', 'uploads', 'route.ts'),
        join('api', 'bff', 'orders', '[orderId]', 'transition', 'route.ts'),
        join('api', 'bff', 'support', '[caseId]', 'assign', 'route.ts'),
        join('api', 'bff', 'support', '[caseId]', 'messages', 'route.ts'),
        join('api', 'bff', 'support', '[caseId]', 'status', 'route.ts'),
        join('api', 'bff', 'inventory', '[skuId]', '[locationId]', '[action]', 'route.ts'),
        join('api', 'bff', 'inventory', '[skuId]', '[locationId]', 'route.ts'),
        join('api', 'bff', 'pricing', '[skuId]', 'route.ts'),
        join(
          'api',
          'bff',
          'catalog',
          'products',
          '[productId]',
          'lifecycle',
          '[action]',
          'route.ts',
        ),
        join('api', 'bff', 'catalog', 'products', '[productId]', 'title', 'route.ts'),
        join('api', 'bff', 'catalog', 'products', 'route.ts'),
        join('api', 'bff', 'catalog', 'taxonomy', 'nodes', '[nodeId]', '[action]', 'route.ts'),
        join('api', 'bff', 'catalog', 'taxonomy', 'nodes', 'route.ts'),
        join('api', 'bff', 'catalog', 'taxonomy', 'releases', '[releaseId]', 'publish', 'route.ts'),
        join('api', 'bff', 'catalog', 'taxonomy', 'releases', 'route.ts'),
      ].sort(),
    )
  })

  it('has no generic proxy: no catch-all routes, no request-chosen backend target', () => {
    const appFiles = SOURCE.map((f) => relative(join(APP, 'src', 'app'), f))
    expect(appFiles.filter((r) => r.includes('[...') || r.includes('[[...'))).toEqual([])
    for (const f of SOURCE) {
      expect(read(f), relative(APP, f)).not.toMatch(
        /searchParams\.get\(\s*['"](url|path|target|backend|host)['"]/,
      )
    }
  })

  it('reaches the backend only from the three declared server modules, built from TAZZZO_BACKEND_URL', () => {
    const serverFetchers = SOURCE.filter(
      (f) =>
        /\bfetch(Impl)?\(|fetchImpl\(/.test(read(f)) &&
        relative(APP, f).startsWith(join('src', 'server')),
    )
    expect(serverFetchers.map((f) => relative(APP, f)).sort()).toEqual([
      join('src', 'server', 'backend', 'admin-me.ts'),
      join('src', 'server', 'backend', 'read.ts'),
      join('src', 'server', 'bff', 'mutation.ts'),
    ])
    // The read helper takes its URL from the caller (session-read.ts passes TAZZZO_BACKEND_URL) and never follows redirects.
    expect(read(join(APP, 'src', 'server', 'backend', 'read.ts'))).toMatch(/redirect: 'error'/)
    expect(read(join(APP, 'src', 'server', 'backend', 'session-read.ts'))).toMatch(
      /backendUrl: env\.TAZZZO_BACKEND_URL/,
    )
    expect(read(join(APP, 'src', 'server', 'bff', 'mutation.ts'))).toMatch(
      /new URL\(call\.path, env\.TAZZZO_BACKEND_URL\)/,
    )
    for (const f of SOURCE.filter((f) => /^['"]use client['"]/m.test(read(f)))) {
      for (const url of read(f).match(/fetch\(\s*[`'"][^`'"]*/g) ?? []) {
        expect(url, relative(APP, f)).toMatch(/fetch\(\s*[`'"]\/api\//)
      }
    }
  })

  it('sends bytes to object storage only from the upload module, never with credentials', () => {
    const xhr = SOURCE.filter((f) => /XMLHttpRequest\(\)/.test(read(f))).map((f) =>
      relative(APP, f),
    )
    expect(xhr).toEqual([join('src', 'lib', 'upload.ts')])
    const upload = read(APP, 'src', 'lib', 'upload.ts')
    expect(upload).toMatch(/xhr\.withCredentials = false/)
    expect(upload).toMatch(
      /CREDENTIAL = \/\^\(cookie\|cookie2\|authorization\|proxy-authorization\)\$\/i/,
    )
  })

  it('never holds a shared service token for human requests', () => {
    for (const f of SOURCE) {
      expect(read(f), relative(APP, f)).not.toMatch(
        /TAZZZO_(CMS|READ)_TOKEN|CMS_WRITER_TOKEN|service:cms-writer|shared-token/,
      )
    }
  })

  it('has no in-memory session/transaction store in production code (fail closed on store errors)', () => {
    for (const f of SOURCE.filter((f) => relative(APP, f).startsWith(join('src', 'server')))) {
      expect(read(f), relative(APP, f)).not.toMatch(/new Map\b|MemoryStore|memory-store/)
    }
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
    expect(ci).not.toContain('ubuntu-latest')
    expect(ci.match(/runs-on: ubuntu-24\.04/g)?.length).toBeGreaterThanOrEqual(7)
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

describe('CSP-safe markup and accessible shell (PR #4 hardening)', () => {
  it('has no inline style attributes in source (production CSP forbids them)', () => {
    const offenders = SOURCE.filter(
      (f) => !f.includes('/tests/') && /\bstyle=\{\{|\bstyle="/.test(readFileSync(f, 'utf8')),
    ).map((f) => relative(APP, f))
    expect(offenders).toEqual([])
  })

  it('global-error pulls in the stylesheet instead of styling inline', () => {
    const src = read(APP, 'src', 'app', 'global-error.tsx')
    expect(src).toContain("import './globals.css'")
    expect(src).toContain('className="fatal"')
  })

  it('keeps the closed mobile drawer out of the tab order via visibility:hidden', () => {
    const css = read(APP, 'src', 'app', 'globals.css')
    const mobile = css.slice(css.indexOf('@media (max-width: 900px)'))
    expect(mobile).toMatch(/\.sidebar\s*\{[^}]*visibility:\s*hidden/)
    expect(mobile).toMatch(/\.sidebar-open\s*\{[^}]*visibility:\s*visible/)
  })

  it('does not use ARIA menu roles on the account popover', () => {
    const src = read(APP, 'src', 'components', 'shell', 'ShellChrome.tsx')
    expect(src).not.toMatch(/role="menu(item)?"|aria-haspopup/)
  })
})
