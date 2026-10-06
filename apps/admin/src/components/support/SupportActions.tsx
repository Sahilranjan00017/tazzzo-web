'use client'

import { useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import {
  MESSAGE_MAX,
  STATUS_LABEL,
  replyText,
  supportErrorMessage,
  targetsFor,
  type StatusTarget,
} from '@/lib/support'

/**
 * Work a support case: reply, take the case, change status. Replies carry no version and no idempotency key on the
 * backend, so the form is guarded against double submit and never auto-retries; a failed send keeps the draft.
 * Mounted with `key={caseId:version}` so a refresh re-initializes it. Backend enforces support-agent.
 */
export function SupportActions({
  caseId,
  status,
  version,
  assignedToMe,
}: {
  caseId: string
  status: string
  version: number
  assignedToMe: boolean
}) {
  const { run, busy } = useBffAction(supportErrorMessage)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<StatusTarget>()
  const base = `/api/bff/support/${encodeURIComponent(caseId)}`
  const closed = status === 'CLOSED'

  async function send(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const parsed = replyText.safeParse(draft)
    if (!parsed.success) {
      setError(`Write a reply of 1 to ${MESSAGE_MAX} characters, without control characters.`)
      return
    }
    setError(undefined)
    const result = await run(`${base}/messages`, 'POST', { message: parsed.data }, 'Reply sent.')
    if (result.ok) setDraft('')
  }

  const label = (t: StatusTarget) =>
    status === 'RESOLVED' && t === 'IN_PROGRESS'
      ? 'Reopen'
      : `Mark ${STATUS_LABEL[t]!.toLowerCase()}`

  return (
    <div className="stack">
      {closed ? (
        <p className="muted">
          This case is closed; replies and status changes are no longer possible.
        </p>
      ) : (
        <form className="stack" onSubmit={send} aria-label="Reply to customer">
          <label>
            Reply to the customer
            <textarea
              rows={5}
              value={draft}
              maxLength={MESSAGE_MAX}
              onChange={(e) => setDraft(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </label>
          <p className="muted">
            {draft.length}/{MESSAGE_MAX}. The customer is notified. A reply cannot be edited or
            recalled.
          </p>
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn btn-primary" disabled={busy || !draft.trim()}>
            {busy ? 'Sending…' : 'Send reply'}
          </button>
        </form>
      )}
      <div className="row">
        {!closed && !assignedToMe ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(`${base}/assign`, 'POST', { expectedVersion: version }, 'Assigned to you.')
            }
          >
            Assign to me
          </button>
        ) : null}
        {targetsFor(status).map((t) => (
          <button
            key={t}
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setPending(t)}
          >
            {label(t)}
          </button>
        ))}
      </div>
      <ConfirmDialog
        open={pending !== undefined}
        title={pending ? `${label(pending)}?` : ''}
        description={
          pending === 'RESOLVED'
            ? 'The customer is notified that the case is resolved. A customer reply reopens it.'
            : pending === 'CLOSED'
              ? 'Closing is final: no further replies or status changes.'
              : 'The case returns to in progress.'
        }
        confirmLabel={pending ? label(pending) : 'Confirm'}
        destructive={pending === 'CLOSED'}
        busy={busy}
        onCancel={() => setPending(undefined)}
        onConfirm={() => {
          if (!pending) return
          void run(
            `${base}/status`,
            'POST',
            { to: pending, expectedVersion: version },
            'Status updated.',
          ).then(() => setPending(undefined))
        }}
      />
    </div>
  )
}
