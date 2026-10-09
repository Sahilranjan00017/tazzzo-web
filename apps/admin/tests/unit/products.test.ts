import { beforeAll, describe, expect, it } from 'vitest'
import { bffErrorMessage } from '@/lib/bff-client'
import { isValidGtin } from '@/lib/gtin'
import { createInput } from '@/lib/product-create'
import {
  ACTIONS_BY_STATE,
  PRODUCT_ID,
  filterSearch,
  parseProductListQuery,
  productListPath,
  realValue,
} from '@/lib/products'

describe('GTIN check digit', () => {
  it.each(['4006381333931', '036000291452', '96385074', '00012345678905'])('accepts %s', (g) =>
    expect(isValidGtin(g)).toBe(true),
  )
  it.each(['4006381333932', '123', 'abcdefghijklm', '', '40063813339311'])('rejects %s', (g) =>
    expect(isValidGtin(g)).toBe(false),
  )
})

describe('product list query', () => {
  it('drops lifecycle/status without a vertical and explains why', () => {
    const { query, problems } = parseProductListQuery({ lifecycle: 'active' })
    expect(query).toEqual({ limit: 50 })
    expect(problems.join()).toMatch(/need a vertical id/)
  })
  it('keeps valid filters, rejects bad enums and injection-shaped values', () => {
    const ok = parseProductListQuery({
      verticalId: 'VT-1',
      lifecycle: 'active',
      status: 'confirmed',
      cursor: 'TZP-9',
    })
    expect(ok.query).toEqual({
      verticalId: 'VT-1',
      lifecycle: 'active',
      status: 'confirmed',
      cursor: 'TZP-9',
      limit: 50,
    })
    const bad = parseProductListQuery({ verticalId: 'a&b=c', lifecycle: 'weird', cursor: '../x' })
    expect(bad.query).toEqual({ limit: 50 })
    expect(bad.problems.length).toBeGreaterThanOrEqual(2)
  })
  it('takes the first of repeated parameters and builds only allowlisted backend params', () => {
    const { query } = parseProductListQuery({ verticalId: ['VT-1', 'VT-2'] })
    expect(productListPath(query)).toBe('/api/v1/products?verticalId=VT-1&limit=50')
    expect(filterSearch({ verticalId: 'VT-1', lifecycle: 'draft' })).toBe(
      'verticalId=VT-1&lifecycle=draft',
    )
  })
})

describe('product helpers', () => {
  it('treats the backend string "null" as absent', () => {
    expect(realValue('null')).toBeUndefined()
    expect(realValue('VT-1')).toBe('VT-1')
  })
  it('offers only legal lifecycle actions', () => {
    expect(ACTIONS_BY_STATE.draft).toEqual(['activate'])
    expect(ACTIONS_BY_STATE.active).toEqual(['retire'])
    expect(ACTIONS_BY_STATE.discontinued).toEqual(['revive', 'archive'])
    expect(ACTIONS_BY_STATE.archived).toBeUndefined()
    expect(ACTIONS_BY_STATE.merging).toBeUndefined()
  })
  it('validates ids', () => {
    expect(PRODUCT_ID.test('TZP-1001')).toBe(true)
    expect(PRODUCT_ID.test('tzp-1')).toBe(false)
    expect(PRODUCT_ID.test('TZP-l001')).toBe(true)
    expect(PRODUCT_ID.test('TZP-1/../x')).toBe(false)
  })
})

describe('create input', () => {
  const base = {
    id: 'TZP-1001',
    productType: 'single',
    identityType: 'gtin',
    gtins: [{ value: '4006381333931', market: 'IN' }],
    brandCode: 'BRAND',
    title: 'Basmati 5 kg',
    verticalId: 'VT-1',
    releaseId: 'REL-1',
    classificationStatus: 'provisional',
  }
  it('accepts a valid GTIN product and an internal-key product', () => {
    expect(createInput.safeParse(base).success).toBe(true)
    const rest: Record<string, unknown> = { ...base }
    delete rest.gtins
    expect(
      createInput.safeParse({ ...rest, identityType: 'internal', internalKey: 'K1' }).success,
    ).toBe(true)
  })
  it('rejects bad GTIN, missing identity, extra fields and non-single types', () => {
    expect(
      createInput.safeParse({ ...base, gtins: [{ value: '4006381333932', market: 'IN' }] }).success,
    ).toBe(false)
    expect(createInput.safeParse({ ...base, gtins: undefined }).success).toBe(false)
    expect(createInput.safeParse({ ...base, extra: 1 }).success).toBe(false)
    expect(createInput.safeParse({ ...base, productType: 'bundle' }).success).toBe(false)
  })
})

describe('bffErrorMessage', () => {
  const fail = (status: number, code?: string) => ({ ok: false as const, status, error: 'x', code })
  it('explains stale versions, state conflicts, denials and network loss distinctly', () => {
    expect(bffErrorMessage(fail(409, 'STALE_VERSION'))).toMatch(/changed this since you loaded/)
    expect(bffErrorMessage(fail(409, 'STATE_CONFLICT'))).toMatch(/not in a state/)
    expect(bffErrorMessage(fail(403))).toMatch(/not permitted/)
    expect(bffErrorMessage(fail(0))).toMatch(/Could not reach/)
    expect(bffErrorMessage(fail(502))).toMatch(/not retried/)
  })
})

describe('BFF specs', () => {
  let actions: typeof import('@/server/bff/product-actions')
  beforeAll(async () => {
    actions = await import('@/server/bff/product-actions')
  })
  it('builds a fixed backend call per lifecycle action with If-Match and no body (except retire reason)', () => {
    const activate = actions.lifecycleMutation('activate')
    const parsed = activate.input.parse({ productId: 'TZP-1', expectedVersion: 3 })
    expect(activate.backend(parsed)).toEqual({
      path: '/api/v1/products/TZP-1/activate',
      headers: { 'If-Match': '3' },
      body: undefined,
    })
    const retire = actions.lifecycleMutation('retire')
    expect(
      retire.backend({ productId: 'TZP-1', expectedVersion: 3, reason: 'bad batch' }).body,
    ).toEqual({
      reason: 'bad batch',
    })
  })
  it('rejects path-shaped ids, unknown keys and negative versions', () => {
    const spec = actions.lifecycleMutation('archive')
    expect(spec.input.safeParse({ productId: 'TZP-1/../x', expectedVersion: 1 }).success).toBe(
      false,
    )
    expect(spec.input.safeParse({ productId: 'TZP-1', expectedVersion: -1 }).success).toBe(false)
    expect(
      spec.input.safeParse({ productId: 'TZP-1', expectedVersion: 1, admin: true }).success,
    ).toBe(false)
  })
})
