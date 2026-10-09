import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveGoto } from '@/lib/goto'
import {
  CONTENT_PRODUCT_ID,
  LINK,
  homeWriteInput,
  idsIssue,
  linkIssue,
  linkOf,
  splitIds,
} from '@/lib/home-content'
import { buildRows, inventoryRowSchema, priceRowSchema, productRowSchema } from '@/lib/imports'
import { createInput } from '@/lib/product-create'
import { PRODUCT_ID, PRODUCT_ID_PATTERN } from '@/lib/products'
import { INVALID_PRODUCT_IDS, VALID_PRODUCT_IDS } from '../support/product-id-corpus'

const CANONICAL = /^TZP-[A-Za-z0-9-]{1,40}$/
// Lower/mixed-case ids that a force-uppercasing implementation would change.
const CASED = ['TZP-l001', 'TZP-Med-3', 'TZP-abc', `TZP-${'a'.repeat(40)}`]

const product = (id: string) => ({
  id,
  productType: 'single',
  identityType: 'internal',
  internalKey: 'K1',
  brandCode: 'BRAND',
  title: 'Rice',
  verticalId: 'VT-1',
  releaseId: 'REL-1',
  classificationStatus: 'provisional',
})
const priceMap = { skuId: 0, sellingPrice: 1, mrp: 2, expectedVersion: -1 }
const invMap = {
  skuId: 0,
  locationId: 1,
  onHand: 2,
  lowStockThreshold: 3,
  maxPurchasable: 4,
  expectedVersion: -1,
}
const prodMap = {
  id: 0,
  title: 1,
  brandCode: 2,
  gtin: 3,
  internalKey: 4,
  verticalId: 5,
  releaseId: 6,
  market: -1,
  classificationStatus: -1,
}

describe('product id corpus', () => {
  it('corpus is self-consistent with the canonical grammar', () => {
    for (const id of VALID_PRODUCT_IDS) expect(CANONICAL.test(id), id).toBe(true)
    for (const id of INVALID_PRODUCT_IDS) expect(CANONICAL.test(id), JSON.stringify(id)).toBe(false)
  })
  it('PRODUCT_ID is exactly the canonical grammar and is the single shared constant', () => {
    expect(PRODUCT_ID.source).toBe(CANONICAL.source)
    expect(PRODUCT_ID.flags).toBe('')
    expect(CONTENT_PRODUCT_ID).toBe(PRODUCT_ID)
  })
  it.each(VALID_PRODUCT_IDS)('accepts %s everywhere', (id) => {
    expect(PRODUCT_ID.test(id)).toBe(true)
    expect(new RegExp(`^(?:${PRODUCT_ID_PATTERN})$`, 'v').test(id)).toBe(true)
    expect(createInput.safeParse(product(id)).success).toBe(true)
    expect(priceRowSchema.safeParse({ skuId: id, sellingPricePaise: 1, mrpPaise: 2 }).success).toBe(
      true,
    )
    expect(LINK.test(`product:${id}`)).toBe(true)
    expect(linkIssue('product', id)).toBeUndefined()
    expect(idsIssue('PRODUCT_RAIL', [id])).toBeUndefined()
    expect(resolveGoto(id, ['reader'])).toMatchObject({ ok: true })
  })
  it.each(INVALID_PRODUCT_IDS)('rejects %j everywhere', (id) => {
    expect(PRODUCT_ID.test(id)).toBe(false)
    expect(new RegExp(`^(?:${PRODUCT_ID_PATTERN})$`, 'v').test(id)).toBe(false)
    expect(createInput.safeParse(product(id)).success).toBe(false)
    expect(priceRowSchema.safeParse({ skuId: id, sellingPricePaise: 1, mrpPaise: 2 }).success).toBe(
      false,
    )
    expect(LINK.test(`product:${id}`)).toBe(false)
    expect(idsIssue('PRODUCT_RAIL', [id])).toBeDefined()
    // resolveGoto trims, so only compare ids that survive trimming unchanged
    if (id.trim() === id && id !== '') expect(resolveGoto(id, ['reader']).ok).toBe(false)
  })
})

describe('mixed-case ids are preserved untransformed', () => {
  it.each(CASED)('import wizard rows keep %s', (id) => {
    const prices = buildRows('prices', [[id, '10', '12']], priceMap)
    expect(prices[0]!.errors).toEqual([])
    expect(prices[0]!.value).toEqual({ skuId: id, sellingPricePaise: 1000, mrpPaise: 1200 })
    expect(prices[0]!.key).toBe(id)

    const inv = buildRows('inventory', [[id, 'L1', '10', '2', '5']], invMap)
    expect(inv[0]!.errors).toEqual([])
    expect((inv[0]!.value as { skuId: string }).skuId).toBe(id)
    expect(inv[0]!.key).toBe(`${id}|L1`)
    expect(inventoryRowSchema.safeParse(inv[0]!.value).success).toBe(true)

    const prod = buildRows('products', [[id, 'Rice', 'BR', '', 'K-1', 'V1', 'R1']], prodMap)
    expect(prod[0]!.key).toBe(id)
    expect((prod[0]!.value as { id: string }).id).toBe(id)
    expect(productRowSchema.safeParse(prod[0]!.value).success).toBe(true)
  })
  it('ids differing only by case are distinct rows, not duplicates', () => {
    const rows = buildRows(
      'prices',
      [
        ['TZP-a', '1', '2'],
        ['TZP-A', '1', '2'],
      ],
      priceMap,
    )
    expect(rows.map((r) => r.errors)).toEqual([[], []])
  })
  it('an import row with a lower-case prefix is invalid, not silently fixed', () => {
    const rows = buildRows('prices', [['tzp-1', '1', '2']], priceMap)
    expect(rows[0]!.value).toBeUndefined()
  })
  it.each(CASED)('product create input keeps %s', (id) => {
    expect(createInput.parse(product(id)).id).toBe(id)
  })
  it.each(CASED)('home-content rails and links keep %s', (id) => {
    expect(splitIds(` ${id}, TZP-9\n`, 'PRODUCT_RAIL')).toEqual([id, 'TZP-9'])
    expect(linkOf('product', ` ${id} `)).toBe(`product:${id}`)
    expect(linkIssue('product', id)).toBeUndefined()
    expect(LINK.test(linkOf('product', id))).toBe(true)
    const parsed = homeWriteInput.parse({
      type: 'PRODUCT_RAIL',
      title: 'Rail',
      sort: 0,
      audience: 'APP_ONLY',
      payload: { ids: [id] },
    })
    expect(parsed.payload).toEqual({ ids: [id] })
  })
  it('only taxonomy node ids are upper-cased', () => {
    expect(linkOf('category', ' tzc-000123 ')).toBe('category:TZC-000123')
    expect(splitIds('tzc-000001,tzs-000002', 'CATEGORY_GRID')).toEqual(['TZC-000001', 'TZS-000002'])
    expect(linkOf('product', 'tzp-1')).toBe('product:tzp-1')
    expect(linkIssue('product', 'tzp-1')).toBeDefined()
  })
})

describe('BFF specs keep the id exactly', () => {
  let commerce: typeof import('@/server/bff/commerce-actions')
  let title: typeof import('@/server/bff/product-title')
  beforeAll(async () => {
    commerce = await import('@/server/bff/commerce-actions')
    title = await import('@/server/bff/product-title')
  })
  it('the title route reuses the shared constant', () => {
    expect(title.PRODUCT_ID).toBe(PRODUCT_ID)
  })
  it.each(CASED)('pricing and inventory BFF paths keep %s', (id) => {
    const price = commerce.setPriceMutation.input.parse({
      skuId: id,
      sellingPricePaise: 1,
      mrpPaise: 2,
    })
    expect(commerce.setPriceMutation.backend(price).path).toBe(`/api/v1/admin/prices/${id}`)
    const stock = commerce.setInventoryMutation.input.parse({
      skuId: id,
      locationId: 'LOC-1',
      onHand: 1,
      lowStockThreshold: 0,
      maxPurchasable: 0,
    })
    expect(commerce.setInventoryMutation.backend(stock).path).toBe(
      `/api/v1/admin/inventory/${id}/LOC-1`,
    )
  })
  it.each(CASED)('title BFF input accepts %s', (id) => {
    const parsed = title.productTitleMutation.input.parse({
      productId: id,
      title: 'T',
      expectedVersion: 1,
    })
    expect(parsed.productId).toBe(id)
  })
  it.each(INVALID_PRODUCT_IDS)('title BFF input rejects %j', (id) => {
    const r = title.productTitleMutation.input.safeParse({
      productId: id,
      title: 'T',
      expectedVersion: 1,
    })
    expect(r.success).toBe(false)
  })
})

describe('server pages pass the id through untransformed', () => {
  const readProduct = vi.fn()
  const readPrice = vi.fn()
  const readInventory = vi.fn()
  const readMediaSet = vi.fn()
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doMock('@/server/session/require-session', () => ({
      requireAdmin: async () => ({ view: 'ok', me: { roles: ['cms-writer'] } }),
    }))
    vi.doMock('@/server/backend/products', () => ({ readProduct }))
    vi.doMock('@/server/backend/commerce', () => ({ readPrice, readInventory }))
    vi.doMock('@/server/backend/media', () => ({ readMediaSet }))
  })
  it.each(CASED)('pricing page reads %s as typed', async (id) => {
    const { default: Page } = await import('@/app/(app)/pricing/page')
    const el = (await Page({ searchParams: Promise.resolve({ sku: ` ${id} ` }) })) as {
      props: { sku?: string; invalidInput?: boolean }
    }
    expect(el.props.invalidInput).toBeUndefined()
    expect(el.props.sku).toBe(id)
    expect(readPrice).toHaveBeenCalledWith(id)
    expect(readProduct).toHaveBeenCalledWith(id)
  })
  it('pricing page treats a lower-case prefix as invalid instead of uppercasing it', async () => {
    const { default: Page } = await import('@/app/(app)/pricing/page')
    const el = (await Page({ searchParams: Promise.resolve({ sku: 'tzp-1' }) })) as {
      props: { invalidInput?: boolean }
    }
    expect(el.props.invalidInput).toBe(true)
    expect(readPrice).not.toHaveBeenCalled()
  })
  it.each(CASED)('inventory page reads %s as typed', async (id) => {
    const { default: Page } = await import('@/app/(app)/inventory/page')
    const el = (await Page({ searchParams: Promise.resolve({ sku: id, location: 'LOC-1' }) })) as {
      props: { sku?: string; invalidInput?: boolean }
    }
    expect(el.props.invalidInput).toBeUndefined()
    expect(el.props.sku).toBe(id)
    expect(readInventory).toHaveBeenCalledWith(id, 'LOC-1')
    expect(readProduct).toHaveBeenCalledWith(id)
  })
  it.each(CASED)('media page reads %s as typed', async (id) => {
    const { default: Page } = await import('@/app/(app)/catalogue/media/page')
    const el = (await Page({ searchParams: Promise.resolve({ id, type: 'product' }) })) as {
      props: { owner?: { id: string }; invalidInput?: boolean }
    }
    expect(el.props.invalidInput).toBeUndefined()
    expect(el.props.owner?.id).toBe(id)
    expect(readMediaSet).toHaveBeenCalledWith('product', id)
  })
})
