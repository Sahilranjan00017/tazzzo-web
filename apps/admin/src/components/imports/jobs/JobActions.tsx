'use client'

import { useState } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import { jobActions, jobErrorMessage, type ImportJob, type JobAction } from '@/lib/import-jobs'

const DONE: Record<JobAction, string> = {
  validate: 'Validation started. Nothing is written by validation.',
  apply: 'Approved. The import is now being applied in the background.',
  resume: 'Resumed from where it paused. Rows already applied are not repeated.',
  cancel: 'Job cancelled.',
}

/**
 * The writer's controls for one job. Every call carries the job `version` the page was rendered with, so a decision made on
 * a stale screen is refused by the backend (409) instead of acting on a different state. `apply` is the explicit approval:
 * the approver is whoever is signed in; the browser never sends one. Nothing is retried automatically.
 */
export function JobActions({ job, approver }: { job: ImportJob; approver: string }) {
  const { run, busy } = useBffAction((failure) => jobErrorMessage(failure, 'action'))
  const [confirm, setConfirm] = useState<'apply' | 'cancel'>()
  const can = jobActions(job.status, job.rowsTotal)
  const send = (action: JobAction) =>
    run(
      `/api/bff/imports/jobs/${encodeURIComponent(job.id)}/${action}`,
      'POST',
      { version: job.version },
      DONE[action],
    )
  const toApply = job.counts.valid + job.counts.unchanged

  if (!can.validate && !can.apply && !can.resume && !can.cancel) return null
  return (
    <section className="panel" aria-labelledby="job-actions-h">
      <h2 id="job-actions-h">Actions</h2>
      <div className="row">
        {can.validate ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void send('validate')}
          >
            {job.status === 'REJECTED' ? 'Validate again' : 'Validate rows'}
          </button>
        ) : null}
        {can.apply ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => setConfirm('apply')}
          >
            Approve and apply…
          </button>
        ) : null}
        {can.resume ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void send('resume')}
          >
            Resume
          </button>
        ) : null}
        {can.cancel ? (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => setConfirm('cancel')}
          >
            Cancel job…
          </button>
        ) : null}
      </div>
      {job.status === 'OPEN' && job.rowsTotal === 0 ? (
        <p className="muted">Add rows first; validation needs at least one row.</p>
      ) : null}
      {job.status === 'VALIDATING' || job.status === 'APPLYING' ? (
        <p className="muted">
          The background worker is running this job. Cancelling stops it at its next row; a row it
          is already writing may still be written.
        </p>
      ) : null}
      <ConfirmDialog
        open={confirm === 'apply'}
        title={`Approve and apply ${job.id}?`}
        description={`This writes up to ${toApply} products to the live catalogue (${job.counts.valid} new, ${job.counts.unchanged} already identical and left alone), in the background. Each product is recorded against ${approver}, who is the approver of this job. It cannot be undone from here.`}
        confirmLabel="Approve and apply"
        busy={busy}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => void send('apply').then(() => setConfirm(undefined))}
      />
      <ConfirmDialog
        open={confirm === 'cancel'}
        title={`Cancel ${job.id}?`}
        description="The job stops and cannot be restarted. Rows that were already applied stay in the catalogue."
        confirmLabel="Cancel job"
        destructive
        busy={busy}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => void send('cancel').then(() => setConfirm(undefined))}
      />
    </section>
  )
}
