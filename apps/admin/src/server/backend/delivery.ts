import 'server-only'
import {
  AREA_ID,
  PINCODE,
  areaListPath,
  areaListSchema,
  areaSchema,
  windowListSchema,
} from '@/lib/delivery'
import { readAsAdmin } from './session-read'

function enc(id: string, pattern: RegExp): string {
  if (!pattern.test(id)) throw new Error('invalid identifier')
  return encodeURIComponent(id)
}
export const readAreas = (q: { after?: string }) => readAsAdmin(areaListPath(q), areaListSchema)
export const readArea = (pincode: string) =>
  readAsAdmin(`/api/v1/admin/service-areas/${enc(pincode, PINCODE)}`, areaSchema)
export const readWindows = (areaId: string) =>
  readAsAdmin(`/api/v1/admin/delivery-slots/${enc(areaId, AREA_ID)}`, windowListSchema)
