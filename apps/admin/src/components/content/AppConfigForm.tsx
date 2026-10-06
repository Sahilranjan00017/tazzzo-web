'use client'

import { useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import { appConfigErrorMessage, appConfigForm, type AppConfig } from '@/lib/appconfig'

type Text = Record<
  | 'maintenanceMessage'
  | 'minAndroid'
  | 'latestAndroid'
  | 'minIos'
  | 'latestIos'
  | 'supportPhone'
  | 'supportEmail'
  | 'termsUrl'
  | 'privacyUrl'
  | 'refundPolicyUrl',
  string
>

const init = (c: AppConfig): Text => ({
  maintenanceMessage: c.maintenanceMessage ?? '',
  minAndroid: c.minAndroid ?? '',
  latestAndroid: c.latestAndroid ?? '',
  minIos: c.minIos ?? '',
  latestIos: c.latestIos ?? '',
  supportPhone: c.supportPhone ?? '',
  supportEmail: c.supportEmail ?? '',
  termsUrl: c.termsUrl ?? '',
  privacyUrl: c.privacyUrl ?? '',
  refundPolicyUrl: c.refundPolicyUrl ?? '',
})

/**
 * Edit the single global app configuration (full replace, version 0 = first save). It holds links, versions and support
 * contact only: never secrets, and never legal policy text (the legal links point to documents the business/legal owner
 * approves separately). Store-open and maintenance affect every customer platform immediately (subject to the public
 * cache of up to 60 seconds); the Android and iOS version fields are per-OS. Remounted with `key={version}`.
 */
export function AppConfigForm({ config }: { config: AppConfig }) {
  const { run, busy } = useBffAction(appConfigErrorMessage)
  const [storeOpen, setStoreOpen] = useState(config.storeOpen)
  const [maintenance, setMaintenance] = useState(config.maintenance)
  const [t, setT] = useState<Text>(init(config))
  const [errors, setErrors] = useState<string[]>([])
  const [confirm, setConfirm] = useState<ReturnType<typeof appConfigForm.parse>>()
  const set = (k: keyof Text) => (e: { target: { value: string } }) =>
    setT((cur) => ({ ...cur, [k]: e.target.value }))

  function review(e: FormEvent) {
    e.preventDefault()
    const parsed = appConfigForm.safeParse({
      storeOpen,
      maintenance,
      ...t,
      expectedVersion: config.version,
    })
    if (!parsed.success) {
      setErrors([...new Set(parsed.error.issues.map((i) => i.message))])
      return
    }
    setErrors([])
    setConfirm(parsed.data)
  }

  const risky = confirm && (!confirm.storeOpen || confirm.maintenance)
  const f = (k: keyof Text, label: string, extra: Record<string, unknown> = {}) => (
    <label>
      {label}
      <input value={t[k]} onChange={set(k)} {...extra} />
    </label>
  )
  return (
    <>
      <form
        className="stack form-narrow"
        onSubmit={review}
        noValidate
        aria-label="App configuration"
      >
        {config.version === 0 ? (
          <p className="notice" role="status">
            No configuration has been saved yet; these are the backend defaults. Saving creates the
            first version.
          </p>
        ) : null}
        <fieldset>
          <legend>Store status (all customer platforms)</legend>
          <label className="inline">
            <input
              type="checkbox"
              checked={storeOpen}
              onChange={(e) => setStoreOpen(e.target.checked)}
            />{' '}
            Store open for orders
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={maintenance}
              onChange={(e) => setMaintenance(e.target.checked)}
            />{' '}
            Maintenance mode
          </label>
          {f('maintenanceMessage', 'Maintenance message (required when maintenance is on)', {
            maxLength: 200,
          })}
        </fieldset>
        <fieldset>
          <legend>App versions (Android and iOS only)</legend>
          <div className="row">
            {f('minAndroid', 'Android minimum', { placeholder: '1.0.0' })}
            {f('latestAndroid', 'Android latest', { placeholder: '1.0.0' })}
          </div>
          <div className="row">
            {f('minIos', 'iOS minimum', { placeholder: '1.0.0' })}
            {f('latestIos', 'iOS latest', { placeholder: '1.0.0' })}
          </div>
        </fieldset>
        <fieldset>
          <legend>Support contact</legend>
          {f('supportPhone', 'Phone (international)', { placeholder: '+918012345678' })}
          {f('supportEmail', 'Email', { type: 'email' })}
        </fieldset>
        <fieldset>
          <legend>Legal links</legend>
          <p className="muted">
            Links only. The policy documents themselves must be written and approved by the
            business/legal owner, not here. Blank means “not published yet”.
          </p>
          {f('termsUrl', 'Terms of service URL', { placeholder: 'https://…' })}
          {f('privacyUrl', 'Privacy policy URL', { placeholder: 'https://…' })}
          {f('refundPolicyUrl', 'Refund policy URL', { placeholder: 'https://…' })}
        </fieldset>
        {errors.length > 0 ? (
          <ul className="field-error" role="alert">
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Review changes
        </button>
      </form>
      <ConfirmDialog
        open={confirm !== undefined}
        title="Save app configuration?"
        description={
          confirm
            ? `${risky ? `${!confirm.storeOpen ? 'The store will be CLOSED for orders. ' : ''}${confirm.maintenance ? 'Maintenance mode will be ON. ' : ''}` : ''}This replaces the whole configuration and applies to customers within about a minute (public cache). Recorded against your account.`
            : ''
        }
        confirmLabel="Save configuration"
        destructive={!!risky}
        busy={busy}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => {
          if (!confirm) return
          void run('/api/bff/content/app-config', 'PUT', confirm, 'Configuration saved.').then(() =>
            setConfirm(undefined),
          )
        }}
      />
    </>
  )
}
