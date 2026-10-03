import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import LoginPage from '@/app/(auth)/login/page'

describe('login page (W1 visual shell)', () => {
  const html = renderToStaticMarkup(<LoginPage />)

  it('has an accessible heading and an explained, disabled Google button', () => {
    expect(html).toMatch(/<h1[^>]*>Tazzzo Admin<\/h1>/)
    const button = html.match(/<button[^>]*>Sign in with Google<\/button>/)?.[0] ?? ''
    expect(button).toContain('type="button"')
    expect(button).toMatch(/\sdisabled(=""|\s|>)/)
    expect(button).toContain('aria-describedby="signin-status"')
    expect(html).toContain('id="signin-status"')
  })

  it('offers no path to an authenticated state', () => {
    expect(html).not.toMatch(/<form/i)
    expect(html).not.toMatch(/<a\s/i)
    expect(html).not.toMatch(/href=|formaction|action=/i)
    expect(html.match(/<button/g)).toHaveLength(1)
  })
})
