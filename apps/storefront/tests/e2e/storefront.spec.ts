import { expect, test, type Page } from '@playwright/test'

/**
 * Real browser, real Next.js runtime, fake public API + fake media host (tests/support/fake-backend.ts). The fake
 * stores APP_ONLY, WEB_ONLY and BOTH blocks and filters by `channel` like the backend; the website never filters.
 */
const backend = () => process.env.E2E_BACKEND_URL!
const media = () => process.env.E2E_MEDIA_URL!

async function backendRequests(): Promise<Array<{ path: string; query: string }>> {
  return (await (await fetch(`${backend()}/__control/requests`)).json()) as Array<{
    path: string
    query: string
  }>
}

async function setMediaDown(down: boolean): Promise<void> {
  await fetch(`${backend()}/__control/media?down=${down ? 1 : 0}`, { method: 'POST' })
}

/** Block ids of the home page, in DOM order (banner slides, rails, grids). */
async function homeBlockIds(page: Page): Promise<string[]> {
  return page
    .locator('main .banner[data-block-id], main section[data-block-id]')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.blockId ?? ''))
}

test.describe('home', () => {
  test('shows WEB_ONLY and BOTH content in backend order, never APP_ONLY, and asks with channel=web', async ({
    page,
  }) => {
    const response = await page.goto('/')
    expect(response?.status()).toBe(200)
    expect(await homeBlockIds(page)).toEqual([
      'CB_web1',
      'CB_both1',
      'CB_rail1',
      'CB_broken',
      'CB_grid1',
      'CB_search',
      'CB_offhost',
    ])
    await expect(page.getByText('App only deal')).toHaveCount(0)
    await expect(page.getByText('App only rail')).toHaveCount(0)
    await expect(page.getByText('Future block type')).toHaveCount(0)

    const homeCalls = (await backendRequests()).filter((r) => r.path === '/v1/content/home')
    expect(homeCalls.length).toBeGreaterThan(0)
    for (const call of homeCalls) expect(call.query).toBe('?channel=web')
  })

  test('banner <picture>: desktop image on wide screens, imageUrl on narrow, alt text, first eager only', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')
    const first = page.locator('.banner[data-block-id="CB_web1"] img')
    await expect(first).toHaveAttribute('alt', 'Sacks of basmati rice')
    await expect(first).toHaveAttribute('loading', 'eager')
    await expect
      .poll(() => first.evaluate((i: HTMLImageElement) => i.currentSrc))
      .toBe(`${media()}/media/banner-web1-wide.png`)
    // As served (before any lazy image loads, or fails and is replaced): only the first banner is eager.
    const html = await (await page.request.get('/')).text()
    const loading = [
      ...html.matchAll(/<picture class="banner__media">.*?<img [^>]*loading="(\w+)"/g),
    ].map((m) => m[1])
    expect(loading).toEqual(['eager', 'lazy', 'lazy', 'lazy'])

    await page.setViewportSize({ width: 375, height: 800 })
    await page.reload()
    await expect
      .poll(() => first.evaluate((i: HTMLImageElement) => i.currentSrc))
      .toBe(`${media()}/media/banner-web1.png`)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    )
    expect(overflow).toBe(false)
  })

  test('product rail renders resolvable products in order and silently skips a missing one', async ({
    page,
  }) => {
    await page.goto('/')
    const rail = page.getByRole('region', { name: 'Bestsellers' })
    await expect(rail.getByRole('article')).toHaveCount(2)
    expect(
      await rail
        .getByRole('article')
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.productId)),
    ).toEqual(['TZP-1001', 'TZP-1002'])
    await expect(rail.getByRole('heading', { name: 'Basmati Rice 5 kg' })).toBeVisible()
    await expect(rail.getByText('₹499')).toBeVisible()
    // TZP-1002 has no image: the branded placeholder stands in.
    await expect(rail.getByRole('img', { name: 'Toor Dal 1 kg' })).toHaveAttribute(
      'data-testid',
      'image-fallback',
    )
  })

  test('the rail is hydrated by batch reads only: no single read, merged and unknown ids omitted', async ({
    page,
  }) => {
    await page.goto('/')
    const rail = page.getByRole('region', { name: 'Bestsellers' })
    await expect(rail.getByRole('article')).toHaveCount(2)
    // TZP-Merged-1 is merged into TZP-1002: the single read would follow it (two identical cards); the batch does not.
    await expect(rail.locator('[data-product-id="TZP-1002"]')).toHaveCount(1)
    const calls = await backendRequests()
    const batch = calls.filter((r) => r.path === '/v1/products:batch')
    expect(batch.length).toBeGreaterThan(0)
    for (const call of batch) {
      expect(new URLSearchParams(call.query).get('ids')).toBe(
        'TZP-1001,TZP-9999,TZP-Merged-1,TZP-1002',
      )
    }
    expect(calls.filter((r) => /^\/v1\/products\/(TZP-9999|TZP-Merged-1)$/.test(r.path))).toEqual(
      [],
    )
  })

  test('a failing banner image becomes the branded placeholder; an out-of-grammar link is not clickable', async ({
    page,
  }) => {
    await page.goto('/')
    const broken = page.locator('.banner[data-block-id="CB_broken"]')
    await broken.scrollIntoViewIfNeeded()
    await expect(broken.getByRole('img', { name: 'Festival offers' })).toHaveAttribute(
      'data-testid',
      'image-fallback',
    )
    await expect(broken.locator('a')).toHaveCount(0)
    await expect(page.locator('a[href*="evil.example"]')).toHaveCount(0)
  })

  test('a banner whose image is off the media host is kept with the placeholder, never requested', async ({
    page,
  }) => {
    const offHost: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('evil.example')) offHost.push(r.url())
    })
    await page.goto('/')
    // Slide 2 of the second carousel, so it is `hidden` until shown: query it including hidden content.
    const banner = page.locator('.banner[data-block-id="CB_offhost"]')
    await expect(banner.getByRole('img', { name: 'Spices', includeHidden: true })).toHaveAttribute(
      'data-testid',
      'image-fallback',
    )
    // Its Devanagari search link (combining marks, backend db3623c) is a valid deep link.
    await expect(banner.getByRole('link', { includeHidden: true })).toHaveAttribute(
      'href',
      `/search?q=${encodeURIComponent('चावल')}`,
    )
    expect(offHost).toEqual([])
  })

  test('CDN down: the page still renders, every image is the placeholder', async ({ page }) => {
    await setMediaDown(true)
    try {
      await page.goto('/')
      await expect(page.getByRole('heading', { name: 'Bestsellers' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Staples' })).toBeVisible()
      // The eager first banner fails before or after hydration; either way it is replaced.
      await expect(
        page
          .locator('.banner[data-block-id="CB_web1"]')
          .getByRole('img', { name: 'Sacks of basmati rice' }),
      ).toHaveAttribute('data-testid', 'image-fallback')
      await expect(
        page
          .getByRole('region', { name: 'Bestsellers' })
          .getByRole('img', { name: 'Basmati Rice 5 kg' }),
      ).toHaveAttribute('data-testid', 'image-fallback')
    } finally {
      await setMediaDown(false)
    }
  })

  test('carousel: arrow keys, buttons and pause; no autoplay control under reduced motion', async ({
    page,
  }) => {
    await page.goto('/')
    const carousel = page.getByTestId('banner-carousel').first()
    const visibleSlide = () =>
      carousel.locator('.banner:not([hidden])').evaluate((e) => (e as HTMLElement).dataset.blockId)
    await carousel.getByRole('button', { name: 'Pause slideshow' }).click()
    await expect(carousel.getByRole('button', { name: 'Play slideshow' })).toBeVisible()
    expect(await visibleSlide()).toBe('CB_web1')
    await carousel.getByRole('button', { name: 'Next slide' }).focus()
    await page.keyboard.press('ArrowRight')
    expect(await visibleSlide()).toBe('CB_both1')
    await page.keyboard.press('ArrowRight')
    expect(await visibleSlide()).toBe('CB_web1')
    await carousel.getByRole('button', { name: 'Show slide 2: Fresh fruit' }).click()
    expect(await visibleSlide()).toBe('CB_both1')

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.reload()
    const reduced = page.getByTestId('banner-carousel').first()
    await expect(reduced.getByRole('button', { name: 'Next slide' })).toBeVisible()
    await expect(reduced.getByRole('button', { name: /slideshow/ })).toHaveCount(0)
  })

  test('sets a strict CSP that admits only the media origin for images, and nothing violates it', async ({
    page,
  }) => {
    const violations: string[] = []
    page.on('console', (msg) => {
      if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text())
    })
    const response = await page.goto('/')
    const csp = response?.headers()['content-security-policy'] ?? ''
    expect(csp).toContain(`img-src 'self' ${media()};`)
    expect(csp).toContain("frame-ancestors 'none'")
    expect(response?.headers()['x-frame-options']).toBe('DENY')
    await expect(page.getByRole('heading', { name: 'Bestsellers' })).toBeVisible()
    expect(violations).toEqual([])
  })
})

test.describe('deep links', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }) // no autoplay: deterministic slides
  })

  test('product: banner -> /p/<id>', async ({ page }) => {
    await page.goto('/')
    await page.locator('.banner[data-block-id="CB_web1"] a').click()
    await expect(page).toHaveURL(/\/p\/TZP-1001$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Basmati Rice 5 kg')
  })

  test('category: banner -> /c/<node>', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Show slide 2: Fresh fruit' }).click()
    await page.locator('.banner[data-block-id="CB_both1"] a').click()
    await expect(page).toHaveURL(/\/c\/TZC-000002$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rice')
    await expect(
      page.getByRole('list', { name: 'Products in Rice' }).getByRole('article'),
    ).toHaveCount(2)
  })

  test('search: banner -> /search?q=<encoded>', async ({ page }) => {
    await page.goto('/')
    await page.locator('.banner[data-block-id="CB_search"] a').click()
    await expect(page).toHaveURL(/\/search\?q=basmati%20rice$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Results for “basmati rice”')
    await expect(page.getByRole('heading', { name: 'Basmati Rice 5 kg' })).toBeVisible()
  })

  test('category grid tile -> /c/<node> with sub-categories; an unresolvable node is not shown', async ({
    page,
  }) => {
    await page.goto('/')
    const grid = page.getByRole('region', { name: 'Shop by category' })
    await expect(grid.getByRole('link')).toHaveText(['Staples', 'Rice', 'Basmati'])
    // Every tile is named by its own GET /v1/categories/{id}, the unknown TZG-000003 included (a 404: skipped).
    const byId = (await backendRequests())
      .map((r) => r.path)
      .filter((p) => /^\/v1\/categories\/[^/]+$/.test(p))
    for (const id of ['TZS-000001', 'TZC-000002', 'TZG-000003', 'TZG-000004'])
      expect(byId).toContain(`/v1/categories/${id}`)
    await grid.getByRole('link', { name: 'Staples' }).click()
    await expect(page).toHaveURL(/\/c\/TZS-000001$/)
    await expect(
      page.getByRole('navigation', { name: 'Sub-categories' }).getByRole('link'),
    ).toHaveText(['Rice'])
  })

  test('a deep category (two levels down) is titled by its own name, from the grid tile', async ({
    page,
  }) => {
    await page.goto('/')
    await page
      .getByRole('region', { name: 'Shop by category' })
      .getByRole('link', { name: 'Basmati' })
      .click()
    await expect(page).toHaveURL(/\/c\/TZG-000004$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Basmati')
    await expect(page).toHaveTitle('Basmati · Tazzzo')
    await expect(
      page.getByRole('list', { name: 'Products in Basmati' }).getByRole('article'),
    ).toHaveCount(2)
  })

  test('an unknown category is a 404 page', async ({ page }) => {
    const response = await page.goto('/c/TZG-000003')
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  })

  test('header search form and unknown product', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('searchbox', { name: 'Search products' }).fill('dal')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/search\?q=dal$/)
    await expect(page.getByRole('heading', { name: 'Toor Dal 1 kg' })).toBeVisible()
    const missing = await page.goto('/p/TZP-9999')
    expect(missing?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  })
})

test.describe('product detail gallery', () => {
  test('primary first, gallery order, alt text fallback, keyboard thumbnails, failed image fallback', async ({
    page,
  }) => {
    await page.goto('/p/TZP-1001')
    const gallery = page.getByTestId('product-gallery')
    const main = gallery.locator('.gallery__main')
    await expect(main.getByRole('img')).toHaveAttribute('alt', 'Front of pack')
    await expect(main.getByRole('img')).toHaveAttribute('src', `${media()}/media/p1-a.png`)
    const thumbs = gallery.getByRole('list', { name: 'Product images' }).getByRole('button')
    await expect(thumbs).toHaveCount(4)
    expect(await thumbs.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(
      [
        'Show image 1 of 4: Front of pack',
        'Show image 2 of 4: Basmati Rice 5 kg',
        'Show image 3 of 4: Back of pack',
        'Show image 4 of 4: Nutrition table',
      ],
    )

    await thumbs.nth(0).focus()
    await page.keyboard.press('ArrowRight')
    await expect(thumbs.nth(1)).toBeFocused()
    await expect(thumbs.nth(1)).toHaveAttribute('aria-pressed', 'true')
    await expect(main.getByRole('img')).toHaveAttribute('src', `${media()}/media/p1-b.png`)
    await expect(main.getByRole('img')).toHaveAttribute('alt', 'Basmati Rice 5 kg')

    await page.keyboard.press('End')
    await expect(thumbs.nth(3)).toBeFocused()
    await expect(main.getByRole('img', { name: 'Nutrition table' })).toHaveAttribute(
      'data-testid',
      'image-fallback',
    )

    await thumbs.nth(2).click()
    await expect(main.getByRole('img')).toHaveAttribute('alt', 'Back of pack')
    await expect(page.getByText('₹499')).toBeVisible()
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/p\/TZP-1001$/)
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      `${media()}/media/p1-a.png`,
    )
  })
})
