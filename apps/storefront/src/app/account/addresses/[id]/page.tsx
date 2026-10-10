import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { AddressForm } from '@/components/AddressForm'
import { isAddressId } from '@/lib/location/validation'
import { pageAddress } from '@/server/address/service'
import { readSession } from '@/server/session/cookies'
import { accessTokenUsable } from '@/server/session/service'
import { Unavailable } from '@/components/Unavailable'

export const metadata: Metadata = { title: 'Edit address', robots: { index: false, follow: false } }

/** Edit one saved address. An id outside the grammar, or one the backend does not know as the caller's, is a 404. */
export default async function EditAddressPage({ params }: PageProps<'/account/addresses/[id]'>) {
  const { id } = await params
  if (!isAddressId(id)) notFound()
  const next = `/account/addresses/${encodeURIComponent(id)}`
  const session = await readSession()
  if (session === null) redirect(`/login?next=${encodeURIComponent(next)}`)
  const outcome = await pageAddress(session, id)
  if (!outcome.ok && outcome.error === 'unauthenticated') {
    const refresh = `/api/auth/refresh?next=${encodeURIComponent(next)}`
    redirect(accessTokenUsable(session) ? `${refresh}&rejected=1` : refresh)
  }
  if (!outcome.ok && outcome.error === 'not_found') notFound()
  if (!outcome.ok) return <Unavailable what="this address" />
  return (
    <div className="auth">
      <AddressForm address={outcome.data} csrfToken={session.csrf} />
    </div>
  )
}
