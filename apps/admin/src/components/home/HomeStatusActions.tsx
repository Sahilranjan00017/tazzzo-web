'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import { PUBLICATION_DELAY_NOTE } from '@/lib/content'
import {
  AUDIENCE_LABEL,
  audienceOf,
  homeErrorMessage,
  scheduleText,
  type HomeBlock,
} from '@/lib/home-content'

type Action = {
  to: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'
  label: string
  destructive: boolean
  text: string
  done: string
}

function actionsFor(b: HomeBlock): Action[] {
  const where = `${AUDIENCE_LABEL[audienceOf(b.audience)]} (${scheduleText(b)})`
  const archive: Action = {
    to: 'ARCHIVED',
    label: 'Archive',
    destructive: true,
    text: `Archived blocks are final: they cannot be edited, published or restored, and leave the Home order.${b.status === 'PUBLISHED' ? ` It is removed from ${where}. ${PUBLICATION_DELAY_NOTE}` : ''}`,
    done: 'Archived.',
  }
  if (b.status === 'DRAFT')
    return [
      {
        to: 'PUBLISHED',
        label: 'Publish',
        destructive: false,
        text: `Customers on ${where} will see this block while it is inside its schedule. ${PUBLICATION_DELAY_NOTE}`,
        done: 'Published.',
      },
      archive,
    ]
  if (b.status === 'PUBLISHED')
    return [
      {
        to: 'DRAFT',
        label: 'Unpublish',
        destructive: false,
        text: `The block returns to draft and is removed from ${where}. ${PUBLICATION_DELAY_NOTE}`,
        done: 'Unpublished.',
      },
      archive,
    ]
  return []
}

/** Publish / unpublish (back to draft) / archive, each confirmed and versioned; plus "Duplicate as new draft". */
export function HomeStatusActions({ block }: { block: HomeBlock }) {
  const { run, busy } = useBffAction(homeErrorMessage)
  const [pending, setPending] = useState<Action>()
  const actions = actionsFor(block)
  return (
    <>
      <div className="row">
        {actions.map((a) => (
          <button
            key={a.to}
            type="button"
            className={a.destructive ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={busy}
            onClick={() => setPending(a)}
          >
            {a.label}
          </button>
        ))}
        <Link
          className="btn"
          href={`/content/home/new?type=${block.type}&from=${encodeURIComponent(block.blockId)}`}
        >
          Duplicate as new draft
        </Link>
      </div>
      {actions.length === 0 ? <p className="muted">This block is archived; it is final.</p> : null}
      <ConfirmDialog
        open={pending !== undefined}
        title={pending ? `${pending.label} “${block.title}”?` : ''}
        description={pending?.text ?? ''}
        confirmLabel={pending?.label ?? 'Confirm'}
        destructive={pending?.destructive}
        busy={busy}
        onCancel={() => setPending(undefined)}
        onConfirm={() => {
          if (!pending) return
          void run(
            `/api/bff/content/blocks/${encodeURIComponent(block.blockId)}/status`,
            'POST',
            { to: pending.to, expectedVersion: block.version },
            pending.done,
          ).then(() => setPending(undefined))
        }}
      />
    </>
  )
}
