import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessMatrix } from '@/components/AccessMatrix'
import { GotoBox } from '@/components/shell/GotoBox'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
beforeEach(() => push.mockClear())

describe('GotoBox', () => {
  it('navigates to a recognised id and clears the box; makes no network call', async () => {
    const user = userEvent.setup()
    const f = vi.spyOn(globalThis, 'fetch')
    render(<GotoBox roles={['reader']} />)
    await user.type(screen.getByRole('textbox', { name: 'Go to an id' }), 'tzp-1001{Enter}')
    expect(push).toHaveBeenCalledWith('/catalogue/products/TZP-1001')
    expect(screen.getByRole('textbox', { name: 'Go to an id' })).toHaveValue('')
    expect(f).not.toHaveBeenCalled()
  })
  it('explains an unrecognised id or a module the roles cannot use, and does not navigate', async () => {
    const user = userEvent.setup()
    render(<GotoBox roles={['reader']} />)
    await user.type(screen.getByRole('textbox', { name: 'Go to an id' }), 'basmati{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('not a recognised id')
    await user.clear(screen.getByRole('textbox', { name: 'Go to an id' }))
    await user.type(screen.getByRole('textbox', { name: 'Go to an id' }), 'ORD_abcdef12{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('cannot open Orders')
    expect(push).not.toHaveBeenCalled()
  })
  it('the / shortcut focuses the box, but not while typing in another field', async () => {
    const user = userEvent.setup()
    render(
      <>
        <GotoBox roles={['reader']} />
        <input aria-label="other" />
      </>,
    )
    await user.keyboard('/')
    expect(screen.getByRole('textbox', { name: 'Go to an id' })).toHaveFocus()
    await user.click(screen.getByLabelText('other'))
    await user.keyboard('/')
    expect(screen.getByLabelText('other')).toHaveFocus()
    expect(screen.getByLabelText('other')).toHaveValue('/')
  })
})

describe('AccessMatrix', () => {
  it('marks the viewer’s roles and lists the documented backend quirks', () => {
    render(<AccessMatrix yourRoles={['order-ops']} />)
    expect(screen.getByText('(you)')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /order-ops/ })).toHaveTextContent('(you)')
    expect(screen.getByText(/refused at the audit log/)).toBeInTheDocument()
    expect(screen.getByText(/not backend roles/)).toBeInTheDocument()
  })
})
