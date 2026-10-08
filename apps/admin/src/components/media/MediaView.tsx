import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import type { MediaSet, OwnerType } from '@/lib/media'
import { MediaSetEditor } from './MediaSetEditor'
import { UploadReadiness } from './UploadReadiness'

type R = Exclude<BackendReadResult<MediaSet>, { kind: 'unauthenticated' }>

/** Media for one product or SKU. The admin API returns no public URL, so there is no image preview here. */
export function MediaView({
  owner,
  result,
  canWrite,
  invalidInput,
}: {
  owner?: { type: OwnerType; id: string }
  result?: R
  canWrite: boolean
  invalidInput?: boolean
}) {
  const header = (
    <PageHeader
      title="Media"
      description="Images attached to a product or SKU. The backend returns no public image URL to admins, so previews are not available here."
    />
  )
  const lookup = (
    <form method="get" className="filters" aria-label="Find media set">
      <label>
        Owner type
        <select name="type" defaultValue={owner?.type ?? 'product'}>
          <option value="product">Product</option>
          <option value="sku">SKU</option>
        </select>
      </label>
      <label>
        Product id
        <input name="id" defaultValue={owner?.id ?? ''} placeholder="TZP-…" maxLength={48} />
      </label>
      <button type="submit" className="btn">
        Find
      </button>
    </form>
  )
  if (!owner || !result) {
    return (
      <>
        {header}
        {lookup}
        {invalidInput ? (
          <p className="notice" role="alert">
            Enter a product id like TZP-1001.
          </p>
        ) : (
          <p className="muted">
            Find a product to see its images. Browse ids in{' '}
            <Link href="/catalogue/products">Products</Link>.
          </p>
        )}
      </>
    )
  }
  const noSet = result.kind === 'not_found'
  return (
    <>
      {header}
      {lookup}
      <section className="panel" aria-labelledby="ms-h">
        <h2 id="ms-h">
          {owner.id} <span className="muted">({owner.type})</span>
        </h2>
        {result.kind === 'ok' ? (
          <>
            <p>
              <StatusBadge tone={result.data.active === false ? 'neutral' : 'success'}>
                {result.data.active === false ? 'Inactive' : 'Active'}
              </StatusBadge>{' '}
              <span className="muted">
                {result.data.assets.length} image{result.data.assets.length === 1 ? '' : 's'} ·
                version {result.data.version}
              </span>
            </p>
            <p className="notice" role="note">
              Verification state is not reported per image. While no storage provider is configured,
              the backend accepts image keys without checking they exist, so a listed image may not
              actually be available.
            </p>
          </>
        ) : noSet ? (
          <p className="notice" role="status">
            This {owner.type} has no media set (or the product does not exist).
          </p>
        ) : (
          <BackendFailure
            result={result}
            title="Media"
            subject="Media"
            forbiddenMessage="Your roles cannot read media."
            refresh={<RefreshButton />}
          />
        )}
      </section>
      {result.kind === 'ok' && canWrite ? (
        result.data.assets.length === 0 ? (
          <p className="muted">The set is empty.</p>
        ) : (
          <section className="panel" aria-labelledby="me-h">
            <h2 id="me-h">Edit images</h2>
            <MediaSetEditor
              key={`${owner.id}:${result.data.version}`}
              ownerType={owner.type}
              ownerId={owner.id}
              set={result.data}
            />
          </section>
        )
      ) : null}
      {result.kind === 'ok' && !canWrite ? (
        <>
          <ul>
            {result.data.assets.map((a) => (
              <li key={a.assetId}>
                <code>{a.assetKey}</code> · {a.role} · order {a.sortOrder}
                {a.altText ? ` · “${a.altText}”` : ' · no alt text'}
              </li>
            ))}
          </ul>
          <p className="notice" role="note">
            Read-only: changing media needs the cms-writer role.
          </p>
        </>
      ) : null}
      {canWrite && (result.kind === 'ok' || noSet) ? (
        <UploadReadiness ownerType={owner.type} ownerId={owner.id} />
      ) : null}
    </>
  )
}
