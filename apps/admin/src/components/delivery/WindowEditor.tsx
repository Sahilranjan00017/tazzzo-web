'use client'

import { useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import {
  DAYS,
  deliveryErrorMessage,
  formatDays,
  minuteToTime,
  timeToMinute,
  windowWriteInput,
  type SlotWindow,
} from '@/lib/delivery'

/**
 * Create or edit one recurring weekly delivery window for a service area. Times are the delivery zone's clock
 * (Asia/Kolkata by default; the backend does not expose the zone to admins). The backend owns capacity and atomic
 * holds, and it may lower capacity below existing holds: no used/remaining count is available here to warn about it.
 */
export function WindowEditor({
  serviceAreaId,
  window: win,
}: {
  serviceAreaId: string
  window?: SlotWindow
}) {
  const { run, busy } = useBffAction(deliveryErrorMessage)
  const [windowId, setWindowId] = useState(win?.windowId ?? '')
  const [label, setLabel] = useState(win?.label ?? '')
  const [start, setStart] = useState(win ? minuteToTime(win.startMinute) : '18:00')
  const [end, setEnd] = useState(win ? minuteToTime(win.endMinute) : '20:00')
  const [cutoff, setCutoff] = useState(String(win?.cutoffMinutes ?? 60))
  const [capacity, setCapacity] = useState(String(win?.capacity ?? 20))
  const [days, setDays] = useState<number[]>(win?.days ?? [1, 2, 3, 4, 5, 6, 7])
  const [errors, setErrors] = useState<string[]>([])
  const [confirm, setConfirm] = useState<ReturnType<typeof windowWriteInput.parse>>()

  function review(e: FormEvent) {
    e.preventDefault()
    const s = timeToMinute(start)
    const en = timeToMinute(end)
    const num = (t: string) => (/^\d{1,9}$/.test(t.trim()) ? Number(t.trim()) : Number.NaN)
    const parsed = windowWriteInput.safeParse({
      serviceAreaId,
      windowId: windowId.trim(),
      label: label.trim(),
      startMinute: s ?? Number.NaN,
      endMinute: en ?? Number.NaN,
      cutoffMinutes: num(cutoff),
      capacity: num(capacity),
      days: [...days].sort((a, b) => a - b),
      ...(win ? { expectedVersion: win.version } : {}),
    })
    if (!parsed.success) {
      const copy: Record<string, string> = {
        windowId: 'Window id: lowercase letters, digits and dashes, up to 32 characters.',
        label: 'Label is required (up to 60 characters).',
        startMinute: 'Start time is not valid.',
        endMinute: 'End time must be after the start time.',
        cutoffMinutes: 'Cut-off must be a whole number of minutes, 0 to 10080.',
        capacity: 'Capacity must be a whole number from 1 to 100000.',
        days: 'Choose at least one day.',
      }
      setErrors([...new Set(parsed.error.issues.map((i) => copy[String(i.path[0])] ?? i.message))])
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
        aria-label={win ? 'Edit delivery window' : 'New delivery window'}
      >
        <label>
          Window id
          <input
            value={windowId}
            disabled={!!win}
            onChange={(e) => setWindowId(e.target.value)}
            maxLength={32}
            aria-describedby="wid-help"
          />
        </label>
        <span id="wid-help" className="muted">
          Lowercase letters, digits and dashes{win ? ' (fixed once created)' : ''}.
        </span>
        <label>
          Label shown to customers
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        </label>
        <div className="row">
          <label>
            Starts
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            Ends
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        <label>
          Order cut-off (minutes before start)
          <input value={cutoff} inputMode="numeric" onChange={(e) => setCutoff(e.target.value)} />
        </label>
        <label>
          Capacity (orders per day)
          <input
            value={capacity}
            inputMode="numeric"
            onChange={(e) => setCapacity(e.target.value)}
          />
        </label>
        <fieldset>
          <legend>Days</legend>
          {DAYS.map((d) => (
            <label key={d.n} className="inline">
              <input
                type="checkbox"
                checked={days.includes(d.n)}
                onChange={(e) =>
                  setDays((cur) =>
                    e.target.checked ? [...cur, d.n] : cur.filter((x) => x !== d.n),
                  )
                }
              />
              {d.label}
            </label>
          ))}
        </fieldset>
        {errors.length > 0 ? (
          <ul className="field-error" role="alert">
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {win ? 'Review changes' : 'Review new window'}
        </button>
      </form>
      <ConfirmDialog
        open={confirm !== undefined}
        title={win ? `Save changes to “${win.label}”?` : 'Create this delivery window?'}
        description={
          confirm
            ? `${confirm.label}: ${minuteToTime(confirm.startMinute)}–${minuteToTime(confirm.endMinute)}, ${formatDays(confirm.days)}, capacity ${confirm.capacity}, cut-off ${confirm.cutoffMinutes} min. Times are the delivery zone's clock. Recorded against your account.`
            : ''
        }
        confirmLabel="Save window"
        busy={busy}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => {
          if (!confirm) return
          const { serviceAreaId: area, windowId: wid, ...body } = confirm
          void run(
            `/api/bff/delivery/slots/${encodeURIComponent(area)}/${encodeURIComponent(wid)}`,
            'PUT',
            body,
            'Delivery window saved.',
          ).then(() => setConfirm(undefined))
        }}
      />
    </>
  )
}
