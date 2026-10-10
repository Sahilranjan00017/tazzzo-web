import { beforeAll, describe, expect, it } from 'vitest'
import {
  LEGAL_BODY_MAX,
  legalBodyProblem,
  legalUpdateInput,
  legalWriteInput,
  liveLegalFor,
  validIsoDate,
  type ContentBlock,
} from '@/lib/content'

const ok = {
  title: 'Terms of Service',
  sort: 0,
  payload: { legalSlug: 'TERMS', body: 'First.\n\nSecond.', effectiveDate: '2026-10-01' },
}

describe('legal body rules (mirror of the backend LEGAL validation)', () => {
  it('accepts plain paragraphs, Indic text with a joiner, and exactly the maximum length', () => {
    expect(legalBodyProblem('One.\n\nTwo.')).toBeUndefined()
    expect(legalBodyProblem('ताज़ा‍नियम')).toBeUndefined()
    expect(legalBodyProblem('x'.repeat(LEGAL_BODY_MAX))).toBeUndefined()
  })
  it.each([
    ['empty', '', 'empty'],
    ['over the limit', 'x'.repeat(LEGAL_BODY_MAX + 1), 'too-long'],
    ['leading space', ' a', 'untrimmed'],
    ['trailing newline', 'a\n', 'untrimmed'],
    ['markup', 'a <b>b</b>', 'angle-brackets'],
    ['greater-than', 'a > b', 'angle-brackets'],
    ['tab', 'a\tb', 'control'],
    ['carriage return', 'a\r\nb', 'control'],
    ['NUL', 'a\u0000b', 'control'],
    ['DEL', 'a\u007Fb', 'control'],
    ['C1 control', 'a\u0085b', 'control'],
    ['bidi override', 'abc‮def', 'control'],
    ['bidi isolate', 'abc⁦def', 'control'],
  ])('rejects %s', (_n, body, why) => {
    expect(legalBodyProblem(body)).toBe(why)
  })
  it('dates are real calendar dates in yyyy-MM-dd only', () => {
    expect(validIsoDate('2026-10-01')).toBe(true)
    expect(validIsoDate('2024-02-29')).toBe(true)
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-1-1',
      '01-10-2026',
      '2026-10-01T00:00:00Z',
      '',
      '2026-10-01 ',
    ])
      expect(validIsoDate(bad), bad).toBe(false)
  })
})

describe('legal write input', () => {
  it('accepts a valid document, with or without a date and window', () => {
    expect(legalWriteInput.safeParse(ok).success).toBe(true)
    expect(
      legalWriteInput.safeParse({ ...ok, payload: { legalSlug: 'PRIVACY', body: 'x' } }).success,
    ).toBe(true)
    expect(
      legalWriteInput.safeParse({
        ...ok,
        startsAt: '2026-10-06T03:30:00.000Z',
        endsAt: '2026-10-07T03:30:00.000Z',
      }).success,
    ).toBe(true)
  })
  it.each([
    ['unknown slug', { payload: { ...ok.payload, legalSlug: 'REFUNDS' } }],
    ['lowercase slug', { payload: { ...ok.payload, legalSlug: 'terms' } }],
    ['markup body', { payload: { ...ok.payload, body: '<p>x</p>' } }],
    ['empty body', { payload: { ...ok.payload, body: '' } }],
    ['bad date', { payload: { ...ok.payload, effectiveDate: '2026-02-30' } }],
    ['faq field smuggled in', { payload: { ...ok.payload, question: 'Q?' } }],
    ['title too long', { title: 't'.repeat(81) }],
    ['blank title', { title: '   ' }],
    ['sort too big', { sort: 10001 }],
    [
      'inverted window',
      { startsAt: '2026-10-07T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' },
    ],
    ['a type from the browser', { type: 'BANNER' }],
    ['a placement from the browser', { placement: 'HOME' }],
  ])('rejects %s', (_n, over) => {
    expect(legalWriteInput.safeParse({ ...ok, ...over }).success).toBe(false)
  })
  it('update needs a block id and a version', () => {
    const base = { ...ok, blockId: 'CB_abcdefghijklmnop', expectedVersion: 2 }
    expect(legalUpdateInput.safeParse(base).success).toBe(true)
    expect(legalUpdateInput.safeParse({ ...base, expectedVersion: 0 }).success).toBe(false)
    expect(legalUpdateInput.safeParse({ ...base, blockId: 'nope' }).success).toBe(false)
  })
})

describe('which document is live per slug (backend pick: latest updatedAt, then id)', () => {
  const NOW = Date.parse('2026-10-06T10:00:00Z')
  const b = (id: string, over: Partial<ContentBlock> & { slug?: string } = {}): ContentBlock => ({
    blockId: id,
    placement: 'HELP',
    type: 'LEGAL',
    title: id,
    sort: 0,
    status: 'PUBLISHED',
    version: 2,
    updatedAt: '2026-10-01T00:00:00Z',
    payload: { legalSlug: over.slug ?? 'TERMS', body: 'x' },
    ...over,
  })
  it('ignores drafts, scheduled, ended, archived, other slugs and non-legal blocks', () => {
    const items = [
      b('CB_draft', { status: 'DRAFT' }),
      b('CB_future', { startsAt: '2026-10-07T00:00:00Z' }),
      b('CB_ended', { endsAt: '2026-10-06T10:00:00Z' }),
      b('CB_archived', { status: 'ARCHIVED' }),
      b('CB_privacy', { slug: 'PRIVACY' }),
      b('CB_faq', { type: 'FAQ' }),
    ]
    expect(liveLegalFor(items, 'TERMS', NOW)).toBeUndefined()
    expect(liveLegalFor(items, 'PRIVACY', NOW)?.blockId).toBe('CB_privacy')
  })
  it('picks the most recently updated when legacy data holds two, then the greater id', () => {
    const older = b('CB_aaa', { updatedAt: '2026-10-01T00:00:00Z' })
    const newer = b('CB_bbb', { updatedAt: '2026-10-02T00:00:00Z' })
    expect(liveLegalFor([older, newer], 'TERMS', NOW)?.blockId).toBe('CB_bbb')
    expect(liveLegalFor([newer, older], 'TERMS', NOW)?.blockId).toBe('CB_bbb')
    const tie = b('CB_ccc', { updatedAt: '2026-10-02T00:00:00Z' })
    expect(liveLegalFor([newer, tie], 'TERMS', NOW)?.blockId).toBe('CB_ccc')
  })
})

describe('legal BFF specs', () => {
  let a: typeof import('@/server/bff/content-actions')
  beforeAll(async () => {
    a = await import('@/server/bff/content-actions')
  })
  it('create fixes placement HELP and type LEGAL in code', () => {
    const call = a.createLegalMutation.backend(a.createLegalMutation.input.parse(ok))
    expect(call.path).toBe('/api/v1/admin/content/blocks')
    expect(call.body).toMatchObject({ placement: 'HELP', type: 'LEGAL', title: 'Terms of Service' })
    expect(call.body).not.toHaveProperty('audience')
    expect(
      a.createLegalMutation.input.safeParse({ ...ok, placement: 'HOME', type: 'BANNER' }).success,
    ).toBe(false)
  })
  it('update is a full replace with a version, no type/placement, omitting cleared bounds and date', () => {
    const input = a.updateLegalMutation.input.parse({
      ...ok,
      payload: { legalSlug: 'TERMS', body: 'x' },
      blockId: 'CB_abcdefghijklmnop',
      expectedVersion: 3,
    })
    const call = a.updateLegalMutation.backend(input)
    expect(call.path).toBe('/api/v1/admin/content/blocks/CB_abcdefghijklmnop')
    expect(call.body).toEqual({
      title: 'Terms of Service',
      sort: 0,
      payload: { legalSlug: 'TERMS', body: 'x' },
      expectedVersion: 3,
    })
  })
})
