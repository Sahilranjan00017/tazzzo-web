'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState, type DragEvent } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { StatusBadge } from '@/components/ui/primitives'
import { useBffAction } from '@/components/useBffAction'
import { PUBLICATION_DELAY_NOTE } from '@/lib/content'
import { formatShortIst } from '@/lib/format'
import {
  AUDIENCE_LABEL,
  EFFECTIVE_LABEL,
  EFFECTIVE_TONE,
  TYPE_LABEL,
  actorLabel,
  audienceOf,
  buildReorder,
  effectiveOf,
  homeErrorMessage,
  move,
  scheduleText,
  type HomeBlock,
  type HomeType,
} from '@/lib/home-content'

/**
 * HOME blocks in display order. Writers can switch to reorder mode: drag a row by its handle, or use the Move up / Move
 * down buttons (keyboard), then save the whole order as ONE call carrying every non-archived block with the version it
 * was loaded at. A conflict keeps the new order on screen and offers a reload. Readers get the table only.
 */
export function HomeBlockTable({
  blocks,
  canWrite,
  nowMs,
  filtered,
}: {
  blocks: HomeBlock[]
  canWrite: boolean
  nowMs: number
  /** A status/channel filter is applied: the list is partial, so reordering is not offered. */
  filtered: boolean
}) {
  const router = useRouter()
  const { run, busy } = useBffAction(homeErrorMessage, { refreshOnConflict: false })
  const active = blocks.filter((b) => b.status !== 'ARCHIVED')
  const loadedOrder = active.map((b) => b.blockId)
  const [ordering, setOrdering] = useState(false)
  const [order, setOrder] = useState<string[]>(loadedOrder)
  const [confirm, setConfirm] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [announce, setAnnounce] = useState('')
  const [dragging, setDragging] = useState<string>()
  const buttons = useRef(new Map<string, HTMLButtonElement | null>())
  const byId = new Map(blocks.map((b) => [b.blockId, b]))
  const changed = order.join() !== loadedOrder.join()
  const rows = ordering ? order.map((id) => byId.get(id)!).filter(Boolean) : blocks
  const canReorder = canWrite && !filtered && active.length > 1

  function shift(id: string, delta: -1 | 1) {
    const from = order.indexOf(id)
    const next = move(order, from, from + delta)
    if (next === order) return
    setOrder(next)
    const title = byId.get(id)?.title ?? id
    setAnnounce(`${title} moved to position ${next.indexOf(id) + 1} of ${next.length}.`)
    // Keep keyboard focus on the moved row's same control (or the other one at an edge).
    requestAnimationFrame(() => {
      const at = next.indexOf(id)
      const dir = at === 0 ? 'down' : at === next.length - 1 ? 'up' : delta < 0 ? 'up' : 'down'
      buttons.current.get(`${id}:${dir}`)?.focus()
    })
  }
  const onDrop = (e: DragEvent, targetId: string) => {
    e.preventDefault()
    const id = dragging ?? e.dataTransfer.getData('text/plain')
    setDragging(undefined)
    if (!id || id === targetId) return
    const next = move(order, order.indexOf(id), order.indexOf(targetId))
    setOrder(next)
    setAnnounce(`${byId.get(id)?.title ?? id} moved to position ${next.indexOf(id) + 1}.`)
  }

  return (
    <>
      {conflict ? (
        <div className="notice" role="alert">
          <p>
            Home content changed since you loaded it (a block was edited, added or archived), so the
            new order was not saved. Your order is still shown. Reloading shows the latest list and
            discards it.
          </p>
          <button type="button" className="btn" onClick={() => router.refresh()}>
            Reload latest version
          </button>
        </div>
      ) : null}
      {canWrite ? (
        <div className="row">
          {ordering ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !changed || conflict}
                onClick={() => setConfirm(true)}
              >
                Save order
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setOrdering(false)
                  setOrder(loadedOrder)
                  setConflict(false)
                }}
              >
                Cancel reorder
              </button>
              <span className="muted">
                Drag a row by its handle, or use Move up / Move down. Archived blocks are not part
                of the order.
              </span>
            </>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={!canReorder || busy}
              onClick={() => {
                setOrder(loadedOrder)
                setOrdering(true)
              }}
            >
              Reorder
            </button>
          )}
          {canWrite && filtered ? (
            <span className="muted">Clear the filters to reorder.</span>
          ) : null}
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Home blocks">
        <table className="data-table">
          <caption className="sr-only">
            {rows.length} Home blocks{ordering ? ', reorder mode' : ''}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="num">
                #
              </th>
              <th scope="col">Title</th>
              <th scope="col">Type</th>
              <th scope="col">Channel</th>
              <th scope="col">Status</th>
              <th scope="col">Schedule (IST)</th>
              <th scope="col">Author / last change</th>
              {ordering ? <th scope="col">Move</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((b, i) => {
              const eff = effectiveOf(b, nowMs)
              return (
                <tr
                  key={b.blockId}
                  className={dragging === b.blockId ? 'row-dragging' : undefined}
                  onDragOver={ordering ? (e) => e.preventDefault() : undefined}
                  onDrop={ordering ? (e) => onDrop(e, b.blockId) : undefined}
                >
                  <td className="num">{ordering ? i + 1 : b.sort}</td>
                  <th scope="row" className="wrap">
                    {ordering ? (
                      <span
                        className="drag-handle"
                        draggable
                        aria-hidden="true"
                        title="Drag to reorder"
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', b.blockId)
                          e.dataTransfer.effectAllowed = 'move'
                          setDragging(b.blockId)
                        }}
                        onDragEnd={() => setDragging(undefined)}
                      >
                        ⠿
                      </span>
                    ) : null}
                    <Link href={`/content/home/${encodeURIComponent(b.blockId)}`}>{b.title}</Link>
                  </th>
                  <td>{TYPE_LABEL[b.type as HomeType] ?? b.type}</td>
                  <td>{AUDIENCE_LABEL[audienceOf(b.audience)]}</td>
                  <td>
                    <StatusBadge tone={EFFECTIVE_TONE[eff]}>{EFFECTIVE_LABEL[eff]}</StatusBadge>
                  </td>
                  <td>{scheduleText(b)}</td>
                  <td className="wrap">
                    <span className="muted">by</span> {actorLabel(b.createdBy)}
                    <br />
                    <span className="muted">last</span> {actorLabel(b.updatedBy)}
                    {b.updatedAt ? ` · ${formatShortIst(b.updatedAt)} IST` : ''}
                  </td>
                  {ordering ? (
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn-icon"
                          ref={(el) => void buttons.current.set(`${b.blockId}:up`, el)}
                          aria-label={`Move ${b.title} up`}
                          disabled={i === 0 || busy}
                          onClick={() => shift(b.blockId, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon"
                          ref={(el) => void buttons.current.set(`${b.blockId}:down`, el)}
                          aria-label={`Move ${b.title} down`}
                          disabled={i === rows.length - 1 || busy}
                          onClick={() => shift(b.blockId, 1)}
                        >
                          ↓
                        </button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Save the new Home order?"
        description={`This re-sequences all ${order.length} active Home blocks for every channel in one step. ${PUBLICATION_DELAY_NOTE}`}
        confirmLabel="Save order"
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          const body = buildReorder(blocks, order)
          if (!body) return setConfirm(false)
          void run('/api/bff/content/home/reorder', 'POST', body, 'Order saved.').then((r) => {
            setConfirm(false)
            if (r.ok) setOrdering(false)
            else if (r.status === 409) setConflict(true)
          })
        }}
      />
    </>
  )
}
