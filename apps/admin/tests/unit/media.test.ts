import { beforeAll, describe, expect, it } from 'vitest'
import { altText, mediaErrorMessage, setInput } from '@/lib/media'

const asset = (over: Record<string, unknown> = {}) => ({
  assetId: 'A1',
  assetKey: 'p/product/tzp-1/abc.jpg',
  role: 'PRIMARY',
  sortOrder: 0,
  ...over,
})
const set = (assets: unknown[], extra: Record<string, unknown> = {}) => ({
  ownerType: 'product',
  ownerId: 'TZP-1',
  assets,
  expectedVersion: 2,
  ...extra,
})

describe('media set schema', () => {
  it('accepts a valid set, an empty set (clear) and optional metadata', () => {
    expect(
      setInput.safeParse(
        set([
          asset(),
          asset({
            assetId: 'A2',
            assetKey: 'p/product/tzp-1/def.png',
            role: 'GALLERY',
            sortOrder: 1,
            altText: 'Front',
            width: 800,
            height: 800,
            contentType: 'image/png',
          }),
        ]),
      ).success,
    ).toBe(true)
    expect(setInput.safeParse(set([])).success).toBe(true)
  })
  it.each([
    ['two primaries', [asset(), asset({ assetId: 'A2', assetKey: 'k2', sortOrder: 1 })]],
    ['primary not at order 0', [asset({ sortOrder: 3 })]],
    ['duplicate order', [asset(), asset({ assetId: 'A2', assetKey: 'k2', role: 'GALLERY' })]],
    ['duplicate key', [asset(), asset({ assetId: 'A2', role: 'GALLERY', sortOrder: 1 })]],
    ['duplicate id', [asset(), asset({ assetKey: 'k2', role: 'GALLERY', sortOrder: 1 })]],
    ['alt text with <', [asset({ altText: '<b>x</b>' })]],
    ['alt text too long', [asset({ altText: 'x'.repeat(301) })]],
    ['width without height', [asset({ width: 10 })]],
    ['unsupported content type', [asset({ contentType: 'image/gif' })]],
    ['key traversal', [asset({ assetKey: 'p/../x' })]],
    ['key double slash', [asset({ assetKey: 'p//x' })]],
    ['key leading slash', [asset({ assetKey: '/p/x' })]],
    ['unknown role', [asset({ role: 'primary' })]],
    [
      'too many assets',
      Array.from({ length: 51 }, (_, i) =>
        asset({ assetId: `A${i}`, assetKey: `k${i}`, role: 'GALLERY', sortOrder: i + 1 }),
      ),
    ],
  ])('rejects %s', (_n, assets) =>
    expect(setInput.safeParse(set(assets as unknown[])).success).toBe(false),
  )
  it('rejects unknown keys, a bad owner and a bad id', () => {
    expect(setInput.safeParse(set([], { url: 'https://evil' })).success).toBe(false)
    expect(setInput.safeParse(set([], { ownerType: 'banner' })).success).toBe(false)
    expect(setInput.safeParse(set([], { ownerId: 'x/../y' })).success).toBe(false)
  })
})

describe('alt text and copy', () => {
  it('mirrors the backend alt-text rule: trimmed, <=300, no angle brackets, no control characters', () => {
    expect(altText.parse('  Front view  ')).toBe('Front view')
    expect(altText.safeParse('x'.repeat(300)).success).toBe(true)
    expect(altText.safeParse(' ' + 'x'.repeat(300) + ' ').success).toBe(true) // trimmed first
    for (const bad of ['a\u0000b', 'tab\there', 'line\nbreak', 'del\u007f', '<b>', 'x'.repeat(301)])
      expect(altText.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    // Leading/trailing control whitespace is trimmed away, as the backend's String.trim() does.
    expect(altText.parse('\tFront\n')).toBe('Front')
  })
  it('names each backend code, including the storage outage, and never claims success', () => {
    const f = (status: number, code?: string) => ({ ok: false as const, status, error: 'x', code })
    expect(mediaErrorMessage(f(502, 'MEDIA_STORAGE_NOT_CONFIGURED'))).toMatch(
      /no media storage is configured/,
    )
    expect(mediaErrorMessage(f(502, 'MEDIA_STORAGE_UNAVAILABLE'))).toMatch(/storage is unavailable/)
    expect(mediaErrorMessage(f(503, 'UPLOAD_ORIGIN_NOT_CONFIGURED'))).toMatch(
      /not enabled in this CMS deployment/,
    )
    expect(mediaErrorMessage(f(422, 'INVALID_MEDIA'))).toMatch(/missing from storage/)
    expect(mediaErrorMessage(f(409, 'STALE_VERSION'))).toMatch(/Your edits are still shown/)
    expect(mediaErrorMessage(f(502))).toMatch(/Nothing was changed/)
  })
})

describe('media BFF specs', () => {
  let a: typeof import('@/server/bff/media-actions')
  beforeAll(async () => {
    a = await import('@/server/bff/media-actions')
  })
  it('set: fixed path, whole-set body, version only when given', () => {
    const input = a.putMediaSetMutation.input.parse(set([asset()]))
    expect(a.putMediaSetMutation.backend(input)).toMatchObject({
      path: '/api/v1/admin/media/product/TZP-1',
      body: { expectedVersion: 2 },
    })
  })
  it('upload request: strict and bounded input; only the validated target fields reach the browser', () => {
    const ok = { ownerType: 'product', ownerId: 'TZP-1', contentType: 'image/png', sizeBytes: 1000 }
    expect(a.requestUploadMutation.input.safeParse(ok).success).toBe(true)
    expect(a.requestUploadMutation.input.safeParse({ ...ok, sizeBytes: 52_428_801 }).success).toBe(
      false,
    )
    expect(
      a.requestUploadMutation.input.safeParse({ ...ok, contentType: 'image/svg+xml' }).success,
    ).toBe(false)
    expect(
      a.requestUploadMutation.input.safeParse({ ...ok, contentType: 'text/html' }).success,
    ).toBe(false)
    expect(a.requestUploadMutation.input.safeParse({ ...ok, url: 'https://x' }).success).toBe(false)
    expect(a.requestUploadMutation.backend(a.requestUploadMutation.input.parse(ok))).toEqual({
      path: '/api/v1/admin/media/uploads',
      body: ok,
    })
    expect(a.requestUploadMutation.precondition).toBeDefined()
  })
})
