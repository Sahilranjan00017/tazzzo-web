import { describe, expect, it } from 'vitest'
import {
  CHUNK_MAX_BYTES,
  CHUNK_MAX_ROWS,
  JOB_FILE_LIMITS,
  JOB_ID,
  JOBS_PAGE_SIZE,
  POLL_MAX_MS,
  POLL_START_MS,
  ROWS_PAGE_SIZE,
  STATUS_LABEL,
  buildCorrection,
  buildUploadRows,
  chunkRows,
  countCsvRecords,
  effectiveVerdict,
  isCorrectable,
  isDefiniteFailure,
  uploadTiming,
  isTerminal,
  isWorking,
  jobActions,
  jobErrorMessage,
  jobListPath,
  jobListSchema,
  jobPath,
  jobRowsPath,
  nextPollDelay,
  negativeRowCount,
  pageOf,
  parseJobListQuery,
  parseRowsFrom,
  prepareUpload,
  progressPercent,
  rowsPageSchema,
  JOB_STATUSES,
} from '@/lib/import-jobs'

const ID = 'IMPJ-0123456789abcdef01234567'
const job = {
  id: ID,
  kind: 'products',
  status: 'OPEN',
  note: null,
  createdBy: { type: 'HUMAN_ADMIN', id: 'google:1' },
  approvedBy: null,
  rowsTotal: 3,
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
  version: 4,
}

describe('job contract shapes', () => {
  it('parses the real list and rows answers (next always points on)', () => {
    expect(jobListSchema.parse({ jobs: [job], next: ID }).jobs[0]!.counts.not_attempted).toBe(0)
    expect(jobListSchema.parse({ jobs: [], next: null }).jobs).toEqual([])
    const rows = rowsPageSchema.parse({
      rows: [
        {
          row: 0,
          line: 1,
          id: 'TZP-1',
          validation: { outcome: 'VALID', code: null, message: null },
          apply: null,
        },
        {
          row: 1,
          line: 2,
          id: null,
          validation: { outcome: 'INVALID', code: 'INVALID_ROW', message: 'x' },
          apply: null,
        },
      ],
      next: 2,
    })
    expect(rows.rows).toHaveLength(2)
  })
  it('refuses a job whose id is not the backend grammar', () => {
    expect(JOB_ID.test(ID)).toBe(true)
    for (const bad of [
      'IMPJ-xyz',
      'imp-0123456789abcdef01234567',
      `${ID}0`,
      `${ID}\n`,
      'IMPJ-0123456789ABCDEF01234567',
    ])
      expect(JOB_ID.test(bad), bad).toBe(false)
    expect(() => jobPath('../../etc')).toThrow()
    expect(() => jobRowsPath('IMPJ-1', 0)).toThrow()
  })
})

describe('state machine', () => {
  const can = (status: string, rows = 3) => jobActions(status, rows)
  it('allows exactly what the backend allows from each status', () => {
    expect(can('OPEN')).toEqual({
      append: true,
      correct: true,
      validate: true,
      apply: false,
      resume: false,
      cancel: true,
    })
    expect(can('OPEN', 0).validate).toBe(false)
    expect(can('REJECTED')).toMatchObject({
      append: false,
      correct: true,
      validate: true,
      apply: false,
      cancel: true,
    })
    expect(can('VALIDATING')).toMatchObject({
      validate: false,
      apply: false,
      correct: false,
      cancel: true,
    })
    expect(can('VALIDATED')).toMatchObject({
      apply: true,
      validate: false,
      correct: false,
      cancel: true,
    })
    expect(can('APPLYING')).toMatchObject({ apply: false, resume: false, cancel: true })
    expect(can('PAUSED')).toMatchObject({ resume: true, apply: false, cancel: true })
    for (const s of ['COMPLETED', 'CANCELLED'])
      expect(can(s), s).toEqual({
        append: false,
        correct: false,
        validate: false,
        apply: false,
        resume: false,
        cancel: false,
      })
  })
  it('only the worker-owned states are working, only completed/cancelled are terminal', () => {
    expect(JOB_STATUSES.filter(isWorking)).toEqual(['VALIDATING', 'APPLYING'])
    expect(JOB_STATUSES.filter(isTerminal)).toEqual(['COMPLETED', 'CANCELLED'])
    for (const s of JOB_STATUSES) expect(STATUS_LABEL[s]).toBeTruthy()
  })
})

describe('lists and paging', () => {
  it('drops invalid filters and cursors', () => {
    expect(parseJobListQuery({ status: 'REJECTED', after: ID })).toEqual({
      status: 'REJECTED',
      after: ID,
    })
    expect(parseJobListQuery({ status: 'rejected', after: 'nope' })).toEqual({})
  })
  it('asks for one extra item so the last page is recognised (the backend next never ends)', () => {
    expect(jobListPath({ status: 'OPEN', after: ID })).toBe(
      `/api/v1/admin/imports/jobs?status=OPEN&after=${ID}&limit=${JOBS_PAGE_SIZE + 1}`,
    )
    expect(jobRowsPath(ID, 200)).toBe(
      `/api/v1/admin/imports/jobs/${ID}/rows?from=200&limit=${ROWS_PAGE_SIZE + 1}`,
    )
    expect(pageOf([1, 2, 3], 2)).toEqual({ items: [1, 2], more: true })
    expect(pageOf([1, 2], 2)).toEqual({ items: [1, 2], more: false })
    expect(parseRowsFrom({ from: '250' })).toBe(250)
    for (const bad of ['-1', 'abc', '1.5', '9999999999999'])
      expect(parseRowsFrom({ from: bad })).toBe(0)
  })
})

describe('row verdicts', () => {
  it('a negative apply verdict is the later one; otherwise the latest phase present', () => {
    const base = { row: 0, line: 1, id: 'TZP-1' }
    expect(
      effectiveVerdict({
        ...base,
        validation: { outcome: 'VALID' },
        apply: { outcome: 'FAILED', code: 'IDENTITY_COLLISION', message: 'm' },
      }),
    ).toEqual({
      phase: 'apply',
      outcome: 'FAILED',
      code: 'IDENTITY_COLLISION',
      message: 'm',
    })
    expect(
      effectiveVerdict({
        ...base,
        validation: { outcome: 'INVALID', code: 'INVALID_ROW' },
        apply: null,
      }),
    ).toMatchObject({ phase: 'validation', outcome: 'INVALID' })
    expect(effectiveVerdict({ ...base, validation: null, apply: null })).toBeUndefined()
    expect(
      effectiveVerdict({ ...base, validation: { outcome: 'INVALID', message: 'x'.repeat(1000) } })!
        .message,
    ).toHaveLength(300)
  })
  it('only a row with a negative validation verdict is offered for correction', () => {
    expect(isCorrectable({ row: 0, validation: { outcome: 'INVALID' } })).toBe(true)
    expect(isCorrectable({ row: 0, validation: { outcome: 'DUPLICATE' } })).toBe(true)
    expect(isCorrectable({ row: 0, validation: { outcome: 'VALID' } })).toBe(false)
    expect(isCorrectable({ row: 0, validation: null })).toBe(false)
  })
  it('counts the rows errors.csv should list', () => {
    expect(
      negativeRowCount({
        counts: { ...job.counts, invalid: 2, duplicate: 1, failed: 4, applied: 9 },
      }),
    ).toBe(7)
  })
})

const CSV = (rows: string[]) => ['id,title,brand,vertical,release,gtin', ...rows].join('\n')

describe('upload preparation', () => {
  it('reads a CSV with the wizard aliases and keeps product ids exactly as written (no upper-casing)', () => {
    const prep = prepareUpload(
      CSV([
        'TZP-med-3,Rice,acme,TZV-000001,REL-1,4006381333931',
        'TZP-MED-3,Dal,acme,TZV-000001,REL-1,4006381333931',
      ]),
    )
    expect(prep.ok).toBe(true)
    if (!prep.ok) return
    const { sendable, invalid } = buildUploadRows(prep.rows, prep.map)
    expect(sendable.map((b) => b.value.id)).toEqual(['TZP-med-3'])
    // same GTIN on the second row: caught client-side, the id difference alone is not a duplicate
    expect(invalid[0]!.errors.join(' ')).toMatch(/GTIN/)
    expect(sendable[0]!.value.brandCode).toBe('ACME')
  })
  it('rejects ids outside the canonical grammar and does not auto-fix them', () => {
    const prep = prepareUpload(
      CSV([
        'tzp-1,A,b,TZV-000001,REL-1,4006381333931',
        'TZP-a_b,A,b,TZV-000001,REL-1,4006381333948',
        'TZP-,A,b,TZV-000001,REL-1,4006381333955',
        `TZP-${'a'.repeat(41)},A,b,TZV-000001,REL-1,4006381333962`,
        'TZP-ok-1,A,b,TZV-000001,REL-1,4006381333979',
      ]),
    )
    if (!prep.ok) throw new Error(prep.reason)
    const { sendable, invalid } = buildUploadRows(prep.rows, prep.map)
    expect(sendable.map((b) => b.value.id)).toEqual(['TZP-ok-1'])
    expect(invalid).toHaveLength(4)
  })
  it('reports missing required columns and bounds the file', () => {
    const prep = prepareUpload('id,title\nTZP-1,A')
    if (!prep.ok) throw new Error(prep.reason)
    expect(buildUploadRows(prep.rows, prep.map).missing.length).toBeGreaterThan(0)
    expect(prepareUpload('')).toMatchObject({ ok: false })
    expect(prepareUpload(`id\n${'1\n'.repeat(JOB_FILE_LIMITS.maxRows + 1)}`)).toMatchObject({
      ok: false,
    })
    expect(prepareUpload('x'.repeat(JOB_FILE_LIMITS.maxChars + 1))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/20 MiB/),
    })
  })
})

describe('chunking', () => {
  it('splits by row count and by bytes without ever splitting a row', () => {
    const rows = Array.from({ length: CHUNK_MAX_ROWS * 2 + 5 }, (_, i) => ({ id: `TZP-${i}` }))
    const chunks = chunkRows(rows)
    expect(chunks.map((c) => c.length)).toEqual([CHUNK_MAX_ROWS, CHUNK_MAX_ROWS, 5])
    expect(chunks.flat()).toEqual(rows)

    const big = Array.from({ length: 5 }, (_, i) => ({ id: `TZP-${i}`, blob: 'x'.repeat(400_000) }))
    const byBytes = chunkRows(big)
    expect(byBytes.every((c) => JSON.stringify(c).length <= CHUNK_MAX_BYTES + 1)).toBe(true)
    expect(byBytes.flat()).toEqual(big)
    expect(chunkRows([])).toEqual([])
    // one oversized row still travels alone rather than being dropped
    expect(chunkRows([{ blob: 'y'.repeat(CHUNK_MAX_BYTES * 2) }])).toHaveLength(1)
  })
})

describe('row correction', () => {
  const full = {
    id: 'TZP-fix-1',
    title: 'Fixed',
    brandCode: 'acme',
    gtin: '4006381333931',
    market: 'in',
    internalKey: '',
    verticalId: 'TZV-000001',
    releaseId: 'REL-1',
    classificationStatus: 'provisional',
  }
  it('replaces the whole row with the shared validation; the id keeps its case', () => {
    const r = buildCorrection(full)
    expect(r).toMatchObject({
      ok: true,
      value: { id: 'TZP-fix-1', brandCode: 'ACME', identityType: 'gtin' },
    })
  })
  it('refuses a bad id, a missing field or a bad GTIN with readable messages', () => {
    for (const patch of [
      { id: 'tzp-fix-1' },
      { id: 'TZP-a b' },
      { title: '' },
      { gtin: '4006381333932' },
    ]) {
      const r = buildCorrection({ ...full, ...patch })
      expect(r.ok, JSON.stringify(patch)).toBe(false)
    }
  })
})

describe('failure wording never carries backend text', () => {
  const fail = (status: number, code?: string) => ({
    ok: false as const,
    status,
    error: 'x',
    ...(code ? { code } : {}),
  })
  it('explains each status class in operator language', () => {
    expect(jobErrorMessage(fail(409, 'IMPORT_JOB_STATE'), 'upload')).toMatch(
      /not in a state that allows this upload/,
    )
    expect(jobErrorMessage(fail(413), 'upload')).toMatch(/too large.*Nothing from it was stored/)
    expect(jobErrorMessage(fail(422, 'INVALID_IMPORT'), 'upload')).toMatch(/none of it was stored/)
    expect(jobErrorMessage(fail(404, 'IMPORT_JOB_NOT_FOUND'))).toMatch(/no longer exists/)
    expect(jobErrorMessage(fail(403))).toMatch(/cms-writer/)
    expect(jobErrorMessage(fail(502), 'approval')).toMatch(/not retried/)
    expect(jobErrorMessage(fail(0))).toMatch(/Could not reach/)
    for (const m of [fail(409, 'IMPORT_JOB_STATE'), fail(422, 'INVALID_IMPORT'), fail(502)])
      expect(jobErrorMessage(m)).not.toMatch(/Foo\.java|stack|Exception|mongo/i)
  })
})

describe('polling schedule', () => {
  it('never goes below the start interval, grows slowly, caps, and backs off on failure', () => {
    expect(POLL_START_MS).toBeGreaterThanOrEqual(2000)
    let d = POLL_START_MS
    const seen = [d]
    for (let i = 0; i < 20; i++) seen.push((d = nextPollDelay(d, false)))
    expect(Math.min(...seen)).toBe(POLL_START_MS)
    expect(Math.max(...seen)).toBe(POLL_MAX_MS)
    expect(nextPollDelay(POLL_START_MS, true)).toBe(POLL_START_MS * 2)
    expect(nextPollDelay(POLL_MAX_MS, true)).toBe(POLL_MAX_MS * 2)
    expect(nextPollDelay(POLL_MAX_MS * 2, true)).toBe(POLL_MAX_MS * 2)
  })
  it('progress is the cursor over the stored rows, clamped', () => {
    expect(progressPercent({ nextRow: 50, rowsTotal: 200 })).toBe(25)
    expect(progressPercent({ nextRow: 5, rowsTotal: 0 })).toBe(0)
    expect(progressPercent({ nextRow: 500, rowsTotal: 200 })).toBe(100)
  })
})

describe('countCsvRecords', () => {
  it('counts quote-aware records, with or without a trailing newline', () => {
    expect(countCsvRecords('a,b\r\n1,2\r\n')).toBe(2)
    expect(countCsvRecords('a,b\n1,"x\ny"\n2,3')).toBe(3)
    expect(countCsvRecords('a\n"he said ""hi"""\n')).toBe(2)
    expect(countCsvRecords('')).toBe(0)
    expect(countCsvRecords('row,line\r\n')).toBe(1)
  })
})

describe('request sizing and failure classes', () => {
  it('chunk size counts UTF-8 bytes, not UTF-16 units', () => {
    const wide = Array.from({ length: 3 }, (_, i) => ({ id: `TZP-${i}`, t: '€'.repeat(300_000) }))
    // 300k UTF-16 units each (< 1 MB together would be 900k) but 900 KB of UTF-8 each: no two fit one request
    expect(chunkRows(wide).map((c) => c.length)).toEqual([1, 1, 1])
    expect(JSON.stringify(wide[0]).length).toBeLessThan(CHUNK_MAX_BYTES)
  })
  it('only a 4xx refusal proves a request stored nothing; network, 5xx and timeouts are ambiguous', () => {
    for (const s of [400, 403, 404, 413, 415, 422, 429])
      expect(isDefiniteFailure({ status: s }), String(s)).toBe(true)
    // 409 is NOT definite on the rows endpoint: IMPORT_JOB_STATE also means "another upload holds the append lock"
    for (const s of [0, 409, 500, 502, 503, 504, 418, 302])
      expect(isDefiniteFailure({ status: s }), String(s)).toBe(false)
  })
})

describe('upload wait timing', () => {
  it('defaults to the long, conservative windows; test overrides must be whole milliseconds in range', () => {
    const keys = ['POLL_MS', 'SETTLE_MS', 'MAXWAIT_MS'].map((k) => `NEXT_PUBLIC_IMPORT_UPLOAD_${k}`)
    const saved = keys.map((k) => process.env[k])
    try {
      for (const k of keys) delete process.env[k]
      expect(uploadTiming()).toEqual({ pollMs: 5_000, settleMs: 90_000, maxWaitMs: 16 * 60_000 })
      process.env[keys[0]!] = '1000'
      process.env[keys[1]!] = '6000'
      process.env[keys[2]!] = '25000'
      expect(uploadTiming()).toEqual({ pollMs: 1_000, settleMs: 6_000, maxWaitMs: 25_000 })
      process.env[keys[0]!] = 'abc'
      process.env[keys[1]!] = '-5'
      process.env[keys[2]!] = '999999999999'
      expect(uploadTiming()).toEqual({ pollMs: 5_000, settleMs: 90_000, maxWaitMs: 16 * 60_000 })
      // the 60 s BFF timeout must be inside the default quiet window
      expect(uploadTiming().settleMs).toBeGreaterThan(60_000)
    } finally {
      keys.forEach((k, i) =>
        saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i]),
      )
    }
  })
})
