import 'server-only'
import { z } from 'zod'
import { appConfigForm } from '@/lib/appconfig'
import { faqUpdateInput, faqWriteInput, statusInput } from '@/lib/content'
import type { BffMutationSpec } from './mutation'

const blockOut = z.object({ blockId: z.string(), status: z.string(), version: z.number().int() })
type BlockOut = z.infer<typeof blockOut>

/**
 * `POST /api/v1/admin/content/blocks` for an FAQ. Placement HELP and type FAQ are fixed here, never taken from the
 * browser. The backend always creates a DRAFT (v1); there is no idempotency key, so a repeat creates another draft.
 */
export const createFaqMutation: BffMutationSpec<
  z.infer<typeof faqWriteInput>,
  BlockOut,
  BlockOut
> = {
  routeId: 'content.faq.create',
  method: 'POST',
  input: faqWriteInput,
  backend: (v) => ({
    path: '/api/v1/admin/content/blocks',
    body: { placement: 'HELP', type: 'FAQ', ...v },
  }),
  output: blockOut,
  toClient: (o) => o,
}

/**
 * `PUT .../blocks/{id}`: full replace (an omitted publication bound is CLEARED by the backend). Editing a PUBLISHED entry
 * changes live content immediately. Type and placement are never sent (the backend rejects them).
 */
export const updateFaqMutation: BffMutationSpec<
  z.infer<typeof faqUpdateInput>,
  BlockOut,
  BlockOut
> = {
  routeId: 'content.faq.update',
  method: 'PUT',
  input: faqUpdateInput,
  backend: ({ blockId, ...rest }) => ({
    path: `/api/v1/admin/content/blocks/${encodeURIComponent(blockId)}`,
    body: rest,
  }),
  output: blockOut,
  toClient: (o) => o,
}

/** `POST .../blocks/{id}/status`: DRAFT <-> PUBLISHED, to ARCHIVED (final). Same-state is a 409 STATE_CONFLICT. */
export const blockStatusMutation: BffMutationSpec<
  z.infer<typeof statusInput>,
  BlockOut,
  BlockOut
> = {
  routeId: 'content.block.status',
  method: 'POST',
  input: statusInput,
  backend: ({ blockId, to, expectedVersion }) => ({
    path: `/api/v1/admin/content/blocks/${encodeURIComponent(blockId)}/status`,
    body: { to, expectedVersion },
  }),
  output: blockOut,
  toClient: (o) => o,
}

const appConfigOut = z.object({ version: z.number().int() })

/**
 * `PUT /api/v1/admin/app-config`: full replace of the single global document (version 0 creates). Blanks are `null`,
 * never empty strings (the backend rejects ""). Contains no secrets by design: links, versions and support contact only.
 */
export const putAppConfigMutation: BffMutationSpec<
  z.infer<typeof appConfigForm>,
  z.infer<typeof appConfigOut>,
  z.infer<typeof appConfigOut>
> = {
  routeId: 'content.app-config.put',
  method: 'PUT',
  input: appConfigForm as unknown as z.ZodType<z.infer<typeof appConfigForm>>,
  backend: (v) => ({ path: '/api/v1/admin/app-config', body: v }),
  output: appConfigOut,
  toClient: (o) => o,
}
