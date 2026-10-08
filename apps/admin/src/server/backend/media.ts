import 'server-only'
import { mediaSetSchema, type OwnerType } from '@/lib/media'
import { PRODUCT_ID } from '@/lib/products'
import { readAsAdmin } from './session-read'

export function readMediaSet(ownerType: OwnerType, ownerId: string) {
  if (!PRODUCT_ID.test(ownerId)) throw new Error('invalid owner id')
  return readAsAdmin(
    `/api/v1/admin/media/${ownerType}/${encodeURIComponent(ownerId)}`,
    mediaSetSchema,
  )
}
