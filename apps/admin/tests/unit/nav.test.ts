import { describe, expect, it } from 'vitest'
import { NAV, breadcrumbsFor, isActive, navFor } from '@/lib/nav'
import { canWrite, describeRoles } from '@/lib/roles'

const ids = (roles: string[]) => navFor(roles).flatMap((s) => s.items.map((i) => i.id))

describe('role-aware navigation (UX only)', () => {
  it('shows the general surface to reader and cms-writer, but never orders, support or audit', () => {
    for (const role of ['reader', 'cms-writer']) {
      const visible = ids([role])
      expect(visible).toContain('products')
      expect(visible).toContain('pricing')
      expect(visible).not.toContain('orders')
      expect(visible).not.toContain('support')
      expect(visible).not.toContain('audit')
    }
  })

  it('shows staff namespaces only to staff roles, and no catalogue to them', () => {
    const ops = ids(['order-ops'])
    expect(ops).toEqual(expect.arrayContaining(['orders', 'support']))
    expect(ops).not.toContain('products')
    const agent = ids(['support-agent'])
    expect(agent).toEqual(expect.arrayContaining(['orders', 'support']))
    expect(agent).not.toContain('pricing')
  })

  it('shows audit only to audit-reader', () => {
    expect(ids(['audit-reader'])).toContain('audit')
    expect(ids(['audit-reader'])).not.toContain('products')
  })

  it('always offers Home, System status and Profile, even with no or unknown roles, and drops empty sections', () => {
    expect(ids([])).toEqual(['home', 'status', 'account'])
    expect(ids(['made-up-role'])).toEqual(['home', 'status', 'account'])
    expect(navFor([]).every((s) => s.items.length > 0)).toBe(true)
  })

  it('has unique ids and hrefs, all absolute in-app paths', () => {
    const items = NAV.flatMap((s) => s.items)
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
    expect(new Set(items.map((i) => i.href)).size).toBe(items.length)
    for (const i of items) expect(i.href).toMatch(/^\/[a-z0-9/-]*$/)
  })

  it('marks active routes on segment boundaries only', () => {
    expect(isActive('/', '/')).toBe(true)
    expect(isActive('/', '/orders')).toBe(false)
    expect(isActive('/orders', '/orders/123')).toBe(true)
    expect(isActive('/orders', '/orders2')).toBe(false)
  })
})

describe('breadcrumbs', () => {
  it('uses nav labels, links ancestors and leaves the last crumb unlinked', () => {
    expect(breadcrumbsFor('/catalogue/products/TZP-1')).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Catalogue', href: '/catalogue' },
      { label: 'Products', href: '/catalogue/products' },
      { label: 'TZP-1' },
    ])
  })
  it('survives malformed percent-encoding', () => {
    expect(breadcrumbsFor('/x/%E0%A4%A').at(-1)).toEqual({ label: '%E0%A4%A' })
  })
})

describe('role descriptions', () => {
  it('describes known roles and flags unknown ones without trusting them', () => {
    const [known, unknown] = describeRoles(['cms-writer', 'root'])
    expect(known).toMatchObject({ known: true, title: 'CMS writer' })
    expect(unknown).toMatchObject({ known: false, role: 'root' })
    expect(canWrite(['cms-writer'])).toBe(true)
    expect(canWrite(['reader', 'order-ops'])).toBe(false)
  })
})
