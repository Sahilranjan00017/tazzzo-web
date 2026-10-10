import Link from 'next/link'
import { ImagePlaceholder } from '@/components/ImagePlaceholder'
import { Price } from '@/components/Price'
import { SafeImage } from '@/components/SafeImage'
import type { ProductSummary } from '@/lib/products'

export function ProductCard({ product }: { product: ProductSummary }) {
  return (
    <article className="card" data-product-id={product.productId}>
      <Link href={`/p/${encodeURIComponent(product.productId)}`} className="card__link">
        {product.image ? (
          <SafeImage
            src={product.image.url}
            alt={product.image.alt}
            width={320}
            height={320}
            className="card__image"
          />
        ) : (
          <ImagePlaceholder label={product.name} className="card__image" />
        )}
        <h3 className="card__name">{product.name}</h3>
      </Link>
      {(product.brandName || product.packSize) && (
        <p className="card__meta">
          {[product.brandName, product.packSize].filter(Boolean).join(' · ')}
        </p>
      )}
      <Price sellingPaise={product.sellingPricePaise} mrpPaise={product.mrpPaise} />
      {product.stockState === 'OUT_OF_STOCK' && (
        <p className="card__stock stock--out">Out of stock</p>
      )}
    </article>
  )
}
