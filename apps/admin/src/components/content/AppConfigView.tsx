import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import type { AppConfig } from '@/lib/appconfig'
import { AppConfigForm } from './AppConfigForm'

type R = Exclude<BackendReadResult<AppConfig>, { kind: 'unauthenticated' }>

export function AppConfigView({ result, canWrite }: { result: R; canWrite: boolean }) {
  const header = (
    <PageHeader
      title="App configuration"
      description="One global configuration for every customer platform; only the Android/iOS version fields are per-OS."
    />
  )
  if (result.kind !== 'ok') {
    return (
      <>
        {header}
        <BackendFailure
          result={result}
          title="App configuration"
          subject="App configuration"
          forbiddenMessage="Your roles cannot read the configuration. The backend allows it for reader and cms-writer."
          refresh={<RefreshButton />}
        />
      </>
    )
  }
  const c = result.data
  return (
    <>
      {header}
      <p>
        <StatusBadge tone={c.storeOpen ? 'success' : 'danger'}>
          {c.storeOpen ? 'Store open' : 'Store closed'}
        </StatusBadge>{' '}
        {c.maintenance ? <StatusBadge tone="warning">Maintenance on</StatusBadge> : null}{' '}
        <span className="muted">version {c.version}</span>
      </p>
      {canWrite ? (
        <AppConfigForm key={c.version} config={c} />
      ) : (
        <>
          <dl className="kv">
            <dt>Maintenance message</dt>
            <dd>{c.maintenanceMessage ?? '—'}</dd>
            <dt>Android min / latest</dt>
            <dd>
              {c.minAndroid ?? '—'} / {c.latestAndroid ?? '—'}
            </dd>
            <dt>iOS min / latest</dt>
            <dd>
              {c.minIos ?? '—'} / {c.latestIos ?? '—'}
            </dd>
            <dt>Support</dt>
            <dd>
              {c.supportPhone ?? '—'} · {c.supportEmail ?? '—'}
            </dd>
            <dt>Terms</dt>
            <dd>{c.termsUrl ?? 'not published'}</dd>
            <dt>Privacy</dt>
            <dd>{c.privacyUrl ?? 'not published'}</dd>
            <dt>Refund policy</dt>
            <dd>{c.refundPolicyUrl ?? 'not published'}</dd>
          </dl>
          <p className="notice" role="note">
            Read-only: changing configuration needs the cms-writer role.
          </p>
        </>
      )}
    </>
  )
}
