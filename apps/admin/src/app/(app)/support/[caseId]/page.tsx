import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SupportCaseView } from '@/components/support/SupportCaseView'
import { moduleHref } from '@/lib/nav'
import { canWorkSupport } from '@/lib/roles'
import { CASE_ID } from '@/lib/support'
import { readCase } from '@/server/backend/support'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Support case · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function SupportCasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params
  if (!CASE_ID.test(caseId)) notFound()
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  return (
    <SupportCaseView
      result={await readCase(caseId)}
      canWork={canWorkSupport(roles)}
      canSeeOrders={moduleHref('orders', roles) !== undefined}
      myActorId={access.view === 'ok' ? access.me.actorId : undefined}
    />
  )
}
