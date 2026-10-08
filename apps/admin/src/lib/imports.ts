import { z } from 'zod'
import { COUNT_MAX, LOCATION_ID, ON_HAND_MAX } from './commerce'
import { MAX_PAISE, parseRupees } from './money'
import { createInput } from './product-create'
import { PRODUCT_ID } from './products'

/**
 * Bulk import model (backend `POST /api/v1/admin/imports/{products|prices|inventory}`): JSON rows, 1..500 per request,
 * 2 MiB body, `dryRun` validates without writing, a rejected file writes nothing (422 INVALID_IMPORT + rowErrors).
 * The CMS parses CSV only (no spreadsheet dependency) and the backend stays the final validation authority.
 */
export const IMPORT_KINDS = ['products', 'prices', 'inventory'] as const
export type ImportKind = (typeof IMPORT_KINDS)[number]

export const MAX_ROWS_PER_REQUEST = 500
export const MAX_FILE_ROWS = 5_000
export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_COLUMNS = 50

const version = z.number().int().min(1).max(2_147_483_647)

export const priceRowSchema = z
  .object({
    skuId: z.string().regex(PRODUCT_ID),
    sellingPricePaise: z.number().int().min(0).max(MAX_PAISE),
    mrpPaise: z.number().int().min(0).max(MAX_PAISE),
    expectedVersion: version.optional(),
  })
  .strict()
  .refine((v) => v.mrpPaise >= v.sellingPricePaise, {
    path: ['mrpPaise'],
    message: 'MRP is below the selling price',
  })

export const inventoryRowSchema = z
  .object({
    skuId: z.string().regex(PRODUCT_ID),
    locationId: z.string().regex(LOCATION_ID),
    onHand: z.number().int().min(0).max(ON_HAND_MAX),
    lowStockThreshold: z.number().int().min(0).max(COUNT_MAX),
    maxPurchasable: z.number().int().min(0).max(COUNT_MAX),
    expectedVersion: version.optional(),
  })
  .strict()

export const productRowSchema = createInput

export interface FieldDef {
  key: string
  label: string
  required: boolean
  aliases: readonly string[]
  help?: string
}

export const FIELDS: Record<ImportKind, readonly FieldDef[]> = {
  products: [
    {
      key: 'id',
      label: 'Product id',
      required: true,
      aliases: ['id', 'productid', 'tzpid', 'sku', 'skuid'],
      help: 'TZP-…',
    },
    { key: 'title', label: 'Title', required: true, aliases: ['title', 'name', 'productname'] },
    { key: 'brandCode', label: 'Brand code', required: true, aliases: ['brand', 'brandcode'] },
    {
      key: 'gtin',
      label: 'GTIN',
      required: false,
      aliases: ['gtin', 'barcode', 'ean', 'upc'],
      help: 'Needed unless an internal key is given',
    },
    {
      key: 'market',
      label: 'GTIN market',
      required: false,
      aliases: ['market', 'gtinmarket', 'country'],
      help: 'Defaults to IN',
    },
    { key: 'internalKey', label: 'Internal key', required: false, aliases: ['internalkey', 'key'] },
    {
      key: 'verticalId',
      label: 'Vertical id',
      required: true,
      aliases: ['vertical', 'verticalid'],
    },
    {
      key: 'releaseId',
      label: 'Taxonomy release id',
      required: true,
      aliases: ['release', 'releaseid', 'taxonomyrelease'],
    },
    {
      key: 'classificationStatus',
      label: 'Classification status',
      required: false,
      aliases: ['classification', 'classificationstatus', 'status'],
      help: 'Defaults to provisional',
    },
  ],
  prices: [
    {
      key: 'skuId',
      label: 'Product id',
      required: true,
      aliases: ['skuid', 'sku', 'productid', 'id'],
    },
    {
      key: 'sellingPrice',
      label: 'Selling price (₹)',
      required: true,
      aliases: ['sellingprice', 'price', 'selling', 'sp'],
    },
    { key: 'mrp', label: 'MRP (₹)', required: true, aliases: ['mrp', 'maxretailprice'] },
    {
      key: 'expectedVersion',
      label: 'Expected version',
      required: false,
      aliases: ['expectedversion', 'version'],
      help: 'Blank = first price',
    },
  ],
  inventory: [
    {
      key: 'skuId',
      label: 'Product id',
      required: true,
      aliases: ['skuid', 'sku', 'productid', 'id'],
    },
    {
      key: 'locationId',
      label: 'Location id',
      required: true,
      aliases: ['locationid', 'location', 'fulfillmentlocationid', 'store'],
    },
    {
      key: 'onHand',
      label: 'On-hand',
      required: true,
      aliases: ['onhand', 'stock', 'quantity', 'qty'],
    },
    {
      key: 'lowStockThreshold',
      label: 'Low-stock threshold',
      required: true,
      aliases: ['lowstockthreshold', 'lowstock', 'threshold'],
    },
    {
      key: 'maxPurchasable',
      label: 'Max per order',
      required: true,
      aliases: ['maxpurchasable', 'maxperorder', 'maxqty'],
    },
    {
      key: 'expectedVersion',
      label: 'Expected version',
      required: false,
      aliases: ['expectedversion', 'version'],
      help: 'Blank = first record',
    },
  ],
}

/* ---------------- CSV ---------------- */

export type CsvResult =
  { ok: true; header: string[]; rows: string[][] } | { ok: false; reason: string }

/** RFC 4180 reader: quotes, escaped quotes, CRLF/LF, UTF-8 BOM. Bounded rows/columns; never evaluates anything. */
export function parseCsv(text: string): CsvResult {
  if (text.length > MAX_FILE_BYTES) return { ok: false, reason: 'The file is larger than 2 MiB.' }
  const src = text.replace(/^﻿/, '')
  const table: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.some((c) => c.trim() !== '')) table.push(row)
      row = []
      if (table.length > MAX_FILE_ROWS + 1)
        return { ok: false, reason: `More than ${MAX_FILE_ROWS} data rows. Split the file.` }
    } else cell += ch
  }
  if (quoted) return { ok: false, reason: 'A quoted value is never closed.' }
  row.push(cell)
  if (row.some((c) => c.trim() !== '')) table.push(row)
  const [header, ...rows] = table
  if (!header) return { ok: false, reason: 'The file is empty.' }
  if (header.length > MAX_COLUMNS) return { ok: false, reason: `More than ${MAX_COLUMNS} columns.` }
  if (rows.length === 0) return { ok: false, reason: 'The file has a header but no data rows.' }
  if (rows.length > MAX_FILE_ROWS)
    return { ok: false, reason: `More than ${MAX_FILE_ROWS} data rows. Split the file.` }
  return { ok: true, header: header.map((h) => h.trim()), rows }
}

/** CSV-injection guard for anything we write out: a leading = + - @ tab or CR would be a formula in a spreadsheet. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

export const templateCsv = (kind: ImportKind): string => toCsv([FIELDS[kind].map((f) => f.key)])

/* ---------------- mapping ---------------- */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** field key -> column index (-1 = unmapped). Each column is used at most once; first alias match wins. */
export function autoMap(kind: ImportKind, header: readonly string[]): Record<string, number> {
  const used = new Set<number>()
  const map: Record<string, number> = {}
  for (const f of FIELDS[kind]) {
    const idx = header.findIndex((h, i) => !used.has(i) && f.aliases.includes(norm(h)))
    map[f.key] = idx
    if (idx >= 0) used.add(idx)
  }
  return map
}

export function missingRequired(kind: ImportKind, map: Record<string, number>): string[] {
  return FIELDS[kind].filter((f) => f.required && (map[f.key] ?? -1) < 0).map((f) => f.label)
}

/* ---------------- row building and validation ---------------- */

export interface BuiltRow {
  /** 1-based data row number (the header is not counted); matches what a spreadsheet user sees minus the header. */
  line: number
  key: string
  value?: Record<string, unknown>
  errors: string[]
}

const int = (text: string): number | undefined =>
  /^\d{1,10}$/.test(text) ? Number(text) : undefined

export function buildRows(
  kind: ImportKind,
  rows: readonly (readonly string[])[],
  map: Record<string, number>,
): BuiltRow[] {
  const cell = (r: readonly string[], k: string) =>
    (map[k] ?? -1) >= 0 ? (r[map[k]!] ?? '').trim() : ''
  const built = rows.map((r, i): BuiltRow => {
    const line = i + 1
    const errors: string[] = []
    let candidate: Record<string, unknown> = {}
    let key = ''
    if (kind === 'prices') {
      key = cell(r, 'skuId').toUpperCase()
      const s = parseRupees(cell(r, 'sellingPrice'))
      const m = parseRupees(cell(r, 'mrp'))
      if (!s.ok) errors.push(`Selling price: ${s.reason}`)
      if (!m.ok) errors.push(`MRP: ${m.reason}`)
      const ev = cell(r, 'expectedVersion')
      candidate = {
        skuId: key,
        sellingPricePaise: s.ok ? s.paise : undefined,
        mrpPaise: m.ok ? m.paise : undefined,
        ...(ev ? { expectedVersion: int(ev) ?? ev } : {}),
      }
    } else if (kind === 'inventory') {
      key = `${cell(r, 'skuId').toUpperCase()}|${cell(r, 'locationId')}`
      const num = (k: string, label: string) => {
        const v = int(cell(r, k))
        if (v === undefined) errors.push(`${label} must be a whole number, 0 or more.`)
        return v
      }
      const ev = cell(r, 'expectedVersion')
      candidate = {
        skuId: cell(r, 'skuId').toUpperCase(),
        locationId: cell(r, 'locationId'),
        onHand: num('onHand', 'On-hand'),
        lowStockThreshold: num('lowStockThreshold', 'Low-stock threshold'),
        maxPurchasable: num('maxPurchasable', 'Max per order'),
        ...(ev ? { expectedVersion: int(ev) ?? ev } : {}),
      }
    } else {
      key = cell(r, 'id').toUpperCase()
      const gtin = cell(r, 'gtin')
      const internalKey = cell(r, 'internalKey')
      candidate = {
        id: key,
        productType: 'single',
        identityType: gtin ? 'gtin' : 'internal',
        ...(gtin
          ? { gtins: [{ value: gtin, market: (cell(r, 'market') || 'IN').toUpperCase() }] }
          : { internalKey }),
        brandCode: cell(r, 'brandCode').toUpperCase(),
        title: cell(r, 'title'),
        verticalId: cell(r, 'verticalId'),
        releaseId: cell(r, 'releaseId'),
        classificationStatus: cell(r, 'classificationStatus') || 'provisional',
      }
    }
    const schema =
      kind === 'products'
        ? productRowSchema
        : kind === 'prices'
          ? priceRowSchema
          : inventoryRowSchema
    const parsed = schema.safeParse(candidate)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const where = issue.path.length ? `${issue.path.join('.')}: ` : ''
        const text = `${where}${issue.message}`
        if (!errors.some((e) => e.startsWith(text.split(':')[0]!))) errors.push(text)
      }
    }
    return {
      line,
      key,
      ...(parsed.success && errors.length === 0
        ? { value: parsed.data as Record<string, unknown> }
        : {}),
      errors,
    }
  })

  // Duplicates inside the file (the backend also rejects them per request; chunk boundaries could hide them).
  const seen = new Map<string, number>()
  for (const b of built) {
    if (!b.key) continue
    const first = seen.get(b.key)
    if (first !== undefined) {
      b.errors.push(`Duplicate of row ${first}.`)
      delete b.value
    } else seen.set(b.key, b.line)
  }
  if (kind === 'products') {
    const gtins = new Map<string, number>()
    for (const b of built) {
      const g = (b.value as { gtins?: { value: string }[] } | undefined)?.gtins?.[0]?.value
      if (!g) continue
      const first = gtins.get(g)
      if (first !== undefined) {
        b.errors.push(`GTIN ${g} is also on row ${first}.`)
        delete b.value
      } else gtins.set(g, b.line)
    }
  }
  return built
}

export function chunk<T>(items: readonly T[], size = MAX_ROWS_PER_REQUEST): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/* ---------------- server report ---------------- */

export const OUTCOMES = ['VALID', 'APPLIED', 'FAILED', 'NOT_ATTEMPTED', 'UNCHANGED'] as const

export const importReportSchema = z.object({
  importId: z.string(),
  kind: z.string(),
  dryRun: z.boolean(),
  rows: z.number().int(),
  applied: z.number().int(),
  failed: z.number().int(),
  notAttempted: z.number().int(),
  unchanged: z.number().int().default(0),
  results: z.array(
    z.object({
      row: z.number().int(),
      key: z.string().nullish(),
      outcome: z.string(),
      version: z.number().int().nullish(),
      code: z.string().nullish(),
      message: z.string().nullish(),
    }),
  ),
})
export type ImportReport = z.infer<typeof importReportSchema>

export interface RowError {
  row: number
  code: string
  message: string
}

/** Bounded, sanitized row errors from a 422 INVALID_IMPORT body: at most 500, short text, closed code grammar. */
export function safeRowErrors(body: unknown): RowError[] {
  const list = (body as { rowErrors?: unknown } | null)?.rowErrors
  if (!Array.isArray(list)) return []
  return list.slice(0, 500).flatMap((e): RowError[] => {
    const r = e as { row?: unknown; code?: unknown; message?: unknown }
    if (typeof r.row !== 'number' || !Number.isInteger(r.row) || r.row < 0) return []
    return [
      {
        row: r.row,
        code: typeof r.code === 'string' && /^[A-Z_]{1,40}$/.test(r.code) ? r.code : 'INVALID_ROW',
        message: typeof r.message === 'string' ? r.message.slice(0, 200) : '',
      },
    ]
  })
}
