import { z } from 'zod'
import { isValidGtin } from './gtin'
import { CLASSIFICATION_STATUSES, FILTER_VALUE, PRODUCT_ID } from './products'

/** Create-product input, shared by the form (client) and the BFF spec (server) so both enforce one rule set. */
export const gtinEntry = z
  .object({
    value: z.string().refine(isValidGtin, 'invalid GTIN check digit or length'),
    market: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict()

export const createInput = z
  .object({
    id: z.string().regex(PRODUCT_ID),
    productType: z.literal('single'),
    identityType: z.enum(['gtin', 'internal']),
    internalKey: z.string().trim().min(1).max(64).optional(),
    gtins: z.array(gtinEntry).max(12).optional(),
    brandCode: z.string().regex(/^[A-Z0-9_-]{1,32}$/),
    title: z.string().trim().min(1).max(200),
    verticalId: z.string().regex(FILTER_VALUE),
    releaseId: z.string().regex(FILTER_VALUE),
    classificationStatus: z.enum(CLASSIFICATION_STATUSES),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.identityType === 'gtin' && !v.gtins?.length)
      ctx.addIssue({ code: 'custom', path: ['gtins'], message: 'a GTIN is required' })
    if (v.identityType === 'internal' && !v.internalKey)
      ctx.addIssue({
        code: 'custom',
        path: ['internalKey'],
        message: 'an internal key is required',
      })
  })
