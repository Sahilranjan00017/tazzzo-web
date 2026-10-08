'use client'

/** Route error boundary: generic text only, never the error message (it may carry internals). */
export default function RouteError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <section className="listing">
      <h1>Something went wrong</h1>
      <p>Please try again.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </section>
  )
}
