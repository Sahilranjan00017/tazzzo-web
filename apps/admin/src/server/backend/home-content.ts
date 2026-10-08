import 'server-only'
import type { BackendReadResult } from '@/lib/backend-result'
import { BLOCK_ID } from '@/lib/content'
import {
  AUDIENCES,
  channelOf,
  homeBlockSchema,
  homeListSchema,
  previewSchema,
  type HomeBlock,
  type PreviewQuery,
} from '@/lib/home-content'

/** The backend's per-request list cap (`ContentService.MAX_BLOCKS_PER_PLACEMENT`). */
const MAX_LIST = 200
type HomeList = { items: HomeBlock[] }
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

/**
 * HOME blocks for the module, read per stored status so the active set is COMPLETE: the backend list is capped at 200
 * INCLUDING archived blocks (`ContentService.list` `.limit(200)`), while active (draft + published) blocks are capped
 * at 200 on create. Draft and published are therefore always all there (a reorder must name every one of them); only
 * archived blocks can be cut, which is flagged. A status filter reads just that status. Merged in display order.
 */
export async function readHomeBlocksComplete(
  filter: { status?: string; audience?: string } = {},
): Promise<
  Exclude<BackendReadResult<HomeList & { archivedCapped: boolean }>, { kind: 'unauthenticated' }>
> {
  const statuses = filter.status ? [filter.status] : ['DRAFT', 'PUBLISHED', 'ARCHIVED']
  const results = await Promise.all(
    statuses.map((status) => readHomeBlocks({ status, audience: filter.audience })),
  )
  for (const r of results) if (r.kind !== 'ok') return r
  const lists = results.map((r) => (r.kind === 'ok' ? r.data.items : []))
  const items = lists
    .flat()
    .sort((a, b) => a.sort - b.sort || (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0))
  const archivedCapped = statuses.some((st, i) => st === 'ARCHIVED' && lists[i]!.length >= MAX_LIST)
  return { kind: 'ok', data: { items, archivedCapped } }
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
