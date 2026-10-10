import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { connection } from 'next/server'
import { serverEnv } from '@/server/env'
import { readSession } from '@/server/session/cookies'
import './globals.css'

const DESCRIPTION = 'Groceries and daily essentials from Tazzzo.'

/** Absolute URLs (canonical, Open Graph) resolve against the configured public site origin, never the request Host. */
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(serverEnv().siteUrl),
    title: { default: 'Tazzzo', template: '%s · Tazzzo' },
    description: DESCRIPTION,
    openGraph: { siteName: 'Tazzzo', type: 'website', locale: 'en_IN' },
  }
}

/**
 * Every page renders per request: the nonce-based CSP needs a fresh nonce for each response. Backend data is still
 * cached for 60 s in the server data cache (src/server/backend/client.ts), so per-request rendering does not mean
 * per-request backend calls. The server environment is validated here, so a misconfigured deployment fails at once.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection()
  serverEnv()
  const signedIn = (await readSession()) !== null
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="site-header">
          <div className="site-header__inner">
            <Link href="/" className="brand">
              Tazzzo
            </Link>
            <form action="/search" method="get" role="search" className="search-form">
              <label htmlFor="site-search" className="visually-hidden">
                Search products
              </label>
              <input
                id="site-search"
                name="q"
                type="search"
                placeholder="Search products"
                minLength={2}
                maxLength={64}
                required
                autoComplete="off"
              />
              <button type="submit">Search</button>
            </form>
            <nav aria-label="Account" className="account-nav">
              {signedIn ? (
                <Link href="/account" data-testid="account-link">
                  Your account
                </Link>
              ) : (
                <Link href="/login" data-testid="signin-link">
                  Sign in
                </Link>
              )}
            </nav>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <footer className="site-footer">
          <p>© Tazzzo</p>
        </footer>
      </body>
    </html>
  )
}
