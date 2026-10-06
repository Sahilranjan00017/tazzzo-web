'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { breadcrumbsFor, isActive, type NavSection } from '@/lib/nav'
import { Breadcrumbs } from './Breadcrumbs'
import { LogoutButton } from '@/components/LogoutButton'
import { GotoBox } from './GotoBox'
import { ToastProvider } from '@/components/ui/Toast'

export interface ShellIdentity {
  label: string
  roles: string[]
}

/**
 * Interactive frame: collapsible sidebar (drawer below 900px), top bar with breadcrumbs and profile menu.
 * Receives display data only. Never a token or credential. Nav filtering happens on the server (`navFor`).
 */
export function ShellChrome({
  identity,
  sections,
  children,
}: {
  identity: ShellIdentity
  sections: readonly NavSection[]
  children: ReactNode
}) {
  const pathname = usePathname()
  // Open state is tied to the path it was opened on, so navigating closes both without an effect.
  const [drawerPath, setDrawerPath] = useState<string | null>(null)
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const drawer = drawerPath === pathname
  const menu = menuPath === pathname
  const setDrawer = (open: boolean) => setDrawerPath(open ? pathname : null)
  const setMenu = (open: boolean) => setMenuPath(open ? pathname : null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu && !drawer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenuPath(null)
      setDrawerPath(null)
    }
    const onClick = (e: MouseEvent) => {
      if (menu && menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuPath(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [menu, drawer])

  const initial = (identity.label.trim()[0] ?? '?').toUpperCase()

  return (
    <ToastProvider>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="shell">
        <aside className={`sidebar${drawer ? ' sidebar-open' : ''}`} aria-label="Primary">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              T
            </span>
            <span>Tazzzo Admin</span>
          </div>
          <nav aria-label="Modules">
            {sections.map((section) => (
              <div key={section.id} className="nav-section">
                <p className="nav-heading">{section.label}</p>
                <ul>
                  {section.items.map((item) => (
                    <li key={item.id}>
                      {item.state === 'planned' ? (
                        <span className="nav-link nav-disabled" aria-disabled="true">
                          {item.label}
                          <span className="nav-soon">Soon</span>
                        </span>
                      ) : (
                        <Link
                          href={item.href}
                          className={`nav-link${isActive(item.href, pathname) ? ' nav-active' : ''}`}
                          aria-current={isActive(item.href, pathname) ? 'page' : undefined}
                        >
                          {item.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>
        {drawer ? (
          <div className="scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
        ) : null}

        <div className="content-col">
          <header className="topbar">
            <button
              type="button"
              className="btn btn-icon menu-toggle"
              aria-label="Open navigation"
              aria-expanded={drawer}
              onClick={() => setDrawer(!drawer)}
            >
              ☰
            </button>
            <Breadcrumbs crumbs={breadcrumbsFor(pathname)} />
            <GotoBox roles={identity.roles} />
            <div className="profile" ref={menuRef}>
              <button
                type="button"
                className="avatar"
                aria-expanded={menu}
                aria-controls="account-menu"
                aria-label={`Account menu for ${identity.label}`}
                onClick={() => setMenu(!menu)}
              >
                {initial}
              </button>
              {menu ? (
                <div className="menu" id="account-menu">
                  <p className="menu-id">{identity.label}</p>
                  <p className="muted menu-roles">{identity.roles.join(', ') || 'no roles'}</p>
                  <Link href="/account" className="menu-item">
                    Profile &amp; access
                  </Link>
                  <LogoutButton />
                </div>
              ) : null}
            </div>
          </header>
          <main id="main" className="main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}
