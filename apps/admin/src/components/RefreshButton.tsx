'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

/** Re-runs the server render of the current page (re-reads authoritative data). Never retries a mutation. */
export function RefreshButton({ label = 'Refresh' }: { label?: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <button
      type="button"
      className="btn"
      disabled={pending}
      aria-busy={pending}
      onClick={() => start(() => router.refresh())}
    >
      {pending ? 'Refreshing…' : label}
    </button>
  )
}
