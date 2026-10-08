import type { Metadata } from 'next'
import { NotificationsView } from '@/components/system/NotificationsView'
import { readDashboard } from '@/server/backend/dashboard'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Notifications · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

const ALLOWED = ['reader', 'cms-writer']

export default async function NotificationsPage() {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  if (!roles.some((r) => ALLOWED.includes(r)))
    return <NotificationsView result={{ kind: 'forbidden' }} />
  return <NotificationsView result={await readDashboard()} />
}
