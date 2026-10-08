import 'server-only'
import { z } from 'zod'
import {
  contentUploadInput,
  homeUpdateInput,
  homeWriteInput,
  reorderInput,
  type HomeUpdate,
  type HomeWrite,
  type ReorderInput,
} from '@/lib/home-content'
import type { UploadTarget } from '@/lib/upload'
import type { BffMutationSpec } from './mutation'
import { toUploadTarget, uploadOriginPrecondition, uploadTargetOut } from './upload-target'

const blockOut = z.object({ blockId: z.string(), status: z.string(), version: z.number().int() })
type BlockOut = z.infer<typeof blockOut>

/**
 * `POST /api/v1/admin/content/blocks` for HOME: placement is fixed here (never from the browser); the backend always
 * creates a DRAFT (version 1). No idempotency key exists, so a repeated create is another draft (the UI guards it).
 */
export const createHomeBlockMutation: BffMutationSpec<HomeWrite, BlockOut, BlockOut> = {
  routeId: 'content.home.create',
  method: 'POST',
  input: homeWriteInput,
  backend: (v) => ({ path: '/api/v1/admin/content/blocks', body: { placement: 'HOME', ...v } }),
  output: blockOut,
  toClient: (o) => o,
}

/**
 * `PUT .../blocks/{id}`: full replace (an omitted window bound is CLEARED) with the version the editor loaded. `type` and
 * `placement` are never sent (the backend rejects them); `audience` is always sent so it is never left to a default.
 */
export const updateHomeBlockMutation: BffMutationSpec<HomeUpdate, BlockOut, BlockOut> = {
  routeId: 'content.home.update',
  method: 'PUT',
  input: homeUpdateInput,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- `type` only selects the payload schema
  backend: ({ blockId, type, ...body }) => ({
    path: `/api/v1/admin/content/blocks/${encodeURIComponent(blockId)}`,
    body,
  }),
  output: blockOut,
  toClient: (o) => o,
}

const reorderOut = z.object({ items: z.array(z.object({ blockId: z.string() })) })

/**
 * `POST .../blocks/reorder` for HOME: every non-archived block once, each with its loaded version; all or nothing (409
 * STALE_VERSION if anything changed meanwhile). The backend re-sequences sort as 10, 20, 30...
 */
export const reorderHomeMutation: BffMutationSpec<
  ReorderInput,
  z.infer<typeof reorderOut>,
  { count: number }
> = {
  routeId: 'content.home.reorder',
  method: 'POST',
  input: reorderInput,
  backend: ({ order }) => ({
    path: '/api/v1/admin/content/blocks/reorder',
    body: { placement: 'HOME', order },
  }),
  output: reorderOut,
  toClient: (o) => ({ count: o.items.length }),
}

/**
 * `POST /api/v1/admin/content/uploads`: a presigned single-use target for one banner image under `c/home/`, validated
 * exactly like media targets (configured storage origin only, no credential headers).
 */
export const requestContentUploadMutation: BffMutationSpec<
  z.infer<typeof contentUploadInput>,
  z.infer<typeof uploadTargetOut>,
  UploadTarget
> = {
  routeId: 'content.home.upload-request',
  method: 'POST',
  input: contentUploadInput,
  backend: (input) => ({ path: '/api/v1/admin/content/uploads', body: input }),
  output: uploadTargetOut,
  toClient: toUploadTarget,
  precondition: uploadOriginPrecondition,
}
