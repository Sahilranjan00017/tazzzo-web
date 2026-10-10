import { expect, test, type Page } from '@playwright/test'

/**
 * Launch pages (FAQ, Privacy, Terms, Contact), footer and login legal links, empty/404 states, the narrow-screen header
 * and the favicon, against the real Next.js runtime and the fake public API (tests/support/fake-backend.ts defaults:
 * FAQs seeded; `terms` published with markup-looking text; `privacy` NOT published; valid support phone and email).
 *
 * Mutation notes (what each assertion catches):
 * - /terms and /faq: rendering the plain text as HTML runs the planted `<script>` (`window.__legalXss`/`__faqXss`) and
 *   turns `<b>` into an element: the literal-text and flag assertions fail;
 * - /contact: building a `tel:` href from a non-E.164 string is covered at unit/component level (the fake's valid
 *   values are always links here);
 * - footer: dropping a footer link, or pointing it elsewhere, fails the href table.
 */
const API = () => process.env.E2E_BACKEND_URL!

async function signIn(page: Page, next = '/account') {
  await page.goto(`/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel('Mobile number').fill('9876543210')
  await page.getByRole('button', { name: 'Send code' }).click()
  await page.getByLabel('6-digit code').fill('123456')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'))
}

/** Landmarks, one h1 and named links: the accessibility floor for every page. */
async function expectAccessibleStructure(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('banner')).toHaveCount(1)
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(page.getByRole('contentinfo')).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  const unnamed = await page
    .locator('a[href]')
    .evaluateAll((links) =>
      links
        .filter((a) => (a.getAttribute('aria-label') ?? a.textContent ?? '').trim() === '')
        .map((a) => a.getAttribute('href')),
    )
  expect(unnamed).toEqual([])
}

test.describe('FAQ', () => {
  test('200, grouped by category, questions are native disclosures that work without JavaScript', async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    const page = await context.newPage()
    const response = await page.goto('/faq')
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1, name: 'Help and FAQ' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Delivery', 'Payment'])
    const summary = page.getByText('How long does delivery take?')
    await expect(page.getByText('Most orders arrive within a day.')).toBeHidden()
    await summary.click()
    await expect(page.getByText('Most orders arrive within a day.')).toBeVisible()
    await expect(page.getByText('You pick a slot at checkout.')).toBeVisible()
    await context.close()
  })

  test('question and answer are shown as literal text, never executed', async ({ page }) => {
    await page.goto('/faq')
    await expect(page.getByText('Do you deliver to my area <b>today</b>?')).toBeVisible()
    expect(await page.locator('main b, main script').count()).toBe(0)
    expect(
      await page.evaluate(() => (window as unknown as { __faqXss?: number }).__faqXss),
    ).toBeUndefined()
  })

  test('structure, and a link on to Contact', async ({ page }) => {
    await page.goto('/faq')
    await expectAccessibleStructure(page)
    await page.getByRole('main').getByRole('link', { name: 'Contact us' }).click()
    await expect(page).toHaveURL(/\/contact$/)
  })

  test('asks the backend for the FAQ with no query string', async ({ page }) => {
    await page.goto('/faq')
    const calls = (await (await fetch(`${API()}/__control/requests`)).json()) as Array<{
      path: string
      query: string
    }>
    for (const c of calls.filter((r) => r.path === '/v1/content/faqs')) expect(c.query).toBe('')
  })
})

test.describe('legal pages', () => {
  test('/terms (published): escaped plain-text paragraphs, effective date, no markup executed', async ({
    page,
  }) => {
    const response = await page.goto('/terms')
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1, name: 'Terms of service' })).toBeVisible()
    await expect(page.getByText('1 March 2026')).toBeVisible()
    const paragraphs = page.locator('article.legal p.legal__p')
    await expect(paragraphs).toHaveCount(3)
    await expect(paragraphs.nth(1)).toHaveText(
      'Orders are subject to availability. <script>window.__legalXss = 1</script>',
    )
    await expect(paragraphs.nth(2)).toHaveText('Prices include <b>all taxes</b> unless stated.')
    expect(await page.locator('article b, article script').count()).toBe(0)
    expect(
      await page.evaluate(() => (window as unknown as { __legalXss?: number }).__legalXss),
    ).toBeUndefined()
    await expectAccessibleStructure(page)
    // Published: indexable (no noindex robots meta).
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0)
  })

  test('/privacy (unpublished): a real page, status 200, friendly message, link to Contact, noindex', async ({
    page,
  }) => {
    const response = await page.goto('/privacy')
    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeVisible()
    await expect(page.getByText("This document hasn't been published yet.")).toBeVisible()
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
    await expectAccessibleStructure(page)
    await page.getByRole('main').getByRole('link', { name: 'contact us' }).click()
    await expect(page).toHaveURL(/\/contact$/)
  })

  test('the legal backend reads use only the closed slugs and no query string', async ({
    page,
  }) => {
    await page.goto('/terms')
    await page.goto('/privacy')
    const calls = (await (await fetch(`${API()}/__control/requests`)).json()) as Array<{
      path: string
      query: string
    }>
    const legal = calls.filter((r) => r.path.startsWith('/v1/content/legal/'))
    expect(legal.length).toBeGreaterThan(0)
    for (const c of legal) {
      expect(['/v1/content/legal/terms', '/v1/content/legal/privacy']).toContain(c.path)
      expect(c.query).toBe('')
    }
  })
})

test.describe('contact', () => {
  test('tel: and mailto: links from the validated support values; FAQ link; no Orders link when signed out', async ({
    page,
  }) => {
    const response = await page.goto('/contact')
    expect(response?.status()).toBe(200)
    await expect(page.getByTestId('contact-phone')).toHaveAttribute('href', 'tel:+918012345678')
    await expect(page.getByTestId('contact-email')).toHaveAttribute(
      'href',
      'mailto:help@tazzzo.example',
    )
    await expect(
      page.getByRole('main').getByRole('link', { name: 'Read the help and FAQ' }),
    ).toHaveAttribute('href', '/faq')
    await expect(page.getByRole('main').getByRole('link', { name: 'Your orders' })).toHaveCount(0)
    await expectAccessibleStructure(page)
  })

  test('signed in: a link to Your orders', async ({ page }) => {
    await signIn(page, '/contact')
    await expect(page).toHaveURL(/\/contact$/)
    await expect(page.getByRole('main').getByRole('link', { name: 'Your orders' })).toHaveAttribute(
      'href',
      '/orders',
    )
  })
})

test.describe('footer and login links', () => {
  test('every page has the footer FAQ, Privacy, Terms and Contact links', async ({ page }) => {
    for (const path of ['/', '/faq', '/search', '/login', '/this-page-does-not-exist']) {
      await page.goto(path)
      const footer = page.getByRole('navigation', { name: 'Footer' })
      const links = await footer
        .getByRole('link')
        .evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute('href')]))
      expect(links, path).toEqual([
        ['FAQ', '/faq'],
        ['Privacy', '/privacy'],
        ['Terms', '/terms'],
        ['Contact', '/contact'],
      ])
    }
  })

  test('footer links navigate', async ({ page }) => {
    await page.goto('/')
    await page
      .getByRole('navigation', { name: 'Footer' })
      .getByRole('link', { name: 'Terms' })
      .click()
    await expect(page).toHaveURL(/\/terms$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Terms of service' })).toBeVisible()
  })

  test('the sign-in legal text links to /terms and /privacy', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('link', { name: 'Terms' }).first()).toBeVisible()
    const legal = page.locator('.auth-legal')
    await expect(legal.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    await expect(legal.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      '/privacy',
    )
    await legal.getByRole('link', { name: 'Privacy Policy' }).click()
    await expect(page).toHaveURL(/\/privacy$/)
  })

  test('the OTP step says where the code went once', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Mobile number').fill('9876543210')
    await page.getByRole('button', { name: 'Send code' }).click()
    await expect(page.getByLabel('6-digit code')).toBeVisible()
    await expect(page.getByText(/We sent a 6-digit code/)).toHaveCount(1)
  })
})

test.describe('empty and not-found states', () => {
  test('/search with no query: guidance and ways out', async ({ page }) => {
    const response = await page.goto('/search')
    expect(response?.status()).toBe(200)
    await expect(page.getByText('Type at least two letters to search for products.')).toBeVisible()
    const next = page.getByRole('navigation', { name: 'Where to next' })
    await expect(next.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/')
    await expect(next.getByRole('link', { name: 'Contact us' })).toHaveAttribute('href', '/contact')
    await expect(
      page.getByRole('navigation', { name: 'Browse categories' }).getByRole('link').first(),
    ).toHaveAttribute('href', /^\/c\/TZS-/)
  })

  test('/search with a query that is too short: hint plus the same links', async ({ page }) => {
    await page.goto('/search?q=a')
    await expect(page.getByText('Search needs 2 to 64 characters.')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Where to next' })).toBeVisible()
  })

  test('/search with no matches: message, tips, try another search, popular categories', async ({
    page,
  }) => {
    await page.goto('/search?q=zzzzqqq')
    await expect(page.getByRole('status').filter({ hasText: 'No products match' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Try a different search' })).toHaveAttribute(
      'href',
      '/search',
    )
    await expect(page.getByTestId('popular-categories')).toBeVisible()
  })

  test('an unknown route is still a real 404 and now offers a way on', async ({ page }) => {
    const response = await page.goto('/this-page-does-not-exist')
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Back to home' })).toBeVisible()
    await expect(page.getByTestId('popular-categories')).toBeVisible()
    await expectAccessibleStructure(page)
  })

  test('an unknown product and category stay 404', async ({ page }) => {
    expect((await page.goto('/p/TZP-NOPE'))?.status()).toBe(404)
    expect((await page.goto('/c/TZS-999999'))?.status()).toBe(404)
  })
})

test.describe('header chip text (desktop)', () => {
  // Mutation note: without the single wrapper element in LocationChipLabel the flex chip collapses the spaces around
  // its inner span and the RENDERED text becomes "Setdeliverylocation" (textContent would still look right).
  test('the rendered words are spaced', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('location-chip')).toHaveText('Set delivery location')
    expect(await page.getByTestId('location-chip').innerText()).toBe('Set delivery location')
  })
})

test.describe('header on a narrow screen', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('two rows at most, no label wraps, every target at least 44px, no sideways scroll', async ({
    page,
  }) => {
    await signIn(page, '/')
    await page.goto('/')
    const chip = page.getByTestId('location-chip')
    await expect(chip).toBeVisible()
    for (const target of [
      chip,
      page.getByTestId('cart-link'),
      page.getByTestId('orders-link'),
      page.getByTestId('account-link'),
    ]) {
      const box = (await target.boundingBox())!
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeLessThan(60) // a wrapped label would be two lines tall
    }
    await expect(chip).toHaveText('Set delivery location') // content unchanged; the optional word is only hidden
    expect((await chip.boundingBox())!.width).toBeLessThan(200)
    expect(await page.getByTestId('account-link').innerText()).toBe('Account')
    expect(await chip.innerText()).toBe('Set location')
    const scrollable = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    )
    expect(scrollable).toBe(false)
    const header = (await page.locator('.site-header').boundingBox())!
    expect(header.height).toBeLessThan(130)
  })

  test('the search field and button are 44px tall', async ({ page }) => {
    await page.goto('/')
    for (const el of [page.locator('#site-search'), page.locator('.search-form button')]) {
      expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
  })
})

test.describe('favicon and console', () => {
  test('/favicon.ico is served as an image', async ({ request }) => {
    const response = await request.get('/favicon.ico')
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toMatch(/image\//)
  })

  test('pages load without any failed same-origin request or console error (the favicon used to 404 on every page)', async ({
    page,
  }) => {
    const problems: string[] = []
    let watchConsole = true
    page.on('console', (m) => {
      if (watchConsole && m.type() === 'error') problems.push(`console: ${m.text()}`)
    })
    page.on('response', (r) => {
      if (r.status() >= 400 && r.url().startsWith('http://localhost:')) {
        problems.push(`${r.status()} ${r.url()}`)
      }
    })
    // The home fixture deliberately carries a broken media image (a console 404 from the media host), so its console is
    // not watched; its same-origin requests still are.
    watchConsole = false
    await page.goto('/')
    watchConsole = true
    for (const path of ['/faq', '/terms', '/contact', '/login', '/search']) await page.goto(path)
    expect(problems).toEqual([])
  })
})

test.describe('loading', () => {
  test('search: the heading and an accessible skeleton show while the results load, then the results replace it', async ({
    page,
  }) => {
    await fetch(`${API()}/__control/search?delay=2500`, { method: 'POST' })
    try {
      await page.goto('/search?q=basmati', { waitUntil: 'commit' })
      await expect(
        page.getByRole('heading', { level: 1, name: 'Results for “basmati”' }),
      ).toBeVisible()
      const skeleton = page.getByTestId('page-skeleton')
      await expect(skeleton).toBeVisible()
      await expect(skeleton).toHaveAttribute('role', 'status')
      await expect(skeleton).toContainText('Searching')
      await expect(page.getByTestId('page-skeleton')).toHaveCount(0, { timeout: 15_000 })
      await expect(page.locator('main article').first()).toBeVisible()
    } finally {
      await fetch(`${API()}/__control/search?delay=0`, { method: 'POST' })
    }
  })

  test('home and search show their content (the skeleton is replaced, not left behind)', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(
      page.locator('main .banner[data-block-id], main section[data-block-id]').first(),
    ).toBeVisible()
    await expect(page.getByTestId('page-skeleton')).toHaveCount(0)
    await page.goto('/search?q=rice')
    await expect(page.getByRole('heading', { level: 1, name: 'Results for “rice”' })).toBeVisible()
    await expect(page.getByTestId('page-skeleton')).toHaveCount(0)
  })
})
