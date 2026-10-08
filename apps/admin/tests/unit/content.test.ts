import { beforeAll, describe, expect, it } from 'vitest'
import { appConfigForm, compareVersions, validHttpsUrl } from '@/lib/appconfig'
import { BLOCK_ID, effectiveStatus, faqWriteInput, utcToIstLocal, windowToUtc } from '@/lib/content'

describe('effective status', () => {
  const now = Date.parse('2026-10-06T10:00:00Z')
  const b = (status: string, startsAt?: string, endsAt?: string) => ({ status, startsAt, endsAt })
  it('derives live, scheduled, ended, draft, archived with start inclusive and end exclusive', () => {
    expect(effectiveStatus(b('PUBLISHED'), now)).toBe('live')
    expect(effectiveStatus(b('PUBLISHED', '2026-10-06T10:00:00Z'), now)).toBe('live')
    expect(effectiveStatus(b('PUBLISHED', '2026-10-06T10:00:01Z'), now)).toBe('scheduled')
    expect(effectiveStatus(b('PUBLISHED', undefined, '2026-10-06T10:00:00Z'), now)).toBe('ended')
    expect(effectiveStatus(b('PUBLISHED', undefined, '2026-10-06T10:00:01Z'), now)).toBe('live')
    expect(effectiveStatus(b('DRAFT', '2020-01-01T00:00:00Z'), now)).toBe('draft')
    expect(effectiveStatus(b('ARCHIVED'), now)).toBe('archived')
  })
})

describe('IST window conversion', () => {
  it('round-trips IST wall time through UTC', () => {
    expect(windowToUtc('2026-10-06T09:00')).toBe('2026-10-06T03:30:00.000Z')
    expect(utcToIstLocal('2026-10-06T03:30:00Z')).toBe('2026-10-06T09:00')
    expect(utcToIstLocal(undefined)).toBe('')
    expect(utcToIstLocal('garbage')).toBe('')
    expect(windowToUtc('nope')).toBeUndefined()
  })
})

describe('FAQ rules', () => {
  const ok = {
    title: 'Delivery times',
    sort: 1,
    payload: {
      faqCategory: 'DELIVERY',
      question: 'When do you deliver?',
      answer: 'Evenings.\nSeven days.',
    },
  }
  it('accepts a valid FAQ (newlines allowed in the answer) and a window', () => {
    expect(faqWriteInput.safeParse(ok).success).toBe(true)
    expect(
      faqWriteInput.safeParse({
        ...ok,
        startsAt: '2026-10-06T03:30:00.000Z',
        endsAt: '2026-10-07T03:30:00.000Z',
      }).success,
    ).toBe(true)
  })
  it.each([
    ['unknown category', { payload: { ...ok.payload, faqCategory: 'OTHER' } }],
    ['newline in question', { payload: { ...ok.payload, question: 'a\nb' } }],
    ['html in answer', { payload: { ...ok.payload, answer: '<b>x</b>' } }],
    ['html in question', { payload: { ...ok.payload, question: 'a < b' } }],
    ['question too long', { payload: { ...ok.payload, question: 'q'.repeat(201) } }],
    ['answer too long', { payload: { ...ok.payload, answer: 'a'.repeat(2001) } }],
    ['blank answer', { payload: { ...ok.payload, answer: '   ' } }],
    ['title too long', { title: 't'.repeat(81) }],
    ['sort too big', { sort: 10001 }],
    [
      'inverted window',
      { startsAt: '2026-10-07T03:30:00.000Z', endsAt: '2026-10-06T03:30:00.000Z' },
    ],
    ['non-UTC instant', { startsAt: '2026-10-06T09:00:00+05:30' }],
    ['extra key', { type: 'BANNER' }],
  ])('rejects %s', (_n, patch) =>
    expect(faqWriteInput.safeParse({ ...ok, ...patch }).success).toBe(false),
  )
  it('block ids must look like CB_…', () => {
    expect(BLOCK_ID.test('CB_abcdefghijklmnop')).toBe(true)
    for (const bad of ['CB_short', 'cb_abcdefghijklmnop', 'CB_abc/../defghijklmnop'])
      expect(BLOCK_ID.test(bad)).toBe(false)
  })
})

describe('app config rules', () => {
  const base = { storeOpen: true, maintenance: false, expectedVersion: 2 }
  it('normalises blanks and null to null (the backend rejects "")', () => {
    const p = appConfigForm.parse({ ...base, minAndroid: '', supportEmail: '   ', termsUrl: null })
    expect(p.minAndroid).toBeNull()
    expect(p.supportEmail).toBeNull()
    expect(p.termsUrl).toBeNull()
    expect(p.privacyUrl).toBeNull()
  })
  it('requires a message for maintenance, https legal links, E.164 phone and ordered versions', () => {
    expect(appConfigForm.safeParse({ ...base, maintenance: true }).success).toBe(false)
    expect(
      appConfigForm.safeParse({ ...base, maintenance: true, maintenanceMessage: 'Back soon' })
        .success,
    ).toBe(true)
    for (const url of [
      'http://x.com/t',
      'https://user:pw@x.com',
      'javascript:alert(1)',
      'https://localhost',
      'x',
      'https://' + 'a'.repeat(500) + '.com',
    ])
      expect(appConfigForm.safeParse({ ...base, termsUrl: url }).success, url).toBe(false)
    expect(appConfigForm.safeParse({ ...base, termsUrl: 'https://tazzzo.com/terms' }).success).toBe(
      true,
    )
    expect(appConfigForm.safeParse({ ...base, supportPhone: '9012345678' }).success).toBe(false)
    expect(appConfigForm.safeParse({ ...base, supportPhone: '+918012345678' }).success).toBe(true)
    expect(
      appConfigForm.safeParse({ ...base, minAndroid: '2.0.0', latestAndroid: '1.9.9' }).success,
    ).toBe(false)
    expect(appConfigForm.safeParse({ ...base, minIos: '1.2', latestIos: '1.10.0' }).success).toBe(
      true,
    )
    expect(appConfigForm.safeParse({ ...base, minIos: '1.2.x' }).success).toBe(false)
  })
  it('compares dotted versions numerically', () => {
    expect(compareVersions('1.10', '1.9')).toBe(1)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.9.9', '1')).toBe(-1)
  })
  it('https url helper', () => {
    expect(validHttpsUrl('https://tazzzo.com/p?x=1')).toBe(true)
    expect(validHttpsUrl('ftp://x.com')).toBe(false)
  })
  it('rejects unknown keys (no smuggled secrets)', () => {
    expect(appConfigForm.safeParse({ ...base, apiKey: 'sk-123' }).success).toBe(false)
  })
})

describe('content BFF specs', () => {
  let a: typeof import('@/server/bff/content-actions')
  beforeAll(async () => {
    a = await import('@/server/bff/content-actions')
  })
  const faq = {
    title: 'T',
    sort: 0,
    payload: { faqCategory: 'REFUND', question: 'Q?', answer: 'A.' },
  }
  it('create fixes placement HELP and type FAQ in code, never from the browser', () => {
    const call = a.createFaqMutation.backend(a.createFaqMutation.input.parse(faq))
    expect(call.path).toBe('/api/v1/admin/content/blocks')
    expect(call.body).toMatchObject({ placement: 'HELP', type: 'FAQ' })
    expect(
      a.createFaqMutation.input.safeParse({ ...faq, placement: 'HOME', type: 'BANNER' }).success,
    ).toBe(false)
  })
  it('update sends a full replace with a version, no type/placement, and omits cleared bounds', () => {
    const input = a.updateFaqMutation.input.parse({
      ...faq,
      blockId: 'CB_abcdefghijklmnop',
      expectedVersion: 3,
    })
    const call = a.updateFaqMutation.backend(input)
    expect(call.path).toBe('/api/v1/admin/content/blocks/CB_abcdefghijklmnop')
    expect(call.body).toEqual({ ...faq, expectedVersion: 3 })
    expect(call.body).not.toHaveProperty('startsAt')
  })
  it('status needs a version and a known target', () => {
    expect(
      a.blockStatusMutation.input.safeParse({
        blockId: 'CB_abcdefghijklmnop',
        to: 'PUBLISHED',
        expectedVersion: 1,
      }).success,
    ).toBe(true)
    expect(
      a.blockStatusMutation.input.safeParse({
        blockId: 'CB_abcdefghijklmnop',
        to: 'DELETED',
        expectedVersion: 1,
      }).success,
    ).toBe(false)
    expect(
      a.blockStatusMutation.input.safeParse({
        blockId: 'CB_abcdefghijklmnop',
        to: 'DRAFT',
        expectedVersion: 0,
      }).success,
    ).toBe(false)
  })
  it('app config PUT sends the normalised document to the fixed path', () => {
    const input = a.putAppConfigMutation.input.parse({
      storeOpen: true,
      maintenance: false,
      expectedVersion: 0,
      supportEmail: '',
    })
    const call = a.putAppConfigMutation.backend(input)
    expect(call.path).toBe('/api/v1/admin/app-config')
    expect(call.body).toMatchObject({ storeOpen: true, supportEmail: null, expectedVersion: 0 })
  })
})
