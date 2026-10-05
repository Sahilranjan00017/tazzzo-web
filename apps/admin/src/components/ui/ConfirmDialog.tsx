'use client'

import { useEffect, useRef } from 'react'

/**
 * Modal confirmation on the native <dialog> (focus trap, Esc to cancel, inert background). Destructive actions
 * focus Cancel first so Enter never confirms by accident.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-desc"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      <p id="confirm-desc">{description}</p>
      <div className="dialog-actions">
        <button
          type="button"
          className="btn"
          autoFocus={destructive}
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className={destructive ? 'btn btn-danger' : 'btn btn-primary'}
          autoFocus={!destructive}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
