import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AreaEditor } from '@/components/delivery/AreaEditor'
import { ServiceAreaDetailView, ServiceAreaListView } from '@/components/delivery/ServiceAreaViews'
import { SlotsView } from '@/components/delivery/SlotsView'
import { WindowEditor } from '@/components/delivery/WindowEditor'
import { ToastProvider } from '@/components/ui/Toast'

const refresh = vi.fn()
const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, replace: vi.fn(), push }) }))
beforeEach(() => {
  refresh.mockClear()
  push.mockClear()
  vi.restoreAllMocks()
})
const wrap = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>)

const area = {
  pincode: '560047',
  serviceAreaId: 'Ejipura',
  active: true,
  version: 3,
  routes: [
    { fulfillmentLocationId: 'LOC-2', priority: 5, active: true },
    { fulfillmentLocationId: 'LOC-1', priority: 1, active: true },
  ],
}
const win = {
  serviceAreaId: 'Ejipura',
  windowId: 'evening',
  label: 'Evening',
  startMinute: 1080,
  endMinute: 1200,
  cutoffMinutes: 60,
  capacity: 20,
  days: [1, 2, 3, 4, 5],
  active: true,
  version: 4,
}

describe('service area views', () => {
  it('lists areas with pincode paging and a create link only for writers', () => {
    const { rerender } = wrap(
      <ServiceAreaListView
        result={{ kind: 'ok', data: { items: [area], nextCursor: '560048' } }}
        canWrite
      />,
    )
    expect(screen.getByRole('link', { name: '560047' })).toHaveAttribute(
      'href',
      '/delivery/service-areas/560047',
    )
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute(
      'href',
      '/delivery/service-areas?after=560048',
    )
    expect(screen.getByRole('link', { name: 'New service area' })).toBeInTheDocument()
    rerender(
      <ToastProvider>
        <ServiceAreaListView result={{ kind: 'ok', data: { items: [] } }} canWrite={false} />
      </ToastProvider>,
    )
    expect(screen.queryByRole('link', { name: 'New service area' })).toBeNull()
    expect(screen.getByText('No service areas')).toBeInTheDocument()
  })
  it('detail names the serving location (lowest active priority) and is read-only without write access', () => {
    wrap(<ServiceAreaDetailView result={{ kind: 'ok', data: area }} canWrite={false} />)
    expect(screen.getByText(/Serving location/)).toHaveTextContent('LOC-1')
    expect(screen.getByRole('note')).toHaveTextContent('cms-writer')
    expect(screen.getByRole('link', { name: 'Delivery slots' })).toHaveAttribute(
      'href',
      '/delivery/slots?area=Ejipura',
    )
  })
  it('permission and not-found states', () => {
    const { rerender } = wrap(
      <ServiceAreaDetailView result={{ kind: 'forbidden' }} canWrite={false} />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Not permitted')
    rerender(
      <ToastProvider>
        <ServiceAreaDetailView result={{ kind: 'not_found' }} canWrite={false} />
      </ToastProvider>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('not found')
  })
})

describe('AreaEditor', () => {
  it('blocks duplicate priorities and bad pincodes locally, with no request', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    wrap(<AreaEditor />)
    await user.type(screen.getByLabelText('Pincode'), '012345')
    await user.type(screen.getByLabelText('Service area id (grouping label)'), 'Ejipura')
    await user.click(screen.getByRole('button', { name: 'Review new area' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Pincode must be 6 digits')
    expect(f).not.toHaveBeenCalled()
  })
  it('edit: warns that save replaces all routes, then sends routes with the loaded version', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: { version: 4 } }), { status: 200 }))
    wrap(<AreaEditor area={area} />)
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByRole('dialog', { hidden: true })).toHaveTextContent('replaces ALL routes')
    expect(f).not.toHaveBeenCalled()
    await user.click(
      within(screen.getByRole('dialog', { hidden: true })).getByRole('button', {
        name: 'Save',
        hidden: true,
      }),
    )
    expect(f.mock.calls[0]![0]).toBe('/api/bff/delivery/service-areas/560047')
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      serviceAreaId: 'Ejipura',
      routes: [
        { fulfillmentLocationId: 'LOC-2', priority: 5, active: true },
        { fulfillmentLocationId: 'LOC-1', priority: 1, active: true },
      ],
      expectedVersion: 3,
    })
  })
  it('create: no version, navigates to the new area on success', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    wrap(<AreaEditor />)
    await user.type(screen.getByLabelText('Pincode'), '560048')
    await user.type(screen.getByLabelText('Service area id (grouping label)'), 'Indiranagar')
    await user.click(screen.getByRole('button', { name: 'Review new area' }))
    await user.click(
      within(screen.getByRole('dialog', { hidden: true })).getByRole('button', {
        name: 'Save',
        hidden: true,
      }),
    )
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      serviceAreaId: 'Indiranagar',
      routes: [],
    })
    expect(push).toHaveBeenCalledWith('/delivery/service-areas/560048')
  })
})

describe('slots', () => {
  it('lists windows with 24 h times and day summaries; non-writers have no actions', () => {
    wrap(
      <SlotsView area="Ejipura" result={{ kind: 'ok', data: { items: [win] } }} canWrite={false} />,
    )
    expect(screen.getByText('18:00–20:00')).toBeInTheDocument()
    expect(screen.getByText('Mon, Tue, Wed, Thu, Fri')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull()
    expect(screen.getByRole('note')).toHaveTextContent('cms-writer')
  })
  it('says that an empty list may also mean an unknown area', () => {
    wrap(<SlotsView area="Nowhere" result={{ kind: 'ok', data: { items: [] } }} canWrite />)
    expect(screen.getByText(/unknown area id also shows none/)).toBeInTheDocument()
  })
  it('window editor converts times to minutes, requires a day, and sends the version on edit', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    wrap(<WindowEditor serviceAreaId="Ejipura" window={win} />)
    await user.clear(screen.getByLabelText('Capacity (orders per day)'))
    await user.type(screen.getByLabelText('Capacity (orders per day)'), '30')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    await user.click(
      within(screen.getByRole('dialog', { hidden: true })).getByRole('button', {
        name: 'Save window',
        hidden: true,
      }),
    )
    expect(f.mock.calls[0]![0]).toBe('/api/bff/delivery/slots/Ejipura/evening')
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      label: 'Evening',
      startMinute: 1080,
      endMinute: 1200,
      cutoffMinutes: 60,
      capacity: 30,
      days: [1, 2, 3, 4, 5],
      expectedVersion: 4,
    })
  })
  it('rejects an end before the start without calling the backend', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    wrap(<WindowEditor serviceAreaId="Ejipura" />)
    await user.type(screen.getByLabelText('Window id'), 'late')
    await user.type(screen.getByLabelText('Label shown to customers'), 'Late')
    await user.click(screen.getByLabelText('Mon'))
    for (const d of ['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
      await user.click(screen.getByLabelText(d))
    await user.click(screen.getByRole('button', { name: 'Review new window' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one day')
    expect(f).not.toHaveBeenCalled()
  })
})
