import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ServiceAreaDetailView } from '@/components/delivery/ServiceAreaViews'
import { PINCODE } from '@/lib/delivery'
import { canWrite } from '@/lib/roles'
import { readArea } from '@/server/backend/delivery'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Service area · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function ServiceAreaPage({
  params,
}: {
  params: Promise<{ pincode: string }>
}) {
  const { pincode } = await params
  if (!PINCODE.test(pincode)) notFound()
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  return <ServiceAreaDetailView result={await readArea(pincode)} canWrite={canWrite(roles)} />
}
