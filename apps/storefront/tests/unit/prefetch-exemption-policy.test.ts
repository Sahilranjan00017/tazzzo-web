import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import nextConfig from '../../next.config'
import { config as proxyConfig } from '@/proxy'

/**
 * Repository policy guarding the proxy matcher's prefetch exemption (`src/proxy.ts`, `config.matcher`).
 *
 * The proxy, and so the per-visitor rate limit, skips genuine Next router prefetches (`rsc: 1` + `next-router-prefetch:
 * 1`). That is safe only because, in Next 16.3.8, such a prefetch renders NO components and so makes no backend call:
 * `next/dist/server/app-render/walk-tree-with-flight-router-state.js` (~line 77-80) sends only the router state when
 * PPR is off AND the route tree has no `loading` component. Any of the following would make a prefetch render page
 * code (and call the backend) without being limited, so each must fail here until the exemption is re-examined:
 * - a `loading.*` file anywhere under `src/app` (a loading boundary is rendered for prefetches);
 * - PPR: `experimental.ppr`, a route's `export const experimental_ppr`, or `cacheComponents` (which enables PPR).
 */
const appRoot = fileURLToPath(new URL('../../', import.meta.url))
const appDir = join(appRoot, 'src', 'app')

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

describe('prefetch exemption policy (see src/proxy.ts matcher)', () => {
  it('has no loading.* file under src/app', () => {
    const loading = filesUnder(appDir).filter((path) =>
      /^loading\.(tsx|ts|jsx|js|mdx)$/.test(path.split('/').pop() ?? ''),
    )
    expect(loading).toEqual([])
  })

  it('does not enable PPR or cacheComponents in next.config', () => {
    const config = nextConfig as Record<string, unknown> & {
      experimental?: Record<string, unknown>
    }
    expect(config.cacheComponents).toBeUndefined()
    expect(config.experimental?.ppr).toBeUndefined()
    expect(config.experimental?.cacheComponents).toBeUndefined()
    // Also by text, so a value assembled indirectly is still caught.
    const source = readFileSync(join(appRoot, 'next.config.ts'), 'utf8')
    expect(source).not.toMatch(/\bppr\b|cacheComponents/)
  })

  it('does not opt any route into PPR', () => {
    const optIns = filesUnder(appDir).filter((path) =>
      /\bexperimental_ppr\b/.test(readFileSync(path, 'utf8')),
    )
    expect(optIns).toEqual([])
  })

  it('never exempts /api/*: route handlers ignore the prefetch headers and run in full', () => {
    const entries = proxyConfig.matcher as Array<{ source: string; missing?: unknown }>
    expect(entries.some((e) => e.source === '/api/:path*' && e.missing === undefined)).toBe(true)
    // Every handler outside /api (route.*, and metadata files such as robots, sitemap, manifest, icons, opengraph/twitter
    // images) runs in full whatever headers it carries, so each must be covered by a matcher entry without `missing`.
    const handlers = filesUnder(appDir).filter(
      (path) =>
        !path.includes('/src/app/api/') &&
        /\/(route|robots|sitemap|manifest|icon|apple-icon|favicon|opengraph-image|twitter-image)\.(ts|tsx|js|jsx|ico|png|jpg|svg|txt|xml|webmanifest)$/.test(
          path,
        ),
    )
    const served: Record<string, string> = {
      'robots.ts': '/robots.txt',
      'sitemap.ts': '/sitemap.xml',
    }
    const unlimited = entries.filter((e) => e.missing === undefined).map((e) => e.source)
    const uncovered = handlers
      .map((path) => path.split('/src/app/')[1]!)
      .filter((rel) => !(served[rel] && unlimited.includes(served[rel])))
    expect(uncovered).toEqual([])
    expect(handlers.map((p) => p.split('/src/app/')[1]).sort()).toEqual(['robots.ts', 'sitemap.ts'])
  })
})
