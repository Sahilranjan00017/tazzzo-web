import type { Metadata } from 'next'
import { TaxonomyView, type TaxonomyData } from '@/components/taxonomy/TaxonomyView'
import { parseNodeListQuery } from '@/lib/taxonomy'
import { canWrite } from '@/lib/roles'
import { readNode, readNodePath, readNodes } from '@/server/backend/taxonomy'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Taxonomy · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function TaxonomyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const query = parseNodeListQuery(await searchParams)
  const [list, node, path] = await Promise.all([
    readNodes(query),
    query.parentId ? readNode(query.parentId) : undefined,
    query.parentId ? readNodePath(query.parentId) : undefined,
  ])
  const data: TaxonomyData = { list, node, path }
  return <TaxonomyView data={data} query={query} canWrite={canWrite(roles)} />
}
