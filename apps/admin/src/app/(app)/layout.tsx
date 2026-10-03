import type { ReactNode } from 'react'
import { AppShellView, StatusPage } from '@/components/AppShellView'
import { requireAdmin } from '@/server/session/require-session'

/**
 * Every page in this group requires a valid server-side session AND a backend-approved identity (`/me`).
 * 403 keeps the session and shows access denied; 401 ends the session (handled inside requireAdmin).
 */
export default async function AppShellLayout({ children }: { children: ReactNode }) {
  const access = await requireAdmin()
  if (access.view === 'forbidden') {
    return (
      <StatusPage
        title="Access denied"
        message="Your account is signed in but has no admin access."
      />
    )
  }
  if (access.view === 'unavailable') {
    return (
      <StatusPage
        title="Temporarily unavailable"
        message="The admin service could not be reached. Try again."
      />
    )
  }
  return (
    <AppShellView
      identity={{ label: access.me.email ?? access.me.actorId, roles: access.me.roles }}
    >
      {children}
    </AppShellView>
  )
}
