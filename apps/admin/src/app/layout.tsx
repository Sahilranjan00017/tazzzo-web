import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { connection } from 'next/server'
import { serverEnv } from '@/server/env'
import './globals.css'

export const metadata: Metadata = {
  title: 'Tazzzo Admin',
  description: 'Tazzzo internal CMS',
  robots: { index: false, follow: false },
}

/**
 * Every page renders per request: the nonce-based CSP needs a fresh nonce for each response (no static pages).
 * The server environment is validated here, so a misconfigured deployment fails on its first render.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection()
  serverEnv()
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
