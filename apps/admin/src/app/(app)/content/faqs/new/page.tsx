import type { Metadata } from 'next'
import { FaqEditor } from '@/components/content/FaqEditor'
import { PageHeader } from '@/components/ui/primitives'
import { canWrite } from '@/lib/roles'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'New FAQ · Tazzzo Admin' }

export default async function NewFaqPage() {
  const access = await requireAdmin()
  const writer = access.view === 'ok' && canWrite(access.me.roles)
  return (
    <>
      <PageHeader
        title="New FAQ"
        description="Created as a draft; it is not public until you publish it."
      />
      {writer ? (
        <FaqEditor />
      ) : (
        <p className="notice" role="note">
          Creating content needs the cms-writer role. The backend enforces this independently.
        </p>
      )}
    </>
  )
}
