import { expect, test, type Page } from '@playwright/test'
import { READER_SUB, SUPPORT_SUB, WRITER_SUB } from '../support/fake-backend'
import { BACKEND, control, recorded, seedJob, settled, signInFresh } from './helpers'

/** Asynchronous import jobs against the mock backend that mirrors the real job state machine (see fake-jobs.ts). */
test.describe.configure({ timeout: 240_000 })

const HEADER = 'id,title,brand,vertical,release,internalKey'
const csv = (rows: string[]) => Buffer.from([HEADER, ...rows].join('\n'))
const jobUrl = (id: string) => `/catalogue/imports/jobs/${id}`
const tick = (request: Parameters<typeof control>[0], id: string, extra: object = {}) =>
  control(request, 'jobs/tick', { id, ...extra })

async function openJob(page: Page, id: string) {
  await page.goto(jobUrl(id))
  await settled(page)
}

test('a writer runs a whole job in the UI: create, upload, validate (live), approve, apply (live), done', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  await page.goto('/catalogue/imports/jobs')
  await settled(page)
  await page.getByLabel(/Note/).fill('October launch')
  await page.getByRole('button', { name: 'Create job' }).click()
  await expect(page).toHaveURL(/\/catalogue\/imports\/jobs\/IMPJ-[0-9a-f]{24}$/)
  const id = page.url().split('/').pop()!
  await expect(page.getByRole('heading', { level: 1, name: id })).toBeVisible()
  await expect(page.getByText('October launch')).toBeVisible()
  await expect(page.getByText('Open (accepting rows)').first()).toBeVisible()
  await expect(page.getByText('Add rows first; validation needs at least one row.')).toBeVisible()

  // upload: one row has an id outside the shared grammar (lower-case prefix) and is skipped only by explicit choice
  await settled(page)
  await page.getByLabel('CSV file').setInputFiles({
    name: 'rows.csv',
    mimeType: 'text/csv',
    buffer: csv([
      'TZP-Med-3,Rice,acme,TZV-000001,REL-1,k1',
      'TZP-med-3,Dal,acme,TZV-000001,REL-1,k2',
      'tzp-bad,Oil,acme,TZV-000001,REL-1,k3',
    ]),
  })
  await expect(page.getByText('2 ready', { exact: true })).toBeVisible()
  await expect(page.getByText('1 with errors', { exact: true })).toBeVisible()
  const add = page.getByRole('button', { name: 'Add 2 rows to the job' })
  await expect(add).toBeDisabled()
  await page.getByLabel(/Skip the 1 rows with errors/).check()
  await add.click()
  await expect(page.getByText('Rows stored').locator('xpath=following-sibling::dd[1]')).toHaveText(
    '2',
  )
  await expect(page.getByLabel('CSV file')).toBeVisible() // still OPEN: more files may be added
  const uploads = (await recorded(request)).filter(
    (r) => r.method === 'POST' && r.path.endsWith('/rows'),
  )
  expect(uploads).toHaveLength(1)
  const sent = JSON.parse(uploads[0]!.body) as { rows: { id: string; brandCode: string }[] }
  expect(sent.rows.map((r) => r.id)).toEqual(['TZP-Med-3', 'TZP-med-3']) // case kept, both valid, distinct
  expect(sent.rows[0]!.brandCode).toBe('ACME')

  // validate: the worker owns it, the page follows it without a click
  await page.getByRole('button', { name: 'Validate rows' }).click()
  await expect(page.getByRole('progressbar', { name: 'Validating progress' })).toBeVisible()
  await tick(request, id)
  await expect(page.getByText('Validated, ready to approve').first()).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByRole('progressbar')).toHaveCount(0)

  // approve: explicit confirmation naming the signed-in approver; the request names nobody
  await page.getByRole('button', { name: 'Approve and apply…' }).click()
  const dialog = page.getByRole('dialog', { name: `Approve and apply ${id}?` })
  await expect(dialog).toContainText(`${WRITER_SUB}@tazzzo.test`)
  await expect(dialog).toContainText('up to 2 products')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect((await recorded(request)).filter((r) => r.path.endsWith('/apply'))).toHaveLength(0)
  await page.getByRole('button', { name: 'Approve and apply…' }).click()
  await page
    .getByRole('dialog', { name: `Approve and apply ${id}?` })
    .getByRole('button', { name: 'Approve and apply' })
    .click()
  await expect(page.getByText('Applying').first()).toBeVisible()
  const apply = (await recorded(request)).filter((r) => r.path.endsWith('/apply'))
  expect(apply).toHaveLength(1)
  expect(JSON.parse(apply[0]!.body)).toEqual({ version: expect.any(Number) })
  expect(apply[0]!.sub).toBe(WRITER_SUB)
  await expect(
    page.getByText('Approved by').locator('xpath=following-sibling::dd[1]'),
  ).toContainText(`google:${WRITER_SUB}`)

  await tick(request, id)
  await expect(page.getByText('Completed').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('cell', { name: 'applied' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: /Validate|Approve|Cancel job/ })).toHaveCount(0)

  // polling stopped for good: no further job reads from the browser's poller
  const reads = async () =>
    (await recorded(request)).filter(
      (r) => r.method === 'GET' && r.path === `/api/v1/admin/imports/jobs/${id}`,
    ).length
  const settledReads = await reads()
  await page.waitForTimeout(8_000)
  expect(await reads()).toBe(settledReads)
})

test('polling is gentle while the worker runs: never faster than every 3 s, and it stops when the job needs a person', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'VALIDATING', rows: 6 })
  const stamps: number[] = []
  page.on('request', (r) => {
    if (r.url().endsWith(`/api/bff/imports/jobs/${id}`)) stamps.push(Date.now())
  })
  await openJob(page, id)
  await expect(page.getByRole('progressbar', { name: 'Validating progress' })).toBeVisible()
  await expect.poll(() => stamps.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3)
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!)
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2_800)
  // progress moves, the page re-reads, and the poll stops at the first status that is not working
  await tick(request, id, { step: 3 })
  await expect(page.getByRole('status').filter({ hasText: 'row 3 of 6' })).toBeVisible({
    timeout: 20_000,
  })
  await tick(request, id)
  await expect(page.getByText('Validated, ready to approve').first()).toBeVisible({
    timeout: 20_000,
  })
  const count = stamps.length
  await page.waitForTimeout(8_000)
  expect(stamps.length).toBe(count)
})

test('no polling at all for jobs that wait for a person', async ({ page, request }) => {
  await signInFresh(page, WRITER_SUB)
  const ids = [
    await seedJob(request, { status: 'OPEN' }),
    await seedJob(request, { status: 'VALIDATED' }),
    await seedJob(request, { status: 'PAUSED', rows: 4 }),
    await seedJob(request, { status: 'COMPLETED' }),
  ]
  let polls = 0
  page.on('request', (r) => {
    if (/\/api\/bff\/imports\/jobs\/IMPJ-[0-9a-f]{24}$/.test(r.url())) polls++
  })
  for (const id of ids) await openJob(page, id)
  await page.waitForTimeout(5_000)
  expect(polls).toBe(0)
})

test('a REJECTED job: verdicts are shown, errors.csv downloads untouched, a row is corrected with the shared id rules, then it re-validates', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'REJECTED', rows: 4, invalidRows: [1, 3] })
  await openJob(page, id)
  await expect(page.getByText('Rejected (rows need fixing)').first()).toBeVisible()
  const rows = page.getByRole('region', { name: 'Row verdicts' })
  await expect(rows.getByRole('row', { name: /tzp_bad_1/ })).toContainText('invalid')
  await expect(rows.getByRole('row', { name: /tzp_bad_1/ })).toContainText('INVALID_ROW')
  await expect(rows.getByRole('row', { name: /TZP-SEED-0/ })).toContainText('valid')

  // errors.csv: a real download, the cells exactly as the backend wrote them
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download errors.csv' }).click(),
  ])
  expect(download.suggestedFilename()).toBe(`${id}-errors.csv`)
  const text = (
    await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8')
  ).replaceAll('\r\n', '\n')
  expect(text.split('\n')[0]).toBe('row,line,id,phase,outcome,code,message')
  expect(text).toContain('1,2,tzp_bad_1,validation,INVALID,INVALID_ROW')
  await expect(page.getByText('Downloaded 2 error lines.')).toBeVisible()

  // the BFF response headers
  const res = await page.request.get(`/api/bff/imports/jobs/${id}/errors.csv`, {
    headers: { 'x-tazzzo-csrf': '1' },
  })
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toBe('text/csv; charset=utf-8')
  expect(res.headers()['content-disposition']).toBe(`attachment; filename="${id}-errors.csv"`)
  expect(res.headers()['cache-control']).toBe('no-store')
  expect(res.headers()['x-content-type-options']).toBe('nosniff')

  // correction: whole-row replacement; a lower-case prefix is refused client-side and nothing is sent
  await rows.getByRole('button', { name: 'Correct row 1' }).click()
  const form = page.getByRole('form', { name: 'Correct row 1' })
  await expect(page.getByRole('heading', { name: 'Correct row 1' })).toBeFocused()
  await form.getByLabel(/^Product id/).fill('tzp-fixed')
  await form.getByLabel(/^Title/).fill('Rice')
  await form.getByLabel(/^Brand code/).fill('acme')
  await form.getByLabel(/^Internal key/).fill('k-1')
  await form.getByLabel(/^Vertical id/).fill('TZV-000001')
  await form.getByLabel(/^Taxonomy release id/).fill('REL-1')
  const puts = () =>
    recorded(request).then((r) => r.filter((x) => x.method === 'PUT' && x.path.includes('/rows/')))
  await form.getByRole('button', { name: 'Replace row 1' }).click()
  await expect(form.getByRole('alert')).toBeVisible()
  expect(await puts()).toHaveLength(0)
  await form.getByLabel(/^Product id/).fill('TZP-Fixed-1')
  await form.getByRole('button', { name: 'Replace row 1' }).click()
  await expect(page.getByText('Open (accepting rows)').first()).toBeVisible()
  const sent = await puts()
  expect(sent).toHaveLength(1)
  expect(sent[0]!.path).toBe(`/api/v1/admin/imports/jobs/${id}/rows/1`)
  expect(JSON.parse(sent[0]!.body)).toMatchObject({ id: 'TZP-Fixed-1', brandCode: 'ACME' })

  // the other bad row is fixed the same way, then validate again
  await rows.getByRole('button', { name: 'Correct row 3' }).click()
  const form3 = page.getByRole('form', { name: 'Correct row 3' })
  await form3.getByLabel(/^Product id/).fill('TZP-Fixed-3')
  await form3.getByLabel(/^Title/).fill('Dal')
  await form3.getByLabel(/^Brand code/).fill('acme')
  await form3.getByLabel(/^Internal key/).fill('k-3')
  await form3.getByLabel(/^Vertical id/).fill('TZV-000001')
  await form3.getByLabel(/^Taxonomy release id/).fill('REL-1')
  await form3.getByRole('button', { name: 'Replace row 3' }).click()
  await expect(page.getByRole('form', { name: 'Correct row 3' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Validate rows' }).click()
  await expect(page.getByRole('progressbar', { name: 'Validating progress' })).toBeVisible()
  await tick(request, id)
  await expect(page.getByText('Validated, ready to approve').first()).toBeVisible({
    timeout: 20_000,
  })
})

test('pause and resume: a paused job offers Resume (not Approve), resumes from its cursor, and completes', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'PAUSED', rows: 6 })
  await openJob(page, id)
  await expect(page.getByText('Paused (can resume)').first()).toBeVisible()
  await expect(page.getByText('Worker note: datastore unavailable')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve and apply…' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Resume' }).click()
  await expect(page.getByText('Applying').first()).toBeVisible()
  await tick(request, id)
  await expect(page.getByText('Completed').first()).toBeVisible({ timeout: 20_000 })
  const resume = (await recorded(request)).filter((r) => r.path.endsWith('/resume'))
  expect(resume).toHaveLength(1)
})

test('cancel asks first, destructive dialog focuses Cancel, and then ends the job', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'VALIDATED', rows: 3 })
  await openJob(page, id)
  await page.getByRole('button', { name: 'Cancel job…' }).click()
  const dialog = page.getByRole('dialog', { name: `Cancel ${id}?` })
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect((await recorded(request)).filter((r) => r.path.endsWith('/cancel'))).toHaveLength(0)
  await page.getByRole('button', { name: 'Cancel job…' }).click()
  await dialog.getByRole('button', { name: 'Cancel job' }).click()
  await expect(page.getByText('Cancelled').first()).toBeVisible()
})

test('a stale screen cannot act: the backend answers 409, the job is reloaded, nothing was changed', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'OPEN', rows: 2 })
  await openJob(page, id)
  // someone else adds rows meanwhile: the job version moves on
  const res = await page.request.post(`/api/bff/imports/jobs/${id}/rows`, {
    headers: {
      origin: 'http://localhost:3988',
      'x-tazzzo-csrf': '1',
      'content-type': 'application/json',
    },
    data: {
      rows: [
        {
          id: 'TZP-other-1',
          productType: 'single',
          identityType: 'internal',
          internalKey: 'o1',
          brandCode: 'ACME',
          title: 'Other',
          verticalId: 'TZV-000001',
          releaseId: 'REL-1',
          classificationStatus: 'provisional',
        },
      ],
    },
  })
  expect(res.status()).toBe(200)
  await page.getByRole('button', { name: 'Validate rows' }).click()
  await expect(page.getByText(/not in a state that allows this action/)).toBeVisible()
  await expect(page.getByText('Open (accepting rows)').first()).toBeVisible()
  await expect(page.getByText('Rows stored').locator('xpath=following-sibling::dd[1]')).toHaveText(
    '3',
  ) // reloaded
  await page.getByRole('button', { name: 'Validate rows' }).click() // with the fresh version it works
  await expect(page.getByText('Validating').first()).toBeVisible()
})

test('upload failures are explained without backend text and never retried by themselves (413, 422, 409, 503, 401)', async ({
  page,
  request,
}) => {
  test.slow() // four of its five cases wait out the ambiguity window (6 s) or the maximum (25 s)
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'OPEN', rows: 0 })
  const rows = csv(
    Array.from({ length: 3 }, (_, i) => `TZP-up-${i},T${i},acme,TZV-000001,REL-1,k${i}`),
  )
  await openJob(page, id)
  const attempt = async () => {
    await page
      .getByLabel('CSV file')
      .setInputFiles({ name: 'rows.csv', mimeType: 'text/csv', buffer: rows })
    await page.getByRole('button', { name: /Add 3 rows to the job|Retry from request 1/ }).click()
  }
  const posts = async () =>
    (await recorded(request)).filter((r) => r.method === 'POST' && r.path.endsWith('/rows')).length
  for (const [status, code, text] of [
    [413, 'PAYLOAD_TOO_LARGE', /too large for the backend. Nothing from it was stored/],
    [422, 'INVALID_IMPORT', /none of it was stored/],
    [409, 'IMPORT_JOB_STATE', /not in a state that allows this upload/],
    [503, 'UNAVAILABLE', /could not complete this upload right now.*not retried/],
  ] as const) {
    await control(request, 'force', [
      { match: 'POST /api/v1/admin/imports/jobs', status, code, count: 1 },
    ])
    const before = await posts()
    await attempt()
    const alert = page.locator('main').getByRole('alert').filter({ hasText: text })
    // 409 and 5xx are AMBIGUOUS: the job is watched (6 s in tests) before anything is concluded
    const ambiguous = status === 409 || status === 503
    await expect(alert).toBeVisible({ timeout: 30_000 })
    await expect(alert).toContainText(
      status === 409
        ? // a lock 409 never counts as idle: it waits for an outcome or the maximum (25 s in tests)
          'Request 1 of 1 had an unknown outcome. Still no answer after 25 seconds'
        : ambiguous
          ? 'Request 1 of 1 had an unknown outcome. The job was watched for 6 s: nothing was published'
          : 'Request 1 of 1 stored nothing; 0 rows',
      { timeout: 30_000 },
    )
    await expect(alert).not.toContainText(ambiguous ? 'stored nothing' : 'unknown outcome')
    await expect(page.getByText(/Foo\.java|stack trace/)).toHaveCount(0)
    await page.waitForTimeout(800)
    expect(await posts()).toBe(before + 1)
    await page.reload()
    await settled(page)
  }
  await control(request, 'force', [
    { match: 'POST /api/v1/admin/imports/jobs', status: 401, code: 'UNAUTHENTICATED', count: 1 },
  ])
  await attempt()
  await expect(page).toHaveURL(/\/login/)
})

test('a failure in the middle keeps the earlier requests, says how many rows are stored, and retries only the failed request', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'OPEN', rows: 0 })
  const many = csv(
    Array.from({ length: 205 }, (_, i) => `TZP-mid-${i},T${i},acme,TZV-000001,REL-1,k${i}`),
  )
  await openJob(page, id)
  await page
    .getByLabel('CSV file')
    .setInputFiles({ name: 'rows.csv', mimeType: 'text/csv', buffer: many })
  // let the first request through, refuse the second
  await control(request, 'force', [
    {
      match: 'POST /api/v1/admin/imports/jobs',
      status: 422,
      code: 'INVALID_IMPORT',
      skip: 1,
      count: 1,
    },
  ])
  await page.getByRole('button', { name: 'Add 205 rows to the job' }).click()
  const alert = page.locator('main').getByRole('alert').filter({
    hasText: 'Request 2 of 2 stored nothing; 200 rows from the earlier requests are stored',
  })
  await expect(alert).toBeVisible()
  await expect(page.getByText('Rows stored').locator('xpath=following-sibling::dd[1]')).toHaveText(
    '200',
  )
  await page.getByRole('button', { name: 'Retry from request 2' }).click()
  await expect(page.getByText('Rows stored').locator('xpath=following-sibling::dd[1]')).toHaveText(
    '205',
  )
})

test('an upload the backend refuses for capacity stores nothing (atomic) and the job stays OPEN', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'OPEN', rows: 0 })
  await control(request, 'jobs/config', { maxRowsPerJob: 2 })
  await openJob(page, id)
  await page.getByLabel('CSV file').setInputFiles({
    name: 'rows.csv',
    mimeType: 'text/csv',
    buffer: csv([
      'TZP-c-1,A,acme,TZV-000001,REL-1,k1',
      'TZP-c-2,B,acme,TZV-000001,REL-1,k2',
      'TZP-c-3,C,acme,TZV-000001,REL-1,k3',
    ]),
  })
  await page.getByRole('button', { name: 'Add 3 rows to the job' }).click()
  await expect(
    page.locator('main').getByRole('alert').filter({ hasText: 'none of it was stored' }),
  ).toBeVisible()
  await expect(page.getByText('Rows stored').locator('xpath=following-sibling::dd[1]')).toHaveText(
    '0',
  )
})

test('the job list pages with Older/Newest and filters by status', async ({ page, request }) => {
  await signInFresh(page, WRITER_SUB)
  await control(request, 'jobs/config', { maxActiveJobs: 100 })
  for (let i = 0; i < 22; i++)
    await seedJob(request, { status: i % 2 ? 'VALIDATED' : 'OPEN', rows: 2, note: `job ${i}` })
  await page.goto('/catalogue/imports/jobs')
  await settled(page)
  const links = page.getByRole('table').getByRole('rowheader')
  await expect(links).toHaveCount(20)
  await expect(page.getByRole('cell', { name: 'job 21' })).toBeVisible() // newest first
  await page.getByRole('link', { name: 'Older' }).click()
  await expect(links).toHaveCount(2)
  await expect(page.getByRole('link', { name: 'Older' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Newest' }).click()
  await expect(links).toHaveCount(20)
  await page.getByLabel('Status').selectOption('VALIDATED')
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page).toHaveURL(/status=VALIDATED/)
  await expect(links).toHaveCount(11)
  await page.getByLabel('Status').selectOption('PAUSED')
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByText('No job has this status.')).toBeVisible()
})

test('rows are paged 100 at a time and a row number can be jumped to', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'VALIDATED', rows: 230 })
  await openJob(page, id)
  const rows = page.getByRole('region', { name: 'Row verdicts' }).getByRole('rowheader')
  await expect(rows).toHaveCount(100)
  await page.getByRole('link', { name: 'Next' }).click()
  await expect(page).toHaveURL(/from=100/)
  await expect(rows.first()).toHaveText('100')
  await page.getByRole('link', { name: 'Next' }).click()
  await expect(rows).toHaveCount(30)
  await expect(page.getByRole('link', { name: 'Next' })).toHaveCount(0)
  await page.getByLabel('Start at row').fill('150')
  await page.getByRole('button', { name: 'Go' }).click()
  await expect(rows.first()).toHaveText('150')
  await page.getByRole('link', { name: 'First rows' }).click()
  await expect(rows.first()).toHaveText('0')
})

test('a reader can read jobs, rows and errors but has no controls; the backend refuses a forged mutation and the session survives', async ({
  page,
  request,
}) => {
  const writerId = await (async () => {
    await signInFresh(page, WRITER_SUB)
    return seedJob(request, { status: 'REJECTED', rows: 3, invalidRows: [1] })
  })()
  await page.context().clearCookies()
  await page.request.post(`${process.env.E2E_OIDC_URL}/__control/identity`, {
    data: { sub: READER_SUB, email: `${READER_SUB}@tazzzo.test` },
  })
  await page.goto('/')
  await page.getByRole('link', { name: 'Sign in with Google' }).click()
  await expect(page.getByRole('button', { name: /Account menu/ })).toBeVisible()
  await expect(
    page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Import jobs' }),
  ).toBeVisible()
  await expect(
    page
      .getByRole('navigation', { name: 'Modules' })
      .getByRole('link', { name: 'Imports', exact: true }),
  ).toHaveCount(0)
  await page.goto('/catalogue/imports/jobs')
  await expect(page.getByRole('note')).toContainText('cms-writer')
  await expect(page.getByRole('form', { name: 'Create import job' })).toHaveCount(0)
  await openJob(page, writerId)
  await expect(page.getByRole('note').filter({ hasText: 'Read-only' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: /Validate|Approve|Cancel job|Correct/ }),
  ).toHaveCount(0)
  await expect(page.getByLabel('CSV file')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Row verdicts' })).toContainText('tzp_bad_1')
  await expect(page.getByRole('button', { name: 'Download errors.csv' })).toBeVisible()
  const forged = await page.request.post(`/api/bff/imports/jobs/${writerId}/cancel`, {
    headers: {
      origin: 'http://localhost:3988',
      'x-tazzzo-csrf': '1',
      'content-type': 'application/json',
    },
    data: { version: 1 },
  })
  expect(forged.status()).toBe(403)
  await page.goto('/catalogue/imports/jobs')
  await expect(page.getByRole('link', { name: writerId })).toBeVisible()
})

test('roles without catalogue access are refused by the backend and see a clear state', async ({
  page,
}) => {
  await signInFresh(page, SUPPORT_SUB)
  await expect(
    page.getByRole('navigation', { name: 'Modules' }).getByRole('link', { name: 'Import jobs' }),
  ).toHaveCount(0)
  await page.goto('/catalogue/imports/jobs')
  await expect(page.locator('main').getByRole('alert')).toContainText('Not permitted')
})

test('the go-to box opens a job by id, and the access matrix documents the job rows', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'VALIDATED', rows: 2 })
  await page.goto('/')
  await settled(page)
  await page.getByRole('textbox', { name: 'Go to an id' }).fill(id)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`${id}$`))
  await page.goto('/account')
  const row = page.getByRole('row', { name: /Import jobs \(background, any size\)/ })
  await expect(row).toBeVisible()
  await expect(row.getByRole('cell').nth(0)).toHaveText('R')
  await expect(row.getByRole('cell').nth(1)).toHaveText('R W')
  await page.goto(jobUrl('IMPJ-ffffffffffffffffffffffff'))
  await expect(page.locator('main').getByRole('alert')).toContainText('Import job not found')
  await page.goto(jobUrl('IMPJ-nope'))
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible()
})

test('a11y basics on the job page: one h1, labelled regions and controls, keyboard-operable dialog', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'VALIDATED', rows: 3 })
  await openJob(page, id)
  await expect(page.locator('main h1')).toHaveCount(1)
  for (const name of ['Row verdicts'])
    await expect(page.getByRole('region', { name })).toHaveAttribute('tabindex', '0')
  await expect(page.getByRole('table')).toHaveCount(1)
  await expect(page.getByRole('table').getByRole('columnheader')).toHaveCount(5)
  const approve = page.getByRole('button', { name: 'Approve and apply…' })
  await approve.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Approve and apply' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(approve).toBeFocused()
})

test('the quick import page keeps working and links to jobs; the backend job list failure is a clear state', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  await page.goto('/catalogue/imports')
  await expect(page.getByRole('link', { name: 'Import jobs (large product files)' })).toBeVisible()
  await expect(page.getByLabel(/CSV file/)).toBeVisible()
  await control(request, 'force', [
    { match: 'GET /api/v1/admin/imports/jobs', status: 503, code: 'UNAVAILABLE', count: 1 },
  ])
  await page.goto('/catalogue/imports/jobs')
  await expect(page.locator('main').getByRole('alert')).toContainText('Import jobs unavailable')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Import jobs' })).toBeVisible()
  expect(BACKEND()).toBeTruthy()
})

const rowsCell = (page: Page) =>
  page.getByText('Rows stored').locator('xpath=following-sibling::dd[1]')
const bigCsv = (n: number, prefix = 'TZP-amb') =>
  csv(
    Array.from(
      { length: n },
      (_, i) => `${prefix}-${i},T${i},acme,TZV-000001,REL-1,k-${prefix}-${i}`,
    ),
  )
const rowPosts = async (request: Parameters<typeof recorded>[0]) =>
  (await recorded(request)).filter((r) => r.method === 'POST' && r.path.endsWith('/rows'))

for (const [label, status] of [
  ['the connection drops (no answer at all)', 0],
  ['the backend answers 504 after committing', 504],
] as const) {
  test(`ambiguous failure, COMMITTED: ${label} -> checked, says it landed, retry never duplicates rows`, async ({
    page,
    request,
  }) => {
    await signInFresh(page, WRITER_SUB)
    const id = await seedJob(request, { status: 'OPEN', rows: 0 })
    await openJob(page, id)
    await page
      .getByLabel('CSV file')
      .setInputFiles({ name: 'rows.csv', mimeType: 'text/csv', buffer: bigCsv(405) })
    // the 2nd request is processed and stored by the backend, then its answer is lost
    await control(request, 'force', [
      {
        match: 'POST /api/v1/admin/imports/jobs',
        status,
        code: 'GATEWAY',
        commit: true,
        skip: 1,
        count: 1,
      },
    ])
    await page.getByRole('button', { name: 'Add 405 rows to the job' }).click()
    const alert = page.locator('main').getByRole('alert').filter({ hasText: 'unknown outcome' })
    await expect(alert).toContainText('it DID land')
    await expect(alert).not.toContainText('stored nothing')
    await expect(rowsCell(page)).toHaveText('400')
    await page.getByRole('button', { name: 'Retry from request 3' }).click()
    await expect(rowsCell(page)).toHaveText('405')
    expect(await rowPosts(request)).toHaveLength(3) // request 2 was never sent twice
    // validate: no row is flagged as a duplicate
    await page.getByRole('button', { name: 'Validate rows' }).click()
    await expect(page.getByRole('progressbar', { name: 'Validating progress' })).toBeVisible()
    await tick(request, id)
    await expect(page.getByText('Validated, ready to approve').first()).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText('Duplicate').locator('xpath=following-sibling::dd[1]')).toHaveText(
      '0',
    )
  })
}

test('ambiguous failure, NOT committed: reported as unknown, checked as not landed, retry sends it exactly once', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'OPEN', rows: 0 })
  await openJob(page, id)
  await page
    .getByLabel('CSV file')
    .setInputFiles({ name: 'rows.csv', mimeType: 'text/csv', buffer: bigCsv(205) })
  await control(request, 'force', [
    { match: 'POST /api/v1/admin/imports/jobs', status: 504, code: 'GATEWAY', skip: 1, count: 1 },
  ])
  await page.getByRole('button', { name: 'Add 205 rows to the job' }).click()
  const alert = page.locator('main').getByRole('alert').filter({ hasText: 'unknown outcome' })
  await expect(alert).toContainText('nothing was published', { timeout: 30_000 })
  await expect(rowsCell(page)).toHaveText('200')
  await page.getByRole('button', { name: 'Retry from request 2' }).click()
  await expect(rowsCell(page)).toHaveText('205')
  expect(await rowPosts(request)).toHaveLength(3)
})

test('the job was changed by someone else meanwhile: the retry is blocked and nothing is re-sent', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'OPEN', rows: 0 })
  await openJob(page, id)
  await page
    .getByLabel('CSV file')
    .setInputFiles({ name: 'rows.csv', mimeType: 'text/csv', buffer: bigCsv(205) })
  await control(request, 'force', [
    { match: 'POST /api/v1/admin/imports/jobs', status: 504, code: 'GATEWAY', skip: 1, count: 1 },
  ])
  await page.getByRole('button', { name: 'Add 205 rows to the job' }).click()
  await expect(
    page.locator('main').getByRole('alert').filter({ hasText: 'nothing was published' }),
  ).toBeVisible({ timeout: 30_000 })
  const other = await page.request.post(`/api/bff/imports/jobs/${id}/rows`, {
    headers: {
      origin: 'http://localhost:3988',
      'x-tazzzo-csrf': '1',
      'content-type': 'application/json',
    },
    data: {
      rows: [
        {
          id: 'TZP-else-1',
          productType: 'single',
          identityType: 'internal',
          internalKey: 'e1',
          brandCode: 'ACME',
          title: 'E',
          verticalId: 'TZV-000001',
          releaseId: 'REL-1',
          classificationStatus: 'provisional',
        },
      ],
    },
  })
  expect(other.status()).toBe(200)
  const before = (await rowPosts(request)).length
  await page.getByRole('button', { name: 'Retry from request 2' }).click()
  await expect(
    page
      .locator('main')
      .getByRole('alert')
      .filter({ hasText: 'The job holds 201 rows but this upload expected 200' }),
  ).toBeVisible()
  expect((await rowPosts(request)).length).toBe(before)
})

test('choosing the same file again after a reload is called out and needs an explicit append', async ({
  page,
  request,
}) => {
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'OPEN', rows: 0 })
  await openJob(page, id)
  const file = { name: 'rows.csv', mimeType: 'text/csv', buffer: bigCsv(30, 'TZP-again') }
  await page.getByLabel('CSV file').setInputFiles(file)
  await page.getByRole('button', { name: 'Add 30 rows to the job' }).click()
  await expect(rowsCell(page)).toHaveText('30')
  await page.reload()
  await settled(page)
  await page.getByLabel('CSV file').setInputFiles(file)
  const add = page.getByRole('button', { name: 'Add 30 rows to the job' })
  await expect(add).toBeDisabled()
  await expect(page.getByRole('note').filter({ hasText: 'same product ids' })).toContainText(
    'This job already holds 30 rows',
  )
  await page.getByRole('checkbox', { name: /Append anyway/ }).check()
  await expect(add).toBeEnabled()
})

test('an invalid stock filter in the address is dropped and the person is told', async ({
  page,
}) => {
  await signInFresh(page, WRITER_SUB)
  await page.goto('/inventory?state=bogus&location=bad%20id')
  await expect(
    page.getByText(/location and state filter in the address was not a valid value/),
  ).toBeVisible()
})

for (const [label, zombieMs] of [
  ['finishes inside the wait', 3_000],
  ['outlives the wait (the retry meets the lock)', 20_000],
] as const) {
  test(`ZOMBIE request (the BFF gave up, the backend keeps going) that ${label}: no duplicates, never "stored nothing"`, async ({
    page,
    request,
  }) => {
    test.slow()
    await signInFresh(page, WRITER_SUB)
    const id = await seedJob(request, { status: 'OPEN', rows: 0 })
    await openJob(page, id)
    await page
      .getByLabel('CSV file')
      .setInputFiles({ name: 'rows.csv', mimeType: 'text/csv', buffer: bigCsv(405, 'TZP-zom') })
    await control(request, 'force', [
      { match: 'POST /api/v1/admin/imports/jobs', status: 0, zombie: zombieMs, skip: 1, count: 1 },
    ])
    await page.getByRole('button', { name: 'Add 405 rows to the job' }).click()
    // the wait is visible, announced, cancellable, and nothing is sent during it
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Waiting to learn whether request 2 reached the job' }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop waiting' })).toBeVisible()
    const alert = page.locator('main').getByRole('alert')
    if (zombieMs > 6_000) {
      // the quiet window passes while the zombie still holds the lock: a retry is offered...
      await expect(alert).toContainText('nothing was published', { timeout: 20_000 })
      await page.getByRole('button', { name: 'Retry from request 2' }).click()
      // ...and the backend refuses it (lock): that is NOT "stored nothing"; we go back to waiting
      await expect(page.getByText('An upload on this job is still running')).toBeVisible({
        timeout: 10_000,
      })
      await expect(alert).not.toContainText('stored nothing')
    }
    await expect(alert).toContainText('it DID land', { timeout: 30_000 })
    await expect(alert).not.toContainText('stored nothing')
    await expect(rowsCell(page)).toHaveText('400')
    await page.getByRole('button', { name: 'Retry from request 3' }).click()
    await expect(rowsCell(page)).toHaveText('405')
    // request 2 reached the backend exactly once as stored rows; the retry (if any) was refused by the lock
    const posts = await rowPosts(request)
    expect(posts.length).toBe(zombieMs > 6_000 ? 4 : 3)
    await page.getByRole('button', { name: 'Validate rows' }).click()
    await expect(page.getByRole('progressbar', { name: 'Validating progress' })).toBeVisible()
    await tick(request, id)
    await expect(page.getByText('Validated, ready to approve').first()).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText('Duplicate').locator('xpath=following-sibling::dd[1]')).toHaveText(
      '0',
    )
  })
}

test('ZOMBIE request that never finishes: the wait is bounded and the upload is blocked with a clear message', async ({
  page,
  request,
}) => {
  test.slow()
  await signInFresh(page, WRITER_SUB)
  const id = await seedJob(request, { status: 'OPEN', rows: 0 })
  await openJob(page, id)
  await page
    .getByLabel('CSV file')
    .setInputFiles({ name: 'rows.csv', mimeType: 'text/csv', buffer: bigCsv(405, 'TZP-nev') })
  await control(request, 'force', [
    { match: 'POST /api/v1/admin/imports/jobs', status: 0, zombie: 120_000, skip: 1, count: 1 },
  ])
  await page.getByRole('button', { name: 'Add 405 rows to the job' }).click()
  // production waits 90 s of quiet, then offers one guarded retry; give up after 16 min. Tests: 6 s and 25 s.
  await page.getByRole('button', { name: 'Retry from request 2' }).click({ timeout: 20_000 })
  const alert = page.locator('main').getByRole('alert')
  await expect(alert).toContainText('Still no answer after 25 seconds', { timeout: 45_000 })
  await expect(page.getByRole('button', { name: 'Retry from request 2' })).toBeDisabled()
  expect((await rowPosts(request)).length).toBe(3) // first, zombie, the one refused retry: nothing else was sent
})
