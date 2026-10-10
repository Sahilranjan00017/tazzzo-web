import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../support/memory-store'
import { fakeIdToken } from '../support/fake-id-token'

/** The import-job mutations through the real mutation layer: fixed paths, strict bodies, no approver, closed error mapping. */
const BASE = 'https://cms.test'
const BACKEND = 'https://backend.internal'
const COOKIE = '__Host-tz_cms_session'
const TOKEN = fakeIdToken({ sub: '110000000000000000001' })
const ID = 'IMPJ-0123456789abcdef01234567'

let bff: typeof import('@/server/bff/mutation')
let jobs: typeof import('@/server/bff/import-job-actions')
let session: typeof import('@/server/session/session')
let store: MemoryStore
let sessionId: string
let calls: { url: string; init: RequestInit }[]

beforeAll(async () => {
  Object.assign(process.env, {
    CMS_BASE_URL: BASE,
    GOOGLE_CLIENT_ID: 'c',
    GOOGLE_CLIENT_SECRET: 's',
    GOOGLE_HOSTED_DOMAIN: 'tazzzo.test',
    TAZZZO_BACKEND_URL: BACKEND,
    SESSION_STORE_URL: 'redis://127.0.0.1:6379',
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  })
  bff = await import('@/server/bff/mutation')
  jobs = await import('@/server/bff/import-job-actions')
  session = await import('@/server/session/session')
})

beforeEach(async () => {
  store = new MemoryStore()
  calls = []
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const config = (await import('@/server/session/config')).sessionConfig(
    (await import('@/server/env')).serverEnv(),
  )
  sessionId = (await session.createSession(
    store,
    TOKEN,
    Math.floor(Date.now() / 1000) + 3600,
    config,
    Date.now(),
  ))!.sessionId
})
afterEach(() => vi.restoreAllMocks())

const jobView = (over: Record<string, unknown> = {}) => ({
  id: ID,
  kind: 'products',
  status: 'OPEN',
  note: null,
  createdBy: { type: 'HUMAN_ADMIN', id: 'google:1' },
  approvedBy: null,
  rowsTotal: 0,
  nextRow: 0,
  counts: {
    valid: 0,
    unchanged: 0,
    invalid: 0,
    duplicate: 0,
    applied: 0,
    failed: 0,
    not_attempted: 0,
  },
  attemptCount: 0,
  lastError: null,
  createdAt: '2026-10-09T10:00:00Z',
  updatedAt: '2026-10-09T10:00:00Z',
  startedAt: null,
  finishedAt: null,
  version: 1,
  ...over,
})

function backend(status: number, body: unknown) {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_0123456789abcdef0123' },
    })
  }) as typeof fetch
}

function req(path: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${BASE}${path}`, {
    method,
    headers: {
      origin: BASE,
      'x-tazzzo-csrf': '1',
      'content-type': 'application/json',
      cookie: `${COOKIE}=${sessionId}`,
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

async function send<I, O, C>(
  spec: import('@/server/bff/mutation').BffMutationSpec<I, O, C>,
  method: string,
  body: unknown,
  status: number,
  upstream: unknown,
  params: Record<string, string> = {},
) {
  const res = await bff.runBffMutation(spec, req('/api/bff/x', method, body), params, {
    store,
    fetchImpl: backend(status, upstream),
    now: Date.now,
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const product = {
  id: 'TZP-med-3',
  productType: 'single',
  identityType: 'internal',
  internalKey: 'k-1',
  brandCode: 'ACME',
  title: 'Rice',
  verticalId: 'TZV-000001',
  releaseId: 'REL-1',
  classificationStatus: 'provisional',
}

describe('create', () => {
  it('posts the kind and an optional trimmed note to the fixed jobs path', async () => {
    const r = await send(
      jobs.createJobMutation,
      'POST',
      { kind: 'products', note: '  launch  ' },
      201,
      jobView(),
    )
    expect(r.status).toBe(200)
    expect((r.body.data as { id: string }).id).toBe(ID)
    expect(calls[0]!.url).toBe(`${BACKEND}/api/v1/admin/imports/jobs`)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ kind: 'products', note: 'launch' })
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
  })
  it('refuses another kind, an overlong note and unknown fields before any backend call', async () => {
    for (const body of [
      { kind: 'prices' },
      { kind: 'products', note: 'x'.repeat(501) },
      { kind: 'products', createdBy: 'me' },
    ]) {
      expect((await send(jobs.createJobMutation, 'POST', body, 201, jobView())).status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })
  it('maps the too-many-active-jobs refusal to 409 with the stable code only', async () => {
    const r = await send(jobs.createJobMutation, 'POST', { kind: 'products' }, 409, {
      error: { code: 'IMPORT_JOB_STATE', message: 'too many active import jobs (max 10)' },
    })
    expect(r).toMatchObject({ status: 409, body: { error: 'conflict', code: 'IMPORT_JOB_STATE' } })
    expect(JSON.stringify(r.body)).not.toMatch(/too many/)
  })
})

describe('append rows', () => {
  it('sends the rows to the fixed rows path of the validated job id', async () => {
    const r = await send(
      jobs.appendRowsMutation,
      'POST',
      { rows: [product] },
      200,
      { rowsAdded: 1, rowsTotal: 1, duplicates: 0 },
      { jobId: ID },
    )
    expect(r.body.data).toEqual({ rowsAdded: 1, rowsTotal: 1, duplicates: 0 })
    expect(calls[0]!.url).toBe(`${BACKEND}/api/v1/admin/imports/jobs/${ID}/rows`)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ rows: [product] })
  })
  it('keeps product ids exactly as sent, rejects bad ids, empty and oversize row lists', async () => {
    await send(
      jobs.appendRowsMutation,
      'POST',
      {
        rows: [
          { ...product, id: 'TZP-MED-3' },
          { ...product, id: 'TZP-med-3' },
        ],
      },
      200,
      { rowsAdded: 2, rowsTotal: 2, duplicates: 0 },
      { jobId: ID },
    )
    expect(
      (JSON.parse(String(calls[0]!.init.body)) as { rows: { id: string }[] }).rows.map((x) => x.id),
    ).toEqual(['TZP-MED-3', 'TZP-med-3'])
    for (const rows of [
      [{ ...product, id: 'tzp-1' }],
      [{ ...product, id: 'TZP-a_b' }],
      [],
      Array.from({ length: 501 }, () => product),
    ]) {
      expect(
        (await send(jobs.appendRowsMutation, 'POST', { rows }, 200, {}, { jobId: ID })).status,
      ).toBe(400)
    }
    expect(calls).toHaveLength(1)
  })
  it('refuses a job id that is not the backend grammar (no path injection)', async () => {
    for (const jobId of [
      '../admin/me',
      'IMPJ-1',
      `${ID}/rows`,
      'IMPJ-0123456789abcdef0123456%2F',
    ]) {
      expect(
        (await send(jobs.appendRowsMutation, 'POST', { rows: [product] }, 200, {}, { jobId }))
          .status,
        jobId,
      ).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })
  it.each([
    [409, 'IMPORT_JOB_STATE', 409],
    [422, 'INVALID_IMPORT', 422],
    [413, 'PAYLOAD_TOO_LARGE', 413],
    [404, 'IMPORT_JOB_NOT_FOUND', 404],
    [403, 'FORBIDDEN', 403],
  ])('answers backend %i %s as %i without the backend message', async (status, code, expected) => {
    const r = await send(
      jobs.appendRowsMutation,
      'POST',
      { rows: [product] },
      status,
      { error: { code, message: 'internal detail: Foo.java:42' } },
      { jobId: ID },
    )
    expect(r.status).toBe(expected)
    expect(JSON.stringify(r.body)).not.toMatch(/Foo\.java|internal detail/)
  })
  it('turns a 5xx into a 502 and never retries', async () => {
    const r = await send(
      jobs.appendRowsMutation,
      'POST',
      { rows: [product] },
      500,
      { error: { code: 'INTERNAL' } },
      { jobId: ID },
    )
    expect(r.status).toBe(502)
    expect(calls).toHaveLength(1)
  })
  it('allows a 2 MiB body and a long wait, because the backend does', () => {
    expect(jobs.appendRowsMutation.maxBodyBytes).toBe(2 * 1024 * 1024)
    expect(jobs.appendRowsMutation.timeoutMs).toBeGreaterThanOrEqual(30_000)
  })
})

describe('correct a row', () => {
  it('PUTs the replacement product to the numbered row; the row comes from the path only', async () => {
    const r = await send(
      jobs.correctRowMutation,
      'PUT',
      { product, row: 99 },
      200,
      jobView({ version: 5 }),
      { jobId: ID, row: '7' },
    )
    expect(r.status).toBe(200)
    expect(calls[0]!.init.method).toBe('PUT')
    expect(calls[0]!.url).toBe(`${BACKEND}/api/v1/admin/imports/jobs/${ID}/rows/7`)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(product)
  })
  it('applies the shared product-id grammar and rejects non-numeric rows', async () => {
    expect(
      (
        await send(
          jobs.correctRowMutation,
          'PUT',
          { product: { ...product, id: 'tzp-x' } },
          200,
          jobView(),
          { jobId: ID, row: '1' },
        )
      ).status,
    ).toBe(400)
    for (const row of ['-1', '1.5', 'abc', '1/2', '']) {
      expect(
        (
          await send(jobs.correctRowMutation, 'PUT', { product }, 200, jobView(), {
            jobId: ID,
            row,
          })
        ).status,
        row,
      ).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('validate / apply / resume / cancel', () => {
  it.each(['validate', 'apply', 'resume', 'cancel'] as const)(
    '%s posts only the version to its own fixed path',
    async (action) => {
      const r = await send(
        jobs.jobActionMutation(action),
        'POST',
        { version: 6 },
        200,
        jobView({ status: 'APPLYING', version: 7 }),
        { jobId: ID },
      )
      expect(r.status).toBe(200)
      expect(calls[0]!.url).toBe(`${BACKEND}/api/v1/admin/imports/jobs/${ID}/${action}`)
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ version: 6 })
    },
  )
  it('the approver is never taken from the browser: any approvedBy/approver field is refused', async () => {
    for (const extra of [{ approvedBy: 'google:1' }, { approver: 'x' }, { actor: { id: 'y' } }]) {
      expect(
        (
          await send(
            jobs.jobActionMutation('apply'),
            'POST',
            { version: 1, ...extra },
            200,
            jobView(),
            { jobId: ID },
          )
        ).status,
      ).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })
  it('requires a numeric version', async () => {
    for (const body of [{}, { version: '3' }, { version: -1 }, { version: 1.5 }]) {
      expect(
        (await send(jobs.jobActionMutation('apply'), 'POST', body, 200, jobView(), { jobId: ID }))
          .status,
      ).toBe(400)
    }
  })
  it('a stale version is a 409 conflict (there is no 412 on this API) and a missing job a 404', async () => {
    expect(
      await send(
        jobs.jobActionMutation('apply'),
        'POST',
        { version: 1 },
        409,
        { error: { code: 'IMPORT_JOB_STATE', message: 'x' } },
        { jobId: ID },
      ),
    ).toMatchObject({ status: 409, body: { code: 'IMPORT_JOB_STATE' } })
    expect(
      (
        await send(
          jobs.jobActionMutation('cancel'),
          'POST',
          { version: 1 },
          404,
          { error: { code: 'IMPORT_JOB_NOT_FOUND' } },
          { jobId: ID },
        )
      ).status,
    ).toBe(404)
  })
  it('a backend 401 ends the CMS session', async () => {
    expect(store.data.size).toBe(1)
    const r = await send(
      jobs.jobActionMutation('validate'),
      'POST',
      { version: 1 },
      401,
      { error: { code: 'UNAUTHENTICATED' } },
      { jobId: ID },
    )
    expect(r.status).toBe(401)
    expect(store.data.size).toBe(0)
  })
  it('recognises exactly the four actions', () => {
    expect(
      ['validate', 'apply', 'resume', 'cancel', 'delete', 'approve', ''].map(jobs.isJobAction),
    ).toEqual([true, true, true, true, false, false, false])
  })
})
