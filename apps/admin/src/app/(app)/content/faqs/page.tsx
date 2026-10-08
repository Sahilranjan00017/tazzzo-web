import type { Metadata } from 'next'
import { FaqListView } from '@/components/content/FaqViews'
import { canWrite } from '@/lib/roles'
import { readFaqBlocks } from '@/server/backend/content'
import { serverNow } from '@/server/clock'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'FAQs · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function FaqsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const raw = (await searchParams).status
  const status = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  return (
    <FaqListView
      result={await readFaqBlocks(status)}
      status={status}
      canWrite={canWrite(roles)}
      nowMs={serverNow()}
    />
  )
}
