import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AppShellView } from '@/components/AppShellView'

const pathname = '/'
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined }),
}))

const shell = (roles: string[]) => (
  <AppShellView identity={{ label: 'ops@tazzzo.test', roles }}>
    <p>page body</p>
  </AppShellView>
)

describe('app shell', () => {
  it('renders landmarks, a skip link and the page body', () => {
    render(shell(['cms-writer']))
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main')
    expect(screen.getByRole('navigation', { name: 'Modules' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveTextContent('page body')
  })

  it('filters the sidebar by role and disables unbuilt modules instead of linking to nowhere', () => {
    render(shell(['order-ops']))
    const nav = screen.getByRole('navigation', { name: 'Modules' })
    expect(within(nav).getByText('Orders')).toHaveAttribute('aria-disabled', 'true')
    expect(within(nav).queryByText('Products')).toBeNull()
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
  })

  it('opens the profile menu with identity and roles, and Escape closes it', async () => {
    const user = userEvent.setup()
    render(shell(['reader', 'audit-reader']))
    expect(screen.queryByRole('menu')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Account menu for ops@tazzzo.test/ }))
    const menu = screen.getByRole('menu')
    expect(menu).toHaveTextContent('ops@tazzzo.test')
    expect(menu).toHaveTextContent('reader, audit-reader')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('toggles the mobile drawer with an accessible expanded state', async () => {
    const user = userEvent.setup()
    render(shell([]))
    const toggle = screen.getByRole('button', { name: 'Open navigation' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('never renders token-like or actor data', () => {
    const { container } = render(shell(['cms-writer']))
    expect(container.innerHTML).not.toMatch(/eyJ|google:|Bearer/)
  })
})
