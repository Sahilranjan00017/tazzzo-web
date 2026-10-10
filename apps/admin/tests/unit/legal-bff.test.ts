import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BffMutationSpec } from '@/server/bff/mutation'
import { MemoryStore } from '../support/memory-store'
import { fakeIdToken } from '../support/fake-id-token'

/** The legal BFF specs through the real mutation layer: the 256 KiB body bound (backend-aligned), forwarding as-is, 403/413 mapping. */
const BASE = 'https://cms.test'
const BACKEND = 'https://backend.internal'
const STORAGE = 'https://tazzzo-media.s3.ap-south-1.amazonaws.com'
const COOKIE = '__Host-tz_cms_session'
const TOKEN = fakeIdToken({ sub: '110000000000000000001' })
const ID = 'CB_abcdefghijklmnop'

let bff: typeof import('@/server/bff/mutation')
let actions: typeof import('@/server/bff/content-actions')
let store: MemoryStore
let sessionId: string
let calls: { url: string; init: RequestInit }[]

beforeAll(async () => {
  Object.assign(process.env, {
    CMS_BASE_URL: BASE,
    GOOGLE_CLIENT_ID: 'c',
    GOOGLE_CLIENT_SECRET: 's',
    GOOGLE_HOSTED_DOMAIN: 'tazzzo.test',
    TAZZZO_BACKEND_URL: BACKEND,
    SESSION_STORE_URL: 'redis://127.0.0.1:6379',
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    CMS_MEDIA_UPLOAD_ORIGIN: STORAGE,
  })
  bff = await import('@/server/bff/mutation')
  actions = await import('@/server/bff/content-actions')
})
beforeEach(async () => {
  store = new MemoryStore()
  calls = []
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const session = await import('@/server/session/session')
  const config = (await import('@/server/session/config')).sessionConfig(
    (await import('@/server/env')).serverEnv(),
  )
  sessionId = (await session.createSession(
    store,
    TOKEN,
    Math.floor(Date.now() / 1000) + 3600,
    config,
    Date.now(),
  ))!.sessionId
})
afterEach(() => vi.restoreAllMocks())

async function call<I, O, C>(
  spec: BffMutationSpec<I, O, C>,
  method: string,
  input: unknown,
  backend: { status: number; body: unknown } = {
    status: 200,
    body: { blockId: ID, status: 'DRAFT', version: 1 },
  },
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
) {
  const res = await bff.runBffMutation(
    spec,
    new NextRequest(`${BASE}/api/bff/x`, {
      method,
      headers: {
        origin: BASE,
        'x-tazzzo-csrf': '1',
        'content-type': 'application/json',
        cookie: `${COOKIE}=${sessionId}`,
        ...headers,
      },
      body: JSON.stringify(input),
    }),
    params,
    {
      store,
      fetchImpl: (async (url: URL | RequestInfo, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify(backend.body), {
          status: backend.status,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
      now: Date.now,
    },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const sent = () => JSON.parse(String(calls[0]!.init.body))

const legal = (body: string) => ({
  title: 'Terms of Service',
  sort: 0,
  payload: { legalSlug: 'TERMS', body, effectiveDate: '2026-10-01' },
})
const devanagari = 'अ'.repeat(60_000)
const asciiHeavy = (() => {
  let s = ''
  for (let i = 0; s.length < 60_000; i++) s += i % 2 ? 'Plain \\ "x"\n' : 'A "quoted" clause.\n\n'
  return s.slice(0, 60_000).trim().padEnd(60_000, 'z')
})()

describe('legal body size (backend cap is 256 KiB on content-block writes)', () => {
  it('the constant is the backend number', async () => {
    expect((await import('@/lib/content')).LEGAL_REQUEST_MAX_BYTES).toBe(262_144)
    expect(actions.createLegalMutation.maxBodyBytes).toBe(262_144)
    expect(actions.updateLegalMutation.maxBodyBytes).toBe(262_144)
  })
  it('a 60,000-character Devanagari body (180,000 bytes) passes the BFF cap and is forwarded as-is', async () => {
    expect(new TextEncoder().encode(devanagari).length).toBe(180_000)
    const r = await call(actions.createLegalMutation, 'POST', legal(devanagari))
    expect(r.status).toBe(200)
    expect(sent().payload.body).toBe(devanagari)
    expect(sent()).toMatchObject({ placement: 'HELP', type: 'LEGAL' })
    expect(calls[0]!.url).toBe(`${BACKEND}/api/v1/admin/content/blocks`)
  })
  it('the same on update, and for 60,000 ASCII characters full of newlines and quotes', async () => {
    const r = await call(actions.updateLegalMutation, 'PUT', {
      ...legal(devanagari),
      blockId: ID,
      expectedVersion: 3,
    })
    expect(r.status).toBe(200)
    expect(sent().payload.body).toBe(devanagari)
    calls.length = 0
    const a = await call(actions.createLegalMutation, 'POST', legal(asciiHeavy))
    expect(a.status).toBe(200)
    expect(sent().payload.body).toBe(asciiHeavy)
  })
  it('a body over 256 KiB is a 413 before any backend call', async () => {
    const huge = JSON.stringify({ ...legal('x'), pad: 'p'.repeat(262_144) })
    const res = await bff.runBffMutation(
      actions.createLegalMutation,
      new NextRequest(`${BASE}/api/bff/x`, {
        method: 'POST',
        headers: {
          origin: BASE,
          'x-tazzzo-csrf': '1',
          'content-type': 'application/json',
          cookie: `${COOKIE}=${sessionId}`,
        },
        body: huge,
      }),
      {},
      {
        store,
        fetchImpl: (async () => {
          throw new Error('must not call the backend')
        }) as typeof fetch,
        now: Date.now,
      },
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' })
    expect(calls).toHaveLength(0)
  })
  it('only the legal specs get the larger cap: an FAQ over 16 KiB is still a 413', async () => {
    const r = await call(actions.createFaqMutation, 'POST', {
      title: 'T',
      sort: 0,
      payload: { faqCategory: 'DELIVERY', question: 'Q?', answer: 'a'.repeat(1500) },
      pad: 'p'.repeat(17_000),
    })
    expect(r.status).toBe(413)
  })
  it('the backend 403 for a reader and its own 413 are surfaced, not swallowed', async () => {
    expect(
      await call(actions.createLegalMutation, 'POST', legal('x'), {
        status: 403,
        body: { error: { code: 'FORBIDDEN' } },
      }),
    ).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    expect(
      await call(actions.createLegalMutation, 'POST', legal('x'), {
        status: 413,
        body: { error: { code: 'PAYLOAD_TOO_LARGE' } },
      }),
    ).toMatchObject({ status: 413, body: { error: 'payload_too_large' } })
  })
})
