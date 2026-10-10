import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { startHarness, stopHarness, type Harness } from '../support/integration-env'

/**
 * End-to-end through the real Next.js runtime (`next dev`): proxy, protected layout (`requireAdmin`: request-time
 * cookies() and redirect()), route handlers and pages, driven like a browser with a manual cookie jar. Development
 * mode because production refuses any non-Google OIDC issuer by design.
 */

let h: Harness
let dev: ChildProcess
const PORT = 3977
const BASE = `http://localhost:${PORT}`
const jar = new Map<string, string>()
let serverLog = ''

async function go(path: string, init: RequestInit = {}) {
  const res = await fetch(new URL(path, BASE), {
    ...init,
    redirect: 'manual',
    headers: {
      ...(init.headers as Record<string, string>),
      cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    },
  })
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';')
    const [name, value] = pair!.split('=')
    if (/Max-Age=0/i.test(c) || value === '') jar.delete(name!)
    else jar.set(name!, value!)
  }
  return res
}

beforeAll(async () => {
  h = await startHarness()
  process.env.CMS_BASE_URL = BASE
  dev = spawn('node_modules/.bin/next', ['dev', '-p', String(PORT)], {
    env: { ...process.env, NODE_ENV: 'development' },
    detached: true,
  })
  dev.stdout?.on('data', (d) => (serverLog += d))
  dev.stderr?.on('data', (d) => (serverLog += d))
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(`${BASE}/login`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}, 120_000)

afterAll(async () => {
  if (dev?.pid) process.kill(-dev.pid, 'SIGTERM')
  await stopHarness(h)
})

it('sign-in, /me bootstrap, 403, 401 re-authentication and logout through the real runtime', async () => {
  let res = await go('/')
  expect(res.status).toBe(307)
  expect([`${BASE}/login?returnTo=%2F`, '/login?returnTo=%2F']).toContain(
    res.headers.get('location'),
  )

  res = await go('/login')
  const loginHtml = await res.text()
  expect(res.status).toBe(200)
  expect(loginHtml).toContain('href="/api/auth/google/start"')

  res = await go('/api/auth/google/start')
  expect(res.status).toBe(302)
  const params = new URL(res.headers.get('location')!).searchParams
  expect(jar.has('tz_cms_tx_dev')).toBe(true)
  const code = h.provider.issueCode({
    codeChallenge: params.get('code_challenge')!,
    redirectUri: params.get('redirect_uri')!,
    claims: {
      sub: '111',
      email: 'ops@tazzzo.test',
      email_verified: true,
      hd: 'tazzzo.test',
      nonce: params.get('nonce'),
    },
  })
  res = await go(`/api/auth/google/callback?code=${code}&state=${params.get('state')}`)
  expect(res.status).toBe(303)
  expect(jar.has('tz_cms_session_dev')).toBe(true)
  expect(jar.has('tz_cms_tx_dev')).toBe(false)

  res = await go('/')
  const home = await res.text()
  expect(res.status).toBe(200)
  expect(home).toContain('ops@tazzzo.test')
  expect(home).toContain('You can view and edit catalogue content.')
  expect(home).not.toContain('eyJ')
  // Home is the launcher: /me bootstraps the shell, then the existing dashboard summary feeds "Needs attention"
  const paths = h.backend.requests.map((r) => r.path)
  expect(paths).toContain('/api/v1/admin/me')
  expect(paths.at(-1)).toBe('/api/v1/admin/dashboard/summary')
  expect(h.backend.requests.at(-1)!.authorization).toMatch(/^Bearer eyJ/)
  expect(home).toContain('Needs attention')

  res = await go('/login')
  expect([307, 303, 302]).toContain(res.status)

  h.backend.status = 403
  res = await go('/')
  const denied = await res.text()
  expect(denied).toContain('Access denied')
  expect(jar.has('tz_cms_session_dev')).toBe(true)

  h.backend.status = 401
  res = await go('/')
  const redirectTarget =
    res.headers.get('location') ?? (await res.text()).match(/\/api\/auth\/expired/)?.[0]
  expect(redirectTarget).toContain('/api/auth/expired')
  res = await go('/api/auth/expired')
  expect([`${BASE}/login?error=expired`, '/login?error=expired']).toContain(
    res.headers.get('location'),
  )
  expect(jar.has('tz_cms_session_dev')).toBe(false)

  h.backend.status = 200
  await go('/api/auth/google/start')
  const p2 = new URL((await go('/api/auth/google/start')).headers.get('location')!).searchParams
  const code2 = h.provider.issueCode({
    codeChallenge: p2.get('code_challenge')!,
    redirectUri: p2.get('redirect_uri')!,
    claims: { sub: '111', email_verified: true, hd: 'tazzzo.test', nonce: p2.get('nonce') },
  })
  await go(`/api/auth/google/callback?code=${code2}&state=${p2.get('state')}`)
  expect(jar.has('tz_cms_session_dev')).toBe(true)
  res = await go('/api/auth/logout', { method: 'GET' })
  expect(res.status).toBe(405)
  res = await go('/api/auth/logout', {
    method: 'POST',
    headers: { origin: BASE, 'x-tazzzo-csrf': '1' },
  })
  expect(res.status).toBe(303)
  expect(jar.has('tz_cms_session_dev')).toBe(false)
  expect(serverLog).not.toMatch(/eyJ[\w-]{10,}\./)
}, 240_000)
