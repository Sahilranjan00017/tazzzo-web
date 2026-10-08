import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductEditor } from '@/components/products/ProductEditor'
import { ProductListView, type ProductListResult } from '@/components/products/ProductListView'
import { ToastProvider } from '@/components/ui/Toast'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}))

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  productType: 'single',
  lifecycle: 'active',
  brandCode: 'BR',
  title: `Item ${id}`,
  verticalId: 'VT-1',
  classificationStatus: 'confirmed',
  version: 2,
  ...over,
})
const ok = (items: ReturnType<typeof item>[], nextCursor?: string): ProductListResult => ({
  kind: 'ok',
  data: { items, nextCursor },
})

describe('ProductListView', () => {
  it('renders rows with links, absent values as dashes, and a cursor-based next link keeping filters', () => {
    render(
      <ProductListView
        result={ok([item('TZP-1'), item('TZP-2', { verticalId: 'null' })], 'TZP-2')}
        query={{ verticalId: 'VT-1', limit: 50 }}
        problems={[]}
        canWrite
      />,
    )
    expect(screen.getByRole('link', { name: 'TZP-1' })).toHaveAttribute(
      'href',
      '/catalogue/products/TZP-1',
    )
    const row = screen.getByRole('link', { name: 'TZP-2' }).closest('tr')!
    expect(within(row).getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute(
      'href',
      '/catalogue/products?verticalId=VT-1&cursor=TZP-2',
    )
    expect(screen.getByRole('link', { name: 'New product' })).toBeInTheDocument()
  })

  it('hides New product without write access, explains ignored filters, and shows an honest empty state', () => {
    render(
      <ProductListView
        result={ok([])}
        query={{ limit: 50 }}
        problems={['Ignored invalid cursor.']}
        canWrite={false}
      />,
    )
    expect(screen.queryByRole('link', { name: 'New product' })).toBeNull()
    expect(screen.getByText('Ignored invalid cursor.')).toBeInTheDocument()
    expect(screen.getByText('No products')).toBeInTheDocument()
  })

  it('shows a permission state for 403 with no table and no retry', () => {
    render(
      <ProductListView
        result={{ kind: 'forbidden' }}
        query={{ limit: 50 }}
        problems={[]}
        canWrite={false}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Not permitted')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
  })
})

describe('ProductEditor', () => {
  beforeEach(() => {
    refresh.mockClear()
    vi.restoreAllMocks()
  })
  const mount = (lifecycle = 'draft', canWrite = true) =>
    render(
      <ToastProvider>
        <ProductEditor
          product={{ id: 'TZP-1', title: 'Old', lifecycle, version: 5 }}
          canWrite={canWrite}
        />
      </ToastProvider>,
    )

  it('is read-only with an explanation when the role cannot write', () => {
    mount('draft', false)
    expect(screen.getByRole('note')).toHaveTextContent('cms-writer')
    expect(screen.queryByRole('button', { name: 'Save title' })).toBeNull()
  })

  it('saves the title with the expected version, then re-reads authoritative data', async () => {
    const user = userEvent.setup()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { id: 'TZP-1', version: 6 } }), { status: 200 }),
      )
    mount()
    const save = screen.getByRole('button', { name: 'Save title' })
    expect(save).toBeDisabled()
    await user.clear(screen.getByLabelText('Title'))
    await user.type(screen.getByLabelText('Title'), 'New')
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    await user.click(save)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/bff/catalog/products/TZP-1/title')
    expect(init).toMatchObject({ method: 'PATCH' })
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'New', expectedVersion: 5 })
    expect((init?.headers as Record<string, string>)['X-Tazzzo-CSRF']).toBe('1')
    expect(refresh).toHaveBeenCalled()
  })

  it('on a stale-version conflict shows the stale message, refreshes, and does not retry', async () => {
    const user = userEvent.setup()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'conflict', code: 'STALE_VERSION' }), { status: 409 }),
      )
    mount()
    await user.type(screen.getByLabelText('Title'), '!')
    await user.click(screen.getByRole('button', { name: 'Save title' }))
    expect(await screen.findByText(/changed this since you loaded/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalled()
  })

  it('offers only the legal action for the state and requires confirmation before calling', async () => {
    const user = userEvent.setup()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { id: 'TZP-1', version: 6 } }), { status: 200 }),
      )
    mount('discontinued')
    expect(screen.getByRole('button', { name: 'Revive' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Archive' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
