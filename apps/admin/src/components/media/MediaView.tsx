import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import type { MediaSet, OwnerType } from '@/lib/media'
import { MediaSetEditor } from './MediaSetEditor'

type R = Exclude<BackendReadResult<MediaSet>, { kind: 'unauthenticated' }>

/**
 * Media for one product or SKU: thumbnails from the backend's resolved public URL when it has one (a neutral placeholder
 * otherwise), upload/replace/remove and metadata editing for cms-writer, a read-only list for everyone else.
 */
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
      description="Images attached to a product or SKU. Uploads go straight from your browser to media storage; the backend checks each stored file when you save the set."
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
            {result.data.assets.some((a) => !a.url) ? (
              <p className="muted">
                Images without a preview have no public address yet (no public media base is
                configured on the backend).
              </p>
            ) : null}
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
      {canWrite && (result.kind === 'ok' || noSet) ? (
        <section className="panel" aria-labelledby="me-h">
          <h2 id="me-h">{noSet ? 'Create the media set' : 'Edit images'}</h2>
          <MediaSetEditor
            key={`${owner.id}:${result.kind === 'ok' ? result.data.version : 'new'}`}
            ownerType={owner.type}
            ownerId={owner.id}
            set={result.kind === 'ok' ? result.data : undefined}
          />
        </section>
      ) : null}
      {result.kind === 'ok' && !canWrite ? (
        <>
          <ul className="media-grid" aria-label="Media assets">
            {result.data.assets.map((a) => (
              <li key={a.assetId} className="media-card">
                {a.url ? (
                  // Plain <img>: next/image adds an inline style (blocked by the CSP) and needs remote-host config.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="thumb" src={a.url} alt="" width={96} height={96} />
                ) : (
                  <span className="thumb thumb-empty" aria-hidden="true">
                    No preview
                  </span>
                )}
                <p className="wrap">
                  <code>{a.assetKey}</code> · {a.role} · order {a.sortOrder}
                  {a.altText ? ` · “${a.altText}”` : ' · no alt text'}
                </p>
              </li>
            ))}
          </ul>
          <p className="notice" role="note">
            Read-only: changing media needs the cms-writer role.
          </p>
        </>
      ) : null}
    </>
  )
}
