import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderActions } from '@/components/orders/OrderActions'
import { OrderDetailView } from '@/components/orders/OrderDetailView'
import { OrderListView } from '@/components/orders/OrderListView'
import { ToastProvider } from '@/components/ui/Toast'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}))

const order = (over: Record<string, unknown> = {}) => ({
  orderId: 'O-100',
  customerId: 'C-1',
  status: 'CONFIRMED',
  version: 2,
  paymentMethod: 'COD',
  lines: [
    {
      skuId: 'TZP-1',
      title: 'Basmati 5 kg',
      quantity: 2,
      unitPricePaise: 12900,
      lineTotalPaise: 25800,
    },
  ],
  itemCount: 2,
  subtotalPaise: 25800,
  payablePaise: 25800,
  deliveryAddress: {
    recipientName: 'A Customer',
    recipientPhone: '+919900000000',
    addressLine1: '12 Main Rd',
    city: 'Bengaluru',
    state: 'KA',
    postalCode: '560047',
  },
  deliverySlot: { label: 'Today 6-8 pm' },
  createdAt: '2026-10-06T03:30:00Z',
  confirmedAt: '2026-10-06T03:31:00Z',
  ...over,
})

describe('OrderListView', () => {
  it('lists orders with status, IST time and a status filter; pages with the opaque cursor', () => {
    render(
      <OrderListView
        result={{ kind: 'ok', data: { items: [order()], nextCursor: 'abc' } }}
        query={{ status: 'CONFIRMED' }}
      />,
    )
    expect(screen.getByRole('link', { name: 'O-100' })).toHaveAttribute('href', '/orders/O-100')
    expect(screen.getByText('Confirmed', { selector: '.badge' })).toBeInTheDocument()
    expect(screen.getByText(/9:00 am/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Older' })).toHaveAttribute(
      'href',
      '/orders?status=CONFIRMED&cursor=abc',
    )
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('CONFIRMED')
  })
  it('shows permission and empty states', () => {
    const { rerender } = render(<OrderListView result={{ kind: 'forbidden' }} query={{}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('order-ops and support-agent')
    rerender(<OrderListView result={{ kind: 'ok', data: { items: [] } }} query={{}} />)
    expect(screen.getByText('No orders')).toBeInTheDocument()
  })
})

describe('OrderDetailView', () => {
  it('shows items, totals, contact and recorded timestamps; never coordinates; no timeline claim', () => {
    const { container } = render(
      <ToastProvider>
        <OrderDetailView
          result={{
            kind: 'ok',
            data: order({
              deliveryAddress: { ...order().deliveryAddress, latitude: 12.9, longitude: 77.6 },
            }),
          }}
          canOperate={false}
        />
      </ToastProvider>,
    )
    expect(screen.getByText('Basmati 5 kg')).toBeInTheDocument()
    expect(screen.getByText('A Customer')).toBeInTheDocument()
    expect(container.innerHTML).not.toMatch(/12\.9|77\.6/)
    expect(screen.getByText(/no event history or per-step actor/)).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('order-ops')
    expect(screen.queryByRole('button', { name: /Mark|Cancel/ })).toBeNull()
  })
  it('explains who cancelled and why', () => {
    render(
      <ToastProvider>
        <OrderDetailView
          result={{
            kind: 'ok',
            data: order({
              status: 'CANCELLED',
              cancelledBy: 'STAFF',
              cancelReason: 'OUT_OF_STOCK',
              cancelledAt: '2026-10-06T04:00:00Z',
            }),
          }}
          canOperate
        />
      </ToastProvider>,
    )
    expect(screen.getByText(/Cancelled by/)).toHaveTextContent('staff')
    expect(screen.getByText(/Out of stock/)).toBeInTheDocument()
    expect(screen.getByText(/final and has no further actions/)).toBeInTheDocument()
  })
})

describe('OrderActions', () => {
  beforeEach(() => {
    refresh.mockClear()
    vi.restoreAllMocks()
  })
  const mount = (status = 'CONFIRMED') =>
    render(
      <ToastProvider>
        <OrderActions orderId="O-100" status={status} version={2} />
      </ToastProvider>,
    )
  it('offers only legal actions and confirms before calling', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    mount('OUT_FOR_DELIVERY')
    expect(screen.getByRole('button', { name: 'Mark delivered' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark out for delivery' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Mark delivered' }))
    expect(f).not.toHaveBeenCalled()
  })
  it('cancel needs a reason (Confirm stays disabled), then sends reason and version once', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: { version: 3 } }), { status: 200 }))
    mount()
    await user.click(screen.getByRole('button', { name: 'Cancel order' }))
    const dialog = screen.getByRole('dialog', { hidden: true })
    const confirm = within(dialog).getByRole('button', { name: 'Cancel order', hidden: true })
    expect(confirm).toBeDisabled()
    await user.selectOptions(
      within(dialog).getByLabelText('Cancellation reason (required)'),
      'CUSTOMER_UNREACHABLE',
    )
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0]![0]).toBe('/api/bff/orders/O-100/transition')
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      to: 'CANCELLED',
      expectedVersion: 2,
      reason: 'CUSTOMER_UNREACHABLE',
    })
  })
  it('on an invalid-transition conflict shows the reason and reloads without retrying', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'conflict', code: 'INVALID_TRANSITION' }), {
        status: 409,
      }),
    )
    mount()
    await user.click(screen.getByRole('button', { name: 'Mark out for delivery' }))
    await user.click(
      within(screen.getByRole('dialog', { hidden: true })).getByRole('button', {
        name: 'Mark out for delivery',
        hidden: true,
      }),
    )
    expect(await screen.findByText(/not allowed from the order/)).toBeInTheDocument()
    expect(f).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalled()
  })
})
