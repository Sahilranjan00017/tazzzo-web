import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AddressForm } from '@/components/AddressForm'
import { AddressList } from '@/components/AddressList'
import { DeliveryChoice } from '@/components/DeliveryChoice'
import { LocationForm } from '@/components/LocationForm'
import { ProductAvailability } from '@/components/ProductAvailability'
import { SlotPicker } from '@/components/SlotPicker'
import type { Address } from '@/lib/address/model'
import type { SlotsView } from '@/lib/delivery/slots'

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
const CSRF = 'c'.repeat(43)

beforeEach(() => {
  fetchMock.mockReset()
  assign.mockReset()
  router.refresh.mockReset()
  router.push.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  })
})
afterEach(() => vi.unstubAllGlobals())

const address = (over: Partial<Address> = {}): Address => ({
  addressId: 'ADDR_abcdefghij123',
  label: 'HOME',
  recipientName: 'Asha Verma',
  recipientPhone: '+919876543210',
  addressLine1: '12 MG Road',
  addressLine2: null,
  landmark: null,
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
  isDefault: true,
  version: 3,
  serviceable: true,
  ...over,
})
const bodyOf = (call = 0) =>
  JSON.parse(String(fetchMock.mock.calls[call]![1]!.body)) as Record<string, unknown>
const headersOf = (call = 0) => fetchMock.mock.calls[call]![1]!.headers as Record<string, string>

describe('LocationForm', () => {
  const form = (over: Partial<React.ComponentProps<typeof LocationForm>> = {}) =>
    render(
      <LocationForm
        initial={null}
        csrfToken={null}
        addresses={null}
        selectedAddressId={null}
        next="/cart"
        {...over}
      />,
    )

  it('labels the field and announces an invalid PIN, focusing the field, without calling the server', async () => {
    form()
    const user = userEvent.setup()
    const input = screen.getByLabelText('PIN code')
    for (const bad of ['', '56001', '056001', 'abc123']) {
      await user.clear(input)
      if (bad) await user.type(input, bad)
      await user.click(screen.getByRole('button', { name: 'Check PIN code' }))
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a 6-digit PIN code')
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input).toHaveFocus()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a serviceable PIN is sent with the pre-login CSRF token, announced, and refreshes the page', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { ok: true, data: { pin: '560001', serviceable: true, viaAddress: false } }),
    )
    form()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('PIN code'), ' 560001 ')
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(screen.getByTestId('location-status')).toHaveTextContent('we deliver to 560001'),
    )
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/location')
    expect(headersOf()['X-Tazzzo-CSRF']).toBe('1')
    expect(bodyOf()).toEqual({ pin: '560001' })
    expect(router.refresh).toHaveBeenCalled()
    expect(screen.getByTestId('location-continue')).toHaveAttribute('href', '/cart')
  })

  it('an unserviceable PIN is a clear state, with no Continue link', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { ok: true, data: { pin: '400001', serviceable: false, viaAddress: false } }),
    )
    form()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('PIN code'), '400001')
    await user.click(screen.getByRole('button', { name: 'Check PIN code' }))
    await waitFor(() =>
      expect(screen.getByTestId('location-status')).toHaveTextContent('do not deliver to 400001'),
    )
    expect(screen.getByTestId('location-current')).toHaveTextContent('Not delivering to 400001')
    expect(screen.queryByTestId('location-continue')).not.toBeInTheDocument()
  })

  it('a failure is announced as an alert, never as backend text', async () => {
    fetchMock.mockResolvedValueOnce(
      json(503, { ok: false, error: 'unavailable', retryAfterSeconds: null }),
    )
    form()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('PIN code'), '560001')
    await user.click(screen.getByRole('button', { name: 'Check PIN code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not check that right now')
  })

  it('signed in: saved addresses can be chosen (the session token is sent) and the choice is announced', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, { ok: true, data: { pin: '560001', serviceable: true, viaAddress: true } }),
    )
    form({
      csrfToken: CSRF,
      addresses: [
        address(),
        address({
          addressId: 'ADDR_second12345',
          label: 'WORK',
          isDefault: false,
          postalCode: '400001',
          serviceable: false,
        }),
      ],
    })
    const user = userEvent.setup()
    const cards = screen.getAllByTestId('location-address')
    expect(
      within(cards[1]!).getByText('We do not deliver to this PIN code yet.'),
    ).toBeInTheDocument()
    await user.click(within(cards[0]!).getByRole('button', { name: 'Deliver here' }))
    await waitFor(() =>
      expect(
        within(cards[0]!).getByRole('button', { name: 'Delivering here' }),
      ).toBeInTheDocument(),
    )
    expect(headersOf()['X-Tazzzo-CSRF']).toBe(CSRF)
    expect(bodyOf()).toEqual({ addressId: 'ADDR_abcdefghij123' })
    expect(screen.getByTestId('location-status')).toHaveTextContent(
      'Delivering to your Home address',
    )
  })

  it('signed out offers sign-in for saved addresses; signed in with none offers to add one', () => {
    form()
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      expect.stringContaining('/login?next='),
    )
    form({ csrfToken: CSRF, addresses: [] })
    expect(screen.getByRole('link', { name: 'Add an address' })).toHaveAttribute(
      'href',
      '/account/addresses/new',
    )
  })
})

describe('AddressForm', () => {
  it('every field has a visible label; optional ones say so', () => {
    render(<AddressForm address={null} csrfToken={CSRF} />)
    for (const name of [
      'Address type',
      'Full name',
      'Mobile number',
      'Address line 1',
      'Address line 2 (optional)',
      'Landmark (optional)',
      'City',
      'State',
      'PIN code',
    ]) {
      expect(screen.getByLabelText(name)).toBeInTheDocument()
    }
  })

  it('shows every error next to its field, announced, moves focus to the first invalid one and sends nothing', async () => {
    render(<AddressForm address={null} csrfToken={CSRF} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('PIN code'), '056001')
    await user.click(screen.getByRole('button', { name: 'Save address' }))
    expect(fetchMock).not.toHaveBeenCalled()
    const name = screen.getByLabelText('Full name')
    expect(name).toHaveFocus()
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAccessibleDescription('Full name is required.')
    expect(screen.getByLabelText('PIN code')).toHaveAccessibleDescription(/6-digit PIN code/)
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(3)
  })

  async function fillValid(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText('Full name'), 'Asha Verma')
    await user.type(screen.getByLabelText('Mobile number'), '98765 43210')
    await user.type(screen.getByLabelText('Address line 1'), '12 MG Road')
    await user.type(screen.getByLabelText('City'), 'Bengaluru')
    await user.type(screen.getByLabelText('State'), 'Karnataka')
    await user.type(screen.getByLabelText('PIN code'), '560001')
  }

  it('creates with an idempotency key, then goes to the list', async () => {
    fetchMock.mockResolvedValueOnce(json(201, { ok: true, data: address() }))
    render(<AddressForm address={null} csrfToken={CSRF} />)
    const user = userEvent.setup()
    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'Save address' }))
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/account/addresses'))
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/addresses')
    expect(headersOf()['X-Tazzzo-CSRF']).toBe(CSRF)
    expect(bodyOf()).toMatchObject({
      label: 'HOME',
      recipientPhone: '+919876543210',
      addressLine2: null,
      landmark: null,
    })
    expect(String(bodyOf().idempotencyKey)).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(Object.keys(bodyOf()).sort()).toEqual([
      'addressLine1',
      'addressLine2',
      'city',
      'idempotencyKey',
      'label',
      'landmark',
      'postalCode',
      'recipientName',
      'recipientPhone',
      'state',
    ])
  })

  it('a retry after a failure reuses the key while the form is unchanged, and uses a new one once it changed', async () => {
    fetchMock.mockResolvedValue(json(503, { ok: false, error: 'unavailable' }))
    render(<AddressForm address={null} csrfToken={CSRF} />)
    const user = userEvent.setup()
    await fillValid(user)
    const save = () => user.click(screen.getByRole('button', { name: 'Save address' }))
    await save()
    await screen.findByText(/could not update your addresses/)
    await save()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(bodyOf(1).idempotencyKey).toBe(bodyOf(0).idempotencyKey)
    await user.type(screen.getByLabelText('Landmark (optional)'), 'Near the park')
    await save()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(bodyOf(2).idempotencyKey).not.toBe(bodyOf(0).idempotencyKey)
  })

  it('edit sends the address id and the version it saw; a stale version refreshes and says so', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { ok: false, error: 'conflict' }))
    render(<AddressForm address={address()} csrfToken={CSRF} />)
    const user = userEvent.setup()
    expect(screen.getByLabelText('Mobile number')).toHaveValue('9876543210')
    await user.click(screen.getByRole('button', { name: 'Save address' }))
    expect(await screen.findByText(/changed in another tab/)).toBeInTheDocument()
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/addresses/update')
    expect(bodyOf()).toMatchObject({ addressId: 'ADDR_abcdefghij123', version: 3 })
    expect(router.refresh).toHaveBeenCalled()
  })

  it('limit reached and signed-out replies are explained or lead to sign-in', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { ok: false, error: 'limit_reached' }))
    render(<AddressForm address={null} csrfToken={CSRF} />)
    const user = userEvent.setup()
    await fillValid(user)
    await user.click(screen.getByRole('button', { name: 'Save address' }))
    expect(await screen.findByText(/limit of saved addresses/)).toBeInTheDocument()
    fetchMock.mockResolvedValueOnce(json(401, { ok: false, error: 'unauthenticated' }))
    await user.click(screen.getByRole('button', { name: 'Save address' }))
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(expect.stringContaining('/login?next=')),
    )
  })
})

describe('AddressList', () => {
  it('lists addresses with accessible action names, marks the default, and warns about an unserviceable PIN', () => {
    render(
      <AddressList
        csrfToken={CSRF}
        addresses={[
          address(),
          address({
            addressId: 'ADDR_second12345',
            label: 'WORK',
            isDefault: false,
            serviceable: false,
            postalCode: '400001',
          }),
        ]}
      />,
    )
    const cards = screen.getAllByTestId('address-card')
    expect(within(cards[0]!).getByText('Default')).toBeInTheDocument()
    expect(within(cards[0]!).queryByRole('button', { name: /default/ })).not.toBeInTheDocument()
    expect(
      within(cards[1]!).getByRole('button', { name: 'Make Work address, 12 MG Road the default' }),
    ).toBeInTheDocument()
    expect(
      within(cards[1]!).getByText('We do not deliver to this PIN code yet.'),
    ).toBeInTheDocument()
    expect(
      within(cards[0]!).getByRole('link', { name: 'Edit Home address, 12 MG Road' }),
    ).toHaveAttribute('href', '/account/addresses/ADDR_abcdefghij123')
  })

  it('delete asks first (keyboard operable), then sends id + version, announces and refreshes', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, data: null }))
    render(<AddressList csrfToken={CSRF} addresses={[address()]} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Delete/ }))
    expect(fetchMock).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Yes, delete Home' }))
    await waitFor(() =>
      expect(screen.getByTestId('address-status')).toHaveTextContent('Address deleted.'),
    )
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/addresses/delete')
    expect(bodyOf()).toEqual({ addressId: 'ADDR_abcdefghij123', version: 3 })
    expect(router.refresh).toHaveBeenCalled()
  })

  it('"Keep it" cancels; set default posts the id; a failure is an alert', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { ok: false, error: 'not_found' }))
    render(
      <AddressList
        csrfToken={CSRF}
        addresses={[address(), address({ addressId: 'ADDR_second12345', isDefault: false })]}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: /^Delete/ })[0]!)
    await user.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(fetchMock).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /the default$/ }))
    expect(await screen.findByText(/no longer exists/)).toBeInTheDocument()
    expect(bodyOf()).toEqual({ addressId: 'ADDR_second12345' })
  })

  it('empty list says so', () => {
    render(<AddressList csrfToken={CSRF} addresses={[]} />)
    expect(screen.getByTestId('address-empty')).toBeInTheDocument()
  })
})

const view = (over: Partial<SlotsView> = {}): SlotsView => ({
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
    {
      slotId: 'afternoon~2026-10-11',
      date: '2026-10-11',
      startsAt: '2026-10-11T13:00:00+05:30',
      endsAt: '2026-10-11T15:00:00+05:30',
      label: 'Afternoon',
      status: 'FULL',
    },
    {
      slotId: 'evening~2026-10-11',
      date: '2026-10-11',
      startsAt: '2026-10-11T18:00:00+05:30',
      endsAt: '2026-10-11T20:00:00+05:30',
      label: 'Evening',
      status: 'CLOSED',
    },
    {
      slotId: 'morning~2026-10-12',
      date: '2026-10-12',
      startsAt: '2026-10-12T09:00:00+05:30',
      endsAt: '2026-10-12T11:00:00+05:30',
      label: 'Morning',
      status: 'AVAILABLE',
    },
  ],
  ...over,
})

describe('SlotPicker', () => {
  it('groups by date, shows the window in the delivery zone and why a slot cannot be taken', () => {
    render(<SlotPicker view={view()} value={null} onChange={() => {}} />)
    expect(screen.getByRole('group', { name: 'Sunday, 11 October' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Monday, 12 October' })).toBeInTheDocument()
    const morning = screen.getAllByTestId('slot-option')[0]!
    expect(morning).toHaveTextContent('Morning')
    expect(morning).toHaveTextContent(/9:00\s?am to 11:00\s?am/i)
    const full = screen.getByRole('radio', { name: /Afternoon/ })
    expect(full).toBeDisabled()
    expect(screen.getByRole('radio', { name: /Afternoon.*Fully booked/ })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /Evening.*Booking closed/ })).toBeDisabled()
    expect(screen.getAllByRole('radio', { name: /Morning/ })[0]).toBeEnabled()
  })

  it('selecting works by click and by keyboard, and a disabled slot is skipped', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<SlotPicker view={view()} value={null} onChange={onChange} />)
    const user = userEvent.setup()
    await user.click(screen.getAllByRole('radio', { name: /Morning/ })[0]!)
    expect(onChange).toHaveBeenLastCalledWith('morning~2026-10-11')
    rerender(<SlotPicker view={view()} value="morning~2026-10-11" onChange={onChange} />)
    screen.getAllByRole('radio', { name: /Morning/ })[0]!.focus()
    await user.keyboard('{ArrowDown}')
    expect(onChange).toHaveBeenLastCalledWith('morning~2026-10-12')
    await user.click(screen.getByRole('radio', { name: /Afternoon/ }))
    expect(onChange).not.toHaveBeenCalledWith('afternoon~2026-10-11')
  })

  it('has states for unserviceable, empty and nothing open', () => {
    const { rerender } = render(
      <SlotPicker
        view={view({ serviceable: false, slots: [] })}
        value={null}
        onChange={() => {}}
      />,
    )
    expect(screen.getByTestId('slots-unserviceable')).toBeInTheDocument()
    rerender(<SlotPicker view={view({ slots: [] })} value={null} onChange={() => {}} />)
    expect(screen.getByTestId('slots-empty')).toBeInTheDocument()
    rerender(
      <SlotPicker
        view={view({ slots: view().slots.map((s) => ({ ...s, status: 'FULL' as const })) })}
        value={null}
        onChange={() => {}}
      />,
    )
    expect(screen.getByTestId('slots-none-open')).toBeInTheDocument()
    expect(screen.getAllByRole('radio').every((r) => (r as HTMLInputElement).disabled)).toBe(true)
  })

  it('never treats a malformed slot id as selectable', () => {
    const bad = view({ slots: [{ ...view().slots[0]!, slotId: '../etc' }] })
    render(<SlotPicker view={bad} value={null} onChange={() => {}} />)
    expect(screen.getByRole('radio')).toBeDisabled()
  })
})

describe('DeliveryChoice', () => {
  const props = {
    addresses: [address()],
    addressId: 'ADDR_abcdefghij123',
    slots: view(),
    slotsError: false,
    savedSlotId: null,
    csrfToken: CSRF,
  }
  it('asks for a slot first, then saves address + slot with the session token', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, data: {} }))
    render(<DeliveryChoice {...props} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Save delivery choice' }))
    expect(screen.getByTestId('delivery-error')).toHaveTextContent('Choose a delivery slot.')
    expect(fetchMock).not.toHaveBeenCalled()
    await user.click(screen.getAllByRole('radio', { name: /Morning/ })[0]!)
    await user.click(screen.getByRole('button', { name: 'Save delivery choice' }))
    await waitFor(() =>
      expect(screen.getByTestId('delivery-saved')).toHaveTextContent('saved for the next step'),
    )
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/checkout/delivery')
    expect(headersOf()['X-Tazzzo-CSRF']).toBe(CSRF)
    expect(bodyOf()).toEqual({ addressId: 'ADDR_abcdefghij123', slotId: 'morning~2026-10-11' })
  })

  it('a slot taken meanwhile is explained and the page reloads its slots', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { ok: false, error: 'slot_unavailable' }))
    render(<DeliveryChoice {...props} savedSlotId="morning~2026-10-11" />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Save delivery choice' }))
    expect(
      await screen.findByText(/no longer available. Please choose another/),
    ).toBeInTheDocument()
    expect(router.refresh).toHaveBeenCalled()
  })

  it('changing the address navigates to that address; no addresses leads to adding one; a slot load failure is an alert', async () => {
    const two = [
      address(),
      address({ addressId: 'ADDR_second12345', label: 'WORK', isDefault: false }),
    ]
    const { unmount } = render(
      <DeliveryChoice {...props} addresses={two} slotsError slots={null} />,
    )
    expect(screen.getByTestId('slots-error')).toHaveAttribute('role', 'alert')
    await userEvent
      .setup()
      .click(screen.getAllByTestId('delivery-address')[1]!.querySelector('input')!)
    expect(router.push).toHaveBeenCalledWith('/checkout/delivery?address=ADDR_second12345')
    unmount()
    render(<DeliveryChoice {...props} addresses={[]} addressId={null} slots={null} />)
    expect(screen.getByTestId('delivery-no-address')).toBeInTheDocument()
  })
})

describe('ProductAvailability', () => {
  const base = { stockState: 'UNKNOWN' as const, lowStockRemaining: null, pinUsed: null }
  it('invites choosing a location without one', () => {
    render(<ProductAvailability {...base} location={null} />)
    expect(screen.getByRole('link', { name: 'Choose your delivery location' })).toHaveAttribute(
      'href',
      '/location',
    )
  })
  it('says so for an unserviceable PIN, and reports stock for a serviceable one', () => {
    const { rerender } = render(
      <ProductAvailability
        {...base}
        location={{ pin: '400001', serviceable: false, viaAddress: false }}
      />,
    )
    expect(screen.getByTestId('availability')).toHaveTextContent('We do not deliver to 400001 yet.')
    rerender(
      <ProductAvailability
        stockState="IN_STOCK"
        lowStockRemaining={null}
        pinUsed="560001"
        location={{ pin: '560001', serviceable: true, viaAddress: false }}
      />,
    )
    expect(screen.getByTestId('availability')).toHaveTextContent('In stock for delivery to 560001.')
    rerender(
      <ProductAvailability
        stockState="LOW_STOCK"
        lowStockRemaining={3}
        pinUsed="560001"
        location={{ pin: '560001', serviceable: true, viaAddress: false }}
      />,
    )
    expect(screen.getByTestId('availability')).toHaveTextContent(
      'Only 3 left for delivery to 560001.',
    )
  })
})
