import type { Metadata } from 'next'
import { AreaEditor } from '@/components/delivery/AreaEditor'
import { PageHeader } from '@/components/ui/primitives'
import { canWrite } from '@/lib/roles'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'New service area · Tazzzo Admin' }

export default async function NewServiceAreaPage() {
  const access = await requireAdmin()
  const writer = access.view === 'ok' && canWrite(access.me.roles)
  return (
    <>
      <PageHeader
        title="New service area"
        description="Create a pincode record and its fulfilment routes. New areas start active."
      />
      {writer ? (
        <AreaEditor />
      ) : (
        <p className="notice" role="note">
          Creating service areas needs the cms-writer role. The backend enforces this independently.
        </p>
      )}
    </>
  )
}
