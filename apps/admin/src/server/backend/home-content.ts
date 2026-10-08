import 'server-only'
import { BLOCK_ID } from '@/lib/content'
import {
  AUDIENCES,
  channelOf,
  homeBlockSchema,
  homeListSchema,
  previewSchema,
  type PreviewQuery,
} from '@/lib/home-content'
import { readAsAdmin } from './session-read'

/** All HOME blocks (the backend returns up to 200, in display order: sort, then id). Placement is always sent. */
export function readHomeBlocks(filter: { status?: string; audience?: string } = {}) {
  const p = new URLSearchParams({ placement: 'HOME' })
  if (filter.status && ['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(filter.status))
    p.set('status', filter.status)
  if (filter.audience && (AUDIENCES as readonly string[]).includes(filter.audience))
    p.set('audience', filter.audience)
  return readAsAdmin(`/api/v1/admin/content/blocks?${p.toString()}`, homeListSchema)
}

export function readHomeBlock(id: string) {
  if (!BLOCK_ID.test(id)) throw new Error('invalid block id')
  return readAsAdmin(`/api/v1/admin/content/blocks/${encodeURIComponent(id)}`, homeBlockSchema)
}

/**
 * `GET /api/v1/admin/content/preview/home`: what one channel's Home would show at an instant, optionally with drafts as
 * if published. Admin-only and read-only on the backend: it never publishes anything.
 */
export function readHomePreview(q: PreviewQuery) {
  const p = new URLSearchParams({ channel: channelOf(q.view), drafts: String(q.drafts) })
  if (q.atUtc) p.set('at', q.atUtc)
  return readAsAdmin(`/api/v1/admin/content/preview/home?${p.toString()}`, previewSchema)
}
