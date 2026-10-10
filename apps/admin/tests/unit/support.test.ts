import { beforeAll, describe, expect, it } from 'vitest'
import {
  CASE_ID,
  caseListPath,
  parseCaseListQuery,
  replyText,
  staffCaseSchema,
  supportErrorMessage,
  targetsFor,
} from '@/lib/support'

describe('support lib', () => {
  it('parses the backend StaffCase payload: message ids are integers (SupportDtos.StaffMessage int id)', () => {
    const backendShape = {
      caseId: 'SUP_abc123',
      customerId: 'CUS_1',
      category: 'ORDER',
      orderId: 'ORD_1',
      subject: 'Late delivery',
      status: 'OPEN',
      assignedTo: null,
      version: 3,
      messages: [
        {
          id: 1,
          author: 'CUSTOMER',
          staffId: null,
          text: 'where is it',
          at: '2026-10-10T05:00:00Z',
        },
        {
          id: 2,
          author: 'STAFF',
          staffId: 'staff-1',
          text: 'on its way',
          at: '2026-10-10T05:05:00Z',
        },
      ],
      createdAt: '2026-10-10T05:00:00Z',
      updatedAt: '2026-10-10T05:05:00Z',
    }
    const ok = staffCaseSchema.safeParse(backendShape)
    expect(ok.success).toBe(true)
    expect(ok.data?.messages.map((m) => m.id)).toEqual([1, 2])
    // a string id is NOT what the backend sends: it must not be accepted (the fake backend once hid this)
    expect(
      staffCaseSchema.safeParse({
        ...backendShape,
        messages: [{ ...backendShape.messages[0], id: 'm1' }],
      }).success,
    ).toBe(false)
  })

  it('list path carries only a valid status/cursor and page_size', () => {
    expect(caseListPath(parseCaseListQuery({}))).toBe('/api/v1/admin/support/cases?page_size=20')
    expect(caseListPath(parseCaseListQuery({ status: 'RESOLVED', cursor: 'abc_-9' }))).toBe(
      '/api/v1/admin/support/cases?status=RESOLVED&cursor=abc_-9&page_size=20',
    )
    expect(parseCaseListQuery({ status: 'bogus', cursor: 'a b' })).toEqual({})
  })
  it('status targets exclude OPEN and the current state; CLOSED is final; resolved can reopen', () => {
    expect(targetsFor('OPEN')).toEqual(['IN_PROGRESS', 'RESOLVED', 'CLOSED'])
    expect(targetsFor('IN_PROGRESS')).toEqual(['RESOLVED', 'CLOSED'])
    expect(targetsFor('RESOLVED')).toEqual(['IN_PROGRESS', 'CLOSED'])
    expect(targetsFor('CLOSED')).toEqual([])
  })
  it('reply text: trimmed, 1..2000, newline allowed, other control characters refused', () => {
    expect(replyText.safeParse('  hello\nworld  ').data).toBe('hello\nworld')
    expect(replyText.safeParse('   ').success).toBe(false)
    expect(replyText.safeParse('x'.repeat(2001)).success).toBe(false)
    expect(replyText.safeParse('bad\u0007').success).toBe(false)
    expect(replyText.safeParse('tab\there').success).toBe(false)
  })
  it('case ids must look like SUP_… and cannot carry path characters', () => {
    expect(CASE_ID.test('SUP_abc123')).toBe(true)
    for (const bad of ['abc', 'SUP_', 'SUP_a/b', 'SUP_../x', 'sup_a'])
      expect(CASE_ID.test(bad)).toBe(false)
  })
  it('error copy covers the backend codes, and warns a 5xx reply may already have been sent', () => {
    const f = (status: number, code?: string) => ({ ok: false as const, status, error: 'x', code })
    expect(supportErrorMessage(f(409, 'MESSAGE_LIMIT'))).toMatch(/100-message/)
    expect(supportErrorMessage(f(409, 'STATE_CONFLICT'))).toMatch(/not in a state/)
    expect(supportErrorMessage(f(502))).toMatch(/may already have been sent/)
  })
})

describe('support BFF specs', () => {
  let a: typeof import('@/server/bff/support-actions')
  beforeAll(async () => {
    a = await import('@/server/bff/support-actions')
  })
  it('reply sends exactly {message}, no version', () => {
    const input = a.replyMutation.input.parse({ caseId: 'SUP_1', message: ' hi ' })
    expect(a.replyMutation.backend(input)).toEqual({
      path: '/api/v1/admin/support/cases/SUP_1/messages',
      body: { message: 'hi' },
    })
    expect(
      a.replyMutation.input.safeParse({ caseId: 'SUP_1', message: 'x', expectedVersion: 1 })
        .success,
    ).toBe(false)
  })
  it('assign and status require a version; OPEN is never a status target', () => {
    expect(a.assignMutation.input.safeParse({ caseId: 'SUP_1', expectedVersion: 0 }).success).toBe(
      false,
    )
    expect(a.assignMutation.backend({ caseId: 'SUP_1', expectedVersion: 3 }).body).toEqual({
      expectedVersion: 3,
    })
    expect(
      a.statusMutation.input.safeParse({ caseId: 'SUP_1', to: 'OPEN', expectedVersion: 1 }).success,
    ).toBe(false)
    expect(
      a.statusMutation.backend({ caseId: 'SUP_1', to: 'RESOLVED', expectedVersion: 2 }),
    ).toEqual({
      path: '/api/v1/admin/support/cases/SUP_1/status',
      body: { to: 'RESOLVED', expectedVersion: 2 },
    })
  })
})
