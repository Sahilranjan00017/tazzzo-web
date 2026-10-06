import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AppShellView } from '@/components/AppShellView'
import { NAV } from '@/lib/nav'

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
    expect(within(nav).getByRole('link', { name: 'Orders' })).toHaveAttribute('href', '/orders')
    expect(within(nav).getByRole('link', { name: 'Support' })).toHaveAttribute('href', '/support')
    expect(within(nav).queryByText('Products')).toBeNull()
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
  })

  it('opens the profile menu with identity and roles, and Escape closes it', async () => {
    const user = userEvent.setup()
    render(shell(['reader', 'audit-reader']))
    const trigger = screen.getByRole('button', { name: /Account menu for ops@tazzzo.test/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const panel = document.getElementById(trigger.getAttribute('aria-controls') ?? '')
    expect(panel).toHaveTextContent('ops@tazzzo.test')
    expect(panel).toHaveTextContent('reader, audit-reader')
    // Plain disclosure semantics: no half-implemented ARIA menu roles.
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('menuitem')).toBeNull()
    expect(trigger).not.toHaveAttribute('aria-haspopup')
    await user.keyboard('{Escape}')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById('account-menu')).toBeNull()
  })

  it('renders any not-yet-built module as disabled text, never a link', () => {
    const planned = NAV.flatMap((sec) => sec.items).filter((i) => i.state === 'planned')
    for (const item of planned) {
      const { unmount } = render(shell(item.roles ? [...item.roles] : ['reader']))
      const nav = screen.getByRole('navigation', { name: 'Modules' })
      expect(within(nav).getByText(item.label)).toHaveAttribute('aria-disabled', 'true')
      expect(within(nav).queryByRole('link', { name: item.label })).toBeNull()
      unmount()
    }
  })

  it('toggles the mobile drawer with an accessible expanded state', async () => {
    const user = userEvent.setup()
    render(shell([]))
    const toggle = screen.getByRole('button', { name: 'Open navigation' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('never renders token-like or actor data', () => {
    const { container } = render(shell(['cms-writer']))
    expect(container.innerHTML).not.toMatch(/eyJ|google:|Bearer/)
  })
})
