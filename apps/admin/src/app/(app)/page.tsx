import { PageHeader } from '@/components/ui/primitives'
import { canWrite } from '@/lib/roles'
import { requireAdmin } from '@/server/session/require-session'

/** Home. Role display is UX only: the backend authorizes every request. */
export default async function HomePage() {
  const access = await requireAdmin()
  const writer = access.view === 'ok' && canWrite(access.me.roles)
  return (
    <>
      <PageHeader
        title="Tazzzo Admin"
        description={
          writer
            ? 'You can view and edit catalogue content.'
            : 'Editing controls are hidden for your roles.'
        }
      />
      <section className="panel">
        <p className="muted">
          Modules marked “Soon” in the sidebar are not built yet. Nothing here is sample data.
        </p>
      </section>
    </>
  )
}
