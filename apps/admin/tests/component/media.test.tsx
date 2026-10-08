import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { MediaSetEditor } from '@/components/media/MediaSetEditor'
import { MediaView } from '@/components/media/MediaView'
import { ToastProvider } from '@/components/ui/Toast'
import { forgetMaxBytes } from '@/lib/upload'
import { FakeXhr, JPEG_HEAD, PNG_HEAD, imageFile } from '../support/fake-xhr'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}))
beforeEach(() => {
  refresh.mockClear()
  vi.restoreAllMocks()
  FakeXhr.reset()
  forgetMaxBytes()
})
const wrap = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>)
const K1 = 'p/product/tzp-1/a.jpg'
const K2 = 'p/product/tzp-1/b.png'
const set = {
  ownerType: 'product',
  ownerId: 'TZP-1',
  version: 3,
  active: true,
  assets: [
    {
      assetId: 'A1',
      assetKey: K1,
      role: 'PRIMARY',
      sortOrder: 0,
      altText: 'Front',
      width: 800,
      height: 800,
      contentType: 'image/jpeg',
      url: 'https://cdn.tazzzo.com/p/product/tzp-1/a.jpg',
    },
    { assetId: 'A2', assetKey: K2, role: 'GALLERY', sortOrder: 1, altText: null },
  ],
}
const NEW_KEY = 'p/product/TZP-1/9f2c.png'
const target = (key = NEW_KEY) => ({
  assetKey: key,
  method: 'PUT',
  url: `https://tazzzo-media.s3.ap-south-1.amazonaws.com/${key}?X-Amz-Signature=s`,
  headers: { 'Content-Type': 'image/png', 'Content-Length': '32', 'If-None-Match': '*' },
  expiresAt: '2026-10-08T10:05:00Z',
  maxBytes: 5242880,
})
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
const fail = (status: number, code?: string) =>
  new Response(JSON.stringify({ error: 'x', ...(code ? { code } : {}) }), { status })
const png = () => imageFile('front.png', 'image/png', PNG_HEAD)
const editor = () => (
  <MediaSetEditor ownerType="product" ownerId="TZP-1" set={set} createXhr={FakeXhr.factory} />
)
const dialog = () => screen.getByRole('dialog', { hidden: true })
const saveButton = () => within(dialog()).getByRole('button', { name: 'Save media', hidden: true })
const bodies = (f: MockInstance, path: string) =>
  f.mock.calls
    .filter((c) => c[0] === path)
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)))

describe('MediaView', () => {
  it('shows backend thumbnails, a neutral placeholder without a URL, and is read-only for readers', () => {
    wrap(
      <MediaView
        owner={{ type: 'product', id: 'TZP-1' }}
        result={{ kind: 'ok', data: set }}
        canWrite={false}
      />,
    )
    const imgs = document.querySelectorAll('img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0]!.getAttribute('src')).toBe('https://cdn.tazzzo.com/p/product/tzp-1/a.jpg')
    expect(screen.getByText('No preview')).toBeInTheDocument()
    expect(screen.getByText(/no alt text/)).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('Read-only')
    expect(screen.queryByLabelText('Image file')).toBeNull()
    expect(screen.queryByRole('button', { name: /Review|Replace/ })).toBeNull()
  })
  it('lets a writer create a set for an owner that has none', () => {
    wrap(
      <MediaView
        owner={{ type: 'product', id: 'TZP-1' }}
        result={{ kind: 'not_found' }}
        canWrite
      />,
    )
    expect(screen.getByText(/has no media set/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Create the media set' })).toBeInTheDocument()
    expect(screen.getByLabelText('Image file')).toBeInTheDocument()
  })
  it('shows permission and invalid-input states', () => {
    const { rerender } = wrap(
      <MediaView
        owner={{ type: 'product', id: 'TZP-1' }}
        result={{ kind: 'forbidden' }}
        canWrite={false}
      />,
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

describe('MediaSetEditor: metadata', () => {
  it('labels controls by asset key and validates locally (primary rule, alt-text control characters)', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    wrap(editor())
    await user.clear(screen.getByLabelText(`Order for ${K1}`))
    await user.type(screen.getByLabelText(`Order for ${K1}`), '4')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByRole('alert')).toHaveTextContent('primary image must have order 0')
    await user.clear(screen.getByLabelText(`Order for ${K1}`))
    await user.type(screen.getByLabelText(`Order for ${K1}`), '0')
    // A control character in the middle (pasted text) is refused, as the backend would.
    await user.click(screen.getByLabelText(`Alt text for ${K2}`))
    await user.paste('Side\u0007view')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(screen.getByRole('alert')).toHaveTextContent('no control characters')
    expect(f).not.toHaveBeenCalled()
  })

  it('saves the whole set with the loaded version and drops removed assets', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok({ version: 4 }))
    wrap(editor())
    await user.type(screen.getByLabelText(`Alt text for ${K2}`), 'Side view')
    await user.click(screen.getByLabelText(`Remove ${K1}`))
    await user.selectOptions(screen.getByLabelText(`Role for ${K2}`), 'PRIMARY')
    await user.clear(screen.getByLabelText(`Order for ${K2}`))
    await user.type(screen.getByLabelText(`Order for ${K2}`), '0')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(dialog()).toHaveTextContent('1 removed from the set')
    await user.click(saveButton())
    const [body] = bodies(f, '/api/bff/media/product/TZP-1')
    expect(body.expectedVersion).toBe(3)
    expect(body.assets).toEqual([
      { assetId: 'A2', assetKey: K2, role: 'PRIMARY', sortOrder: 0, altText: 'Side view' },
    ])
    await waitFor(() => expect(dialog()).not.toHaveAttribute('open'))
  })

  it('a version conflict keeps the edits on screen and offers an explicit reload', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(409, 'STALE_VERSION'))
    wrap(editor())
    await user.type(screen.getByLabelText(`Alt text for ${K2}`), 'Side view')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    await user.click(saveButton())
    const alert = await screen.findByText(/Someone else changed this media set/)
    expect(alert.closest('[role="alert"]')).not.toBeNull()
    expect(screen.getByLabelText(`Alt text for ${K2}`)).toHaveValue('Side view')
    expect(dialog()).not.toHaveAttribute('open')
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Review changes' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reload latest version' }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('any other failure keeps the dialog open and says why (never closes silently)', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(422, 'INVALID_MEDIA'))
    wrap(editor())
    await user.type(screen.getByLabelText(`Alt text for ${K2}`), 'Side view')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    await user.click(saveButton())
    expect(
      await within(dialog()).findByText(/missing from storage/, undefined, {}),
    ).toBeInTheDocument()
    expect(dialog()).toHaveAttribute('open')
  })
})

describe('MediaSetEditor: upload', () => {
  it('uploads straight to storage with progress, adds the image, and saves it with role, alt and order', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) =>
        input === '/api/bff/media/uploads' ? ok(target()) : ok({ version: 4 }),
      )
    wrap(editor())
    await user.upload(screen.getByLabelText('Image file'), png())
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    expect(bodies(f, '/api/bff/media/uploads')).toEqual([
      { ownerType: 'product', ownerId: 'TZP-1', contentType: 'image/png', sizeBytes: 32 },
    ])
    const x = FakeXhr.last()
    expect(x.method).toBe('PUT')
    expect(x.url).toBe(target().url)
    expect(x.withCredentials).toBe(false)
    expect(x.headers).toEqual({ 'Content-Type': 'image/png', 'If-None-Match': '*' })
    x.progress(16, 32)
    expect(await screen.findByRole('progressbar', { name: 'Uploading front.png' })).toHaveAttribute(
      'value',
      '50',
    )
    x.respond(200)
    expect(await screen.findByLabelText(`Alt text for ${NEW_KEY}`)).toBeInTheDocument()
    expect(screen.getByLabelText(`Order for ${NEW_KEY}`)).toHaveValue('2')
    await user.type(screen.getByLabelText(`Alt text for ${NEW_KEY}`), 'Pack front')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(dialog()).toHaveTextContent('3 images will remain, 1 added')
    await user.click(saveButton())
    const [body] = bodies(f, '/api/bff/media/product/TZP-1')
    expect(body.expectedVersion).toBe(3)
    expect(body.assets[2]).toMatchObject({
      assetKey: NEW_KEY,
      role: 'GALLERY',
      sortOrder: 2,
      altText: 'Pack front',
      contentType: 'image/png',
    })
    expect(body.assets[2].assetId).toMatch(/^img-/)
  })

  it('a used (412) or refused (403) upload link fails visibly; Retry requests a FRESH link', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok(target()))
    wrap(editor())
    await user.upload(screen.getByLabelText('Image file'), png())
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    FakeXhr.last().respond(412)
    expect(await screen.findByText(/already used/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry upload' }))
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(2))
    FakeXhr.last().respond(403)
    expect(await screen.findByText(/link expired or the request did not match/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry upload' }))
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(3))
    FakeXhr.last().respond(200)
    expect(await screen.findByLabelText(`Alt text for ${NEW_KEY}`)).toBeInTheDocument()
    expect(bodies(f, '/api/bff/media/uploads')).toHaveLength(3)
  })

  it('names a storage outage (retryable) and storage switched off (not retryable)', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(fail(502, 'MEDIA_STORAGE_UNAVAILABLE'))
    wrap(editor())
    await user.upload(screen.getByLabelText('Image file'), png())
    expect(await screen.findByText(/storage is unavailable right now/)).toBeInTheDocument()
    f.mockResolvedValueOnce(fail(502, 'MEDIA_STORAGE_NOT_CONFIGURED'))
    await user.click(screen.getByRole('button', { name: 'Retry upload' }))
    expect(await screen.findByText(/no media storage is configured/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry upload' })).toBeNull()
    expect(FakeXhr.instances).toHaveLength(0)
  })

  it('refuses SVG and spoofed files locally: no target request, no bytes sent', async () => {
    const user = userEvent.setup({ applyAccept: false })
    const f = vi.spyOn(globalThis, 'fetch')
    wrap(editor())
    await user.upload(
      screen.getByLabelText('Image file'),
      new File(['<svg onload="x"/>'], 'logo.svg', { type: 'image/svg+xml' }),
    )
    expect(await screen.findByText(/SVG images are not accepted/)).toBeInTheDocument()
    await user.upload(
      screen.getByLabelText('Image file'),
      imageFile('a.png', 'image/png', JPEG_HEAD),
    )
    expect(await screen.findByText(/labelled PNG but its contents are JPEG/)).toBeInTheDocument()
    expect(f).not.toHaveBeenCalled()
    expect(FakeXhr.instances).toHaveLength(0)
  })

  it('replaces an image: new upload, same slot and asset id, new key', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) =>
        input === '/api/bff/media/uploads' ? ok(target()) : ok({ version: 4 }),
      )
    wrap(editor())
    await user.click(screen.getByRole('button', { name: `Replace ${K2}` }))
    await user.upload(screen.getByLabelText(`Replacement image for ${K2}`), png())
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    FakeXhr.last().respond(200)
    expect(await screen.findByLabelText(`Order for ${NEW_KEY}`)).toHaveValue('1')
    expect(screen.queryByLabelText(`Order for ${K2}`)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(dialog()).toHaveTextContent('1 replaced')
    await user.click(saveButton())
    const [body] = bodies(f, '/api/bff/media/product/TZP-1')
    expect(body.assets[1]).toMatchObject({ assetId: 'A2', assetKey: NEW_KEY, sortOrder: 1 })
  })

  it('Cancel stops an in-flight upload; nothing is added and it can be retried', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok(target()))
    wrap(editor())
    await user.upload(screen.getByLabelText('Image file'), png())
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    FakeXhr.last().progress(8, 32)
    await user.click(await screen.findByRole('button', { name: 'Cancel upload' }))
    expect(FakeXhr.last().aborted).toBe(true)
    expect(await screen.findByText(/Upload cancelled/)).toBeInTheDocument()
    expect(screen.queryByLabelText(`Alt text for ${NEW_KEY}`)).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry upload' })).toBeInTheDocument()
  })

  it('learns the backend limit from a target and then refuses larger files locally', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => ok({ ...target(), maxBytes: 40 }))
    wrap(editor())
    await user.upload(screen.getByLabelText('Image file'), png())
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    FakeXhr.last().respond(200)
    expect(await screen.findByLabelText(`Alt text for ${NEW_KEY}`)).toBeInTheDocument()
    await user.upload(
      screen.getByLabelText('Image file'),
      imageFile('big.png', 'image/png', PNG_HEAD, 100),
    )
    expect(await screen.findByText('The file is 1 KiB; the limit is 1 KiB.')).toBeInTheDocument()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a size refusal at save names the backend limit', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid_request',
          code: 'INVALID_MEDIA',
          detail: { reason: 'size', maxBytes: 2097152 },
        }),
        { status: 422 },
      ),
    )
    wrap(editor())
    await user.type(screen.getByLabelText(`Alt text for ${K2}`), 'Side')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    await user.click(saveButton())
    expect(
      await within(dialog()).findByText(
        'An image is larger than this backend accepts (up to 2 MiB). Nothing was saved.',
      ),
    ).toBeInTheDocument()
  })

  it('after a conflict, replacing is disabled like adding', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(409, 'STALE_VERSION'))
    wrap(editor())
    await user.click(screen.getByRole('button', { name: `Replace ${K2}` }))
    await user.type(screen.getByLabelText(`Alt text for ${K2}`), 'Side')
    await user.click(screen.getByRole('button', { name: 'Review changes' }))
    await user.click(saveButton())
    await screen.findByText(/Someone else changed this media set/)
    expect(screen.getByRole('button', { name: 'Cancel replace' })).toBeDisabled()
    expect(screen.getByLabelText(`Replacement image for ${K2}`)).toBeDisabled()
    expect(screen.getByLabelText('Image file')).toBeDisabled()
  })

  it('a superseded local preview is released when its image is replaced again', async () => {
    const user = userEvent.setup()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ok(target()))
    const created: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      created.push(`blob:preview-${created.length + 1}`)
      return created.at(-1)!
    })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    wrap(editor())
    await user.click(screen.getByRole('button', { name: `Replace ${K2}` }))
    await user.upload(screen.getByLabelText(`Replacement image for ${K2}`), png())
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    FakeXhr.last().respond(200)
    await screen.findByLabelText(`Order for ${NEW_KEY}`)
    expect(revoke).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: `Replace ${NEW_KEY}` }))
    await user.upload(screen.getByLabelText(`Replacement image for ${NEW_KEY}`), png())
    await waitFor(() => expect(FakeXhr.instances).toHaveLength(2))
    FakeXhr.last().respond(200)
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:preview-1'))
  })
})
