import type { Metadata } from 'next'
import { AppConfigView } from '@/components/content/AppConfigView'
import { canWrite } from '@/lib/roles'
import { readAppConfig } from '@/server/backend/content'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'App configuration · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function AppConfigPage() {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  return <AppConfigView result={await readAppConfig()} canWrite={canWrite(roles)} />
}
