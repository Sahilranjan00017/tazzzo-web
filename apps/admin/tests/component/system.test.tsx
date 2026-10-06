import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AuditView } from '@/components/system/AuditView'
import { NotificationsView } from '@/components/system/NotificationsView'
import { StatusView } from '@/components/system/StatusView'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

const ev = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  occurredAt: '2026-10-06T03:30:00Z',
  action: 'PRICE_SET',
  targetType: 'product',
  targetId: 'TZP-1',
  actorType: 'HUMAN_ADMIN',
  actorId: 'google:123',
  credentialId: null,
  requestId: 'req_0123456789abcdef0123',
  ...over,
})

describe('AuditView', () => {
  it('shows attributed fields in IST, links the request id to a filtered view, keeps filters on paging', () => {
    render(
      <AuditView
        result={{ kind: 'ok', data: { items: [ev('e1')], nextCursor: 'nxt' } }}
        query={{ actorType: 'HUMAN_ADMIN', cursor: 'cur' }}
        problems={['Ignored invalid action.']}
        roles={['audit-reader']}
      />,
    )
    expect(screen.getByText('PRICE_SET')).toBeInTheDocument()
    expect(screen.getByText(/9:00:00 am/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'req_0123456789abcdef0123' })).toHaveAttribute(
      'href',
      '/system/audit?requestId=req_0123456789abcdef0123',
    )
    expect(screen.getByRole('link', { name: 'Older' })).toHaveAttribute(
      'href',
      '/system/audit?actorType=HUMAN_ADMIN&cursor=nxt',
    )
    expect(screen.getByRole('link', { name: 'Newest' })).toHaveAttribute(
      'href',
      '/system/audit?actorType=HUMAN_ADMIN',
    )
    expect(screen.getByText('Ignored invalid action.')).toBeInTheDocument()
  })
  it('renders no raw payloads or secrets (only the safe fields)', () => {
    const { container } = render(
      <AuditView
        result={{
          kind: 'ok',
          data: { items: [ev('e1', { detail: 'password=hunter2', token: 'eyJxxx' })] },
        }}
        query={{}}
        problems={[]}
        roles={['audit-reader']}
      />,
    )
    expect(container.innerHTML).not.toMatch(/hunter2|eyJxxx/)
  })
  it('403 explains the audit-reader rule and the known mixed-role limitation only when relevant', () => {
    const { rerender } = render(
      <AuditView result={{ kind: 'forbidden' }} query={{}} problems={[]} roles={['reader']} />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('audit-reader')
    expect(screen.getByRole('alert')).not.toHaveTextContent('Known backend limitation')
    rerender(
      <AuditView
        result={{ kind: 'forbidden' }}
        query={{}}
        problems={[]}
        roles={['audit-reader', 'order-ops']}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Known backend limitation')
  })
  it('empty state', () => {
    render(
      <AuditView
        result={{ kind: 'ok', data: { items: [] } }}
        query={{}}
        problems={[]}
        roles={['audit-reader']}
      />,
    )
    expect(screen.getByText('No events')).toBeInTheDocument()
  })
})

describe('StatusView', () => {
  const up = {
    kind: 'ok' as const,
    httpStatus: 200,
    data: { status: 'UP', components: { datastore: 'OPEN', mongo: 'SKIPPED' } },
  }
  it('shows reported components, a DOWN readiness, and never a backend URL', () => {
    const { container } = render(
      <StatusView
        live={up}
        ready={{
          kind: 'ok',
          httpStatus: 503,
          data: { status: 'DOWN', components: { mongo: 'DOWN' } },
        }}
        environment="production"
        cmsOrigin="https://admin.tazzzo.com"
      />,
    )
    expect(screen.getAllByText('DOWN', { selector: '.badge' }).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('HTTP 503')).toBeInTheDocument()
    expect(screen.getByText('production')).toBeInTheDocument()
    expect(container.innerHTML).not.toMatch(/api\.tazzzo|127\.0\.0\.1/)
    expect(screen.getByText(/Nothing is invented here/)).toBeInTheDocument()
  })
  it('an unreachable probe says unreachable, with a reason, and no invented status', () => {
    render(
      <StatusView
        live={{ kind: 'unavailable', reason: 'timeout' }}
        ready={{ kind: 'not_found' }}
        environment="test"
        cmsOrigin="http://localhost"
      />,
    )
    expect(screen.getAllByText('Unreachable')).toHaveLength(2)
    expect(screen.getByText(/No answer within the timeout/)).toBeInTheDocument()
    expect(screen.getByText(/not served/)).toBeInTheDocument()
    expect(screen.queryByText('UP')).toBeNull()
  })
})

describe('NotificationsView', () => {
  const data = (pending: number, failed: number, capped = false) => ({
    kind: 'ok' as const,
    data: {
      notifications: { pending: { value: pending, capped }, failed: { value: failed, capped } },
    } as never,
  })
  it('shows only the two real counters, lower-bounds capped ones, and labels the rest as blocked by the backend', () => {
    render(<NotificationsView result={data(10000, 3, true)} />)
    const pending = screen.getByText('Pending').closest('.kpi')!
    expect(within(pending as HTMLElement).getByText('10,000+')).toBeInTheDocument()
    expect(screen.getAllByText(/Lower bound/).length).toBe(2)
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(screen.getByText(/Not available from the backend/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry|resend/i })).toBeNull()
  })
  it('explains who may see the counters', () => {
    render(<NotificationsView result={{ kind: 'forbidden' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('reader and cms-writer')
  })
})
