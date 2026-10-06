'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import { MAX_ROUTES, areaWriteInput, deliveryErrorMessage, type ServiceArea } from '@/lib/delivery'

type RouteRow = { loc: string; priority: string; active: boolean }

/**
 * Create or replace a service area's routing. The backend write is a WHOLE REPLACE of serviceAreaId + routes (it never
 * touches the area's own active flag), so the confirmation says so. Lowest-priority ACTIVE route wins. There is no
 * geo/maps provider here: a pincode is just a validated 6-digit code. Remounted with `key={pincode:version}`.
 */
export function AreaEditor({ area }: { area?: ServiceArea }) {
  const router = useRouter()
  const { run, busy } = useBffAction(deliveryErrorMessage)
  const [pincode, setPincode] = useState(area?.pincode ?? '')
  const [areaId, setAreaId] = useState(area?.serviceAreaId ?? '')
  const [routes, setRoutes] = useState<RouteRow[]>(
    area?.routes.map((r) => ({
      loc: r.fulfillmentLocationId,
      priority: String(r.priority),
      active: r.active,
    })) ?? [],
  )
  const [errors, setErrors] = useState<string[]>([])
  const [confirm, setConfirm] = useState<ReturnType<typeof areaWriteInput.parse>>()

  const setRow = (i: number, patch: Partial<RouteRow>) =>
    setRoutes((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  function review(e: FormEvent) {
    e.preventDefault()
    const candidate = {
      pincode: pincode.trim(),
      serviceAreaId: areaId.trim(),
      routes: routes.map((r) => ({
        fulfillmentLocationId: r.loc.trim(),
        priority: /^\d{1,9}$/.test(r.priority.trim()) ? Number(r.priority.trim()) : Number.NaN,
        active: r.active,
      })),
      ...(area ? { expectedVersion: area.version } : {}),
    }
    const parsed = areaWriteInput.safeParse(candidate)
    if (!parsed.success) {
      const text = parsed.error.issues.map((i) => {
        const where = i.path[0] === 'routes' ? `Route ${Number(i.path[1]) + 1}: ` : ''
        const field = String(i.path.at(-1))
        const friendly =
          field === 'pincode'
            ? 'Pincode must be 6 digits and not start with 0.'
            : field === 'serviceAreaId'
              ? 'Area id is required (letters, digits, space and . _ : -).'
              : field === 'fulfillmentLocationId'
                ? i.message.includes('duplicate')
                  ? 'duplicate location.'
                  : 'location id is not valid.'
                : field === 'priority'
                  ? i.message.includes('duplicate')
                    ? 'duplicate priority (each route needs its own).'
                    : 'priority must be a whole number, 0 or more.'
                  : i.message
        return `${where}${friendly}`
      })
      setErrors([...new Set(text)])
      return
    }
    setErrors([])
    setConfirm(parsed.data)
  }

  return (
    <>
      <form
        className="stack form-narrow"
        onSubmit={review}
        noValidate
        aria-label={area ? 'Edit service area' : 'Create service area'}
      >
        <label>
          Pincode
          <input
            value={pincode}
            onChange={(e) => setPincode(e.target.value)}
            disabled={!!area}
            inputMode="numeric"
            maxLength={6}
          />
        </label>
        <label>
          Service area id (grouping label)
          <input value={areaId} onChange={(e) => setAreaId(e.target.value)} maxLength={128} />
        </label>
        <fieldset>
          <legend>
            Fulfilment routes ({routes.length}/{MAX_ROUTES})
          </legend>
          {routes.length === 0 ? (
            <p className="muted">No routes: the area cannot be served until one is added.</p>
          ) : null}
          {routes.map((r, i) => (
            <div key={i} className="route-row">
              <label>
                Location id
                <input value={r.loc} onChange={(e) => setRow(i, { loc: e.target.value })} />
              </label>
              <label>
                Priority
                <input
                  value={r.priority}
                  inputMode="numeric"
                  onChange={(e) => setRow(i, { priority: e.target.value })}
                />
              </label>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={r.active}
                  onChange={(e) => setRow(i, { active: e.target.checked })}
                />{' '}
                Active
              </label>
              <button
                type="button"
                className="btn"
                onClick={() => setRoutes((rs) => rs.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            disabled={routes.length >= MAX_ROUTES}
            onClick={() =>
              setRoutes((rs) => [...rs, { loc: '', priority: String(rs.length), active: true }])
            }
          >
            Add route
          </button>
          <p className="muted">
            The lowest priority number among active routes wins. Location ids are not checked
            against any registry.
          </p>
        </fieldset>
        {errors.length > 0 ? (
          <ul className="field-error" role="alert">
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {area ? 'Review changes' : 'Review new area'}
        </button>
      </form>
      <ConfirmDialog
        open={confirm !== undefined}
        title={
          area ? `Replace routing for ${area.pincode}?` : `Create service area ${pincode.trim()}?`
        }
        description={
          confirm
            ? `${area ? 'This replaces ALL routes for the area. ' : ''}${confirm.routes.length} route${confirm.routes.length === 1 ? '' : 's'} will be saved. Recorded against your account.`
            : ''
        }
        confirmLabel="Save"
        busy={busy}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => {
          if (!confirm) return
          const { pincode: pin, ...body } = confirm
          void run(
            `/api/bff/delivery/service-areas/${encodeURIComponent(pin)}`,
            'PUT',
            body,
            'Service area saved.',
          ).then((r) => {
            setConfirm(undefined)
            if (r.ok && !area) router.push(`/delivery/service-areas/${encodeURIComponent(pin)}`)
          })
        }}
      />
    </>
  )
}
