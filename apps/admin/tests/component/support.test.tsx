import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SupportActions } from '@/components/support/SupportActions'
import { SupportCaseView } from '@/components/support/SupportCaseView'
import { SupportListView } from '@/components/support/SupportListView'
import { ToastProvider } from '@/components/ui/Toast'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}))

const summary = (id: string, over: Record<string, unknown> = {}) => ({
  caseId: id,
  customerId: 'C-1',
  category: 'DELIVERY',
  subject: `Subject ${id}`,
  status: 'OPEN',
  assignedTo: null,
  messageCount: 2,
  version: 1,
  updatedAt: '2026-10-06T03:30:00Z',
  ...over,
})
const theCase = (over: Record<string, unknown> = {}) => ({
  caseId: 'SUP_1',
  customerId: 'C-1',
  category: 'ORDER_ISSUE',
  orderId: 'O-100',
  subject: 'Late order',
  status: 'OPEN',
  assignedTo: null,
  version: 2,
  messages: [
    {
      id: 1,
      author: 'CUSTOMER',
      text: '<img src=x onerror=alert(1)>\nwhere is it',
      at: '2026-10-06T03:30:00Z',
    },
    {
      id: 2,
      author: 'STAFF',
      staffId: 'google:9',
      text: 'Checking',
      at: '2026-10-06T03:40:00Z',
    },
  ],
  ...over,
})

describe('SupportListView', () => {
  it('shows status, who it is assigned to, de-duplicates repeated ids, and pages with the cursor', () => {
    render(
      <SupportListView
        result={{
          kind: 'ok',
          data: {
            items: [
              summary('SUP_1', { assignedTo: 'google:me' }),
              summary('SUP_1'),
              summary('SUP_2', { assignedTo: 'google:other' }),
            ],
            nextCursor: 'zz',
          },
        }}
        query={{ status: 'OPEN' }}
        myActorId="google:me"
      />,
    )
    expect(screen.getAllByRole('link', { name: /Subject SUP_1/ })).toHaveLength(1)
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByText('A teammate')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Older' })).toHaveAttribute(
      'href',
      '/support?status=OPEN&cursor=zz',
    )
  })
  it('permission and empty states', () => {
    const { rerender } = render(<SupportListView result={{ kind: 'forbidden' }} query={{}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('support-agent and order-ops')
    rerender(<SupportListView result={{ kind: 'ok', data: { items: [] } }} query={{}} />)
    expect(screen.getByText('No cases')).toBeInTheDocument()
  })
})

describe('SupportCaseView', () => {
  it('renders message text as inert text, links the order only when the viewer may read orders, and never claims names', () => {
    const { container, rerender } = render(
      <ToastProvider>
        <SupportCaseView
          result={{ kind: 'ok', data: theCase() }}
          canWork={false}
          canSeeOrders
          myActorId="google:me"
        />
      </ToastProvider>,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/onerror=alert/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'O-100' })).toHaveAttribute('href', '/orders/O-100')
    expect(screen.getByRole('note')).toHaveTextContent('support-agent')
    rerender(
      <ToastProvider>
        <SupportCaseView
          result={{ kind: 'ok', data: theCase() }}
          canWork={false}
          canSeeOrders={false}
        />
      </ToastProvider>,
    )
    expect(screen.queryByRole('link', { name: 'O-100' })).toBeNull()
  })
})

describe('SupportActions', () => {
  beforeEach(() => {
    refresh.mockClear()
    vi.restoreAllMocks()
  })
  const mount = (status = 'OPEN', assignedToMe = false) =>
    render(
      <ToastProvider>
        <SupportActions caseId="SUP_1" status={status} version={2} assignedToMe={assignedToMe} />
      </ToastProvider>,
    )
  it('validates the reply, sends exactly once without a version, clears the draft on success', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: { version: 3 } }), { status: 200 }))
    mount()
    expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled()
    await user.type(screen.getByLabelText('Reply to the customer'), 'On its way')
    await user.click(screen.getByRole('button', { name: 'Send reply' }))
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0]![0]).toBe('/api/bff/support/SUP_1/messages')
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({ message: 'On its way' })
    expect(screen.getByLabelText('Reply to the customer')).toHaveValue('')
  })
  it('keeps the draft when sending fails and does not retry', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: 'upstream_error' }), { status: 502 }))
    mount()
    await user.type(screen.getByLabelText('Reply to the customer'), 'Please wait')
    await user.click(screen.getByRole('button', { name: 'Send reply' }))
    expect(await screen.findByText(/may already have been sent/)).toBeInTheDocument()
    expect(screen.getByLabelText('Reply to the customer')).toHaveValue('Please wait')
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('offers only legal status moves and confirms before calling; closed cases have none', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const { unmount } = mount('RESOLVED', true)
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Mark closed' }))
    expect(f).not.toHaveBeenCalled()
    await user.click(
      within(screen.getByRole('dialog', { hidden: true })).getByRole('button', {
        name: 'Mark closed',
        hidden: true,
      }),
    )
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      to: 'CLOSED',
      expectedVersion: 2,
    })
    unmount()
    mount('CLOSED')
    expect(screen.getByText(/case is closed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Mark|Reopen|Assign/ })).toBeNull()
  })
})
