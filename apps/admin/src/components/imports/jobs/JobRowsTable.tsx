'use client'

import { useRef, useState, type FormEvent } from 'react'
import { useBffAction } from '@/components/useBffAction'
import { StatusBadge } from '@/components/ui/primitives'
import { PRODUCT_ID_PATTERN } from '@/lib/products'
import {
  CORRECTION_FIELDS,
  OUTCOME_TONE,
  buildCorrection,
  effectiveVerdict,
  isCorrectable,
  jobErrorMessage,
  type ImportJob,
  type JobRow,
} from '@/lib/import-jobs'

/**
 * The per-row verdict viewer for one page of rows, and (for a writer, while the job is OPEN or REJECTED) the correction of a
 * row with a negative validation verdict. The backend listing returns only a row's product id and verdicts, never the rest of
 * the stored row, so a correction REPLACES the whole row: every field is entered again. The row is built and checked by the
 * same code as an upload row, so the shared product-id grammar applies and the id is never case-changed.
 */
export function JobRowsTable({
  job,
  rows,
  canCorrect,
}: {
  job: ImportJob
  rows: JobRow[]
  canCorrect: boolean
}) {
  const { run, busy } = useBffAction((failure) => jobErrorMessage(failure, 'correction'))
  const [editing, setEditing] = useState<JobRow>()
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<string[]>([])
  const heading = useRef<HTMLHeadingElement>(null)

  function open(row: JobRow) {
    setEditing(row)
    setValues({ id: row.id ?? '', classificationStatus: 'provisional', market: 'IN' })
    setErrors([])
    // The panel mounts after this render; move keyboard focus to its heading once it exists.
    setTimeout(() => heading.current?.focus(), 0)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    const built = buildCorrection(values)
    if (!built.ok) return setErrors(built.errors)
    setErrors([])
    const result = await run(
      `/api/bff/imports/jobs/${encodeURIComponent(job.id)}/rows/${editing.row}`,
      'PUT',
      { product: built.value },
      `Row ${editing.row} replaced. The job is open again; validate to re-check it.`,
    )
    if (result.ok) setEditing(undefined)
  }

  return (
    <>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Row verdicts">
        <table className="data-table">
          <caption className="sr-only">
            Rows {rows[0]?.row ?? 0} to {rows[rows.length - 1]?.row ?? 0} with their validation and
            apply verdicts
          </caption>
          <thead>
            <tr>
              <th scope="col">Row</th>
              <th scope="col">Product id</th>
              <th scope="col">Verdict</th>
              <th scope="col">Code</th>
              <th scope="col">Detail</th>
              {canCorrect ? <th scope="col">Fix</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const v = effectiveVerdict(r)
              return (
                <tr key={r.row}>
                  <th scope="row">{r.row}</th>
                  <td>{r.id ? <code>{r.id}</code> : '—'}</td>
                  <td>
                    {v ? (
                      <StatusBadge tone={OUTCOME_TONE[v.outcome] ?? 'neutral'}>
                        {v.outcome.toLowerCase().replaceAll('_', ' ')}
                        <span className="sr-only"> ({v.phase})</span>
                      </StatusBadge>
                    ) : (
                      <span className="muted">not checked yet</span>
                    )}
                  </td>
                  <td>{v?.code ?? ''}</td>
                  <td className="wrap">{v?.message ?? ''}</td>
                  {canCorrect ? (
                    <td>
                      {isCorrectable(r) ? (
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => open(r)}
                          aria-label={`Correct row ${r.row}`}
                        >
                          Correct
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {editing ? (
        <section className="panel" aria-labelledby="row-fix-h">
          <h3 id="row-fix-h" ref={heading} tabIndex={-1}>
            Correct row {editing.row}
          </h3>
          <p className="muted">
            The backend does not return the stored row, so this replaces the whole row: enter every
            field. The product id must be TZP- followed by letters, digits or hyphens, and is saved
            exactly as typed.
          </p>
          <form
            className="stack form-narrow"
            onSubmit={(e) => void submit(e)}
            noValidate
            aria-label={`Correct row ${editing.row}`}
          >
            {CORRECTION_FIELDS.map((f) => (
              <label key={f.key}>
                {f.label}
                {f.required ? ' *' : ''}
                <input
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  {...(f.key === 'id'
                    ? { pattern: PRODUCT_ID_PATTERN, autoCapitalize: 'off', spellCheck: false }
                    : {})}
                />
                {f.help ? <span className="muted">{f.help}</span> : null}
              </label>
            ))}
            {errors.length ? (
              <ul className="field-error" role="alert">
                {errors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : null}
            <div className="row">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Replace row {editing.row}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </>
  )
}
