'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { PRODUCT_ID } from '@/lib/products'

/** Jump straight to a product by id (the backend has no text search). Validates the id before navigating. */
export function OpenById() {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string>()
  function submit(event: FormEvent) {
    event.preventDefault()
    const id = value.trim().toUpperCase()
    if (!PRODUCT_ID.test(id)) {
      setError('Enter a product id such as TZP-1001.')
      return
    }
    setError(undefined)
    router.push(`/catalogue/products/${encodeURIComponent(id)}`)
  }
  return (
    <form className="filters" onSubmit={submit} aria-label="Open product by id">
      <label>
        Open by product id
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'open-id-error' : undefined}
          placeholder="TZP-…"
        />
      </label>
      <button type="submit" className="btn">
        Open
      </button>
      {error ? (
        <p id="open-id-error" className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}
