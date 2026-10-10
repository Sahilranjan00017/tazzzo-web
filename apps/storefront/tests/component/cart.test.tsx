import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddToCart } from '@/components/AddToCart'
import { CartView } from '@/components/CartView'
import { QuantityStepper } from '@/components/QuantityStepper'
import type { Cart, CartLine } from '@/lib/cart/model'

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const assign = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  assign.mockReset()
  router.refresh.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  })
})
afterEach(() => vi.unstubAllGlobals())

const line = (over: Partial<CartLine> = {}): CartLine => ({
  productId: 'TZP-1001',
  quantity: 2,
  title: 'Basmati Rice 5 kg',
  brandCode: 'TZB-1',
  imageUrl: null,
  unitPricePaise: 49900,
  mrpPaise: 59900,
  lineTotalPaise: 99800,
  stockState: 'IN_STOCK',
  maxOrderQuantity: 10,
  serviceable: true,
  buyable: true,
  issues: [],
  ...over,
})
const cart = (lines: CartLine[], over: Partial<Cart> = {}): Cart => ({
  version: 4,
  lines,
  itemCount: lines.reduce((n, l) => n + l.quantity, 0),
  subtotalPaise: lines.reduce((n, l) => n + (l.lineTotalPaise ?? 0), 0),
  freshness: 'FRESH',
  ...over,
})
const CSRF = 'c'.repeat(43)

describe('QuantityStepper', () => {
  it('has a labelled group, named buttons and a value, and steps within bounds', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<QuantityStepper value={2} max={3} label="Rice" onChange={onChange} />)
    expect(screen.getByRole('group', { name: 'Quantity of Rice' })).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Increase quantity of Rice' }))
    await user.click(screen.getByRole('button', { name: 'Decrease quantity of Rice' }))
    expect(onChange.mock.calls).toEqual([[3], [1]])
  })

  it('ignores presses at a bound and while busy, yet keeps keyboard focus on the button', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <QuantityStepper value={1} max={2} label="Rice" onChange={onChange} />,
    )
    const minus = screen.getByRole('button', { name: 'Decrease quantity of Rice' })
    expect(minus).toHaveAttribute('aria-disabled', 'true')
    await user.click(minus)
    expect(onChange).not.toHaveBeenCalled()
    rerender(<QuantityStepper value={2} max={2} label="Rice" onChange={onChange} />)
    const plus = screen.getByRole('button', { name: 'Increase quantity of Rice' })
    plus.focus()
    await user.keyboard('{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    expect(plus).toHaveFocus()
    rerender(<QuantityStepper value={1} max={5} label="Rice" busy onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Increase quantity of Rice' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('is operable from the keyboard', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<QuantityStepper value={2} max={5} label="Rice" onChange={onChange} />)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Decrease quantity of Rice' })).toHaveFocus()
    await user.tab()
    await user.keyboard(' ')
    expect(onChange).toHaveBeenCalledWith(3)
  })
})

describe('CartView lines', () => {
  it('shows image slot, title link, unit price, MRP, quantity, line total and subtotal', () => {
    render(<CartView initial={cart([line()])} csrfToken={CSRF} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Your cart' })).toBeInTheDocument()
    const item = document.querySelector<HTMLElement>('[data-product-id="TZP-1001"]')!
    expect(within(item).getByRole('link', { name: 'Basmati Rice 5 kg' })).toHaveAttribute(
      'href',
      '/p/TZP-1001',
    )
    expect(within(item).getByText('₹499')).toBeInTheDocument()
    expect(within(item).getByText('₹599')).toBeInTheDocument() // struck-through MRP
    expect(
      within(item)
        .getByText(/Line total/)
        .closest('p'),
    ).toHaveTextContent('₹998')
    expect(screen.getByTestId('cart-subtotal')).toHaveTextContent('₹998')
    expect(screen.getByText('Subtotal (2 items)')).toBeInTheDocument()
    expect(screen.getByText(/Prices can change until you place your order/)).toBeInTheDocument()
    expect(screen.getByTestId('cart-checkout-link')).toHaveAttribute('href', '/checkout')
  })

  it('encodes the id in the product link and keeps its case', () => {
    render(<CartView initial={cart([line({ productId: 'TZP-Mix-7' })])} csrfToken={CSRF} />)
    expect(screen.getByRole('link', { name: 'Basmati Rice 5 kg' })).toHaveAttribute(
      'href',
      '/p/TZP-Mix-7',
    )
  })

  it('renders each stale/revalidation state the backend reports, and flags the cart', () => {
    const lines = [
      line({
        productId: 'TZP-1',
        title: 'Gone Item',
        issues: ['PRODUCT_UNAVAILABLE'],
        unitPricePaise: null,
        lineTotalPaise: null,
        buyable: false,
      }),
      line({
        productId: 'TZP-2',
        title: 'Dry Item',
        issues: ['OUT_OF_STOCK'],
        stockState: 'OUT_OF_STOCK',
        maxOrderQuantity: 0,
        buyable: false,
      }),
      line({
        productId: 'TZP-3',
        title: 'Scarce Item',
        issues: ['INSUFFICIENT_STOCK'],
        quantity: 5,
        maxOrderQuantity: 2,
        buyable: false,
      }),
      line({ productId: 'TZP-4', title: 'Moved Item', issues: ['PRICE_CHANGED'] }),
      line({
        productId: 'TZP-5',
        title: 'Plain Item',
        issues: ['LOCATION_REQUIRED'],
        stockState: 'UNKNOWN',
        maxOrderQuantity: 0,
        buyable: false,
      }),
    ]
    render(<CartView initial={cart(lines, { freshness: 'REVALIDATE' })} csrfToken={CSRF} />)
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-product-id="${id}"]`)!
    expect(within(row('TZP-1')).getByText(/No longer available/)).toBeInTheDocument()
    expect(within(row('TZP-1')).getByText('Price unavailable')).toBeInTheDocument()
    expect(within(row('TZP-2')).getByText(/Out of stock\./)).toBeInTheDocument()
    expect(
      within(row('TZP-3')).getByText('Only 2 available. Lower the quantity to continue.'),
    ).toBeInTheDocument()
    expect(within(row('TZP-4')).getByText(/price changed/)).toBeInTheDocument()
    expect(within(row('TZP-5')).getByText(/delivery address/)).toBeInTheDocument()
    expect(row('TZP-1')).toHaveAttribute('data-blocked', 'true')
    expect(row('TZP-2')).toHaveAttribute('data-blocked', 'true')
    expect(row('TZP-3')).toHaveAttribute('data-blocked', 'true')
    expect(row('TZP-4')).toHaveAttribute('data-blocked', 'false')
    expect(row('TZP-5')).toHaveAttribute('data-blocked', 'false')
    expect(screen.getByTestId('cart-blocked')).toHaveTextContent('3 items need your attention')
    expect(screen.getByText(/It has been a while/)).toBeInTheDocument()
    // The out-of-stock line can still be reduced or removed; the stepper is capped at the reported stock.
    expect(
      within(row('TZP-3')).getByRole('button', { name: 'Remove Scarce Item from cart' }),
    ).toBeInTheDocument()
    expect(
      within(row('TZP-3')).getByRole('button', { name: 'Increase quantity of Scarce Item' }),
    ).toHaveAttribute('aria-disabled', 'true')
  })

  it('says when the subtotal leaves out unpriced items', () => {
    const lines = [
      line(),
      line({
        productId: 'TZP-2',
        unitPricePaise: null,
        lineTotalPaise: null,
        issues: ['PRICE_UNAVAILABLE'],
        buyable: false,
      }),
    ]
    render(<CartView initial={cart(lines)} csrfToken={CSRF} />)
    expect(
      screen.getByText(/1 item has no price right now and is not included/),
    ).toBeInTheDocument()
  })

  it('shows the empty state with a way back to shopping', () => {
    render(<CartView initial={cart([])} csrfToken={CSRF} />)
    expect(screen.getByText('Your cart is empty.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Continue shopping' })).toHaveAttribute('href', '/')
    expect(screen.queryByText(/Subtotal/)).not.toBeInTheDocument()
  })
})

describe('CartView changes', () => {
  it('sends the quantity with the CSRF token and the cart version, then shows only the server answer', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(
      json(200, {
        ok: true,
        cart: cart([line({ quantity: 3, lineTotalPaise: 149700 })], { version: 5 }),
      }),
    )
    render(<CartView initial={cart([line()])} csrfToken={CSRF} />)
    await user.click(screen.getByRole('button', { name: 'Increase quantity of Basmati Rice 5 kg' }))
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/cart/update')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['X-Tazzzo-CSRF']).toBe(CSRF)
    expect(JSON.parse(String(init?.body))).toEqual({
      productId: 'TZP-1001',
      quantity: 3,
      version: 4,
    })
    await waitFor(() => expect(screen.getByTestId('cart-subtotal')).toHaveTextContent('₹1,497'))
    expect(screen.getByTestId('cart-status')).toHaveTextContent(
      'Basmati Rice 5 kg: quantity 3. Subtotal ₹1,497.',
    )
    expect(screen.getByTestId('cart-status')).toHaveAttribute('aria-live', 'polite')
    expect(router.refresh).toHaveBeenCalled()
    // The next change presents the NEW version.
    fetchMock.mockResolvedValueOnce(
      json(200, { ok: true, cart: cart([line({ quantity: 2 })], { version: 6 }) }),
    )
    await user.click(screen.getByRole('button', { name: 'Decrease quantity of Basmati Rice 5 kg' }))
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)).version).toBe(5)
  })

  it('is not optimistic: a failed change leaves the old cart and announces the failure in an alert', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(
      json(503, { ok: false, error: 'unavailable', retryAfterSeconds: null }),
    )
    render(<CartView initial={cart([line()])} csrfToken={CSRF} />)
    await user.click(screen.getByRole('button', { name: 'Increase quantity of Basmati Rice 5 kg' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not update your cart right now.',
    )
    expect(screen.getByTestId('cart-subtotal')).toHaveTextContent('₹998')
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it('on a conflict replaces the screen with the fresh cart and explains it', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(
      json(409, {
        ok: false,
        error: 'conflict',
        retryAfterSeconds: null,
        cart: cart([line({ quantity: 6, lineTotalPaise: 299400 })], { version: 9 }),
      }),
    )
    render(<CartView initial={cart([line()])} csrfToken={CSRF} />)
    await user.click(screen.getByRole('button', { name: 'Increase quantity of Basmati Rice 5 kg' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your cart changed in another tab or window',
    )
    expect(screen.getByTestId('cart-subtotal')).toHaveTextContent('₹2,994')
  })

  it('ignores a second press while one change is in flight', async () => {
    const user = userEvent.setup()
    let release!: (r: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)))
    render(<CartView initial={cart([line()])} csrfToken={CSRF} />)
    const plus = screen.getByRole('button', { name: 'Increase quantity of Basmati Rice 5 kg' })
    await user.click(plus)
    await user.click(plus)
    await user.click(screen.getByRole('button', { name: 'Remove Basmati Rice 5 kg from cart' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(plus).toHaveAttribute('aria-disabled', 'true')
    release(json(200, { ok: true, cart: cart([line({ quantity: 3 })], { version: 5 }) }))
    await waitFor(() => expect(plus).toHaveAttribute('aria-disabled', 'false'))
  })

  it('removes a line, announces it, and moves focus to the cart heading', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, cart: cart([], { version: 5 }) }))
    render(<CartView initial={cart([line()])} csrfToken={CSRF} />)
    await user.click(screen.getByRole('button', { name: 'Remove Basmati Rice 5 kg from cart' }))
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/cart/remove')
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      productId: 'TZP-1001',
      version: 4,
    })
    expect(
      await screen.findByText('Your cart is empty.', { selector: 'p:not([role])' }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('cart-status')).toHaveTextContent(
      'Basmati Rice 5 kg removed. Your cart is empty.',
    )
    expect(screen.getByRole('heading', { name: 'Your cart' })).toHaveFocus()
  })

  it('asks before clearing, and Keep items cancels without a request', async () => {
    const user = userEvent.setup()
    render(<CartView initial={cart([line()])} csrfToken={CSRF} />)
    await user.click(screen.getByRole('button', { name: 'Clear cart' }))
    const yes = screen.getByRole('button', { name: 'Yes, clear cart' })
    expect(yes).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Keep items' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Clear cart' })).toHaveFocus()
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, cart: cart([], { version: 5 }) }))
    await user.click(screen.getByRole('button', { name: 'Clear cart' }))
    await user.click(screen.getByRole('button', { name: 'Yes, clear cart' }))
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/cart/clear')
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ version: 4 })
    expect(
      await screen.findByText('Your cart is empty.', { selector: 'p:not([role])' }),
    ).toBeInTheDocument()
  })

  it('sends a signed-out answer to sign-in with a return path', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(
      json(401, { ok: false, error: 'unauthenticated', retryAfterSeconds: null }),
    )
    render(<CartView initial={cart([line()])} csrfToken={CSRF} />)
    await user.click(screen.getByRole('button', { name: 'Increase quantity of Basmati Rice 5 kg' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login?next=%2Fcart'))
  })
})

describe('AddToCart', () => {
  it('signed out: a link to sign-in that returns to this product, and no cart request', () => {
    render(
      <AddToCart productId="TZP-Mix-7" productName="Tea" csrfToken={null} stockState="UNKNOWN" />,
    )
    expect(screen.getByRole('link', { name: 'Sign in to add to cart' })).toHaveAttribute(
      'href',
      '/login?next=%2Fp%2FTZP-Mix-7',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a known out-of-stock product shows it and disables the control', () => {
    render(
      <AddToCart
        productId="TZP-2001"
        productName="Ghee"
        csrfToken={CSRF}
        stockState="OUT_OF_STOCK"
      />,
    )
    expect(screen.getByTestId('stock-state')).toHaveTextContent('Out of stock')
    expect(screen.getByRole('button', { name: 'Add to cart' })).toBeDisabled()
  })

  it('adds the chosen quantity with the CSRF token and announces the result', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, cart: cart([line({ quantity: 3 })]) }))
    render(
      <AddToCart productId="TZP-1001" productName="Rice" csrfToken={CSRF} stockState="UNKNOWN" />,
    )
    await user.click(screen.getByRole('button', { name: 'Increase quantity of Rice' }))
    await user.click(screen.getByRole('button', { name: 'Increase quantity of Rice' }))
    await user.click(screen.getByRole('button', { name: 'Add to cart' }))
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/cart/add')
    expect((init?.headers as Record<string, string>)['X-Tazzzo-CSRF']).toBe(CSRF)
    expect(JSON.parse(String(init?.body))).toEqual({ productId: 'TZP-1001', quantity: 3 })
    expect(await screen.findByTestId('add-status')).toHaveTextContent(
      'Added 3 to your cart. You now have 3.',
    )
    expect(screen.getByRole('link', { name: 'View cart' })).toHaveAttribute('href', '/cart')
    expect(router.refresh).toHaveBeenCalled()
  })

  it('surfaces the backend’s own stock signal from the add answer', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(
      json(200, { ok: true, cart: cart([line({ issues: ['OUT_OF_STOCK'], buyable: false })]) }),
    )
    render(
      <AddToCart productId="TZP-1001" productName="Rice" csrfToken={CSRF} stockState="UNKNOWN" />,
    )
    await user.click(screen.getByRole('button', { name: 'Add to cart' }))
    expect(await screen.findByTestId('add-status')).toHaveTextContent('Out of stock.')
  })

  it('reports a refusal in an alert and does not claim success', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(
      json(422, { ok: false, error: 'quantity_limit', retryAfterSeconds: null }),
    )
    render(
      <AddToCart productId="TZP-1001" productName="Rice" csrfToken={CSRF} stockState="UNKNOWN" />,
    )
    await user.click(screen.getByRole('button', { name: 'Add to cart' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('You can buy up to 20 of one item.')
    expect(screen.queryByRole('link', { name: 'View cart' })).not.toBeInTheDocument()
    expect(router.refresh).not.toHaveBeenCalled()
  })
})
