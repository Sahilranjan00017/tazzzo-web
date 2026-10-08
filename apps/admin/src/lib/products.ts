import { z } from 'zod'
import type { Tone } from '@/components/ui/primitives'

/**
 * Product contract (backend main c3306b6, `ProductController`). Client-safe: schemas, lifecycle rules and list-query
 * parsing only. The backend remains the authority for every rule mirrored here.
 */
export const PRODUCT_ID = /^TZP-[A-Z0-9][A-Z0-9-]{0,39}$/
/** Backend list-filter value grammar (`AdminListParams`). */
export const FILTER_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/

export const LIFECYCLES = [
  'draft',
  'active',
  'merging',
  'discontinued',
  'archived',
  'merged',
] as const
export type Lifecycle = (typeof LIFECYCLES)[number]

export const CLASSIFICATION_STATUSES = [
  'confirmed',
  'provisional',
  'review',
  'scope_blocked',
] as const

export const productSummarySchema = z.object({
  id: z.string(),
  productType: z.string(),
  lifecycle: z.string(),
  brandCode: z.string().nullish(),
  title: z.string(),
  verticalId: z.string().nullish(),
  classificationStatus: z.string().nullish(),
  version: z.number().int(),
})
export type ProductSummary = z.infer<typeof productSummarySchema>

export const productListSchema = z.object({
  items: z.array(productSummarySchema),
  nextCursor: z.string().nullish(),
})

export const productDetailSchema = z.object({
  id: z.string(),
  productType: z.string(),
  lifecycle: z.string(),
  brandCode: z.string().nullish(),
  title: z.string(),
  classification: z
    .object({
      verticalId: z.string().nullish(),
      releaseId: z.string().nullish(),
      status: z.string().nullish(),
    })
    .nullish(),
  attributes: z.record(z.string(), z.unknown()).nullish(),
  version: z.number().int(),
  taxonomyPath: z.string().nullish(),
})
export type ProductDetail = z.infer<typeof productDetailSchema>

/** The backend stringifies a missing vertical/release as the literal "null". Show that as absent, never as a value. */
export function realValue(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value === 'null' || value === ''
    ? undefined
    : value
}

export const LIFECYCLE_TONE: Record<string, Tone> = {
  draft: 'neutral',
  active: 'success',
  merging: 'warning',
  discontinued: 'warning',
  archived: 'neutral',
  merged: 'neutral',
}

/** Legal lifecycle transitions (`ProductLifecycleService`): draft->active, active->discontinued, discontinued->active|archived. */
export type LifecycleAction = 'activate' | 'retire' | 'revive' | 'archive'
export const LIFECYCLE_ACTIONS: readonly LifecycleAction[] = [
  'activate',
  'retire',
  'revive',
  'archive',
]

export const ACTIONS_BY_STATE: Record<string, readonly LifecycleAction[]> = {
  draft: ['activate'],
  active: ['retire'],
  discontinued: ['revive', 'archive'],
}

export const ACTION_COPY: Record<
  LifecycleAction,
  { label: string; confirm: string; destructive: boolean; result: string }
> = {
  activate: {
    label: 'Activate',
    confirm: 'Activate this product? It becomes eligible for sale once price and stock exist.',
    destructive: false,
    result: 'active',
  },
  retire: {
    label: 'Retire',
    confirm: 'Retire this product? It is marked discontinued and stops being sold.',
    destructive: true,
    result: 'discontinued',
  },
  revive: {
    label: 'Revive',
    confirm: 'Revive this discontinued product back to active?',
    destructive: false,
    result: 'active',
  },
  archive: {
    label: 'Archive',
    confirm: 'Archive this product? Archived is terminal and cannot be undone.',
    destructive: true,
    result: 'archived',
  },
}

export interface ProductListQuery {
  verticalId?: string
  lifecycle?: string
  status?: string
  cursor?: string
  limit: number
}

export const PAGE_SIZE = 50

type Raw = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

/**
 * Parses the page's URL state into a backend-valid list query. Invalid values are dropped and reported (never sent).
 * `lifecycle` and `status` need a `verticalId` (backend 400 otherwise), so they are dropped without one.
 */
export function parseProductListQuery(raw: Raw): { query: ProductListQuery; problems: string[] } {
  const problems: string[] = []
  const pick = (key: string, valid: (v: string) => boolean): string | undefined => {
    const v = one(raw[key])?.trim()
    if (!v) return undefined
    if (!valid(v)) {
      problems.push(`Ignored invalid ${key}.`)
      return undefined
    }
    return v
  }
  const verticalId = pick('verticalId', (v) => FILTER_VALUE.test(v))
  const lifecycle = pick('lifecycle', (v) => (LIFECYCLES as readonly string[]).includes(v))
  const status = pick('status', (v) => (CLASSIFICATION_STATUSES as readonly string[]).includes(v))
  const cursor = pick('cursor', (v) => FILTER_VALUE.test(v) || PRODUCT_ID.test(v))
  const query: ProductListQuery = { limit: PAGE_SIZE }
  if (verticalId) {
    query.verticalId = verticalId
    if (lifecycle) query.lifecycle = lifecycle
    if (status) query.status = status
  } else if (lifecycle || status) {
    problems.push(
      'Lifecycle and classification filters need a vertical id, so they were not applied.',
    )
  }
  if (cursor) query.cursor = cursor
  return { query, problems }
}

/** Backend path for a parsed query. Only allowlisted keys are ever emitted. */
export function productListPath(q: ProductListQuery): string {
  const p = new URLSearchParams()
  for (const key of ['verticalId', 'lifecycle', 'status', 'cursor'] as const) {
    const v = q[key]
    if (v) p.set(key, v)
  }
  p.set('limit', String(q.limit))
  return `/api/v1/products?${p.toString()}`
}

/** Query string for the CMS page URL (bookmarkable), without paging state. */
export function filterSearch(
  q: Pick<ProductListQuery, 'verticalId' | 'lifecycle' | 'status'>,
): string {
  const p = new URLSearchParams()
  for (const key of ['verticalId', 'lifecycle', 'status'] as const) if (q[key]) p.set(key, q[key])
  return p.toString()
}
