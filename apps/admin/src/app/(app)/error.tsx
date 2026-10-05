'use client'

import { ErrorPanel } from '@/components/ui/primitives'

/** Segment error boundary: a generic, trace-able message. The error text/stack is never shown. */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  return (
    <ErrorPanel
      title="This page failed to load"
      message="An unexpected error occurred. You can try again; if it keeps happening, share the reference below with an engineer."
      correlationId={error.digest}
      onRetry={retry}
    />
  )
}
