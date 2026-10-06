import { RefreshButton } from '@/components/RefreshButton'
import { PageHeader, StatusBadge, type Tone } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import type { Health } from '@/lib/health'

type R = Exclude<BackendReadResult<Health>, { kind: 'unauthenticated' }>

const TONE: Record<string, Tone> = {
  UP: 'success',
  OPEN: 'success',
  DOWN: 'danger',
  REFUSED: 'danger',
  STARTING: 'warning',
  SKIPPED: 'neutral',
  DISABLED: 'neutral',
  JOB: 'neutral',
}

function Probe({ title, result }: { title: string; result: R }) {
  return (
    <section className="panel" aria-labelledby={`p-${title}`}>
      <h2 id={`p-${title}`}>{title}</h2>
      {result.kind === 'ok' ? (
        <>
          <p>
            <StatusBadge tone={TONE[result.data.status] ?? 'neutral'}>
              {result.data.status}
            </StatusBadge>{' '}
            <span className="muted">HTTP {result.httpStatus ?? '?'}</span>
          </p>
          <dl className="kv">
            {Object.entries(result.data.components).map(([k, v]) => (
              <div key={k} className="kv-row">
                <dt>{k.replace(/_/g, ' ')}</dt>
                <dd>
                  <StatusBadge tone={TONE[v] ?? 'neutral'}>{v}</StatusBadge>
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p role="status">
          <StatusBadge tone="danger">Unreachable</StatusBadge>{' '}
          {result.kind === 'unavailable' && result.reason === 'timeout'
            ? 'No answer within the timeout.'
            : result.kind === 'unavailable' && result.reason === 'shape'
              ? 'The answer was not in the expected format.'
              : result.kind === 'not_found'
                ? 'This probe is not served (or not exposed by the edge) in this environment.'
                : 'The probe could not be completed.'}
        </p>
      )}
    </section>
  )
}

/**
 * Read-only operational status from the backend's own health endpoints. It shows nothing it did not receive: there is no
 * uptime history, provider status (geo, media storage, notifications) or version endpoint on the backend.
 */
export function StatusView({
  live,
  ready,
  environment,
  cmsOrigin,
}: {
  live: R
  ready: R
  environment: string
  cmsOrigin: string
}) {
  return (
    <>
      <PageHeader
        title="System status"
        description="Live probes of the backend's health endpoints, taken when this page loaded."
        actions={<RefreshButton />}
      />
      <div className="detail-grid">
        <Probe title="Liveness" result={live} />
        <Probe title="Readiness" result={ready} />
      </div>
      <section className="panel" aria-labelledby="env-h">
        <h2 id="env-h">This CMS</h2>
        <dl className="kv">
          <dt>Environment</dt>
          <dd>{environment}</dd>
          <dt>CMS origin</dt>
          <dd>{cmsOrigin}</dd>
        </dl>
        <p className="muted">
          Not available from the backend: provider readiness (geo, media storage, notifications),
          deployed version, uptime history. Nothing is invented here.
        </p>
      </section>
    </>
  )
}
