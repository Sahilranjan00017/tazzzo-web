'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { StatusBadge } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/Toast'
import { callBff, getBff } from '@/lib/bff-client'
import { FIELDS } from '@/lib/imports'
import {
  JOB_FILE_LIMITS,
  chunkFingerprint,
  appendedSchema,
  buildUploadRows,
  chunkRows,
  isDefiniteFailure,
  uploadTiming,
  type UploadTiming,
  jobErrorMessage,
  jobSchema,
  prepareUpload,
  type ImportJob,
} from '@/lib/import-jobs'

type Prepared = {
  /** Rows the job already held when this file was chosen (a second file, or a re-upload of the same one). */
  existing: number
  fileName: string
  header: string[]
  rows: string[][]
  map: Record<string, number>
}
type Progress = { sent: number; total: number; added: number; duplicates: number }

/**
 * Adds rows to an OPEN job from a CSV file. The file is read in the browser with the same parser, column aliases and row
 * validation as the quick import wizard, then sent in requests of at most 200 rows / about 1 MB (the backend and BFF bound a
 * request at 2 MiB). Each request is atomic on the backend: it stores all of its rows or none. The whole file is not, so when a
 * request fails the earlier ones stay in the job. A 4xx failure proves the request stored nothing; any other failure (network,
 * 5xx, timeout) has an UNKNOWN outcome, so the job is re-read and its row count compared with what this upload has sent
 * before anything is re-sent (the backend does not de-duplicate a repeated request). Nothing is retried automatically.
 */
/** Uploads running in this tab, by job: a remounted component can never start a second concurrent upload for the same job. */
const running_ = new Set<string>()
/** Jobs of this tab whose last upload ended with an unknown outcome (survives navigation within the app, not a reload). */
/**
 * Per job: fingerprints of requests whose outcome this tab does not know ("the same rows again" can then be called out), and
 * whether one of them is later KNOWN to have published its rows (a request left mid-flight that answered 2xx afterwards).
 */
interface Marker {
  fps: Set<string>
  published: boolean
}
const unresolved_ = new Map<string, Marker>()
function markUnknown(jobId: string, fp: string | undefined) {
  if (!fp) return
  const m = unresolved_.get(jobId) ?? { fps: new Set<string>(), published: false }
  m.fps.add(fp)
  unresolved_.set(jobId, m)
}
function markPublished(jobId: string, fp: string | undefined) {
  markUnknown(jobId, fp)
  const m = unresolved_.get(jobId)
  if (m) m.published = true
}
/** A definite answer for THIS request only: other unknown requests of the job keep their marker. */
function clearRequest(jobId: string, fp: string | undefined) {
  const m = unresolved_.get(jobId)
  if (!m || !fp) return
  m.fps.delete(fp)
  if (m.fps.size === 0 && !m.published) unresolved_.delete(jobId)
}
/** Test seam: the two guards above are module state, so tests start each case from a clean slate. */
export function resetUploadGuards() {
  running_.clear()
  unresolved_.clear()
}

export function JobUpload({
  job,
  firstIds,
  timingOverride,
}: {
  job: ImportJob
  firstIds?: readonly string[]
  timingOverride?: UploadTiming
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [prepared, setPrepared] = useState<Prepared>()
  const [skipInvalid, setSkipInvalid] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress>()
  const [resumeAt, setResumeAt] = useState<number>()
  const [locked, setLocked] = useState(false)
  const [waiting, setWaiting] = useState<{ request: number; elapsed: number; unchanged: number }>()
  /** The outcome of the last failed request is not known yet: a retry must first WAIT (not just look once). */
  const needSettle = useRef(false)
  const alive = useRef(true)
  const refocus = useRef(false)
  /** Fingerprint of the request currently in flight in this mounted run (cleared when its answer arrives). */
  const inflightFp = useRef<string>(undefined)
  const retryButton = useRef<HTMLButtonElement>(null)
  const timing = useMemo(() => timingOverride ?? uploadTiming(), [timingOverride])
  const [appendAnyway, setAppendAnyway] = useState(false)
  /** Rows the job held before the first request of THIS upload: every later check is arithmetic on it. */
  const base = useRef(0)
  const stop = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)

  // Validated once per file and column choice, not on every progress tick.
  const built = useMemo(
    () => (prepared ? buildUploadRows(prepared.rows, prepared.map) : undefined),
    [prepared],
  )
  // A job that already holds rows (a second file, or the same file chosen again after a reload) needs an explicit "append".
  const overlap = useMemo(() => {
    if (!prepared || prepared.existing === 0 || !built || !firstIds) return 0
    const known = new Set(firstIds)
    return built.sendable.slice(0, 50).filter((b) => known.has(String(b.value.id))).length
  }, [prepared, built, firstIds])
  // An earlier upload of this tab ended (or was left) with an unknown outcome: do these rows repeat one of its requests?
  const marker = unresolved_.get(job.id)
  const sameAsUnknown = useMemo(() => {
    if (!marker || !built) return false
    return chunkRows(built.sendable.map((b) => b.value)).some((c) =>
      marker.fps.has(chunkFingerprint(c)),
    )
  }, [marker, built])
  const needsConfirm =
    prepared !== undefined &&
    (prepared.existing > 0 || unresolved_.has(job.id)) &&
    resumeAt === undefined &&
    !running
  const blocked =
    !built ||
    built.missing.length > 0 ||
    built.sendable.length === 0 ||
    (built.invalid.length > 0 && !skipInvalid) ||
    (needsConfirm && !appendAnyway)

  async function onFile(file: File | undefined) {
    setProblem(undefined)
    setProgress(undefined)
    setResumeAt(undefined)
    setLocked(false)
    needSettle.current = false
    setAppendAnyway(false)
    if (!file) return setPrepared(undefined)
    if (!/\.csv$/i.test(file.name))
      return setProblem('Only .csv files are supported. Export your spreadsheet as CSV (UTF-8).')
    if (file.size > JOB_FILE_LIMITS.maxChars)
      return setProblem(
        `The file is larger than ${JOB_FILE_LIMITS.maxChars / (1024 * 1024)} MiB. Split it and add the parts one after another.`,
      )
    const prep = prepareUpload(await file.text())
    if (!prep.ok) return setProblem(prep.reason)
    setPrepared({
      existing: job.rowsTotal,
      fileName: file.name,
      header: prep.header,
      rows: prep.rows,
      map: prep.map,
    })
  }

  // A file chosen before hydration finished is on the input but unknown to React state: pick it up once.
  useEffect(() => {
    const f = fileInput.current?.files?.[0]
    if (f) void onFile(f)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When "Stop waiting" removes the focused button, focus moves to the retry control (or the file input), never to <body>.
  useEffect(() => {
    if (waiting || !refocus.current) return
    refocus.current = false
    ;(retryButton.current ?? fileInput.current)?.focus()
  }, [waiting])

  // Leaving the page stops the upload loop at its next step; nothing keeps sending in the background.
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      stop.current = true
      markUnknown(job.id, inflightFp.current) // left mid-request
    }
  }, [job.id])

  /** Fresh, uncached read of the job: how many rows does the backend really hold, and can it still take rows? */
  async function readJob() {
    const r = await getBff<unknown>(`/api/bff/imports/jobs/${encodeURIComponent(job.id)}`)
    if (!r.ok) return { unauthenticated: r.status === 401 } as const
    const parsed = jobSchema.safeParse(r.data)
    return parsed.success ? ({ job: parsed.data } as const) : ({} as const)
  }

  const sleep = async (ms: number) => {
    // short slices so "Stop waiting" and leaving the page are noticed quickly
    for (let left = ms; left > 0 && !stop.current; left -= 250)
      await new Promise((r) => setTimeout(r, Math.min(250, left)))
  }

  /**
   * One look: what does the backend hold, compared with what this upload has sent?
   *   rows == expected                 -> nothing published (NOT proof that nothing is running: see settle)
   *   rows == expected + request size  -> the request landed
   *   anything else                    -> someone else changed the job
   */
  async function reconcile(
    chunks: readonly (readonly unknown[])[],
    i: number,
  ): Promise<'send' | 'landed' | { stop: string } | 'login'> {
    const read = await readJob()
    if ('unauthenticated' in read && read.unauthenticated) return 'login'
    if (!read.job)
      return {
        stop: 'The job could not be read to check what it holds, so nothing more is sent. Use Refresh, check the stored row count, then continue.',
      }
    if (read.job.status !== 'OPEN')
      return { stop: `The job is now ${read.job.status}, so it no longer accepts rows.` }
    const before = chunks.slice(0, i).reduce((n, c) => n + c.length, 0)
    const expected = base.current + before
    const stored = read.job.rowsTotal
    if (stored === expected) return 'send'
    if (stored === expected + chunks[i]!.length) return 'landed'
    return {
      stop: `The job holds ${stored} rows but this upload expected ${expected} (or ${expected + chunks[i]!.length} if request ${i + 1} had landed). Someone else may have changed the job, so nothing more is sent from here. Check the job's rows, and cancel the job if they are not what you expect.`,
    }
  }

  /**
   * After an AMBIGUOUS failure (network, 5xx, timeout, or an "upload in progress" 409) the request may still be RUNNING on the
   * backend: it holds the append lock and publishes its rows (the job's row count) only when it finishes. One read that shows
   * the old count therefore proves nothing. So: re-read the job every few seconds until it is provably resolved:
   *   - the count reached expected + size  -> it landed (skip it)
   *   - the count stayed at expected for the whole stability window (default 90 s, longer than the BFF's 60 s timeout) -> idle,
   *     except after a lock 409 (the lock was just seen held): then only an outcome or the maximum wait ends the wait
   *   - anything else (other count, not OPEN) or the maximum wait (default 16 min, the lock lifetime) -> blocked
   * The wait is visible, and "Stop waiting" or leaving the page ends it (a later retry waits again).
   */
  async function settle(
    chunks: readonly (readonly unknown[])[],
    i: number,
    lockHeld = false,
  ): Promise<'landed' | 'idle' | 'login' | { stop: string; blocked: boolean }> {
    const started = Date.now()
    let lastChange = started
    let last: number | undefined
    for (;;) {
      if (stop.current)
        return {
          stop: 'You stopped waiting. The outcome of the last request is still unknown; retrying waits again before anything is sent.',
          blocked: false,
        }
      const read = await readJob()
      const now = Date.now()
      if ('unauthenticated' in read && read.unauthenticated) return 'login'
      if (read.job) {
        if (read.job.status !== 'OPEN')
          return {
            stop: `The job is now ${read.job.status}, so it no longer accepts rows.`,
            blocked: true,
          }
        const before = chunks.slice(0, i).reduce((n, c) => n + c.length, 0)
        const expected = base.current + before
        const stored = read.job.rowsTotal
        if (stored === expected + chunks[i]!.length) return 'landed'
        if (stored !== expected)
          return {
            stop: `The job holds ${stored} rows but this upload expected ${expected} (or ${expected + chunks[i]!.length} if request ${i + 1} had landed). Someone else may have changed the job, so nothing more is sent from here. Check the job's rows, and cancel the job if they are not what you expect.`,
            blocked: true,
          }
        if (last !== undefined && stored !== last) lastChange = now
        last = stored
        // A 409 proves the append lock was held a moment ago: quiet alone no longer proves it is free, only an outcome does.
        if (!lockHeld && now - lastChange >= timing.settleMs) return 'idle'
      } else lastChange = now // an unreadable job proves nothing: the quiet period starts over
      if (now - started >= timing.maxWaitMs)
        return {
          stop: `Still no answer after ${timing.maxWaitMs >= 120_000 ? `${Math.round(timing.maxWaitMs / 60_000)} minutes` : `${Math.round(timing.maxWaitMs / 1000)} seconds`}. Check the job's rows and cancel the job if they look wrong; nothing more is sent from here.`,
          blocked: true,
        }
      if (alive.current)
        setWaiting({ request: i, elapsed: now - started, unchanged: now - lastChange })
      await sleep(timing.pollMs)
    }
  }

  async function upload(from = 0, resuming = false) {
    if (!built) return
    if (running_.has(job.id)) {
      return setProblem('An upload for this job is already running in this tab.')
    }
    running_.add(job.id)
    try {
      await runUpload(from, resuming, built)
    } finally {
      running_.delete(job.id)
      if (alive.current) setWaiting(undefined)
    }
  }

  async function runUpload(
    from: number,
    resuming: boolean,
    built: ReturnType<typeof buildUploadRows>,
  ) {
    const chunks = chunkRows(built.sendable.map((b) => b.value))
    stop.current = false
    setProblem(undefined)
    setRunning(true)
    const total = built.sendable.length
    const done = { added: progress?.added ?? 0, duplicates: progress?.duplicates ?? 0 }
    if (!resuming) {
      done.added = 0
      done.duplicates = 0
      const start = await readJob()
      if ('unauthenticated' in start && start.unauthenticated) {
        router.replace('/login?error=expired')
        router.refresh()
        return
      }
      if (!start.job || start.job.status !== 'OPEN') {
        setRunning(false)
        return setProblem(
          'The job could not be read, or no longer accepts rows. Refresh and try again.',
        )
      }
      if (prepared && start.job.rowsTotal !== prepared.existing) {
        // The job changed since this file was chosen (an earlier request left mid-flight published, or another tab added
        // rows): the confirmation the person gave was for a different state. Ask again, with the real count.
        setPrepared({ ...prepared, existing: start.job.rowsTotal })
        setAppendAnyway(false)
        setRunning(false)
        return setProblem(
          `The job now holds ${start.job.rowsTotal} rows (it held ${prepared.existing} when you chose this file). Nothing was sent. Review the note below and confirm to add.`,
        )
      }
      base.current = start.job.rowsTotal
    }
    let sent = chunks.slice(0, from).reduce((n, c) => n + c.length, 0)
    setProgress({ sent, total, ...done })
    const halt = (
      message: string,
      at: number,
      opts: { refresh?: boolean; lock?: boolean } = {},
    ) => {
      if (!alive.current) return
      setResumeAt(at)
      setRunning(false)
      setLocked(opts.lock ?? false)
      if (opts.refresh ?? true) router.refresh()
      setProblem(message)
    }
    const login = () => {
      setRunning(false)
      router.replace('/login?error=expired')
      router.refresh()
    }
    /** The request just failed or is being resumed with an unknown outcome: wait it out, then act on the answer. */
    const resolveUnknown = async (i: number, head: string, lockHeld = false) => {
      needSettle.current = true
      const verdict = await settle(chunks, i, lockHeld)
      if (verdict === 'login') return (login(), 'end' as const)
      if (!alive.current) return 'end' as const
      if (typeof verdict === 'object') {
        if (verdict.blocked) needSettle.current = true
        halt(`${head}${verdict.stop}`, i, { lock: verdict.blocked })
        return 'end' as const
      }
      needSettle.current = false
      if (verdict === 'landed') {
        unresolved_.delete(job.id)
        return 'landed' as const
      }
      return 'idle' as const
    }
    const sentBefore = (i: number) => chunks.slice(0, i).reduce((n, c) => n + c.length, 0)
    for (let i = from; i < chunks.length; i++) {
      if (stop.current)
        return halt(
          `Stopped before request ${i + 1} of ${chunks.length}. ${done.added} rows are stored in the job; continue to add the rest.`,
          i,
          { refresh: false },
        )
      const landed = () => {
        done.added += chunks[i]!.length
        sent += chunks[i]!.length
        setProgress({ sent, total, ...done })
      }
      if (resuming && i === from) {
        // a retry or continue: the answer to "did it land?" comes from the backend, never from the screen
        if (needSettle.current) {
          const r = await resolveUnknown(i, `Request ${i + 1} of ${chunks.length}: `)
          if (r === 'end') return
          if (r === 'landed') {
            landed()
            continue
          }
        } else {
          const verdict = await reconcile(chunks, i)
          if (verdict === 'login') return login()
          if (typeof verdict === 'object') return halt(verdict.stop, i, { lock: true })
          if (verdict === 'landed') {
            landed()
            continue
          }
        }
      }
      // In flight in THIS mounted run: not an unknown outcome yet. If the page is left now, the cleanup effect converts it
      // into one, so a returning user cannot treat a later publish of these rows as anything but unknown.
      inflightFp.current = chunkFingerprint(
        built.sendable.slice(sentBefore(i), sentBefore(i) + chunks[i]!.length).map((b) => b.value),
      )
      const result = await callBff<unknown>(
        `/api/bff/imports/jobs/${encodeURIComponent(job.id)}/rows`,
        'POST',
        { rows: chunks[i] },
      )
      const fp = inflightFp.current
      inflightFp.current = undefined
      if (!alive.current) {
        // The page was left while the request ran. A 2xx or a 4xx refusal is a definite answer; anything else stays unknown.
        // 2xx: the rows ARE in the job now, which is exactly when sending the same file again duplicates them. The marker
        // stays (as "published") so a file chosen before this answer still needs confirmation, and the job's row count is
        // re-read at click time. Only a 4xx refusal (nothing published) lets this request's marker go.
        if (result.ok) markPublished(job.id, fp)
        else if (isDefiniteFailure(result)) clearRequest(job.id, fp)
        else markUnknown(job.id, fp)
        return
      }
      if (!result.ok) {
        if (result.status === 401) return login()
        const head = `${jobErrorMessage(result, 'upload')} Request ${i + 1} of ${chunks.length}`
        if (isDefiniteFailure(result)) {
          clearRequest(job.id, fp)
          return halt(
            `${head} stored nothing; ${done.added} rows from the earlier requests are stored in the job. You can retry from request ${i + 1}, or cancel the job and start again.`,
            i,
          )
        }
        // Ambiguous (including every 409 here: "another upload is in progress" may be our own earlier request still running).
        markUnknown(job.id, fp)
        setProblem(
          result.status === 409
            ? `An upload on this job is still running (possibly your previous request ${i + 1}). Waiting to see whether it finishes…`
            : `${head} had an unknown outcome. Waiting to see what the job ends up holding…`,
        )
        const r = await resolveUnknown(i, `${head} had an unknown outcome. `, result.status === 409)
        if (r === 'end') return
        if (r === 'landed') {
          landed()
          if (i + 1 >= chunks.length) {
            // it was the last request: the upload is complete although its answer was lost
            unresolved_.delete(job.id)
            setProblem(undefined)
            setRunning(false)
            setResumeAt(undefined)
            toast(
              'success',
              `${done.added} rows added to the job (the last answer was lost, the job was checked).`,
            )
            setPrepared(undefined)
            router.refresh()
            return
          }
          return halt(
            `${head} had an unknown outcome, and the job was watched: it DID land (its rows are stored). Continue from request ${i + 2}; do not re-send request ${i + 1}.`,
            i + 1,
          )
        }
        return halt(
          `${head} had an unknown outcome. The job was watched for ${Math.round(timing.settleMs / 1000)} s: nothing was published. You can retry from request ${i + 1} (the job is checked again first, and the backend refuses a retry while an upload still holds the job).`,
          i,
        )
      }
      clearRequest(job.id, fp)
      const appended = appendedSchema.safeParse(result.data)
      const expectedAfter = base.current + sent + chunks[i]!.length
      if (appended.success && appended.data.rowsTotal !== expectedAfter) {
        // someone else appended meanwhile: stop before anything else is added
        landed()
        return halt(
          `The job now holds ${appended.data.rowsTotal} rows but this upload expected ${expectedAfter}. Someone else added rows at the same time, so nothing more is sent from here. Check the job's rows, and cancel the job if they are not what you expect.`,
          i + 1,
          { lock: true },
        )
      }
      done.added += appended.success ? appended.data.rowsAdded : chunks[i]!.length
      done.duplicates += appended.success ? appended.data.duplicates : 0
      sent += chunks[i]!.length
      setProgress({ sent, total, ...done })
    }
    unresolved_.delete(job.id)
    setProblem(undefined)
    setRunning(false)
    setResumeAt(undefined)
    toast('success', `${done.added} rows added to the job.`)
    setPrepared(undefined)
    router.refresh()
  }

  const percent =
    progress && progress.total > 0 ? Math.floor((progress.sent / progress.total) * 100) : 0
  return (
    <section className="panel stack" aria-labelledby="job-upload-h">
      <h2 id="job-upload-h">Add rows to this job</h2>
      <p className="muted">
        UTF-8 CSV up to {JOB_FILE_LIMITS.maxChars / (1024 * 1024)} MiB and{' '}
        {JOB_FILE_LIMITS.maxRows.toLocaleString('en-IN')} rows per file; add more files one after
        another (a job holds up to 250,000 rows). Product ids are kept exactly as written.
        Spreadsheet formulas are never evaluated.
      </p>
      <label>
        CSV file
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          disabled={running}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </label>
      {problem ? (
        <p className="field-error" role="alert">
          {problem}
        </p>
      ) : null}
      {prepared && built ? (
        <>
          <h3>
            Columns ({prepared.fileName}, {prepared.rows.length} rows)
          </h3>
          <div className="map-grid">
            {FIELDS.products.map((f) => (
              <label key={f.key}>
                {f.label}
                {f.required ? ' *' : ''}
                <select
                  value={prepared.map[f.key] ?? -1}
                  disabled={running || resumeAt !== undefined}
                  onChange={(e) =>
                    setPrepared({
                      ...prepared,
                      map: { ...prepared.map, [f.key]: Number(e.target.value) },
                    })
                  }
                >
                  <option value={-1}>— not in file —</option>
                  {prepared.header.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `(column ${i + 1})`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {built.missing.length ? (
            <p className="field-error" role="alert">
              Map these required fields: {built.missing.join(', ')}.
            </p>
          ) : (
            <>
              <p>
                <StatusBadge tone="success">{built.sendable.length} ready</StatusBadge>{' '}
                <StatusBadge tone={built.invalid.length ? 'danger' : 'neutral'}>
                  {built.invalid.length} with errors
                </StatusBadge>
              </p>
              {built.invalid.length > 0 ? (
                <>
                  <ul className="muted">
                    {built.invalid.slice(0, 5).map((b) => (
                      <li key={b.line}>
                        Row {b.line}: {b.errors.join(' ')}
                      </li>
                    ))}
                    {built.invalid.length > 5 ? (
                      <li>… and {built.invalid.length - 5} more.</li>
                    ) : null}
                  </ul>
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={skipInvalid}
                      disabled={running || resumeAt !== undefined}
                      onChange={(e) => setSkipInvalid(e.target.checked)}
                    />
                    Skip the {built.invalid.length} rows with errors and add only the{' '}
                    {built.sendable.length} ready ones
                  </label>
                </>
              ) : null}
            </>
          )}
          {needsConfirm ? (
            <div className="notice" role="note">
              {marker ? (
                <p>
                  {marker.published
                    ? 'An earlier upload from this page was left mid-request, and that request has since PUBLISHED its rows.'
                    : 'An earlier upload from this page ended with an UNKNOWN outcome: its last request may still publish its rows later.'}{' '}
                  {sameAsUnknown
                    ? 'This file contains that same request (same rows), so adding it again would duplicate them.'
                    : "Check the job's row count first."}
                </p>
              ) : null}
              <p>
                This job already holds {prepared.existing} rows.{' '}
                {overlap > 0
                  ? `${overlap} of this file's first rows have the same product ids as rows already in the job: this looks like the same file chosen again. Adding it would flag them as duplicates, the job would end REJECTED, and rows cannot be removed from a job.`
                  : 'Rows you add now come after them; a product id already in the job is flagged as a duplicate and rows cannot be removed from a job.'}
              </p>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={appendAnyway}
                  disabled={running}
                  onChange={(e) => setAppendAnyway(e.target.checked)}
                />
                {overlap > 0
                  ? 'Append anyway, I accept the duplicates'
                  : 'Append these rows after the existing ones'}
              </label>
            </div>
          ) : null}
          <div className="row">
            <button
              type="button"
              ref={retryButton}
              className="btn btn-primary"
              disabled={blocked || running || locked}
              onClick={() => void upload(resumeAt ?? 0, resumeAt !== undefined)}
            >
              {resumeAt !== undefined
                ? `Retry from request ${resumeAt + 1}`
                : `Add ${built.sendable.length} rows to the job`}
            </button>
            {running ? (
              <button type="button" className="btn" onClick={() => (stop.current = true)}>
                Stop after this request
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {progress ? (
        <div className="stack">
          <progress
            value={progress.sent}
            max={Math.max(progress.total, 1)}
            aria-label="Upload progress"
          />
          <p role="status">
            {running ? 'Uploading' : 'Upload'}: {progress.sent} of {progress.total} rows sent (
            {percent}%).
            {progress.duplicates > 0
              ? ` ${progress.duplicates} were flagged as duplicates of earlier rows in this job.`
              : ''}
          </p>
        </div>
      ) : null}
      {waiting ? (
        <div className="stack">
          <p role="status">
            Waiting to learn whether request {waiting.request + 1} reached the job. Nothing is sent
            while waiting.
          </p>
          {/* per-poll progress is deliberately NOT a live region: only the start and the outcome are announced */}
          <p className="muted">
            {Math.round(waiting.elapsed / 1000)} s so far, row count unchanged for{' '}
            {Math.round(waiting.unchanged / 1000)} of {Math.round(timing.settleMs / 1000)} s.
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              refocus.current = true
              stop.current = true
            }}
          >
            Stop waiting
          </button>
        </div>
      ) : null}
    </section>
  )
}
