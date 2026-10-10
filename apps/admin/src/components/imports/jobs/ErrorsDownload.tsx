'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { countCsvRecords, isWorking, negativeRowCount, type ImportJob } from '@/lib/import-jobs'

/**
 * Downloads `errors.csv` through the BFF (streamed there, `no-store`, attachment). The browser keeps the answer as a file
 * blob and saves it unchanged: cells are not re-read or re-written (the backend already neutralised formula cells).
 * The backend can end a very long export early without an error status, so the number of lines received is compared with
 * the job's own negative-row count and a mismatch is reported instead of being trusted silently.
 */
export function ErrorsDownload({ job }: { job: ImportJob }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string }>()

  async function download() {
    setBusy(true)
    setMessage(undefined)
    let response: Response
    try {
      response = await fetch(`/api/bff/imports/jobs/${encodeURIComponent(job.id)}/errors.csv`, {
        method: 'GET',
        headers: { 'X-Tazzzo-CSRF': '1' },
        redirect: 'error',
        cache: 'no-store',
      })
    } catch {
      setBusy(false)
      return setMessage({
        tone: 'error',
        text: 'Could not reach the CMS. Check your connection and try again.',
      })
    }
    if (!response.ok) {
      setBusy(false)
      if (response.status === 401) {
        router.replace('/login?error=expired')
        router.refresh()
        return
      }
      const text =
        response.status === 403
          ? 'Your roles cannot read this export.'
          : response.status === 404
            ? 'This job no longer exists.'
            : response.status === 429
              ? 'Too many requests. Try again shortly.'
              : 'The error file could not be produced right now. Try again in a moment.'
      return setMessage({ tone: 'error', text })
    }
    const csv = await response.text().catch(() => undefined)
    setBusy(false)
    if (csv === undefined)
      return setMessage({ tone: 'error', text: 'The download was interrupted. Try again.' })
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${job.id}-errors.csv`
    a.click()
    URL.revokeObjectURL(url)
    const lines = Math.max(0, countCsvRecords(csv) - 1)
    const expected = negativeRowCount(job)
    setMessage(
      !isWorking(job.status) && lines !== expected
        ? {
            tone: 'warn',
            text: `The file has ${lines} error line${lines === 1 ? '' : 's'} but the job counts ${expected} problem row${expected === 1 ? '' : 's'}. The file may be incomplete or the counts may be from an earlier pass; download again after the job settles.`,
          }
        : { tone: 'ok', text: `Downloaded ${lines} error line${lines === 1 ? '' : 's'}.` },
    )
  }

  return (
    <div className="stack">
      <div className="row">
        <button
          type="button"
          className="btn"
          onClick={() => void download()}
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? 'Preparing…' : 'Download errors.csv'}
        </button>
      </div>
      {message ? (
        <p
          className={message.tone === 'error' ? 'field-error' : 'muted'}
          role={message.tone === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  )
}
