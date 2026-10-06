import { z } from 'zod'

/** Audit-read contract (backend main c3306b6, `AdminAuditEventsController`). Client-safe. */
export const AUDIT_PAGE = 50

export const actorTypes = ['HUMAN_ADMIN', 'SERVICE_ACCOUNT', 'SYSTEM'] as const
const GRAMMAR = {
  actorId: /^(google:[A-Za-z0-9_-]{1,255}|service:[a-z0-9-]{1,32}|system:[A-Za-z0-9_.-]{1,64})$/,
  action: /^[A-Za-z][A-Za-z0-9_]{0,63}$/,
  targetType: /^[a-z][a-z0-9_]{0,63}$/,
  targetId: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/,
  requestId: /^req_[0-9a-f]{20}$/,
  cursor: /^[A-Za-z0-9_-]{1,128}$/,
} as const

export const auditEventSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  action: z.string(),
  targetType: z.string().nullish(),
  targetId: z.string().nullish(),
  actorType: z.string(),
  actorId: z.string().nullish(),
  credentialId: z.string().nullish(),
  requestId: z.string().nullish(),
})
export type AuditEvent = z.infer<typeof auditEventSchema>
export const auditListSchema = z.object({
  items: z.array(auditEventSchema),
  nextCursor: z.string().nullish(),
})

export interface AuditQuery {
  actorType?: string
  actorId?: string
  action?: string
  targetType?: string
  targetId?: string
  requestId?: string
  /** IST wall-clock `YYYY-MM-DDTHH:mm` as typed in the form (kept in the URL so views are bookmarkable). */
  fromLocal?: string
  toLocal?: string
  cursor?: string
}

const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/** IST wall time -> UTC instant with a `Z` suffix (IST is a fixed +05:30; there is no DST). */
export function istLocalToUtcIso(local: string): string | undefined {
  if (!LOCAL.test(local)) return undefined
  const t = Date.parse(`${local}:00.000Z`)
  if (Number.isNaN(t)) return undefined
  return new Date(t - IST_OFFSET_MS).toISOString()
}

type Raw = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim()

/** Parses the page URL into a backend-valid query; invalid values are dropped and explained, never sent. */
export function parseAuditQuery(raw: Raw): { query: AuditQuery; problems: string[] } {
  const problems: string[] = []
  const query: AuditQuery = {}
  const take = (key: keyof typeof GRAMMAR | 'actorType', ok: (v: string) => boolean) => {
    const v = first(raw[key])
    if (!v) return
    if (ok(v)) query[key] = v
    else problems.push(`Ignored invalid ${key}.`)
  }
  take('actorType', (v) => (actorTypes as readonly string[]).includes(v))
  take('actorId', (v) => GRAMMAR.actorId.test(v))
  take('action', (v) => GRAMMAR.action.test(v))
  take('targetType', (v) => GRAMMAR.targetType.test(v))
  take('targetId', (v) => GRAMMAR.targetId.test(v))
  take('requestId', (v) => GRAMMAR.requestId.test(v))
  take('cursor', (v) => GRAMMAR.cursor.test(v))
  if (query.targetId && !query.targetType) {
    delete query.targetId
    problems.push('Target id needs a target type, so it was not applied.')
  }
  for (const key of ['fromLocal', 'toLocal'] as const) {
    const v = first(raw[key])
    if (!v) continue
    if (istLocalToUtcIso(v)) query[key] = v
    else problems.push(`Ignored invalid ${key === 'fromLocal' ? 'from' : 'to'} time.`)
  }
  const from = query.fromLocal && istLocalToUtcIso(query.fromLocal)
  const to = query.toLocal && istLocalToUtcIso(query.toLocal)
  if (from && to && from > to) {
    delete query.fromLocal
    delete query.toLocal
    problems.push('The from time was after the to time, so the time range was not applied.')
  }
  return { query, problems }
}

/** Backend path. Only allowlisted keys, each at most once. */
export function auditPath(q: AuditQuery): string {
  const p = new URLSearchParams()
  for (const key of [
    'actorType',
    'actorId',
    'action',
    'targetType',
    'targetId',
    'requestId',
  ] as const) {
    if (q[key]) p.set(key, q[key]!)
  }
  if (q.fromLocal) p.set('from', istLocalToUtcIso(q.fromLocal)!)
  if (q.toLocal) p.set('to', istLocalToUtcIso(q.toLocal)!)
  if (q.cursor) p.set('cursor', q.cursor)
  p.set('limit', String(AUDIT_PAGE))
  return `/api/v1/admin/audit-events?${p.toString()}`
}

/** Page-URL search string for the filters (without the cursor): the cursor must be replayed with identical filters. */
export function auditFilterSearch(q: AuditQuery, cursor?: string): string {
  const p = new URLSearchParams()
  for (const key of [
    'actorType',
    'actorId',
    'action',
    'targetType',
    'targetId',
    'requestId',
    'fromLocal',
    'toLocal',
  ] as const) {
    if (q[key]) p.set(key, q[key]!)
  }
  if (cursor) p.set('cursor', cursor)
  const s = p.toString()
  return s ? `?${s}` : ''
}
