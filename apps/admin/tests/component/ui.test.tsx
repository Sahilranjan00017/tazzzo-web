import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ToastProvider, useToast } from '@/components/ui/Toast'
import { EmptyState, ErrorPanel, Skeleton, StatusBadge } from '@/components/ui/primitives'

function Trigger() {
  const { toast } = useToast()
  return (
    <>
      <button onClick={() => toast('success', 'Saved')}>ok</button>
      <button onClick={() => toast('error', '<b>boom</b>')}>bad</button>
    </>
  )
}

describe('toasts', () => {
  it('announces success politely and auto-dismisses it', async () => {
    vi.useFakeTimers()
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    )
    act(() => screen.getByText('ok').click())
    expect(screen.getByRole('status')).toHaveTextContent('Saved')
    act(() => void vi.advanceTimersByTime(6_100))
    expect(screen.queryByRole('status')).toBeNull()
    vi.useRealTimers()
  })

  it('keeps errors until dismissed, as an alert, rendering text not HTML', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    )
    await user.click(screen.getByText('bad'))
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('<b>boom</b>')
    expect(alert.querySelector('b')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('requires a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/)
    spy.mockRestore()
  })
})

describe('confirm dialog', () => {
  it('opens modally, confirms and cancels via buttons', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ConfirmDialog
        open
        destructive
        title="Archive product?"
        description="This hides it."
        confirmLabel="Archive"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    const dialog = screen.getByRole('dialog', { name: 'Archive product?' })
    expect(dialog).toHaveAttribute('open')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Archive' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('disables both actions while busy', () => {
    render(
      <ConfirmDialog
        open
        busy
        title="t"
        description="d"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    )
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled()
  })
})

describe('state primitives', () => {
  it('shows loading, empty and error states with the right semantics', async () => {
    const retry = vi.fn()
    render(
      <>
        <Skeleton label="Loading orders" />
        <EmptyState title="No orders" message="Nothing matches." />
        <ErrorPanel
          title="Failed"
          message="Backend unavailable."
          correlationId="req_abc"
          onRetry={retry}
        />
        <StatusBadge tone="danger">Out of stock</StatusBadge>
      </>,
    )
    expect(screen.getByRole('status', { name: 'Loading orders' })).toHaveAttribute(
      'aria-busy',
      'true',
    )
    expect(screen.getByRole('heading', { name: 'No orders' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Reference: req_abc')
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()
  })
})
