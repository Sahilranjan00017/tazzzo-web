import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AddToCart } from '@/components/AddToCart'
import { Price } from '@/components/Price'
import { ProductAvailability } from '@/components/ProductAvailability'
import { ProductGallery } from '@/components/ProductGallery'
import { Unavailable } from '@/components/Unavailable'
import { isProductId } from '@/lib/ids'
import { getProduct } from '@/server/backend/catalog'
import { catalogPin, currentLocation } from '@/server/location/service'
import { readSession } from '@/server/session/cookies'

const DESCRIPTION_MAX = 160

function summary(text: string | null, name: string): string {
  const base = text ?? `Buy ${name} on Tazzzo.`
  return base.length <= DESCRIPTION_MAX ? base : `${base.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
}

export async function generateMetadata({ params }: PageProps<'/p/[id]'>): Promise<Metadata> {
  const { id } = await params
  const product = isProductId(id) ? await getProduct(id, await catalogPin()) : null
  if (product === null || product === 'unavailable') return { title: 'Product' }
  const image = product.images[0]
  return {
    title: product.name,
    description: summary(product.description, product.name),
    alternates: { canonical: `/p/${encodeURIComponent(product.productId)}` },
    openGraph: {
      url: `/p/${encodeURIComponent(product.productId)}`,
      title: product.name,
      images: image ? [{ url: image.url, alt: image.alt }] : undefined,
    },
  }
}

/** Product detail from `GET /v1/products/{id}[?pin=]`: gallery (primary first), name, brand, price, description. */
export default async function ProductPage({ params }: PageProps<'/p/[id]'>) {
  const { id } = await params
  if (!isProductId(id)) notFound()
  const pin = await catalogPin()
  const product = await getProduct(id, pin)
  if (product === null) notFound()
  if (product === 'unavailable') return <Unavailable what="this product" />
  const session = await readSession()
  const location = await currentLocation(session)
  return (
    <article className="pdp" data-product-id={product.productId}>
      <ProductGallery images={product.images} productName={product.name} />
      <div className="pdp__info">
        <h1>{product.name}</h1>
        {(product.brandName || product.packSize) && (
          <p className="pdp__meta">
            {[product.brandName, product.packSize].filter(Boolean).join(' · ')}
          </p>
        )}
        <Price sellingPaise={product.sellingPricePaise} mrpPaise={product.mrpPaise} />
        <ProductAvailability
          location={location}
          pinUsed={pin}
          stockState={product.stockState}
          lowStockRemaining={product.lowStockRemaining}
        />
        <AddToCart
          productId={product.productId}
          productName={product.name}
          csrfToken={session?.csrf ?? null}
          stockState={product.stockState}
        />
        {product.highlights.length > 0 && (
          <ul className="pdp__highlights">
            {product.highlights.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        )}
        {product.description && <p className="pdp__description">{product.description}</p>}
      </div>
    </article>
  )
}
