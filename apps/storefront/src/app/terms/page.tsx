import type { Metadata } from 'next'
import { LegalPage, legalMetadata } from '../_sections/LegalPage'

// Always rendered per request: the 60 s freshness lives in the backend client, and a legal take-down must never be
// pinned by a prerendered or ISR copy of this page.
export const dynamic = 'force-dynamic'

export function generateMetadata(): Promise<Metadata> {
  return legalMetadata('terms')
}

export default function Page() {
  return <LegalPage slug="terms" />
}
