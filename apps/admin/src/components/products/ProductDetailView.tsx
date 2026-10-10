import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { LIFECYCLE_TONE, realValue, type ProductDetail } from '@/lib/products'
import { ProductEditor } from './ProductEditor'

export type ProductDetailResult = Exclude<
  BackendReadResult<ProductDetail>,
  { kind: 'unauthenticated' }
>

export function ProductDetailView({
  result,
  canWrite,
}: {
  result: ProductDetailResult
  canWrite: boolean
}) {
  if (result.kind !== 'ok') {
    return (
      <BackendFailure
        result={result}
        title="Product"
        subject="Product"
        forbiddenMessage="Your roles cannot read the catalogue."
        refresh={<RefreshButton />}
      />
    )
  }
  const p = result.data
  const c = p.classification
  const attributes = Object.entries(p.attributes ?? {})
  return (
    <>
      <PageHeader
        title={p.title}
        description={p.id}
        actions={
          <Link href="/catalogue/products" className="btn">
            All products
          </Link>
        }
      />
      <div className="detail-grid">
        <section className="panel" aria-labelledby="facts-h">
          <h2 id="facts-h">Details</h2>
          <dl className="kv">
            <dt>Lifecycle</dt>
            <dd>
              <StatusBadge tone={LIFECYCLE_TONE[p.lifecycle] ?? 'neutral'}>
                {p.lifecycle}
              </StatusBadge>
            </dd>
            <dt>Type</dt>
            <dd>{p.productType}</dd>
            <dt>Brand</dt>
            <dd>{realValue(p.brandCode) ?? '—'}</dd>
            <dt>Vertical</dt>
            <dd>{realValue(c?.verticalId) ?? '—'}</dd>
            <dt>Release</dt>
            <dd>{realValue(c?.releaseId) ?? '—'}</dd>
            <dt>Classification</dt>
            <dd>{realValue(c?.status) ?? '—'}</dd>
            <dt>Taxonomy path</dt>
            <dd>{realValue(p.taxonomyPath) ?? '—'}</dd>
            <dt>Version</dt>
            <dd>{p.version}</dd>
          </dl>
        </section>
        <section className="panel" aria-labelledby="edit-h">
          <h2 id="edit-h">Edit</h2>
          <ProductEditor
            key={`${p.id}:${p.version}`}
            product={{ id: p.id, title: p.title, lifecycle: p.lifecycle, version: p.version }}
            canWrite={canWrite}
          />
        </section>
      </div>
      <section className="panel" aria-labelledby="ops-h">
        <h2 id="ops-h">Price, stock and media</h2>
        <p className="muted">
          The backend does not return price, stock or images with the product, so they are edited in
          their own screens. These links open them for {p.id}.
        </p>
        <div className="row">
          <Link href={`/pricing?sku=${encodeURIComponent(p.id)}`} className="btn">
            Price
          </Link>
          <Link href={`/inventory?sku=${encodeURIComponent(p.id)}`} className="btn">
            Stock
          </Link>
          <Link
            href={`/catalogue/media?type=product&id=${encodeURIComponent(p.id)}`}
            className="btn"
          >
            Media
          </Link>
          {canWrite ? (
            <Link href="/catalogue/imports" className="btn">
              Import
            </Link>
          ) : null}
        </div>
        <p className="muted">
          Edited on this page: the title and the lifecycle (activate, retire, revive, archive).
          Type, brand, classification, taxonomy path and attributes are read-only in the CMS because
          the backend only lets a product’s title be edited. Stock is held per location, so the
          Stock link asks for the location. Price and stock are edited for one SKU at a time; many
          at once go through Import{canWrite ? '' : ' (needs the cms-writer role)'}.
        </p>
      </section>
      <section className="panel" aria-labelledby="attrs-h">
        <h2 id="attrs-h">Attributes</h2>
        {attributes.length === 0 ? (
          <p className="muted">No attributes recorded.</p>
        ) : (
          <dl className="kv">
            {attributes.map(([k, v]) => (
              <div key={k} className="kv-row">
                <dt>{k}</dt>
                <dd>
                  {typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
                    ? String(v)
                    : JSON.stringify(v)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </>
  )
}
