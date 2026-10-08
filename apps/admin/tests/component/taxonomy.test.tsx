import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NodeActions } from '@/components/taxonomy/NodeActions'
import { TaxonomyView, type TaxonomyData } from '@/components/taxonomy/TaxonomyView'
import { ToastProvider } from '@/components/ui/Toast'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}))

const node = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  nodeType: 'category',
  name: `Node ${id}`,
  parentId: 'TZS-000001',
  status: 'active',
  version: 4,
  ...over,
})

describe('TaxonomyView', () => {
  it('lists children with drill-down links, trail, and cursor paging that keeps the parent', () => {
    const data: TaxonomyData = {
      list: {
        kind: 'ok',
        data: {
          items: [node('TZC-000001'), node('TZC-000002', { status: 'deprecated' })],
          nextCursor: 'TZC-000002',
        },
      },
      node: {
        kind: 'ok',
        data: node('TZS-000001', { nodeType: 'super_category', name: 'Staples', parentId: null }),
      },
      path: { kind: 'ok', data: { nodes: [{ id: 'TZS-000001', name: 'Staples' }] } },
    }
    render(
      <ToastProvider>
        <TaxonomyView data={data} query={{ parentId: 'TZS-000001', limit: 100 }} canWrite={false} />
      </ToastProvider>,
    )
    expect(screen.getByRole('link', { name: 'Node TZC-000001' })).toHaveAttribute(
      'href',
      '/catalogue/taxonomy?parent=TZC-000001',
    )
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute(
      'href',
      '/catalogue/taxonomy?parent=TZS-000001&cursor=TZC-000002',
    )
    expect(screen.getByText('deprecated')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('cms-writer')
    expect(screen.queryByRole('form', { name: 'Rename node' })).toBeNull()
  })

  it('shows permission and empty states honestly', () => {
    const { rerender } = render(
      <TaxonomyView
        data={{ list: { kind: 'forbidden' } }}
        query={{ limit: 100 }}
        canWrite={false}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Not permitted')
    rerender(
      <TaxonomyView
        data={{ list: { kind: 'ok', data: { items: [] } } }}
        query={{ limit: 100 }}
        canWrite={false}
      />,
    )
    expect(screen.getByText('No super categories')).toBeInTheDocument()
  })
})

describe('NodeActions', () => {
  beforeEach(() => {
    refresh.mockClear()
    vi.restoreAllMocks()
  })
  const mount = (n = node('TZC-000001')) =>
    render(
      <ToastProvider>
        <NodeActions node={n} />
      </ToastProvider>,
    )

  it('explains NO_OPEN_RELEASE, sends expectedVersion, and does not retry', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'conflict', code: 'NO_OPEN_RELEASE' }), {
        status: 409,
      }),
    )
    mount()
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    expect(await screen.findByText(/Open a release first/)).toBeInTheDocument()
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0]![0]).toBe('/api/bff/catalog/taxonomy/nodes/TZC-000001/rename')
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      name: 'Renamed',
      expectedVersion: 4,
    })
  })

  it('creates a child one level down; a vertical parent offers no child form', async () => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: { id: 'TZB-1' } }), { status: 200 }))
    const { unmount } = mount(node('TZC-000001', { nodeType: 'category' }))
    await user.type(screen.getByLabelText(/New subcategory name/), 'Basmati')
    await user.click(screen.getByRole('button', { name: 'Add subcategory' }))
    expect(JSON.parse(String(f.mock.calls[0]![1]?.body))).toEqual({
      nodeType: 'sub_category',
      name: 'Basmati',
      parentId: 'TZC-000001',
    })
    unmount()
    mount(node('TZV-1', { nodeType: 'vertical' }))
    expect(screen.getByText(/leaf/)).toBeInTheDocument()
  })

  it('requires confirmation before deprecating', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    mount()
    await user.click(screen.getByRole('button', { name: 'Deprecate' }))
    expect(f).not.toHaveBeenCalled()
  })
})
