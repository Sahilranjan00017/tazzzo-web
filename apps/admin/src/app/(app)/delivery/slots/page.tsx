import type { Metadata } from 'next'
import { SlotsView } from '@/components/delivery/SlotsView'
import { AREA_ID, WINDOW_ID } from '@/lib/delivery'
import { canWrite } from '@/lib/roles'
import { readWindows } from '@/server/backend/delivery'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Delivery slots · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim()

export default async function SlotsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const raw = await searchParams
  const area = one(raw.area)
  const edit = one(raw.edit)
  if (!area) return <SlotsView canWrite={canWrite(roles)} />
  if (!AREA_ID.test(area)) return <SlotsView canWrite={canWrite(roles)} invalidInput />
  return (
    <SlotsView
      area={area}
      result={await readWindows(area)}
      editId={edit && WINDOW_ID.test(edit) ? edit : undefined}
      canWrite={canWrite(roles)}
    />
  )
}
