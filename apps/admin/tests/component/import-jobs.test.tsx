import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateJobForm } from '@/components/imports/jobs/CreateJobForm'
import { ErrorsDownload } from '@/components/imports/jobs/ErrorsDownload'
import { JobActions } from '@/components/imports/jobs/JobActions'
import { JobDetailView } from '@/components/imports/jobs/JobDetailView'
import { JobPoller } from '@/components/imports/jobs/JobPoller'
import { JobRowsTable } from '@/components/imports/jobs/JobRowsTable'
import { JobUpload, resetUploadGuards } from '@/components/imports/jobs/JobUpload'
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

  it('becoming visible while a poll is in flight starts no second request or timer chain', async () => {
    vi.useFakeTimers()
    let release: (r: Response) => void = () => undefined
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)))
    render(<JobPoller job={working()} />)
    await advance(3_100)
    expect(f).toHaveBeenCalledTimes(1) // in flight
    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))
    await advance(10)
    expect(f).toHaveBeenCalledTimes(1)
    release(ok(working()))
    await advance(3_100)
    await advance(5_000)
    // one chain: two more answers at most in the next seconds, never a doubled cadence
    expect(f.mock.calls.length).toBeLessThanOrEqual(3)
    const calls = f.mock.calls.length
    await advance(60_000)
    expect(f.mock.calls.length - calls).toBeLessThanOrEqual(6)
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

/**
 * A stateful stand-in for the job's rows endpoints: GET returns what the "backend" holds, and each POST consumes the next
 * scripted outcome. 'lost' COMMITS the request and then loses the answer (status 0 = dropped connection, or a 5xx).
 */
function jobBackend(
  stored: { n: number; status?: string },
  script: ('ok' | { fail: number; code?: string } | { lost: number })[],
  posts: number[] = [],
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (!init?.method || init.method === 'GET')
      return ok(
        job({ rowsTotal: stored.n, status: (stored.status ?? 'OPEN') as ImportJob['status'] }),
      )
    const n = (JSON.parse(String(init.body)) as { rows: unknown[] }).rows.length
    posts.push(n)
    const step = script.shift() ?? 'ok'
    if (step === 'ok') {
      stored.n += n
      return ok({ rowsAdded: n, rowsTotal: stored.n, duplicates: 0 })
    }
    if ('lost' in step) {
      stored.n += n // committed
      if (step.lost === 0) throw new TypeError('connection dropped')
      return fail(step.lost)
    }
    return fail(step.fail, step.code ? { code: step.code } : {})
  })
}

const FAST = { pollMs: 0, settleMs: 0, maxWaitMs: 5_000 }

describe('JobUpload', () => {
  beforeEach(() => resetUploadGuards())

  const header = 'id,title,brand,vertical,release,internalKey'
  const line = (i: number) => `TZP-u-${i},Item ${i},acme,TZV-000001,REL-1,k${i}`
  const csvOf = (n: number) => [header, ...Array.from({ length: n }, (_, i) => line(i))].join('\n')
  const file = (text: string, name = 'rows.csv') => new File([text], name, { type: 'text/csv' })
  const choose = async (user: ReturnType<typeof userEvent.setup>, f: File) =>
    user.upload(screen.getByLabelText('CSV file'), f)
  const addButton = (n: number) => screen.findByRole('button', { name: `Add ${n} rows to the job` })

  it('refuses a non-CSV file and a file with missing required columns', async () => {
    const user = userEvent.setup({ applyAccept: false })
    wrap(<JobUpload timingOverride={FAST} job={job()} />)
    await choose(user, file('x', 'rows.xlsx'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Only .csv files/)
    await choose(user, file('id,title\nTZP-1,A'))
    expect(await screen.findByText(/Map these required fields/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add \d+ rows/ })).toBeDisabled()
  })

  it('previews valid and invalid rows and blocks until the invalid ones are explicitly skipped', async () => {
    const user = userEvent.setup()
    wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 0 })} />)
    await choose(
      user,
      file([header, line(0), 'tzp-lower,Bad id,acme,TZV-000001,REL-1,kx'].join('\n')),
    )
    expect(await screen.findByText('1 ready')).toBeInTheDocument()
    expect(screen.getByText('1 with errors')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add 1 rows to the job' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /Skip the 1 rows with errors/ }))
    expect(screen.getByRole('button', { name: 'Add 1 rows to the job' })).toBeEnabled()
  })

  it('uploads in atomic requests with progress, keeps ids as written, and refreshes when done', async () => {
    const user = userEvent.setup()
    const posts: number[] = []
    const stored = { n: 0 }
    const f = jobBackend(stored, [], posts)
    wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 0 })} />)
    await choose(user, file(csvOf(205).replaceAll('TZP-u-', 'TZP-Mix-')))
    await user.click(await addButton(205))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(posts).toEqual([200, 5])
    const first = f.mock.calls.find((c) => c[1]?.method === 'POST')!
    expect(first[0]).toBe(`/api/bff/imports/jobs/${ID}/rows`)
    expect((JSON.parse(String(first[1]?.body)) as { rows: { id: string }[] }).rows[0]!.id).toBe(
      'TZP-Mix-0',
    )
    expect(screen.getByText(/205 of 205 rows sent \(100%\)/)).toBeInTheDocument()
  })

  it('a DEFINITE failure (422) stored nothing: it is said so, and Retry resends only that request after checking the job', async () => {
    const user = userEvent.setup()
    const posts: number[] = []
    const stored = { n: 0 }
    jobBackend(stored, ['ok', { fail: 422, code: 'INVALID_IMPORT' }], posts)
    wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 0 })} />)
    await choose(user, file(csvOf(205)))
    await user.click(await addButton(205))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/none of it was stored/)
    expect(alert).toHaveTextContent(
      /Request 2 of 2 stored nothing; 200 rows from the earlier requests are stored/,
    )
    await user.click(screen.getByRole('button', { name: 'Retry from request 2' }))
    await waitFor(() => expect(posts).toEqual([200, 5, 5]))
    expect(stored.n).toBe(205)
  })

  it.each([
    ['the connection drops', 0],
    ['the BFF times out (504)', 504],
    ['the backend answers 502', 502],
  ])(
    'AMBIGUOUS: %s after the backend COMMITTED the request -> checked, says it landed, never re-sends it',
    async (_n, lost) => {
      const user = userEvent.setup()
      const posts: number[] = []
      const stored = { n: 0 }
      jobBackend(stored, ['ok', { lost }], posts)
      wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 0 })} />)
      await choose(user, file(csvOf(405)))
      await user.click(await addButton(405))
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(/unknown outcome/)
      expect(alert).toHaveTextContent(/it DID land/)
      expect(alert).toHaveTextContent(/do not re-send request 2/)
      expect(alert).not.toHaveTextContent(/stored nothing/)
      expect(stored.n).toBe(400)
      await user.click(screen.getByRole('button', { name: 'Retry from request 3' }))
      await waitFor(() => expect(refresh).toHaveBeenCalled())
      expect(posts).toEqual([200, 200, 5]) // request 2 was NOT sent twice
      expect(stored.n).toBe(405)
    },
  )

  it('AMBIGUOUS failure of the LAST request that had landed completes the upload without a re-send', async () => {
    const user = userEvent.setup()
    const posts: number[] = []
    const stored = { n: 0 }
    jobBackend(stored, [{ lost: 504 }], posts)
    wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 0 })} />)
    await choose(user, file(csvOf(3)))
    await user.click(await addButton(3))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(posts).toEqual([3])
    expect(stored.n).toBe(3)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('AMBIGUOUS failure that did NOT land: unknown outcome is reported, the check says it did not land, and Retry re-checks then sends once', async () => {
    const user = userEvent.setup()
    const posts: number[] = []
    const stored = { n: 0 }
    jobBackend(stored, ['ok', { fail: 502 }], posts)
    wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 0 })} />)
    await choose(user, file(csvOf(205)))
    await user.click(await addButton(205))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      /unknown outcome. The job was watched for 0 s: nothing was published/,
    )
    await user.click(screen.getByRole('button', { name: 'Retry from request 2' }))
    await waitFor(() => expect(posts).toEqual([200, 5, 5]))
    expect(stored.n).toBe(205)
  })

  it('a retry whose late commit landed in the meantime is detected at retry time and skipped', async () => {
    const user = userEvent.setup()
    const posts: number[] = []
    const stored = { n: 0 }
    jobBackend(stored, ['ok', { fail: 504 }], posts)
    wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 0 })} />)
    await choose(user, file(csvOf(205)))
    await user.click(await addButton(205))
    await screen.findByText(/nothing was published/)
    stored.n += 5 // the slow request commits after the check
    await user.click(screen.getByRole('button', { name: 'Retry from request 2' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(posts).toEqual([200, 5])
    expect(stored.n).toBe(205)
  })

  it('if the row count is neither before nor after the request (someone else changed the job), nothing is re-sent', async () => {
    const user = userEvent.setup()
    const posts: number[] = []
    const stored = { n: 0 }
    jobBackend(stored, ['ok', { fail: 504 }], posts)
    wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 0 })} />)
    await choose(user, file(csvOf(205)))
    await user.click(await addButton(205))
    await screen.findByText(/nothing was published/)
    stored.n += 37 // another uploader
    await user.click(screen.getByRole('button', { name: 'Retry from request 2' }))
    const alert = await screen.findByText(/The job holds 237 rows but this upload expected 200/)
    expect(alert).toBeInTheDocument()
    expect(posts).toEqual([200, 5])
  })

  it('a retry is blocked when the job is no longer OPEN', async () => {
    const user = userEvent.setup()
    const posts: number[] = []
    const stored: { n: number; status?: string } = { n: 0 }
    jobBackend(stored, ['ok', { fail: 504 }], posts)
    wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 0 })} />)
    await choose(user, file(csvOf(205)))
    await user.click(await addButton(205))
    await screen.findByText(/nothing was published/)
    stored.status = 'CANCELLED'
    await user.click(screen.getByRole('button', { name: 'Retry from request 2' }))
    expect(await screen.findByText(/The job is now CANCELLED/)).toBeInTheDocument()
    expect(posts).toEqual([200, 5])
  })

  it('an ambiguous failure whose check cannot read the job refuses to re-send', async () => {
    const user = userEvent.setup()
    const posts: number[] = []
    const f = jobBackend({ n: 0 }, ['ok', { fail: 504 }], posts)
    wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 0 })} />)
    await choose(user, file(csvOf(205)))
    await user.click(await addButton(205))
    await screen.findByText(/nothing was published/)
    f.mockImplementation(async () => fail(502))
    await user.click(screen.getByRole('button', { name: 'Retry from request 2' }))
    expect(await screen.findByText(/could not be read to check what it holds/)).toBeInTheDocument()
    expect(posts).toEqual([200, 5])
  })

  it.each([
    [413, {}, /too large.*Nothing from it was stored/],
    [422, { code: 'INVALID_IMPORT' }, /none of it was stored/],
  ])(
    'a %i on the first request is definite and explained without backend text',
    async (status, body, text) => {
      const user = userEvent.setup()
      jobBackend({ n: 0 }, [{ fail: status, code: (body as { code?: string }).code }])
      wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 0 })} />)
      await choose(user, file(csvOf(1)))
      await user.click(await addButton(1))
      expect(await screen.findByRole('alert')).toHaveTextContent(text)
    },
  )

  it('a 401 mid-upload goes to sign in', async () => {
    const user = userEvent.setup()
    jobBackend({ n: 0 }, [{ fail: 401 }])
    wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 0 })} />)
    await choose(user, file(csvOf(1)))
    await user.click(await addButton(1))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?error=expired'))
  })

  it('a job that already holds rows needs an explicit "append"; the same file chosen again is called out and the box is required', async () => {
    const user = userEvent.setup()
    const posts: number[] = []
    jobBackend({ n: 3 }, [], posts)
    wrap(
      <JobUpload
        timingOverride={FAST}
        job={job({ rowsTotal: 3 })}
        firstIds={['TZP-u-0', 'TZP-u-1', 'TZP-u-2']}
      />,
    )
    await choose(user, file(csvOf(3)))
    const add = await addButton(3)
    expect(add).toBeDisabled()
    expect(screen.getByRole('note')).toHaveTextContent(/This job already holds 3 rows/)
    expect(screen.getByRole('note')).toHaveTextContent(
      /3 of this file's first rows have the same product ids/,
    )
    await user.click(screen.getByRole('checkbox', { name: /Append anyway/ }))
    expect(add).toBeEnabled()
    await user.click(add)
    await waitFor(() => expect(posts).toEqual([3]))
  })

  it('a different file on a non-empty job gets the plain confirmation (no overlap claim)', async () => {
    const user = userEvent.setup()
    wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 3 })} firstIds={['TZP-other-1']} />)
    await choose(user, file(csvOf(2)))
    const add = await addButton(2)
    expect(add).toBeDisabled()
    expect(screen.getByRole('note')).not.toHaveTextContent(/same product ids/)
    await user.click(
      screen.getByRole('checkbox', { name: /Append these rows after the existing ones/ }),
    )
    expect(add).toBeEnabled()
  })

  it('does not re-validate the file on every progress tick (the row build is memoised)', async () => {
    const user = userEvent.setup()
    const imports = await import('@/lib/import-jobs')
    const spy = vi.spyOn(imports, 'buildUploadRows')
    jobBackend({ n: 0 }, [])
    wrap(<JobUpload timingOverride={FAST} job={job({ rowsTotal: 0 })} />)
    await choose(user, file(csvOf(450)))
    await user.click(await addButton(450))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(spy.mock.calls.length).toBeGreaterThan(0)
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3)
  })
})

describe('JobUpload: waiting out an unknown outcome', () => {
  // Real (short) timers: poll every 20 ms, quiet for 300 ms means idle, give up after 2 s.
  const T = { pollMs: 20, settleMs: 300, maxWaitMs: 2_000 }
  const header = 'id,title,brand,vertical,release,internalKey'
  const csvOf = (n: number) =>
    [
      header,
      ...Array.from({ length: n }, (_, i) => `TZP-w-${i},Item,acme,TZV-000001,REL-1,k${i}`),
    ].join('\n')
  const slow = { timeout: 4_000 }
  beforeEach(() => resetUploadGuards())

  async function start(script: Parameters<typeof jobBackend>[1], rows = 205) {
    const posts: number[] = []
    const stored = { n: 0 }
    const f = jobBackend(stored, script, posts)
    const user = userEvent.setup()
    wrap(<JobUpload timingOverride={T} job={job({ rowsTotal: 0 })} />)
    await user.upload(
      screen.getByLabelText('CSV file'),
      new File([csvOf(rows)], 'rows.csv', { type: 'text/csv' }),
    )
    await user.click(await screen.findByRole('button', { name: `Add ${rows} rows to the job` }))
    return { user, posts, stored, f }
  }

  it('one read showing the old count is NOT enough: it waits, visibly, and only then offers a send', async () => {
    const { user, posts } = await start(['ok', { fail: 504 }])
    expect(
      await screen.findByText(/Waiting to learn whether request 2 reached the job/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop waiting' })).toBeInTheDocument()
    expect(screen.queryByText(/nothing was published/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry from request 2/ })).toBeNull()
    expect(
      await screen.findByText(/watched for 0 s: nothing was published/, undefined, slow),
    ).toBeInTheDocument()
    expect(posts).toEqual([200, 5])
    await user.click(screen.getByRole('button', { name: 'Retry from request 2' }))
    await waitFor(() => expect(posts).toEqual([200, 5, 5]))
  })

  it('the request finishes while we wait (count reaches expected + size): it landed, and is skipped', async () => {
    const { posts, stored } = await start(['ok', { fail: 504 }], 405)
    await screen.findByText(/Waiting to learn/)
    stored.n += 200 // the zombie publishes
    expect(await screen.findByText(/it DID land/, undefined, slow)).toBeInTheDocument()
    expect(screen.queryByText(/stored nothing/)).toBeNull()
    expect(posts).toEqual([200, 200])
    expect(screen.queryByRole('button', { name: /Retry from request 2/ })).toBeNull()
  })

  it('a 409 on the rows endpoint is never "stored nothing": it enters the wait, and resolves to landed', async () => {
    const { posts, stored } = await start(['ok', { fail: 409, code: 'IMPORT_JOB_STATE' }], 405)
    expect(await screen.findByText(/Waiting to learn whether request 2/)).toBeInTheDocument()
    expect(screen.getByText(/An upload on this job is still running/)).toBeInTheDocument()
    stored.n += 200
    expect(await screen.findByText(/it DID land/, undefined, slow)).toBeInTheDocument()
    expect(screen.queryByText(/stored nothing/)).toBeNull()
    expect(posts).toEqual([200, 200])
  })

  it('if the wait ends idle but the backend lock is still held, the retry gets a 409 and waits again instead of claiming nothing was stored', async () => {
    const { user, posts, stored } = await start(
      ['ok', { fail: 504 }, { fail: 409, code: 'IMPORT_JOB_STATE' }],
      405,
    )
    await user.click(await screen.findByRole('button', { name: 'Retry from request 2' }, slow))
    await waitFor(() => expect(posts).toEqual([200, 200, 200]))
    expect(await screen.findByText(/Waiting to learn whether request 2/)).toBeInTheDocument()
    expect(screen.queryByText(/stored nothing/)).toBeNull()
    stored.n += 200 // the first request finally publishes
    expect(await screen.findByText(/it DID land/, undefined, slow)).toBeInTheDocument()
    expect(posts).toEqual([200, 200, 200]) // never a fourth
  })

  it('after a lock 409 quiet alone never means idle: it waits for an outcome or the maximum, then blocks', async () => {
    const { posts } = await start(['ok', { fail: 409, code: 'IMPORT_JOB_STATE' }], 405)
    // the quiet window (300 ms) passes, but the lock was seen held, so no "nothing was published" verdict and no retry
    expect(
      await screen.findByText(/Still no answer after/, undefined, { timeout: 5_000 }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/nothing was published/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry from request 2' })).toBeDisabled()
    expect(posts).toEqual([200, 200])
  })

  it('an unreadable job never counts as quiet: the wait is bounded and then blocks with no retry', async () => {
    const { f } = await start(['ok', { fail: 504 }])
    await screen.findByText(/Waiting to learn/)
    f.mockImplementation(async () => fail(502))
    expect(
      await screen.findByText(/Still no answer after/, undefined, { timeout: 5_000 }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry from request 2' })).toBeDisabled()
  })

  it('"Stop waiting" ends the wait without sending; a later retry waits again from scratch', async () => {
    const { user, posts } = await start(['ok', { fail: 504 }])
    await user.click(await screen.findByRole('button', { name: 'Stop waiting' }))
    expect(await screen.findByText(/You stopped waiting/)).toBeInTheDocument()
    expect(posts).toEqual([200, 5])
    await user.click(screen.getByRole('button', { name: 'Retry from request 2' }))
    expect(await screen.findByText(/Waiting to learn whether request 2/)).toBeInTheDocument()
    expect(posts).toEqual([200, 5]) // waiting again, nothing sent
  })

  it('a successful request that reports an unexpected row count (someone else appended) stops the upload', async () => {
    const posts: number[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      if (!init?.method || init.method === 'GET') return ok(job({ rowsTotal: 0 }))
      posts.push(1)
      return ok({ rowsAdded: 200, rowsTotal: 777, duplicates: 0 })
    })
    const user = userEvent.setup()
    wrap(<JobUpload timingOverride={T} job={job({ rowsTotal: 0 })} />)
    await user.upload(
      screen.getByLabelText('CSV file'),
      new File([csvOf(405)], 'rows.csv', { type: 'text/csv' }),
    )
    await user.click(await screen.findByRole('button', { name: 'Add 405 rows to the job' }))
    expect(
      await screen.findByText(/job now holds 777 rows but this upload expected 200/),
    ).toBeInTheDocument()
    expect(posts).toHaveLength(1)
    expect(screen.getByRole('button', { name: /Retry from request/ })).toBeDisabled()
  })

  it('leaving the page stops the upload: no further request is sent', async () => {
    const posts: number[] = []
    let release: () => void = () => undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      if (!init?.method || init.method === 'GET') return ok(job({ rowsTotal: 0 }))
      posts.push(1)
      await new Promise<void>((r) => (release = r))
      return ok({ rowsAdded: 200, rowsTotal: 200 * posts.length, duplicates: 0 })
    })
    const user = userEvent.setup()
    const view = wrap(<JobUpload timingOverride={T} job={job({ rowsTotal: 0 })} />)
    await user.upload(
      screen.getByLabelText('CSV file'),
      new File([csvOf(405)], 'rows.csv', { type: 'text/csv' }),
    )
    await user.click(await screen.findByRole('button', { name: 'Add 405 rows to the job' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    view.unmount()
    release()
    await new Promise((r) => setTimeout(r, 200))
    expect(posts).toHaveLength(1) // the loop noticed and stopped before request 2
  })

  it('leaving mid-request that then ends ambiguously leaves the job marked unknown: a returning user must confirm, and the same rows are called out', async () => {
    let fail504: () => void = () => undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      if (!init?.method || init.method === 'GET') return ok(job({ rowsTotal: 0 }))
      await new Promise<void>((r) => (fail504 = r))
      return fail(504)
    })
    const user = userEvent.setup()
    const first = wrap(<JobUpload timingOverride={T} job={job({ rowsTotal: 0 })} />)
    await user.upload(
      screen.getByLabelText('CSV file'),
      new File([csvOf(3)], 'rows.csv', { type: 'text/csv' }),
    )
    await user.click(await screen.findByRole('button', { name: 'Add 3 rows to the job' }))
    await waitFor(() => expect(fail504).not.toBe(undefined))
    first.unmount() // the page is left while the request is in flight
    fail504()
    await new Promise((r) => setTimeout(r, 50))
    // same rows again: explicit confirmation, and the repeated request is named
    wrap(<JobUpload timingOverride={T} job={job({ rowsTotal: 0 })} />)
    await user.upload(
      screen.getByLabelText('CSV file'),
      new File([csvOf(3)], 'rows.csv', { type: 'text/csv' }),
    )
    const add = await screen.findByRole('button', { name: 'Add 3 rows to the job' })
    expect(add).toBeDisabled()
    expect(screen.getByRole('note')).toHaveTextContent(/ended with an UNKNOWN outcome/)
    expect(screen.getByRole('note')).toHaveTextContent(/contains that same request \(same rows\)/)
    await user.click(screen.getByRole('checkbox'))
    expect(add).toBeEnabled()
  })

  it('a different file after an unknown outcome still needs confirmation but is not called the same request', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      if (!init?.method || init.method === 'GET') return ok(job({ rowsTotal: 0 }))
      return fail(504)
    })
    const user = userEvent.setup()
    const first = wrap(
      <JobUpload timingOverride={{ ...T, maxWaitMs: 1_000 }} job={job({ rowsTotal: 0 })} />,
    )
    await user.upload(
      screen.getByLabelText('CSV file'),
      new File([csvOf(3)], 'rows.csv', { type: 'text/csv' }),
    )
    await user.click(await screen.findByRole('button', { name: 'Add 3 rows to the job' }))
    await screen.findByText(/nothing was published/, undefined, slow)
    first.unmount()
    wrap(<JobUpload timingOverride={T} job={job({ rowsTotal: 0 })} />)
    await user.upload(
      screen.getByLabelText('CSV file'),
      new File([csvOf(3).replaceAll('TZP-w-', 'TZP-other-')], 'other.csv', { type: 'text/csv' }),
    )
    expect(await screen.findByRole('button', { name: 'Add 3 rows to the job' })).toBeDisabled()
    expect(screen.getByRole('note')).toHaveTextContent(/UNKNOWN outcome/)
    expect(screen.getByRole('note')).not.toHaveTextContent(/same request/)
  })

  it('announces only the start of the wait (the per-poll counter is not a live region) and moves focus off the removed Stop button', async () => {
    const { user } = await start(['ok', { fail: 504 }])
    const live = await screen.findByText(/Waiting to learn whether request 2 reached the job/)
    expect(live).toHaveAttribute('role', 'status')
    expect(live.textContent).not.toMatch(/\d+ s so far/)
    expect(screen.getByText(/s so far, row count unchanged/)).not.toHaveAttribute('role')
    await user.click(screen.getByRole('button', { name: 'Stop waiting' }))
    const retry = await screen.findByRole('button', { name: 'Retry from request 2' })
    await waitFor(() => expect(retry).toHaveFocus())
  })

  it('a healthy upload (one request or several) never shows the unknown-outcome notice or asks for the append checkbox', async () => {
    for (const rows of [3, 405]) {
      resetUploadGuards()
      let release: () => void = () => undefined
      const stored = { n: 0 }
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
        if (!init?.method || init.method === 'GET') return ok(job({ rowsTotal: stored.n }))
        const n = (JSON.parse(String(init.body)) as { rows: unknown[] }).rows.length
        await new Promise<void>((r) => (release = r)) // held in flight so the in-flight render is observed
        stored.n += n
        return ok({ rowsAdded: n, rowsTotal: stored.n, duplicates: 0 })
      })
      const user = userEvent.setup()
      const view = wrap(<JobUpload timingOverride={T} job={job({ rowsTotal: 0 })} />)
      await user.upload(
        screen.getByLabelText('CSV file'),
        new File([csvOf(rows)], 'rows.csv', { type: 'text/csv' }),
      )
      expect(screen.queryByRole('checkbox')).toBeNull()
      await user.click(await screen.findByRole('button', { name: `Add ${rows} rows to the job` }))
      await waitFor(() => expect(release).not.toBe(undefined))
      for (let k = 0; k < (rows === 3 ? 1 : 3); k++) {
        await waitFor(() => expect(screen.getByText(/rows sent/)).toBeInTheDocument())
        expect(screen.queryByText(/UNKNOWN outcome/)).toBeNull()
        expect(screen.queryByRole('checkbox')).toBeNull()
        release()
        await new Promise((r) => setTimeout(r, 30))
      }
      await waitFor(() => expect(refresh).toHaveBeenCalled())
      expect(screen.queryByText(/UNKNOWN outcome/)).toBeNull()
      expect(screen.queryByRole('checkbox')).toBeNull()
      view.unmount()
      refresh.mockClear()
      vi.restoreAllMocks()
    }
  })

  it('a request left mid-flight that ends with a definite OK leaves no unknown marker behind', async () => {
    let release: () => void = () => undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      if (!init?.method || init.method === 'GET') return ok(job({ rowsTotal: 0 }))
      await new Promise<void>((r) => (release = r))
      return ok({ rowsAdded: 3, rowsTotal: 3, duplicates: 0 })
    })
    const user = userEvent.setup()
    const first = wrap(<JobUpload timingOverride={T} job={job({ rowsTotal: 0 })} />)
    await user.upload(
      screen.getByLabelText('CSV file'),
      new File([csvOf(3)], 'rows.csv', { type: 'text/csv' }),
    )
    await user.click(await screen.findByRole('button', { name: 'Add 3 rows to the job' }))
    await waitFor(() => expect(release).not.toBe(undefined))
    first.unmount()
    release()
    await new Promise((r) => setTimeout(r, 50))
    wrap(<JobUpload timingOverride={T} job={job({ rowsTotal: 3 })} firstIds={[]} />)
    await user.upload(
      screen.getByLabelText('CSV file'),
      new File([csvOf(3).replaceAll('TZP-w-', 'TZP-n-')], 'n.csv', { type: 'text/csv' }),
    )
    await screen.findByRole('button', { name: 'Add 3 rows to the job' })
    expect(screen.queryByText(/UNKNOWN outcome/)).toBeNull() // only the ordinary "job already holds rows" confirmation
  })

  it('a second mount for the same job cannot start a concurrent upload while one is running', async () => {
    let release: () => void = () => undefined
    const posts: number[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      if (!init?.method || init.method === 'GET') return ok(job({ rowsTotal: 0 }))
      posts.push(1)
      await new Promise<void>((r) => (release = r))
      return ok({ rowsAdded: 3, rowsTotal: 3, duplicates: 0 })
    })
    const user = userEvent.setup()
    const first = wrap(<JobUpload timingOverride={T} job={job({ rowsTotal: 0 })} />)
    await user.upload(
      screen.getByLabelText('CSV file'),
      new File([csvOf(3)], 'rows.csv', { type: 'text/csv' }),
    )
    await user.click(await screen.findByRole('button', { name: 'Add 3 rows to the job' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    first.unmount()
    wrap(<JobUpload timingOverride={T} job={job({ rowsTotal: 0 })} />)
    await user.upload(
      screen.getByLabelText('CSV file'),
      new File([csvOf(3)], 'rows.csv', { type: 'text/csv' }),
    )
    await user.click(await screen.findByRole('checkbox')) // the in-flight request marks the job unknown: explicit append
    await user.click(await screen.findByRole('button', { name: /Add 3 rows to the job/ }))
    expect(await screen.findByText(/already running in this tab/)).toBeInTheDocument()
    expect(posts).toHaveLength(1)
    release()
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
