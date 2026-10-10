import type { Metadata } from 'next'
import Link from 'next/link'
import { ImportWizard } from '@/components/imports/ImportWizard'
import { PageHeader } from '@/components/ui/primitives'
import { canWrite } from '@/lib/roles'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Imports · Tazzzo Admin' }

export default async function ImportsPage() {
  const access = await requireAdmin()
  const writer = access.view === 'ok' && canWrite(access.me.roles)
  return (
    <>
      <PageHeader
        title="Bulk import"
        description="Import products, prices or stock from a CSV file. The backend validates and has the final say."
        actions={
          <Link className="btn" href="/catalogue/imports/jobs">
            Import jobs (large product files)
          </Link>
        }
      />
      {writer ? (
        <ImportWizard />
      ) : (
        <p className="notice" role="note">
          Imports need the cms-writer role. The backend enforces this independently.
        </p>
      )}
    </>
  )
}
