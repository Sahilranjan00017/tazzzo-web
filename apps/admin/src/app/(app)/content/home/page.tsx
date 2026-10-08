import type { Metadata } from 'next'
import { HomeListView } from '@/components/home/HomeViews'
import { AUDIENCES } from '@/lib/home-content'
import { canWrite } from '@/lib/roles'
import { readHomeBlocks } from '@/server/backend/home-content'
import { serverNow } from '@/server/clock'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Home content · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined

export default async function HomeContentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const raw = await searchParams
  const status = one(raw.status)
  const audience = one(raw.audience)
  const filter = {
    status: status && ['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(status) ? status : undefined,
    audience:
      audience && (AUDIENCES as readonly string[]).includes(audience) ? audience : undefined,
  }
  return (
    <HomeListView
      result={await readHomeBlocks(filter)}
      filter={filter}
      canWrite={canWrite(roles)}
      nowMs={serverNow()}
    />
  )
}
