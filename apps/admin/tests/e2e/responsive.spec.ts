import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { AUDIT_SUB, OPS_SUB, WRITER_SUB } from '../support/fake-backend'

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
  '/catalogue/imports',
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

/** Visits every page at every width and returns ALL layout problems (so one run lists every offender). */
async function sweep(page: Page, paths: string[]): Promise<string[]> {
  const dir = process.env.CMS_SHOTS
  if (dir) mkdirSync(dir, { recursive: true })
  const problems: string[] = []
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 })
    for (const path of paths) {
      await page.goto(path, { waitUntil: 'networkidle' })
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      if (overflow > 1) problems.push(`${path} @${width}px overflows horizontally by ${overflow}px`)
      const h1 = await page.locator('main h1').count()
      if (h1 !== 1) problems.push(`${path} @${width}px has ${h1} h1 elements`)
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
}) => {
  await signIn(page, WRITER_SUB)
  expect(await sweep(page, GENERAL_PAGES)).toEqual([])
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
