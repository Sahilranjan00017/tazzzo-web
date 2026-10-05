import type { ReactNode } from 'react'

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  )
}

export function Skeleton({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label} aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton-line" />
      ))}
    </div>
  )
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string
  message?: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {message ? <p className="muted">{message}</p> : null}
      {action}
    </div>
  )
}

/** Inline, actionable error panel (never a stack trace). `correlationId` helps support trace a failure. */
export function ErrorPanel({
  title,
  message,
  correlationId,
  onRetry,
}: {
  title: string
  message: string
  correlationId?: string
  onRetry?: () => void
}) {
  return (
    <div className="panel panel-error" role="alert">
      <h2>{title}</h2>
      <p>{message}</p>
      {correlationId ? <p className="muted">Reference: {correlationId}</p> : null}
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  )
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

export function StatusBadge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}
