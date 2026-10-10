import { LauncherView, type LauncherDashboard } from '@/components/launcher/LauncherView'
import { canReadDashboard } from '@/lib/launcher'
import { canWrite } from '@/lib/roles'
import { readDashboard } from '@/server/backend/dashboard'
import { requireAdmin } from '@/server/session/require-session'

export const dynamic = 'force-dynamic'

/** Home: a role-aware launcher. Role display is UX only: the backend authorizes every request. */
export default async function HomePage() {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const dashboard: LauncherDashboard = canReadDashboard(roles)
    ? await readDashboard()
    : { kind: 'not_requested' }
  return (
    <LauncherView
      roles={roles}
      writer={access.view === 'ok' && canWrite(access.me.roles)}
      dashboard={dashboard}
    />
  )
}
