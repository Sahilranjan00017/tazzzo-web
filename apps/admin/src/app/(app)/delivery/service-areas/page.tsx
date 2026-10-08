import type { Metadata } from 'next'
import { ServiceAreaListView } from '@/components/delivery/ServiceAreaViews'
import { parseAreaListQuery } from '@/lib/delivery'
import { canWrite } from '@/lib/roles'
import { readAreas } from '@/server/backend/delivery'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Service areas · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function ServiceAreasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const q = parseAreaListQuery(await searchParams)
  return (
    <ServiceAreaListView result={await readAreas(q)} after={q.after} canWrite={canWrite(roles)} />
  )
}
