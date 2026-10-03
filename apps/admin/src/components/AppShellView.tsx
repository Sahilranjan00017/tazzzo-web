import type { ReactNode } from 'react'
import { LogoutButton } from './LogoutButton'

/** Authenticated shell (pure view). Receives display data only: never a token or credential. */
export interface ShellIdentity {
  label: string
  roles: string[]
}

export function AppShellView({
  identity,
  children,
}: {
  identity: ShellIdentity
  children: ReactNode
}) {
  return (
    <>
      <header className="shell-header">
        <strong>Tazzzo Admin</strong>
        <span className="shell-user">
          <span>{identity.label}</span>
          <span className="muted">{identity.roles.join(', ')}</span>
          <LogoutButton />
        </span>
      </header>
      <main className="shell-main">{children}</main>
    </>
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
