import type { Metadata } from 'next'
import { ProductCreateForm } from '@/components/products/ProductCreateForm'
import { PageHeader } from '@/components/ui/primitives'
import { canWrite } from '@/lib/roles'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'New product · Tazzzo Admin' }

export default async function NewProductPage() {
  const access = await requireAdmin()
  const writer = access.view === 'ok' && canWrite(access.me.roles)
  return (
    <>
      <PageHeader title="New product" description="Create a single-SKU draft product." />
      {writer ? (
        <ProductCreateForm />
      ) : (
        <p className="notice" role="note">
          Creating products needs the cms-writer role. The backend enforces this independently.
        </p>
      )}
    </>
  )
}
