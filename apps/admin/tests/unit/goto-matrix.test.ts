import { describe, expect, it } from 'vitest'
import { resolveGoto } from '@/lib/goto'
import { canSee, NAV } from '@/lib/nav'
import { ACCESS_MATRIX, MATRIX_ROLES } from '@/lib/roles'

const all = ['reader', 'cms-writer', 'audit-reader', 'order-ops', 'support-agent']

describe('go-to resolution', () => {
  it.each([
    ['TZP-1001', '/catalogue/products/TZP-1001'],
    ['TZP-l001', '/catalogue/products/TZP-l001'],
    ['TZP-Med-3', '/catalogue/products/TZP-Med-3'],
    ['ORD_abcdef12', '/orders/ORD_abcdef12'],
    ['SUP_abcdefghijklmnopqrst', '/support/SUP_abcdefghijklmnopqrst'],
    ['CB_abcdefghijklmnop', '/content/faqs/CB_abcdefghijklmnop'],
    ['tzc-000123', '/catalogue/taxonomy?parent=TZC-000123'],
    ['560047', '/delivery/service-areas/560047'],
    ['IMPJ-0123456789abcdef01234567', '/catalogue/imports/jobs/IMPJ-0123456789abcdef01234567'],
    ['req_0123456789abcdef0123', '/system/audit?requestId=req_0123456789abcdef0123'],
  ])('%s -> %s', (input, href) => {
    expect(resolveGoto(input, all)).toEqual({ ok: true, target: expect.objectContaining({ href }) })
  })
  it('trims, and rejects empty and unrecognised input with guidance, never guessing a module', () => {
    expect(resolveGoto('  560047 ', all).ok).toBe(true)
    expect(resolveGoto('', all)).toMatchObject({ ok: false })
    const r = resolveGoto('basmati rice', all)
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).toMatch(/exact id/)
  })
  it('never builds a path from path-shaped input', () => {
    for (const bad of [
      'TZP-1/../x',
      'tzp-1001',
      '../../etc/passwd',
      'ORD_abc/def',
      '560047/../1',
      'javascript:alert(1)',
      'https://evil.example',
      'IMPJ-0123456789ABCDEF01234567',
      'IMPJ-0123456789abcdef01234567/../x',
      'impj-0123456789abcdef01234567',
    ])
      expect(resolveGoto(bad, all).ok, bad).toBe(false)
  })
  it('only offers modules the viewer can use', () => {
    expect(resolveGoto('ORD_abcdef12', ['reader'])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Orders/),
    })
    expect(resolveGoto('TZP-1', ['order-ops'])).toMatchObject({ ok: false })
    expect(resolveGoto('IMPJ-0123456789abcdef01234567', ['reader']).ok).toBe(true)
    expect(resolveGoto('IMPJ-0123456789abcdef01234567', ['order-ops'])).toMatchObject({ ok: false })
    expect(resolveGoto('TZP-1', ['reader']).ok).toBe(true)
    expect(resolveGoto('req_0123456789abcdef0123', ['cms-writer']).ok).toBe(false)
    expect(resolveGoto('req_0123456789abcdef0123', ['audit-reader']).ok).toBe(true)
  })
})

describe('access matrix', () => {
  it('has exactly the five backend roles, and no invented personas', () => {
    expect([...MATRIX_ROLES]).toEqual([
      'reader',
      'cms-writer',
      'audit-reader',
      'order-ops',
      'support-agent',
    ])
    expect(JSON.stringify(ACCESS_MATRIX)).not.toMatch(
      /CATALOG_MANAGER|PRICING_MANAGER|SUPER_ADMIN|INVENTORY_MANAGER|CONTENT_MANAGER/,
    )
  })
  it('agrees with the role-gated navigation: a role sees a module only if the matrix grants it read', () => {
    const area: Record<string, string> = {
      dashboard: 'Dashboard summary',
      products: 'Products, taxonomy, attributes',
      taxonomy: 'Products, taxonomy, attributes',
      imports: 'Bulk imports',
      'import-jobs': 'Import jobs (background, any size)',
      media: 'Pricing, stock, media',
      pricing: 'Pricing, stock, media',
      inventory: 'Pricing, stock, media',
      orders: 'Orders',
      'service-areas': 'Service areas, delivery slots',
      slots: 'Service areas, delivery slots',
      support: 'Support cases',
      'home-content': 'Home content, FAQs, app config',
      faqs: 'Home content, FAQs, app config',
      'app-config': 'Home content, FAQs, app config',
      audit: 'Audit log',
    }
    for (const item of NAV.flatMap((s) => s.items)) {
      const name = area[item.id]
      if (!name) continue
      const row = ACCESS_MATRIX.find((r) => r.area === name)!
      for (const role of MATRIX_ROLES) {
        expect(canSee(item, [role]), `${item.id} / ${role}`).toBe(row.access[role] !== '')
      }
    }
  })
  it('writes are only cms-writer (catalogue), order-ops (orders) and support-agent (support)', () => {
    const writers = (name: string) =>
      MATRIX_ROLES.filter((r) => ACCESS_MATRIX.find((x) => x.area === name)!.access[r] === 'R W')
    expect(writers('Products, taxonomy, attributes')).toEqual(['cms-writer'])
    expect(writers('Orders')).toEqual(['order-ops'])
    expect(writers('Support cases')).toEqual(['support-agent'])
    expect(writers('Audit log')).toEqual([])
  })
})
