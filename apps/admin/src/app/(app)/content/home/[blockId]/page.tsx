import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { HomeDetailView } from '@/components/home/HomeViews'
import { BLOCK_ID } from '@/lib/content'
import { canWrite } from '@/lib/roles'
import { readHomeBlock } from '@/server/backend/home-content'
import { serverNow } from '@/server/clock'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Home block · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function HomeBlockPage({ params }: { params: Promise<{ blockId: string }> }) {
  const { blockId } = await params
  if (!BLOCK_ID.test(blockId)) notFound()
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  return (
    <HomeDetailView
      result={await readHomeBlock(blockId)}
      canWrite={canWrite(roles)}
      nowMs={serverNow()}
    />
  )
}
