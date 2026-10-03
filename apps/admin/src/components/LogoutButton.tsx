'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

/** POSTs to the logout route with the CSRF header (same-origin fetch), then returns to the sign-in page. */
export function LogoutButton() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  async function logout() {
    setPending(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Tazzzo-CSRF': '1' } })
    } finally {
      router.replace('/login')
      router.refresh()
    }
  }
  return (
    <button type="button" className="link-button" onClick={logout} disabled={pending}>
      Sign out
    </button>
  )
}
