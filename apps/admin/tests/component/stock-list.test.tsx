import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StockList } from '@/components/inventory/StockList'
import { StockListView } from '@/components/inventory/StockListView'
import type { StockRow } from '@/lib/stock-list'

const replace = vi.fn()
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, replace, push: vi.fn() }) }))

beforeEach(() => {
  vi.restoreAllMocks()
  replace.mockClear()
  refresh.mockClear()
})

const row = (n: number, over: Partial<StockRow> = {}): StockRow => ({
  skuId: `TZP-${String(n).padStart(3, '0')}`,
  fulfillmentLocationId: 'LOC-1',
  onHand: 10,
  reserved: 2,
  available: 8,
  lowStockThreshold: 3,
  maxPurchasable: 5,
  version: 1,
  active: true,
  stockState: 'IN_STOCK',
  ...over,
})
const page = (items: StockRow[], nextCursor: string | null) =>
  new Response(JSON.stringify({ data: { items, nextCursor } }), { status: 200 })
const fail = (status: number, body: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error: 'x', ...body }), { status })

describe('StockList', () => {
  it('renders an accessible table; each row links to the per-SKU editor with the right verb for the role', () => {
    const { rerender } = render(
      <StockList
        initial={{ items: [row(1), row(2, { stockState: 'OUT_OF_STOCK' })], nextCursor: null }}
        filters={{}}
        canWrite
      />,
    )
    const table = screen.getByRole('table')
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Product',
      'Location',
      'State',
      'On hand',
      'Reserved',
      'Available',
      'Low-stock at',
      'Max per order',
    ])
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((h) => h.textContent),
    ).toEqual(['TZP-001', 'TZP-002'])
    const edit = screen.getByRole('link', { name: 'Edit stock for TZP-001 at LOC-1' })
    expect(edit).toHaveAttribute('href', '/inventory?sku=TZP-001&location=LOC-1')
    expect(screen.getByText('Out of stock')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Stock table' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByText(/End of the list: 2 records/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    rerender(
      <StockList initial={{ items: [row(1)], nextCursor: null }} filters={{}} canWrite={false} />,
    )
    expect(
      screen.getByRole('link', { name: 'View stock for TZP-001 at LOC-1' }),
    ).toBeInTheDocument()
  })

  it('Load more follows the keyset cursor with the same filters, appends rows, moves focus to the first new row, and ends on a null cursor', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(page([row(3), row(4)], null))
    render(
      <StockList
        initial={{ items: [row(1), row(2)], nextCursor: 'CUR1' }}
        filters={{ location: 'LOC-1', state: 'LOW_STOCK' }}
        canWrite
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(String(f.mock.calls[0]![0])).toBe(
      '/api/bff/inventory/stock?location=LOC-1&state=LOW_STOCK&limit=50&cursor=CUR1',
    )
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'GET', headers: { 'X-Tazzzo-CSRF': '1' } })
    expect(await screen.findByRole('link', { name: /TZP-004/ })).toBeInTheDocument()
    expect(screen.getAllByRole('rowheader')).toHaveLength(4)
    expect(screen.getByRole('link', { name: /TZP-003/ })).toHaveFocus()
    expect(screen.getByText('Loaded 2 more rows.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    expect(screen.getByText(/End of the list: 4 records/)).toBeInTheDocument()
  })

  it('an EMPTY page with a cursor is not the end: it is followed automatically (bounded) until rows arrive', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page([], 'C2'))
      .mockResolvedValueOnce(page([], 'C3'))
      .mockResolvedValueOnce(page([row(9)], 'C4'))
    render(<StockList initial={{ items: [row(1)], nextCursor: 'C1' }} filters={{}} canWrite />)
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByRole('link', { name: /TZP-009/ })
    expect(f).toHaveBeenCalledTimes(3)
    expect(String(f.mock.calls[2]![0])).toContain('cursor=C3')
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument()
  })

  it('stops following empty pages after the hop bound and says so, leaving Load more available', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => page([], 'MORE'))
    render(<StockList initial={{ items: [row(1)], nextCursor: 'C1' }} filters={{}} canWrite />)
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByText(/No rows in this stretch/)
    expect(f).toHaveBeenCalledTimes(10)
    expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled()
  })

  it('a first page that is empty but has a cursor is followed once without a click', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(page([row(5)], null))
    render(<StockList initial={{ items: [], nextCursor: 'C1' }} filters={{}} canWrite />)
    await screen.findByRole('link', { name: /TZP-005/ })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('an empty list with no cursor is an empty state, worded by whether filters are active', () => {
    const { rerender } = render(
      <StockList initial={{ items: [], nextCursor: null }} filters={{}} canWrite />,
    )
    expect(screen.getByText('The backend reports no stock records yet.')).toBeInTheDocument()
    rerender(
      <StockList
        initial={{ items: [], nextCursor: null }}
        filters={{ state: 'INACTIVE' }}
        canWrite
      />,
    )
    expect(screen.getByText('No stock record matches these filters.')).toBeInTheDocument()
  })

  it('503 LIST_TIMEOUT keeps the rows and offers an explicit retry of the same page (no automatic retry)', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fail(503, { error: 'unavailable', code: 'LIST_TIMEOUT' }))
      .mockResolvedValueOnce(page([row(2)], null))
    render(<StockList initial={{ items: [row(1)], nextCursor: 'C1' }} filters={{}} canWrite />)
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/took too long/)
    expect(alert).toHaveTextContent(/narrow the list/)
    expect(screen.getByRole('link', { name: /TZP-001/ })).toBeInTheDocument()
    expect(f).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('link', { name: /TZP-002/ })
    expect(String(f.mock.calls[1]![0])).toContain('cursor=C1')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('401 sends the person to sign in; 403 shows the role message without a retry; a network failure can be retried', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fail(401, { error: 'unauthenticated' }))
    const { unmount } = render(
      <StockList initial={{ items: [row(1)], nextCursor: 'C1' }} filters={{}} canWrite />,
    )
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login?error=expired'))
    unmount()
    f.mockResolvedValueOnce(fail(403, { error: 'forbidden' }))
    render(<StockList initial={{ items: [row(1)], nextCursor: 'C1' }} filters={{}} canWrite />)
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot read stock/)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('a network error and a malformed answer are explained and retryable', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { items: 'x' } }), { status: 200 }),
      )
    render(<StockList initial={{ items: [row(1)], nextCursor: 'C1' }} filters={{}} canWrite />)
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach the CMS/)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/unexpected format/)
  })

  it('never lists the same row twice when a page repeats one', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(page([row(1), row(2)], null))
    render(<StockList initial={{ items: [row(1)], nextCursor: 'C1' }} filters={{}} canWrite />)
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByRole('link', { name: /TZP-002/ })
    expect(screen.getAllByRole('rowheader')).toHaveLength(2)
  })
})

describe('StockListView', () => {
  const ok = { kind: 'ok' as const, data: { items: [row(1)], nextCursor: null } }
  it('has one h1, labelled filter forms, and the read-only notice for a reader', () => {
    render(<StockListView result={ok} filters={{ location: 'LOC-1' }} canWrite={false} />)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('form', { name: 'Stock list filters' })).toBeInTheDocument()
    expect(screen.getByLabelText('Filter by location id')).toHaveValue('LOC-1')
    expect(screen.getByLabelText('State')).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Open a stock record' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute(
      'href',
      '/inventory',
    )
    expect(screen.getByRole('note')).toHaveTextContent(/cms-writer/)
  })
  it('tells the person when a filter in the address was invalid and ignored', () => {
    render(<StockListView result={ok} filters={{}} canWrite dropped={['location', 'state']} />)
    expect(
      screen.getByText(/location and state filter in the address was not a valid value/),
    ).toBeInTheDocument()
  })
  it('shows no read-only notice for a writer and no clear link without filters', () => {
    render(<StockListView result={ok} filters={{}} canWrite />)
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Clear filters' })).toBeNull()
  })
  it('a first-page 503 LIST_TIMEOUT reads as try again, other failures as distinct states', () => {
    const { rerender } = render(
      <StockListView
        result={{ kind: 'unavailable', reason: 'status', httpStatus: 503, code: 'LIST_TIMEOUT' }}
        filters={{}}
        canWrite
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/The stock list timed out/)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    rerender(<StockListView result={{ kind: 'forbidden' }} filters={{}} canWrite />)
    expect(screen.getByRole('alert')).toHaveTextContent(/Not permitted/)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    rerender(
      <StockListView
        result={{
          kind: 'unavailable',
          reason: 'status',
          httpStatus: 422,
          code: 'INVALID_INVENTORY',
        }}
        filters={{}}
        canWrite
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/Filters not accepted/)
    rerender(
      <StockListView result={{ kind: 'unavailable', reason: 'timeout' }} filters={{}} canWrite />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/Stock list unavailable/)
  })
})
