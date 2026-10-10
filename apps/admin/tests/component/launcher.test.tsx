import { render as plainRender, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/ui/Toast'
import { InventoryView } from '@/components/inventory/InventoryView'
import { LauncherView, type LauncherDashboard } from '@/components/launcher/LauncherView'
import { ProductDetailView } from '@/components/products/ProductDetailView'
import type { DashboardSummary } from '@/lib/dashboard'
import { attentionItems, canReadDashboard, launcherFor } from '@/lib/launcher'
import { moduleHref } from '@/lib/nav'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined, replace: vi.fn(), push: vi.fn() }),
}))

const render = (ui: React.ReactNode) => plainRender(<ToastProvider>{ui}</ToastProvider>)
const c = (value: number, capped = false) => ({ value, capped })
const summary = (over: Partial<DashboardSummary> = {}): DashboardSummary => ({
  orders: {
    open_confirmed: c(0),
    open_out_for_delivery: c(0),
    last24h_confirmed: c(0),
    last24h_out_for_delivery: c(0),
    last24h_delivered: c(0),
    last24h_cancelled: c(0),
  },
  inventory: { out_of_stock: c(0), low_stock: c(0) },
  catalog: { products_total: c(5), active: c(5), draft: c(0) },
  serviceability: { service_areas_total: c(1), active: c(1) },
  support: { open: c(0), in_progress: c(0) },
  notifications: { pending: c(0), failed: c(0) },
  generatedAt: '2026-10-06T03:30:00Z',
  bounds: { cap: 10000, maxTimeMs: 2000, recentWindowHours: 24 },
  ...over,
})
const okDash = (d: DashboardSummary): LauncherDashboard => ({ kind: 'ok', data: d })
const ids = (roles: string[]) => launcherFor(roles).flatMap((s) => s.cards.map((x) => x.id))

describe('launcherFor (role-aware cards)', () => {
  it('a cms-writer sees the catalogue, commerce, content and system modules but never orders or support', () => {
    const got = ids(['cms-writer'])
    expect(got).toEqual(
      expect.arrayContaining([
        'dashboard',
        'products',
        'imports',
        'pricing',
        'legal',
        'app-config',
      ]),
    )
    expect(got).not.toContain('orders')
    expect(got).not.toContain('support')
    expect(got).not.toContain('audit')
    expect(got).not.toContain('home')
  })
  it('a reader gets no cms-writer-only Imports card', () => {
    expect(ids(['reader'])).not.toContain('imports')
    expect(ids(['reader'])).toContain('import-jobs')
  })
  it('order-ops and support-agent see only operations, never the dashboard or catalogue', () => {
    const ops = ids(['order-ops'])
    expect(ops).toEqual(expect.arrayContaining(['orders', 'support', 'status', 'account']))
    expect(ops).not.toContain('products')
    expect(ops).not.toContain('dashboard')
    expect(ids(['audit-reader'])).toContain('audit')
  })
  it('every card links to a path its roles can use (same source as the sidebar)', () => {
    for (const roles of [
      ['reader'],
      ['cms-writer'],
      ['order-ops'],
      ['support-agent'],
      ['audit-reader'],
    ]) {
      for (const s of launcherFor(roles))
        for (const card of s.cards) expect(moduleHref(card.id, roles), card.id).toBe(card.href)
    }
    expect(launcherFor([])).toEqual(launcherFor([]).filter((s) => s.cards.length > 0))
  })
  it('only reader and cms-writer are served the dashboard summary', () => {
    expect(canReadDashboard(['reader'])).toBe(true)
    expect(canReadDashboard(['cms-writer', 'audit-reader'])).toBe(true)
    expect(canReadDashboard(['order-ops', 'support-agent', 'audit-reader'])).toBe(false)
  })
})

describe('attentionItems', () => {
  it('lists only non-zero figures, keeps capped values as lower bounds, and links only what the roles can open', () => {
    const d = summary({
      inventory: { out_of_stock: c(4), low_stock: c(10000, true) },
      notifications: { pending: c(9), failed: c(2) },
      support: { open: c(3), in_progress: c(1) },
    })
    const items = attentionItems(d, (id) => moduleHref(id, ['reader']))
    expect(items.map((i) => i.id)).toEqual([
      'out-of-stock',
      'low-stock',
      'failed-notifications',
      'open-support',
    ])
    expect(items.find((i) => i.id === 'low-stock')).toMatchObject({ value: 10000, capped: true })
    expect(items.find((i) => i.id === 'out-of-stock')?.href).toBe('/inventory')
    expect(items.find((i) => i.id === 'open-support')?.href).toBeUndefined()
    expect(attentionItems(summary(), () => undefined)).toEqual([])
  })
})

describe('LauncherView', () => {
  it('shows cards and a needs-attention strip from the dashboard summary', () => {
    render(
      <LauncherView
        roles={['cms-writer']}
        writer
        dashboard={okDash(summary({ inventory: { out_of_stock: c(4), low_stock: c(0) } }))}
      />,
    )
    expect(screen.getByText('You can view and edit catalogue content.')).toBeInTheDocument()
    expect(screen.getByTestId('attention-out-of-stock')).toHaveTextContent('4')
    expect(screen.getByTestId('attention-out-of-stock').querySelector('a')).toHaveAttribute(
      'href',
      '/inventory',
    )
    expect(screen.queryByTestId('attention-low-stock')).toBeNull()
    expect(screen.getByRole('link', { name: 'Legal' })).toHaveAttribute('href', '/content/legal')
    expect(screen.queryByText(/Soon/)).toBeNull()
  })
  it('says nothing needs attention when every figure is zero', () => {
    render(<LauncherView roles={['reader']} writer={false} dashboard={okDash(summary())} />)
    expect(screen.getByTestId('attention-none')).toBeInTheDocument()
    expect(screen.getByText('Editing controls are hidden for your roles.')).toBeInTheDocument()
  })
  it('degrades to links only when the summary fails, without partial numbers', () => {
    render(
      <LauncherView
        roles={['reader']}
        writer={false}
        dashboard={{ kind: 'unavailable', reason: 'timeout' } as LauncherDashboard}
      />,
    )
    expect(screen.getByText(/live summary is unavailable/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Products' })).toBeInTheDocument()
  })
  it('roles without the dashboard get cards and no attention panel', () => {
    render(
      <LauncherView roles={['order-ops']} writer={false} dashboard={{ kind: 'not_requested' }} />,
    )
    expect(screen.queryByText('Needs attention')).toBeNull()
    expect(screen.getByRole('link', { name: 'Orders' })).toHaveAttribute('href', '/orders')
    expect(screen.queryByRole('link', { name: 'Products' })).toBeNull()
  })
  it('an account with no usable role still gets the two modules everyone has', () => {
    render(<LauncherView roles={[]} writer={false} dashboard={{ kind: 'not_requested' }} />)
    expect(screen.getByRole('link', { name: 'System status' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Profile & access' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Products' })).toBeNull()
  })
})

describe('ProductDetailView operator navigation', () => {
  const product = {
    id: 'TZP-REF-1',
    title: 'Reference rice',
    productType: 'single',
    lifecycle: 'active',
    version: 3,
    attributes: {},
  } as never
  it('links Price, Stock, Media and Import for this product and explains what can be edited', () => {
    render(<ProductDetailView result={{ kind: 'ok', data: product }} canWrite />)
    expect(screen.getByRole('link', { name: 'Price' })).toHaveAttribute(
      'href',
      '/pricing?sku=TZP-REF-1',
    )
    expect(screen.getByRole('link', { name: 'Stock' })).toHaveAttribute(
      'href',
      '/inventory?sku=TZP-REF-1',
    )
    expect(screen.getByRole('link', { name: 'Media' })).toHaveAttribute(
      'href',
      '/catalogue/media?type=product&id=TZP-REF-1',
    )
    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute(
      'href',
      '/catalogue/imports',
    )
    expect(screen.getByText(/title and the lifecycle/)).toBeInTheDocument()
    expect(screen.queryByText(/Soon/)).toBeNull()
  })
  it('a reader has no Import link and is told it needs cms-writer', () => {
    render(<ProductDetailView result={{ kind: 'ok', data: product }} canWrite={false} />)
    expect(screen.queryByRole('link', { name: 'Import' })).toBeNull()
    expect(screen.getByText(/Import \(needs the cms-writer role\)/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Price' })).toBeInTheDocument()
  })
})

describe('Inventory with a product but no location', () => {
  it('asks for the location instead of showing an input error', () => {
    render(<InventoryView sku="TZP-REF-1" canWrite needLocation />)
    expect(screen.getByRole('status')).toHaveTextContent('Enter the location id')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText('Product id')).toHaveValue('TZP-REF-1')
  })
})
