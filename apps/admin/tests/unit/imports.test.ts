import { beforeAll, describe, expect, it } from 'vitest'
import {
  autoMap,
  buildRows,
  chunk,
  csvCell,
  missingRequired,
  parseCsv,
  safeRowErrors,
  templateCsv,
  toCsv,
} from '@/lib/imports'

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded commas/newlines, CRLF and a BOM', () => {
    const r = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",z\r\n')
    expect(r).toEqual({
      ok: true,
      header: ['a', 'b'],
      rows: [
        ['x, y', 'say "hi"'],
        ['multi\nline', 'z'],
      ],
    })
  })
  it('skips blank lines, rejects empty, header-only and unterminated quotes', () => {
    expect(parseCsv('a,b\n\n1,2\n')).toMatchObject({ ok: true, rows: [['1', '2']] })
    expect(parseCsv('')).toMatchObject({ ok: false })
    expect(parseCsv('a,b\n')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no data rows/),
    })
    expect(parseCsv('a,b\n"open,1')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/never closed/),
    })
  })
  it('bounds rows, columns and size', () => {
    expect(parseCsv(`h\n${'1\n'.repeat(5001)}`)).toMatchObject({ ok: false })
    expect(parseCsv(`${Array.from({ length: 51 }, (_, i) => `c${i}`).join(',')}\n1`)).toMatchObject(
      { ok: false },
    )
    expect(parseCsv('x'.repeat(2 * 1024 * 1024 + 1))).toMatchObject({ ok: false })
  })
  it('never evaluates formulas: values stay plain strings', () => {
    expect(parseCsv('a\n=HYPERLINK("http://evil")')).toMatchObject({
      ok: true,
      rows: [['=HYPERLINK("http://evil")']],
    })
  })
})

describe('CSV output safety', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\rcmd'])('neutralises %j', (v) => {
    expect(csvCell(v).replace(/^"/, '').startsWith("'")).toBe(true)
  })
  it('quotes when needed and leaves plain text alone', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "x"')).toBe('"say ""x"""')
    expect(toCsv([['a', '=b']])).toBe("a,'=b\r\n")
  })
  it('templates are header-only', () => {
    expect(templateCsv('prices').trim().split('\r\n')).toHaveLength(1)
    expect(templateCsv('inventory')).toContain('lowStockThreshold')
  })
})

describe('mapping and row building', () => {
  it('maps headers by alias, once each, and reports missing required fields', () => {
    const map = autoMap('prices', ['SKU', 'Price', 'M.R.P', 'Notes'])
    expect(map).toMatchObject({ skuId: 0, sellingPrice: 1, mrp: 2, expectedVersion: -1 })
    expect(missingRequired('prices', { ...map, mrp: -1 })).toEqual(['MRP (₹)'])
  })
  const priceMap = { skuId: 0, sellingPrice: 1, mrp: 2, expectedVersion: -1 }
  it('prices: rupees to paise, MRP floor, bad amounts, duplicates', () => {
    const rows = buildRows(
      'prices',
      [
        ['TZP-1', '129.5', '149'],
        ['TZP-2', '200', '100'],
        ['TZP-3', 'abc', '10'],
        ['TZP-1', '1', '2'],
        ['bad id', '1', '2'],
      ],
      priceMap,
    )
    expect(rows[0]!.value).toEqual({ skuId: 'TZP-1', sellingPricePaise: 12950, mrpPaise: 14900 })
    expect(rows[1]!.errors.join()).toMatch(/MRP/)
    expect(rows[2]!.errors.join()).toMatch(/Selling price/)
    expect(rows[3]!.errors).toContain('Duplicate of row 1.')
    expect(rows[3]!.value).toBeUndefined()
    expect(rows[4]!.value).toBeUndefined()
  })
  it('inventory: whole numbers, duplicate sku+location, version optional', () => {
    const map = {
      skuId: 0,
      locationId: 1,
      onHand: 2,
      lowStockThreshold: 3,
      maxPurchasable: 4,
      expectedVersion: 5,
    }
    const rows = buildRows(
      'inventory',
      [
        ['TZP-1', 'L1', '10', '2', '5', '3'],
        ['TZP-1', 'L2', '-1', '2', '5', ''],
        ['TZP-1', 'L1', '1', '1', '1', ''],
      ],
      map,
    )
    expect(rows[0]!.value).toMatchObject({ onHand: 10, expectedVersion: 3 })
    expect(rows[1]!.errors.join()).toMatch(/On-hand/)
    expect(rows[2]!.errors).toContain('Duplicate of row 1.')
  })
  it('products: GTIN check digit, defaults, identity choice, duplicate GTIN across rows', () => {
    const map = {
      id: 0,
      title: 1,
      brandCode: 2,
      gtin: 3,
      market: -1,
      internalKey: 4,
      verticalId: 5,
      releaseId: 6,
      classificationStatus: -1,
    }
    const rows = buildRows(
      'products',
      [
        ['TZP-1', 'Rice', 'br', '4006381333931', '', 'V1', 'R1'],
        ['TZP-2', 'Dal', 'br', '4006381333932', '', 'V1', 'R1'],
        ['TZP-3', 'Salt', 'br', '', 'K-3', 'V1', 'R1'],
        ['TZP-4', 'Oil', 'br', '4006381333931', '', 'V1', 'R1'],
        ['TZP-5', 'Tea', 'br', '', '', 'V1', 'R1'],
      ],
      map,
    )
    expect(rows[0]!.value).toMatchObject({
      identityType: 'gtin',
      brandCode: 'BR',
      classificationStatus: 'provisional',
      gtins: [{ value: '4006381333931', market: 'IN' }],
    })
    expect(rows[1]!.value).toBeUndefined()
    expect(rows[2]!.value).toMatchObject({ identityType: 'internal', internalKey: 'K-3' })
    expect(rows[3]!.errors.join()).toMatch(/also on row 1/)
    expect(rows[4]!.value).toBeUndefined()
  })
})

describe('chunk and report handling', () => {
  it('splits at the backend limit of 500', () => {
    const parts = chunk(Array.from({ length: 1201 }, (_, i) => i))
    expect(parts.map((p) => p.length)).toEqual([500, 500, 201])
  })
  it('sanitizes row errors from a 422 body', () => {
    const body = {
      rowErrors: [
        { row: 2, code: 'UNKNOWN_PRODUCT', message: 'x'.repeat(500) },
        { row: -1, code: 'X', message: 'm' },
        { row: 1.5 },
        { row: 3, code: '<script>', message: 5 },
      ],
    }
    const errs = safeRowErrors(body)
    expect(errs).toHaveLength(2)
    expect(errs[0]!.message).toHaveLength(200)
    expect(errs[1]).toEqual({ row: 3, code: 'INVALID_ROW', message: '' })
    expect(safeRowErrors(null)).toEqual([])
    expect(
      safeRowErrors({
        rowErrors: Array.from({ length: 900 }, (_, i) => ({ row: i, code: 'A', message: '' })),
      }),
    ).toHaveLength(500)
  })
})

describe('import BFF specs', () => {
  let a: typeof import('@/server/bff/import-actions')
  beforeAll(async () => {
    a = await import('@/server/bff/import-actions')
  })
  it('use fixed paths, a larger body bound and a longer timeout', () => {
    for (const kind of ['products', 'prices', 'inventory'] as const) {
      const s = a.importMutations[kind]
      expect(s.backend({ dryRun: true, rows: [] as never }).path).toBe(
        `/api/v1/admin/imports/${kind}`,
      )
      expect(s.maxBodyBytes).toBe(2 * 1024 * 1024)
      expect(s.timeoutMs).toBe(60_000)
    }
  })
  it('enforces 1..500 rows, strict rows and a boolean dryRun', () => {
    const s = a.importMutations.prices
    const row = { skuId: 'TZP-1', sellingPricePaise: 1, mrpPaise: 2 }
    expect(s.input.safeParse({ dryRun: true, rows: [row] }).success).toBe(true)
    expect(s.input.safeParse({ dryRun: true, rows: [] }).success).toBe(false)
    expect(s.input.safeParse({ dryRun: true, rows: Array(501).fill(row) }).success).toBe(false)
    expect(s.input.safeParse({ dryRun: 'yes', rows: [row] }).success).toBe(false)
    expect(s.input.safeParse({ dryRun: true, rows: [{ ...row, currency: 'USD' }] }).success).toBe(
      false,
    )
    expect(s.input.safeParse({ dryRun: true, rows: [row], extra: 1 }).success).toBe(false)
  })
})
