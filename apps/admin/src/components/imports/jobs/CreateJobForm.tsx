'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { useToast } from '@/components/ui/Toast'
import { callBff } from '@/lib/bff-client'
import { JOB_KINDS, jobErrorMessage, jobSchema } from '@/lib/import-jobs'

const NOTE_MAX = 500

/** Creates an empty OPEN job (`createImportJob`) and opens it; rows are added on the job page. Only `products` exists. */
export function CreateJobForm() {
  const router = useRouter()
  const { toast } = useToast()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (note.trim().length > NOTE_MAX)
      return setError(`The note can be at most ${NOTE_MAX} characters.`)
    setError(undefined)
    setBusy(true)
    const result = await callBff<unknown>('/api/bff/imports/jobs', 'POST', {
      kind: JOB_KINDS[0],
      ...(note.trim() ? { note: note.trim() } : {}),
    })
    setBusy(false)
    if (!result.ok) {
      if (result.status === 401) {
        router.replace('/login?error=expired')
        router.refresh()
        return
      }
      return setError(jobErrorMessage(result, 'job creation'))
    }
    const job = jobSchema.safeParse(result.data)
    toast('success', 'Import job created.')
    if (job.success) router.push(`/catalogue/imports/jobs/${encodeURIComponent(job.data.id)}`)
    else router.refresh()
  }

  return (
    <form
      className="panel stack form-narrow"
      onSubmit={submit}
      noValidate
      aria-label="Create import job"
    >
      <h2>New import job</h2>
      <label>
        Kind
        <select value={JOB_KINDS[0]} disabled aria-describedby="job-kind-help">
          {JOB_KINDS.map((k) => (
            <option key={k} value={k}>
              Products
            </option>
          ))}
        </select>
        <span id="job-kind-help" className="muted">
          Only product jobs exist today. Prices and stock use the quick import.
        </span>
      </label>
      <label>
        Note (optional, up to {NOTE_MAX} characters)
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX + 50} />
      </label>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create job'}
        </button>
      </div>
    </form>
  )
}
