import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AddressForm } from '@/components/AddressForm'
import { readSession } from '@/server/session/cookies'

export const metadata: Metadata = {
  title: 'Add an address',
  robots: { index: false, follow: false },
}

export default async function NewAddressPage() {
  const session = await readSession()
  if (session === null) redirect('/login?next=/account/addresses/new')
  return (
    <div className="auth">
      <AddressForm address={null} csrfToken={session.csrf} />
    </div>
  )
}
