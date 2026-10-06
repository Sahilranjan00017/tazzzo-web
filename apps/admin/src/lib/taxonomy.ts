import { z } from 'zod'
import type { Tone } from '@/components/ui/primitives'
import type { BffResult } from './bff-client'
import { bffErrorMessage } from './bff-client'
import { FILTER_VALUE } from './products'

/** Taxonomy contract (backend main c3306b6, `TaxonomyController`). Client-safe schemas, rules and copy. */
export const NODE_ID = FILTER_VALUE
export const RELEASE_ID = FILTER_VALUE

export const NODE_TYPES = ['super_category', 'category', 'sub_category', 'vertical'] as const
export type NodeType = (typeof NODE_TYPES)[number]

export const NODE_TYPE_LABEL: Record<string, string> = {
  super_category: 'Super category',
  category: 'Category',
  sub_category: 'Subcategory',
  vertical: 'Vertical',
}

/** A child is always exactly one level below its parent; verticals are leaves. */
export const CHILD_TYPE: Partial<Record<string, NodeType>> = {
  super_category: 'category',
  category: 'sub_category',
  sub_category: 'vertical',
}

export const nodeSchema = z.object({
  id: z.string(),
  nodeType: z.string(),
  name: z.string(),
  parentId: z.string().nullish(),
  status: z.string(),
  attributeSchemaId: z.string().nullish(),
  version: z.number().int(),
})
export type TaxonomyNode = z.infer<typeof nodeSchema>

export const nodeListSchema = z.object({
  items: z.array(nodeSchema),
  nextCursor: z.string().nullish(),
})

export const nodePathSchema = z.object({
  verticalId: z.string().nullish(),
  path: z.string().nullish(),
  nodes: z
    .array(z.object({ id: z.string(), name: z.string(), nodeType: z.string().nullish() }))
    .default([]),
})

export const releaseSchema = z.object({
  id: z.string(),
  status: z.string(),
  basedOn: z.string().nullish(),
})

export const STATUS_TONE: Record<string, Tone> = {
  active: 'success',
  deprecated: 'warning',
  merged: 'neutral',
  publishing: 'info',
  freezing: 'warning',
}

/** Node name rules (`TaxonomyChangeService`): trimmed, non-blank, no control characters, at most 120. */
export const nodeName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'no control characters')

type Raw = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export interface NodeListQuery {
  parentId?: string
  cursor?: string
  limit: number
}

/** `?parent=<node id>&cursor=<id>`. Roots are the super categories (the backend cannot filter `parentId=null`). */
export function parseNodeListQuery(raw: Raw): NodeListQuery {
  const parent = first(raw.parent)?.trim()
  const cursor = first(raw.cursor)?.trim()
  return {
    ...(parent && NODE_ID.test(parent) ? { parentId: parent } : {}),
    ...(cursor && NODE_ID.test(cursor) ? { cursor } : {}),
    limit: 100,
  }
}

export function nodeListPath(q: NodeListQuery): string {
  const p = new URLSearchParams()
  if (q.parentId) p.set('parentId', q.parentId)
  else p.set('nodeType', 'super_category')
  if (q.cursor) p.set('cursor', q.cursor)
  p.set('limit', String(q.limit))
  return `/api/v1/taxonomy/nodes?${p.toString()}`
}

/** Operator copy for the taxonomy-specific backend codes; anything else falls back to the generic message. */
const CODE_COPY: Record<string, string> = {
  NO_OPEN_RELEASE:
    'No taxonomy release is open, so the backend refuses catalogue changes. Open a release first (Taxonomy > Releases).',
  RELEASE_ALREADY_OPEN:
    'Another release is already open, or this release id already exists. The backend does not say which release is open, so look it up by id on the Releases page.',
  RELEASE_NOT_OPEN: 'That release is missing or already active, so it cannot be published.',
  DUPLICATE_NODE: 'A sibling with this name already exists under the same parent.',
  NODE_NOT_ACTIVE: 'The parent must be active before children can be added.',
  HAS_ACTIVE_CHILDREN: 'This node still has active children. Deprecate or move them first.',
  UNKNOWN_SCHEMA: 'That attribute schema does not exist.',
  NODE_NOT_FOUND: 'That node does not exist.',
  NOT_DEPRECATED: 'Only a deprecated node can be revived.',
  INVALID_PARENT: 'The parent is not valid for this change.',
  INVALID_NODE: 'The backend rejected the node (check name, level and attribute schema).',
}

export function taxonomyErrorMessage(result: Extract<BffResult<unknown>, { ok: false }>): string {
  if (result.code && CODE_COPY[result.code]) return CODE_COPY[result.code]!
  return bffErrorMessage(result, 'taxonomy change')
}
