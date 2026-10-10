import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateJobForm } from '@/components/imports/jobs/CreateJobForm'
import { ErrorsDownload } from '@/components/imports/jobs/ErrorsDownload'
import { JobActions } from '@/components/imports/jobs/JobActions'
import { JobDetailView } from '@/components/imports/jobs/JobDetailView'
import { JobPoller } from '@/components/imports/jobs/JobPoller'
import { JobRowsTable } from '@/components/imports/jobs/JobRowsTable'
import { JobUpload } from '@/components/imports/jobs/JobUpload'
import { JobsListView } from '@/components/imports/jobs/JobsListView'
import { ToastProvider } from '@/components/ui/Toast'
import type { ImportJob, JobRow } from '@/lib/import-jobs'

const refresh = vi.fn()
const replace = vi.fn()
const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, replace, push }) }))

const ID = 'IMPJ-0123456789abcdef01234567'
const job = (over: Partial<ImportJob> = {}): ImportJob => ({
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
  ...over,
})
const wrap = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>)
const view = (ui: React.ReactNode) => <ToastProvider>{ui}</ToastProvider>
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status })
const fail = (status: number, body: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error: 'x', ...body }), { status })

beforeEach(() => {
  vi.restoreAllMocks()
  refresh.mockClear()
  replace.mockClear()
  push.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('JobsListView', () => {
  const list = (jobs: ImportJob[]) => ({
    kind: 'ok' as const,
    data: { jobs, next: jobs.at(-1)?.id ?? null },
  })
  it('lists jobs with status badges, links, counts, a status filter and no Older link on the last page', () => {
    render(
      <JobsListView
        result={list([
          job({ status: 'REJECTED', counts: { ...job().counts, invalid: 2, duplicate: 1 } }),
        ])}
        query={{}}
        canWrite={false}
      />,
    )
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('link', { name: ID })).toHaveAttribute(
      'href',
      `/catalogue/imports/jobs/${ID}`,
    )
    expect(
      within(screen.getByRole('table')).getByText('Rejected (rows need fixing)'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('table'))
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toContain('Invalid')
    expect(screen.getByLabelText('Status')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Older' })).toBeNull()
    expect(screen.getByRole('note')).toHaveTextContent(/cms-writer/)
    expect(screen.queryByRole('form', { name: 'Create import job' })).toBeNull()
  })
  it('pages with the extra-item trick: 21 jobs show 20 and link Older from the 20th', () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      job({ id: `IMPJ-${String(100 - i).padStart(24, 'a')}` }),
    )
    wrap(<JobsListView result={list(many)} query={{ status: 'OPEN' }} canWrite />)
    expect(screen.getAllByRole('rowheader')).toHaveLength(20)
    expect(screen.getByRole('link', { name: 'Older' })).toHaveAttribute(
      'href',
      `/catalogue/imports/jobs?status=OPEN&after=${many[19]!.id}`,
    )
    expect(screen.getByRole('form', { name: 'Create import job' })).toBeInTheDocument()
  })
  it('has distinct empty, filtered-empty, forbidden and unavailable states', () => {
    const { rerender } = wrap(<JobsListView result={list([])} query={{}} canWrite />)
    expect(screen.getByText('No import job has been created yet.')).toBeInTheDocument()
    rerender(view(<JobsListView result={list([])} query={{ status: 'PAUSED' }} canWrite />))
    expect(screen.getByText('No job has this status.')).toBeInTheDocument()
    rerender(view(<JobsListView result={{ kind: 'forbidden' }} query={{}} canWrite />))
    expect(screen.getByRole('alert')).toHaveTextContent(/Not permitted/)
    rerender(
      view(<JobsListView result={{ kind: 'unavailable', reason: 'status' }} query={{}} canWrite />),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/unavailable/)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('CreateJobForm', () => {
  it('creates a products job (the only kind) and opens it', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok(job({ rowsTotal: 0 }), 200))
    wrap(<CreateJobForm />)
    expect(screen.getByLabelText(/Kind/)).toBeDisabled()
    await user.type(screen.getByLabelText(/Note/), 'launch catalogue')
    await user.click(screen.getByRole('button', { name: 'Create job' }))
    expect(f.mock.calls[0]![0]).toBe('/api/bff/imports/jobs')
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      kind: 'products',
      note: 'launch catalogue',
    })
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/catalogue/imports/jobs/${ID}`))
  })
  it('explains the too-many-active-jobs conflict and 403 without backend text', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fail(409, { code: 'IMPORT_JOB_STATE' }))
      .mockResolvedValueOnce(fail(403))
    wrap(<CreateJobForm />)
    await user.click(screen.getByRole('button', { name: 'Create job' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/too many jobs are active/)
    await user.click(screen.getByRole('button', { name: 'Create job' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/cms-writer/))
    expect(push).not.toHaveBeenCalled()
  })
  it('a 401 sends the person to sign in', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(401))
    wrap(<CreateJobForm />)
    await user.click(screen.getByRole('button', { name: 'Create job' }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?error=expired'))
  })
})

describe('JobActions', () => {
  it('offers exactly the actions of the status: validate from OPEN, approve from VALIDATED, resume from PAUSED, cancel unless terminal', () => {
    const { rerender } = wrap(<JobActions job={job()} approver="ops@tazzzo.test" />)
    expect(screen.getByRole('button', { name: 'Validate rows' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel job…' })).toBeInTheDocument()
    rerender(
      <ToastProvider>
        <JobActions job={job({ status: 'VALIDATED' })} approver="a" />
      </ToastProvider>,
    )
    expect(screen.getByRole('button', { name: 'Approve and apply…' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Validate/ })).toBeNull()
    rerender(
      <ToastProvider>
        <JobActions job={job({ status: 'PAUSED' })} approver="a" />
      </ToastProvider>,
    )
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
    rerender(
      <ToastProvider>
        <JobActions job={job({ status: 'REJECTED' })} approver="a" />
      </ToastProvider>,
    )
    expect(screen.getByRole('button', { name: 'Validate again' })).toBeInTheDocument()
    rerender(
      <ToastProvider>
        <JobActions job={job({ status: 'COMPLETED' })} approver="a" />
      </ToastProvider>,
    )
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('validate sends the loaded version and nothing else', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok(job({ status: 'VALIDATING', version: 5 })))
    wrap(<JobActions job={job()} approver="a" />)
    await user.click(screen.getByRole('button', { name: 'Validate rows' }))
    expect(f.mock.calls[0]![0]).toBe(`/api/bff/imports/jobs/${ID}/validate`)
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({ version: 4 })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('approve needs an explicit confirmation naming the approver and the numbers; the request carries no approver', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok(job({ status: 'APPLYING', version: 6 })))
    wrap(
      <JobActions
        job={job({
          status: 'VALIDATED',
          version: 5,
          counts: { ...job().counts, valid: 7, unchanged: 2 },
        })}
        approver="ops@tazzzo.test"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Approve and apply…' }))
    const dialog = screen.getByRole('dialog', { name: `Approve and apply ${ID}?`, hidden: true })
    expect(dialog).toHaveTextContent('Approve and apply IMPJ-0123456789abcdef01234567?')
    expect(dialog).toHaveTextContent(/up to 9 products/)
    expect(dialog).toHaveTextContent(/7 new, 2 already identical/)
    expect(dialog).toHaveTextContent('ops@tazzzo.test')
    expect(f).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Approve and apply', hidden: true }))
    expect(f.mock.calls[0]![0]).toBe(`/api/bff/imports/jobs/${ID}/apply`)
    const body = JSON.parse(String(f.mock.calls[0]![1]?.body))
    expect(body).toEqual({ version: 5 })
    expect(JSON.stringify(body)).not.toMatch(/approv/i)
  })

  it('cancel is destructive: it confirms first and focuses Cancel', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok(job({ status: 'CANCELLED' })))
    wrap(<JobActions job={job({ status: 'PAUSED' })} approver="a" />)
    await user.click(screen.getByRole('button', { name: 'Cancel job…' }))
    expect(f).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Cancel job', hidden: true }))
    expect(f.mock.calls[0]![0]).toBe(`/api/bff/imports/jobs/${ID}/cancel`)
  })

  it.each([
    [409, { code: 'IMPORT_JOB_STATE' }, /not in a state that allows this action/],
    [403, {}, /cms-writer/],
    [404, { code: 'IMPORT_JOB_NOT_FOUND' }, /no longer exists/],
    [502, {}, /not retried/],
  ])(
    'a %i answer is explained, never retried, and a 409 reloads the job',
    async (status, body, text) => {
      const user = userEvent.setup()
      const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(status, body))
      wrap(<JobActions job={job()} approver="a" />)
      await user.click(screen.getByRole('button', { name: 'Validate rows' }))
      expect(await screen.findByText(text)).toBeInTheDocument()
      expect(f).toHaveBeenCalledTimes(1)
      if (status === 409) expect(refresh).toHaveBeenCalled()
    },
  )

  it('a 401 goes to sign in', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(401))
    wrap(<JobActions job={job()} approver="a" />)
    await user.click(screen.getByRole('button', { name: 'Validate rows' }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?error=expired'))
  })
})

describe('JobPoller', () => {
  const working = (over: Partial<ImportJob> = {}) =>
    job({ status: 'VALIDATING', rowsTotal: 100, nextRow: 10, version: 5, ...over })
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  it('renders nothing for a status the worker does not own and never calls the backend', async () => {
    vi.useFakeTimers()
    const f = vi.spyOn(globalThis, 'fetch')
    for (const status of [
      'OPEN',
      'VALIDATED',
      'REJECTED',
      'PAUSED',
      'COMPLETED',
      'CANCELLED',
    ] as const) {
      const { container, unmount } = render(<JobPoller job={job({ status })} />)
      expect(container).toBeEmptyDOMElement()
      await advance(120_000)
      unmount()
    }
    expect(f).not.toHaveBeenCalled()
  })

  it('polls no sooner than 3 s, slows down while nothing changes, refreshes the page on change, and stops on the first non-working status', async () => {
    vi.useFakeTimers()
    const answers = [
      working(),
      working(),
      working({ nextRow: 60, version: 6 }),
      job({ status: 'VALIDATED', rowsTotal: 100, nextRow: 100, version: 7 }),
    ]
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        ok(answers.shift() ?? job({ status: 'VALIDATED', version: 7 })),
      )
    render(<JobPoller job={working()} />)
    expect(screen.getByRole('progressbar', { name: 'Validating progress' })).toHaveAttribute(
      'value',
      '10',
    )
    await advance(2_900)
    expect(f).toHaveBeenCalledTimes(0)
    await advance(200)
    expect(f).toHaveBeenCalledTimes(1)
    expect(String(f.mock.calls[0]![0])).toBe(`/api/bff/imports/jobs/${ID}`)
    expect(refresh).not.toHaveBeenCalled() // nothing changed
    await advance(4_300) // grown wait is 4.5 s
    expect(f).toHaveBeenCalledTimes(1)
    await advance(300)
    expect(f).toHaveBeenCalledTimes(2)
    await advance(6_400) // the wait grew again to 6.75 s
    expect(f).toHaveBeenCalledTimes(2)
    await advance(200) // third answer changes the cursor: refresh, wait resets to 3 s
    expect(f).toHaveBeenCalledTimes(3)
    expect(refresh).toHaveBeenCalledTimes(1)
    await advance(3_100)
    expect(f).toHaveBeenCalledTimes(4) // VALIDATED
    expect(refresh).toHaveBeenCalledTimes(2)
    await advance(600_000) // stopped for good
    expect(f).toHaveBeenCalledTimes(4)
  })

  it('shows live progress from the newest answer', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok(working({ nextRow: 75, version: 6 })))
    render(<JobPoller job={working()} />)
    expect(screen.getByRole('status')).toHaveTextContent('row 10 of 100 (10%)')
    await advance(3_100)
    expect(screen.getByRole('status')).toHaveTextContent('row 75 of 100 (75%)')
  })

  it('stops after five failures in a row with a message, and does not poll again', async () => {
    vi.useFakeTimers()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(502))
    render(<JobPoller job={working()} />)
    await advance(10 * 60_000)
    expect(f).toHaveBeenCalledTimes(5)
    expect(screen.getByText(/Live updates stopped after repeated failures/)).toBeInTheDocument()
    await advance(10 * 60_000)
    expect(f).toHaveBeenCalledTimes(5)
  })

  it('a 401 goes to sign in and stops; a 404 stops with a message', async () => {
    vi.useFakeTimers()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fail(401))
    const first = render(<JobPoller job={working()} />)
    await advance(3_100)
    expect(replace).toHaveBeenCalledWith('/login?error=expired')
    await advance(60_000)
    expect(f).toHaveBeenCalledTimes(1)
    first.unmount()
    f.mockResolvedValueOnce(fail(404))
    render(<JobPoller job={working()} />)
    await advance(3_100)
    expect(screen.getByText(/can no longer be read/)).toBeInTheDocument()
    await advance(60_000)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('stops when the page goes away and does not poll while the tab is hidden', async () => {
    vi.useFakeTimers()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok(working()))
    const view = render(<JobPoller job={working()} />)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    await advance(30_000)
    expect(f).not.toHaveBeenCalled()
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
    await advance(10)
    expect(f).toHaveBeenCalledTimes(1)
    view.unmount()
    await advance(60_000)
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('JobUpload', () => {
  const header = 'id,title,brand,vertical,release,gtin'
  const csvRow = (i: number) =>
    `TZP-u-${i},Item ${i},acme,TZV-000001,REL-1,${['4006381333931', '4006381333948', '4006381333955', '4006381333962', '4006381333979'][i % 5]}${i >= 5 ? '' : ''}`
  const file = (text: string, name = 'rows.csv') => new File([text], name, { type: 'text/csv' })
  const choose = async (user: ReturnType<typeof userEvent.setup>, f: File) =>
    user.upload(screen.getByLabelText('CSV file'), f)

  it('refuses a non-CSV file and a file with missing required columns', async () => {
    const user = userEvent.setup({ applyAccept: false })
    wrap(<JobUpload job={job()} />)
    await choose(user, file('x', 'rows.xlsx'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Only .csv files/)
    await choose(user, file('id,title\nTZP-1,A'))
    expect(await screen.findByText(/Map these required fields/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add 0 rows|Add \d+ rows/ })).toBeDisabled()
  })

  it('maps the columns, previews valid and invalid rows, and blocks until the invalid ones are explicitly skipped', async () => {
    const user = userEvent.setup()
    wrap(<JobUpload job={job()} />)
    await choose(
      user,
      file([header, csvRow(0), 'tzp-lower,Bad id,acme,TZV-000001,REL-1,4006381333948'].join('\n')),
    )
    expect(await screen.findByText('1 ready')).toBeInTheDocument()
    expect(screen.getByText('1 with errors')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add 1 rows to the job' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /Skip the 1 rows with errors/ }))
    expect(screen.getByRole('button', { name: 'Add 1 rows to the job' })).toBeEnabled()
  })

  it('uploads in atomic requests with progress, keeps product ids as written, and refreshes when done', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      const n = (JSON.parse(String(init?.body)) as { rows: unknown[] }).rows.length
      return ok({ rowsAdded: n, rowsTotal: n, duplicates: 0 })
    })
    wrap(<JobUpload job={job({ rowsTotal: 0 })} />)
    const rows = Array.from(
      { length: 205 },
      (_, i) => `TZP-Mix-${i},Item ${i},acme,TZV-000001,REL-1,`,
    )
    // internal identity needs a key: use the gtin-less path with an internalKey column
    const text = [
      'id,title,brand,vertical,release,internalKey',
      ...rows.map((r, i) => `${r}key-${i}`),
    ].join('\n')
    await choose(user, file(text))
    await user.click(await screen.findByRole('button', { name: 'Add 205 rows to the job' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(f).toHaveBeenCalledTimes(2) // 200 + 5
    expect(f.mock.calls[0]![0]).toBe(`/api/bff/imports/jobs/${ID}/rows`)
    const first = JSON.parse(String(f.mock.calls[0]![1]?.body)) as { rows: { id: string }[] }
    expect(first.rows).toHaveLength(200)
    expect(first.rows[0]!.id).toBe('TZP-Mix-0')
    expect(screen.getByText(/205 of 205 rows sent \(100%\)/)).toBeInTheDocument()
  })

  it('a failed request stored nothing: the earlier ones are reported, nothing is retried by itself, and Retry resumes at the failed request', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(ok({ rowsAdded: 200, rowsTotal: 200, duplicates: 1 }))
      .mockResolvedValueOnce(fail(409, { code: 'IMPORT_JOB_STATE' }))
      .mockResolvedValueOnce(ok({ rowsAdded: 5, rowsTotal: 205, duplicates: 0 }))
    wrap(<JobUpload job={job({ rowsTotal: 0 })} />)
    const text = [
      'id,title,brand,vertical,release,internalKey',
      ...Array.from({ length: 205 }, (_, i) => `TZP-r-${i},Item,acme,TZV-000001,REL-1,key-${i}`),
    ].join('\n')
    await choose(user, file(text))
    await user.click(await screen.findByRole('button', { name: 'Add 205 rows to the job' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/not in a state that allows this upload/)
    expect(alert).toHaveTextContent(
      /Request 2 of 2 stored nothing; 200 rows from the earlier requests are stored/,
    )
    expect(f).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('button', { name: 'Retry from request 2' }))
    await waitFor(() => expect(f).toHaveBeenCalledTimes(3))
    const retried = JSON.parse(String(f.mock.calls[2]![1]?.body)) as { rows: { id: string }[] }
    expect(retried.rows.map((r) => r.id)).toEqual([
      'TZP-r-200',
      'TZP-r-201',
      'TZP-r-202',
      'TZP-r-203',
      'TZP-r-204',
    ])
  })

  it.each([
    [413, {}, /too large.*Nothing from it was stored/],
    [422, { code: 'INVALID_IMPORT' }, /none of it was stored/],
    [409, { code: 'IMPORT_JOB_STATE' }, /not in a state that allows this upload/],
  ])('a %i on the first request is explained without backend text', async (status, body, text) => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(status, body))
    wrap(<JobUpload job={job()} />)
    await choose(user, file([header, csvRow(0)].join('\n')))
    await user.click(await screen.findByRole('button', { name: 'Add 1 rows to the job' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
  })

  it('a 401 mid-upload goes to sign in', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(401))
    wrap(<JobUpload job={job()} />)
    await choose(user, file([header, csvRow(0)].join('\n')))
    await user.click(await screen.findByRole('button', { name: 'Add 1 rows to the job' }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?error=expired'))
  })
})

describe('JobRowsTable', () => {
  const rows: JobRow[] = [
    {
      row: 0,
      line: 1,
      id: 'TZP-ok-1',
      validation: { outcome: 'VALID', code: null, message: null },
      apply: null,
    },
    {
      row: 1,
      line: 2,
      id: 'tzp-bad',
      validation: { outcome: 'INVALID', code: 'INVALID_ROW', message: 'id must match the grammar' },
      apply: null,
    },
    {
      row: 2,
      line: 3,
      id: 'TZP-dup',
      validation: { outcome: 'DUPLICATE', code: 'DUPLICATE_ROW', message: 'appears earlier' },
      apply: null,
    },
    {
      row: 3,
      line: 4,
      id: 'TZP-f',
      validation: { outcome: 'VALID', code: null, message: null },
      apply: { outcome: 'FAILED', code: 'IDENTITY_COLLISION', message: 'collides' },
    },
    { row: 4, line: 5, id: null, validation: null, apply: null },
  ]
  it('shows verdicts as text with table semantics, and Correct only for negative validation verdicts of a writer on an editable job', () => {
    wrap(<JobRowsTable job={job({ status: 'REJECTED' })} rows={rows} canCorrect />)
    const table = screen.getByRole('table')
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual(['0', '1', '2', '3', '4'])
    expect(screen.getByText('INVALID_ROW')).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.getByText('not checked yet')).toBeInTheDocument()
    expect(
      screen
        .getAllByRole('button', { name: /Correct row/ })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Correct row 1', 'Correct row 2'])
  })
  it('a reader (or a non-editable job) gets the verdicts without any Correct control', () => {
    wrap(<JobRowsTable job={job({ status: 'REJECTED' })} rows={rows} canCorrect={false} />)
    expect(screen.queryByRole('button', { name: /Correct/ })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Fix' })).toBeNull()
  })

  async function open(user: ReturnType<typeof userEvent.setup>) {
    wrap(<JobRowsTable job={job({ status: 'REJECTED' })} rows={rows} canCorrect />)
    await user.click(screen.getByRole('button', { name: 'Correct row 1' }))
    return screen.getByRole('form', { name: 'Correct row 1' })
  }
  const fill = async (
    user: ReturnType<typeof userEvent.setup>,
    form: HTMLElement,
    v: Record<string, string>,
  ) => {
    for (const [label, value] of Object.entries(v)) {
      const input = within(form).getByLabelText(new RegExp(`^${label}`))
      await user.clear(input)
      if (value) await user.type(input, value)
    }
  }

  it('opens a full-row form with the id prefilled, focus on its heading, and the shared id validation (no auto-uppercase)', async () => {
    const user = userEvent.setup()
    const form = await open(user)
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Correct row 1' })).toHaveFocus(),
    )
    expect(within(form).getByLabelText(/^Product id/)).toHaveValue('tzp-bad')
    await fill(user, form, {
      Title: 'Rice',
      'Brand code': 'acme',
      'Internal key': 'k1',
      'Vertical id': 'TZV-000001',
      'Taxonomy release id': 'REL-1',
    })
    const f = vi.spyOn(globalThis, 'fetch')
    await user.click(within(form).getByRole('button', { name: 'Replace row 1' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/id/i)
    expect(f).not.toHaveBeenCalled()
  })

  it('PUTs the corrected row (id exactly as typed) to the numbered row and refreshes', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok(job({ status: 'OPEN', version: 8 })))
    const form = await open(user)
    await fill(user, form, {
      'Product id': 'TZP-Fixed-9',
      Title: 'Rice',
      'Brand code': 'acme',
      'Internal key': 'k1',
      'Vertical id': 'TZV-000001',
      'Taxonomy release id': 'REL-1',
    })
    await user.click(within(form).getByRole('button', { name: 'Replace row 1' }))
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1))
    expect(f.mock.calls[0]![0]).toBe(`/api/bff/imports/jobs/${ID}/rows/1`)
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'PUT' })
    const sent = JSON.parse(String(f.mock.calls[0]![1]?.body)) as {
      product: Record<string, unknown>
    }
    expect(sent.product).toMatchObject({
      id: 'TZP-Fixed-9',
      brandCode: 'ACME',
      identityType: 'internal',
      internalKey: 'k1',
    })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(screen.queryByRole('form', { name: 'Correct row 1' })).toBeNull()
  })

  it('a 409 keeps the form open with an explanation; a 422 says nothing was stored', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fail(409, { code: 'IMPORT_JOB_STATE' }))
      .mockResolvedValueOnce(fail(422, { code: 'INVALID_IMPORT' }))
    const form = await open(user)
    await fill(user, form, {
      'Product id': 'TZP-Fixed-9',
      Title: 'Rice',
      'Brand code': 'acme',
      'Internal key': 'k1',
      'Vertical id': 'TZV-000001',
      'Taxonomy release id': 'REL-1',
    })
    await user.click(within(form).getByRole('button', { name: 'Replace row 1' }))
    expect(
      await screen.findByText(/not in a state that allows this correction/),
    ).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Correct row 1' })).toBeInTheDocument()
    await user.click(
      within(screen.getByRole('form', { name: 'Correct row 1' })).getByRole('button', {
        name: 'Replace row 1',
      }),
    )
    await waitFor(() => expect(screen.getByText(/none of it was stored/)).toBeInTheDocument())
  })
})

describe('ErrorsDownload', () => {
  const csv =
    'row,line,id,phase,outcome,code,message\r\n1,2,tzp-bad,validation,INVALID,INVALID_ROW,"\'=cmd"\r\n'
  let created: Blob[] = []
  beforeEach(() => {
    created = []
    URL.createObjectURL = vi.fn((b: Blob) => (created.push(b), 'blob:x'))
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
  })

  it('downloads through the BFF with the CSRF header and saves the text unchanged', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } }),
      )
    render(
      <ErrorsDownload job={job({ status: 'REJECTED', counts: { ...job().counts, invalid: 1 } })} />,
    )
    await user.click(screen.getByRole('button', { name: 'Download errors.csv' }))
    expect(f.mock.calls[0]![0]).toBe(`/api/bff/imports/jobs/${ID}/errors.csv`)
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'GET', headers: { 'X-Tazzzo-CSRF': '1' } })
    expect(await screen.findByRole('status')).toHaveTextContent('Downloaded 1 error line.')
    expect(await created[0]!.text()).toBe(csv)
  })

  it('warns when the file has fewer lines than the job counts (a truncated export), but not while the job is still working', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } }),
    )
    const view = render(
      <ErrorsDownload job={job({ status: 'REJECTED', counts: { ...job().counts, invalid: 5 } })} />,
    )
    await user.click(screen.getByRole('button', { name: 'Download errors.csv' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      /1 error line but the job counts 5 problem rows/,
    )
    view.unmount()
    render(
      <ErrorsDownload
        job={job({ status: 'VALIDATING', counts: { ...job().counts, invalid: 5 } })}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Download errors.csv' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Downloaded 1 error line.')
  })

  it.each([
    [403, /cannot read this export/],
    [404, /no longer exists/],
    [429, /Too many requests/],
    [502, /could not be produced/],
  ])('a %i is explained and nothing is saved', async (status, text) => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }))
    render(<ErrorsDownload job={job()} />)
    await user.click(screen.getByRole('button', { name: 'Download errors.csv' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(created).toHaveLength(0)
  })

  it('a 401 goes to sign in; a network failure is retryable', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockRejectedValueOnce(new TypeError('offline'))
    render(<ErrorsDownload job={job()} />)
    await user.click(screen.getByRole('button', { name: 'Download errors.csv' }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?error=expired'))
    await user.click(screen.getByRole('button', { name: 'Download errors.csv' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach the CMS/)
  })
})

describe('JobDetailView', () => {
  const rowsOk = (rows: JobRow[], next: number | null = null) => ({
    kind: 'ok' as const,
    data: { rows, next },
  })
  const r = (n: number): JobRow => ({
    row: n,
    line: n + 1,
    id: `TZP-${n}`,
    validation: { outcome: 'VALID', code: null, message: null },
    apply: null,
  })
  const base = { jobId: ID, from: 0, approver: 'ops@tazzzo.test' }
  const show = (props: Partial<React.ComponentProps<typeof JobDetailView>>) =>
    wrap(<JobDetailView {...base} canWrite={false} job={{ kind: 'ok', data: job() }} {...props} />)

  it('a reader sees status, counts, approver and rows, but no action, upload or correction controls', () => {
    show({
      job: {
        kind: 'ok',
        data: job({ status: 'REJECTED', approvedBy: { type: 'HUMAN_ADMIN', id: 'google:9' } }),
      },
      rows: rowsOk([r(0)]),
    })
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByText('google:9 (HUMAN_ADMIN)')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(/cms-writer/)
    expect(screen.queryByRole('button', { name: /Validate|Approve|Resume|Cancel job/ })).toBeNull()
    expect(screen.queryByLabelText('CSV file')).toBeNull()
    expect(screen.queryByRole('button', { name: /Correct/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Download errors.csv' })).toBeInTheDocument()
  })

  it('a writer on an OPEN job gets validate, cancel and the upload', () => {
    show({ canWrite: true, rows: rowsOk([r(0)]) })
    expect(screen.getByRole('button', { name: 'Validate rows' })).toBeInTheDocument()
    expect(screen.getByLabelText('CSV file')).toBeInTheDocument()
  })

  it('a writer on a VALIDATED job gets the approval and no upload', () => {
    show({
      canWrite: true,
      job: { kind: 'ok', data: job({ status: 'VALIDATED' }) },
      rows: rowsOk([r(0)]),
    })
    expect(screen.getByRole('button', { name: 'Approve and apply…' })).toBeInTheDocument()
    expect(screen.queryByLabelText('CSV file')).toBeNull()
  })

  it('pages the rows: 101 rows show 100 and Next starts at the 101st; later pages offer First and Previous', () => {
    const many = Array.from({ length: 101 }, (_, i) => r(i + 200))
    show({ from: 200, job: { kind: 'ok', data: job({ rowsTotal: 400 }) }, rows: rowsOk(many, 301) })
    expect(screen.getAllByRole('rowheader')).toHaveLength(100)
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      `/catalogue/imports/jobs/${ID}?from=300`,
    )
    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
      'href',
      `/catalogue/imports/jobs/${ID}?from=100`,
    )
    expect(screen.getByRole('link', { name: 'First rows' })).toHaveAttribute(
      'href',
      `/catalogue/imports/jobs/${ID}`,
    )
    expect(screen.getByLabelText('Start at row')).toHaveValue('200')
  })

  it('a missing job and a forbidden read are distinct states', () => {
    const missing = show({ job: { kind: 'not_found' } })
    expect(screen.getByRole('alert')).toHaveTextContent(/Import job not found/)
    missing.unmount()
    show({ job: { kind: 'forbidden' } })
    expect(screen.getByRole('alert')).toHaveTextContent(/Not permitted/)
  })

  it('an unavailable row listing and an empty job are distinct states', () => {
    const down = show({ rows: { kind: 'unavailable', reason: 'status' } })
    expect(screen.getByRole('alert')).toHaveTextContent(/Rows unavailable/)
    down.unmount()
    show({ job: { kind: 'ok', data: job({ rowsTotal: 0 }) } })
    expect(screen.getByText('This job has no rows yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download errors.csv' })).toBeNull()
  })

  it('shows the worker note, truncated, as plain text', () => {
    show({
      job: { kind: 'ok', data: job({ status: 'PAUSED', lastError: '<b>x</b>'.padEnd(500, 'y') }) },
      rows: rowsOk([r(0)]),
    })
    const note = screen.getByText(/Worker note/)
    expect(note.textContent!.length).toBeLessThan(230)
    expect(note.querySelector('b')).toBeNull()
  })
})
