import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { AUDIT_SUB, OPS_SUB, READER_SUB, WRITER_SUB } from '../support/fake-backend'
import { control, seedJob } from './helpers'

/**
 * Responsive and basic accessibility sweep over every built module at the target widths. Data comes from the mock backend,
 * so this proves layout behaviour, not real-data correctness. Set CMS_SHOTS=<dir> to also save screenshots for review.
 */
const OIDC = () => process.env.E2E_OIDC_URL!
const BACKEND = () => process.env.E2E_BACKEND_URL!
const WIDTHS = [360, 390, 768, 1024, 1440]

const GENERAL_PAGES = [
  '/',
  '/dashboard',
  '/catalogue/products',
  '/catalogue/products/TZP-REF-1',
  '/catalogue/products/new',
  '/catalogue/taxonomy',
  '/catalogue/taxonomy/releases',
  '/pricing?sku=TZP-REF-1',
  '/inventory?sku=TZP-REF-1&location=LOC-1',
  '/inventory',
  '/inventory?location=LOC-BULK&state=LOW_STOCK',
  '/catalogue/imports',
  '/catalogue/imports/jobs',
  '/catalogue/media?type=product&id=TZP-REF-1',
  '/delivery/service-areas',
  '/delivery/service-areas/560047',
  '/delivery/slots?area=Ejipura',
  '/content/faqs',
  '/content/faqs/CB_faqseed000000001',
  '/content/app-config',
  '/system/status',
  '/system/notifications',
  '/account',
]
const OPS_PAGES = ['/orders', '/orders/O-100', '/support', '/support/SUP_1']
const AUDIT_PAGES = ['/system/audit']

async function signIn(page: Page, sub: string) {
  await page.request.post(`${BACKEND()}/__control/reset`, { data: {} })
  await page.request.post(`${OIDC()}/__control/identity`, {
    data: { sub, email: `${sub}@tazzzo.test` },
  })
  await page.goto('/')
  await page.getByRole('link', { name: 'Sign in with Google' }).click()
  await expect(page.getByRole('button', { name: /Account menu/ })).toBeVisible()
}

/**
 * What a settled page looks like: the route's loading skeleton (`aria-busy`) is gone and exactly one h1 is in <main>.
 * `networkidle` alone is NOT enough: in `next dev` a cold route compiles on first visit and streams its content after the
 * document, and `count()` does not wait, so reading it straight after `goto` can see the skeleton (no h1) or an error
 * boundary (no h1). Waiting here, and describing the page when it still is not right, keeps that from being a flake while a
 * genuinely broken page still fails with an explanation.
 */
async function settledH1(page: Page): Promise<{ count: number; state: string }> {
  await page
    .locator('[aria-busy="true"]')
    .first()
    .waitFor({ state: 'detached', timeout: 20_000 })
    .catch(() => undefined)
  await expect(page.locator('main h1'))
    .toHaveCount(1, { timeout: 20_000 })
    .catch(() => undefined)
  const count = await page.locator('main h1').count()
  if (count === 1) return { count, state: '' }
  const text = (
    await page
      .locator('main')
      .innerText({ timeout: 2_000 })
      .catch(() => '(no <main>)')
  )
    .replace(/\s+/g, ' ')
    .slice(0, 160)
  return { count, state: ` [page shows: "${text}"]` }
}

/** Visits every page at every width and returns ALL layout problems (so one run lists every offender). */
async function sweep(page: Page, paths: string[]): Promise<string[]> {
  const dir = process.env.CMS_SHOTS
  if (dir) mkdirSync(dir, { recursive: true })
  const problems: string[] = []
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    for (const path of paths) {
      await page.goto(path, { waitUntil: 'networkidle' })
      const h1 = await settledH1(page)
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      if (overflow > 1) problems.push(`${path} @${width}px overflows horizontally by ${overflow}px`)
      if (h1.count !== 1)
        problems.push(`${path} @${width}px has ${h1.count} h1 elements${h1.state}`)
      if (dir)
        await page.screenshot({
          path: `${dir}/${width}${path.replace(/[^a-z0-9]+/gi, '_')}.png`,
          fullPage: true,
        })
    }
  }
  return problems
}

test.describe.configure({ timeout: 300_000 })

test('general modules do not overflow horizontally at 360-1440px and have one h1 each', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  // data that makes the new pages show their real layout: a full first page of stock with Load more, and jobs in the
  // states with the widest content (a rejected job with verdicts and Correct buttons, one the worker is running)
  await control(request, 'seed-stock', { count: 60 })
  await control(request, 'seed-stock', { count: 6, location: 'LOC-BULK' })
  const rejected = await seedJob(request, {
    status: 'REJECTED',
    rows: 8,
    invalidRows: [1, 5],
    note: 'Responsive sweep',
  })
  const running = await seedJob(request, { status: 'VALIDATING', rows: 40 })
  const validated = await seedJob(request, { status: 'VALIDATED', rows: 3 })
  const paths = [
    ...GENERAL_PAGES,
    `/catalogue/imports/jobs/${rejected}`,
    `/catalogue/imports/jobs/${running}`,
    `/catalogue/imports/jobs/${validated}?from=1`,
  ]
  expect(await sweep(page, paths)).toEqual([])
})

test('the job correction form, the upload mapping and the stock reader view do not overflow at 360-1440px', async ({
  page,
  request,
}) => {
  await signIn(page, WRITER_SUB)
  const rejected = await seedJob(request, { status: 'REJECTED', rows: 4, invalidRows: [1] })
  const open = await seedJob(request, { status: 'OPEN', rows: 1 })
  const problems: string[] = []
  const overflowed = async (label: string, width: number) => {
    const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (o > 1) problems.push(`${label} @${width}px overflows horizontally by ${o}px`)
  }
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/catalogue/imports/jobs/${rejected}`, { waitUntil: 'networkidle' })
    await settledH1(page)
    await page.getByRole('button', { name: 'Correct row 1' }).click()
    await expect(page.getByRole('form', { name: 'Correct row 1' })).toBeVisible()
    await overflowed('correction form', width)
    await page.goto(`/catalogue/imports/jobs/${open}`, { waitUntil: 'networkidle' })
    await settledH1(page)
    await page.getByLabel('CSV file').setInputFiles({
      name: 'rows.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        'id,title,brand,vertical,release,internalKey\nTZP-1,A,acme,TZV-000001,REL-1,k\n',
      ),
    })
    await expect(page.getByText('1 ready')).toBeVisible()
    await overflowed('upload mapping', width)
  }
  expect(problems).toEqual([])
})

test('the reader views of the stock list and the job pages do not overflow at 360-1440px', async ({
  page,
  request,
}) => {
  await signIn(page, READER_SUB)
  await control(request, 'seed-stock', { count: 60 })
  const id = await seedJob(request, { status: 'REJECTED', rows: 6, invalidRows: [2] })
  expect(
    await sweep(page, ['/inventory', '/catalogue/imports/jobs', `/catalogue/imports/jobs/${id}`]),
  ).toEqual([])
})

test('order and support modules do not overflow horizontally at 360-1440px', async ({ page }) => {
  await signIn(page, OPS_SUB)
  expect(await sweep(page, OPS_PAGES)).toEqual([])
})

test('audit log does not overflow horizontally at 360-1440px', async ({ page }) => {
  await signIn(page, AUDIT_SUB)
  expect(await sweep(page, AUDIT_PAGES)).toEqual([])
})

test('desktop hides the drawer toggle; mobile shows it', async ({ page }) => {
  await signIn(page, WRITER_SUB)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden()
  await page.setViewportSize({ width: 390, height: 900 })
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible()
})

test('mobile navigation: closed drawer links are not focusable, open drawer links are', async ({
  page,
}) => {
  await signIn(page, WRITER_SUB)
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/', { waitUntil: 'networkidle' })
  const link = page.getByRole('link', { name: 'Products' })
  await expect(link).toBeHidden()
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(link).toBeVisible()
  await link.focus()
  await expect(link).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(link).toBeHidden()
})
