import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { LegalDetailView } from '@/components/content/LegalViews'
import { BLOCK_ID } from '@/lib/content'
import { canWrite } from '@/lib/roles'
import { readBlock } from '@/server/backend/content'
import { serverNow } from '@/server/clock'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Legal document · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function LegalDocumentPage({
  params,
}: {
  params: Promise<{ blockId: string }>
}) {
  const { blockId } = await params
  if (!BLOCK_ID.test(blockId)) notFound()
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  return (
    <LegalDetailView
      result={await readBlock(blockId)}
      canWrite={canWrite(roles)}
      nowMs={serverNow()}
    />
  )
}
