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
          <p className="muted">
            Price, stock and media are managed in their own modules; the backend does not return
            them with the product.
          </p>
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
