import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginForm } from '@/components/LoginForm'
import { LogoutButton } from '@/components/LogoutButton'

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const assign = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  assign.mockReset()
  router.replace.mockReset()
  router.refresh.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const sent = {
  ok: true,
  maskedPhone: '+91 ******3210',
  expiresInSeconds: 300,
  resendAfterSeconds: 2,
}

describe('LoginForm phone step', () => {
  it('has a labelled phone field, focused, and a submit button', () => {
    render(<LoginForm next="/account" pending={null} notice={null} />)
    const input = screen.getByLabelText('Mobile number')
    expect(input).toHaveAttribute('type', 'tel')
    expect(input).toHaveAttribute('autocomplete', 'tel-national')
    expect(input).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Send code' })).toBeEnabled()
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('rejects an invalid number locally: announced, field invalid and described by the error, no request', async () => {
    const user = userEvent.setup()
    render(<LoginForm next="/account" pending={null} notice={null} />)
    await user.type(screen.getByLabelText('Mobile number'), '12345')
    await user.click(screen.getByRole('button', { name: 'Send code' }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Enter a valid 10-digit Indian mobile number.')
    const input = screen.getByLabelText('Mobile number')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', alert.id)
    expect(input).toHaveFocus()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('submits with Enter, shows progress, then moves to the code step with focus on the code field', async () => {
    const user = userEvent.setup()
    let release: (r: Response) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)))
    render(<LoginForm next="/account" pending={null} notice={null} />)
    await user.type(screen.getByLabelText('Mobile number'), '98765 43210{Enter}')
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
    expect(screen.getByText('Sending your code…')).toBeInTheDocument()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/auth/otp/request')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('x-tazzzo-csrf')).toBe('1')
    expect(JSON.parse(String(init?.body))).toEqual({ phone: '98765 43210' })
    await act(async () => release(json(200, sent)))
    expect(await screen.findByLabelText('6-digit code')).toHaveFocus()
    expect(screen.getByText('+91 ******3210')).toBeInTheDocument()
  })

  // Mutation note: restoring `setStatus('We sent a 6-digit code to ...')` after a send prints the sentence twice.
  it('says where the code went exactly once, and the code field is described by that hint', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(json(200, sent))
    render(<LoginForm next="/account" pending={null} notice={null} />)
    await user.type(screen.getByLabelText('Mobile number'), '9876543210{Enter}')
    const code = await screen.findByLabelText('6-digit code')
    expect(screen.getAllByText(/We sent a 6-digit code/)).toHaveLength(1)
    const hint = document.getElementById('login-code-hint')!
    expect(hint).toHaveTextContent('We sent a 6-digit code to +91 ******3210.')
    expect(code.getAttribute('aria-describedby')).toContain('login-code-hint')
  })

  it('links the legal text to /terms and /privacy', () => {
    render(<LoginForm next="/account" pending={null} notice={null} />)
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy')
  })

  it.each([
    [
      429,
      { ok: false, error: 'rate_limited', retryAfterSeconds: 42 },
      'Too many attempts. Please wait 42 seconds and try again.',
    ],
    [
      503,
      { ok: false, error: 'unavailable', retryAfterSeconds: null },
      'We could not sign you in right now. Please try again in a moment.',
    ],
    [
      403,
      { ok: false, error: 'forbidden' },
      'We could not verify this request. Reload the page and try again.',
    ],
  ])(
    'shows a plain message for a %i answer and stays on the phone step',
    async (status, body, message) => {
      const user = userEvent.setup()
      fetchMock.mockResolvedValueOnce(json(status, body))
      render(<LoginForm next="/account" pending={null} notice={null} />)
      await user.type(screen.getByLabelText('Mobile number'), '9876543210')
      await user.click(screen.getByRole('button', { name: 'Send code' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(screen.getByRole('button', { name: 'Send code' })).toBeEnabled()
    },
  )

  it('survives a network failure and a non-JSON answer', async () => {
    const user = userEvent.setup()
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('<html>', { status: 502 }))
    render(<LoginForm next="/account" pending={null} notice={null} />)
    await user.type(screen.getByLabelText('Mobile number'), '9876543210')
    await user.click(screen.getByRole('button', { name: 'Send code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not sign you in')
    await user.click(screen.getByRole('button', { name: 'Send code' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not sign you in')
  })

  it('shows the notice it was given (e.g. an ended session)', () => {
    render(
      <LoginForm
        next="/account"
        pending={null}
        notice="Your session has ended. Please sign in again."
      />,
    )
    expect(screen.getByText('Your session has ended. Please sign in again.')).toBeInTheDocument()
  })
})

describe('LoginForm code step', () => {
  async function toCodeStep() {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(json(200, sent))
    render(<LoginForm next="/p/TZP-1001" pending={null} notice={null} />)
    await user.type(screen.getByLabelText('Mobile number'), '9876543210')
    await user.click(screen.getByRole('button', { name: 'Send code' }))
    await screen.findByLabelText('6-digit code')
    return user
  }

  it('takes digits only, asks for six, and does not call the backend for fewer', async () => {
    const user = await toCodeStep()
    const input = screen.getByLabelText('6-digit code')
    expect(input).toHaveAttribute('autocomplete', 'one-time-code')
    expect(input).toHaveAttribute('inputmode', 'numeric')
    await user.type(input, '12ab34')
    expect(input).toHaveValue('1234')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the 6-digit code.')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('signs in and goes to the (sanitised) next page with a full navigation', async () => {
    const user = await toCodeStep()
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }))
    await user.type(screen.getByLabelText('6-digit code'), '123456{Enter}')
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/p/TZP-1001'))
    const [url, init] = fetchMock.mock.calls[1]!
    expect(url).toBe('/api/auth/otp/verify')
    expect(JSON.parse(String(init?.body))).toEqual({ otp: '123456' })
  })

  it('refuses to navigate off site even if given a hostile next', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(json(200, sent)).mockResolvedValueOnce(json(200, { ok: true }))
    render(<LoginForm next="https://evil.example/" pending={null} notice={null} />)
    await user.type(screen.getByLabelText('Mobile number'), '9876543210')
    await user.click(screen.getByRole('button', { name: 'Send code' }))
    await user.type(await screen.findByLabelText('6-digit code'), '123456{Enter}')
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/account'))
  })

  it.each([
    ['invalid_code', 400, 'That code is not right.'],
    ['expired', 400, 'That code has expired. Ask for a new one.'],
    ['rate_limited', 429, 'Too many attempts. Please wait 2 minutes and try again.'],
  ])(
    'shows %s as an announced error, keeps the code field and does not navigate',
    async (error, status, message) => {
      const user = await toCodeStep()
      fetchMock.mockResolvedValueOnce(json(status, { ok: false, error, retryAfterSeconds: 120 }))
      await user.type(screen.getByLabelText('6-digit code'), '111111{Enter}')
      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(screen.getByLabelText('6-digit code')).toHaveFocus()
      expect(screen.getByLabelText('6-digit code')).toHaveAttribute('aria-invalid', 'true')
      expect(assign).not.toHaveBeenCalled()
    },
  )

  it('offers a new code only after the cooldown and a different number at any time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    fetchMock.mockResolvedValueOnce(json(200, sent))
    render(<LoginForm next="/account" pending={null} notice={null} />)
    await user.type(screen.getByLabelText('Mobile number'), '9876543210')
    await user.click(screen.getByRole('button', { name: 'Send code' }))
    const resend = await screen.findByRole('button', { name: /Send a new code in/ })
    expect(resend).toBeDisabled()
    // The countdown re-arms after each render, so advance one second at a time.
    for (let i = 0; i < 3; i++) await act(async () => void vi.advanceTimersByTime(1000))
    const ready = await screen.findByRole('button', { name: 'Send a new code' })
    expect(ready).toBeEnabled()
    fetchMock.mockResolvedValueOnce(json(200, sent))
    await user.click(ready)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await user.click(screen.getByRole('button', { name: 'Use a different number' }))
    expect(screen.getByLabelText('Mobile number')).toHaveFocus()
  })

  it('opens on the code step when a code was already sent from this browser', () => {
    render(<LoginForm next="/account" pending={{ maskedPhone: '+91 ******3210' }} notice={null} />)
    expect(screen.getByLabelText('6-digit code')).toHaveFocus()
    expect(screen.getByText('+91 ******3210')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Send a new code/ })).toBeNull() // number unknown to the page
    expect(screen.getByRole('button', { name: 'Use a different number' })).toBeInTheDocument()
  })
})

describe('LogoutButton', () => {
  it('posts the session CSRF token, then leaves the account page', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, revoked: true }))
    render(<LogoutButton csrfToken={'T'.repeat(43)} />)
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/auth/logout')
    expect(new Headers(init?.headers).get('x-tazzzo-csrf')).toBe('T'.repeat(43))
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'))
    expect(router.refresh).toHaveBeenCalled()
  })

  it('announces a failure and lets the customer retry', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValueOnce(json(403, { ok: false }))
    render(<LogoutButton csrfToken="x" />)
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not sign you out.')
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled()
    expect(router.replace).not.toHaveBeenCalled()
  })
})
