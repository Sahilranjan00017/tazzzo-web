import 'server-only'
import { z } from 'zod'
import { NODE_ID, RELEASE_ID, NODE_TYPES, nodeName } from '@/lib/taxonomy'
import type { BffMutationSpec } from './mutation'

const version = z.number().int().min(0).max(2_147_483_647)
const nodeOut = z.object({
  id: z.string(),
  nodeType: z.string(),
  name: z.string(),
  status: z.string(),
  version: z.number().int(),
})
type NodeOut = z.infer<typeof nodeOut>
const nodeClient = ({ id, nodeType, name, status, version }: NodeOut) => ({
  id,
  nodeType,
  name,
  status,
  version,
})
type NodeClient = ReturnType<typeof nodeClient>

const createInput = z
  .object({
    nodeType: z.enum(NODE_TYPES),
    name: nodeName,
    parentId: z.string().regex(NODE_ID).nullable(),
    attributeSchemaId: z.string().regex(NODE_ID).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.nodeType === 'super_category' && v.parentId !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['parentId'],
        message: 'a super category has no parent',
      })
    if (v.nodeType !== 'super_category' && v.parentId === null)
      ctx.addIssue({ code: 'custom', path: ['parentId'], message: 'a parent is required' })
    if (v.nodeType === 'vertical' && !v.attributeSchemaId)
      ctx.addIssue({
        code: 'custom',
        path: ['attributeSchemaId'],
        message: 'a vertical needs an attribute schema',
      })
    if (v.nodeType !== 'vertical' && v.attributeSchemaId)
      ctx.addIssue({
        code: 'custom',
        path: ['attributeSchemaId'],
        message: 'only verticals take a schema',
      })
  })

/** `POST /api/v1/taxonomy/nodes`. Needs an open release (409 NO_OPEN_RELEASE otherwise); not idempotent. */
export const createNodeMutation: BffMutationSpec<
  z.infer<typeof createInput>,
  NodeOut,
  NodeClient
> = {
  routeId: 'catalog.taxonomy.create',
  method: 'POST',
  input: createInput,
  backend: (input) => ({ path: '/api/v1/taxonomy/nodes', body: input }),
  output: nodeOut,
  toClient: nodeClient,
}

export const NODE_ACTIONS = ['rename', 'deprecate', 'revive'] as const
export type NodeAction = (typeof NODE_ACTIONS)[number]

const renameInput = z
  .object({ nodeId: z.string().regex(NODE_ID), name: nodeName, expectedVersion: version })
  .strict()
const stateInput = z
  .object({ nodeId: z.string().regex(NODE_ID), expectedVersion: version })
  .strict()

/** rename / deprecate / revive: `POST /api/v1/taxonomy/nodes/{id}/{action}` with `expectedVersion` in the body. */
export function nodeActionMutation(
  action: NodeAction,
): BffMutationSpec<
  { nodeId: string; expectedVersion: number; name?: string },
  NodeOut,
  NodeClient
> {
  const input = (action === 'rename' ? renameInput : stateInput) as z.ZodType<{
    nodeId: string
    expectedVersion: number
    name?: string
  }>
  return {
    routeId: `catalog.taxonomy.${action}`,
    method: 'POST',
    input,
    backend: ({ nodeId, name, expectedVersion }) => ({
      path: `/api/v1/taxonomy/nodes/${encodeURIComponent(nodeId)}/${action}`,
      body: action === 'rename' ? { name, expectedVersion } : { expectedVersion },
    }),
    output: nodeOut,
    toClient: nodeClient,
  }
}

const releaseOut = z.object({ id: z.string() })
const openReleaseInput = z
  .object({
    releaseId: z.string().regex(RELEASE_ID),
    basedOn: z.string().regex(RELEASE_ID).optional(),
  })
  .strict()

/** `POST /api/v1/taxonomy/releases`: open a release. 409 RELEASE_ALREADY_OPEN if one is open or the id exists. */
export const openReleaseMutation: BffMutationSpec<
  z.infer<typeof openReleaseInput>,
  z.infer<typeof releaseOut>,
  { id: string }
> = {
  routeId: 'catalog.taxonomy.release.open',
  method: 'POST',
  input: openReleaseInput,
  backend: (input) => ({ path: '/api/v1/taxonomy/releases', body: input }),
  output: releaseOut,
  toClient: ({ id }) => ({ id }),
}

const publishInput = z.object({ releaseId: z.string().regex(RELEASE_ID) }).strict()

/** `POST /api/v1/taxonomy/releases/{id}/publish`: synchronous; makes the open release's changes visible to consumers. */
export const publishReleaseMutation: BffMutationSpec<
  z.infer<typeof publishInput>,
  z.infer<typeof releaseOut>,
  { id: string }
> = {
  routeId: 'catalog.taxonomy.release.publish',
  method: 'POST',
  input: publishInput,
  backend: ({ releaseId }) => ({
    path: `/api/v1/taxonomy/releases/${encodeURIComponent(releaseId)}/publish`,
    body: undefined,
  }),
  output: releaseOut,
  toClient: ({ id }) => ({ id }),
}
