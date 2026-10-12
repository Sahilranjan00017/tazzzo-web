import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertNoSecretValuesIn,
  deployManifest,
  entrypointSource,
  packageCompute,
} from './package-compute.mjs'
import {
  CONTRACT,
  REQUIRED_SECRETS,
  assertNoPublicSecrets,
  selectRuntimeEnv,
} from './runtime-env.mjs'
import { judge, nonceOf, smoke } from './smoke.mjs'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const GOOD_STOREFRONT = {
  TAZZZO_API_BASE_URL: 'https://api-uat.example.test',
  TAZZZO_SITE_URL: 'https://uat.example.test',
  STOREFRONT_SESSION_SECRET: 'c2Vzc2lvbi1zZWNyZXQtc2Vzc2lvbi1zZWNyZXQtMzI=',
}
const GOOD_ADMIN = {
  CMS_BASE_URL: 'https://cms-uat.example.test',
  GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'google-secret-value',
  GOOGLE_HOSTED_DOMAIN: 'example.test',
  TAZZZO_BACKEND_URL: 'https://api-uat.example.test',
  SESSION_STORE_URL: 'rediss://:pw@redis.example.test:6380',
  SESSION_ENCRYPTION_KEY: 'a2V5LWtleS1rZXkta2V5LWtleS1rZXkta2V5LWtleS0zMg',
}

describe('runtime env contract', () => {
  it('covers every variable the apps read (apps/*/src/server/env.ts, proxy.ts, rate-limit.ts)', () => {
    const names = (app) => [
      ...CONTRACT[app].required,
      ...CONTRACT[app].optional,
      ...CONTRACT[app].secret,
    ]
    const sources = {
      storefront: [
        read('apps/storefront/src/server/env.ts'),
        read('apps/storefront/src/lib/security/rate-limit.ts'),
      ],
      admin: [read('apps/admin/src/server/env.ts'), read('apps/admin/src/proxy.ts')],
    }
    for (const app of Object.keys(sources)) {
      const used = new Set()
      for (const src of sources[app]) {
        for (const m of src.matchAll(/\b((?:TAZZZO|STOREFRONT|CMS|GOOGLE|SESSION)_[A-Z_]+)\b/g))
          used.add(m[1])
      }
      // GOOGLE_ISSUER is a test seam, GOOGLE_ISSUER-like constants are not env names.
      used.delete('GOOGLE_ISSUER')
      // prefixes quoted in comments (TAZZZO_CALLER_*) end with an underscore
      const missing = [...used].filter((n) => !n.endsWith('_') && !names(app).includes(n))
      assert.deepEqual(
        missing.filter((n) => !IGNORED.has(n)),
        [],
        `${app} reads variables missing from the contract`,
      )
    }
  })

  it('never forwards the GOOGLE_ISSUER test seam', () => {
    assert.ok(!CONTRACT.admin.optional.includes('GOOGLE_ISSUER'))
    const { values } = selectRuntimeEnv('admin', {
      ...GOOD_ADMIN,
      GOOGLE_ISSUER: 'http://evil.test',
    })
    assert.equal(values.GOOGLE_ISSUER, undefined)
  })

  it('forwards only allow-listed names', () => {
    const { values } = selectRuntimeEnv('storefront', {
      ...GOOD_STOREFRONT,
      AWS_SECRET_ACCESS_KEY: 'x',
      HOME: '/root',
    })
    assert.deepEqual(Object.keys(values).sort(), [
      'STOREFRONT_SESSION_SECRET',
      'TAZZZO_API_BASE_URL',
      'TAZZZO_SITE_URL',
    ])
  })

  it('reports missing variables by name only', () => {
    assert.throws(
      () => selectRuntimeEnv('admin', { CMS_BASE_URL: 'https://x.test' }),
      (e) => {
        assert.match(e.message, /GOOGLE_CLIENT_SECRET/)
        assert.doesNotMatch(e.message, /x\.test/)
        return true
      },
    )
    assert.ok(REQUIRED_SECRETS.storefront.includes('STOREFRONT_SESSION_SECRET'))
  })

  it('refuses http urls and a non-TLS session store, naming the variable but not the value', () => {
    assert.throws(
      () =>
        selectRuntimeEnv('storefront', {
          ...GOOD_STOREFRONT,
          TAZZZO_API_BASE_URL: 'http://api.test',
        }),
      (e) => /TAZZZO_API_BASE_URL/.test(e.message) && !/api\.test/.test(e.message),
    )
    assert.throws(
      () =>
        selectRuntimeEnv('admin', { ...GOOD_ADMIN, SESSION_STORE_URL: 'redis://localhost:6379' }),
      /SESSION_STORE_URL/,
    )
  })

  it('refuses a secret-like NEXT_PUBLIC_ variable', () => {
    assert.throws(
      () => assertNoPublicSecrets({ NEXT_PUBLIC_SESSION_KEY: 'x' }),
      /NEXT_PUBLIC_SESSION_KEY/,
    )
    assert.doesNotThrow(() =>
      assertNoPublicSecrets({ NEXT_PUBLIC_IMPORT_UPLOAD_SETTLE_MS: '90000' }),
    )
  })
})

const IGNORED = new Set([
  // not environment variable names
  'SESSION_COOKIES',
  'PUBLIC_PATHS',
])

describe('packaging', () => {
  function fakeBuild(app) {
    const root = mkdtempSync(join(tmpdir(), 'amplify-pkg-'))
    const appDir = join(root, 'apps', app)
    mkdirSync(join(appDir, '.next', 'standalone', 'apps', app), { recursive: true })
    mkdirSync(join(appDir, '.next', 'static', 'chunks'), { recursive: true })
    writeFileSync(join(appDir, '.next', 'standalone', 'apps', app, 'server.js'), '// server')
    writeFileSync(join(appDir, '.next', 'static', 'chunks', 'a.js'), 'console.log(1)')
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ dependencies: { next: '16.3.8' } }),
    )
    return { root, appDir }
  }

  it('writes manifest, entrypoint, and runtime env into compute only', () => {
    const { root, appDir } = fakeBuild('storefront')
    const result = packageCompute({ root, app: 'storefront', env: GOOD_STOREFRONT })
    const manifest = JSON.parse(
      readFileSync(join(appDir, '.amplify-hosting', 'deploy-manifest.json'), 'utf8'),
    )
    assert.equal(manifest.version, 1)
    assert.equal(manifest.routes.at(-1).path, '/*')
    assert.deepEqual(manifest.routes.at(-1).target, { kind: 'Compute', src: 'default' })
    assert.equal(manifest.computeResources[0].entrypoint, 'index.js')
    const env = JSON.parse(
      readFileSync(join(result.out, 'compute', 'default', 'runtime-env.json'), 'utf8'),
    )
    assert.equal(env.STOREFRONT_SESSION_SECRET, GOOD_STOREFRONT.STOREFRONT_SESSION_SECRET)
    assert.equal(
      readFileSync(join(result.out, 'static', '_next', 'static', 'chunks', 'a.js'), 'utf8'),
      'console.log(1)',
    )
  })

  it('fails when a secret value leaks into a client asset', () => {
    const { root, appDir } = fakeBuild('storefront')
    writeFileSync(
      join(appDir, '.next', 'static', 'chunks', 'leak.js'),
      `x="${GOOD_STOREFRONT.STOREFRONT_SESSION_SECRET}"`,
    )
    assert.throws(
      () => packageCompute({ root, app: 'storefront', env: GOOD_STOREFRONT }),
      (e) => {
        assert.match(e.message, /STOREFRONT_SESSION_SECRET/)
        assert.ok(!e.message.includes(GOOD_STOREFRONT.STOREFRONT_SESSION_SECRET))
        return true
      },
    )
    const dir = mkdtempSync(join(tmpdir(), 'amplify-leak-'))
    assert.doesNotThrow(() => assertNoSecretValuesIn(dir, { A: 'longsecretvalue' }))
  })

  it('refuses to package without a standalone build', () => {
    const root = mkdtempSync(join(tmpdir(), 'amplify-none-'))
    assert.throws(
      () => packageCompute({ root, app: 'admin', env: GOOD_ADMIN }),
      /no standalone build/,
    )
  })

  it('entrypoint pins production mode and binds all interfaces', () => {
    const src = entrypointSource('admin')
    assert.match(src, /import\('\.\/apps\/admin\/server\.js'\)/)
    assert.match(src, /HOSTNAME = '0\.0\.0\.0'/)
    assert.match(src, /NODE_ENV = 'production'/)
    assert.equal(
      deployManifest({ nextVersion: '16.3.8', runtime: 'nodejs22.x' }).framework.version,
      '16.3.8',
    )
  })
})

describe('smoke verdict', () => {
  const headers = (nonce, extra = {}) =>
    new Headers({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
      ...extra,
    })
  const NONCE_A = 'QUFBQUFBQUFBQUFBQUFBQQ=='
  const NONCE_B = 'QkJCQkJCQkJCQkJCQkJCQg=='

  it('passes with distinct nonces', () => {
    assert.deepEqual(
      judge({ status: 200, headers: headers(NONCE_A) }, { status: 200, headers: headers(NONCE_B) }),
      [],
    )
    assert.equal(nonceOf(headers(NONCE_A).get('content-security-policy')), NONCE_A)
  })

  it('fails on a repeated nonce, a missing header or unsafe CSP', () => {
    const repeated = judge(
      { status: 200, headers: headers(NONCE_A) },
      { status: 200, headers: headers(NONCE_A) },
    )
    assert.match(repeated.join(), /cached/)
    const bare = judge(
      { status: 500, headers: new Headers() },
      { status: 200, headers: headers(NONCE_B) },
    )
    assert.match(bare.join(), /status 500/)
    const unsafe = judge(
      {
        status: 200,
        headers: headers(NONCE_A, {
          'content-security-policy': `script-src 'unsafe-inline' 'nonce-${NONCE_A}'`,
        }),
      },
      { status: 200, headers: headers(NONCE_B) },
    )
    assert.match(unsafe.join(), /unsafe/)
  })

  it('retries and reports a network failure without throwing', async () => {
    const result = await smoke('storefront', 'https://uat.example.test', {
      fetchImpl: async () => {
        throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
      },
      attempts: 2,
      delayMs: 1,
    })
    assert.match(result.failures.join(), /ENOTFOUND/)
    await assert.rejects(smoke('storefront', 'http://uat.example.test'), /https/)
  })
})

describe('repository wiring', () => {
  it('amplify.yml has one entry per app with the matching appRoot and pnpm frozen install', () => {
    const yml = read('amplify.yml')
    for (const app of ['storefront', 'admin']) {
      assert.ok(yml.includes(`appRoot: apps/${app}`), app)
      assert.ok(yml.includes(`node scripts/amplify/package-compute.mjs ${app}`), app)
    }
    assert.match(yml, /pnpm install --frozen-lockfile/)
    assert.doesNotMatch(yml, /env \| grep|printenv|>> *\.env/)
  })

  it('deploy workflow: OIDC only, gated on CI, pinned actions, no static AWS keys', () => {
    const wf = read('.github/workflows/deploy-uat-web.yml')
    assert.match(wf, /id-token: write/)
    assert.match(wf, /uses: \.\/\.github\/workflows\/ci\.yml/)
    assert.match(wf, /needs: ci/)
    assert.match(wf, /environment: uat/)
    assert.match(wf, /--job-type RELEASE/)
    assert.doesNotMatch(wf, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|secrets\.AWS/)
    for (const use of wf.match(/uses: [^\n]+/g) ?? []) {
      if (use.startsWith('uses: ./')) continue
      assert.match(use, /@[0-9a-f]{40}\b/, `unpinned action: ${use}`)
    }
  })
})
