'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { useToast } from '@/components/ui/Toast'
import { bffErrorMessage, callBff } from '@/lib/bff-client'
import { createInput } from '@/lib/product-create'
import { CLASSIFICATION_STATUSES } from '@/lib/products'

type Errors = Record<string, string>

/** Single-SKU draft creation. Client rules are the shared schema; the backend remains the authority. */
export function ProductCreateForm() {
  const router = useRouter()
  const { toast } = useToast()
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const [identity, setIdentity] = useState<'gtin' | 'internal'>('gtin')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const f = new FormData(event.currentTarget)
    const text = (k: string) => String(f.get(k) ?? '').trim()
    const candidate = {
      id: text('id').toUpperCase(),
      productType: 'single',
      identityType: identity,
      ...(identity === 'internal' ? { internalKey: text('internalKey') } : {}),
      ...(identity === 'gtin'
        ? { gtins: [{ value: text('gtin'), market: text('market').toUpperCase() }] }
        : {}),
      brandCode: text('brandCode').toUpperCase(),
      title: text('title'),
      verticalId: text('verticalId'),
      releaseId: text('releaseId'),
      classificationStatus: text('classificationStatus'),
    }
    const parsed = createInput.safeParse(candidate)
    if (!parsed.success) {
      const next: Errors = {}
      for (const issue of parsed.error.issues) {
        const path = issue.path[0] === 'gtins' ? 'gtin' : String(issue.path[0] ?? 'form')
        next[path] ??= issue.message
      }
      setErrors(next)
      return
    }
    setErrors({})
    setBusy(true)
    const result = await callBff<{ id: string }>('/api/bff/catalog/products', 'POST', parsed.data)
    setBusy(false)
    if (result.ok) {
      toast('success', `Created draft ${result.data.id}.`)
      router.push(`/catalogue/products/${encodeURIComponent(result.data.id)}`)
      return
    }
    if (result.status === 401) {
      router.replace('/login?error=expired')
      router.refresh()
      return
    }
    toast('error', bffErrorMessage(result, 'product creation'))
  }

  const field = (name: string, label: string, props: Record<string, unknown> = {}) => (
    <label>
      {label}
      <input
        name={name}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={errors[name] ? `${name}-err` : undefined}
        {...props}
      />
      {errors[name] ? (
        <span id={`${name}-err`} className="field-error" role="alert">
          {errors[name]}
        </span>
      ) : null}
    </label>
  )

  return (
    <form className="stack form-narrow" onSubmit={submit} noValidate aria-label="Create product">
      {field('id', 'Product id', { placeholder: 'TZP-1001', required: true })}
      {field('title', 'Title', { required: true, maxLength: 200 })}
      {field('brandCode', 'Brand code', { required: true })}
      <fieldset>
        <legend>Identity</legend>
        <label className="inline">
          <input type="radio" checked={identity === 'gtin'} onChange={() => setIdentity('gtin')} />{' '}
          GTIN (barcode)
        </label>
        <label className="inline">
          <input
            type="radio"
            checked={identity === 'internal'}
            onChange={() => setIdentity('internal')}
          />{' '}
          Internal key
        </label>
      </fieldset>
      {identity === 'gtin' ? (
        <>
          {field('gtin', 'GTIN (8, 12, 13 or 14 digits, check digit verified)', {
            inputMode: 'numeric',
          })}
          {field('market', 'GTIN market (2 letters)', { defaultValue: 'IN', maxLength: 2 })}
        </>
      ) : (
        field('internalKey', 'Internal key', { maxLength: 64 })
      )}
      {field('verticalId', 'Vertical id', { required: true })}
      {field('releaseId', 'Taxonomy release id', { required: true })}
      <label>
        Classification status
        <select name="classificationStatus" defaultValue="provisional">
          {CLASSIFICATION_STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <p className="muted">
        Creates a single-SKU draft. The backend does not check that the vertical or release exists,
        and creation cannot be retried safely: a repeat returns an identity collision.
      </p>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create draft'}
      </button>
    </form>
  )
}
