import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { auditFilterSearch, auditPath, istLocalToUtcIso, parseAuditQuery } from '@/lib/audit'
import { healthSchema } from '@/lib/health'
import { backendRead } from '@/server/backend/read'

describe('IST conversion', () => {
  it('converts IST wall time to a UTC Z instant (fixed +05:30)', () => {
    expect(istLocalToUtcIso('2026-10-06T09:00')).toBe('2026-10-06T03:30:00.000Z')
    expect(istLocalToUtcIso('2026-01-01T00:00')).toBe('2025-12-31T18:30:00.000Z')
  })
  it('rejects malformed or impossible values', () => {
    for (const bad of ['', '2026-10-06', '2026-10-06T9:00', '2026-13-40T10:00', 'x'])
      expect(istLocalToUtcIso(bad)).toBeUndefined()
  })
})

describe('audit query', () => {
  it('builds only allowlisted params, UTC times, a bounded limit and the cursor', () => {
    const { query } = parseAuditQuery({
      actorType: 'HUMAN_ADMIN',
      action: 'PRICE_SET',
      targetType: 'product',
      targetId: 'TZP-1',
      fromLocal: '2026-10-06T09:00',
      cursor: 'abc_-1',
    })
    expect(auditPath(query)).toBe(
      '/api/v1/admin/audit-events?actorType=HUMAN_ADMIN&action=PRICE_SET&targetType=product&targetId=TZP-1&from=2026-10-06T03%3A30%3A00.000Z&cursor=abc_-1&limit=50',
    )
  })
  it('drops grammar violations with an explanation, never sending them', () => {
    const { query, problems } = parseAuditQuery({
      actorId: 'bob',
      action: '1bad',
      requestId: 'req_zz',
      targetType: 'Bad',
      actorType: 'ROOT',
    })
    expect(query).toEqual({})
    expect(problems.length).toBe(5)
  })
  it('targetId needs targetType; an inverted range is dropped', () => {
    const a = parseAuditQuery({ targetId: 'TZP-1' })
    expect(a.query).toEqual({})
    expect(a.problems.join()).toMatch(/needs a target type/)
    const b = parseAuditQuery({ fromLocal: '2026-10-07T09:00', toLocal: '2026-10-06T09:00' })
    expect(b.query).toEqual({})
    expect(b.problems.join()).toMatch(/after the to time/)
  })
  it('accepts valid ids and keeps filters in page links, cursor only when given', () => {
    const { query } = parseAuditQuery({
      actorId: 'google:123_abc',
      requestId: 'req_0123456789abcdef0123',
    })
    expect(query).toEqual({ actorId: 'google:123_abc', requestId: 'req_0123456789abcdef0123' })
    expect(auditFilterSearch(query)).toBe(
      '?actorId=google%3A123_abc&requestId=req_0123456789abcdef0123',
    )
    expect(auditFilterSearch(query, 'c1')).toContain('cursor=c1')
    expect(auditFilterSearch({})).toBe('')
  })
})

describe('anonymous health reads', () => {
  const dep = (fetchImpl: typeof fetch, parseAlso?: number[]) => ({
    backendUrl: 'https://api.test',
    fetchImpl,
    parseAlso,
  })
  it('sends no Authorization header at all', async () => {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ status: 'UP', components: { datastore: 'OPEN' } }), {
          status: 200,
        }),
    )
    const r = await backendRead(dep(f), '/health/live', healthSchema)
    expect(r).toMatchObject({ kind: 'ok', httpStatus: 200, data: { status: 'UP' } })
    expect(f.mock.calls[0]![1]?.headers).toEqual({ Accept: 'application/json' })
  })
  it('parses a 503 body only for statuses the caller opted into', async () => {
    const down = () =>
      new Response(JSON.stringify({ status: 'DOWN', components: { mongo: 'DOWN' } }), {
        status: 503,
      })
    expect(
      await backendRead(dep(vi.fn(async () => down())), '/health/ready', healthSchema),
    ).toMatchObject({ kind: 'unavailable', reason: 'status' })
    expect(
      await backendRead(
        dep(
          vi.fn(async () => down()),
          [503],
        ),
        '/health/ready',
        healthSchema,
      ),
    ).toMatchObject({ kind: 'ok', httpStatus: 503, data: { components: { mongo: 'DOWN' } } })
  })
  it('still rejects an unexpected body shape', async () => {
    const f = vi.fn(async () => new Response('{"nope":1}', { status: 200 }))
    expect(await backendRead(dep(f), '/h', z.object({ status: z.string() }))).toMatchObject({
      reason: 'shape',
    })
  })
})
