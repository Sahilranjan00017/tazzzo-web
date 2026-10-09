import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { PRICE_STATUS_TONE, type AdminPrice } from '@/lib/commerce'
import { formatPaise } from '@/lib/money'
import type { ProductDetail } from '@/lib/products'
import { PriceEditor } from './PriceEditor'

type Ok<T> = Exclude<BackendReadResult<T>, { kind: 'unauthenticated' }>

/** SKU-centric pricing: the backend has no price list, so work starts from a product id. */
export function PricingView({
  sku,
  product,
  price,
  canWrite,
  invalidInput,
}: {
  sku?: string
  product?: Ok<ProductDetail>
  price?: Ok<AdminPrice>
  canWrite: boolean
  invalidInput?: boolean
}) {
  const header = (
    <PageHeader
      title="Pricing"
      description="Selling price and MRP per product. The backend has no price list, so look a product up by id."
    />
  )
  const lookup = (
    <form method="get" className="filters" aria-label="Find product">
      <label>
        Product id
        <input name="sku" defaultValue={sku ?? ''} placeholder="TZP-…" maxLength={48} />
      </label>
      <button type="submit" className="btn">
        Find
      </button>
    </form>
  )
  if (!sku || !product) {
    return (
      <>
        {header}
        {lookup}
        {invalidInput ? (
          <p className="notice" role="alert">
            Enter a product id like TZP-1001 (case matters).
          </p>
        ) : null}
        <p className="muted">
          Find a product to see and change its price. Browse ids in{' '}
          <Link href="/catalogue/products">Products</Link>.
        </p>
      </>
    )
  }
  if (product.kind !== 'ok') {
    return (
      <>
        {header}
        {lookup}
        <BackendFailure
          result={product}
          title="Product"
          subject="Product"
          forbiddenMessage="Your roles cannot read the catalogue."
          refresh={<RefreshButton />}
        />
      </>
    )
  }
  const p = product.data
  const noPrice = price?.kind === 'not_found'
  return (
    <>
      {header}
      {lookup}
      <section className="panel" aria-labelledby="pp-h">
        <h2 id="pp-h">{p.title}</h2>
        <p className="muted">
          <Link href={`/catalogue/products/${encodeURIComponent(p.id)}`}>{p.id}</Link> ·{' '}
          {p.lifecycle}
        </p>
        {price?.kind === 'ok' ? (
          <dl className="kv">
            <dt>Selling price</dt>
            <dd>{formatPaise(price.data.sellingPricePaise)}</dd>
            <dt>MRP</dt>
            <dd>{formatPaise(price.data.mrpPaise)}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge tone={PRICE_STATUS_TONE[price.data.status ?? ''] ?? 'neutral'}>
                {price.data.status ?? 'unknown'}
              </StatusBadge>
            </dd>
            <dt>Version</dt>
            <dd>{price.data.version}</dd>
          </dl>
        ) : noPrice ? (
          <p className="notice" role="status">
            No price is set for this product yet.
          </p>
        ) : price ? (
          <BackendFailure
            result={price}
            title="Price"
            subject="Price"
            forbiddenMessage="Your roles cannot read prices."
            refresh={<RefreshButton />}
          />
        ) : null}
        <p className="muted">
          The backend returns only the current price (no history endpoint exists), and checkout
          totals are always calculated by the backend.
        </p>
      </section>
      {canWrite && (price?.kind === 'ok' || noPrice) ? (
        <section className="panel" aria-labelledby="pe-h">
          <h2 id="pe-h">{noPrice ? 'Set first price' : 'Change price'}</h2>
          <PriceEditor
            key={`${p.id}:${price?.kind === 'ok' ? price.data.version : 0}`}
            skuId={p.id}
            current={price?.kind === 'ok' ? price.data : undefined}
          />
        </section>
      ) : null}
      {!canWrite && price ? (
        <p className="notice" role="note">
          Read-only: changing prices needs the cms-writer role.
        </p>
      ) : null}
    </>
  )
}
