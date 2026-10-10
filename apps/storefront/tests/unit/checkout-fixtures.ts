import { randomBytes } from 'node:crypto'
import { vi } from 'vitest'
import { CookieJar } from '../support/cookie-jar'

/** Shared fixtures of the checkout / orders unit suites: the backend's wire shapes and a routed `fetch` mock. */
export const jar = new CookieJar()
export const KEY = randomBytes(32).toString('base64')
export const SITE = 'https://www.tazzzo.test'
export const API = 'https://api.tazzzo.test'
export const TOKEN = 'AT.' + 'x'.repeat(60)
export const REFRESH = 'SES_abcdef123.' + 'r'.repeat(30)
export const ADDR = 'ADDR_abcdefghij123'
export const SLOT = 'morning~2026-10-11'
export const QUOTE = 'CHKQ_abcdefghijklmnopqrstu'
export const ORDER = 'ORD_abcdefghijklmnopqrstu'
export const SECRET_TEXT = 'secret internal detail 560001 Asha'

export const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()

export const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers })
export const backendError = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  reply(status, { code, message: SECRET_TEXT, requestId: 'req_x', ...extra })

export const addressBody = (over: Record<string, unknown> = {}) => ({
  addressId: ADDR,
  label: 'HOME',
  recipientName: 'Asha Verma',
  recipientPhone: '+919876543210',
  addressLine1: '12 MG Road',
  addressLine2: null,
  landmark: null,
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
  latitude: null,
  longitude: null,
  isDefault: true,
  version: 1,
  serviceability: { serviceable: true },
  requestId: 'req_a',
  ...over,
})

export const cartItem = (sku = 'TZP-1001', quantity = 2, unit = 49900) => ({
  skuId: sku,
  quantity,
  product: { title: 'Basmati Rice 5 kg', brandCode: 'TZB-1', imageUrl: null },
  price: { unitPricePaise: unit, mrpPaise: 59900, currency: 'INR' },
  availability: { stockState: 'IN_STOCK', maxOrderQuantity: 10, serviceable: true },
  lineTotalPaise: unit * quantity,
  buyable: true,
  issues: [],
})
export const cartBody = (version = 3, items = [cartItem()]) => ({
  version,
  items,
  itemCount: items.reduce((n, i) => n + i.quantity, 0),
  subtotalPaise: items.reduce((n, i) => n + i.lineTotalPaise, 0),
  freshness: 'FRESH',
  requestId: 'req_c',
})

export const quoteBody = (over: Record<string, unknown> = {}) => ({
  quoteId: QUOTE,
  cartVersion: 3,
  addressId: ADDR,
  items: [{ skuId: 'TZP-1001', quantity: 2, unitPricePaise: 49900, lineTotalPaise: 99800 }],
  itemCount: 2,
  distinctItemCount: 1,
  subtotalPaise: 99800,
  currency: 'INR',
  createdAt: '2026-10-11T04:30:12.345Z',
  expiresAt: '2026-10-11T04:35:12.345Z',
  benefitPreview: { applied: false },
  moneyPreview: { merchandiseSubtotalPaise: 99800, benefitDiscountPaise: 0, payablePaise: 99800 },
  requestId: 'req_q',
  ...over,
})

export const slotsBody = (status = 'AVAILABLE') => ({
  serviceable: true,
  timezone: 'Asia/Kolkata',
  slots: [
    {
      slotId: SLOT,
      date: '2026-10-11',
      startsAt: '2026-10-11T09:00:00+05:30',
      endsAt: '2026-10-11T11:00:00+05:30',
      label: 'Morning',
      status,
    },
  ],
  requestId: 'req_s',
})

export const orderBody = (over: Record<string, unknown> = {}) => ({
  orderId: ORDER,
  status: 'CONFIRMED',
  paymentMethod: 'COD',
  paymentCondition: 'COD_DUE',
  items: [
    {
      skuId: 'TZP-1001',
      title: 'Basmati Rice 5 kg',
      brandCode: 'TZB-1',
      quantity: 2,
      unitPricePaise: 49900,
      lineTotalPaise: 99800,
    },
  ],
  itemCount: 2,
  subtotalPaise: 99800,
  currency: 'INR',
  deliveryAddress: {
    label: 'HOME',
    recipientName: 'Asha Verma',
    recipientPhone: '+919876543210',
    addressLine1: '12 MG Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    postalCode: '560001',
  },
  createdAt: '2026-10-11T04:30:20.000Z',
  confirmedAt: '2026-10-11T04:30:20.000Z',
  money: { merchandiseSubtotalPaise: 99800, benefitDiscountPaise: 0, payablePaise: 99800 },
  deliverySlot: {
    slotId: SLOT,
    label: 'Morning',
    startsAt: '2026-10-11T09:00:00+05:30',
    endsAt: '2026-10-11T11:00:00+05:30',
  },
  requestId: 'req_o',
  ...over,
})

export interface Loaded {
  csrf: string
  cookies: typeof import('@/server/session/cookies')
}

/** A fresh module graph on a production-mode environment with a signed-in customer (unless told otherwise). */
export async function loadEnv(
  options: { signedIn?: boolean; customerId?: string; extraEnv?: Record<string, string> } = {},
): Promise<Loaded> {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('STOREFRONT_TRUST_PROXY', 'true')
  vi.stubEnv('TAZZZO_API_BASE_URL', API)
  vi.stubEnv('TAZZZO_SITE_URL', SITE)
  vi.stubEnv('STOREFRONT_SESSION_SECRET', KEY)
  for (const [k, v] of Object.entries(options.extraEnv ?? {})) vi.stubEnv(k, v)
  const cookies = await import('@/server/session/cookies')
  const csrf = cookies.newCsrfToken()
  if (options.signedIn !== false) {
    const now = Date.now()
    await cookies.writeSession({
      customerId: options.customerId ?? 'CUS_1',
      accessToken: TOKEN,
      accessExpiresAt: now + 900_000,
      refreshToken: REFRESH,
      csrf,
      issuedAt: now,
      expiresAt: now + 3_600_000,
    })
  }
  return { csrf, cookies }
}

export const headers = (csrf: string, extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  'x-tazzzo-csrf': csrf,
  origin: SITE,
  host: 'www.tazzzo.test',
  'sec-fetch-site': 'same-origin',
  ...extra,
})
export const without = (h: Record<string, string>, key: string) =>
  Object.fromEntries(Object.entries(h).filter(([k]) => k !== key))
export const post = (path: string, body: unknown, h: Record<string, string>) =>
  new Request(`${SITE}${path}`, {
    method: 'POST',
    headers: h,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

export const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${url.replace(API, '')}`)
export const sentHeaders = (i: number) =>
  (fetchMock.mock.calls[i]![1] as RequestInit & { headers: Record<string, string> }).headers
export const sentBody = (i: number) =>
  JSON.parse(String(fetchMock.mock.calls[i]![1]!.body)) as Record<string, unknown>

/** Routes backend calls by `METHOD /path` (query included); an unrouted call fails the test loudly. */
export function routeBackend(routes: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (url, init) => {
    const key = `${init?.method} ${url.replace(API, '')}`
    const handler = routes[key] ?? routes[key.split('?')[0]!]
    if (!handler) throw new Error(`unrouted backend call: ${key}`)
    return handler()
  })
}

export function resetFetch(logs: string[]) {
  jar.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation((m) => void logs.push(String(m)))
  vi.spyOn(console, 'error').mockImplementation((m) => void logs.push(String(m)))
  vi.spyOn(console, 'log').mockImplementation((m) => void logs.push(String(m)))
}
