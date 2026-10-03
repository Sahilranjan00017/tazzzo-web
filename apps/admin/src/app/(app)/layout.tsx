import type { ReactNode } from 'react'

/** App shell for future authenticated CMS pages. W1 renders no identity: nobody is signed in. */
export default function AppShellLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="shell-header">
        <strong>Tazzzo Admin</strong>
        <span className="muted">Not signed in</span>
      </header>
      <main className="shell-main">{children}</main>
    </>
  )
}
