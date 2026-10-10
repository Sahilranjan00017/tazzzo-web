'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { errorMessage } from '@/lib/auth/messages'
import { isOtp, normalisePhone, safeNext } from '@/lib/auth/validation'

interface Props {
  /** Already reduced to a same-origin path by the page; reduced again before navigating. */
  next: string
  /** A code was sent earlier from this browser and is still valid. */
  pending: { maskedPhone: string } | null
  /** Why the customer is here again (expired session, ...), already a message. */
  notice: string | null
}

type Step = 'phone' | 'code'
type Reply = { ok: boolean; error?: string; retryAfterSeconds?: number | null } & Record<
  string,
  unknown
>

async function post(path: string, body: unknown): Promise<Reply> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tazzzo-CSRF': '1' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    })
    const reply = (await response.json()) as Reply
    return response.ok ? { ...reply, ok: true } : { ...reply, ok: false }
  } catch {
    return { ok: false, error: 'unavailable' }
  }
}

/** Phone number, then the code texted to it. Both steps share one live region for errors and progress. */
export function LoginForm({ next, pending, notice }: Props) {
  const [step, setStep] = useState<Step>(pending ? 'code' : 'phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [masked, setMasked] = useState(pending?.maskedPhone ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [resendIn, setResendIn] = useState(0)
  const phoneRef = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (resendIn <= 0) return
    const timer = setTimeout(() => setResendIn((n) => n - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendIn])

  useEffect(() => {
    ;(step === 'code' ? codeRef : phoneRef).current?.focus()
  }, [step])

  async function sendCode(event?: FormEvent) {
    event?.preventDefault()
    if (busy) return
    const canonical = normalisePhone(phone)
    if (step === 'phone' && canonical === null) {
      setError(errorMessage('invalid_phone'))
      phoneRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    setStatus('Sending your code…')
    // Resending uses the number already typed; the server never gives the full number back.
    const reply = await post('/api/auth/otp/request', { phone })
    setBusy(false)
    if (!reply.ok) {
      setStatus(null)
      setError(errorMessage(reply.error ?? 'unavailable', reply.retryAfterSeconds ?? null))
      return
    }
    setMasked(String(reply.maskedPhone ?? ''))
    setResendIn(Number(reply.resendAfterSeconds ?? 30))
    setCode('')
    // The code step's own hint says where the code went; repeating that in the live region printed it twice. Only a
    // resend (already on the code step) gets an announcement, and a different one.
    setStatus(step === 'code' ? 'A new code has been sent.' : null)
    setStep('code')
  }

  async function verify(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!isOtp(code)) {
      setError('Enter the 6-digit code.')
      codeRef.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    setStatus('Checking your code…')
    const reply = await post('/api/auth/otp/verify', { otp: code })
    if (reply.ok) {
      setStatus('Signed in. Taking you there…')
      window.location.assign(safeNext(next))
      return
    }
    setBusy(false)
    setStatus(null)
    setError(errorMessage(reply.error ?? 'unavailable', reply.retryAfterSeconds ?? null))
    codeRef.current?.focus()
  }

  function changeNumber() {
    setStep('phone')
    setError(null)
    setStatus(null)
    setCode('')
  }

  const live = (
    <div className="auth-live" aria-live="polite" aria-atomic="true">
      {error ? (
        <p id="auth-error" className="auth-error" role="alert">
          {error}
        </p>
      ) : status ? (
        <p className="auth-status">{status}</p>
      ) : null}
    </div>
  )

  return (
    <div className="auth-card">
      {notice && <p className="auth-notice">{notice}</p>}
      {step === 'phone' ? (
        <form onSubmit={sendCode} noValidate aria-busy={busy}>
          <h1>Sign in</h1>
          <p className="auth-hint">We will text you a 6-digit code. No password needed.</p>
          <label htmlFor="login-phone">Mobile number</label>
          <div className="auth-phone">
            <span aria-hidden="true">+91</span>
            <input
              id="login-phone"
              ref={phoneRef}
              name="phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              maxLength={16}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              aria-invalid={error !== null}
              aria-describedby={error ? 'auth-error' : undefined}
              required
            />
          </div>
          {live}
          <button type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
          <p className="auth-legal">
            By continuing you agree to our <Link href="/terms">Terms</Link> and{' '}
            <Link href="/privacy">Privacy Policy</Link>.
          </p>
        </form>
      ) : (
        <form onSubmit={verify} noValidate aria-busy={busy}>
          <h1>Enter your code</h1>
          <p id="login-code-hint" className="auth-hint">
            We sent a 6-digit code to <strong>{masked}</strong>.
          </p>
          <label htmlFor="login-code">6-digit code</label>
          <input
            id="login-code"
            ref={codeRef}
            name="otp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            aria-invalid={error !== null}
            aria-describedby={error ? 'login-code-hint auth-error' : 'login-code-hint'}
            required
          />
          {live}
          <button type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          <div className="auth-links">
            {normalisePhone(phone) !== null && (
              <button
                type="button"
                className="link-button"
                onClick={() => void sendCode()}
                disabled={busy || resendIn > 0}
              >
                {resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'}
              </button>
            )}
            <button type="button" className="link-button" onClick={changeNumber} disabled={busy}>
              Use a different number
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
