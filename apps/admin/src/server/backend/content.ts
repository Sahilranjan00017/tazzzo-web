import 'server-only'
import { appConfigSchema } from '@/lib/appconfig'
import { BLOCK_ID, BLOCK_STATUSES, blockListSchema, blockSchema } from '@/lib/content'
import { readAsAdmin } from './session-read'

/** FAQs are content blocks on placement HELP (the default placement is HOME, so it is always sent explicitly). */
export function readFaqBlocks(status?: string) {
  const p = new URLSearchParams({ placement: 'HELP' })
  if (status && (BLOCK_STATUSES as readonly string[]).includes(status)) p.set('status', status)
  return readAsAdmin(`/api/v1/admin/content/blocks?${p.toString()}`, blockListSchema)
}
export function readBlock(id: string) {
  if (!BLOCK_ID.test(id)) throw new Error('invalid block id')
  return readAsAdmin(`/api/v1/admin/content/blocks/${encodeURIComponent(id)}`, blockSchema)
}
export const readAppConfig = () => readAsAdmin('/api/v1/admin/app-config', appConfigSchema)
