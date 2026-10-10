import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { stockState, type AdminInventory } from '@/lib/commerce'
import type { ProductDetail } from '@/lib/products'
import { InventoryEditor } from './InventoryEditor'

type Ok<T> = Exclude<BackendReadResult<T>, { kind: 'unauthenticated' }>

/** SKU + location stock (the editor). The list of records is `StockListView`; there is no location registry on the backend. */
export function InventoryView({
  sku,
  location,
  product,
  stock,
  canWrite,
  invalidInput,
  needLocation,
}: {
  sku?: string
  location?: string
  product?: Ok<ProductDetail>
  stock?: Ok<AdminInventory>
  canWrite: boolean
  invalidInput?: boolean
  /** A valid product id arrived without a location (e.g. from the product page): ask for it, do not call it an error. */
  needLocation?: boolean
}) {
  const header = (
    <PageHeader
      title="Inventory"
      description="Stock per product and fulfilment location. Open a record by product and location id, or go back to the full list."
    />
  )
  const lookup = (
    <form method="get" className="filters" aria-label="Find stock record">
      <label>
        Product id
        <input name="sku" defaultValue={sku ?? ''} placeholder="TZP-…" maxLength={48} />
      </label>
      <label>
        Location id
        <input name="location" defaultValue={location ?? ''} maxLength={128} />
      </label>
      <button type="submit" className="btn">
        Find
      </button>
    </form>
  )
  if (!sku || !location || !product || !stock) {
    return (
      <>
        {header}
        {lookup}
        {invalidInput ? (
          <p className="notice" role="alert">
            Enter a product id like TZP-1001 (case matters) and a location id of letters, digits and
            . _ : - only.
          </p>
        ) : needLocation ? (
          <p className="notice" role="status">
            Stock is held per product and location. Enter the location id to open {sku}’s stock
            record, or <Link href="/inventory">go back to the stock list</Link> to find the
            locations that hold it.
          </p>
        ) : (
          <p className="muted">
            <Link href="/inventory">Back to the stock list</Link>. Stock counts by state are on the{' '}
            <Link href="/dashboard">Dashboard</Link>.
          </p>
        )}
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
  const noRecord = stock.kind === 'not_found'
  const s = stock.kind === 'ok' ? stock.data : undefined
  const state = s ? stockState(s) : undefined
  return (
    <>
      {header}
      {lookup}
      <p className="muted">
        <Link href="/inventory">Back to the stock list</Link>
      </p>
      <section className="panel" aria-labelledby="inv-h">
        <h2 id="inv-h">{product.data.title}</h2>
        <p className="muted">
          <Link href={`/catalogue/products/${encodeURIComponent(product.data.id)}`}>
            {product.data.id}
          </Link>{' '}
          at <code>{location}</code>
        </p>
        {s && state ? (
          <dl className="kv">
            <dt>State</dt>
            <dd>
              <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
            </dd>
            <dt>On hand</dt>
            <dd>{s.onHand}</dd>
            <dt>Reserved</dt>
            <dd>{s.reserved}</dd>
            <dt>Available</dt>
            <dd>{s.available}</dd>
            <dt>Low-stock threshold</dt>
            <dd>{s.lowStockThreshold}</dd>
            <dt>Max per order</dt>
            <dd>{s.maxPurchasable}</dd>
            <dt>Version</dt>
            <dd>{s.version}</dd>
          </dl>
        ) : noRecord ? (
          <p className="notice" role="status">
            No stock record exists for this product at this location.
          </p>
        ) : (
          <BackendFailure
            result={stock as Exclude<typeof stock, { kind: 'ok' }>}
            title="Stock"
            subject="Stock"
            forbiddenMessage="Your roles cannot read stock."
            refresh={<RefreshButton />}
          />
        )}
      </section>
      {canWrite && (s || noRecord) ? (
        <section className="panel" aria-labelledby="ie-h">
          <h2 id="ie-h">{noRecord ? 'Create stock record' : 'Change stock'}</h2>
          {noRecord ? (
            <p className="muted">
              The backend does not check that this location exists; a mistyped id creates an orphan
              record. Check the id.
            </p>
          ) : null}
          <InventoryEditor
            key={`${sku}:${location}:${s?.version ?? 0}`}
            skuId={sku}
            locationId={location}
            current={s}
          />
        </section>
      ) : null}
      {!canWrite && (s || noRecord) ? (
        <p className="notice" role="note">
          Read-only: changing stock needs the cms-writer role.
        </p>
      ) : null}
    </>
  )
}
