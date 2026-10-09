'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

/** Signs out through `POST /api/auth/logout` with the session's CSRF token, then leaves the account page. */
export function LogoutButton({ csrfToken }: { csrfToken: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function logout() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tazzzo-CSRF': csrfToken },
        body: '{}',
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('logout failed')
      router.replace('/')
      router.refresh()
    } catch {
      setBusy(false)
      setError('We could not sign you out. Please try again.')
    }
  }

  return (
    <div>
      <button type="button" onClick={() => void logout()} disabled={busy} aria-busy={busy}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
      <p className="auth-error" role="alert">
        {error}
      </p>
    </div>
  )
}
