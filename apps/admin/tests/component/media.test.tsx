import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaSetEditor } from '@/components/media/MediaSetEditor'
import { MediaView } from '@/components/media/MediaView'
import { UploadReadiness } from '@/components/media/UploadReadiness'
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
const set = {
  ownerType: 'product',
  ownerId: 'TZP-1',
  version: 3,
  active: true,
  assets: [
    {
      assetId: 'A1',
      assetKey: 'p/product/tzp-1/a.jpg',
      role: 'PRIMARY',
      sortOrder: 0,
      altText: 'Front',
      width: 800,
      height: 800,
      contentType: 'image/jpeg',
    },
    {
      assetId: 'A2',
      assetKey: 'p/product/tzp-1/b.png',
      role: 'GALLERY',
      sortOrder: 1,
      altText: null,
    },
  ],
}

describe('MediaView', () => {
  it('warns that listed images are unverified without storage, and offers no preview', () => {
    wrap(
      <MediaView
        owner={{ type: 'product', id: 'TZP-1' }}
        result={{ kind: 'ok', data: set }}
        canWrite={false}
      />,
    )
    expect(screen.getAllByRole('note')[0]).toHaveTextContent('without checking they exist')
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText(/no alt text/)).toBeInTheDocument()
  })
  it('shows no-set, permission and invalid-input states', () => {
    const { rerender } = wrap(
      <MediaView
        owner={{ type: 'product', id: 'TZP-1' }}
        result={{ kind: 'not_found' }}
        canWrite
      />,
    )
    expect(screen.getByText(/has no media set/)).toBeInTheDocument()
    rerender(
      <ToastProvider>
        <MediaView
          owner={{ type: 'product', id: 'TZP-1' }}
          result={{ kind: 'forbidden' }}
          canWrite={false}
        />
      </ToastProvider>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Not permitted')
    rerender(
      <ToastProvider>
        <MediaView canWrite invalidInput />
      </ToastProvider>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('TZP-1001')
  })
})

describe('MediaSetEditor', () => {
  it('validates the primary rule and alt text locally, with no request', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    wrap(<MediaSetEditor ownerType="product" ownerId="TZP-1" set={set} />)
    await user.clear(screen.getByLabelText('Order for A1'))
    await user.type(screen.getByLabelText('Order for A1'), '4')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByRole('alert')).toHaveTextContent('primary image must have order 0')
    await user.clear(screen.getByLabelText('Order for A1'))
    await user.type(screen.getByLabelText('Order for A1'), '0')
    await user.type(screen.getByLabelText('Alt text for A2'), '<script>')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByRole('alert')).toHaveTextContent('300 characters or fewer')
    expect(f).not.toHaveBeenCalled()
  })
  it('sends the whole set with the loaded version, drops removed assets, never adds keys', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: { version: 4 } }), { status: 200 }))
    wrap(<MediaSetEditor ownerType="product" ownerId="TZP-1" set={set} />)
    await user.type(screen.getByLabelText('Alt text for A2'), 'Side view')
    await user.click(screen.getByLabelText('Remove A1'))
    await user.click(screen.getByLabelText('Role for A2'))
    await user.selectOptions(screen.getByLabelText('Role for A2'), 'PRIMARY')
    await user.clear(screen.getByLabelText('Order for A2'))
    await user.type(screen.getByLabelText('Order for A2'), '0')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByRole('dialog', { hidden: true })).toHaveTextContent('1 removed from the set')
    await user.click(
      within(screen.getByRole('dialog', { hidden: true })).getByRole('button', {
        name: 'Save media',
        hidden: true,
      }),
    )
    expect(f.mock.calls[0]![0]).toBe('/api/bff/media/product/TZP-1')
    const body = JSON.parse(String(f.mock.calls[0]![1]?.body))
    expect(body.expectedVersion).toBe(3)
    expect(body.assets).toEqual([
      {
        assetId: 'A2',
        assetKey: 'p/product/tzp-1/b.png',
        role: 'PRIMARY',
        sortOrder: 0,
        altText: 'Side view',
      },
    ])
  })
})

describe('UploadReadiness', () => {
  const pick = async (user: ReturnType<typeof userEvent.setup>, file: File) =>
    user.upload(screen.getByLabelText('Image file'), file)
  it('rejects a bad file locally and never calls the backend', async () => {
    const user = userEvent.setup({ applyAccept: false })
    const f = vi.spyOn(globalThis, 'fetch')
    wrap(<UploadReadiness ownerType="product" ownerId="TZP-1" />)
    await pick(user, new File(['x'], 'a.gif', { type: 'image/gif' }))
    expect(screen.getByRole('alert')).toHaveTextContent('JPEG, PNG or WebP')
    expect(screen.getByRole('button', { name: 'Check upload readiness' })).toBeDisabled()
    expect(f).not.toHaveBeenCalled()
  })
  it('reports the storage blocker honestly and never claims an upload', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'upstream_error', code: 'MEDIA_STORAGE_NOT_CONFIGURED' }),
          { status: 502 },
        ),
      )
    wrap(<UploadReadiness ownerType="product" ownerId="TZP-1" />)
    await pick(user, new File(['abc'], 'a.png', { type: 'image/png' }))
    await user.click(screen.getByRole('button', { name: 'Check upload readiness' }))
    expect(await screen.findByText(/no media storage provider is configured/)).toBeInTheDocument()
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      ownerType: 'product',
      ownerId: 'TZP-1',
      contentType: 'image/png',
      sizeBytes: 3,
    })
    expect(screen.queryByText(/uploaded successfully|upload complete/i)).toBeNull()
  })
  it('even when the backend could issue a target, says nothing was uploaded', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { ready: true } }), { status: 200 }),
    )
    wrap(<UploadReadiness ownerType="product" ownerId="TZP-1" />)
    await pick(user, new File(['abc'], 'a.png', { type: 'image/png' }))
    await user.click(screen.getByRole('button', { name: 'Check upload readiness' }))
    expect(await screen.findByText(/nothing was uploaded/)).toBeInTheDocument()
  })
})
