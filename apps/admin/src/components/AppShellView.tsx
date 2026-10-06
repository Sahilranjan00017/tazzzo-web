import type { ReactNode } from 'react'
import { navFor } from '@/lib/nav'
import { LogoutButton } from './LogoutButton'
import { ShellChrome, type ShellIdentity } from './shell/ShellChrome'

export type { ShellIdentity }

/** Authenticated shell (server view). Nav is filtered by the backend roles here: UX only, never authorization. */
export function AppShellView({
  identity,
  children,
}: {
  identity: ShellIdentity
  children: ReactNode
}) {
  return (
    <ShellChrome identity={identity} sections={navFor(identity.roles)}>
      {children}
    </ShellChrome>
  )
}

export function StatusPage({ title, message }: { title: string; message: string }) {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="status-title">
        <h1 id="status-title">{title}</h1>
        <p role="alert">{message}</p>
        <LogoutButton />
      </section>
    </main>
  )
}
