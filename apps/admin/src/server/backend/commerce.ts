import 'server-only'
import { LOCATION_ID, inventorySchema, priceSchema } from '@/lib/commerce'
import { PRODUCT_ID } from '@/lib/products'
import { readAsAdmin } from './session-read'

function enc(id: string, pattern: RegExp): string {
  if (!pattern.test(id)) throw new Error('invalid identifier')
  return encodeURIComponent(id)
}
export const readPrice = (skuId: string) =>
  readAsAdmin(`/api/v1/admin/prices/${enc(skuId, PRODUCT_ID)}`, priceSchema)
export const readInventory = (skuId: string, locationId: string) =>
  readAsAdmin(
    `/api/v1/admin/inventory/${enc(skuId, PRODUCT_ID)}/${enc(locationId, LOCATION_ID)}`,
    inventorySchema,
  )
