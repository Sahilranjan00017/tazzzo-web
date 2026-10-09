'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { PRODUCT_ID_PATTERN } from '@/lib/products'

type Result = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; message: string }

const MESSAGES: Record<number, string> = {
  401: 'Your session has ended. Please sign in again.',
  403: 'Access denied: your role cannot make this change.',
  404: 'Product not found.',
  409: 'The product changed since you loaded it. Reload and try again.',
  413: 'Request too large.',
  429: 'Too many requests. Try again shortly.',
}

/**
 * W3 BFF reference control: same-origin JSON PATCH to the CMS BFF (never the backend), with the CSRF header. The
 * browser only ever sees the normalized BFF result; the backend decides whether this human may make the change.
 */
export function ProductTitleForm() {
  const router = useRouter()
  const [result, setResult] = useState<Result>({ kind: 'idle' })

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setResult({ kind: 'busy' })
    const response = await fetch(
      `/api/bff/catalog/products/${encodeURIComponent(String(form.get('productId')))}/title`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Tazzzo-CSRF': '1' },
        body: JSON.stringify({
          title: String(form.get('title')),
          expectedVersion: Number(form.get('expectedVersion')),
        }),
      },
    )
    if (response.status === 401) {
      router.replace('/login?error=expired')
      router.refresh()
      return
    }
    const body = (await response.json().catch(() => ({}))) as { data?: { version?: number } }
    setResult({
      kind: 'done',
      message: response.ok
        ? `Saved. New version ${body.data?.version ?? ''}.`
        : (MESSAGES[response.status] ?? 'The change could not be saved. Try again later.'),
    })
  }

  return (
    <form className="reference-form" onSubmit={submit}>
      <label>
        Product id
        <input name="productId" required pattern={PRODUCT_ID_PATTERN} />
      </label>
      <label>
        Expected version
        <input name="expectedVersion" type="number" min={0} required />
      </label>
      <label>
        New title
        <input name="title" required maxLength={200} />
      </label>
      <button type="submit" className="button" disabled={result.kind === 'busy'}>
        Save title
      </button>
      {result.kind === 'done' ? (
        <p role="status" className="notice">
          {result.message}
        </p>
      ) : null}
    </form>
  )
}
