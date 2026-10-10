import { expect, test } from '@playwright/test'
import { READER_SUB, WRITER_SUB } from '../support/fake-backend'
import { control, recorded, settled, signInFresh } from './helpers'

/** Inventory list (listStock) against the mock backend that mirrors the real list contract. */
test.describe.configure({ timeout: 180_000 })

test('a writer sees the first 50 rows, loads more by keyset until the end, and the table is labelled', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  await control(request, 'seed-stock', { count: 120 })
  await page.goto('/inventory')
  await settled(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible()
  const table = page.getByRole('table')
  await expect(table.getByRole('rowheader')).toHaveCount(50)
  await expect(table.getByRole('columnheader')).toHaveCount(8)
  await expect(page.getByRole('region', { name: 'Stock table' })).toBeVisible()
  await expect(table.getByRole('rowheader').first()).toContainText('TZP-BULK-0000')

  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(table.getByRole('rowheader')).toHaveCount(100)
  await expect(page.getByText('Loaded 50 more rows.')).toBeVisible()
  await expect(table.getByRole('rowheader').nth(50).getByRole('link')).toBeFocused()

  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(table.getByRole('rowheader')).toHaveCount(121)
  await expect(page.getByText('End of the list: 121 records.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)

  // the list reads only through the BFF, as the human, with the backend's closed grammar and our cursor
  const reads = (await recorded(request)).filter((r) =>
    r.path.startsWith('/api/v1/admin/inventory?'),
  )
  expect(reads).toHaveLength(3)
  expect(reads.map((r) => new URL(r.path, 'http://x').searchParams.get('limit'))).toEqual([
    '50',
    '50',
    '50',
  ])
  expect(new URL(reads[1]!.path, 'http://x').searchParams.get('cursor')).toBeTruthy()
  expect(reads.every((r) => r.sub === WRITER_SUB)).toBe(true)
})

test('filters by location and state, shows a clear empty state, and clearing returns to the full list', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  await control(request, 'seed-stock', { count: 12, location: 'LOC-F' })
  await page.goto('/inventory')
  await settled(page)
  const filters = page.getByRole('form', { name: 'Stock list filters' })
  await filters.getByLabel('Filter by location id').fill('LOC-F')
  await filters.getByLabel('State').selectOption('OUT_OF_STOCK')
  await filters.getByRole('button', { name: 'Apply' }).click()
  await expect(page).toHaveURL(/location=LOC-F&state=OUT_OF_STOCK/)
  const rows = page.getByRole('table').getByRole('rowheader')
  await expect(rows.first()).toBeVisible()
  for (const badge of await page.getByRole('table').locator('.badge').allTextContents())
    expect(badge).toBe('Out of stock')

  await filters.getByLabel('Filter by location id').fill('LOC-NOPE')
  await filters.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByRole('heading', { name: 'No stock records' })).toBeVisible()
  await expect(page.getByText('No stock record matches these filters.')).toBeVisible()
  await page.getByRole('link', { name: 'Clear filters' }).click()
  await expect(page.getByRole('table').getByRole('rowheader').first()).toBeVisible()
  // an invalid filter in the URL is dropped, never sent to the backend
  await page.goto('/inventory?state=bogus&location=bad%20id')
  await expect(page.getByRole('table').getByRole('rowheader').first()).toBeVisible()
  const sent = (await recorded(request)).filter((r) => r.path.includes('/inventory?'))
  expect(sent.every((r) => !/bogus|bad/.test(r.path))).toBe(true)
})

test('a row opens the existing per-SKU editor; the lookup form still works', async ({ page }) => {
  await signInFresh(page, WRITER_SUB)
  await page.goto('/inventory')
  await settled(page)
  await page.getByRole('link', { name: 'Edit stock for TZP-REF-1 at LOC-1' }).click()
  await expect(page).toHaveURL(/\/inventory\?sku=TZP-REF-1&location=LOC-1/)
  await expect(page.getByRole('heading', { name: 'Change stock' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to the stock list' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to the stock list' }).click()
  const lookup = page.getByRole('form', { name: 'Open a stock record' })
  await lookup.getByLabel('Product id').fill('TZP-REF-1')
  await lookup.getByLabel('Location of the record').fill('LOC-1')
  await lookup.getByRole('button', { name: 'Open record' }).click()
  await expect(page.getByRole('heading', { name: 'Change stock' })).toBeVisible()
})

test('a reader may read the list but is told it is read-only, and the editor stays read-only', async ({
  page,
}) => {
  await signInFresh(page, READER_SUB)
  await page.goto('/inventory')
  await settled(page)
  await expect(page.getByRole('note')).toContainText('Read-only')
  await page.getByRole('link', { name: 'View stock for TZP-REF-1 at LOC-1' }).click()
  await expect(page.getByText('Read-only: changing stock needs the cms-writer role.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Change stock' })).toHaveCount(0)
})

test('503 LIST_TIMEOUT on the first page is a retry state; after the backend recovers, Try again shows the list', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  await control(request, 'force', [
    { match: 'GET /api/v1/admin/inventory', status: 503, code: 'LIST_TIMEOUT', count: 1 },
  ])
  await page.goto('/inventory')
  await expect(page.locator('main').getByRole('alert')).toContainText('The stock list timed out')
  await expect(page.locator('main').getByRole('alert')).toContainText('Try again')
  await expect(page.getByText(/Foo\.java|stack trace/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('table').getByRole('rowheader').first()).toBeVisible()
})

test('503 LIST_TIMEOUT on Load more keeps the rows, explains, and retries the same page on request', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  await control(request, 'seed-stock', { count: 80 })
  await page.goto('/inventory')
  await settled(page)
  await control(request, 'force', [
    { match: 'GET /api/v1/admin/inventory', status: 503, code: 'LIST_TIMEOUT', count: 1 },
  ])
  await page.getByRole('button', { name: 'Load more' }).click()
  const alert = page.locator('main').getByRole('alert')
  await expect(alert).toContainText('took too long')
  await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(50)
  const before = (await recorded(request)).filter((r) =>
    r.path.startsWith('/api/v1/admin/inventory?'),
  ).length
  await page.waitForTimeout(1500)
  expect(
    (await recorded(request)).filter((r) => r.path.startsWith('/api/v1/admin/inventory?')).length,
  ).toBe(before) // never retried by itself
  await alert.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(81)
  await expect(alert).toHaveCount(0)
})

test('short and empty pages that still carry a cursor are followed, never mistaken for the end', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  // 120 rows, every third one corrupt: the backend returns SHORT pages that still have a cursor
  await control(request, 'seed-stock', { count: 120, location: 'LOC-M', corruptEvery: 3 })
  await page.goto('/inventory?location=LOC-M')
  await settled(page)
  const rows = page.getByRole('table').getByRole('rowheader')
  await expect(rows).toHaveCount(34) // the first 50 positions hold 34 listable rows (16 are corrupt)
  await expect(async () => {
    const more = page.getByRole('button', { name: 'Load more' })
    if ((await more.count()) && (await more.isEnabled())) await more.click()
    await expect(page.getByText('End of the list: 80 records.')).toBeVisible({ timeout: 1_500 })
  }).toPass({ timeout: 45_000 })
  await expect(rows).toHaveCount(80)
  await expect(page.getByText('End of the list: 80 records.')).toBeVisible()
})

test('a list whose every position is corrupt is empty only after the cursor is followed to its end', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  await control(request, 'seed-stock', { count: 400, location: 'LOC-C', corruptEvery: 1 })
  await page.goto('/inventory?location=LOC-C')
  await settled(page)
  await expect(page.getByRole('heading', { name: 'No stock records' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
  const reads = (await recorded(request)).filter((r) => r.path.includes('location=LOC-C'))
  expect(reads.length).toBe(8) // 400 positions at 50 per page
})

test('401 on Load more sends the person back to sign in; 403 shows a role message without retry', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  await control(request, 'seed-stock', { count: 80 })
  await page.goto('/inventory')
  await settled(page)
  await control(request, 'force', [
    { match: 'GET /api/v1/admin/inventory', status: 403, code: 'FORBIDDEN', count: 1 },
  ])
  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(page.locator('main').getByRole('alert')).toContainText('cannot read stock')
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await page.goto('/inventory')
  await settled(page)
  await control(request, 'force', [
    { match: 'GET /api/v1/admin/inventory', status: 401, code: 'UNAUTHENTICATED', count: 1 },
  ])
  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(page).toHaveURL(/\/login/)
})

test('keyboard: Load more is reachable and operable without a mouse', async ({ page, request }) => {
  await signInFresh(page, WRITER_SUB)
  await control(request, 'seed-stock', { count: 120 })
  await page.goto('/inventory')
  await settled(page)
  const more = page.getByRole('button', { name: 'Load more' })
  await more.focus()
  await expect(more).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('table').getByRole('rowheader')).toHaveCount(100)
})
