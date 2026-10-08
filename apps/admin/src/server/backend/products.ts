import 'server-only'
import {
  PRODUCT_ID,
  productDetailSchema,
  productListPath,
  productListSchema,
  type ProductListQuery,
} from '@/lib/products'
import { readAsAdmin } from './session-read'

/** `GET /api/v1/products` (cursor paging, closed filter grammar). `query` is already validated by `parseProductListQuery`. */
export const readProductList = (query: ProductListQuery) =>
  readAsAdmin(productListPath(query), productListSchema)

/** `GET /api/v1/products/{id}`. The id is validated before it becomes part of a path. */
export function readProduct(id: string) {
  if (!PRODUCT_ID.test(id)) throw new Error('invalid product id')
  return readAsAdmin(`/api/v1/products/${encodeURIComponent(id)}`, productDetailSchema)
}
