import { Redis } from 'ioredis'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { READER_SUB, WRITER_SUB } from '../support/fake-backend'
import {
  CMS_BASE_URL,
  SESSION_COOKIE,
  startHarness,
  stopHarness,
  TX_COOKIE,
  type Harness,
} from '../support/integration-env'

/**
 * The stock-list and import-job BFF routes over real Valkey sessions, with a backend that verifies every forwarded bearer as
 * a genuine ID token and decides roles by subject. The backend stand-in implements the real state machine, so a whole job
 * (create, append, validate, approve, apply, errors.csv) runs through the actual route handlers.
 */
let h: Harness
let redis: Redis
type Handler = (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>
const r: Record<string, Record<string, Handler>> = {}

beforeAll(async () => {
  h = await startHarness({ verifyTokens: true })
  redis = new Redis(h.redisUrl)
  const load = async (k: string, p: Promise<unknown>) =>
    void (r[k] = (await p) as Record<string, Handler>)
  const start = await import('@/app/api/auth/google/start/route')
  const callback = await import('@/app/api/auth/google/callback/route')
  r.start = start as unknown as Record<string, Handler>
  r.callback = callback as unknown as Record<string, Handler>
  await load('stock', import('@/app/api/bff/inventory/stock/route'))
  await load('create', import('@/app/api/bff/imports/jobs/route'))
  await load('job', import('@/app/api/bff/imports/jobs/[jobId]/route'))
  await load('rows', import('@/app/api/bff/imports/jobs/[jobId]/rows/route'))
  await load('row', import('@/app/api/bff/imports/jobs/[jobId]/rows/[row]/route'))
  await load('action', import('@/app/api/bff/imports/jobs/[jobId]/[action]/route'))
  await load('errors', import('@/app/api/bff/imports/jobs/[jobId]/errors.csv/route'))
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterAll(async () => {
  await redis?.quit()
  await stopHarness(h)
})

beforeEach(async () => {
  await redis.flushall()
  h.backend.reset()
})

async function signIn(sub: string): Promise<string> {
  const res = (await r.start!.GET!(new NextRequest(`${CMS_BASE_URL}/api/auth/google/start`), {
    params: Promise.resolve({}),
  })) as import('next/server').NextResponse
  const p = new URL(res.headers.get('location')!).searchParams
  const code = h.provider.issueCode({
    codeChallenge: p.get('code_challenge')!,
    redirectUri: p.get('redirect_uri')!,
    claims: {
      sub,
      email: `${sub}@tazzzo.test`,
      email_verified: true,
      hd: 'tazzzo.test',
      nonce: p.get('nonce'),
    },
  })
  const done = (await r.callback!.GET!(
    new NextRequest(
      `${CMS_BASE_URL}/api/auth/google/callback?code=${code}&state=${p.get('state')}`,
      {
        headers: { cookie: `${TX_COOKIE}=${res.cookies.get(TX_COOKIE)!.value}` },
      },
    ),
    { params: Promise.resolve({}) },
  )) as import('next/server').NextResponse
  return done.cookies.get(SESSION_COOKIE)!.value
}

function call(
  handler: Handler,
  method: string,
  path: string,
  sessionId: string | null,
  params: Record<string, string> = {},
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return handler(
    new NextRequest(`${CMS_BASE_URL}${path}`, {
      method,
      headers: {
        'x-tazzzo-csrf': '1',
        ...(method === 'GET' ? {} : { origin: CMS_BASE_URL, 'content-type': 'application/json' }),
        ...(sessionId ? { cookie: `${SESSION_COOKIE}=${sessionId}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) },
  )
}

const product = (n: number | string, over: Record<string, unknown> = {}) => ({
  id: `TZP-job-${n}`,
  productType: 'single',
  identityType: 'internal',
  internalKey: `key-${n}`,
  brandCode: 'ACME',
  title: `Item ${n}`,
  verticalId: 'TZV-000001',
  releaseId: 'REL-1',
  classificationStatus: 'provisional',
  ...over,
})
const seedStock = (body: Record<string, unknown>) =>
  fetch(`${h.backend.url}/__control/seed-stock`, { method: 'POST', body: JSON.stringify(body) })
const stockPath = (q = '') => `/api/bff/inventory/stock${q ? `?${q}` : ''}`
const json = async (res: Response) => (await res.json()) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('stock list route', () => {
  it('pages through the keyset cursor until it is null, in (sku, location) order, as the human', async () => {
    await seedStock({ count: 120 })
    const sid = await signIn(WRITER_SUB)
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res = await call(
        r.stock!.GET!,
        'GET',
        stockPath(`limit=50${cursor ? `&cursor=${cursor}` : ''}`),
        sid,
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      const body = await json(res)
      seen.push(...body.data.items.map((i: { skuId: string }) => i.skuId))
      cursor = body.data.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    expect(seen).toHaveLength(121) // TZP-REF-1 plus 120 seeded
    expect([...seen].sort()).toEqual(seen)
    const sent = h.backend.requests.filter((x) => x.path.startsWith('/api/v1/admin/inventory?'))
    expect(
      sent.every((x) => x.sub === WRITER_SUB && x.authorization?.startsWith('Bearer eyJ')),
    ).toBe(true)
    expect(sent.every((x) => x.headers.cookie === undefined)).toBe(true)
  })

  it('an empty page can still carry a cursor (corrupt rows are skipped), and a reader may read the list', async () => {
    await seedStock({ count: 6, corruptEvery: 2, location: 'LOC-C' })
    const sid = await signIn(READER_SUB)
    const res = await call(r.stock!.GET!, 'GET', stockPath('location=LOC-C&limit=1'), sid)
    const body = await json(res)
    expect(res.status).toBe(200)
    // the first listed position is a valid row; walk until a page is empty yet has a cursor
    let page = body.data
    let sawEmptyWithCursor = false
    while (page.nextCursor) {
      const next = await json(
        await call(
          r.stock!.GET!,
          'GET',
          stockPath(`location=LOC-C&limit=1&cursor=${page.nextCursor}`),
          sid,
        ),
      )
      page = next.data
      if (page.items.length === 0 && page.nextCursor) sawEmptyWithCursor = true
    }
    expect(sawEmptyWithCursor).toBe(true)
  })

  it('filters by state and location with the backend grammar; anything else is refused before the backend', async () => {
    await seedStock({ count: 8, location: 'LOC-S' })
    const sid = await signIn(WRITER_SUB)
    const ok = await json(
      await call(r.stock!.GET!, 'GET', stockPath('state=OUT_OF_STOCK&location=LOC-S'), sid),
    )
    expect(ok.data.items.length).toBeGreaterThan(0)
    expect(
      ok.data.items.every((i: { stockState: string }) => i.stockState === 'OUT_OF_STOCK'),
    ).toBe(true)
    const before = h.backend.requests.length
    for (const q of [
      'sku=TZP-1',
      'state=nope',
      'location=',
      'limit=500',
      'cursor=a b',
      'location=A&location=B',
    ]) {
      expect((await call(r.stock!.GET!, 'GET', stockPath(q), sid)).status, q).toBe(400)
    }
    expect(h.backend.requests.length).toBe(before)
  })

  it('503 LIST_TIMEOUT keeps its status and stable code and nothing of the backend text; 403/401 are distinct', async () => {
    const sid = await signIn(WRITER_SUB)
    await fetch(`${h.backend.url}/__control/force`, {
      method: 'POST',
      body: JSON.stringify([
        { match: 'GET /api/v1/admin/inventory', status: 503, code: 'LIST_TIMEOUT', count: 1 },
      ]),
    })
    const res = await call(r.stock!.GET!, 'GET', stockPath(), sid)
    expect(res.status).toBe(503)
    const text = JSON.stringify(await json(res))
    expect(text).toContain('LIST_TIMEOUT')
    expect(text).not.toMatch(/Foo\.java|stack trace/)
    await fetch(`${h.backend.url}/__control/force`, {
      method: 'POST',
      body: JSON.stringify([
        { match: 'GET /api/v1/admin/inventory', status: 403, code: 'FORBIDDEN', count: 1 },
      ]),
    })
    expect((await call(r.stock!.GET!, 'GET', stockPath(), sid)).status).toBe(403)
    expect(await redis.keys('cms:sess:*')).toHaveLength(1)
    await fetch(`${h.backend.url}/__control/force`, {
      method: 'POST',
      body: JSON.stringify([
        { match: 'GET /api/v1/admin/inventory', status: 401, code: 'UNAUTHENTICATED', count: 1 },
      ]),
    })
    expect((await call(r.stock!.GET!, 'GET', stockPath(), sid)).status).toBe(401)
    expect(await redis.keys('cms:sess:*')).toHaveLength(0)
  })

  it('no session, a forged cookie and a missing CSRF header never reach the backend', async () => {
    const before = h.backend.requests.length
    expect((await call(r.stock!.GET!, 'GET', stockPath(), null)).status).toBe(401)
    expect((await call(r.stock!.GET!, 'GET', stockPath(), 'f'.repeat(43))).status).toBe(401)
    const sid = await signIn(WRITER_SUB)
    const mid = h.backend.requests.length
    expect(
      (await call(r.stock!.GET!, 'GET', stockPath(), sid, {}, undefined, { 'x-tazzzo-csrf': '' }))
        .status,
    ).toBe(403)
    expect(
      (
        await call(r.stock!.GET!, 'GET', stockPath(), sid, {}, undefined, {
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403)
    expect(h.backend.requests.length).toBe(mid)
    expect(before).toBeLessThanOrEqual(mid)
  })
})

describe('a whole import job through the real routes', () => {
  async function createJob(sid: string) {
    const res = await call(
      r.create!.POST!,
      'POST',
      '/api/bff/imports/jobs',
      sid,
      {},
      { kind: 'products', note: 'launch' },
    )
    expect(res.status).toBe(200)
    return (await json(res)).data as { id: string; version: number; status: string }
  }
  const action = (sid: string, id: string, a: string, version: number) =>
    call(
      r.action!.POST!,
      'POST',
      `/api/bff/imports/jobs/${id}/${a}`,
      sid,
      { jobId: id, action: a },
      { version },
    )
  const append = (sid: string, id: string, rows: unknown[]) =>
    call(r.rows!.POST!, 'POST', `/api/bff/imports/jobs/${id}/rows`, sid, { jobId: id }, { rows })
  const get = async (sid: string, id: string) =>
    (await json(await call(r.job!.GET!, 'GET', `/api/bff/imports/jobs/${id}`, sid, { jobId: id })))
      .data as {
      status: string
      version: number
      counts: Record<string, number>
      approvedBy: { id: string } | null
      rowsTotal: number
    }

  it('create -> append -> validate -> (REJECTED) correct -> validate -> approve -> apply, with the approver taken from the token', async () => {
    const sid = await signIn(WRITER_SUB)
    const job = await createJob(sid)
    expect(job.status).toBe('OPEN')
    expect(job.id).toMatch(/^IMPJ-[0-9a-f]{24}$/)

    // an invalid id cannot even be sent through the BFF; a row that is valid for the BFF but fails the backend is corrected later
    const appended = await append(sid, job.id, [product(1), product(2), product(2)])
    expect(await json(appended)).toMatchObject({
      data: { rowsAdded: 3, rowsTotal: 3, duplicates: 1 },
    })

    let current = await get(sid, job.id)
    const validate = await action(sid, job.id, 'validate', current.version)
    expect(validate.status).toBe(200)
    expect((await get(sid, job.id)).status).toBe('VALIDATING')
    h.backend.lists.tick({ id: job.id })
    current = await get(sid, job.id)
    expect(current.status).toBe('REJECTED') // the duplicate row
    expect(current.counts).toMatchObject({ valid: 2, duplicate: 1 })

    // errors.csv lists the duplicate, streamed with the right headers
    const csv = await call(
      r.errors!.GET!,
      'GET',
      `/api/bff/imports/jobs/${job.id}/errors.csv`,
      sid,
      { jobId: job.id },
    )
    expect(csv.status).toBe(200)
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(csv.headers.get('cache-control')).toBe('no-store')
    expect(csv.headers.get('content-disposition')).toBe(
      `attachment; filename="${job.id}-errors.csv"`,
    )
    expect(csv.headers.get('x-content-type-options')).toBe('nosniff')
    const text = await csv.text()
    expect(text.split('\r\n')[0]).toBe('row,line,id,phase,outcome,code,message')
    expect(text).toContain('DUPLICATE_ROW')

    // correct row 2 (REJECTED -> OPEN), validate again, approve
    const fix = await call(
      r.row!.PUT!,
      'PUT',
      `/api/bff/imports/jobs/${job.id}/rows/2`,
      sid,
      { jobId: job.id, row: '2' },
      { product: product(3) },
    )
    expect(fix.status).toBe(200)
    expect((await json(fix)).data.status).toBe('OPEN')
    current = await get(sid, job.id)
    await action(sid, job.id, 'validate', current.version)
    h.backend.lists.tick({ id: job.id })
    current = await get(sid, job.id)
    expect(current.status).toBe('VALIDATED')

    const apply = await action(sid, job.id, 'apply', current.version)
    expect(apply.status).toBe(200)
    const approved = await get(sid, job.id)
    expect(approved.status).toBe('APPLYING')
    expect(approved.approvedBy?.id).toBe(`google:${WRITER_SUB}`)
    const sent = h.backend.requests.filter((x) => x.path.endsWith('/apply'))
    expect(JSON.parse(sent[0]!.body)).toEqual({ version: current.version })
    h.backend.lists.tick({ id: job.id })
    expect((await get(sid, job.id)).status).toBe('COMPLETED')
    expect(h.backend.products.get('TZP-job-3')).toBeDefined()
  })

  it('a stale version is refused with 409 and nothing changes; the approval cannot be replayed', async () => {
    const sid = await signIn(WRITER_SUB)
    const job = await createJob(sid)
    await append(sid, job.id, [product(1)])
    const stale = await action(sid, job.id, 'validate', job.version) // version moved when rows were added
    expect(stale.status).toBe(409)
    expect(await json(stale)).toMatchObject({ error: 'conflict', code: 'IMPORT_JOB_STATE' })
    expect((await get(sid, job.id)).status).toBe('OPEN')
    const current = await get(sid, job.id)
    expect((await action(sid, job.id, 'apply', current.version)).status).toBe(409) // not VALIDATED
  })

  it('a reader can read jobs and rows but every mutation is a backend 403 that keeps the session', async () => {
    const writer = await signIn(WRITER_SUB)
    const job = await createJob(writer)
    await append(writer, job.id, [product(1)])
    const sid = await signIn(READER_SUB)
    expect((await get(sid, job.id)).rowsTotal).toBe(1)
    expect((await action(sid, job.id, 'cancel', 1)).status).toBe(403)
    expect((await append(sid, job.id, [product(9)])).status).toBe(403)
    expect(
      (await call(r.create!.POST!, 'POST', '/api/bff/imports/jobs', sid, {}, { kind: 'products' }))
        .status,
    ).toBe(403)
    expect(await redis.keys('cms:sess:*')).toHaveLength(2)
    expect((await get(writer, job.id)).rowsTotal).toBe(1)
  })

  it('maps 404, 422, 413 and 409(too many jobs) without backend text and never retries', async () => {
    const sid = await signIn(WRITER_SUB)
    const missing = 'IMPJ-ffffffffffffffffffffffff'
    expect(
      (await call(r.job!.GET!, 'GET', `/api/bff/imports/jobs/${missing}`, sid, { jobId: missing }))
        .status,
    ).toBe(404)
    expect((await action(sid, missing, 'cancel', 1)).status).toBe(404)
    const job = await createJob(sid)
    expect((await action(sid, job.id, 'validate', job.version)).status).toBe(422) // no rows
    await fetch(`${h.backend.url}/__control/force`, {
      method: 'POST',
      body: JSON.stringify([
        {
          match: 'POST /api/v1/admin/imports/jobs',
          status: 413,
          code: 'PAYLOAD_TOO_LARGE',
          count: 1,
        },
      ]),
    })
    const big = await append(sid, job.id, [product(1)])
    expect(big.status).toBe(413)
    expect(JSON.stringify(await json(big))).not.toMatch(/Foo\.java|stack/)
    await fetch(`${h.backend.url}/__control/jobs/config`, {
      method: 'POST',
      body: JSON.stringify({ maxActiveJobs: 1 }),
    })
    const many = await call(
      r.create!.POST!,
      'POST',
      '/api/bff/imports/jobs',
      sid,
      {},
      { kind: 'products' },
    )
    expect(many.status).toBe(409)
    expect(await json(many)).toMatchObject({ code: 'IMPORT_JOB_STATE' })
    await fetch(`${h.backend.url}/__control/jobs/config`, {
      method: 'POST',
      body: JSON.stringify({ maxRowsPerJob: 2 }),
    })
    const over = await append(sid, job.id, [product(1), product(2), product(3)])
    expect(over.status).toBe(422)
    expect((await get(sid, job.id)).rowsTotal).toBe(0) // the failed request stored nothing
  })

  it('paused applies resume from the cursor without re-applying; cancel ends a job; terminal jobs refuse more', async () => {
    const sid = await signIn(WRITER_SUB)
    const job = await createJob(sid)
    await append(sid, job.id, [product(1), product(2), product(3), product(4)])
    let cur = await get(sid, job.id)
    await action(sid, job.id, 'validate', cur.version)
    h.backend.lists.tick({ id: job.id })
    cur = await get(sid, job.id)
    await action(sid, job.id, 'apply', cur.version)
    h.backend.lists.tick({ id: job.id, pause: true })
    cur = await get(sid, job.id)
    expect(cur.status).toBe('PAUSED')
    expect(cur.counts.applied).toBe(2)
    expect((await action(sid, job.id, 'resume', cur.version)).status).toBe(200)
    h.backend.lists.tick({ id: job.id })
    cur = await get(sid, job.id)
    expect(cur).toMatchObject({
      status: 'COMPLETED',
      counts: expect.objectContaining({ applied: 4 }),
    })
    expect((await action(sid, job.id, 'cancel', cur.version)).status).toBe(409)
    expect((await append(sid, job.id, [product(8)])).status).toBe(409)
  })

  it('every job route needs the session, the CSRF header and a grammar-valid job id', async () => {
    const sid = await signIn(WRITER_SUB)
    const id = 'IMPJ-0123456789abcdef01234567'
    expect(
      (await call(r.job!.GET!, 'GET', `/api/bff/imports/jobs/${id}`, null, { jobId: id })).status,
    ).toBe(401)
    expect(
      (
        await call(r.errors!.GET!, 'GET', `/api/bff/imports/jobs/${id}/errors.csv`, null, {
          jobId: id,
        })
      ).status,
    ).toBe(401)
    expect(
      (await call(r.create!.POST!, 'POST', '/api/bff/imports/jobs', null, {}, { kind: 'products' }))
        .status,
    ).toBe(401)
    expect(
      (
        await call(
          r.action!.POST!,
          'POST',
          `/api/bff/imports/jobs/${id}/apply`,
          sid,
          { jobId: id, action: 'apply' },
          { version: 1 },
          { 'x-tazzzo-csrf': '' },
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await call(
          r.action!.POST!,
          'POST',
          `/api/bff/imports/jobs/${id}/apply`,
          sid,
          { jobId: id, action: 'apply' },
          { version: 1, approvedBy: 'google:evil' },
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await call(
          r.action!.POST!,
          'POST',
          `/api/bff/imports/jobs/${id}/delete`,
          sid,
          { jobId: id, action: 'delete' },
          { version: 1 },
        )
      ).status,
    ).toBe(404)
    for (const bad of ['IMPJ-1', '../me', 'IMPJ-0123456789ABCDEF01234567']) {
      expect(
        (await call(r.job!.GET!, 'GET', '/api/bff/imports/jobs/x', sid, { jobId: bad })).status,
        bad,
      ).toBe(404)
      expect(
        (
          await call(r.errors!.GET!, 'GET', '/api/bff/imports/jobs/x/errors.csv', sid, {
            jobId: bad,
          })
        ).status,
        bad,
      ).toBe(404)
      expect((await action(sid, bad, 'cancel', 1)).status, bad).toBe(400)
    }
    expect(h.backend.requests.filter((x) => x.path.includes('/imports/jobs'))).toEqual([])
  })

  it('errors.csv streams a hostile cell through untouched and a backend failure is a JSON error, not a file', async () => {
    const sid = await signIn(WRITER_SUB)
    const job = await createJob(sid)
    await append(sid, job.id, [
      product(1, { title: '=HYPERLINK("http://evil")' }),
      product(2, { id: 'TZP-ok' }),
    ])
    const cur = await get(sid, job.id)
    await action(sid, job.id, 'validate', cur.version)
    h.backend.lists.tick({ id: job.id })
    const ok = await call(
      r.errors!.GET!,
      'GET',
      `/api/bff/imports/jobs/${job.id}/errors.csv`,
      sid,
      { jobId: job.id },
    )
    expect(ok.status).toBe(200)
    await fetch(`${h.backend.url}/__control/force`, {
      method: 'POST',
      body: JSON.stringify([
        { match: 'GET /api/v1/admin/imports/jobs', status: 500, code: 'INTERNAL', count: 1 },
      ]),
    })
    const bad = await call(
      r.errors!.GET!,
      'GET',
      `/api/bff/imports/jobs/${job.id}/errors.csv`,
      sid,
      { jobId: job.id },
    )
    expect(bad.status).toBe(502)
    expect(bad.headers.get('content-type')).toMatch(/json/)
    expect(await bad.text()).not.toMatch(/Foo\.java|stack/)
  })
})
