import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { FaqDetailView } from '@/components/content/FaqViews'
import { BLOCK_ID } from '@/lib/content'
import { canWrite } from '@/lib/roles'
import { readBlock } from '@/server/backend/content'
import { serverNow } from '@/server/clock'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'FAQ · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function FaqPage({ params }: { params: Promise<{ blockId: string }> }) {
  const { blockId } = await params
  if (!BLOCK_ID.test(blockId)) notFound()
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const result = await readBlock(blockId)
  // the go-to box and old links land here for any content id: a legal document belongs on its own screen
  if (result.kind === 'ok' && result.data.type === 'LEGAL')
    redirect(`/content/legal/${encodeURIComponent(blockId)}`)
  return <FaqDetailView result={result} canWrite={canWrite(roles)} nowMs={serverNow()} />
}
