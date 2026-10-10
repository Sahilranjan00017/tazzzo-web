import type { Metadata } from 'next'
import { LegalEditor } from '@/components/content/LegalEditor'
import { PageHeader } from '@/components/ui/primitives'
import { canWrite } from '@/lib/roles'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'New legal document · Tazzzo Admin' }

export default async function NewLegalPage() {
  const access = await requireAdmin()
  const writer = access.view === 'ok' && canWrite(access.me.roles)
  return (
    <>
      <PageHeader
        title="New legal document"
        description="Created as a draft; it is not public until you publish it."
      />
      {writer ? (
        <LegalEditor />
      ) : (
        <p className="notice" role="note">
          Creating content needs the cms-writer role. The backend enforces this independently.
        </p>
      )}
    </>
  )
}
