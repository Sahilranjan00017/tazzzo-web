'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import {
  LEGAL_BODY_MAX,
  LEGAL_SLUGS,
  LEGAL_SLUG_LABEL,
  PUBLICATION_DELAY_NOTE,
  legalBodyProblem,
  legalErrorMessage,
  legalParagraphs,
  legalUpdateInput,
  legalWriteInput,
  utcToIstLocal,
  validIsoDate,
  windowToUtc,
  type ContentBlock,
} from '@/lib/content'

const FIELD_COPY: Record<string, string> = {
  title: 'Document title: 1 to 80 characters, no < or >. Customers see it as the heading.',
  legalSlug: 'Choose which document this is.',
  endsAt: 'The end time must be after the start time.',
  startsAt: 'The start time is not valid.',
}

const BODY_COPY: Record<string, string> = {
  empty: 'Write the document text.',
  'too-long': `The text is too long: at most ${LEGAL_BODY_MAX.toLocaleString('en-IN')} characters.`,
  untrimmed: 'Remove the blank space or empty lines at the very start and end of the text.',
  'angle-brackets': 'The text cannot contain < or > (formatting codes are not supported).',
  control:
    'The text contains a character that is not allowed (a tab, or an invisible control or direction character). Replace tabs with spaces.',
}

/**
 * Create or edit one legal document (a content block on placement HELP, type LEGAL). A new document is a DRAFT and is
 * not public. The body is PLAIN TEXT: customers see it as paragraphs split at blank lines, nothing else is interpreted.
 * Editing a PUBLISHED document changes the public page, so the confirmation says so. A failed save keeps what was
 * typed (a 60,000-character text must never be lost to a refresh).
 */
export function LegalEditor({ block }: { block?: ContentBlock }) {
  const router = useRouter()
  const { run, busy } = useBffAction((f) => legalErrorMessage(f, true), {
    refreshOnConflict: false,
  })
  const p = block?.payload
  const [slug, setSlug] = useState(p?.legalSlug ?? 'TERMS')
  const [title, setTitle] = useState(block?.title ?? '')
  const [body, setBody] = useState(p?.body ?? '')
  const [date, setDate] = useState(p?.effectiveDate ?? '')
  const [starts, setStarts] = useState(utcToIstLocal(block?.startsAt))
  const [ends, setEnds] = useState(utcToIstLocal(block?.endsAt))
  const [errors, setErrors] = useState<string[]>([])
  const [conflict, setConflict] = useState(false)
  const [confirm, setConfirm] = useState<ReturnType<typeof legalWriteInput.parse>>()
  const archived = block?.status === 'ARCHIVED'
  const dirty =
    !block ||
    slug !== (p?.legalSlug ?? '') ||
    title !== block.title ||
    body !== (p?.body ?? '') ||
    date !== (p?.effectiveDate ?? '') ||
    starts !== utcToIstLocal(block.startsAt) ||
    ends !== utcToIstLocal(block.endsAt)

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function review(e: FormEvent) {
    e.preventDefault()
    const from = starts ? windowToUtc(starts) : undefined
    const to = ends ? windowToUtc(ends) : undefined
    const trimmed = body.trim()
    const base = {
      title: title.trim(),
      sort: block?.sort ?? 0,
      ...(from ? { startsAt: from } : {}),
      ...(to ? { endsAt: to } : {}),
      payload: { legalSlug: slug, body: trimmed, ...(date ? { effectiveDate: date } : {}) },
    }
    const parsed = (block ? legalUpdateInput : legalWriteInput).safeParse(
      block ? { ...base, blockId: block.blockId, expectedVersion: block.version } : base,
    )
    const msgs: string[] = []
    if (starts && !from) msgs.push('The start time is not valid.')
    if (ends && !to) msgs.push('The end time is not valid.')
    const problem = legalBodyProblem(trimmed)
    if (problem) msgs.push(BODY_COPY[problem] ?? 'The text is not valid.')
    if (date && !validIsoDate(date)) msgs.push('The effective date is not a valid date.')
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        const key = String(i.path.at(-1))
        if (key === 'body' || key === 'effectiveDate') continue
        msgs.push(FIELD_COPY[key] ?? i.message)
      }
    }
    setErrors([...new Set(msgs)])
    if (parsed.success && msgs.length === 0) setConfirm(parsed.data)
  }

  const live = block?.status === 'PUBLISHED'
  const slugPath = slug.toLowerCase()
  const paragraphs = legalParagraphs(body)
  return (
    <div className="detail-grid">
      <form
        className="stack"
        onSubmit={review}
        noValidate
        aria-label={block ? 'Edit legal document' : 'New legal document'}
      >
        <label>
          Document
          <select value={slug} disabled={archived} onChange={(e) => setSlug(e.target.value)}>
            {LEGAL_SLUGS.map((s) => (
              <option key={s} value={s}>
                {LEGAL_SLUG_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Document title (shown to customers as the heading)
          <input
            value={title}
            maxLength={80}
            disabled={archived}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Text
          <textarea
            rows={22}
            value={body}
            disabled={archived}
            aria-describedby="legal-body-help"
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <p id="legal-body-help" className="muted">
          <span aria-live="polite">
            {body.length.toLocaleString('en-IN')} / {LEGAL_BODY_MAX.toLocaleString('en-IN')}{' '}
            characters
          </span>
          {body.length > LEGAL_BODY_MAX ? ' (over the limit; shorten it before saving)' : ''}. This
          text is shown to customers as plain paragraphs. Separate paragraphs with a blank line.
          Bold, headings, lists and links are not supported, and &lt; and &gt; are not allowed.
        </p>
        <label>
          Effective date (optional)
          <input
            type="date"
            value={date}
            disabled={archived}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <p className="muted">
          Shown with the document as the date it takes effect. It does not control when the document
          is published.
        </p>
        <fieldset>
          <legend>Publication window (optional, IST)</legend>
          <div className="row">
            <label>
              Starts
              <input
                type="datetime-local"
                value={starts}
                disabled={archived}
                onChange={(e) => setStarts(e.target.value)}
              />
            </label>
            <label>
              Ends
              <input
                type="datetime-local"
                value={ends}
                disabled={archived}
                onChange={(e) => setEnds(e.target.value)}
              />
            </label>
          </div>
          <p className="muted">
            Start is included, end is excluded. Leaving a box blank removes that bound. Only one{' '}
            {LEGAL_SLUG_LABEL[slug] ?? slug} document can be published for any period; to replace
            one, end its window when the new one starts.
          </p>
        </fieldset>
        {errors.length > 0 ? (
          <ul className="field-error" role="alert">
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
        {conflict ? (
          <p className="notice" role="status">
            The save was refused. Your text is still here. If the document changed meanwhile,{' '}
            <button
              type="button"
              className="btn"
              onClick={() => {
                setConflict(false)
                router.refresh()
              }}
            >
              Reload the latest version
            </button>{' '}
            (this discards your edits, so copy them first).
          </p>
        ) : null}
        {archived ? (
          <p className="muted">Archived documents are final and cannot be edited.</p>
        ) : (
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
              {block ? 'Review changes' : 'Review new document'}
            </button>
            {block && dirty ? <span className="muted">Unsaved changes</span> : null}
          </div>
        )}
      </form>
      <section className="panel" aria-labelledby="legal-prev-h">
        <h2 id="legal-prev-h">Customer preview</h2>
        <p className="muted">
          Public page: /{slugPath}. Shown as plain paragraphs
          {date && validIsoDate(date) ? ` · effective ${date}` : ''}.
        </p>
        <h3 className="preview-q">{title.trim() || 'Your document title appears here'}</h3>
        {paragraphs.length === 0 ? (
          <p className="msg-text">The text appears here.</p>
        ) : (
          paragraphs.map((t, i) => (
            <p key={i} className="msg-text">
              {t}
            </p>
          ))
        )}
      </section>
      <ConfirmDialog
        open={confirm !== undefined}
        title={block ? 'Save changes to this document?' : 'Create this document as a draft?'}
        description={
          block
            ? `${live ? 'This document is PUBLISHED: your edit changes the public page. ' : ''}${live ? PUBLICATION_DELAY_NOTE : 'It is not public until published.'}`
            : 'It is created as a draft and is not visible to customers until you publish it.'
        }
        confirmLabel="Save"
        busy={busy}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => {
          if (!confirm) return
          const done = (r: { ok: boolean; data?: unknown; status?: number }) => {
            setConfirm(undefined)
            if (!r.ok && r.status === 409) setConflict(true)
            if (r.ok && !block) {
              const id = (r.data as { blockId?: string } | undefined)?.blockId
              router.push(id ? `/content/legal/${encodeURIComponent(id)}` : '/content/legal')
            }
          }
          if (block) {
            const { blockId, ...rest } = confirm as ReturnType<typeof legalUpdateInput.parse>
            void run(
              `/api/bff/content/legal/${encodeURIComponent(blockId)}`,
              'PUT',
              rest,
              'Document saved.',
            ).then(done)
          } else {
            void run('/api/bff/content/legal', 'POST', confirm, 'Draft created.').then(done)
          }
        }}
      />
    </div>
  )
}

type Action = {
  to: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'
  label: string
  destructive: boolean
  text: string
  done: string
}

const ACTIONS: Record<string, Action[]> = {
  DRAFT: [
    {
      to: 'PUBLISHED',
      label: 'Publish',
      destructive: false,
      text: `This makes the document the one customers read on its public page (subject to its window). Only one document per Terms or Privacy can be published for any period; if another is, the backend refuses and you must unpublish it or end its window first. ${PUBLICATION_DELAY_NOTE}`,
      done: 'Published.',
    },
    {
      to: 'ARCHIVED',
      label: 'Archive',
      destructive: true,
      text: 'Archived documents are final: they cannot be edited or restored.',
      done: 'Archived.',
    },
  ],
  PUBLISHED: [
    {
      to: 'DRAFT',
      label: 'Unpublish',
      destructive: true,
      text: `The document returns to draft and its public page shows “not found” unless another document is published. ${PUBLICATION_DELAY_NOTE}`,
      done: 'Unpublished.',
    },
    {
      to: 'ARCHIVED',
      label: 'Archive',
      destructive: true,
      text: `The document is removed from the public page and cannot be restored. ${PUBLICATION_DELAY_NOTE}`,
      done: 'Archived.',
    },
  ],
}

/** Versioned publish / unpublish / archive with the up-to-60-second public delay and the one-live rule disclosed. */
export function LegalStatusActions({
  blockId,
  status,
  version,
}: {
  blockId: string
  status: string
  version: number
}) {
  const { run, busy } = useBffAction((f) => legalErrorMessage(f, false))
  const [pending, setPending] = useState<Action>()
  const actions = ACTIONS[status] ?? []
  if (actions.length === 0) return <p className="muted">This document is archived; it is final.</p>
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
      </div>
      <ConfirmDialog
        open={pending !== undefined}
        title={pending ? `${pending.label} this document?` : ''}
        description={pending?.text ?? ''}
        confirmLabel={pending?.label ?? 'Confirm'}
        destructive={pending?.destructive}
        busy={busy}
        onCancel={() => setPending(undefined)}
        onConfirm={() => {
          if (!pending) return
          void run(
            `/api/bff/content/blocks/${encodeURIComponent(blockId)}/status`,
            'POST',
            { to: pending.to, expectedVersion: version },
            pending.done,
          ).then(() => setPending(undefined))
        }}
      />
    </>
  )
}
