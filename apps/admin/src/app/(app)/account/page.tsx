import type { Metadata } from 'next'
import { AccessMatrix } from '@/components/AccessMatrix'
import { PageHeader, StatusBadge } from '@/components/ui/primitives'
import { describeRoles } from '@/lib/roles'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Profile & access · Tazzzo Admin' }

/** Signed-in identity and effective roles, straight from the backend `/me`. Staff provisioning is operational. */
export default async function AccountPage() {
  const access = await requireAdmin()
  if (access.view !== 'ok') return null
  const { me } = access
  const roles = describeRoles(me.roles)
  return (
    <>
      <PageHeader
        title="Profile & access"
        description="Who you are signed in as and what the backend lets you do."
      />
      <section className="panel" aria-labelledby="identity-h">
        <h2 id="identity-h">Identity</h2>
        <dl className="kv">
          <dt>Email</dt>
          <dd>{me.email ?? 'not provided'}</dd>
          <dt>Actor</dt>
          <dd>
            <code>{me.actorId}</code> <StatusBadge tone="info">{me.actorType}</StatusBadge>
          </dd>
        </dl>
      </section>
      <section className="panel" aria-labelledby="roles-h">
        <h2 id="roles-h">Effective roles</h2>
        {roles.length === 0 ? (
          <p className="muted">
            No roles. You can sign in but the backend will refuse module access.
          </p>
        ) : (
          <ul className="role-list">
            {roles.map((r) => (
              <li key={r.role}>
                <strong>{r.title}</strong> <code>{r.role}</code>
                <p className="muted">{r.grants}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <AccessMatrix yourRoles={me.roles} />
      <section className="panel" aria-labelledby="prov-h">
        <h2 id="prov-h">Staff provisioning</h2>
        <p>
          Roles come from the backend allowlist, not from Google. The backend has no staff-user
          management API, so granting or revoking access is an operational change made by an
          engineer. Menus here only reflect your roles; the backend authorizes every request.
        </p>
      </section>
    </>
  )
}
