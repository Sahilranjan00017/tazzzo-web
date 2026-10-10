/**
 * Support contacts from `GET /v1/app-config`. The values are operator-entered text from the backend; they only ever
 * become a `tel:` / `mailto:` link when they match a strict grammar, so a stray `javascript:`, a space, a query string
 * (`?body=`, `&cc=`) or a second address can never reach an `href`. A value that fails is not shown as a link and not
 * shown at all: the page says the details are not available.
 */

/** E.164: `+`, a non-zero country digit, then 7 to 14 more digits (8 to 15 digits in total). Nothing else. */
export const E164_PHONE = /^\+[1-9][0-9]{7,14}$/

/** One plain address: no whitespace, quotes, angle brackets, commas or a second `@`; a dotted domain; <= 254 chars. */
export const SIMPLE_EMAIL =
  /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

export interface SupportContacts {
  /** Validated E.164 number, or null. */
  phone: string | null
  /** Validated address, or null. */
  email: string | null
}

export const NO_SUPPORT: SupportContacts = { phone: null, email: null }

export function validPhone(value: unknown): string | null {
  return typeof value === 'string' && E164_PHONE.test(value) ? value : null
}

export function validEmail(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 254 && SIMPLE_EMAIL.test(value) ? value : null
}

/** `tel:` href for a validated number only (the number matched the grammar, so it needs no escaping). */
export function telHref(phone: string): string {
  return `tel:${phone}`
}

/** `mailto:` href for a validated address only. */
export function mailtoHref(email: string): string {
  return `mailto:${email}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The support contacts out of an app-config body. The public contract nests them (`support.phone`, `support.email`);
 * the flat names the CMS form uses (`supportPhone`, `supportEmail`) are accepted too. Anything that is not a valid
 * number or address is dropped, so the result is always safe to turn into links.
 */
export function parseSupport(raw: unknown): SupportContacts {
  if (!isRecord(raw)) return NO_SUPPORT
  const nested = isRecord(raw.support) ? raw.support : {}
  return {
    phone: validPhone(nested.phone) ?? validPhone(raw.supportPhone),
    email: validEmail(nested.email) ?? validEmail(raw.supportEmail),
  }
}
