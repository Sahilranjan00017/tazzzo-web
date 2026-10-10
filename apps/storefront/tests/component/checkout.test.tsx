import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CancelOrder } from '@/components/CancelOrder'
import { CheckoutBlocked } from '@/components/CheckoutBlocked'
import { CheckoutReview } from '@/components/CheckoutReview'
import { DeliveryChoice } from '@/components/DeliveryChoice'
import { OrderDetail } from '@/components/OrderDetail'
import { OrderList } from '@/components/OrderList'
import { PendingOrderNotice } from '@/components/PendingOrderNotice'
import { clearPendingOrder, markPendingOrder, readPendingOrder } from '@/lib/pending-order'
import { RefreshReview } from '@/components/RefreshReview'
import type { ReviewView } from '@/lib/checkout/model'
import type { Order, OrderPage } from '@/lib/orders/model'

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }))
const navigate = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/cart' }))
vi.mock('@/lib/navigate', () => ({ hardNavigate: navigate }))
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch,
    ...rest
  }: {
    href: string
    children: React.ReactNode
    prefetch?: boolean
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}))

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const CSRF = 'c'.repeat(43)
const ORDER = 'ORD_abcdefghijklmnopqrstu'

beforeEach(() => {
  clearPendingOrder()
  fetchMock.mockReset()
  navigate.mockReset()
  router.refresh.mockReset()
  router.push.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const view = (over: Partial<ReviewView> = {}): ReviewView => ({
  quoteId: 'CHKQ_abcdefghijklmnopqrstu',
  cartVersion: 3,
  addressId: 'ADDR_abcdefghij123',
  slotId: 'morning~2026-10-11',
  lines: [
    {
      productId: 'TZP-1001',
      title: 'Basmati Rice 5 kg',
      imageUrl: null,
      quantity: 2,
      unitPricePaise: 49900,
      mrpPaise: 59900,
      lineTotalPaise: 99800,
    },
    {
      productId: 'TZP-1002',
      title: null,
      imageUrl: null,
      quantity: 1,
      unitPricePaise: 15950,
      mrpPaise: 15950,
      lineTotalPaise: 15950,
    },
  ],
  itemCount: 3,
  subtotalPaise: 115750,
  discountPaise: 0,
  payablePaise: 115750,
  expiresAt: null,
  address: {
    addressId: 'ADDR_abcdefghij123',
    label: 'HOME',
    recipientName: 'Asha Verma',
    recipientPhone: '+919876543210',
    addressLine1: '12 MG Road',
    addressLine2: 'Flat 4',
    landmark: 'Metro',
    city: 'Bengaluru',
    state: 'Karnataka',
    postalCode: '560001',
    isDefault: true,
    version: 1,
    serviceable: true,
  },
  slot: {
    slotId: 'morning~2026-10-11',
    label: 'Morning',
    date: '2026-10-11',
    window: '9:00 am to 11:00 am',
  },
  ...over,
})

const bodyOf = (call = 0) =>
  JSON.parse(String(fetchMock.mock.calls[call]![1]!.body)) as Record<string, unknown>
const placeButton = () => screen.getByTestId('checkout-place')

describe('CheckoutReview', () => {
  it('shows what the backend quoted: lines with MRP, the address, the slot, Cash on Delivery and the total', () => {
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Review your order' })).toBeInTheDocument()
    const lines = within(screen.getByRole('list', { name: 'Items in your order' })).getAllByRole(
      'listitem',
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toHaveTextContent('Basmati Rice 5 kg')
    expect(lines[0]).toHaveTextContent('₹499')
    expect(lines[0]).toHaveTextContent('MRP')
    expect(lines[0]).toHaveTextContent('Quantity 2')
    expect(lines[0]).toHaveTextContent('₹998')
    expect(lines[1]).toHaveTextContent('This item')
    expect(screen.getByTestId('checkout-address')).toHaveTextContent('Asha Verma')
    expect(screen.getByTestId('checkout-address')).toHaveTextContent(
      '12 MG Road, Flat 4, near Metro',
    )
    expect(screen.getByTestId('checkout-address')).toHaveTextContent('Bengaluru, Karnataka 560001')
    expect(screen.getByTestId('checkout-slot')).toHaveTextContent('Sunday, 11 October')
    expect(screen.getByTestId('checkout-slot')).toHaveTextContent('9:00 am to 11:00 am')
    expect(screen.getByTestId('checkout-payment')).toHaveTextContent('Cash on delivery')
    expect(screen.getByTestId('checkout-subtotal')).toHaveTextContent('₹1,157.50')
    expect(screen.queryByTestId('checkout-discount')).not.toBeInTheDocument()
    expect(screen.getByTestId('checkout-total')).toHaveTextContent('₹1,157.50')
    expect(placeButton()).toHaveTextContent('Place order · ₹1,157.50')
    expect(placeButton()).toHaveAttribute('aria-disabled', 'false')
    // No fee, tax or tip row exists in the quote, so none is invented.
    expect(screen.queryByText(/delivery fee|tax|tip/i)).not.toBeInTheDocument()
  })

  it('shows the benefit discount and the amount to pay when the quote carries them', () => {
    render(
      <CheckoutReview
        view={view({ discountPaise: 11575, payablePaise: 104175 })}
        csrfToken={CSRF}
      />,
    )
    expect(screen.getByTestId('checkout-discount')).toHaveTextContent('₹115.75')
    expect(screen.getByTestId('checkout-total')).toHaveTextContent('₹1,041.75')
    expect(screen.getByText('To pay on delivery')).toBeInTheDocument()
  })

  it('a quote without money shows the subtotal as "Total", never a zero', () => {
    render(<CheckoutReview view={view({ payablePaise: null })} csrfToken={CSRF} />)
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByTestId('checkout-total')).toHaveTextContent('₹1,157.50')
  })

  it('places the order with exactly the reviewed quote, cart version, address and slot, and the CSRF header', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, data: { orderId: ORDER } }))
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    await userEvent.setup().click(placeButton())
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/orders/${ORDER}?placed=1`))
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/orders')
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('POST')
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)['X-Tazzzo-CSRF']).toBe(
      CSRF,
    )
    expect(bodyOf()).toEqual({
      quoteId: 'CHKQ_abcdefghijklmnopqrstu',
      cartVersion: 3,
      addressId: 'ADDR_abcdefghij123',
      slotId: 'morning~2026-10-11',
    })
    expect(screen.getByTestId('checkout-status')).toHaveTextContent('Your order is placed')
  })

  it('a double click, an Enter held down and a repeat after success send ONE request', async () => {
    let finish: (r: Response) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (finish = resolve)))
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    const user = userEvent.setup()
    await user.dblClick(placeButton())
    await user.click(placeButton())
    placeButton().focus()
    await user.keyboard('{Enter}{Enter}')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(placeButton()).toHaveAttribute('aria-disabled', 'true')
    expect(placeButton()).toHaveTextContent('Placing order…')
    expect(screen.getByRole('region', { name: 'Review your order' })).toHaveAttribute(
      'aria-busy',
      'true',
    )
    finish(json(200, { ok: true, data: { orderId: ORDER } }))
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    await user.click(placeButton())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(placeButton()).toHaveAttribute('aria-disabled', 'true') // stays off until the confirmation page replaces this one
  })

  it('never navigates on an order id outside the backend grammar', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, data: { orderId: '../../admin' } }))
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    await userEvent.setup().click(placeButton())
    await waitFor(() =>
      expect(screen.getByTestId('checkout-error')).toHaveTextContent('could not confirm whether'),
    )
    expect(navigate).not.toHaveBeenCalled()
  })

  it('status unknown: says the order may exist, links to Orders, and a retry asks for the SAME quote', async () => {
    fetchMock
      .mockResolvedValueOnce(json(502, { ok: false, error: 'unknown', retryAfterSeconds: null }))
      .mockResolvedValueOnce(json(200, { ok: true, data: { orderId: ORDER } }))
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    const user = userEvent.setup()
    await user.click(placeButton())
    const alert = await screen.findByTestId('checkout-error')
    await waitFor(() =>
      expect(alert).toHaveTextContent('could not confirm whether your order was placed'),
    )
    expect(alert).toHaveFocus()
    expect(screen.getByTestId('checkout-to-orders')).toHaveAttribute('href', '/orders')
    expect(router.refresh).not.toHaveBeenCalled()
    expect(placeButton()).toHaveAttribute('aria-disabled', 'false')
    await user.click(placeButton())
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/orders/${ORDER}?placed=1`))
    expect(bodyOf(1)).toEqual(bodyOf(0))
    expect(bodyOf(1).quoteId).toBe('CHKQ_abcdefghijklmnopqrstu')
  })

  it('a price change re-renders the review and asks for an explicit confirmation of the new total', async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, { ok: false, error: 'price_changed', retryAfterSeconds: null }),
    )
    const { rerender } = render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    const user = userEvent.setup()
    await user.click(placeButton())
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('checkout-error')).toHaveTextContent('A price changed')
    // the server renders again with a NEW quote at the new price
    rerender(
      <CheckoutReview
        view={view({
          quoteId: 'CHKQ_zzzzzzzzzzzzzzzzzzzzz',
          subtotalPaise: 120750,
          payablePaise: 120750,
        })}
        csrfToken={CSRF}
      />,
    )
    expect(screen.getByTestId('checkout-changed')).toHaveTextContent(
      'changed from ₹1,157.50 to ₹1,207.50',
    )
    expect(screen.getByTestId('checkout-changed')).toHaveTextContent('not placed until you confirm')
    expect(placeButton()).toHaveTextContent('Confirm ₹1,207.50 and place order')
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, data: { orderId: ORDER } }))
    await user.click(placeButton())
    await waitFor(() => expect(navigate).toHaveBeenCalled())
    expect(bodyOf(1).quoteId).toBe('CHKQ_zzzzzzzzzzzzzzzzzzzzz') // the new quote, never the old one
  })

  it.each([
    ['items_unavailable', 'no longer available in the quantity you chose'],
    ['quote_expired', 'review expired'],
    ['cart_changed', 'cart changed in another tab'],
    ['choice_changed', 'delivery choice changed'],
  ])('%s re-renders the review and keeps the button off until it has', async (error, text) => {
    fetchMock.mockResolvedValueOnce(json(409, { ok: false, error, retryAfterSeconds: null }))
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    await userEvent.setup().click(placeButton())
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('checkout-error')).toHaveTextContent(text)
  })

  it.each([
    ['slot_unavailable', 'delivery slot is no longer available'],
    ['address_changed', 'delivery address changed'],
    ['unserviceable', 'do not deliver to that address'],
  ])(
    '%s sends the customer back to the delivery step and offers nothing to press',
    async (error, text) => {
      fetchMock.mockResolvedValueOnce(json(409, { ok: false, error, retryAfterSeconds: null }))
      render(<CheckoutReview view={view()} csrfToken={CSRF} />)
      await userEvent.setup().click(placeButton())
      await waitFor(() => expect(screen.getByTestId('checkout-error')).toHaveTextContent(text))
      expect(screen.getByTestId('checkout-to-delivery')).toHaveAttribute(
        'href',
        '/checkout/delivery',
      )
      expect(placeButton()).toHaveAttribute('aria-disabled', 'true')
      await userEvent.setup().click(placeButton())
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(router.refresh).not.toHaveBeenCalled()
    },
  )

  it('an order already placed for this cart points to Orders and stops', async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, { ok: false, error: 'already_ordered', retryAfterSeconds: null }),
    )
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    await userEvent.setup().click(placeButton())
    await waitFor(() => expect(screen.getByTestId('checkout-to-orders')).toBeInTheDocument())
    expect(placeButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('a rate limit says how long to wait and allows a retry', async () => {
    fetchMock.mockResolvedValueOnce(
      json(429, { ok: false, error: 'rate_limited', retryAfterSeconds: 42 }),
    )
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    await userEvent.setup().click(placeButton())
    await waitFor(() =>
      expect(screen.getByTestId('checkout-error')).toHaveTextContent('42 seconds'),
    )
    expect(placeButton()).toHaveAttribute('aria-disabled', 'false')
  })

  it.each([
    ['the network failing', () => Promise.reject(new TypeError('network'))],
    [
      'a proxy HTML 502 page',
      () => Promise.resolve(new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    ],
    [
      'a framework 500 page',
      () => Promise.resolve(new Response('Internal Server Error', { status: 500 })),
    ],
    ['a truncated body', () => Promise.resolve(new Response('{"ok":fal', { status: 200 }))],
    ['a 504 with no body', () => Promise.resolve(new Response(null, { status: 504 }))],
  ])(
    '%s is status UNKNOWN (the backend may have committed), never "no order was placed"',
    async (_n, answer) => {
      fetchMock.mockImplementationOnce(answer)
      render(<CheckoutReview view={view()} csrfToken={CSRF} />)
      await userEvent.setup().click(placeButton())
      const alert = screen.getByTestId('checkout-error')
      await waitFor(() =>
        expect(alert).toHaveTextContent('could not confirm whether your order was placed'),
      )
      expect(alert).not.toHaveTextContent('No order was placed')
      expect(screen.getByTestId('checkout-to-orders')).toHaveAttribute('href', '/orders')
      expect(readPendingOrder()).toEqual({ quoteId: 'CHKQ_abcdefghijklmnopqrstu' })
      expect(placeButton()).toHaveAttribute('aria-disabled', 'false')
    },
  )

  it('after an unknown outcome, a "cart changed" answer (the order emptied it) points to Orders instead of refreshing', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(
        json(409, { ok: false, error: 'cart_changed', retryAfterSeconds: null }),
      )
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    const user = userEvent.setup()
    await user.click(placeButton())
    await waitFor(() => expect(screen.getByTestId('checkout-to-orders')).toBeInTheDocument())
    await user.click(placeButton())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByTestId('checkout-error')).toHaveTextContent('could not confirm whether'),
    )
    expect(router.refresh).not.toHaveBeenCalled()
    expect(readPendingOrder()).not.toBeNull()
  })

  it('a success clears the pending mark; the total that differs from the reviewed one is carried to the confirmation', async () => {
    markPendingOrder('CHKQ_abcdefghijklmnopqrstu')
    fetchMock.mockResolvedValueOnce(
      json(200, { ok: true, data: { orderId: ORDER, payablePaise: 100000 } }),
    )
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    await userEvent.setup().click(placeButton())
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(`/orders/${ORDER}?placed=1&was=115750`),
    )
    expect(readPendingOrder()).toBeNull()
  })

  it('an equal total adds nothing to the confirmation address', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { ok: true, data: { orderId: ORDER, payablePaise: 115750 } }),
    )
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    await userEvent.setup().click(placeButton())
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/orders/${ORDER}?placed=1`))
  })

  it('the page tells that benefits are checked again at placement (it does not promise a confirmation it cannot give)', () => {
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    expect(document.body).toHaveTextContent('Benefits are checked again when the order is placed')
  })

  it('PendingOrderNotice shows for an unresolved attempt, offers Orders, and clears when checked', async () => {
    markPendingOrder('CHKQ_abcdefghijklmnopqrstu')
    render(<PendingOrderNotice />)
    expect(await screen.findByTestId('pending-order')).toHaveTextContent('may have gone through')
    expect(screen.getByTestId('pending-order-link')).toHaveAttribute('href', '/orders')
    await userEvent.setup().click(screen.getByRole('button', { name: 'I have checked' }))
    expect(screen.queryByTestId('pending-order')).not.toBeInTheDocument()
    expect(readPendingOrder()).toBeNull()
  })

  it('a session that ended goes to sign-in and back to the review', async () => {
    fetchMock.mockResolvedValueOnce(
      json(401, { ok: false, error: 'unauthenticated', retryAfterSeconds: null }),
    )
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    await userEvent.setup().click(placeButton())
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/login?next=%2Fcheckout'))
  })

  it('an unrecognised error code reads as the generic closed message, never as the raw code', async () => {
    fetchMock.mockResolvedValueOnce(
      json(500, { ok: false, error: 'DROP TABLE', message: 'secret' }),
    )
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    await userEvent.setup().click(placeButton())
    await waitFor(() =>
      expect(screen.getByTestId('checkout-error')).toHaveTextContent('could not confirm whether'),
    )
    expect(document.body).not.toHaveTextContent('DROP TABLE')
    expect(document.body).not.toHaveTextContent('secret')
  })

  it('announces through a polite live region and an alert; the heading labels the region', () => {
    render(<CheckoutReview view={view()} csrfToken={CSRF} />)
    expect(screen.getByTestId('checkout-status')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByTestId('checkout-status')).toHaveAttribute('role', 'status')
    expect(screen.getByTestId('checkout-error')).toHaveAttribute('role', 'alert')
    expect(screen.getByRole('region', { name: 'Review your order' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Change address or slot' })).toHaveAttribute(
      'href',
      '/checkout/delivery',
    )
    expect(screen.getByRole('link', { name: 'Back to cart' })).toHaveAttribute('href', '/cart')
  })
})

describe('RefreshReview', () => {
  it('asks the server for a new review once, then re-renders', async () => {
    let finish: (r: Response) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (finish = resolve)))
    render(<RefreshReview csrfToken={CSRF} />)
    expect(screen.getByTestId('checkout-expired')).toHaveTextContent('Nothing was ordered')
    const user = userEvent.setup()
    await user.dblClick(screen.getByTestId('checkout-refresh'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/checkout/refresh')
    expect(bodyOf()).toEqual({})
    finish(json(200, { ok: true, data: null }))
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1))
  })

  it('a lost delivery choice goes back to the delivery step; other failures can be retried', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { ok: false, error: 'choice_changed' }))
    render(<RefreshReview csrfToken={CSRF} />)
    await userEvent.setup().click(screen.getByTestId('checkout-refresh'))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/checkout/delivery'))
    fetchMock.mockResolvedValueOnce(json(503, { ok: false, error: 'unavailable' }))
    await userEvent.setup().click(screen.getByTestId('checkout-refresh'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not refresh'))
    expect(screen.getByTestId('checkout-refresh')).toHaveAttribute('aria-disabled', 'false')
  })
})

describe('CheckoutBlocked', () => {
  it('names each blocked line and why, and offers only the way back to the cart', () => {
    render(
      <CheckoutBlocked
        lines={[
          {
            productId: 'TZP-1001',
            title: 'Basmati Rice 5 kg',
            imageUrl: null,
            quantity: 2,
            reason: 'OUT_OF_STOCK',
          },
          {
            productId: 'TZP-1002',
            title: null,
            imageUrl: null,
            quantity: 1,
            reason: 'NOT_BUYABLE',
          },
        ]}
      />,
    )
    expect(screen.getByTestId('checkout-blocked')).toHaveTextContent('No order was placed')
    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Basmati Rice 5 kg')
    expect(items[0]).toHaveTextContent('Out of stock.')
    expect(items[1]).toHaveTextContent('This item')
    expect(items[1]).toHaveTextContent('cannot be bought right now')
    expect(screen.getByTestId('checkout-fix-cart')).toHaveAttribute('href', '/cart')
    expect(screen.queryByTestId('checkout-place')).not.toBeInTheDocument()
  })
})

describe('DeliveryChoice hands on to the review', () => {
  it('shows the notice the order step sent the customer back with, and Continue only after the choice is saved', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        ok: true,
        data: { addressId: 'ADDR_abcdefghij123', slotId: 'morning~2026-10-11' },
      }),
    )
    render(
      <DeliveryChoice
        addresses={[view().address]}
        addressId="ADDR_abcdefghij123"
        slots={{
          serviceable: true,
          timezone: 'Asia/Kolkata',
          slots: [
            {
              slotId: 'morning~2026-10-11',
              date: '2026-10-11',
              startsAt: '2026-10-11T09:00:00+05:30',
              endsAt: '2026-10-11T11:00:00+05:30',
              label: 'Morning',
              status: 'AVAILABLE',
            },
          ],
        }}
        slotsError={false}
        savedSlotId="morning~2026-10-11"
        notice="The delivery slot you chose is no longer available. Please choose another."
        csrfToken={CSRF}
      />,
    )
    expect(screen.getByTestId('delivery-notice')).toHaveTextContent('no longer available')
    expect(screen.queryByTestId('delivery-continue')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save delivery choice' }))
    const next = await screen.findByTestId('delivery-continue')
    expect(next).toHaveAttribute('href', '/checkout')
  })
})

const order = (over: Partial<Order> = {}): Order => ({
  orderId: ORDER,
  status: 'CONFIRMED',
  paymentMethod: 'COD',
  paymentCondition: 'COD_DUE',
  lines: [
    {
      productId: 'TZP-1001',
      title: 'Basmati Rice 5 kg',
      brandCode: 'TZB-1',
      quantity: 2,
      unitPricePaise: 49900,
      lineTotalPaise: 99800,
    },
    {
      productId: 'TZP-1002',
      title: null,
      brandCode: null,
      quantity: 1,
      unitPricePaise: 15950,
      lineTotalPaise: 15950,
    },
  ],
  itemCount: 3,
  subtotalPaise: 115750,
  address: {
    label: 'HOME',
    recipientName: 'Asha Verma',
    recipientPhone: '+919876543210',
    addressLine1: '12 MG Road',
    addressLine2: null,
    landmark: null,
    city: 'Bengaluru',
    state: 'Karnataka',
    postalCode: '560001',
  },
  createdAt: '2026-10-11T04:30:20.000Z',
  confirmedAt: '2026-10-11T04:30:20.000Z',
  money: { merchandiseSubtotalPaise: 115750, benefitDiscountPaise: 11575, payablePaise: 104175 },
  slot: {
    slotId: 'morning~2026-10-11',
    label: 'Morning',
    startsAt: '2026-10-11T09:00:00+05:30',
    endsAt: '2026-10-11T11:00:00+05:30',
  },
  cancelledAt: null,
  outForDeliveryAt: null,
  deliveredAt: null,
  ...over,
})

describe('OrderDetail', () => {
  it('shows the order from its own snapshot: status, items, the money it settled on, address and slot', () => {
    render(<OrderDetail order={order()} placed={false} cancelOffered={false} csrfToken={CSRF} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Your order' })).toBeInTheDocument()
    expect(screen.getByTestId('order-status')).toHaveTextContent('Confirmed')
    expect(screen.getByTestId('order-id')).toHaveTextContent(ORDER)
    expect(screen.getByText('Placed 11 Oct 2026, 10:00 am')).toBeInTheDocument()
    expect(screen.getByTestId('order-subtotal')).toHaveTextContent('₹1,157.50')
    expect(screen.getByTestId('order-discount')).toHaveTextContent('₹115.75')
    expect(screen.getByTestId('order-total')).toHaveTextContent('₹1,041.75')
    expect(screen.getByText('To pay on delivery')).toBeInTheDocument()
    expect(screen.getByTestId('order-payment')).toHaveTextContent('Cash on delivery')
    expect(screen.getByTestId('order-address')).toHaveTextContent('12 MG Road')
    expect(screen.getByTestId('order-slot')).toHaveTextContent('Sunday, 11 October')
    expect(screen.getByTestId('order-slot')).toHaveTextContent('Morning, 9:00 am to 11:00 am')
    expect(screen.getByRole('link', { name: 'Basmati Rice 5 kg' })).toHaveAttribute(
      'href',
      '/p/TZP-1001',
    )
    expect(screen.queryByTestId('order-placed')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cancel-open')).not.toBeInTheDocument()
  })

  it('right after placing, the confirmation says so, says what to keep ready, and takes focus', () => {
    render(<OrderDetail order={order()} placed cancelOffered={false} csrfToken={CSRF} />)
    const heading = screen.getByRole('heading', {
      level: 1,
      name: 'Thank you, your order is placed',
    })
    expect(heading).toHaveFocus()
    expect(screen.getByTestId('order-placed')).toHaveTextContent(
      'keep ₹1,041.75 ready to pay in cash',
    )
  })

  it('?placed=1 on a cancelled order does not claim it was just placed', () => {
    render(
      <OrderDetail
        order={order({
          status: 'CANCELLED',
          paymentCondition: null,
          cancelledAt: '2026-10-11T05:00:00.000Z',
        })}
        placed
        cancelOffered={false}
        csrfToken={CSRF}
      />,
    )
    expect(screen.queryByTestId('order-placed')).not.toBeInTheDocument()
    expect(screen.getByTestId('order-status')).toHaveTextContent('Cancelled')
    expect(screen.getByText('Cancelled 11 Oct 2026, 10:30 am')).toBeInTheDocument()
    expect(screen.getByTestId('order-payment')).toHaveTextContent('Nothing is due')
  })

  it('an order without money says the amount is not available, never a zero', () => {
    render(
      <OrderDetail
        order={order({ money: null })}
        placed={false}
        cancelOffered={false}
        csrfToken={CSRF}
      />,
    )
    expect(screen.queryByTestId('order-total')).not.toBeInTheDocument()
    expect(
      screen.getByText('The amount payable is not available for this order.'),
    ).toBeInTheDocument()
  })

  it('an order with no slot, a landmark and a status newer than this site says so plainly', () => {
    render(
      <OrderDetail
        order={order({
          slot: null,
          status: 'UNKNOWN',
          address: { ...order().address, landmark: 'Metro', addressLine2: 'Flat 4' },
        })}
        placed={false}
        cancelOffered={false}
        csrfToken={CSRF}
      />,
    )
    expect(screen.getByTestId('order-slot')).toHaveTextContent('No delivery slot was chosen')
    expect(screen.getByTestId('order-status')).toHaveTextContent('In progress')
    expect(screen.getByTestId('order-address')).toHaveTextContent('12 MG Road, Flat 4, near Metro')
  })

  it('shows delivery milestones when the backend reports them', () => {
    render(
      <OrderDetail
        order={order({
          status: 'DELIVERED',
          outForDeliveryAt: '2026-10-11T05:30:00.000Z',
          deliveredAt: '2026-10-11T06:30:00.000Z',
        })}
        placed={false}
        cancelOffered={false}
        csrfToken={CSRF}
      />,
    )
    expect(screen.getByText('Out for delivery 11 Oct 2026, 11:00 am')).toBeInTheDocument()
    expect(screen.getByText('Delivered 11 Oct 2026, 12:00 pm')).toBeInTheDocument()
  })
})

describe('OrderDetail: a total that changed at placement', () => {
  it('says so on the confirmation, with both amounts; nothing when equal or when not just placed', () => {
    const { rerender } = render(
      <OrderDetail
        order={order()}
        placed
        reviewedPayablePaise={110000}
        cancelOffered={false}
        csrfToken={CSRF}
      />,
    )
    expect(screen.getByTestId('order-total-changed')).toHaveTextContent(
      'changed from ₹1,100 to ₹1,041.75',
    )
    rerender(
      <OrderDetail
        order={order()}
        placed
        reviewedPayablePaise={104175}
        cancelOffered={false}
        csrfToken={CSRF}
      />,
    )
    expect(screen.queryByTestId('order-total-changed')).not.toBeInTheDocument()
    rerender(
      <OrderDetail
        order={order()}
        placed={false}
        reviewedPayablePaise={110000}
        cancelOffered={false}
        csrfToken={CSRF}
      />,
    )
    expect(screen.queryByTestId('order-total-changed')).not.toBeInTheDocument()
  })
})

describe('CancelOrder (offered only where the deployment says the backend allows it)', () => {
  it('is hidden by default and shown when offered; two steps, a reason, and the closed body', async () => {
    const { rerender } = render(
      <OrderDetail order={order()} placed={false} cancelOffered={false} csrfToken={CSRF} />,
    )
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument()
    rerender(<OrderDetail order={order()} placed={false} cancelOffered csrfToken={CSRF} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Cancel order' }))
    const reason = screen.getByLabelText('Reason')
    expect(reason).toHaveFocus()
    await user.click(screen.getByTestId('cancel-confirm'))
    expect(screen.getByTestId('cancel-error')).toHaveTextContent('Choose a reason.')
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, data: { status: 'CANCELLED' } }))
    await user.selectOptions(reason, 'CHANGED_MIND')
    await user.click(screen.getByTestId('cancel-confirm'))
    await waitFor(() => expect(router.refresh).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/orders/cancel')
    expect(bodyOf()).toEqual({ orderId: ORDER, reason: 'CHANGED_MIND' })
    expect(screen.getByTestId('cancel-status')).toHaveTextContent('Your order is cancelled.')
  })

  it('"cancelling is not available" is shown gracefully, the order is re-read, and nothing is hidden', async () => {
    fetchMock.mockResolvedValueOnce(
      json(409, { ok: false, error: 'window_closed', retryAfterSeconds: null }),
    )
    render(<CancelOrder orderId={ORDER} csrfToken={CSRF} />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('cancel-open'))
    await user.selectOptions(screen.getByLabelText('Reason'), 'OTHER')
    await user.click(screen.getByTestId('cancel-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('cancel-error')).toHaveTextContent('Cancelling is not available'),
    )
    expect(router.refresh).toHaveBeenCalled()
    expect(document.body).not.toHaveTextContent('CANCELLATION_WINDOW_CLOSED')
  })

  it('a double press sends one request; "Keep my order" closes it and returns focus', async () => {
    let finish: (r: Response) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (finish = resolve)))
    render(<CancelOrder orderId={ORDER} csrfToken={CSRF} />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('cancel-open'))
    await user.selectOptions(screen.getByLabelText('Reason'), 'OTHER')
    await user.dblClick(screen.getByTestId('cancel-confirm'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    finish(json(409, { ok: false, error: 'not_cancellable' }))
    await waitFor(() =>
      expect(screen.getByTestId('cancel-error')).toHaveTextContent('can no longer be cancelled'),
    )
    await user.click(screen.getByRole('button', { name: 'Keep my order' }))
    expect(screen.getByTestId('cancel-open')).toHaveFocus()
  })
})

describe('OrderList', () => {
  const page = (over: Partial<OrderPage> = {}): OrderPage => ({
    orders: [
      {
        orderId: ORDER,
        status: 'CONFIRMED',
        itemCount: 3,
        subtotalPaise: 115750,
        payablePaise: 104175,
        createdAt: '2026-10-11T04:30:20.000Z',
        slot: { slotId: 'morning~2026-10-11', label: 'Morning', startsAt: '', endsAt: '' },
        cancelledAt: null,
      },
      {
        orderId: 'ORD_secondorder1234',
        status: 'CANCELLED',
        itemCount: 1,
        subtotalPaise: 15950,
        payablePaise: null,
        createdAt: '2026-10-10T04:30:20.000Z',
        slot: null,
        cancelledAt: '2026-10-10T05:00:00.000Z',
      },
    ],
    nextCursor: 'abc_DEF-123',
    ...over,
  })

  it('lists orders newest first with status, items, amount and slot, each a link by id', () => {
    render(<OrderList page={page()} first />)
    expect(screen.getByRole('heading', { level: 1, name: 'Your orders' })).toBeInTheDocument()
    const rows = within(screen.getByRole('list', { name: 'Orders, newest first' })).getAllByRole(
      'listitem',
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Order placed 11 Oct 2026, 10:00 am')
    expect(rows[0]).toHaveTextContent('Confirmed')
    expect(rows[0]).toHaveTextContent('3 items · ₹1,041.75')
    expect(rows[0]).toHaveTextContent('Delivery Sunday, 11 October, Morning')
    expect(rows[1]).toHaveTextContent('Cancelled')
    expect(rows[1]).toHaveTextContent('1 item · ₹159.50')
    expect(within(rows[0]!).getByTestId('order-link')).toHaveAttribute('href', `/orders/${ORDER}`)
  })

  it('pages with the backend cursor, encoded, and offers the way back after the first page', () => {
    const { rerender } = render(<OrderList page={page()} first />)
    expect(screen.getByTestId('orders-older')).toHaveAttribute('href', '/orders?cursor=abc_DEF-123')
    expect(screen.queryByRole('link', { name: 'Newest orders' })).not.toBeInTheDocument()
    rerender(<OrderList page={page({ nextCursor: null })} first={false} />)
    expect(screen.queryByTestId('orders-older')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Newest orders' })).toHaveAttribute('href', '/orders')
  })

  it('an empty history invites shopping; an empty later page offers the way back', () => {
    const { rerender } = render(<OrderList page={{ orders: [], nextCursor: null }} first />)
    expect(screen.getByTestId('orders-empty')).toHaveTextContent('not placed any orders yet')
    expect(screen.getByRole('link', { name: 'Start shopping' })).toHaveAttribute('href', '/')
    rerender(<OrderList page={{ orders: [], nextCursor: null }} first={false} />)
    expect(screen.getByRole('link', { name: 'Back to your newest orders' })).toHaveAttribute(
      'href',
      '/orders',
    )
  })
})
