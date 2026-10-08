import { ProductCard } from '@/components/ProductCard'
import type { ProductSummary } from '@/lib/products'

export function ProductGrid({ products, label }: { products: ProductSummary[]; label: string }) {
  return (
    <ul className="product-grid" aria-label={label}>
      {products.map((product) => (
        <li key={product.productId}>
          <ProductCard product={product} />
        </li>
      ))}
    </ul>
  )
}
