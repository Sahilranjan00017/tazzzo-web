'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { StatusBadge } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/Toast'
import { callBff } from '@/lib/bff-client'
import { FIELDS } from '@/lib/imports'
import {
  JOB_FILE_LIMITS,
  appendedSchema,
  buildUploadRows,
  chunkRows,
  jobErrorMessage,
  prepareUpload,
  type ImportJob,
} from '@/lib/import-jobs'

type Prepared = {
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
 * request fails the earlier ones stay in the job; the screen says exactly how many rows are stored and offers to retry from the
 * request that failed (safe, because that request stored nothing). Nothing is retried automatically.
 */
export function JobUpload({ job }: { job: ImportJob }) {
  const router = useRouter()
  const { toast } = useToast()
  const [prepared, setPrepared] = useState<Prepared>()
  const [skipInvalid, setSkipInvalid] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress>()
  const [resumeAt, setResumeAt] = useState(0)
  const stop = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const built = prepared ? buildUploadRows(prepared.rows, prepared.map) : undefined
  const blocked =
    !built ||
    built.missing.length > 0 ||
    built.sendable.length === 0 ||
    (built.invalid.length > 0 && !skipInvalid)

  async function onFile(file: File | undefined) {
    setProblem(undefined)
    setProgress(undefined)
    setResumeAt(0)
    if (!file) return setPrepared(undefined)
    if (!/\.csv$/i.test(file.name))
      return setProblem('Only .csv files are supported. Export your spreadsheet as CSV (UTF-8).')
    if (file.size > JOB_FILE_LIMITS.maxChars)
      return setProblem(
        `The file is larger than ${JOB_FILE_LIMITS.maxChars / (1024 * 1024)} MiB. Split it and add the parts one after another.`,
      )
    const prep = prepareUpload(await file.text())
    if (!prep.ok) return setProblem(prep.reason)
    setPrepared({ fileName: file.name, header: prep.header, rows: prep.rows, map: prep.map })
  }

  // A file chosen before hydration finished is on the input but unknown to React state: pick it up once.
  useEffect(() => {
    const f = fileInput.current?.files?.[0]
    if (f) void onFile(f)
  }, [])

  async function upload(from = 0) {
    if (!built) return
    const chunks = chunkRows(built.sendable.map((b) => b.value))
    stop.current = false
    setProblem(undefined)
    setRunning(true)
    const total = built.sendable.length
    let sent = chunks.slice(0, from).reduce((n, c) => n + c.length, 0)
    const done = { added: progress?.added ?? 0, duplicates: progress?.duplicates ?? 0 }
    if (from === 0) {
      done.added = 0
      done.duplicates = 0
    }
    setProgress({ sent, total, ...done })
    for (let i = from; i < chunks.length; i++) {
      if (stop.current) {
        setResumeAt(i)
        setRunning(false)
        return setProblem(
          `Stopped before request ${i + 1} of ${chunks.length}. ${done.added} rows are stored in the job; continue to add the rest.`,
        )
      }
      const result = await callBff<unknown>(
        `/api/bff/imports/jobs/${encodeURIComponent(job.id)}/rows`,
        'POST',
        {
          rows: chunks[i],
        },
      )
      if (!result.ok) {
        setRunning(false)
        if (result.status === 401) {
          router.replace('/login?error=expired')
          router.refresh()
          return
        }
        setResumeAt(i)
        router.refresh()
        return setProblem(
          `${jobErrorMessage(result, 'upload')} Request ${i + 1} of ${chunks.length} stored nothing; ${done.added} rows from the earlier requests are stored in the job. You can retry from request ${i + 1}, or cancel the job and start again.`,
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
