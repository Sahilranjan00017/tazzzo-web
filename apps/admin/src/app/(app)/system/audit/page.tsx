import type { Metadata } from 'next'
import { AuditView } from '@/components/system/AuditView'
import { parseAuditQuery } from '@/lib/audit'
import { readAudit } from '@/server/backend/audit'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Audit log · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const { query, problems } = parseAuditQuery(await searchParams)
  return (
    <AuditView result={await readAudit(query)} query={query} problems={problems} roles={roles} />
  )
}
