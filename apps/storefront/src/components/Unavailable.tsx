/** Shown when the backend cannot answer (rate limited, unavailable, timed out). Never exposes the cause. */
export function Unavailable({ what }: { what: string }) {
  return (
    <div className="notice" role="status">
      <p>We can&apos;t load {what} right now. Please try again in a minute.</p>
    </div>
  )
}
