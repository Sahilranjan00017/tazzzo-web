'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { StatusBadge, type Tone } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/Toast'
import { bffErrorMessage, callBff } from '@/lib/bff-client'
import {
  FIELDS,
  IMPORT_KINDS,
  MAX_FILE_BYTES,
  MAX_ROWS_PER_REQUEST,
  autoMap,
  buildRows,
  chunk,
  missingRequired,
  parseCsv,
  templateCsv,
  toCsv,
  type BuiltRow,
  type ImportKind,
  type ImportReport,
  type RowError,
} from '@/lib/imports'

const KIND_LABEL: Record<ImportKind, string> = {
  products: 'Products (single-SKU drafts)',
  prices: 'Prices',
  inventory: 'Stock',
}

type RowStatus = { tone: Tone; label: string; detail?: string }
type Phase = 'pick' | 'map' | 'validating' | 'validated' | 'applying' | 'done'

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Bulk import. Parse CSV locally, map columns, validate locally with the same schemas the BFF enforces, then ask the
 * backend to validate (dry run, nothing written), confirm explicitly, and apply in chunks of at most 500 rows. The
 * backend is the final authority: a rejected chunk writes nothing and its row errors are shown here. Never retried
 * automatically; a retry is an explicit action limited to rows that were not attempted.
 */
export function ImportWizard() {
  const { toast } = useToast()
  const [kind, setKind] = useState<ImportKind>('prices')
  const [fileName, setFileName] = useState('')
  const [table, setTable] = useState<{ header: string[]; rows: string[][] }>()
  const [map, setMap] = useState<Record<string, number>>({})
  const [phase, setPhase] = useState<Phase>('pick')
  const [problem, setProblem] = useState<string>()
  const [skipInvalid, setSkipInvalid] = useState(false)
  const [serverErrors, setServerErrors] = useState<Map<number, RowError>>(new Map())
  const [results, setResults] = useState<
    Map<number, { outcome: string; code?: string | null; message?: string | null }>
  >(new Map())
  const [summary, setSummary] = useState<{
    applied: number
    failed: number
    unchanged: number
    notAttempted: number
  }>()
  const [confirm, setConfirm] = useState(false)
  const [progress, setProgress] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const built: BuiltRow[] = useMemo(
    () => (table ? buildRows(kind, table.rows, map) : []),
    [kind, table, map],
  )
  const missing = table ? missingRequired(kind, map) : []
  const invalid = built.filter((b) => !b.value)
  const sendable = built.filter((b) => b.value)
  const blocked =
    missing.length > 0 || sendable.length === 0 || (invalid.length > 0 && !skipInvalid)

  async function onFile(file: File | undefined) {
    setProblem(undefined)
    if (!file) return
    if (!/\.csv$/i.test(file.name))
      return setProblem('Only .csv files are supported. Export your spreadsheet as CSV (UTF-8).')
    if (file.size > MAX_FILE_BYTES) return setProblem('The file is larger than 2 MiB. Split it.')
    const parsed = parseCsv(await file.text())
    if (!parsed.ok) return setProblem(parsed.reason)
    setFileName(file.name)
    setTable({ header: parsed.header, rows: parsed.rows })
    setMap(autoMap(kind, parsed.header))
    setServerErrors(new Map())
    setResults(new Map())
    setSummary(undefined)
    setPhase('map')
  }

  // A file chosen before hydration finished is still on the input but unknown to React state: pick it up once.
  useEffect(() => {
    const f = fileInput.current?.files?.[0]
    if (f) void onFile(f)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function reset() {
    setTable(undefined)
    setFileName('')
    setPhase('pick')
    setServerErrors(new Map())
    setResults(new Map())
    setSummary(undefined)
    setProblem(undefined)
  }

  async function runChunks(rows: BuiltRow[], dryRun: boolean) {
    const errs = new Map<number, RowError>()
    const out = new Map<
      number,
      { outcome: string; code?: string | null; message?: string | null }
    >()
    const totals = { applied: 0, failed: 0, unchanged: 0, notAttempted: 0 }
    const chunks = chunk(rows)
    for (const [i, part] of chunks.entries()) {
      setProgress(`${dryRun ? 'Validating' : 'Applying'} batch ${i + 1} of ${chunks.length}…`)
      const r = await callBff<ImportReport>(`/api/bff/imports/${kind}`, 'POST', {
        dryRun,
        rows: part.map((b) => b.value),
      })
      if (!r.ok) {
        const detail = r.detail
        if (r.status === 422 && r.code === 'INVALID_IMPORT' && Array.isArray(detail)) {
          for (const e of detail as RowError[]) {
            const target = part[e.row]
            if (target) errs.set(target.line, e)
          }
          if (!dryRun) {
            setProblem(
              'The backend rejected a batch and wrote nothing from it. Fix the rows listed and re-validate.',
            )
            return { errs, out, totals, stopped: true }
          }
          continue
        }
        setProblem(
          r.status === 422
            ? 'The backend rejected the file as invalid without row details.'
            : bffErrorMessage(r, 'import'),
        )
        return { errs, out, totals, stopped: true }
      }
      for (const res of r.data.results) {
        const target = part[res.row]
        if (target)
          out.set(target.line, { outcome: res.outcome, code: res.code, message: res.message })
      }
      totals.applied += r.data.applied
      totals.failed += r.data.failed
      totals.unchanged += r.data.unchanged
      totals.notAttempted += r.data.notAttempted
      if (!dryRun && r.data.notAttempted > 0) {
        setProblem(
          'The backend stopped part-way (datastore unavailable). Review which rows were not attempted.',
        )
        return { errs, out, totals, stopped: true }
      }
    }
    return { errs, out, totals, stopped: false }
  }

  async function validate() {
    setProblem(undefined)
    setPhase('validating')
    const r = await runChunks(sendable, true)
    setServerErrors(r.errs)
    setResults(r.out)
    if (r.stopped) return setPhase('map')
    if (r.errs.size > 0) {
      setProblem(
        `The backend rejected ${r.errs.size} row${r.errs.size === 1 ? '' : 's'}. Fix them in your file and re-upload, or exclude them.`,
      )
      return setPhase('map')
    }
    setPhase('validated')
  }

  async function apply(rows: BuiltRow[]) {
    setConfirm(false)
    setProblem(undefined)
    setPhase('applying')
    const r = await runChunks(rows, false)
    setResults((prev) => new Map([...prev, ...r.out]))
    setSummary(r.totals)
    setPhase('done')
    toast(
      r.totals.failed > 0 || r.stopped ? 'error' : 'success',
      `Import finished: ${r.totals.applied} applied, ${r.totals.failed} failed.`,
    )
  }

  const statusOf = (b: BuiltRow): RowStatus => {
    const res = results.get(b.line)
    if (res) {
      const tone: Tone =
        res.outcome === 'APPLIED' || res.outcome === 'VALID'
          ? 'success'
          : res.outcome === 'UNCHANGED'
            ? 'neutral'
            : 'danger'
      return {
        tone,
        label: res.outcome.toLowerCase().replace('_', ' '),
        detail: res.message ?? res.code ?? undefined,
      }
    }
    const se = serverErrors.get(b.line)
    if (se) return { tone: 'danger', label: 'rejected', detail: `${se.code}: ${se.message}` }
    if (b.errors.length) return { tone: 'danger', label: 'invalid', detail: b.errors.join(' ') }
    return { tone: 'neutral', label: 'ready' }
  }

  const failedRows = built.filter((b) =>
    ['FAILED', 'NOT_ATTEMPTED'].includes(results.get(b.line)?.outcome ?? ''),
  )
  const retryable = built.filter((b) => results.get(b.line)?.outcome === 'NOT_ATTEMPTED')

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="imp-1">
        <h2 id="imp-1">1. Choose what to import</h2>
        <div className="filters">
          <label>
            Import type
            <select
              value={kind}
              disabled={phase !== 'pick' && phase !== 'map'}
              onChange={(e) => {
                setKind(e.target.value as ImportKind)
                reset()
              }}
            >
              {IMPORT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            CSV file (UTF-8, up to 2 MiB)
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              disabled={phase === 'validating' || phase === 'applying'}
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </label>
          <button
            type="button"
            className="btn"
            onClick={() => download(`tazzzo-${kind}-template.csv`, templateCsv(kind))}
          >
            Download template
          </button>
        </div>
        <p className="muted">
          CSV only. The backend takes {MAX_ROWS_PER_REQUEST} rows per request; larger files are sent
          in batches. Prices are in rupees. Spreadsheet formulas are never evaluated, and exported
          files neutralise leading = + - @.
        </p>
        {problem ? (
          <p className="field-error" role="alert">
            {problem}
          </p>
        ) : null}
      </section>

      {table ? (
        <section className="panel" aria-labelledby="imp-2">
          <h2 id="imp-2">
            2. Map columns ({fileName}, {table.rows.length} rows)
          </h2>
          <div className="map-grid">
            {FIELDS[kind].map((f) => (
              <label key={f.key}>
                {f.label}
                {f.required ? ' *' : ''}
                <select
                  value={map[f.key] ?? -1}
                  disabled={phase !== 'map'}
                  onChange={(e) => setMap({ ...map, [f.key]: Number(e.target.value) })}
                >
                  <option value={-1}>— not in file —</option>
                  {table.header.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `(column ${i + 1})`}
                    </option>
                  ))}
                </select>
                {f.help ? <span className="muted">{f.help}</span> : null}
              </label>
            ))}
          </div>
          {missing.length ? (
            <p className="field-error" role="alert">
              Map these required fields: {missing.join(', ')}.
            </p>
          ) : null}
        </section>
      ) : null}

      {table && missing.length === 0 ? (
        <section className="panel" aria-labelledby="imp-3">
          <h2 id="imp-3">3. Review</h2>
          <p>
            <StatusBadge tone="success">{sendable.length} valid</StatusBadge>{' '}
            <StatusBadge tone={invalid.length ? 'danger' : 'neutral'}>
              {invalid.length} with errors
            </StatusBadge>
          </p>
          {invalid.length > 0 && phase === 'map' ? (
            <label className="inline">
              <input
                type="checkbox"
                checked={skipInvalid}
                onChange={(e) => setSkipInvalid(e.target.checked)}
              />
              Skip the {invalid.length} invalid rows and import only the valid ones
            </label>
          ) : null}
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Import preview">
            <table className="data-table">
              <caption className="sr-only">
                First 100 rows of the file with their validation state
              </caption>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Key</th>
                  <th scope="col">State</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {built.slice(0, 100).map((b) => {
                  const s = statusOf(b)
                  return (
                    <tr key={b.line}>
                      <th scope="row">{b.line}</th>
                      <td>{b.key || '—'}</td>
                      <td>
                        <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
                      </td>
                      <td className="wrap">{s.detail ?? ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {built.length > 100 ? (
            <p className="muted">
              Showing the first 100 of {built.length} rows. Invalid rows beyond that are still
              counted above.
            </p>
          ) : null}
          <div className="row">
            {phase === 'map' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={blocked}
                onClick={() => void validate()}
              >
                Validate with the backend (dry run)
              </button>
            ) : null}
            {phase === 'validated' ? (
              <button type="button" className="btn btn-primary" onClick={() => setConfirm(true)}>
                Apply {sendable.length} rows…
              </button>
            ) : null}
            {phase === 'validating' || phase === 'applying' ? (
              <span role="status">{progress}</span>
            ) : null}
            <button
              type="button"
              className="btn"
              disabled={phase === 'validating' || phase === 'applying'}
              onClick={reset}
            >
              Start over
            </button>
          </div>
          {phase === 'validated' ? (
            <p className="notice" role="status">
              The dry run passed for all {sendable.length} rows. A dry run does not check version
              conflicts, so some rows can still fail when applied.
            </p>
          ) : null}
        </section>
      ) : null}

      {phase === 'done' && summary ? (
        <section className="panel" aria-labelledby="imp-4">
          <h2 id="imp-4">4. Result</h2>
          <p>
            <StatusBadge tone="success">{summary.applied} applied</StatusBadge>{' '}
            <StatusBadge tone="neutral">{summary.unchanged} unchanged</StatusBadge>{' '}
            <StatusBadge tone={summary.failed ? 'danger' : 'neutral'}>
              {summary.failed} failed
            </StatusBadge>{' '}
            <StatusBadge tone={summary.notAttempted ? 'warning' : 'neutral'}>
              {summary.notAttempted} not attempted
            </StatusBadge>
          </p>
          <div className="row">
            {failedRows.length ? (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  download(
                    `tazzzo-${kind}-failed-rows.csv`,
                    toCsv([
                      ['row', 'key', 'outcome', 'code', 'message'],
                      ...failedRows.map((b) => {
                        const r = results.get(b.line)
                        return [
                          String(b.line),
                          b.key,
                          r?.outcome ?? '',
                          r?.code ?? '',
                          r?.message ?? '',
                        ]
                      }),
                    ]),
                  )
                }
              >
                Download failed rows (CSV)
              </button>
            ) : null}
            {retryable.length ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void apply(retryable)}
              >
                Retry the {retryable.length} rows that were not attempted
              </button>
            ) : null}
          </div>
          <p className="muted">
            Failed rows need fixing (for example a stale version) and a new upload; they are not
            retried automatically.
          </p>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirm}
        title={`Apply ${sendable.length} ${kind} rows?`}
        description={`This writes ${sendable.length} records to the live backend in ${chunk(sendable).length} batch${chunk(sendable).length === 1 ? '' : 'es'}, recorded against your account. A rejected batch writes nothing from it, but batches already applied stay applied.`}
        confirmLabel="Apply import"
        onCancel={() => setConfirm(false)}
        onConfirm={() => void apply(sendable)}
      />
    </div>
  )
}
