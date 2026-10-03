import { CMS_WRITER_ROLE } from '@/server/backend/admin-me'
import { requireAdmin } from '@/server/session/require-session'

/** Placeholder home. Role display is UX only: the backend authorizes every request. */
export default async function HomePage() {
  const access = await requireAdmin()
  const canWrite = access.view === 'ok' && access.me.roles.includes(CMS_WRITER_ROLE)
  return (
    <section aria-labelledby="home-title">
      <h1 id="home-title">Tazzzo Admin</h1>
      <p>
        {canWrite
          ? 'You can view and edit catalogue content.'
          : 'You have read-only access. Editing controls are hidden.'}
      </p>
      <p className="muted">CMS modules arrive in later releases.</p>
    </section>
  )
}
