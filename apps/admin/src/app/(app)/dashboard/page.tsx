import { DashboardView } from '@/components/dashboard/DashboardView'
import { PageHeader } from '@/components/ui/primitives'
import { readDashboard } from '@/server/backend/dashboard'
import { requireAdmin } from '@/server/session/require-session'

export const dynamic = 'force-dynamic'

const DASHBOARD_ROLES = ['reader', 'cms-writer']

/**
 * Operations dashboard. Roles outside reader/cms-writer are refused by the backend, so they get an explanatory state
 * without a pointless call; the backend remains the authority either way.
 */
export default async function DashboardPage() {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  if (!roles.some((r) => DASHBOARD_ROLES.includes(r))) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <section className="panel" role="status">
          <h2>Dashboard not available for your roles</h2>
          <p>
            The backend serves the dashboard summary to reader and cms-writer only. Use the modules
            in the sidebar that your roles allow.
          </p>
        </section>
      </>
    )
  }
  return <DashboardView result={await readDashboard()} />
}
