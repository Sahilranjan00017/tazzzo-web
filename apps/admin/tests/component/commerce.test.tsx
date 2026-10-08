import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InventoryEditor } from '@/components/inventory/InventoryEditor'
import { PriceEditor } from '@/components/pricing/PriceEditor'
import { ToastProvider } from '@/components/ui/Toast'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}))

beforeEach(() => {
  refresh.mockClear()
  vi.restoreAllMocks()
})
const wrap = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>)
const price = {
  skuId: 'TZP-1',
  currency: 'INR',
  sellingPricePaise: 12900,
  mrpPaise: 14900,
  version: 3,
  status: 'ACTIVE',
}

describe('PriceEditor', () => {
  it('blocks MRP below selling and bad amounts before any request', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    wrap(<PriceEditor skuId="TZP-1" current={price} />)
    await user.clear(screen.getByLabelText('MRP (₹)'))
    await user.type(screen.getByLabelText('MRP (₹)'), '100')
    await user.click(screen.getByRole('button', { name: 'Review change' }))
    expect(screen.getByText('MRP cannot be below the selling price.')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Selling price (₹)'))
    await user.type(screen.getByLabelText('Selling price (₹)'), '1.234')
    await user.click(screen.getByRole('button', { name: 'Review change' }))
    expect(screen.getByText(/at most two decimals/)).toBeInTheDocument()
    expect(f).not.toHaveBeenCalled()
  })

  it('shows before/after, sends integer paise with the loaded version only after confirmation', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: { version: 4 } }), { status: 200 }))
    wrap(<PriceEditor skuId="TZP-1" current={price} />)
    await user.clear(screen.getByLabelText('Selling price (₹)'))
    await user.type(screen.getByLabelText('Selling price (₹)'), '119.99')
    await user.click(screen.getByRole('button', { name: 'Review change' }))
    expect(screen.getByRole('dialog', { hidden: true })).toHaveTextContent('→')
    expect(f).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Update price', hidden: true }))
    expect(f.mock.calls[0]![0]).toBe('/api/bff/pricing/TZP-1')
    expect(f.mock.calls[0]![1]).toMatchObject({ method: 'PUT' })
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      sellingPricePaise: 11999,
      mrpPaise: 14900,
      expectedVersion: 3,
    })
  })

  it('first price sends no version; a stale conflict is explained and not retried', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'conflict', code: 'STALE_VERSION' }), { status: 409 }),
      )
    wrap(<PriceEditor skuId="TZP-1" />)
    await user.type(screen.getByLabelText('Selling price (₹)'), '10')
    await user.type(screen.getByLabelText('MRP (₹)'), '12')
    await user.click(screen.getByRole('button', { name: 'Review first price' }))
    await user.click(screen.getByRole('button', { name: 'Set price', hidden: true }))
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      sellingPricePaise: 1000,
      mrpPaise: 1200,
    })
    expect(await screen.findByText(/changed since you loaded it/)).toBeInTheDocument()
    expect(f).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalled()
  })
})

describe('InventoryEditor', () => {
  const stock = {
    skuId: 'TZP-1',
    fulfillmentLocationId: 'LOC-1',
    onHand: 20,
    reserved: 8,
    available: 12,
    lowStockThreshold: 5,
    maxPurchasable: 10,
    version: 2,
    active: true,
  }
  it('refuses on-hand below reserved locally and sends an absolute set otherwise', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: { version: 3 } }), { status: 200 }))
    wrap(<InventoryEditor skuId="TZP-1" locationId="LOC-1" current={stock} />)
    await user.clear(screen.getByLabelText('On-hand quantity'))
    await user.type(screen.getByLabelText('On-hand quantity'), '7')
    await user.click(screen.getByRole('button', { name: 'Review change' }))
    expect(screen.getByText(/below the 8 units already reserved/)).toBeInTheDocument()
    await user.clear(screen.getByLabelText('On-hand quantity'))
    await user.type(screen.getByLabelText('On-hand quantity'), '30')
    await user.click(screen.getByRole('button', { name: 'Review change' }))
    expect(f).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Save stock', hidden: true }))
    expect(f.mock.calls[0]![0]).toBe('/api/bff/inventory/TZP-1/LOC-1')
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      onHand: 30,
      lowStockThreshold: 5,
      maxPurchasable: 10,
      expectedVersion: 2,
    })
  })
  it('deactivate asks first, then posts the version', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    wrap(<InventoryEditor skuId="TZP-1" locationId="LOC-1" current={stock} />)
    await user.click(screen.getByRole('button', { name: 'Deactivate' }))
    expect(f).not.toHaveBeenCalled()
    await user.click(screen.getAllByRole('button', { name: 'Deactivate', hidden: true }).at(-1)!)
    expect(f.mock.calls[0]![0]).toBe('/api/bff/inventory/TZP-1/LOC-1/deactivate')
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({ expectedVersion: 2 })
  })
})
