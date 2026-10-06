import type { Metadata } from 'next'
import { SupportListView } from '@/components/support/SupportListView'
import { parseCaseListQuery } from '@/lib/support'
import { readCases } from '@/server/backend/support'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Support · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const query = parseCaseListQuery(await searchParams)
  return (
    <SupportListView
      result={await readCases(query)}
      query={query}
      myActorId={access.view === 'ok' ? access.me.actorId : undefined}
    />
  )
}
