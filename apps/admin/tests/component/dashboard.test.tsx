import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DashboardView, type DashboardResult } from '@/components/dashboard/DashboardView'
import { formatCount, formatDateTimeIst } from '@/lib/format'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

const c = (value: number, capped = false) => ({ value, capped })
const ok = (over: Record<string, unknown> = {}): DashboardResult => ({
  kind: 'ok',
  data: {
    orders: {
      open_confirmed: c(7),
      open_out_for_delivery: c(2),
      last24h_confirmed: c(3),
      last24h_out_for_delivery: c(1),
      last24h_delivered: c(9),
      last24h_cancelled: c(0),
    },
    inventory: { out_of_stock: c(4), low_stock: c(10000, true) },
    catalog: { products_total: c(120), active: c(100), draft: c(20) },
    serviceability: { service_areas_total: c(1), active: c(1) },
    support: { open: c(5), in_progress: c(1) },
    notifications: { pending: c(0), failed: c(2) },
    generatedAt: '2026-10-06T03:30:00Z',
    bounds: { cap: 10000, maxTimeMs: 2000, recentWindowHours: 24 },
    ...over,
  },
})

describe('formatting', () => {
  it('marks capped counts as lower bounds and shows IST', () => {
    expect(formatCount(c(1234))).toBe('1,234')
    expect(formatCount(c(10000, true))).toBe('10,000+')
    expect(formatDateTimeIst('2026-10-06T03:30:00Z')).toContain('9:00:00 am IST')
    expect(formatDateTimeIst('nope')).toBe('unknown time')
  })
})

describe('DashboardView', () => {
  it('shows backend counts and flags capped values as lower bounds with an accessible phrase', () => {
    render(<DashboardView result={ok()} />)
    expect(screen.getByText('Open: confirmed').nextElementSibling).toHaveTextContent('7')
    const low = screen.getByText('Low-stock').closest('.kpi')!
    expect(low).toHaveTextContent('10,000+')
    expect(low).toHaveTextContent('at least 10,000')
    expect(low).toHaveTextContent('Lower bound')
    expect(screen.getByText('Failed notifications').closest('.kpi')).toHaveTextContent(
      'Needs attention',
    )
  })

  it('does not link metrics to modules that are not built', () => {
    render(<DashboardView result={ok()} />)
    expect(screen.queryByRole('link', { name: /View open/ })).toBeNull()
  })

  it('renders a progress distribution with a text alternative', () => {
    render(<DashboardView result={ok()} />)
    expect(screen.getByRole('progressbar', { name: 'Active: 100 of 120' })).toBeInTheDocument()
  })

  it('shows an honest empty state for an empty dataset', () => {
    render(
      <DashboardView
        result={ok({
          catalog: { products_total: c(0), active: c(0), draft: c(0) },
          serviceability: { service_areas_total: c(0), active: c(0) },
        })}
      />,
    )
    expect(screen.getByText('No catalogue or service areas yet')).toBeInTheDocument()
  })

  it.each([
    [{ kind: 'forbidden' }, 'Not permitted', false],
    [{ kind: 'not_found' }, 'Dashboard endpoint not found', true],
    [{ kind: 'rate_limited', retryAfterSeconds: 12 }, 'Too many requests', true],
    [{ kind: 'unavailable', reason: 'timeout' }, 'Dashboard unavailable', true],
  ] as const)('renders the %o failure with no fabricated numbers', (result, title, retry) => {
    render(<DashboardView result={result as DashboardResult} />)
    expect(screen.getByRole('alert')).toHaveTextContent(title)
    expect(screen.queryByRole('button', { name: 'Refresh' }) !== null).toBe(retry)
    expect(document.querySelector('.kpi')).toBeNull()
  })
})
