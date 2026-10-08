import type { Metadata } from 'next'
import { StatusView } from '@/components/system/StatusView'
import { readHealth } from '@/server/backend/health'
import { serverEnv } from '@/server/env'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'System status · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function StatusPage() {
  await requireAdmin()
  const { live, ready } = await readHealth()
  const env = serverEnv()
  return (
    <StatusView live={live} ready={ready} environment={env.NODE_ENV} cmsOrigin={env.CMS_BASE_URL} />
  )
}
