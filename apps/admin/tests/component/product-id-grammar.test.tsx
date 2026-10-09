import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenById } from '@/components/products/OpenById'
import { ProductCreateForm } from '@/components/products/ProductCreateForm'
import { ToastProvider } from '@/components/ui/Toast'
import { INVALID_PRODUCT_IDS } from '../support/product-id-corpus'

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}))
beforeEach(() => push.mockClear())

const CASED = ['TZP-l001', 'TZP-Med-3', 'TZP-abc']

describe('OpenById', () => {
  it.each(CASED)('navigates to %s exactly as typed', async (id) => {
    const user = userEvent.setup()
    render(<OpenById />)
    await user.type(screen.getByPlaceholderText('TZP-…'), `  ${id} {Enter}`)
    expect(push).toHaveBeenCalledWith(`/catalogue/products/${id}`)
  })
  it('rejects a lower-case prefix instead of upper-casing it', async () => {
    const user = userEvent.setup()
    render(<OpenById />)
    await user.type(screen.getByPlaceholderText('TZP-…'), 'tzp-1{Enter}')
    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('case matters')
  })
  it.each(INVALID_PRODUCT_IDS.filter((x) => x.trim() === x && x !== '' && !x.includes('\n')))(
    'rejects %j',
    async (id) => {
      const user = userEvent.setup()
      render(<OpenById />)
      await user.type(screen.getByPlaceholderText('TZP-…'), `${id}{Enter}`)
      expect(push).not.toHaveBeenCalled()
    },
  )
})

describe('ProductCreateForm', () => {
  it.each(CASED)('submits %s untransformed', async (id) => {
    const user = userEvent.setup()
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ data: { id } }), { status: 201 }))
    render(
      <ToastProvider>
        <ProductCreateForm />
      </ToastProvider>,
    )
    await user.type(screen.getByLabelText('Product id'), id)
    await user.type(screen.getByLabelText('Title'), 'Rice')
    await user.type(screen.getByLabelText('Brand code'), 'br')
    await user.click(screen.getByRole('radio', { name: /Internal key/ }))
    await user.type(screen.getByRole('textbox', { name: 'Internal key' }), 'K-1')
    await user.type(screen.getByLabelText('Vertical id'), 'VT-1')
    await user.type(screen.getByLabelText('Taxonomy release id'), 'REL-1')
    await user.click(screen.getByRole('button', { name: 'Create draft' }))
    const call = f.mock.calls.find((c) => c[0] === '/api/bff/catalog/products')
    expect(call).toBeDefined()
    const body = JSON.parse(String((call![1] as RequestInit).body)) as {
      id: string
      brandCode: string
    }
    expect(body.id).toBe(id)
    expect(body.brandCode).toBe('BR')
    f.mockRestore()
  })
  it('does not upper-case a lower-case prefix (so it fails validation)', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    render(
      <ToastProvider>
        <ProductCreateForm />
      </ToastProvider>,
    )
    await user.type(screen.getByLabelText('Product id'), 'tzp-1')
    await user.click(screen.getByRole('button', { name: 'Create draft' }))
    expect(f).not.toHaveBeenCalled()
    f.mockRestore()
  })
})
