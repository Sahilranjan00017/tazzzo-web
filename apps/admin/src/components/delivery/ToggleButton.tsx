'use client'

import { useState } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import { deliveryErrorMessage } from '@/lib/delivery'

/** Versioned activate/deactivate with confirmation (shared by service areas and delivery windows). */
export function ToggleButton({
  path,
  active,
  version,
  noun,
  consequence,
}: {
  /** BFF base, without the trailing action (e.g. `/api/bff/delivery/service-areas/560047`). */
  path: string
  active: boolean
  version: number
  noun: string
  consequence: string
}) {
  const { run, busy } = useBffAction(deliveryErrorMessage)
  const [open, setOpen] = useState(false)
  const action = active ? 'deactivate' : 'activate'
  return (
    <>
      <button
        type="button"
        className={active ? 'btn btn-danger' : 'btn'}
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        {active ? 'Deactivate' : 'Activate'}
      </button>
      <ConfirmDialog
        open={open}
        title={`${active ? 'Deactivate' : 'Activate'} this ${noun}?`}
        description={consequence}
        confirmLabel={active ? 'Deactivate' : 'Activate'}
        destructive={active}
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={() =>
          void run(
            `${path}/${action}`,
            'POST',
            { expectedVersion: version },
            `${noun} ${active ? 'deactivated' : 'activated'}.`,
          ).then(() => setOpen(false))
        }
      />
    </>
  )
}
