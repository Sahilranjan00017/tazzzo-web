import { z } from 'zod'
import type { BffResult } from './bff-client'
import { bffErrorMessage } from './bff-client'

/** App-config contract (backend main c3306b6, `AppConfig`). One global document; Android/iOS versions are per-OS. */
export const appConfigSchema = z.object({
  storeOpen: z.boolean(),
  maintenance: z.boolean(),
  maintenanceMessage: z.string().nullish(),
  minAndroid: z.string().nullish(),
  latestAndroid: z.string().nullish(),
  minIos: z.string().nullish(),
  latestIos: z.string().nullish(),
  supportPhone: z.string().nullish(),
  supportEmail: z.string().nullish(),
  termsUrl: z.string().nullish(),
  privacyUrl: z.string().nullish(),
  refundPolicyUrl: z.string().nullish(),
  version: z.number().int(),
})
export type AppConfig = z.infer<typeof appConfigSchema>

const VERSION = /^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$/
const PHONE = /^\+[1-9][0-9]{7,14}$/
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,255}\.[^\s@<>]{2,}$/

/** Version compare on dotted numbers (missing parts are 0). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** Legal links must be absolute https URLs without credentials, at most 500 characters. */
export function validHttpsUrl(text: string): boolean {
  if (text.length > 500) return false
  try {
    const u = new URL(text)
    return (
      u.protocol === 'https:' && u.username === '' && u.password === '' && u.hostname.includes('.')
    )
  } catch {
    return false
  }
}

/** A text field that may be blank: null, undefined and whitespace all normalise to `null`; anything else must pass `check`. */
const optional = (check: (v: string) => boolean, message: string) =>
  z
    .string()
    .nullish()
    .transform((v) => (v == null || v.trim() === '' ? null : v.trim()))
    .refine((v) => v === null || check(v), message)

/** Form model: blanks become `null` (the backend rejects ""). Mirrors the backend rules. */
export const appConfigForm = z
  .object({
    storeOpen: z.boolean(),
    maintenance: z.boolean(),
    maintenanceMessage: optional(
      (v) => v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v),
      'Message: up to 200 characters, no control characters.',
    ),
    minAndroid: optional((v) => VERSION.test(v), 'Use a version like 1.4.2.'),
    latestAndroid: optional((v) => VERSION.test(v), 'Use a version like 1.4.2.'),
    minIos: optional((v) => VERSION.test(v), 'Use a version like 1.4.2.'),
    latestIos: optional((v) => VERSION.test(v), 'Use a version like 1.4.2.'),
    supportPhone: optional((v) => PHONE.test(v), 'Use international format, e.g. +918012345678.'),
    supportEmail: optional((v) => EMAIL.test(v) && v.length <= 320, 'Enter a valid email address.'),
    termsUrl: optional(
      validHttpsUrl,
      'Use an absolute https:// link (no credentials, up to 500 characters).',
    ),
    privacyUrl: optional(
      validHttpsUrl,
      'Use an absolute https:// link (no credentials, up to 500 characters).',
    ),
    refundPolicyUrl: optional(
      validHttpsUrl,
      'Use an absolute https:// link (no credentials, up to 500 characters).',
    ),
    expectedVersion: z.number().int().min(0).max(2_147_483_647),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.maintenance && !v.maintenanceMessage)
      ctx.addIssue({
        code: 'custom',
        path: ['maintenanceMessage'],
        message: 'Maintenance mode needs a message.',
      })
    for (const [min, latest, label] of [
      ['minAndroid', 'latestAndroid', 'Android'],
      ['minIos', 'latestIos', 'iOS'],
    ] as const) {
      const lo = v[min]
      const hi = v[latest]
      if (lo && hi && compareVersions(lo, hi) > 0)
        ctx.addIssue({
          code: 'custom',
          path: [min],
          message: `${label}: minimum version cannot be above the latest.`,
        })
    }
  })

const CODE_COPY: Record<string, string> = {
  INVALID_CONTENT:
    'The backend rejected the configuration (check versions, phone, email and link formats).',
  STALE_VERSION:
    'The configuration changed since you loaded it. The latest values have been reloaded; review them and try again.',
}

export function appConfigErrorMessage(result: Extract<BffResult<unknown>, { ok: false }>): string {
  if (result.code && CODE_COPY[result.code]) return CODE_COPY[result.code]!
  return bffErrorMessage(result, 'configuration change')
}
