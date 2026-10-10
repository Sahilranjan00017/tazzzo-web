import 'server-only'
import { z } from 'zod'
import type { Slot, SlotsView } from '@/lib/delivery/slots'
import { isPin, isSlotId } from '@/lib/location/validation'
import { sendJson } from '@/server/backend/client'
import { addressFailure, type AddressCallResult } from '@/server/backend/addresses'

/**
 * `GET /v1/customer/delivery/slots?pin=` (tazzzo-backend `DeliverySlotController`, bearer): the delivery windows for a
 * PIN over the next `tazzzo.delivery.horizon-days` (default 3; `days` is left to that default). The answer is
 * `{serviceable, timezone, slots[]}`; an unserviceable PIN is `serviceable:false` with no slots. A slot carries a
 * status only (`AVAILABLE`/`FULL`/`CLOSED`), never a capacity count, and is computed fresh on every read (nothing is
 * reserved by reading). Nothing in the contract stores a slot choice before the order: the slot id goes to the order
 * placement (`deliverySlotId`) in the next step. A status this site does not know is treated as `CLOSED`.
 */
const slot = z.object({
  slotId: z.string().refine(isSlotId),
  date: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  startsAt: z.string().min(10).max(40),
  endsAt: z.string().min(10).max(40),
  label: z.string().min(1).max(120),
  status: z.string().max(32),
})
const body = z.object({
  serviceable: z.boolean(),
  timezone: z.string().min(1).max(64),
  slots: z.array(slot).max(400),
})

export async function listSlots(
  accessToken: string,
  pin: string,
): Promise<AddressCallResult<SlotsView>> {
  if (!isPin(pin)) throw new Error('canonical PINs only')
  const result = await sendJson('GET', `/v1/customer/delivery/slots?pin=${pin}`, {
    bearer: accessToken,
  })
  if (!result.ok) return addressFailure(result)
  const parsed = body.safeParse(result.data)
  if (!parsed.success) {
    console.warn('storefront_backend_malformed path=/v1/customer/delivery/slots')
    return { ok: false, reason: 'unavailable', retryAfterSeconds: null }
  }
  const slots: Slot[] = parsed.data.slots.map((s) => ({
    ...s,
    status: s.status === 'AVAILABLE' || s.status === 'FULL' ? s.status : 'CLOSED',
  }))
  return {
    ok: true,
    data: { serviceable: parsed.data.serviceable, timezone: parsed.data.timezone, slots },
  }
}
