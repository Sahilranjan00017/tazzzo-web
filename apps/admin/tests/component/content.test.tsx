import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppConfigForm } from '@/components/content/AppConfigForm'
import { FaqEditor, FaqStatusActions } from '@/components/content/FaqEditor'
import { FaqDetailView, FaqListView } from '@/components/content/FaqViews'
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
const NOW = Date.parse('2026-10-06T10:00:00Z')
const block = (over: Record<string, unknown> = {}) => ({
  blockId: 'CB_abcdefghijklmnop',
  placement: 'HELP',
  type: 'FAQ',
  title: 'Delivery',
  sort: 1,
  status: 'PUBLISHED',
  version: 4,
  payload: { faqCategory: 'DELIVERY', question: 'When?', answer: '<b>Evenings</b>\nDaily' },
  ...over,
})

describe('FAQ views', () => {
  it('lists with a derived visibility badge, the delay disclosure, and filters FAQ blocks only', () => {
    wrap(
      <FaqListView
        result={{
          kind: 'ok',
          data: {
            items: [
              block(),
              block({
                blockId: 'CB_2222222222222222',
                status: 'PUBLISHED',
                startsAt: '2026-10-07T00:00:00Z',
                payload: { faqCategory: 'REFUND', question: 'Refunds?', answer: 'x' },
              }),
              block({ blockId: 'CB_3333333333333333', type: 'BANNER' }),
            ],
          },
        }}
        canWrite
        nowMs={NOW}
      />,
    )
    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(screen.getByText('live')).toBeInTheDocument()
    expect(screen.getByText('scheduled')).toBeInTheDocument()
    expect(screen.getByText(/emergency unpublish/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'New FAQ' })).toBeInTheDocument()
  })
  it('detail renders the answer as inert text, and is read-only without write access', () => {
    const { container } = wrap(
      <FaqDetailView result={{ kind: 'ok', data: block() }} canWrite={false} nowMs={NOW} />,
    )
    expect(container.querySelector('b')).toBeNull()
    expect(screen.getByText(/<b>Evenings<\/b>/)).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('cms-writer')
  })
  it('refuses to edit a non-FAQ block here', () => {
    wrap(
      <FaqDetailView
        result={{ kind: 'ok', data: block({ type: 'BANNER' }) }}
        canWrite
        nowMs={NOW}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('BANNER')
  })
  it('permission and empty states', () => {
    const { rerender } = wrap(
      <FaqListView result={{ kind: 'forbidden' }} canWrite={false} nowMs={NOW} />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Not permitted')
    rerender(
      <ToastProvider>
        <FaqListView result={{ kind: 'ok', data: { items: [] } }} canWrite={false} nowMs={NOW} />
      </ToastProvider>,
    )
    expect(screen.getByText('No FAQs')).toBeInTheDocument()
  })
})

describe('FaqEditor', () => {
  it('validates locally (HTML, newline in question) with no request', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    wrap(<FaqEditor />)
    await user.type(screen.getByLabelText('Question'), 'a < b')
    await user.type(screen.getByLabelText('Answer'), 'ok')
    await user.click(screen.getByRole('button', { name: 'Review new FAQ' }))
    expect(screen.getByRole('alert')).toHaveTextContent('no < or >')
    expect(f).not.toHaveBeenCalled()
  })
  it('creates a DRAFT (no placement/type from the browser) and navigates to the new entry', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { blockId: 'CB_newnewnewnewnewnew', status: 'DRAFT', version: 1 },
        }),
        { status: 200 },
      ),
    )
    wrap(<FaqEditor />)
    await user.type(screen.getByLabelText('Question'), 'Do you deliver Sundays?')
    await user.type(screen.getByLabelText('Answer'), 'Yes.')
    await user.click(screen.getByRole('button', { name: 'Review new FAQ' }))
    expect(screen.getByRole('dialog', { hidden: true })).toHaveTextContent(
      'not visible to customers until you publish',
    )
    await user.click(
      within(screen.getByRole('dialog', { hidden: true })).getByRole('button', {
        name: 'Save',
        hidden: true,
      }),
    )
    expect(f.mock.calls[0]![0]).toBe('/api/bff/content/faqs')
    const body = JSON.parse(String(f.mock.calls[0]![1]?.body))
    expect(body).toMatchObject({
      title: 'Do you deliver Sundays?',
      sort: 0,
      payload: { faqCategory: 'DELIVERY' },
    })
    expect(body).not.toHaveProperty('type')
    expect(body).not.toHaveProperty('placement')
    expect(push).toHaveBeenCalledWith('/content/faqs/CB_newnewnewnewnewnew')
  })
  it('editing a published FAQ warns that it changes live content and discloses the delay; a cleared window is omitted', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    wrap(
      <FaqEditor
        block={block({
          startsAt: '2026-10-06T03:30:00Z',
          payload: { faqCategory: 'DELIVERY', question: 'When?', answer: 'Evenings' },
        })}
      />,
    )
    expect(screen.getByLabelText('Starts')).toHaveValue('2026-10-06T09:00')
    await user.clear(screen.getByLabelText('Starts'))
    await user.type(screen.getByLabelText('Answer'), ' More.')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByRole('dialog', { hidden: true })).toHaveTextContent(
      'PUBLISHED: your edit changes what customers see',
    )
    expect(screen.getByRole('dialog', { hidden: true })).toHaveTextContent('up to a minute')
    await user.click(
      within(screen.getByRole('dialog', { hidden: true })).getByRole('button', {
        name: 'Save',
        hidden: true,
      }),
    )
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('/api/bff/content/blocks/CB_abcdefghijklmnop')
    const body = JSON.parse(String(init?.body))
    expect(body.expectedVersion).toBe(4)
    expect(body).not.toHaveProperty('startsAt')
  })
  it('archived entries are read-only', () => {
    wrap(<FaqEditor block={block({ status: 'ARCHIVED' })} />)
    expect(screen.getByText(/Archived entries are final/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull()
  })
})

describe('FaqStatusActions', () => {
  it('offers the legal moves, confirms with the delay disclosure, and posts the version', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    wrap(<FaqStatusActions blockId="CB_abcdefghijklmnop" status="PUBLISHED" version={4} />)
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Unpublish' }))
    expect(f).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { hidden: true })).toHaveTextContent('emergency unpublish')
    await user.click(
      within(screen.getByRole('dialog', { hidden: true })).getByRole('button', {
        name: 'Unpublish',
        hidden: true,
      }),
    )
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      to: 'DRAFT',
      expectedVersion: 4,
    })
  })
  it('archived has no actions', () => {
    wrap(<FaqStatusActions blockId="CB_abcdefghijklmnop" status="ARCHIVED" version={4} />)
    expect(screen.getByText(/archived; it is final/)).toBeInTheDocument()
  })
})

describe('AppConfigForm', () => {
  const cfg = {
    storeOpen: true,
    maintenance: false,
    maintenanceMessage: null,
    minAndroid: '1.0.0',
    latestAndroid: '1.2.0',
    minIos: null,
    latestIos: null,
    supportPhone: '+918012345678',
    supportEmail: null,
    termsUrl: null,
    privacyUrl: null,
    refundPolicyUrl: null,
    version: 3,
  }
  it('blocks bad links and maintenance without a message, with no request', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    wrap(<AppConfigForm config={cfg} />)
    await user.type(screen.getByLabelText('Terms of service URL'), 'http://insecure.example/terms')
    await user.click(screen.getByLabelText('Maintenance mode'))
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByRole('alert')).toHaveTextContent('https://')
    expect(screen.getByRole('alert')).toHaveTextContent('needs a message')
    expect(f).not.toHaveBeenCalled()
  })
  it('closing the store is flagged in the confirmation, and the PUT sends nulls for blanks with the version', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: { version: 4 } }), { status: 200 }))
    wrap(<AppConfigForm config={cfg} />)
    await user.click(screen.getByLabelText('Store open for orders'))
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByRole('dialog', { hidden: true })).toHaveTextContent('CLOSED for orders')
    await user.click(
      within(screen.getByRole('dialog', { hidden: true })).getByRole('button', {
        name: 'Save configuration',
        hidden: true,
      }),
    )
    expect(f.mock.calls[0]![0]).toBe('/api/bff/content/app-config')
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toMatchObject({
      storeOpen: false,
      maintenance: false,
      minAndroid: '1.0.0',
      minIos: null,
      termsUrl: null,
      expectedVersion: 3,
    })
  })
  it('first-save state is explained', () => {
    wrap(<AppConfigForm config={{ ...cfg, version: 0 }} />)
    expect(screen.getByRole('status')).toHaveTextContent('backend defaults')
  })
})
