import { randomBytes } from 'node:crypto'

/**
 * Stand-in for two backend surfaces, written from the backend SOURCE (not from the thin OpenAPI document):
 *  - `GET /api/v1/admin/inventory` (`InventoryAdminListController.listStock`): closed query grammar, keyset cursor, derived
 *    stock state, and the "short or empty page may still carry a cursor" paging contract;
 *  - `/api/v1/admin/imports/jobs/**` (`ImportJobController`): the job state machine, version compare-and-swap in the BODY
 *    (409 IMPORT_JOB_STATE, never 412), approvedBy taken from the token, atomic per-request row appends, per-row verdicts,
 *    `next` pointers that always point on, and a streamed errors.csv with formula cells neutralised.
 *
 * Differences from the real backend are listed in the PR report (docs/ENGINEERING_STATUS.md, "C1"). The worker is NOT a
 * timer: a test advances it with `POST /__control/jobs/tick`, so state changes are deterministic.
 */
const PRODUCT_ID = /^TZP-[A-Za-z0-9-]{1,40}$/
const LOCATION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const JOB_STATUSES = [
  'OPEN',
  'VALIDATING',
  'VALIDATED',
  'REJECTED',
  'APPLYING',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
]
const BODY_LIMIT = 2 * 1024 * 1024

export interface Reply {
  status: number
  body?: unknown
  text?: string
  headers?: Record<string, string>
}

export interface Ctx {
  method: string
  pathname: string
  params: URLSearchParams
  body: string
  byteLength: number
  roles: string[]
  sub?: string
}

const err = (status: number, code: string, message: string): Reply => ({
  status,
  body: { error: { code, message, request_id: `req_${randomBytes(10).toString('hex')}` } },
})
const forbidden = (): Reply => ({ status: 403, body: { error: { code: 'FORBIDDEN' } } })

/* ------------------------------------------------------------------ stock list */

export interface StockRecord {
  onHand: number
  reserved: number
  lowStockThreshold: number
  maxPurchasable: number
  version: number
  active: boolean
}

const stateOf = (r: StockRecord) =>
  !r.active
    ? 'INACTIVE'
    : r.onHand - r.reserved <= 0
      ? 'OUT_OF_STOCK'
      : r.onHand - r.reserved <= r.lowStockThreshold
        ? 'LOW_STOCK'
        : 'IN_STOCK'

const encodeCursor = (sku: string, loc: string) =>
  Buffer.from(`${sku.length}:${sku}${loc}`, 'utf8').toString('base64url')
function decodeCursor(cursor: string): [string, string] | undefined {
  try {
    if (cursor.length > 1400 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const colon = raw.indexOf(':')
    const n = Number(raw.slice(0, colon))
    if (!Number.isInteger(n) || colon < 1) return undefined
    const sku = raw.slice(colon + 1, colon + 1 + n)
    const loc = raw.slice(colon + 1 + n)
    return sku && loc ? [sku, loc] : undefined
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ jobs */

interface RowDoc {
  row: number
  line: number
  payload: Record<string, unknown>
  validation?: { outcome: string; code: string | null; message: string | null }
  apply?: { outcome: string; code: string | null; message: string | null }
}
interface JobDoc {
  id: string
  kind: 'products'
  status: string
  note: string | null
  createdBy: { type: string; id: string }
  approvedBy: { type: string; id: string } | null
  rowsTotal: number
  nextRow: number
  counts: Counts
  attemptCount: number
  lastError: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  version: number
}
interface Counts {
  valid: number
  unchanged: number
  invalid: number
  duplicate: number
  applied: number
  failed: number
  not_attempted: number
}
const ZERO: Counts = {
  valid: 0,
  unchanged: 0,
  invalid: 0,
  duplicate: 0,
  applied: 0,
  failed: 0,
  not_attempted: 0,
}

export interface Forced {
  /** `GET /api/v1/admin/inventory` style: METHOD + space + path prefix. */
  match: string
  status: number
  code?: string
  count?: number
  /** Let this many matching requests through first, then force the next `count`. */
  skip?: number
  delayMs?: number
}

export class FakeAdminLists {
  readonly jobs = new Map<string, JobDoc>()
  readonly rows = new Map<string, RowDoc[]>()
  /** Stock rows that break the record invariants: they occupy cursor positions but are never listed. */
  readonly corrupt: { sku: string; loc: string }[] = []
  forced: Forced[] = []
  maxRowsPerJob = 250_000
  maxActiveJobs = 10
  /** Test hooks: applied products are added here so the product pages see them. */
  products?: Map<string, { id: string; title: string; version: number; lifecycle: string }>
  private seq = 0
  private clock = Date.parse('2026-10-09T10:00:00Z')

  constructor(private readonly stock: Map<string, StockRecord>) {}

  reset(): void {
    this.jobs.clear()
    this.rows.clear()
    this.corrupt.length = 0
    this.forced = []
    this.maxRowsPerJob = 250_000
    this.maxActiveJobs = 10
    this.seq = 0
  }

  private now(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }

  /* ----------------------------- dispatch */

  async handle(ctx: Ctx): Promise<Reply | undefined> {
    const isList = ctx.pathname === '/api/v1/admin/inventory'
    const isJobs = ctx.pathname.startsWith('/api/v1/admin/imports/jobs')
    if (!isList && !isJobs) return undefined
    const forced = this.forced.find(
      (f) =>
        `${ctx.method} ${ctx.pathname}`.startsWith(f.match) &&
        (f.count === undefined || f.count > 0),
    )
    if (forced?.skip) {
      forced.skip -= 1
    } else if (forced) {
      if (forced.count !== undefined) forced.count -= 1
      if (forced.delayMs) await new Promise((r) => setTimeout(r, forced.delayMs))
      return forced.status === 204
        ? { status: 204 }
        : err(forced.status, forced.code ?? 'FORCED', 'internal detail: stack trace at Foo.java:42')
    }
    if (isList) return ctx.method === 'GET' ? this.listStock(ctx) : undefined
    return this.jobsRoute(ctx)
  }

  /* ----------------------------- stock list */

  private listStock(ctx: Ctx): Reply {
    const bad = (m: string) => err(422, 'INVALID_INVENTORY', m)
    const seen = new Set<string>()
    let location: string | undefined
    let state: string | undefined
    let cursor: string | undefined
    let limit = 50
    for (const name of new Set(ctx.params.keys())) {
      if (!['location', 'state', 'limit', 'cursor'].includes(name))
        return bad('unsupported query parameter')
      const all = ctx.params.getAll(name)
      if (all.length !== 1 || all[0] === '' || seen.has(name))
        return bad(`query parameter ${name} must appear exactly once and not be empty`)
      seen.add(name)
      const v = all[0]!
      if (name === 'location') location = v
      else if (name === 'state') {
        if (!['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'INACTIVE'].includes(v))
          return bad('state must be one of IN_STOCK, LOW_STOCK, OUT_OF_STOCK, INACTIVE')
        state = v
      } else if (name === 'limit') {
        if (!/^[1-9][0-9]{0,2}$/.test(v) || Number(v) > 200)
          return bad('limit must be between 1 and 200')
        limit = Number(v)
      } else cursor = v
    }
    if (location && !LOCATION.test(location)) return bad('invalid location')
    const after = cursor ? decodeCursor(cursor) : undefined
    if (cursor && !after) return bad('invalid cursor')
    type Item = { sku: string; loc: string; rec?: StockRecord }
    const everything: Item[] = [
      ...[...this.stock].map(([key, rec]): Item => {
        const [sku, loc] = key.split('|') as [string, string]
        return { sku, loc, rec }
      }),
      ...this.corrupt.map((c): Item => ({ sku: c.sku, loc: c.loc })),
    ]
    const items = everything
      .filter((i) => !location || i.loc === location)
      .filter((i) => !state || (i.rec && stateOf(i.rec) === state))
      .filter((i) => !after || i.sku > after[0] || (i.sku === after[0] && i.loc > after[1]))
      .sort((a, b) => (a.sku === b.sku ? (a.loc < b.loc ? -1 : 1) : a.sku < b.sku ? -1 : 1))
    const window = items.slice(0, limit + 1)
    const more = window.length > limit
    const page = more ? window.slice(0, limit) : window
    const last = page[page.length - 1]
    return {
      status: 200,
      body: {
        items: page.flatMap((i) =>
          i.rec
            ? [
                {
                  skuId: i.sku,
                  fulfillmentLocationId: i.loc,
                  onHand: i.rec.onHand,
                  reserved: i.rec.reserved,
                  available: i.rec.onHand - i.rec.reserved,
                  lowStockThreshold: i.rec.lowStockThreshold,
                  maxPurchasable: i.rec.maxPurchasable,
                  version: i.rec.version,
                  active: i.rec.active,
                  stockState: stateOf(i.rec),
                },
              ]
            : [],
        ),
        nextCursor: more && last ? encodeCursor(last.sku, last.loc) : null,
      },
    }
  }

  /* ----------------------------- jobs */

  private view(job: JobDoc): JobDoc {
    return { ...job, counts: { ...job.counts } }
  }
  private bump(job: JobDoc): void {
    job.version += 1
    job.updatedAt = this.now()
  }
  private find(id: string): JobDoc | undefined {
    return id.startsWith('IMPJ-') ? this.jobs.get(id) : undefined
  }
  private notFound = (id: string): Reply => err(404, 'IMPORT_JOB_NOT_FOUND', `no import job ${id}`)
  private stateConflict = (rule: string, job: JobDoc): Reply =>
    err(409, 'IMPORT_JOB_STATE', `${rule} (the job is ${job.status}, version ${job.version})`)

  private jobsRoute(ctx: Ctx): Reply | undefined {
    const base = '/api/v1/admin/imports/jobs'
    const rest = ctx.pathname.slice(base.length)
    const write = ctx.method !== 'GET'
    if (write && !ctx.roles.includes('cms-writer')) return forbidden()
    if (write && ctx.byteLength > BODY_LIMIT)
      return err(413, 'PAYLOAD_TOO_LARGE', 'request body is too large')
    const json = (): Record<string, unknown> | undefined => {
      try {
        const v = ctx.body ? (JSON.parse(ctx.body) as unknown) : {}
        return v !== null && typeof v === 'object' && !Array.isArray(v)
          ? (v as Record<string, unknown>)
          : undefined
      } catch {
        return undefined
      }
    }
    const actor = { type: 'HUMAN_ADMIN', id: `google:${ctx.sub ?? 'unknown'}` }

    if (rest === '') {
      if (ctx.method === 'POST') {
        const b = json()
        if (!b) return err(400, 'MALFORMED_REQUEST', 'request body is malformed or unreadable')
        if (String(b.kind).toUpperCase() !== 'PRODUCTS')
          return err(422, 'INVALID_IMPORT', 'kind must be one of [PRODUCTS]')
        if (typeof b.note === 'string' && b.note.length > 500)
          return err(422, 'INVALID_IMPORT', 'note must be at most 500 characters')
        const active = [...this.jobs.values()].filter(
          (j) => !['COMPLETED', 'CANCELLED'].includes(j.status),
        ).length
        if (active >= this.maxActiveJobs)
          return err(
            409,
            'IMPORT_JOB_STATE',
            `too many active import jobs (max ${this.maxActiveJobs}); cancel or complete one first`,
          )
        const ts = this.now()
        this.seq += 1
        const id = `IMPJ-${Math.floor(this.clock / 1000)
          .toString(16)
          .padStart(
            8,
            '0',
          )}${randomBytes(4).toString('hex')}${this.seq.toString(16).padStart(8, '0')}`
        const job: JobDoc = {
          id,
          kind: 'products',
          status: 'OPEN',
          note: typeof b.note === 'string' ? b.note : null,
          createdBy: actor,
          approvedBy: null,
          rowsTotal: 0,
          nextRow: 0,
          counts: { ...ZERO },
          attemptCount: 0,
          lastError: null,
          createdAt: ts,
          updatedAt: ts,
          startedAt: null,
          finishedAt: null,
          version: 1,
        }
        this.jobs.set(id, job)
        this.rows.set(id, [])
        return { status: 201, body: this.view(job) }
      }
      if (ctx.method === 'GET') {
        const status = ctx.params.get('status')
        if (status && !JOB_STATUSES.includes(status.toUpperCase()))
          return err(422, 'INVALID_IMPORT', `status must be one of ${JSON.stringify(JOB_STATUSES)}`)
        const after = ctx.params.get('after')
        const limit = Math.max(1, Math.min(Number(ctx.params.get('limit') ?? '50'), 200))
        const list = [...this.jobs.values()]
          .filter((j) => !status || j.status === status.toUpperCase())
          .filter((j) => !after || j.id < after)
          .sort((a, b) => (a.id < b.id ? 1 : -1))
          .slice(0, limit)
          .map((j) => this.view(j))
        return {
          status: 200,
          body: { jobs: list, next: list.length ? list[list.length - 1]!.id : null },
        }
      }
      return undefined
    }

    const m = rest.match(/^\/([^/]+)(\/.*)?$/)
    if (!m) return undefined
    const id = decodeURIComponent(m[1]!)
    const tail = m[2] ?? ''
    const job = this.find(id)

    if (tail === '' && ctx.method === 'GET')
      return job ? { status: 200, body: this.view(job) } : this.notFound(id)
    if (!job) return this.notFound(id)
    const rows = this.rows.get(id) ?? []

    if (tail === '/rows' && ctx.method === 'GET') {
      const from = Math.max(0, Number(ctx.params.get('from') ?? '0'))
      const limit = Math.max(1, Math.min(Number(ctx.params.get('limit') ?? '100'), 500))
      const page = rows.filter((r) => r.row >= from && r.row < job.rowsTotal).slice(0, limit)
      return {
        status: 200,
        body: {
          rows: page.map((r) => ({
            row: r.row,
            line: r.line,
            id: typeof r.payload.id === 'string' ? r.payload.id : null,
            validation: r.validation ?? null,
            apply: r.apply ?? null,
          })),
          next: page.length ? page[page.length - 1]!.row + 1 : null,
        },
      }
    }

    if (tail === '/errors.csv' && ctx.method === 'GET') {
      const cell = (s: string | null | undefined) => {
        let v = s ?? ''
        if (v && '=+-@\t\r'.includes(v[0]!)) v = `'${v}`
        return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v
      }
      const bad = ['INVALID', 'DUPLICATE', 'FAILED']
      const lines = rows
        .filter((r) => r.row < job.rowsTotal)
        .filter(
          (r) => bad.includes(r.validation?.outcome ?? '') || bad.includes(r.apply?.outcome ?? ''),
        )
        .map((r) => {
          const fromApply = bad.includes(r.apply?.outcome ?? '')
          const o = fromApply ? r.apply! : r.validation!
          return [
            String(r.row),
            String(r.line),
            cell(typeof r.payload.id === 'string' ? r.payload.id : ''),
            fromApply ? 'apply' : 'validation',
            cell(o.outcome),
            cell(o.code),
            cell(o.message),
          ].join(',')
        })
      return {
        status: 200,
        text: ['row,line,id,phase,outcome,code,message', ...lines].join('\r\n') + '\r\n',
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${id}-errors.csv"`,
        },
      }
    }

    if (ctx.method === 'POST' && tail === '/rows') {
      if (job.status !== 'OPEN')
        return err(
          409,
          'IMPORT_JOB_STATE',
          `rows can be added only while the job is OPEN (it is ${job.status})`,
        )
      const b = json()
      if (!b) return err(400, 'MALFORMED_REQUEST', 'request body is malformed or unreadable')
      const incoming = b.rows
      if (!Array.isArray(incoming) || incoming.length === 0)
        return err(422, 'INVALID_IMPORT', 'rows must contain at least one entry')
      if (job.rowsTotal + incoming.length > this.maxRowsPerJob)
        return err(422, 'INVALID_IMPORT', `a job holds at most ${this.maxRowsPerJob} rows`)
      // Atomic: nothing is stored unless every row of the request is.
      const staged: RowDoc[] = []
      let duplicates = 0
      const ids = new Set(
        rows.filter((r) => r.row < job.rowsTotal).map((r) => String(r.payload.id ?? '')),
      )
      const keys = new Set(
        rows.filter((r) => r.row < job.rowsTotal).flatMap((r) => identityKeys(r.payload)),
      )
      for (const [i, raw] of incoming.entries()) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
          return err(400, 'MALFORMED_REQUEST', 'request body is malformed or unreadable')
        const payload = raw as Record<string, unknown>
        const doc: RowDoc = { row: job.rowsTotal + i, line: i + 1, payload }
        const pid = String(payload.id ?? '').trim()
        const idKeys = identityKeys(payload)
        if (pid && ids.has(pid)) {
          doc.validation = {
            outcome: 'DUPLICATE',
            code: 'DUPLICATE_ROW',
            message: `product id ${pid} appears earlier in this job`,
          }
          duplicates += 1
        } else if (idKeys.some((k) => keys.has(k))) {
          doc.validation = {
            outcome: 'DUPLICATE',
            code: 'DUPLICATE_IDENTITY',
            message: 'a GTIN or internal key of this row belongs to an earlier row of this job',
          }
          duplicates += 1
        } else {
          if (pid) ids.add(pid)
          for (const k of idKeys) keys.add(k)
        }
        staged.push(doc)
      }
      rows.splice(job.rowsTotal, rows.length, ...staged)
      job.rowsTotal += staged.length
      this.bump(job)
      return {
        status: 200,
        body: { rowsAdded: staged.length, rowsTotal: job.rowsTotal, duplicates },
      }
    }

    const put = tail.match(/^\/rows\/(\d+)$/)
    if (ctx.method === 'PUT' && put) {
      if (job.status !== 'OPEN' && job.status !== 'REJECTED')
        return err(
          409,
          'IMPORT_JOB_STATE',
          `rows can be corrected only while the job is OPEN or REJECTED (it is ${job.status})`,
        )
      const n = Number(put[1])
      if (n >= job.rowsTotal)
        return err(422, 'INVALID_IMPORT', `row must be 0..${job.rowsTotal - 1}`)
      const b = json()
      if (!b) return err(400, 'MALFORMED_REQUEST', 'request body is malformed or unreadable')
      const pid = String(b.id ?? '').trim()
      if (
        pid &&
        rows.some(
          (r) =>
            r.row !== n &&
            r.row < job.rowsTotal &&
            String(r.payload.id ?? '').trim() === pid &&
            !r.validation?.outcome.startsWith('DUPLICATE'),
        )
      )
        return err(
          422,
          'INVALID_IMPORT',
          'the product id, a GTIN or the internal key of this row already belongs to another row of this job',
        )
      if (job.status === 'REJECTED') {
        job.status = 'OPEN'
        job.nextRow = 0
        this.bump(job)
      }
      const doc = rows[n]!
      doc.payload = b
      delete doc.validation
      delete doc.apply
      this.bump(job)
      return { status: 200, body: this.view(job) }
    }

    if (ctx.method === 'POST' && /^\/(validate|apply|resume|cancel)$/.test(tail)) {
      const action = tail.slice(1)
      const b = json()
      if (!b) return err(400, 'MALFORMED_REQUEST', 'request body is malformed or unreadable')
      const expected = typeof b.version === 'number' ? b.version : job.version
      const fromOk: Record<string, string[]> = {
        validate: ['OPEN', 'REJECTED'],
        apply: ['VALIDATED'],
        resume: ['PAUSED'],
        cancel: JOB_STATUSES.filter((s) => s !== 'COMPLETED' && s !== 'CANCELLED'),
      }
      if (action === 'validate' && job.rowsTotal === 0)
        return err(422, 'INVALID_IMPORT', 'the job has no rows')
      if (expected !== job.version || !fromOk[action]!.includes(job.status)) {
        const rule: Record<string, string> = {
          validate: 'validation can start only from OPEN or REJECTED, with no upload in progress',
          apply: 'only a VALIDATED job can be applied',
          resume: 'only a PAUSED job can be resumed',
          cancel: `the job is already ${job.status}`,
        }
        return this.stateConflict(rule[action]!, job)
      }
      if (action === 'validate') {
        job.status = 'VALIDATING'
        job.nextRow = 0
        job.counts = { ...ZERO }
      } else if (action === 'apply') {
        job.status = 'APPLYING'
        job.approvedBy = actor // the approver is the caller, never a field of the request
        job.startedAt = this.now()
      } else if (action === 'resume') job.status = 'APPLYING'
      else {
        job.status = 'CANCELLED'
        job.finishedAt = this.now()
      }
      this.bump(job)
      return { status: 200, body: this.view(job) }
    }
    return undefined
  }

  /* ----------------------------- worker (driven by tests) */

  /** Advances one job (or every working job): `step` limits how many rows are processed; `pause` pauses an apply midway. */
  tick(opts: { id?: string; step?: number; pause?: boolean } = {}): void {
    for (const job of this.jobs.values()) {
      if (opts.id && job.id !== opts.id) continue
      const rows = (this.rows.get(job.id) ?? []).filter((r) => r.row < job.rowsTotal)
      if (job.status === 'VALIDATING') {
        const end = Math.min(rows.length, job.nextRow + (opts.step ?? rows.length))
        for (const r of rows.slice(job.nextRow, end)) {
          if (r.validation?.outcome === 'DUPLICATE') continue
          const pid = String(r.payload.id ?? '')
          if (!PRODUCT_ID.test(pid)) {
            r.validation = {
              outcome: 'INVALID',
              code: 'INVALID_ROW',
              message: 'id must match ^TZP-[A-Za-z0-9-]{1,40}$',
            }
          } else if (this.products?.has(pid))
            r.validation = { outcome: 'UNCHANGED', code: null, message: null }
          else r.validation = { outcome: 'VALID', code: null, message: null }
        }
        job.nextRow = end
        if (end >= rows.length) {
          const tally = (o: string) => rows.filter((r) => r.validation?.outcome === o).length
          job.counts = {
            ...ZERO,
            valid: tally('VALID'),
            unchanged: tally('UNCHANGED'),
            invalid: tally('INVALID'),
            duplicate: tally('DUPLICATE'),
          }
          job.status = job.counts.invalid + job.counts.duplicate > 0 ? 'REJECTED' : 'VALIDATED'
        }
        this.bump(job)
      } else if (job.status === 'APPLYING') {
        const candidates = rows.filter((r) =>
          ['VALID', 'UNCHANGED'].includes(r.validation?.outcome ?? ''),
        )
        let done = 0
        for (const r of candidates) {
          if (r.apply?.outcome === 'APPLIED' || r.apply?.outcome === 'UNCHANGED') continue
          if (opts.step !== undefined && done >= opts.step) break
          if (opts.pause && done >= Math.floor(candidates.length / 2)) {
            r.apply = {
              outcome: 'NOT_ATTEMPTED',
              code: 'UNAVAILABLE',
              message: 'the datastore failed; the job paused here',
            }
            job.status = 'PAUSED'
            job.nextRow = r.row
            job.lastError = 'datastore unavailable'
            job.counts.not_attempted = candidates.filter(
              (c) => !c.apply || c.apply.outcome === 'NOT_ATTEMPTED',
            ).length
            this.bump(job)
            break
          }
          if (r.validation?.outcome === 'UNCHANGED')
            r.apply = { outcome: 'UNCHANGED', code: null, message: null }
          else {
            r.apply = { outcome: 'APPLIED', code: null, message: null }
            job.counts.applied += 1
            const pid = String(r.payload.id)
            this.products?.set(pid, {
              id: pid,
              title: String(r.payload.title ?? pid),
              version: 1,
              lifecycle: 'draft',
            })
          }
          job.nextRow = r.row + 1
          done += 1
        }
        if (job.status === 'APPLYING') {
          const finished = candidates.every((r) => r.apply && r.apply.outcome !== 'NOT_ATTEMPTED')
          if (finished) {
            job.status = 'COMPLETED'
            job.nextRow = job.rowsTotal
            job.finishedAt = this.now()
            job.lastError = null
            job.counts.not_attempted = 0
          }
          this.bump(job)
        }
      }
    }
  }

  /** Seeds a job directly in a given state (for list/pagination/role tests). */
  seed(spec: { status: string; rows?: number; note?: string; invalidRows?: number[] }): JobDoc {
    const ts = this.now()
    this.seq += 1
    const id = `IMPJ-${Math.floor(this.clock / 1000)
      .toString(16)
      .padStart(8, '0')}${randomBytes(4).toString('hex')}${this.seq.toString(16).padStart(8, '0')}`
    const n = spec.rows ?? 3
    const docs: RowDoc[] = Array.from({ length: n }, (_, i) => ({
      row: i,
      line: i + 1,
      payload: {
        id: spec.invalidRows?.includes(i) ? `tzp_bad_${i}` : `TZP-SEED-${i}`,
        title: `Seed ${i}`,
      },
    }))
    const job: JobDoc = {
      id,
      kind: 'products',
      status: 'OPEN',
      note: spec.note ?? null,
      createdBy: { type: 'HUMAN_ADMIN', id: 'google:seed' },
      approvedBy: null,
      rowsTotal: n,
      nextRow: 0,
      counts: { ...ZERO },
      attemptCount: 0,
      lastError: null,
      createdAt: ts,
      updatedAt: ts,
      startedAt: null,
      finishedAt: null,
      version: 1,
    }
    this.jobs.set(id, job)
    this.rows.set(id, docs)
    // Walk the state machine with the same code as the API so verdicts and counters are consistent.
    const target = spec.status
    if (target === 'OPEN') return job
    job.status = 'VALIDATING'
    this.tick({ id })
    if (target === 'VALIDATING') {
      job.status = 'VALIDATING'
      job.nextRow = 0
      job.counts = { ...ZERO }
      return job
    }
    if (target === 'VALIDATED' || target === 'REJECTED') return job
    if (job.status !== 'VALIDATED') return job
    job.status = 'APPLYING'
    job.approvedBy = { type: 'HUMAN_ADMIN', id: 'google:seed' }
    if (target === 'APPLYING') return job
    this.tick({ id, pause: target === 'PAUSED' })
    if (target === 'CANCELLED') {
      job.status = 'CANCELLED'
      job.finishedAt = this.now()
    }
    return job
  }
}

function identityKeys(payload: Record<string, unknown>): string[] {
  const keys: string[] = []
  const gtins = payload.gtins
  if (Array.isArray(gtins))
    for (const g of gtins) {
      const v = (g as { value?: unknown } | null)?.value
      if (typeof v === 'string' && v.trim()) keys.push(`gtin:${v.trim()}`)
    }
  if (
    payload.identityType === 'internal' &&
    typeof payload.internalKey === 'string' &&
    payload.internalKey.trim()
  )
    keys.push(`key:${payload.internalKey.trim()}`)
  return keys
}
