import { expect, test, type Page } from '@playwright/test'
import { E2E_CALLER_NAME, E2E_CALLER_SECRET } from './global-setup'

/**
 * The production build under its real policy. Every test records CSP violations (the DOM event, which fires for
 * blocked scripts, styles, style attributes and images alike), console errors and uncaught page errors, and requires
 * all three to be empty, apart from failed image loads a test causes on purpose.
 */
const backend = () => process.env.E2E_BACKEND_URL!
const media = () => process.env.E2E_MEDIA_URL!

interface Problems {
  violations: () => Promise<string[]>
  console: string[]
  page: string[]
}

async function watch(page: Page): Promise<Problems> {
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __csp: string[] }).__csp = seen
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.violatedDirective} ${e.blockedURI}`),
    )
  })
  const problems: Problems = {
    // Per document: the init script re-arms on every full load; client-side navigations keep the same list.
    violations: () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? []),
    console: [],
    page: [],
  }
  page.on('console', (m) => {
    if (m.type() === 'error') problems.console.push(m.text())
  })
  page.on('pageerror', (e) => problems.page.push(String(e)))
  return problems
}

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((d) => {
      const [name = '', ...values] = d.trim().split(/\s+/)
      return [name, values]
    }),
  )
}

test('production CSP: nonce-only scripts and styles, media origin only; the page runs with zero violations', async ({
  page,
}) => {
  const problems = await watch(page)
  const response = await page.goto('/')
  const csp = response?.headers()['content-security-policy'] ?? ''
  const d = directives(csp)
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]
  expect(nonce).toBeTruthy()
  expect(d.get('script-src')).toEqual(["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"])
  expect(d.get('style-src')).toEqual(["'self'", `'nonce-${nonce}'`])
  expect(d.get('img-src')).toEqual(["'self'", media()])
  expect(csp).not.toContain('unsafe-inline')
  expect(csp).not.toContain('unsafe-eval')

  // Stylesheets applied (a blocked stylesheet would leave the header unstyled).
  await expect(page.locator('.site-header')).toHaveCSS('background-color', 'rgb(91, 43, 224)')
  // A real image from the https media host decoded under img-src.
  const first = page.locator('.banner[data-block-id="CB_web1"] img')
  await expect
    .poll(() => first.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0)
  // The off-host banner image is never requested, so it cannot even be a violation: placeholder instead.
  await expect(
    page
      .locator('.banner[data-block-id="CB_offhost"]')
      .getByRole('img', { name: 'Spices', includeHidden: true }),
  ).toHaveAttribute('data-testid', 'image-fallback')

  expect(await problems.violations()).toEqual([])
  // Client-side navigation (RSC fetch under connect-src 'self') and the PDP gallery under the same policy.
  await page.locator('.banner[data-block-id="CB_web1"] a').click()
  await expect(page).toHaveURL(/\/p\/TZP-1001$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Basmati Rice 5 kg')
  await page.getByRole('button', { name: 'Show image 3 of 4: Back of pack' }).click()
  await expect(page.locator('.gallery__main img')).toHaveAttribute('alt', 'Back of pack')

  expect(await problems.violations()).toEqual([])
  // The PDP's 4th image is deliberately missing on the media host (404): that resource error is the only one allowed.
  expect(problems.console.filter((t) => !/Failed to load resource.*404/.test(t))).toEqual([])
  expect(problems.page).toEqual([])

  // Positive control: the policy really enforces, and the detector really sees it. An inline <style> without the
  // nonce (what 'unsafe-inline' would allow) is blocked and reported.
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.textContent = 'body { background: red }'
    document.head.append(style)
  })
  await expect.poll(problems.violations).toContainEqual(expect.stringMatching(/^style-src/))
  await expect(page.locator('body')).not.toHaveCSS('background-color', 'rgb(255, 0, 0)')
})

test('carousel under the production policy: controls work, autoplay runs, an explicit pause sticks', async ({
  page,
}) => {
  const problems = await watch(page)
  await page.clock.install()
  await page.goto('/')
  const carousel = page.getByTestId('banner-carousel').first()
  const visible = () => carousel.locator('.banner:not([hidden])').getAttribute('data-block-id')
  await expect(carousel.getByRole('button', { name: 'Pause slideshow' })).toBeVisible() // hydrated
  expect(await visible()).toBe('CB_web1')

  // Autoplay (pointer and focus outside the carousel).
  await page.mouse.move(1, 1)
  await page.clock.runFor(6_500)
  await expect.poll(visible).toBe('CB_both1')

  // Keyboard and buttons.
  await carousel.getByRole('button', { name: 'Next slide' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(visible).toBe('CB_web1')
  await carousel.getByRole('button', { name: 'Show slide 2: Fresh fruit' }).click()
  await expect.poll(visible).toBe('CB_both1')

  // Explicit pause survives the pointer and focus leaving.
  await carousel.getByRole('button', { name: 'Pause slideshow' }).click()
  await page.mouse.move(1, 1)
  await page.getByRole('searchbox', { name: 'Search products' }).focus()
  await page.clock.runFor(30_000)
  expect(await visible()).toBe('CB_both1')
  await carousel.getByRole('button', { name: 'Play slideshow' }).click()
  await page.mouse.move(1, 1)
  await page.getByRole('searchbox', { name: 'Search products' }).focus()
  await page.clock.runFor(6_500)
  await expect.poll(visible).toBe('CB_web1')

  expect(await problems.violations()).toEqual([])
  expect(problems.console.filter((t) => !/Failed to load resource.*404/.test(t))).toEqual([])
  expect(problems.page).toEqual([])
})

test('reduced motion in production: no autoplay and no pause/play control', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.install()
  await page.goto('/')
  const carousel = page.getByTestId('banner-carousel').first()
  await expect(carousel.getByRole('button', { name: 'Next slide' })).toBeVisible()
  await expect(carousel.getByRole('button', { name: /slideshow/ })).toHaveCount(0)
  await page.clock.runFor(30_000)
  await expect(carousel.locator('.banner:not([hidden])')).toHaveAttribute(
    'data-block-id',
    'CB_web1',
  )
})

test('CDN down in production: every image becomes the placeholder, the page stays intact', async ({
  page,
}) => {
  const problems = await watch(page)
  await fetch(`${backend()}/__control/media?down=1`, { method: 'POST' })
  try {
    await page.goto('/')
    const bannerFallback = page
      .locator('.banner[data-block-id="CB_web1"]')
      .getByRole('img', { name: 'Sacks of basmati rice' })
    await expect(bannerFallback).toHaveAttribute('data-testid', 'image-fallback')
    // The placeholder keeps the banner box and its brand mark sits in the centre (it used to be pinned top-left
    // because `.banner__media { display: block }` overrode the placeholder's flex layout).
    await expect(bannerFallback).toHaveCSS('display', 'flex')
    const frame = await bannerFallback.boundingBox()
    const mark = await bannerFallback.locator('svg').boundingBox()
    expect(frame && mark).toBeTruthy()
    expect(frame!.width).toBeGreaterThan(mark!.width * 2)
    expect(Math.abs(mark!.x + mark!.width / 2 - (frame!.x + frame!.width / 2))).toBeLessThanOrEqual(
      1,
    )
    expect(
      Math.abs(mark!.y + mark!.height / 2 - (frame!.y + frame!.height / 2)),
    ).toBeLessThanOrEqual(1)
    await expect(page.getByRole('heading', { name: 'Bestsellers' })).toBeVisible()
    await expect(
      page
        .getByRole('region', { name: 'Bestsellers' })
        .getByRole('img', { name: 'Basmati Rice 5 kg' }),
    ).toHaveAttribute('data-testid', 'image-fallback')
    await page
      .getByTestId('banner-carousel')
      .first()
      .getByRole('button', { name: 'Next slide' })
      .click()
    expect(await problems.violations()).toEqual([])
    expect(problems.console.filter((t) => !/Failed to load resource.*503/.test(t))).toEqual([])
    expect(problems.page).toEqual([])
  } finally {
    await fetch(`${backend()}/__control/media?down=0`, { method: 'POST' })
  }
})

async function backendRequests(): Promise<
  Array<{ path: string; caller: string | null; callerSecret: string | null }>
> {
  return (await (await fetch(`${backend()}/__control/requests`)).json()) as Array<{
    path: string
    caller: string | null
    callerSecret: string | null
  }>
}

test('per-visitor rate limit (default limits, behind a trusted proxy): a burst to /search gets 429', async ({
  request,
}) => {
  const visitor = { 'x-forwarded-for': '203.0.113.50' }
  const searchCalls = async () =>
    (await backendRequests()).filter((r) => r.path === '/v1/search').length
  const before = await searchCalls()

  const statuses: number[] = []
  for (let i = 0; i < 6; i++) {
    statuses.push((await request.get(`/search?q=rice${i}`, { headers: visitor })).status())
  }
  expect(statuses).toEqual([200, 200, 200, 200, 200, 200])

  const refused = await request.get('/search?q=dal', { headers: visitor, maxRedirects: 0 })
  expect(refused.status()).toBe(429)
  const headers = refused.headers()
  expect(Number(headers['retry-after'])).toBeGreaterThanOrEqual(1)
  expect(headers['content-type']).toBe('text/plain; charset=utf-8')
  expect(headers['cache-control']).toBe('no-store')
  expect(await refused.text()).toBe('Too many requests. Please wait a moment and try again.\n')
  // The security headers are unchanged on a refusal.
  expect(headers['content-security-policy']).toMatch(
    /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
  )
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['x-frame-options']).toBe('DENY')

  // A refused request never reaches the backend: exactly the six admitted searches did.
  expect((await searchCalls()) - before).toBe(6)

  // Writing a fresh address on the client-controlled left of X-Forwarded-For buys nothing.
  const spoofed = await request.get('/search?q=dal', {
    headers: { 'x-forwarded-for': '198.51.100.77, 203.0.113.50' },
  })
  expect(spoofed.status()).toBe(429)
  // Ordinary pages still have their own (larger) bucket; another visitor is unaffected.
  expect((await request.get('/', { headers: visitor })).status()).toBe(200)
  expect(
    (
      await request.get('/search?q=dal', { headers: { 'x-forwarded-for': '203.0.113.51' } })
    ).status(),
  ).toBe(200)
})

test('trusted backend caller: every backend read carries the credential; the browser never sees it', async ({
  page,
}) => {
  const bodies: string[] = []
  page.on('response', async (response) => {
    if (!response.url().startsWith('http://localhost')) return
    try {
      bodies.push(await response.text())
    } catch {
      // redirects and aborted responses have no body
    }
  })
  await page.goto('/')
  await page.locator('.banner[data-block-id="CB_web1"] a').click()
  await expect(page).toHaveURL(/\/p\/TZP-1001$/)
  await page.goto('/search?q=rice')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  const calls = await backendRequests()
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls) {
    expect(call.caller, call.path).toBe(E2E_CALLER_NAME)
    expect(call.callerSecret, call.path).toBe(E2E_CALLER_SECRET)
  }
  expect(bodies.length).toBeGreaterThan(3)
  for (const body of bodies) {
    expect(body).not.toContain(E2E_CALLER_SECRET)
    expect(body).not.toContain('TAZZZO_CALLER')
  }
})
