import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { DeliveryChoice } from '@/components/DeliveryChoice'
import { isAddressId } from '@/lib/location/validation'
import { pageAddresses } from '@/server/address/service'
import { pageSlots } from '@/server/delivery/service'
import { readCheckoutChoice, readSession } from '@/server/session/cookies'
import { accessTokenUsable } from '@/server/session/service'

export const metadata: Metadata = { title: 'Delivery', robots: { index: false, follow: false } }

function firstString(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Delivery step: saved addresses (`GET /v1/customer/addresses`) and the slots for the chosen address's PIN
 * (`GET /v1/customer/delivery/slots`). Stops at "address and slot kept": placing the order (which is where the backend
 * takes `deliverySlotId`) is the next step.
 */
export default async function DeliveryPage({ searchParams }: PageProps<'/checkout/delivery'>) {
  const params = await searchParams
  const session = await readSession()
  if (session === null) redirect('/login?next=/checkout/delivery')
  const refresh = '/api/auth/refresh?next=/checkout/delivery'
  const list = await pageAddresses(session)
  if (!list.ok && list.error === 'unauthenticated') {
    redirect(accessTokenUsable(session) ? `${refresh}&rejected=1` : refresh)
  }
  if (!list.ok) {
    return (
      <section className="auth">
        <div className="panel">
          <h1>Delivery</h1>
          <p role="alert">
            We could not load your addresses right now.{' '}
            <Link href="/checkout/delivery">Try again</Link>
          </p>
        </div>
      </section>
    )
  }
  const addresses = list.data
  const asked = firstString(params.address)
  const choice = await readCheckoutChoice()
  const kept = choice?.customerId === session.customerId ? choice : null
  const wanted = isAddressId(asked) ? asked : (kept?.addressId ?? null)
  const selected =
    addresses.find((a) => a.addressId === wanted) ??
    addresses.find((a) => a.isDefault) ??
    addresses[0] ??
    null
  const slots = selected ? await pageSlots(session, selected.postalCode) : null
  if (slots && !slots.ok && slots.error === 'unauthenticated') {
    redirect(accessTokenUsable(session) ? `${refresh}&rejected=1` : refresh)
  }
  const view = slots?.ok ? slots.data : null
  const savedSlotId =
    kept &&
    selected &&
    kept.addressId === selected.addressId &&
    view?.slots.some((s) => s.slotId === kept.slotId && s.status === 'AVAILABLE')
      ? kept.slotId
      : null
  return (
    <div className="checkout-step">
      <DeliveryChoice
        addresses={addresses}
        addressId={selected?.addressId ?? null}
        slots={view}
        slotsError={slots !== null && !slots.ok}
        savedSlotId={savedSlotId}
        csrfToken={session.csrf}
      />
    </div>
  )
}
