import type { Metadata } from 'next'
import { LegalListView } from '@/components/content/LegalViews'
import { canWrite } from '@/lib/roles'
import { readLegalBlocks } from '@/server/backend/content'
import { serverNow } from '@/server/clock'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Legal documents · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function LegalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const raw = (await searchParams).status
  const status = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  return (
    <LegalListView
      result={await readLegalBlocks(status)}
      status={status}
      canWrite={canWrite(roles)}
      nowMs={serverNow()}
    />
  )
}
