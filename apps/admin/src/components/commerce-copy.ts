import { bffErrorMessage, type BffResult } from '@/lib/bff-client'
import { COMMERCE_CODE_COPY } from '@/lib/commerce'

/** Price/stock failure copy: backend business codes first, then the generic mapping. */
export function commerceErrorMessage(result: Extract<BffResult<unknown>, { ok: false }>): string {
  if ((result.status === 409 || result.status === 422 || result.status === 400) && result.code) {
    const copy = COMMERCE_CODE_COPY[result.code]
    if (copy) return copy
  }
  return bffErrorMessage(result, 'change')
}
