'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { StatusBadge } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/Toast'
import { callBff, getBff } from '@/lib/bff-client'
import { FIELDS } from '@/lib/imports'
import {
  JOB_FILE_LIMITS,
  appendedSchema,
  buildUploadRows,
  chunkRows,
  isDefiniteFailure,
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
export function JobUpload({ job, firstIds }: { job: ImportJob; firstIds?: readonly string[] }) {
  const router = useRouter()
  const { toast } = useToast()
  const [prepared, setPrepared] = useState<Prepared>()
  const [skipInvalid, setSkipInvalid] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress>()
  const [resumeAt, setResumeAt] = useState(0)
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
  const needsConfirm = prepared !== undefined && prepared.existing > 0 && resumeAt === 0
  const blocked =
    !built ||
    built.missing.length > 0 ||
    built.sendable.length === 0 ||
    (built.invalid.length > 0 && !skipInvalid) ||
    (needsConfirm && !appendAnyway)

  async function onFile(file: File | undefined) {
    setProblem(undefined)
    setProgress(undefined)
    setResumeAt(0)
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

  /** Fresh, uncached read of the job: how many rows does the backend really hold, and can it still take rows? */
  async function readJob() {
    const r = await getBff<unknown>(`/api/bff/imports/jobs/${encodeURIComponent(job.id)}`)
    if (!r.ok) return { unauthenticated: r.status === 401 } as const
    const parsed = jobSchema.safeParse(r.data)
    return parsed.success ? ({ job: parsed.data } as const) : ({} as const)
  }

  /**
   * Before any request (and after any ambiguous failure) compare what the backend holds with what this upload has sent.
   * The backend appends atomically per request but does not de-duplicate a re-sent one, so an unknown outcome must never be
   * answered by blindly sending the same rows again.
   *   rows == expected                 -> the request did not land: send it
   *   rows == expected + request size  -> it DID land: skip it
   *   anything else                    -> someone else changed the job (or a partial state): stop and say so
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

  async function upload(from = 0) {
    if (!built) return
    const chunks = chunkRows(built.sendable.map((b) => b.value))
    stop.current = false
    setProblem(undefined)
    setRunning(true)
    const total = built.sendable.length
    const done = { added: progress?.added ?? 0, duplicates: progress?.duplicates ?? 0 }
    if (from === 0) {
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
      base.current = start.job.rowsTotal
    }
    let sent = chunks.slice(0, from).reduce((n, c) => n + c.length, 0)
    setProgress({ sent, total, ...done })
    const halt = (message: string, at: number, refresh = true) => {
      setResumeAt(at)
      setRunning(false)
      if (refresh) router.refresh()
      setProblem(message)
    }
    for (let i = from; i < chunks.length; i++) {
      if (stop.current)
        return halt(
          `Stopped before request ${i + 1} of ${chunks.length}. ${done.added} rows are stored in the job; continue to add the rest.`,
          i,
          false,
        )
      if (i === from && from > 0) {
        // a retry or continue: the answer to "did it land?" comes from the backend, never from the screen
        const verdict = await reconcile(chunks, i)
        if (verdict === 'login') {
          router.replace('/login?error=expired')
          router.refresh()
          return
        }
        if (typeof verdict === 'object') return halt(verdict.stop, i)
        if (verdict === 'landed') {
          done.added += chunks[i]!.length
          sent += chunks[i]!.length
          setProgress({ sent, total, ...done })
          continue
        }
      }
      const result = await callBff<unknown>(
        `/api/bff/imports/jobs/${encodeURIComponent(job.id)}/rows`,
        'POST',
        { rows: chunks[i] },
      )
      if (!result.ok) {
        if (result.status === 401) {
          setRunning(false)
          router.replace('/login?error=expired')
          router.refresh()
          return
        }
        const head = `${jobErrorMessage(result, 'upload')} Request ${i + 1} of ${chunks.length}`
        if (isDefiniteFailure(result))
          return halt(
            `${head} stored nothing; ${done.added} rows from the earlier requests are stored in the job. You can retry from request ${i + 1}, or cancel the job and start again.`,
            i,
          )
        // Ambiguous: the request may have been committed before the answer was lost. Look, do not guess.
        const verdict = await reconcile(chunks, i)
        if (verdict === 'send')
          return halt(
            `${head} had an unknown outcome, and the job was checked: it did not land. ${done.added} rows from the earlier requests are stored. You can retry from request ${i + 1}; the job is checked again first.`,
            i,
          )
        if (verdict === 'landed') {
          done.added += chunks[i]!.length
          if (i + 1 >= chunks.length) {
            // it was the last request: the upload is complete although its answer was lost
            setRunning(false)
            setResumeAt(0)
            toast(
              'success',
              `${done.added} rows added to the job (the last answer was lost, the job was checked).`,
            )
            setPrepared(undefined)
            router.refresh()
            return
          }
          setProgress({ sent: sent + chunks[i]!.length, total, ...done })
          return halt(
            `${head} had an unknown outcome, and the job was checked: it DID land (its rows are stored). Continue from request ${i + 2}; do not re-send request ${i + 1}.`,
            i + 1,
          )
        }
        if (verdict === 'login') {
          router.replace('/login?error=expired')
          router.refresh()
          return
        }
        return halt(
          `${head} had an unknown outcome. ${verdict.stop} Do not re-send the file until you know what the job holds.`,
          i,
        )
      }
      const appended = appendedSchema.safeParse(result.data)
      sent += chunks[i]!.length
      done.added += appended.success ? appended.data.rowsAdded : chunks[i]!.length
      done.duplicates += appended.success ? appended.data.duplicates : 0
      setProgress({ sent, total, ...done })
    }
    setRunning(false)
    setResumeAt(0)
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
                  disabled={running || resumeAt > 0}
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
                      disabled={running || resumeAt > 0}
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
              className="btn btn-primary"
              disabled={blocked || running}
              onClick={() => void upload(resumeAt)}
            >
              {resumeAt > 0
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
    </section>
  )
}
