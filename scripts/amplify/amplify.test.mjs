import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertNoSecretValuesIn,
  deployManifest,
  entrypointSource,
  leakVariants,
  packageCompute,
} from './package-compute.mjs'
import { CONTRACT, assertNoPublicSecrets, selectRuntimeEnv } from './runtime-env.mjs'
import { validateRuntimeEnv } from './validate-runtime-env.mjs'
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
  SESSION_ENCRYPTION_KEY: 'q'.repeat(43),
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

const noValidate = () => {}

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
    const result = packageCompute({
      root,
      app: 'storefront',
      env: GOOD_STOREFRONT,
      validate: noValidate,
    })
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
      () => packageCompute({ root, app: 'storefront', env: GOOD_STOREFRONT, validate: noValidate }),
      (e) => {
        assert.match(e.message, /STOREFRONT_SESSION_SECRET/)
        assert.ok(!e.message.includes(GOOD_STOREFRONT.STOREFRONT_SESSION_SECRET))
        return true
      },
    )
    const dir = mkdtempSync(join(tmpdir(), 'amplify-leak-'))
    assert.doesNotThrow(() => assertNoSecretValuesIn(dir, { A: 'longsecretvalue' }))
  })

  it('validates before writing anything and stops the build on a rejected configuration', () => {
    const { root, appDir } = fakeBuild('admin')
    const calls = []
    assert.throws(
      () =>
        packageCompute({
          root,
          app: 'admin',
          env: GOOD_ADMIN,
          validate: (args) => {
            calls.push(args.values.SESSION_STORE_URL)
            throw new Error('the admin production configuration is invalid: SESSION_STORE_URL')
          },
        }),
      /SESSION_STORE_URL/,
    )
    assert.equal(calls.length, 1)
    assert.equal(existsSync(join(appDir, '.amplify-hosting')), false)
  })

  it('leak check covers plain, percent-encoded, JSON-escaped and base64 spellings', () => {
    const secret = 'p@ss/w0rd+value"x'
    const dir = mkdtempSync(join(tmpdir(), 'amplify-enc-'))
    for (const variant of leakVariants(secret)) {
      writeFileSync(join(dir, 'a.js'), `var x="${variant}"`)
      assert.throws(() => assertNoSecretValuesIn(dir, { S: secret }), /S in/, variant)
    }
    writeFileSync(join(dir, 'a.js'), 'nothing here')
    assert.doesNotThrow(() => assertNoSecretValuesIn(dir, { S: secret }))
    assert.deepEqual(leakVariants('short'), [])
  })

  it('refuses to package without a standalone build', () => {
    const root = mkdtempSync(join(tmpdir(), 'amplify-none-'))
    assert.throws(
      () => packageCompute({ root, app: 'admin', env: GOOD_ADMIN, validate: noValidate }),
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

// These run the apps' REAL parsers through vitest (needs installed dependencies, as in CI).
describe('production rules come from the apps parsers', { timeout: 120_000 }, () => {
  const run = (app, values) => validateRuntimeEnv({ root: ROOT, app, values })
  const failure = (app, values) => {
    try {
      run(app, values)
    } catch (e) {
      return e.message
    }
    return null
  }

  it('accepts a valid storefront and admin configuration', () => {
    assert.equal(
      failure('storefront', { ...GOOD_STOREFRONT, STOREFRONT_TRUST_PROXY: 'true' }),
      null,
    )
    assert.equal(failure('admin', GOOD_ADMIN), null)
  })

  it('fails the storefront build without STOREFRONT_TRUST_PROXY=true, naming the variable only', () => {
    const message = failure('storefront', GOOD_STOREFRONT)
    assert.match(message, /STOREFRONT_TRUST_PROXY/)
    assert.ok(!message.includes(GOOD_STOREFRONT.STOREFRONT_SESSION_SECRET))
  })

  it('fails on an http API url, a short session key and a missing secret', () => {
    const base = { ...GOOD_STOREFRONT, STOREFRONT_TRUST_PROXY: 'true' }
    assert.match(
      failure('storefront', { ...base, TAZZZO_API_BASE_URL: 'http://api.example.test' }),
      /TAZZZO_API_BASE_URL/,
    )
    assert.match(
      failure('storefront', { ...base, STOREFRONT_SESSION_SECRET: 'c2hvcnQ=' }),
      /STOREFRONT_SESSION_SECRET/,
    )
    const { STOREFRONT_SESSION_SECRET: _omit, ...without } = base
    assert.match(failure('storefront', without), /STOREFRONT_SESSION_SECRET/)
  })

  it('fails the admin build on a non-TLS store, a short encryption key and a bad media origin', () => {
    assert.match(
      failure('admin', { ...GOOD_ADMIN, SESSION_STORE_URL: 'redis://redis.example.test:6379' }),
      /SESSION_STORE_URL/,
    )
    assert.match(
      failure('admin', { ...GOOD_ADMIN, SESSION_ENCRYPTION_KEY: 'c2hvcnQ' }),
      /SESSION_ENCRYPTION_KEY/,
    )
    assert.match(
      failure('admin', {
        ...GOOD_ADMIN,
        CMS_MEDIA_UPLOAD_ORIGIN: 'https://bucket.example.test/path',
      }),
      /CMS_MEDIA_UPLOAD_ORIGIN/,
    )
    assert.match(
      failure('admin', { ...GOOD_ADMIN, CMS_BASE_URL: 'http://cms.example.test' }),
      /CMS_BASE_URL/,
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

  it('deploy workflow: OIDC through the AWS action, gated on CI, every third-party action pinned, no static AWS keys', () => {
    const wf = read('.github/workflows/deploy-uat-web.yml')
    assert.match(wf, /id-token: write/)
    assert.match(wf, /uses: \.\/\.github\/workflows\/ci\.yml/)
    assert.match(wf, /needs: \[guard\]/)
    assert.match(wf, /needs: \[guard, ci\]/)
    assert.match(wf, /environment: uat/)
    assert.match(wf, /--job-type RELEASE/)
    assert.match(wf, /aws-actions\/configure-aws-credentials@[0-9a-f]{40}/)
    assert.match(wf, /role-duration-seconds: 3600/)
    assert.doesNotMatch(wf, /ACTIONS_ID_TOKEN_REQUEST|AWS_WEB_IDENTITY_TOKEN_FILE/)
    assert.doesNotMatch(wf, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|secrets\.AWS/)
    for (const use of wf.match(/uses: [^\n]+/g) ?? []) {
      if (use.startsWith('uses: ./')) continue
      assert.match(use, /@[0-9a-f]{40}\b/, `unpinned action: ${use}`)
    }
  })
})
