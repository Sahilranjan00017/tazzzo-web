import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { LocationForm } from '@/components/LocationForm'
import { returnPath } from '@/lib/location/validation'
import { pageAddresses } from '@/server/address/service'
import { cartAddressId, currentLocation } from '@/server/location/service'
import { readSession } from '@/server/session/cookies'
import { accessTokenUsable } from '@/server/session/service'

export const metadata: Metadata = {
  title: 'Delivery location',
  robots: { index: false, follow: false },
}

function firstString(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Where to deliver: a PIN code check for anyone (`GET /v1/serviceability`), and for a signed-in customer a choice among
 * saved addresses (`GET /v1/customer/addresses`). The choice is stored in a sealed cookie and sent to the backend with
 * every product, search, list and cart read.
 */
export default async function LocationPage({ searchParams }: PageProps<'/location'>) {
  const next = returnPath(firstString((await searchParams).next))
  const session = await readSession()
  const location = await currentLocation(session)
  const outcome = session ? await pageAddresses(session) : null
  if (session && outcome && !outcome.ok && outcome.error === 'unauthenticated') {
    // An access token we consider expired is refreshed; one the backend refused moments after issue ends the session.
    const back = encodeURIComponent(`/location?${new URLSearchParams({ next })}`)
    redirect(`/api/auth/refresh?next=${back}${accessTokenUsable(session) ? '&rejected=1' : ''}`)
  }
  const addresses = outcome?.ok ? outcome.data : null
  return (
    <div className="auth">
      <LocationForm
        initial={location}
        csrfToken={session?.csrf ?? null}
        addresses={addresses}
        selectedAddressId={await cartAddressId(session)}
        next={next}
      />
    </div>
  )
}
