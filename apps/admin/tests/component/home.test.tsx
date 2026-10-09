import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { HomeBlockEditor } from '@/components/home/HomeBlockEditor'
import { HomeBlockTable } from '@/components/home/HomeBlockTable'
import { PreviewFrame } from '@/components/home/HomePreviewView'
import { HomeDetailView, HomeListView } from '@/components/home/HomeViews'
import { ToastProvider } from '@/components/ui/Toast'
import type { HomeBlock, HomePreview } from '@/lib/home-content'
import { FakeXhr, PNG_HEAD, imageFile } from '../support/fake-xhr'

const refresh = vi.fn()
const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push }),
}))
beforeEach(() => {
  refresh.mockClear()
  push.mockClear()
  vi.restoreAllMocks()
  FakeXhr.reset()
})
const wrap = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>)
const NOW = Date.parse('2026-10-08T06:00:00Z')
const block = (over: Partial<HomeBlock>): HomeBlock => ({
  blockId: 'CB_aaaaaaaaaaaaaaaa',
  placement: 'HOME',
  type: 'BANNER',
  title: 'Mango season',
  sort: 10,
  status: 'PUBLISHED',
  effectiveStatus: 'LIVE',
  payload: { imageAssetKey: 'c/home/m.png', link: 'category:TZC-000001' },
  audience: 'BOTH',
  imageUrl: 'https://cdn.tazzzo.com/c/home/m.png',
  version: 2,
  createdBy: 'google:111',
  updatedBy: 'google:222',
  updatedAt: '2026-10-08T03:30:00Z',
  ...over,
})
const BLOCKS = [
  block({}),
  block({
    blockId: 'CB_bbbbbbbbbbbbbbbb',
    type: 'PRODUCT_RAIL',
    title: 'Bestsellers',
    sort: 20,
    status: 'DRAFT',
    effectiveStatus: 'DRAFT',
    audience: 'APP_ONLY',
    payload: { ids: ['TZP-1'] },
    version: 5,
  }),
  block({
    blockId: 'CB_cccccccccccccccc',
    type: 'CATEGORY_GRID',
    title: 'Shop by category',
    sort: 30,
    effectiveStatus: 'SCHEDULED',
    audience: 'WEB_ONLY',
    startsAt: '2026-10-09T03:30:00Z',
    endsAt: '2026-10-10T03:30:00Z',
    payload: { ids: ['TZC-000001'] },
    version: 1,
  }),
  block({
    blockId: 'CB_dddddddddddddddd',
    title: 'Old offer',
    sort: 40,
    status: 'ARCHIVED',
    effectiveStatus: 'ARCHIVED',
    version: 9,
  }),
]
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
const fail = (status: number, code?: string) =>
  new Response(JSON.stringify({ error: 'x', ...(code ? { code } : {}) }), { status })
const dialog = () => screen.getByRole('dialog', { hidden: true })
const confirmIn = (name: string) => within(dialog()).getByRole('button', { name, hidden: true })
const bodies = (f: MockInstance, path: string) =>
  f.mock.calls
    .filter((c) => c[0] === path)
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)))

describe('Home list', () => {
  it('shows type, channel, effective status, IST schedule and authorship', () => {
    wrap(
      <HomeListView
        result={{ kind: 'ok', data: { items: BLOCKS } }}
        filter={{}}
        canWrite
        nowMs={NOW}
      />,
    )
    const rows = within(screen.getByRole('region', { name: 'Home blocks' })).getAllByRole('row')
    expect(rows[1]).toHaveTextContent(/Mango season.*Banner.*Both.*Live.*Always/)
    expect(rows[2]).toHaveTextContent(/Bestsellers.*Product rail.*App.*Draft/)
    expect(rows[3]).toHaveTextContent(
      /Shop by category.*Category grid.*Website.*Scheduled.*9 Oct 2026, 9:00 am → 10 Oct 2026, 9:00 am IST/,
    )
    expect(rows[4]).toHaveTextContent(/Old offer.*Archived/)
    expect(rows[1]).toHaveTextContent(/by google:111.*last google:222/)
    expect(screen.getByRole('link', { name: 'New banner' })).toHaveAttribute(
      'href',
      '/content/home/new?type=BANNER',
    )
  })
  it('gives a reader the table and preview only: no create, reorder or edit controls', () => {
    wrap(
      <HomeListView
        result={{ kind: 'ok', data: { items: BLOCKS } }}
        filter={{}}
        canWrite={false}
        nowMs={NOW}
      />,
    )
    expect(screen.getByRole('note')).toHaveTextContent('Read-only')
    expect(screen.queryByRole('button', { name: 'Reorder' })).toBeNull()
    expect(screen.queryByRole('link', { name: /New / })).toBeNull()
    expect(screen.getByRole('link', { name: 'Preview' })).toBeInTheDocument()
  })
  it('shows empty and failure states', () => {
    const { rerender } = wrap(
      <HomeListView
        result={{ kind: 'ok', data: { items: [] } }}
        filter={{}}
        canWrite
        nowMs={NOW}
      />,
    )
    expect(screen.getByText('No Home blocks')).toBeInTheDocument()
    rerender(
      <ToastProvider>
        <HomeListView
          result={{ kind: 'unavailable', reason: 'timeout' }}
          filter={{}}
          canWrite
          nowMs={NOW}
        />
      </ToastProvider>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('took too long')
  })
})

describe('reorder', () => {
  it('moves with the keyboard, keeps focus and announces, then saves ONE call with every active block', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ count: 3 }))
    wrap(<HomeBlockTable blocks={BLOCKS} canWrite nowMs={NOW} filtered={false} />)
    await user.click(screen.getByRole('button', { name: 'Reorder' }))
    expect(screen.queryByRole('button', { name: 'Move Old offer up' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Move Mango season up' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Move Shop by category up' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move Shop by category up' })).toHaveFocus(),
    )
    expect(screen.getByText('Shop by category moved to position 2 of 3.')).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(screen.getByText('Shop by category moved to position 1 of 3.')).toBeInTheDocument()
    // At the top edge focus moves to the control that still works.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move Shop by category down' })).toHaveFocus(),
    )
    await user.click(screen.getByRole('button', { name: 'Save order' }))
    expect(dialog()).toHaveTextContent('all 3 active Home blocks')
    await user.click(confirmIn('Save order'))
    expect(bodies(f, '/api/bff/content/home/reorder')).toEqual([
      {
        order: [
          { blockId: 'CB_cccccccccccccccc', expectedVersion: 1 },
          { blockId: 'CB_aaaaaaaaaaaaaaaa', expectedVersion: 2 },
          { blockId: 'CB_bbbbbbbbbbbbbbbb', expectedVersion: 5 },
        ],
      },
    ])
  })
  it('a conflict keeps the new order and offers a reload', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(409, 'STALE_VERSION'))
    wrap(<HomeBlockTable blocks={BLOCKS} canWrite nowMs={NOW} filtered={false} />)
    await user.click(screen.getByRole('button', { name: 'Reorder' }))
    await user.click(screen.getByRole('button', { name: 'Move Bestsellers up' }))
    await user.click(screen.getByRole('button', { name: 'Save order' }))
    await user.click(confirmIn('Save order'))
    expect(await screen.findByText(/new order was not saved/)).toBeInTheDocument()
    const rows = within(screen.getByRole('region', { name: 'Home blocks' })).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('Bestsellers')
    expect(refresh).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Reload latest version' }))
    expect(refresh).toHaveBeenCalled()
  })
  it('refuses to save an order when the list was refreshed mid-session, and can start again', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    const { rerender } = wrap(
      <HomeBlockTable blocks={BLOCKS} canWrite nowMs={NOW} filtered={false} />,
    )
    await user.click(screen.getByRole('button', { name: 'Reorder' }))
    await user.click(screen.getByRole('button', { name: 'Move Bestsellers up' }))
    const refreshed = BLOCKS.map((b) =>
      b.blockId === 'CB_aaaaaaaaaaaaaaaa' ? { ...b, version: 3 } : b,
    )
    rerender(
      <ToastProvider>
        <HomeBlockTable blocks={refreshed} canWrite nowMs={NOW} filtered={false} />
      </ToastProvider>,
    )
    expect(screen.getByText(/The list was refreshed while you were reordering/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save order' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Start again' }))
    expect(screen.queryByText(/The list was refreshed/)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Move Bestsellers up' }))
    f.mockResolvedValue(ok({ count: 3 }))
    await user.click(screen.getByRole('button', { name: 'Save order' }))
    await user.click(confirmIn('Save order'))
    expect(bodies(f, '/api/bff/content/home/reorder')[0].order[1]).toEqual({
      blockId: 'CB_aaaaaaaaaaaaaaaa',
      expectedVersion: 3,
    })
  })
  it('is not offered on a filtered (partial) list', () => {
    wrap(<HomeBlockTable blocks={BLOCKS} canWrite nowMs={NOW} filtered />)
    expect(screen.getByRole('button', { name: 'Reorder' })).toBeDisabled()
    expect(screen.getByText('Clear the filters to reorder.')).toBeInTheDocument()
  })
})

describe('banner editor', () => {
  const target = {
    assetKey: 'c/home/9f.png',
    method: 'PUT',
    url: 'https://tazzzo-media.s3.ap-south-1.amazonaws.com/c/home/9f.png?X-Amz-Signature=s',
    headers: { 'Content-Type': 'image/png', 'Content-Length': '32', 'If-None-Match': '*' },
    expiresAt: null,
    maxBytes: 5242880,
  }
  it('validates locally: required image, link grammar, invisible characters, schedule order', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    wrap(<HomeBlockEditor type="BANNER" createXhr={FakeXhr.factory} />)
    await user.type(screen.getByLabelText(/^Title/), 'Mango season')
    await user.selectOptions(screen.getByLabelText('Link type'), 'search')
    await user.type(screen.getByLabelText('Search text'), 'mango!')
    await user.click(screen.getByLabelText(/^Subtitle/))
    await user.paste('Sale ‮05')
    await user.type(screen.getByLabelText('Starts (IST)'), '2026-10-09T10:00')
    await user.type(screen.getByLabelText('Ends (IST)'), '2026-10-09T09:00')
    await user.click(screen.getByRole('button', { name: 'Review new draft' }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Upload the mobile (app) image.')
    expect(alert).toHaveTextContent('no punctuation')
    expect(alert).toHaveTextContent('invisible or direction-control characters')
    expect(alert).toHaveTextContent('The end time must be after the start time.')
    await waitFor(() => expect(alert).toHaveFocus())
    expect(f).not.toHaveBeenCalled()
  })

  it('uploads the image to storage with progress and creates a DRAFT with link, channel and IST schedule', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) =>
        input === '/api/bff/content/home/uploads'
          ? ok(target)
          : ok({ blockId: 'CB_newnewnewnewnewne', status: 'DRAFT', version: 1 }),
      )
    wrap(<HomeBlockEditor type="BANNER" createXhr={FakeXhr.factory} />)
    await user.type(screen.getByLabelText(/^Title/), 'Mango season')
    await user.click(screen.getByLabelText('App'))
    await user.upload(
      screen.getByLabelText('Mobile image'),
      imageFile('m.png', 'image/png', PNG_HEAD),
    )
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    expect(bodies(f, '/api/bff/content/home/uploads')).toEqual([
      { contentType: 'image/png', sizeBytes: 32 },
    ])
    FakeXhr.last().progress(32, 32)
    FakeXhr.last().respond(200)
    expect(await screen.findByText(/Uploaded m.png/)).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Link type'), 'search')
    await user.type(screen.getByLabelText('Search text'), 'ताज़ा आम')
    expect(screen.getByText('search:ताज़ा आम')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Starts (IST)'), '2026-10-09T09:00')
    await user.click(screen.getByRole('button', { name: 'Review new draft' }))
    expect(dialog()).toHaveTextContent('created as a draft')
    await user.click(confirmIn('Save'))
    expect(bodies(f, '/api/bff/content/home/blocks')).toEqual([
      {
        type: 'BANNER',
        title: 'Mango season',
        sort: 0,
        audience: 'APP_ONLY',
        startsAt: '2026-10-09T03:30:00.000Z',
        payload: { imageAssetKey: 'c/home/9f.png', link: 'search:ताज़ा आम' },
      },
    ])
    await waitFor(() => expect(push).toHaveBeenCalledWith('/content/home/CB_newnewnewnewnewne'))
  })

  it('edits keep the version, never send type/placement, and a conflict keeps the edits', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(409, 'STALE_VERSION'))
    wrap(<HomeBlockEditor type="BANNER" block={BLOCKS[0]} />)
    await user.clear(screen.getByLabelText(/^Title/))
    await user.type(screen.getByLabelText(/^Title/), 'Mango festival')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(dialog()).toHaveTextContent('PUBLISHED: your edit changes what customers see on Both')
    await user.click(confirmIn('Save'))
    const [body] = bodies(f, `/api/bff/content/home/blocks/CB_aaaaaaaaaaaaaaaa`)
    expect(body).toMatchObject({
      title: 'Mango festival',
      expectedVersion: 2,
      audience: 'BOTH',
      payload: { imageAssetKey: 'c/home/m.png', link: 'category:TZC-000001' },
    })
    expect(await screen.findByText(/This block changed since you loaded it/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Mango festival')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('an untouched schedule keeps its exact instant (seconds are not truncated)', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ version: 3 }))
    const timed = block({
      startsAt: '2026-10-09T03:30:42.123Z',
      endsAt: '2026-10-10T03:30:15Z',
    })
    wrap(<HomeBlockEditor type="BANNER" block={timed} />)
    await user.type(screen.getByLabelText(/^Subtitle/), 'Fresh')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    await user.click(confirmIn('Save'))
    expect(bodies(f, '/api/bff/content/home/blocks/CB_aaaaaaaaaaaaaaaa')[0]).toMatchObject({
      startsAt: '2026-10-09T03:30:42.123Z',
      endsAt: '2026-10-10T03:30:15Z',
    })
  })

  it('a duplicate starts as a new draft with the same content', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok({ blockId: 'CB_copycopycopycopyco', status: 'DRAFT', version: 1 }))
    wrap(<HomeBlockEditor type="BANNER" template={BLOCKS[0]} />)
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Copy of Mango season')
    await user.click(screen.getByRole('button', { name: 'Review new draft' }))
    await user.click(confirmIn('Save'))
    const [body] = bodies(f, '/api/bff/content/home/blocks')
    expect(body).toMatchObject({
      type: 'BANNER',
      title: 'Copy of Mango season',
      payload: { imageAssetKey: 'c/home/m.png', link: 'category:TZC-000001' },
    })
    expect(body).not.toHaveProperty('expectedVersion')
  })
})

describe('rail and grid editors', () => {
  it('bounds and validates ids before any request', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    wrap(<HomeBlockEditor type="CATEGORY_GRID" />)
    await user.type(screen.getByLabelText(/^Title/), 'Shop by category')
    await user.type(screen.getByLabelText(/Category node ids/), 'TZC-000001, TZP-1')
    await user.click(screen.getByRole('button', { name: 'Review new draft' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Not a valid category id: TZP-1.')
    expect(f).not.toHaveBeenCalled()
  })
  it('sends a product rail with its ids', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok({ blockId: 'CB_railrailrailrailra', status: 'DRAFT', version: 1 }))
    wrap(<HomeBlockEditor type="PRODUCT_RAIL" />)
    await user.type(screen.getByLabelText(/^Title/), 'Bestsellers')
    await user.type(screen.getByLabelText(/Product ids/), 'TZP-1\nTZP-2')
    await user.click(screen.getByLabelText('Website'))
    await user.click(screen.getByRole('button', { name: 'Review new draft' }))
    await user.click(confirmIn('Save'))
    expect(bodies(f, '/api/bff/content/home/blocks')[0]).toEqual({
      type: 'PRODUCT_RAIL',
      title: 'Bestsellers',
      sort: 0,
      audience: 'WEB_ONLY',
      payload: { ids: ['TZP-1', 'TZP-2'] },
    })
  })
})

describe('detail view', () => {
  it('writers get publish/unpublish/archive with confirmation and a duplicate link', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ version: 3 }))
    wrap(<HomeDetailView result={{ kind: 'ok', data: BLOCKS[0]! }} canWrite nowMs={NOW} />)
    expect(screen.getByRole('link', { name: 'Duplicate as new draft' })).toHaveAttribute(
      'href',
      '/content/home/new?type=BANNER&from=CB_aaaaaaaaaaaaaaaa',
    )
    await user.click(screen.getByRole('button', { name: 'Unpublish' }))
    const d = screen.getByRole('dialog', { name: /Unpublish/, hidden: true })
    expect(d).toHaveTextContent('returns to draft and is removed from Both')
    await user.click(within(d).getByRole('button', { name: 'Unpublish', hidden: true }))
    expect(bodies(f, '/api/bff/content/blocks/CB_aaaaaaaaaaaaaaaa/status')).toEqual([
      { to: 'DRAFT', expectedVersion: 2 },
    ])
  })
  it('readers see the content read-only, with no mutation controls', () => {
    wrap(<HomeDetailView result={{ kind: 'ok', data: BLOCKS[0]! }} canWrite={false} nowMs={NOW} />)
    expect(screen.getByRole('note')).toHaveTextContent('Read-only')
    expect(screen.queryByRole('button', { name: /Publish|Unpublish|Archive|Review/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /Duplicate/ })).toBeNull()
    expect(screen.queryByLabelText(/Mobile image/)).toBeNull()
    expect(screen.getByText('category:TZC-000001')).toBeInTheDocument()
  })
  it('text from the backend stays inert (no HTML rendering)', () => {
    wrap(
      <HomeDetailView
        result={{
          kind: 'ok',
          data: block({ title: '<img src=x onerror=alert(1)>' }),
        }}
        canWrite={false}
        nowMs={NOW}
      />,
    )
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      '<img src=x onerror=alert(1)>',
    )
    expect(document.querySelector('img[src="x"]')).toBeNull()
  })
})

describe('preview rendering per channel', () => {
  const preview = (channel: string): HomePreview => ({
    channel,
    at: '2026-10-08T06:00:00Z',
    includeDrafts: true,
    blocks: [
      {
        blockId: 'CB_aaaaaaaaaaaaaaaa',
        type: 'BANNER',
        title: 'Mango season',
        subtitle: 'Fresh',
        altText: 'Mangoes',
        imageUrl: 'https://cdn/m.png',
        desktopImageUrl: 'https://cdn/d.png',
        link: 'search:mango',
        status: 'PUBLISHED',
        effectiveStatus: 'LIVE',
        audience: 'BOTH',
      },
      {
        blockId: 'CB_bbbbbbbbbbbbbbbb',
        type: 'PRODUCT_RAIL',
        title: 'Bestsellers',
        ids: ['TZP-1', 'TZP-2'],
        status: 'DRAFT',
        effectiveStatus: 'DRAFT',
        audience: 'APP_ONLY',
      },
    ],
  })
  const windows = new Map([['CB_aaaaaaaaaaaaaaaa', { startsAt: '2026-10-08T03:30:00Z' }]])
  it('app: phone frame, mobile image at the app banner ratio, order, state, channel and schedule', () => {
    render(<PreviewFrame view="app" preview={preview('app')} windows={windows} />)
    const frame = document.querySelector('[data-view="app"]')!
    expect(frame).toHaveClass('phone-frame')
    const img = within(frame as HTMLElement).getByRole('img', { name: 'Mangoes' })
    expect(img).toHaveAttribute('src', 'https://cdn/m.png')
    expect(img.parentElement).toHaveClass('banner-app')
    const items = within(frame as HTMLElement).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent(/#1.*Live.*Banner.*Both.*8 Oct 2026, 9:00 am → no end IST/)
    expect(items[0]).toHaveTextContent('Opens search:mango')
    expect(screen.getByText('Draft (preview only)')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('IST')
  })
  it('website desktop: browser frame and the wide desktop image', () => {
    render(<PreviewFrame view="web-desktop" preview={preview('web')} windows={windows} />)
    const frame = document.querySelector('[data-view="web-desktop"]') as HTMLElement
    expect(frame).toHaveClass('browser-frame')
    expect(frame).not.toHaveClass('browser-mobile')
    const img = within(frame).getByRole('img', { name: 'Mangoes' })
    expect(img).toHaveAttribute('src', 'https://cdn/d.png')
    expect(img.parentElement).toHaveClass('banner-web-3x1')
  })
  it('website desktop: a carousel where one banner lacks a desktop image stays 16:9 for every banner', () => {
    const p = preview('web')
    const second = {
      ...p.blocks[0]!,
      blockId: 'CB_eeeeeeeeeeeeeeee',
      title: 'Monsoon',
      altText: 'Rain',
      desktopImageUrl: null,
    }
    render(
      <PreviewFrame
        view="web-desktop"
        preview={{ ...p, blocks: [p.blocks[0]!, second] }}
        windows={windows}
      />,
    )
    const first = screen.getByRole('img', { name: 'Mangoes' })
    expect(first).toHaveAttribute('src', 'https://cdn/d.png')
    expect(first.parentElement).toHaveAttribute('data-crop', 'web-16x9')
    const other = screen.getByRole('img', { name: 'Rain' })
    expect(other).toHaveAttribute('src', 'https://cdn/m.png')
    expect(other.parentElement).toHaveAttribute('data-crop', 'web-16x9')
    expect(screen.getAllByText(/16:9 because not every banner in this carousel/)).toHaveLength(2)
  })
  it('website mobile: narrow browser frame and the mobile image', () => {
    render(<PreviewFrame view="web-mobile" preview={preview('web')} windows={windows} />)
    const frame = document.querySelector('[data-view="web-mobile"]') as HTMLElement
    expect(frame).toHaveClass('browser-mobile')
    const img = within(frame).getByRole('img', { name: 'Mangoes' })
    expect(img).toHaveAttribute('src', 'https://cdn/m.png')
    expect(img.parentElement).toHaveAttribute('data-crop', 'web-16x9')
  })
  it('an empty Home says so', () => {
    render(
      <PreviewFrame view="app" preview={{ ...preview('app'), blocks: [] }} windows={new Map()} />,
    )
    expect(screen.getByText('Nothing to show')).toBeInTheDocument()
  })
})
