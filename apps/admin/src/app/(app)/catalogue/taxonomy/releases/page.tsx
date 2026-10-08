import type { Metadata } from 'next'
import { ReleasePanel } from '@/components/taxonomy/ReleasePanel'
import { PageHeader } from '@/components/ui/primitives'
import { RELEASE_ID } from '@/lib/taxonomy'
import { canWrite } from '@/lib/roles'
import { readRelease } from '@/server/backend/taxonomy'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Taxonomy releases · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function ReleasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const raw = (await searchParams).release
  const id = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  let looked
  if (id && RELEASE_ID.test(id)) {
    const r = await readRelease(id)
    if (r.kind === 'ok') looked = r.data
    else if (r.kind === 'not_found') looked = { id, missing: true as const }
  }
  return (
    <>
      <PageHeader
        title="Taxonomy releases"
        description="Open and publish releases. Catalogue changes need exactly one open release."
      />
      <ReleasePanel canWrite={canWrite(roles)} looked={looked} />
    </>
  )
}
