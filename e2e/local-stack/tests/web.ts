// Browser-side helpers shared by the storefront journeys.
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { env, log, sleep } from './support'

export async function shot(page: Page, name: string) {
  const dir = join(env.evidence, 'screens')
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true })
  log(`  screenshot: screens/${name}.png`)
}

/**
 * Reload `path` until `ok(page)` holds. The storefront caches backend reads for 60 s and serves one stale copy while it
 * revalidates (apps/storefront/src/server/backend/client.ts), so a change made through the admin API reaches the page
 * within roughly 60-120 s. The elapsed time is logged: that publish lag is part of the evidence, not hidden.
 */
export async function untilPage(
  page: Page,
  what: string,
  path: string,
  ok: (page: Page) => Promise<boolean>,
  timeoutMs = 200_000,
  everyMs = 4_000,
): Promise<boolean> {
  const t0 = Date.now()
  for (;;) {
    const r = await page.goto(path, { waitUntil: 'load' })
    if (r && r.status() < 500 && (await ok(page).catch(() => false))) {
      log(`  website ${path}: "${what}" observed after ${Math.round((Date.now() - t0) / 1000)} s`)
      return true
    }
    if (Date.now() - t0 > timeoutMs) {
      log(`  website ${path}: "${what}" NOT observed within ${Math.round(timeoutMs / 1000)} s (last status ${r?.status()})`)
      return false
    }
    await sleep(everyMs)
  }
}

/** Block ids of banners / rails / grids on the storefront home, in document order. */
export async function webBlocks(page: Page): Promise<{ id: string; kind: string }[]> {
  return page.$$eval('.banner[data-block-id], section.rail[data-block-id], section.grid-block[data-block-id]', (els) =>
    els.map((e) => ({
      id: e.getAttribute('data-block-id')!,
      kind: e.classList.contains('banner') ? 'banner' : e.classList.contains('rail') ? 'rail' : 'grid',
    })),
  )
}
export async function untilHome(page: Page, what: string, ok: (ids: string[]) => boolean, timeoutMs = 220_000): Promise<string[]> {
  let last: string[] = []
  await untilPage(page, what, '/', async (p) => {
    last = (await webBlocks(p)).map((b) => b.id)
    return ok(last)
  }, timeoutMs, 5_000)
  return last
}

/** The real /location form: PIN -> "Check PIN code" -> chip "Deliver to <pin>". */
export async function uiSetLocation(page: Page, pin = '560001') {
  await page.goto('/location')
  await page.getByLabel('PIN code').fill(pin)
  await page.getByRole('button', { name: 'Check PIN code' }).click()
  await page.getByTestId('location-chip').filter({ hasText: pin }).waitFor({ timeout: 15_000 }).catch(() => undefined)
}

/** Sign in, save a serviceable address, return the phone. */
export async function uiCustomer(page: Page, signIn: (p: Page, phone?: string, next?: string) => Promise<string>, pin = '560001'): Promise<string> {
  const phone = await signIn(page, undefined, '/account/addresses/new')
  const v: Record<string, string> = { 'Full name': 'E2E Tester', 'Mobile number': phone, 'Address line 1': '12 MG Road', City: 'Bengaluru', State: 'Karnataka', 'PIN code': pin }
  for (const [label, value] of Object.entries(v)) await page.getByLabel(label, { exact: true }).fill(value)
  await page.getByRole('button', { name: 'Save address' }).click()
  await page.waitForURL(/\/account\/addresses$/)
  return phone
}
export async function uiAdd(page: Page, sku: string) {
  await page.goto(`/p/${sku}`)
  await page.getByRole('button', { name: 'Add to cart' }).click()
  await page.getByTestId('add-status').filter({ hasText: /^Added/ }).waitFor({ timeout: 15_000 })
}
/** /checkout/delivery: first selectable slot -> Save delivery choice -> Continue -> review page. */
export async function uiDelivery(page: Page) {
  await page.goto('/checkout/delivery')
  const slot = page.locator('[data-testid="slot-option"] input[type="radio"]:not([disabled])').first()
  await slot.check()
  await page.getByRole('button', { name: 'Save delivery choice' }).click()
  await page.getByTestId('delivery-saved').waitFor({ timeout: 15_000 })
  await page.getByTestId('delivery-continue').click()
  await page.getByRole('heading', { level: 1, name: 'Review your order' }).waitFor({ timeout: 20_000 })
  await page.locator('body[data-hydrated]').waitFor({ state: 'attached', timeout: 15_000 })
}

/** /location -> "Deliver here" on the first saved address: the cart and PDP are then located by that address. */
export async function uiDeliverHere(page: Page) {
  await page.goto('/location')
  await page.getByRole('button', { name: 'Deliver here' }).first().click()
  await page.getByRole('button', { name: 'Delivering here' }).first().waitFor({ timeout: 15_000 })
}
