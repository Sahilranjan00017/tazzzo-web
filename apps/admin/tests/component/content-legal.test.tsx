import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppConfigForm } from '@/components/content/AppConfigForm'
import { LegalEditor, LegalStatusActions } from '@/components/content/LegalEditor'
import { legalParagraphs } from '@/lib/content'
import { LegalDetailView, LegalListView } from '@/components/content/LegalViews'
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
const doc = (over: Record<string, unknown> = {}) => ({
  blockId: 'CB_abcdefghijklmnop',
  placement: 'HELP',
  type: 'LEGAL',
  title: 'Terms of Service',
  sort: 0,
  status: 'PUBLISHED',
  version: 4,
  updatedAt: '2026-10-01T00:00:00Z',
  payload: { legalSlug: 'TERMS', body: '<b>One</b>.\n\nTwo.', effectiveDate: '2026-10-01' },
  ...over,
})
const clean = (over: Record<string, unknown> = {}) =>
  doc({
    payload: { legalSlug: 'TERMS', body: 'One.\n\nTwo.', effectiveDate: '2026-10-01' },
    ...over,
  })
const dialog = () => screen.getByRole('dialog', { hidden: true })
const confirmWith = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(within(dialog()).getByRole('button', { name, hidden: true }))

describe('legal paragraphs', () => {
  it('splits at blank lines only and drops empties', () => {
    expect(legalParagraphs('a\nb\n\nc\n \n\nd')).toEqual(['a\nb', 'c', 'd'])
    expect(legalParagraphs('')).toEqual([])
  })
})

describe('Legal list', () => {
  it('shows which document is live per slug, flags a missing one, and lists only LEGAL blocks', () => {
    wrap(
      <LegalListView
        result={{
          kind: 'ok',
          data: {
            items: [
              doc(),
              doc({
                blockId: 'CB_2222222222222222',
                title: 'Privacy draft',
                status: 'DRAFT',
                payload: { legalSlug: 'PRIVACY', body: 'x' },
              }),
              doc({ blockId: 'CB_3333333333333333', type: 'FAQ', title: 'An FAQ' }),
            ],
          },
        }}
        canWrite
        nowMs={NOW}
      />,
    )
    expect(screen.getByTestId('live-terms')).toHaveTextContent('Terms of Service')
    expect(screen.getByTestId('live-terms')).toHaveTextContent('effective 2026-10-01')
    expect(screen.getByTestId('live-privacy')).toHaveTextContent('none live')
    expect(screen.getByTestId('live-privacy')).toHaveTextContent('“not found”')
    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(screen.queryByText('An FAQ')).toBeNull()
    expect(screen.getByText(/emergency unpublish/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'New document' })).toBeInTheDocument()
  })
  it('warns when legacy data makes two documents live for one page', () => {
    wrap(
      <LegalListView
        result={{
          kind: 'ok',
          data: { items: [doc(), doc({ blockId: 'CB_2222222222222222', title: 'Terms v2' })] },
        }}
        canWrite={false}
        nowMs={NOW}
      />,
    )
    expect(screen.getByTestId('live-terms')).toHaveTextContent('2 documents are live')
    expect(screen.queryByRole('link', { name: 'New document' })).toBeNull()
  })
  it('permission and empty states', () => {
    const { rerender } = wrap(
      <LegalListView result={{ kind: 'forbidden' }} canWrite={false} nowMs={NOW} />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Not permitted')
    rerender(
      <ToastProvider>
        <LegalListView result={{ kind: 'ok', data: { items: [] } }} canWrite nowMs={NOW} />
      </ToastProvider>,
    )
    expect(screen.getByText('No legal documents')).toBeInTheDocument()
    expect(screen.getByTestId('live-terms')).toHaveTextContent('none live')
  })
})

describe('Legal detail', () => {
  it('a reader sees the text as inert paragraphs and no write controls', () => {
    const { container } = wrap(
      <LegalDetailView result={{ kind: 'ok', data: doc() }} canWrite={false} nowMs={NOW} />,
    )
    expect(container.querySelector('b')).toBeNull()
    expect(screen.getByText('<b>One</b>.')).toBeInTheDocument()
    expect(screen.getByText('Two.')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('cms-writer')
    expect(screen.queryByRole('button', { name: 'Unpublish' })).toBeNull()
  })
  it('points a non-legal entry to its own screen instead of editing it here', () => {
    wrap(
      <LegalDetailView result={{ kind: 'ok', data: doc({ type: 'FAQ' }) }} canWrite nowMs={NOW} />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('FAQ')
    expect(screen.getByRole('link', { name: 'Open it in FAQs' })).toHaveAttribute(
      'href',
      '/content/faqs/CB_abcdefghijklmnop',
    )
  })
})

describe('LegalEditor', () => {
  it('counts characters live and states that the text is plain paragraphs', async () => {
    const user = userEvent.setup()
    wrap(<LegalEditor />)
    expect(screen.getByText(/0 \/ 60,000 characters/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Text'), 'Hello')
    expect(screen.getByText(/5 \/ 60,000 characters/)).toBeInTheDocument()
    expect(screen.getByText(/shown to customers as plain paragraphs/)).toBeInTheDocument()
    expect(screen.getByLabelText('Effective date (optional)')).toBeInTheDocument()
  })
  it('validates locally (markup, empty title, no text) with no request', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    wrap(<LegalEditor />)
    await user.click(screen.getByRole('button', { name: 'Review new document' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Write the document text')
    expect(screen.getByRole('alert')).toHaveTextContent('Document title')
    await user.type(
      screen.getByLabelText('Document title (shown to customers as the heading)'),
      'T',
    )
    await user.type(screen.getByLabelText('Text'), 'a <b>x</b>')
    await user.click(screen.getByRole('button', { name: 'Review new document' }))
    expect(screen.getByRole('alert')).toHaveTextContent('cannot contain < or >')
    expect(f).not.toHaveBeenCalled()
  })
  it('creates a DRAFT with HELP/LEGAL fixed server-side and navigates to the new document', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { blockId: 'CB_newnewnewnewnewnew', status: 'DRAFT', version: 1 },
        }),
        { status: 200 },
      ),
    )
    wrap(<LegalEditor />)
    await user.selectOptions(screen.getByLabelText('Document'), 'PRIVACY')
    await user.type(
      screen.getByLabelText('Document title (shown to customers as the heading)'),
      'Privacy Policy',
    )
    await user.type(screen.getByLabelText('Text'), '  We keep little.')
    await user.type(screen.getByLabelText('Effective date (optional)'), '2026-10-01')
    await user.click(screen.getByRole('button', { name: 'Review new document' }))
    expect(dialog()).toHaveTextContent('not visible to customers until you publish')
    await confirmWith(user, 'Save')
    expect(f.mock.calls[0]![0]).toBe('/api/bff/content/legal')
    const body = JSON.parse(String(f.mock.calls[0]![1]?.body))
    expect(body).toEqual({
      title: 'Privacy Policy',
      sort: 0,
      payload: { legalSlug: 'PRIVACY', body: 'We keep little.', effectiveDate: '2026-10-01' },
    })
    expect(push).toHaveBeenCalledWith('/content/legal/CB_newnewnewnewnewnew')
  })
  it('editing a published document warns it changes the public page; cleared bounds and date are omitted', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    wrap(<LegalEditor block={clean({ startsAt: '2026-10-06T03:30:00Z' })} />)
    expect(screen.getByLabelText('Starts')).toHaveValue('2026-10-06T09:00')
    await user.clear(screen.getByLabelText('Starts'))
    await user.clear(screen.getByLabelText('Effective date (optional)'))
    await user.type(screen.getByLabelText('Text'), ' More.')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(dialog()).toHaveTextContent('PUBLISHED: your edit changes the public page')
    expect(dialog()).toHaveTextContent('up to a minute')
    await confirmWith(user, 'Save')
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('/api/bff/content/legal/CB_abcdefghijklmnop')
    const body = JSON.parse(String(init?.body))
    expect(body.expectedVersion).toBe(4)
    expect(body).not.toHaveProperty('startsAt')
    expect(body.payload).not.toHaveProperty('effectiveDate')
    expect(body).not.toHaveProperty('blockId')
  })
  it('keeps the typed text after a refused save (the one-live conflict) and offers an explicit reload', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'STATE_CONFLICT' } }), { status: 409 }),
    )
    wrap(<LegalEditor block={clean()} />)
    await user.type(screen.getByLabelText('Text'), ' Extra.')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    await confirmWith(user, 'Save')
    expect(await screen.findByText(/Your text is still here/)).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Text')).toHaveValue('One.\n\nTwo. Extra.')
    await user.click(screen.getByRole('button', { name: 'Reload the latest version' }))
    expect(refresh).toHaveBeenCalled()
  })
  const saveWith = async (status: number, body: unknown) => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }))
    wrap(<LegalEditor block={clean()} />)
    await user.type(screen.getByLabelText('Text'), ' Extra.')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    await confirmWith(user, 'Save')
  }
  it('a refused save for size says so specifically and keeps the text', async () => {
    await saveWith(413, { error: 'payload_too_large' })
    expect(
      await screen.findByText(/too large to save \(limit 60,000 characters \/ 256 KB\)/),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Text')).toHaveValue('One.\n\nTwo. Extra.')
  })
  it('tells another-document-published (STATE_CONFLICT) from someone-else-edited (STALE_VERSION)', async () => {
    await saveWith(409, { error: 'invalid_request', code: 'STATE_CONFLICT' })
    expect(
      await screen.findByText(/already published for an overlapping period/),
    ).toBeInTheDocument()
  })
  it('someone else edited (STALE_VERSION) has its own message', async () => {
    await saveWith(409, { error: 'invalid_request', code: 'STALE_VERSION' })
    expect(await screen.findByText(/Someone else changed this document/)).toBeInTheDocument()
  })
  it('a role the backend refuses (403) gets the existing forbidden message, not a silent failure', async () => {
    await saveWith(403, { error: 'forbidden' })
    expect(await screen.findByText(/Your role is not permitted to make this/)).toBeInTheDocument()
  })
  it('archived documents are read-only', () => {
    wrap(<LegalEditor block={doc({ status: 'ARCHIVED' })} />)
    expect(screen.getByText(/Archived documents are final/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull()
  })
})

describe('LegalStatusActions', () => {
  it('publish discloses the one-live rule and the delay, and posts the version', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    wrap(<LegalStatusActions blockId="CB_abcdefghijklmnop" status="DRAFT" version={2} />)
    await user.click(screen.getByRole('button', { name: 'Publish' }))
    expect(f).not.toHaveBeenCalled()
    expect(dialog()).toHaveTextContent('Only one document')
    expect(dialog()).toHaveTextContent('emergency unpublish')
    await confirmWith(user, 'Publish')
    expect(f.mock.calls[0]![0]).toBe('/api/bff/content/blocks/CB_abcdefghijklmnop/status')
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      to: 'PUBLISHED',
      expectedVersion: 2,
    })
  })
  it('unpublish warns the public page will show not found', async () => {
    const user = userEvent.setup()
    wrap(<LegalStatusActions blockId="CB_abcdefghijklmnop" status="PUBLISHED" version={4} />)
    await user.click(screen.getByRole('button', { name: 'Unpublish' }))
    expect(dialog()).toHaveTextContent('“not found”')
  })
  it('archived has no actions', () => {
    wrap(<LegalStatusActions blockId="CB_abcdefghijklmnop" status="ARCHIVED" version={4} />)
    expect(screen.getByText(/archived; it is final/)).toBeInTheDocument()
  })
})

describe('App config legal links helper', () => {
  it('says Terms and Privacy are managed under Legal and the URLs are optional overrides, keeping the fields', () => {
    wrap(
      <AppConfigForm
        config={{
          storeOpen: true,
          maintenance: false,
          maintenanceMessage: null,
          minAndroid: null,
          latestAndroid: null,
          minIos: null,
          latestIos: null,
          supportPhone: null,
          supportEmail: null,
          termsUrl: null,
          privacyUrl: null,
          refundPolicyUrl: null,
          version: 1,
        }}
      />,
    )
    expect(screen.getByRole('link', { name: 'Content → Legal' })).toHaveAttribute(
      'href',
      '/content/legal',
    )
    expect(screen.getByText(/optional external overrides/)).toBeInTheDocument()
    expect(screen.getByLabelText('Terms of service URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Privacy policy URL')).toBeInTheDocument()
  })
})
