'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import {
  FAQ_CATEGORIES,
  FAQ_CATEGORY_LABEL,
  PUBLICATION_DELAY_NOTE,
  contentErrorMessage,
  faqUpdateInput,
  faqWriteInput,
  utcToIstLocal,
  windowToUtc,
  type ContentBlock,
} from '@/lib/content'

const FIELD_COPY: Record<string, string> = {
  title: 'Internal title: 1 to 80 characters, no < or >.',
  question: 'Question: 1 to 200 characters, one line, no < or >.',
  answer: 'Answer: 1 to 2000 characters, no < or >.',
  sort: 'Order: a whole number from 0 to 10000.',
  faqCategory: 'Choose a category.',
  endsAt: 'The end time must be after the start time.',
  startsAt: 'The start time is not valid.',
}

/**
 * Create or edit one help-centre FAQ (a content block on placement HELP, type FAQ). A new entry is a DRAFT and is not
 * public. Editing a PUBLISHED entry changes live content, so the confirmation says so. Leaving a publication bound blank
 * CLEARS it (backend full-replace). The preview is the customer-facing text as plain text, never HTML.
 */
export function FaqEditor({ block }: { block?: ContentBlock }) {
  const router = useRouter()
  const { run, busy } = useBffAction(contentErrorMessage)
  const p = block?.payload
  const [title, setTitle] = useState(block?.title ?? '')
  const [category, setCategory] = useState(p?.faqCategory ?? 'DELIVERY')
  const [question, setQuestion] = useState(p?.question ?? '')
  const [answer, setAnswer] = useState(p?.answer ?? '')
  const [sort, setSort] = useState(String(block?.sort ?? 0))
  const [starts, setStarts] = useState(utcToIstLocal(block?.startsAt))
  const [ends, setEnds] = useState(utcToIstLocal(block?.endsAt))
  const [errors, setErrors] = useState<string[]>([])
  const [confirm, setConfirm] = useState<ReturnType<typeof faqWriteInput.parse>>()
  const archived = block?.status === 'ARCHIVED'
  const dirty =
    !block ||
    title !== block.title ||
    category !== (p?.faqCategory ?? '') ||
    question !== (p?.question ?? '') ||
    answer !== (p?.answer ?? '') ||
    sort !== String(block.sort) ||
    starts !== utcToIstLocal(block.startsAt) ||
    ends !== utcToIstLocal(block.endsAt)

  useEffect(() => {
    if (!dirty || !block) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, block])

  function review(e: FormEvent) {
    e.preventDefault()
    const from = starts ? windowToUtc(starts) : undefined
    const to = ends ? windowToUtc(ends) : undefined
    const base = {
      title: title.trim() || question.trim().slice(0, 80),
      sort: /^\d{1,5}$/.test(sort.trim()) ? Number(sort.trim()) : Number.NaN,
      ...(from ? { startsAt: from } : {}),
      ...(to ? { endsAt: to } : {}),
      payload: { faqCategory: category, question, answer },
    }
    const parsed = (block ? faqUpdateInput : faqWriteInput).safeParse(
      block ? { ...base, blockId: block.blockId, expectedVersion: block.version } : base,
    )
    const msgs: string[] = []
    if (starts && !from) msgs.push('The start time is not valid.')
    if (ends && !to) msgs.push('The end time is not valid.')
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        const key = String(i.path.at(-1))
        msgs.push(FIELD_COPY[key] ?? i.message)
      }
    }
    setErrors([...new Set(msgs)])
    if (parsed.success && msgs.length === 0) setConfirm(parsed.data)
  }

  const live = block?.status === 'PUBLISHED'
  return (
    <div className="detail-grid">
      <form
        className="stack"
        onSubmit={review}
        noValidate
        aria-label={block ? 'Edit FAQ' : 'New FAQ'}
      >
        <label>
          Category
          <select
            value={category}
            disabled={archived}
            onChange={(e) => setCategory(e.target.value)}
          >
            {FAQ_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {FAQ_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Question
          <input
            value={question}
            maxLength={200}
            disabled={archived}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <label>
          Answer
          <textarea
            rows={7}
            value={answer}
            maxLength={2000}
            disabled={archived}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </label>
        <p className="muted">
          {answer.length}/2000. Plain text only; line breaks are kept. No &lt; or &gt;.
        </p>
        <label>
          Internal title (CMS only; defaults to the question)
          <input
            value={title}
            maxLength={80}
            disabled={archived}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Order (lower shows first within a category)
          <input
            value={sort}
            inputMode="numeric"
            disabled={archived}
            onChange={(e) => setSort(e.target.value)}
          />
        </label>
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
            Start is included, end is excluded. Leaving a box blank removes that bound.
          </p>
        </fieldset>
        {errors.length > 0 ? (
          <ul className="field-error" role="alert">
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
        {archived ? (
          <p className="muted">Archived entries are final and cannot be edited.</p>
        ) : (
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
              {block ? 'Review changes' : 'Review new FAQ'}
            </button>
            {block && dirty ? <span className="muted">Unsaved changes</span> : null}
          </div>
        )}
      </form>
      <section className="panel" aria-labelledby="prev-h">
        <h2 id="prev-h">Customer preview</h2>
        <p className="muted">{FAQ_CATEGORY_LABEL[category] ?? category}</p>
        <h3 className="preview-q">{question || 'Your question appears here'}</h3>
        <p className="msg-text">{answer || 'Your answer appears here.'}</p>
      </section>
      <ConfirmDialog
        open={confirm !== undefined}
        title={block ? 'Save changes to this FAQ?' : 'Create this FAQ as a draft?'}
        description={
          block
            ? `${live ? 'This entry is PUBLISHED: your edit changes what customers see. ' : ''}${live ? PUBLICATION_DELAY_NOTE : 'It is not public until published.'}`
            : 'It is created as a draft and is not visible to customers until you publish it.'
        }
        confirmLabel="Save"
        busy={busy}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => {
          if (!confirm) return
          const done = (r: { ok: boolean; data?: unknown }) => {
            setConfirm(undefined)
            if (r.ok && !block) {
              const id = (r.data as { blockId?: string } | undefined)?.blockId
              router.push(id ? `/content/faqs/${encodeURIComponent(id)}` : '/content/faqs')
            }
          }
          if (block) {
            const { blockId, ...body } = confirm as ReturnType<typeof faqUpdateInput.parse>
            void run(
              `/api/bff/content/blocks/${encodeURIComponent(blockId)}`,
              'PUT',
              body,
              'FAQ saved.',
            ).then(done)
          } else {
            void run('/api/bff/content/faqs', 'POST', confirm, 'Draft created.').then(done)
          }
        }}
      />
    </div>
  )
}

const ACTIONS: Record<
  string,
  {
    to: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'
    label: string
    destructive: boolean
    text: string
    done: string
  }[]
> = {
  DRAFT: [
    {
      to: 'PUBLISHED',
      label: 'Publish',
      destructive: false,
      text: `This makes the FAQ visible to customers (subject to its window). ${PUBLICATION_DELAY_NOTE}`,
      done: 'Published.',
    },
    {
      to: 'ARCHIVED',
      label: 'Archive',
      destructive: true,
      text: 'Archived entries are final: they cannot be edited or restored.',
      done: 'Archived.',
    },
  ],
  PUBLISHED: [
    {
      to: 'DRAFT',
      label: 'Unpublish',
      destructive: false,
      text: `The FAQ returns to draft and is removed from the public help centre. ${PUBLICATION_DELAY_NOTE}`,
      done: 'Unpublished.',
    },
    {
      to: 'ARCHIVED',
      label: 'Archive',
      destructive: true,
      text: `The FAQ is removed and cannot be restored. ${PUBLICATION_DELAY_NOTE}`,
      done: 'Archived.',
    },
  ],
}

/** Versioned publish / unpublish / archive with a disclosure of the up-to-60-second public delay. */
export function FaqStatusActions({
  blockId,
  status,
  version,
}: {
  blockId: string
  status: string
  version: number
}) {
  const { run, busy } = useBffAction(contentErrorMessage)
  const [pending, setPending] = useState<(typeof ACTIONS)[string][number]>()
  const actions = ACTIONS[status] ?? []
  if (actions.length === 0) return <p className="muted">This entry is archived; it is final.</p>
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
        title={pending ? `${pending.label} this FAQ?` : ''}
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
