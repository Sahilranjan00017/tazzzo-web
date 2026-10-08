'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'

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
  confirmDisabled = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  destructive?: boolean
  busy?: boolean
  /** Keeps Confirm disabled until a required input inside the dialog is filled. */
  confirmDisabled?: boolean
  onConfirm: () => void
  onCancel: () => void
  /** Optional extra controls (e.g. a required reason) shown between the description and the buttons. */
  children?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  // Unique per dialog: a page can hold several (e.g. status actions and an editor), and shared ids would mislabel them.
  const id = useId()
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
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-desc`}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <h2 id={`${id}-title`}>{title}</h2>
      <p id={`${id}-desc`}>{description}</p>
      {children}
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
          disabled={busy || confirmDisabled}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
