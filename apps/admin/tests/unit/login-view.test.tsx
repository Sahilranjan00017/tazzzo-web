import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AppShellView } from '@/components/AppShellView'
import { LoginView } from '@/components/LoginView'

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ replace: () => undefined, refresh: () => undefined }),
}))

describe('login view', () => {
  const html = renderToStaticMarkup(<LoginView startHref="/api/auth/google/start" />)

  it('signs in with a plain GET link to the server-side login start (no form, no script)', () => {
    expect(html).toMatch(/<h1[^>]*>Tazzzo Admin<\/h1>/)
    expect(html).toContain(
      '<a class="button" href="/api/auth/google/start">Sign in with Google</a>',
    )
    expect(html).not.toMatch(/<form|<button|onclick/i)
  })

  it('shows only known, generic error messages', () => {
    expect(renderToStaticMarkup(<LoginView startHref="/s" error="signin_failed" />)).toContain(
      'did not complete',
    )
    const injected = renderToStaticMarkup(
      <LoginView startHref="/s" error="<script>alert(1)</script>" />,
    )
    expect(injected).not.toContain('script')
    expect(injected).not.toContain('role="alert"')
  })
})

describe('authenticated shell', () => {
  it('renders the email label and roles from /me, and nothing else about the identity', () => {
    const html = renderToStaticMarkup(
      <AppShellView identity={{ label: 'ops@tazzzo.test', roles: ['cms-writer', 'reader'] }}>
        <p>content</p>
      </AppShellView>,
    )
    expect(html).toContain('Account menu for ops@tazzzo.test')
    expect(html).not.toMatch(/eyJ|google:|Bearer/)
  })
})
