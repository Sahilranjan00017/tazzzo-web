import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AddressList } from '@/components/AddressList'
import { pageAddresses } from '@/server/address/service'
import { readSession } from '@/server/session/cookies'
import { accessTokenUsable } from '@/server/session/service'

export const metadata: Metadata = {
  title: 'Your addresses',
  robots: { index: false, follow: false },
}

const REFRESH = '/api/auth/refresh?next=/account/addresses'

/** Saved addresses (`GET /v1/customer/addresses`, default first). Same sign-in and token-refresh rules as `/cart`. */
export default async function AddressesPage() {
  const session = await readSession()
  if (session === null) redirect('/login?next=/account/addresses')
  const outcome = await pageAddresses(session)
  if (!outcome.ok && outcome.error === 'unauthenticated') {
    redirect(accessTokenUsable(session) ? `${REFRESH}&rejected=1` : REFRESH)
  }
  if (!outcome.ok) {
    return (
      <section className="auth" aria-labelledby="addresses-title">
        <div className="panel">
          <h1 id="addresses-title">Your addresses</h1>
          <p role="alert" data-testid="address-load-error">
            We could not load your addresses right now.{' '}
            <Link href="/account/addresses">Try again</Link>
          </p>
        </div>
      </section>
    )
  }
  return (
    <div className="auth">
      <AddressList addresses={outcome.data} csrfToken={session.csrf} />
    </div>
  )
}
