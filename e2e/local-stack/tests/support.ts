// Shared helpers for the local cross-stack journeys (backend jar + Mongo RS + Redis + Versity S3 + CDN stand-in + storefront
// production server + a real Chromium). Every admin call here is the exact call the CMS BFF makes (method, path, body shape;
// each helper cites the apps/admin source file), sent with a LOCAL credential because the CMS's only login is Google OIDC:
//   - the backend's static local tokens (cms-writer / reader), or
//   - for the human-only staff roles (order-ops, support-agent) an RS256 ID token minted with a throwaway key whose public half
//     is served to the backend as its JWKS (tazzzo.admin.oidc.jwks-uri, documented loopback override). The backend still runs its
//     full verification (issuer, audience, hd, email_verified, allowlisted sub, role). No code path is bypassed.
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, createSign, randomUUID } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
// @ts-expect-error plain ESM shared with lib/redact-evidence.mjs
import { redactPii } from '../lib/redact-patterns.mjs'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

function must(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set: run through scripts/journeys.sh`)
  return v
}
export const env = {
  backend: must('E2E_BACKEND').replace('localhost', '127.0.0.1'),
  cdn: must('E2E_CDN'),
  store: must('E2E_STORE'),
  cmsOrigin: must('E2E_CMS_ORIGIN'),
  cmsToken: must('E2E_CMS_TOKEN'),
  readToken: must('E2E_READ_TOKEN'),
  callerName: must('E2E_CALLER_NAME'),
  callerSecret: must('E2E_CALLER_SECRET'),
  adminAudience: must('E2E_ADMIN_AUDIENCE'),
  adminHd: must('E2E_ADMIN_HD'),
  certDir: must('E2E_CERT_DIR'),
  certFile: join(must('E2E_CERT_DIR'), 'cdn.crt'),
  runDir: must('E2E_RUN_DIR'),
  harness: must('E2E_HARNESS_DIR'),
  evidence: must('E2E_EVIDENCE_DIR'),
  apiProxy: `http://127.0.0.1:${process.env.E2E_API_PROXY_PORT || 8081}`,
  mongoPort: must('E2E_MONGO_PORT'),
}
export const RUN = new Date().toISOString().slice(11, 19).replace(/:/g, '') // unique per run (HHMMSS UTC)
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------------------------------------------------
// Transcript (committed evidence). Tokens, OTP codes, presigned query strings and session tokens are never written.
// ---------------------------------------------------------------------------------------------------------------------
const TRANSCRIPT = () => join(env.evidence, 'transcript.txt')
// A worker restart reloads this module: pick the transcript position and the recorded results up from the files.
let lineNo = existsSync(TRANSCRIPT())
  ? readFileSync(TRANSCRIPT(), 'utf8').split('\n').length - 1
  : 0
export const currentLine = () => lineNo
export function resetTranscript(header: string) {
  writeFileSync(TRANSCRIPT(), header + '\n')
  lineNo = header.split('\n').length
}
export function redact(s: string): string {
  let out = s.replace(/\?X-Amz-[^"\s]*/g, '?X-Amz-…(presigned query redacted)')
  out = out.replace(
    /<AWSAccessKeyId>[^<]*<\/AWSAccessKeyId>/g,
    '<AWSAccessKeyId>(redacted)</AWSAccessKeyId>',
  )
  out = out.replace(/"(accessToken|refreshToken|token)":"[^"]*"/g, '"$1":"<redacted>"')
  out = out.replace(/"otp":"[^"]*"/g, '"otp":"<redacted>"')
  out = out.replace(/\b(SES_[A-Za-z0-9_-]{4,}\.)[A-Za-z0-9_-]+/g, '$1<redacted>')
  out = out.replace(
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    '<jwt redacted>',
  )
  const secrets = [
    env.cmsToken,
    env.readToken,
    env.callerSecret,
    process.env.E2E_S3_ACCESS_KEY,
    process.env.E2E_S3_SECRET_KEY,
    process.env.E2E_CURSOR_KEY,
    process.env.E2E_SESSION_SECRET,
    process.env.E2E_SMS_TOKEN,
    process.env.E2E_CUSTOMER_ACCESS_KEY,
    process.env.E2E_CUSTOMER_REFRESH_KEY,
    process.env.E2E_OTP_HMAC_KEY,
  ]
  for (const secret of secrets) if (secret) out = out.split(secret).join('<redacted>')
  return redactPii(out) as string
}
export function log(line: string) {
  const text = redact(line)
  appendFileSync(TRANSCRIPT(), text + '\n')
  lineNo += text.split('\n').length
}
export function section(name: string) {
  log(`\n--- ${name}`)
}

// ---------------------------------------------------------------------------------------------------------------------
// Journey bookkeeping: every check is a logged PASS/FAIL line; a journey's verdict and transcript line range go to results.json.
// ---------------------------------------------------------------------------------------------------------------------
export interface JourneyResult {
  id: string
  title: string
  verdict: 'PASS' | 'FAIL' | 'BLOCKED'
  checks: number
  failed: number
  failures: string[]
  blocked?: string
  startLine: number
  endLine: number
  ms: number
}
const RESULTS = () => join(env.evidence, 'results.json')
const results: JourneyResult[] = existsSync(RESULTS())
  ? JSON.parse(readFileSync(RESULTS(), 'utf8'))
  : []
let current: { id: string; n: number; failures: string[] } | null = null

/** A recorded assertion. Never throws: the journey continues and reports FAIL at the end. */
export function check(name: string, cond: unknown, detail?: unknown): boolean {
  const j = current
  const ok = Boolean(cond)
  const n = j ? ++j.n : 0
  const tag = j ? `${j.id}.${n}` : '?'
  const extra =
    detail === undefined
      ? ''
      : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 600)
  log(`  CHECK ${ok ? 'PASS' : 'FAIL'} ${tag} ${name}${extra}`)
  if (!ok && j) j.failures.push(`${tag} ${name}`)
  return ok
}
export class Blocked extends Error {}
/** A precondition that cannot be met: the journey is reported BLOCKED with this exact reason. */
export function blocked(reason: string): never {
  throw new Blocked(reason)
}

// Cross-journey state (a few journeys build on an earlier one), persisted so a worker restart cannot lose it.
const STATE = () => join(env.runDir, 'journey-state.json')
export const S = {
  get<T = any>(k: string): T | undefined {
    try {
      return JSON.parse(readFileSync(STATE(), 'utf8'))[k]
    } catch {
      return undefined
    }
  },
  set(k: string, v: unknown) {
    let cur: Record<string, unknown> = {}
    try {
      cur = JSON.parse(readFileSync(STATE(), 'utf8'))
    } catch {
      /* new */
    }
    cur[k] = v
    writeFileSync(STATE(), JSON.stringify(cur))
  },
}
export function resetRunFiles(header: string) {
  resetTranscript(header)
  writeFileSync(RESULTS(), '[]')
  writeFileSync(STATE(), '{}')
  results.length = 0
}

/** Registers one journey as one Playwright test. Verdict: PASS (all checks), FAIL (a check failed or it threw), BLOCKED. */
export function journey(
  id: string,
  title: string,
  fn: (ctx: { page: Page; browser: any; info: TestInfo }) => Promise<void>,
) {
  test(`${id} ${title}`, async ({ page, browser }, info) => {
    const startLine = lineNo + 1
    const t0 = Date.now()
    section(`==================== ${id} ${title} ====================`)
    current = { id, n: 0, failures: [] }
    let verdict: JourneyResult['verdict'] = 'PASS'
    let blockedReason: string | undefined
    try {
      await fn({ page, browser, info })
    } catch (e: any) {
      if (e instanceof Blocked) {
        verdict = 'BLOCKED'
        blockedReason = e.message
        log(`  BLOCKED ${id}: ${e.message}`)
      } else {
        verdict = 'FAIL'
        current.failures.push(
          `THROWN ${String(e?.message ?? e)
            .split('\n')[0]!
            .slice(0, 300)}`,
        )
        log(
          `  THROWN ${id}: ${String(e?.stack ?? e)
            .split('\n')
            .slice(0, 4)
            .join(' | ')
            .slice(0, 800)}`,
        )
      }
    }
    if (verdict === 'PASS' && current.failures.length) verdict = 'FAIL'
    const r: JourneyResult = {
      id,
      title,
      verdict,
      checks: current.n,
      failed: current.failures.length,
      failures: current.failures,
      blocked: blockedReason,
      startLine,
      endLine: lineNo,
      ms: Date.now() - t0,
    }
    log(
      `  RESULT ${id} ${verdict} checks=${r.checks} failed=${r.failed} lines ${startLine}-${lineNo} ${Math.round(r.ms / 1000)}s`,
    )
    results.push(r)
    writeFileSync(RESULTS(), JSON.stringify(results, null, 1))
    current = null
    // The verdict lives in results.json (scripts/journeys.sh derives the exit code); the Playwright test itself always
    // completes, so one failing journey never restarts the worker or hides the others.
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP to the backend
// ---------------------------------------------------------------------------------------------------------------------
export type Role =
  | 'cms-writer'
  | 'reader'
  | 'anonymous'
  | 'order-ops'
  | 'support-agent'
  | 'human-writer'
  | 'human-reader'
export interface Res {
  status: number
  body: any
  headers: Headers
  text: string
}

const HUMAN_SUB: Record<string, string> = {
  'order-ops': 'e2e-sub-ops',
  'support-agent': 'e2e-sub-support',
  'human-writer': 'e2e-sub-writer',
  'human-reader': 'e2e-sub-reader',
}
/** RS256 ID token for an allowlisted human admin (see the header comment). Short-lived; never logged. */
export function adminToken(sub: string): string {
  const key = readFileSync(join(env.certDir, 'idp.key'))
  const kid = readFileSync(join(env.certDir, 'idp.kid'), 'utf8').trim()
  const b64u = (o: unknown) =>
    Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const h = b64u({ alg: 'RS256', typ: 'JWT', kid })
  const p = b64u({
    iss: 'https://accounts.google.com',
    aud: env.adminAudience,
    azp: env.adminAudience,
    sub,
    hd: env.adminHd,
    email: `${sub}@${env.adminHd}`,
    email_verified: true,
    iat: now,
    exp: now + 300,
  })
  const sig = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key).toString('base64url')
  return `${h}.${p}.${sig}`
}
function bearerFor(role: Role): string | undefined {
  if (role === 'cms-writer') return env.cmsToken
  if (role === 'reader') return env.readToken
  if (role === 'anonymous') return undefined
  return adminToken(HUMAN_SUB[role]!)
}

export interface CallOpts {
  role?: Role
  body?: unknown
  rawBody?: string
  headers?: Record<string, string>
  quiet?: boolean
  /** trusted-caller identity (what the storefront server sends) */
  caller?: boolean
  bearer?: string
  label?: string
}
export async function call(method: string, path: string, opts: CallOpts = {}): Promise<Res> {
  const role = opts.role ?? 'cms-writer'
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) }
  const token = opts.bearer ?? bearerFor(role)
  if (token) headers.Authorization = `Bearer ${token}`
  if (opts.caller) {
    headers['X-Tazzzo-Caller'] = env.callerName
    headers['X-Tazzzo-Caller-Secret'] = env.callerSecret
  }
  if (opts.body !== undefined || opts.rawBody !== undefined)
    headers['Content-Type'] ??= 'application/json'
  const payload = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
  const r = await fetch(env.backend + path, { method, headers, body: payload })
  const text = await r.text()
  let body: any = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* keep text */
  }
  if (!opts.quiet) {
    const who = opts.bearer ? 'customer' : role
    log(
      `$ ${method} ${path}  [${opts.label ?? who}]${payload === undefined ? '' : '  ' + payload.slice(0, 500)}`,
    )
    log(
      `  -> ${r.status} ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 700)}`,
    )
  }
  return { status: r.status, body, headers: r.headers, text }
}
export const get = (path: string, opts: CallOpts = {}) =>
  call('GET', path, { role: 'anonymous', ...opts })
/** Public read the way the apps/storefront server makes it: anonymous + trusted-caller headers. */
export const pub = (path: string, opts: CallOpts = {}) =>
  call('GET', path, { role: 'anonymous', caller: true, ...opts })

// ---- catalogue / commerce admin (apps/admin/src/server/bff/*-actions.ts) ----
/** product-actions.ts createProductMutation -> POST /api/v1/products */
export const createProduct = (v: Record<string, unknown>, role: Role = 'cms-writer') =>
  call('POST', '/api/v1/products', { role, body: v })
export const productBody = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  productType: 'single',
  identityType: 'internal',
  internalKey: `k-${createHash('sha1').update(id).digest('hex').slice(0, 24)}`,
  brandCode: 'E2E',
  title,
  verticalId: 'TZV-000001',
  releaseId: 'R1',
  classificationStatus: 'confirmed',
  ...over,
})
/** product-actions.ts lifecycleMutation -> POST /api/v1/products/{id}/activate  (If-Match = version) */
export const activate = (id: string, version: number) =>
  call('POST', `/api/v1/products/${encodeURIComponent(id)}/activate`, {
    headers: { 'If-Match': String(version) },
  })
/** commerce-actions.ts pricing.set -> PUT /api/v1/admin/prices/{sku} */
export const setPrice = (
  sku: string,
  sell: number,
  mrp: number,
  expectedVersion?: number,
  role: Role = 'cms-writer',
) =>
  call('PUT', `/api/v1/admin/prices/${encodeURIComponent(sku)}`, {
    role,
    body: {
      sellingPricePaise: sell,
      mrpPaise: mrp,
      currency: 'INR',
      ...(expectedVersion ? { expectedVersion } : {}),
    },
  })
/** commerce-actions.ts inventory.set -> PUT /api/v1/admin/inventory/{sku}/{location} */
export const setStock = (
  sku: string,
  onHand: number,
  over: Record<string, unknown> = {},
  loc = 'FL-E2E-1',
  role: Role = 'cms-writer',
) =>
  call('PUT', `/api/v1/admin/inventory/${encodeURIComponent(sku)}/${encodeURIComponent(loc)}`, {
    role,
    body: {
      onHand,
      lowStockThreshold: 3,
      maxPurchasable: Math.max(1, Math.min(10, onHand)),
      ...over,
    },
  })
/** A complete sellable product: create + activate + price + stock. */
export async function sellable(
  id: string,
  title: string,
  o: { sell?: number; mrp?: number; stock?: number; vertical?: string } = {},
) {
  const c = await createProduct(
    productBody(id, title, o.vertical ? { verticalId: o.vertical } : {}),
  )
  if (c.status !== 201) throw new Error(`create ${id}: ${c.status} ${c.text.slice(0, 200)}`)
  const a = await activate(id, c.body.version)
  if (a.status !== 200) throw new Error(`activate ${id}: ${a.status}`)
  const p = await setPrice(id, o.sell ?? 20000, o.mrp ?? 25000)
  const s = await setStock(id, o.stock ?? 20)
  if (p.status >= 300 || s.status >= 300)
    throw new Error(`price/stock ${id}: ${p.status}/${s.status}`)
}

// ---- media / content (media-actions.ts, home-content-actions.ts, content-actions.ts) ----
export const productUploadTarget = (
  ownerId: string,
  contentType: string,
  sizeBytes: number,
  role: Role = 'cms-writer',
) =>
  call('POST', '/api/v1/admin/media/uploads', {
    role,
    body: { ownerType: 'product', ownerId, contentType, sizeBytes },
  })
export const putMediaSet = (
  ownerId: string,
  assets: unknown[],
  expectedVersion?: number,
  role: Role = 'cms-writer',
) =>
  call('PUT', `/api/v1/admin/media/product/${encodeURIComponent(ownerId)}`, {
    role,
    body: { assets, ...(expectedVersion ? { expectedVersion } : {}) },
  })
export const contentUploadTarget = (
  contentType: string,
  sizeBytes: number,
  role: Role = 'cms-writer',
) => call('POST', '/api/v1/admin/content/uploads', { role, body: { contentType, sizeBytes } })
export const createBlock = (v: Record<string, unknown>, role: Role = 'cms-writer') =>
  call('POST', '/api/v1/admin/content/blocks', { role, body: { placement: 'HOME', ...v } })
export const setStatus = (
  blockId: string,
  to: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED',
  expectedVersion: number,
  role: Role = 'cms-writer',
) =>
  call('POST', `/api/v1/admin/content/blocks/${encodeURIComponent(blockId)}/status`, {
    role,
    body: { to, expectedVersion },
  })
export const reorder = (
  order: { blockId: string; expectedVersion: number }[],
  role: Role = 'cms-writer',
) =>
  call('POST', '/api/v1/admin/content/blocks/reorder', { role, body: { placement: 'HOME', order } })
export async function listBlocks(status?: string): Promise<any[]> {
  const q = status ? `&status=${status}` : ''
  const r = await call('GET', `/api/v1/admin/content/blocks?placement=HOME${q}`, { quiet: true })
  if (r.status !== 200) throw new Error(`list blocks ${r.status}`)
  return r.body.items
}
export const preview = (channel: 'app' | 'web', drafts: boolean, at?: string) =>
  call(
    'GET',
    `/api/v1/admin/content/preview/home?channel=${channel}&drafts=${drafts}${at ? `&at=${encodeURIComponent(at)}` : ''}`,
  )
export const publicHome = (channel?: 'app' | 'web') =>
  call('GET', `/v1/content/home${channel ? `?channel=${channel}` : ''}`, { role: 'anonymous' })
export const titles = (home: Res) => (home.body.blocks as any[]).map((b) => b.title as string)

// ---- import jobs (docs/ops/BULK_IMPORT.md; the CMS on main has no BFF for these yet) ----
export const createJob = (note: string) =>
  call('POST', '/api/v1/admin/imports/jobs', { body: { kind: 'products', note } })
export const appendCsv = (id: string, csv: string) =>
  call('POST', `/api/v1/admin/imports/jobs/${id}/rows`, {
    rawBody: csv,
    headers: { 'Content-Type': 'text/csv' },
  })
export const getJob = (id: string, quiet = true) =>
  call('GET', `/api/v1/admin/imports/jobs/${id}`, { quiet })
export const jobAction = (
  id: string,
  action: 'validate' | 'apply' | 'cancel' | 'resume',
  version?: number,
) =>
  call('POST', `/api/v1/admin/imports/jobs/${id}/${action}`, {
    body: version === undefined ? {} : { version },
  })
export async function waitJob(id: string, until: string[], timeoutMs = 120_000): Promise<any> {
  const t0 = Date.now()
  let last: any = null
  while (Date.now() - t0 < timeoutMs) {
    const r = await getJob(id)
    last = r.body
    if (until.includes(last?.status)) {
      log(
        `  job ${id} reached ${last.status} after ${Math.round((Date.now() - t0) / 100) / 10}s counts=${JSON.stringify(last.counts)} lastError=${last.lastError ?? null}`,
      )
      return last
    }
    await sleep(700)
  }
  log(
    `  job ${id} did NOT reach ${until.join('|')} within ${timeoutMs / 1000}s; last=${JSON.stringify(last)?.slice(0, 400)}`,
  )
  return last
}

// ---------------------------------------------------------------------------------------------------------------------
// Customer (the public customer API, exactly as the storefront server calls it: trusted-caller headers + customer bearer)
// ---------------------------------------------------------------------------------------------------------------------
export function freshPhone(): string {
  return '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
}
/** Reads the code the backend's HTTP OTP adapter delivered to the loopback gateway stand-in (run/sms/<digits>.json). */
export async function otpFor(phone: string, afterMs = 0, timeoutMs = 10_000): Promise<string> {
  const f = join(env.runDir, 'sms', `91${phone}.json`)
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(f)) {
      try {
        const m = JSON.parse(readFileSync(f, 'utf8'))
        if (m.at >= afterMs && m.code) return m.code
      } catch {
        /* partially written */
      }
    }
    await sleep(150)
  }
  throw new Error(`no OTP delivered for ${phone} within ${timeoutMs} ms`)
}

export class Customer {
  token = ''
  refresh = ''
  customerId = ''
  addressId = ''
  constructor(public phone: string) {}
  /** OTP request -> (code from the gateway stand-in) -> verify -> session. */
  static async signIn(phone = freshPhone()): Promise<Customer> {
    const c = new Customer(phone)
    const before = Date.now() - 1
    const rq = await call('POST', '/v1/auth/otp/request', {
      role: 'anonymous',
      caller: true,
      body: { phone },
    })
    if (rq.status !== 202) throw new Error(`otp request ${rq.status} ${rq.text.slice(0, 200)}`)
    const code = await otpFor(phone, before)
    const vf = await call('POST', '/v1/auth/otp/verify', {
      role: 'anonymous',
      caller: true,
      body: { challengeId: rq.body.challengeId, otp: code },
    })
    if (vf.status !== 200) throw new Error(`otp verify ${vf.status} ${vf.text.slice(0, 200)}`)
    const se = await call('POST', '/v1/auth/session', {
      role: 'anonymous',
      caller: true,
      body: { grantId: vf.body.grantId },
    })
    if (se.status !== 200) throw new Error(`session ${se.status}`)
    c.token = se.body.accessToken
    c.refresh = se.body.refreshToken
    c.customerId = se.body.customerId
    return c
  }
  req(method: string, path: string, o: CallOpts = {}) {
    return call(method, path, {
      role: 'anonymous',
      caller: true,
      bearer: this.token,
      label: `customer ${this.customerId.slice(0, 8)}`,
      ...o,
    })
  }
  async addAddress(pin = '560001'): Promise<string> {
    const r = await this.req('POST', '/v1/customer/addresses', {
      headers: { 'Idempotency-Key': randomUUID().replace(/-/g, '') },
      body: {
        label: 'Home',
        recipientName: 'E2E Tester',
        recipientPhone: this.phone,
        addressLine1: '12 MG Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: pin,
      },
    })
    if (r.status !== 201) throw new Error(`address ${r.status} ${r.text.slice(0, 200)}`)
    this.addressId = r.body.addressId
    return this.addressId
  }
  cart() {
    return this.req(
      'GET',
      `/v1/customer/cart${this.addressId ? `?addressId=${this.addressId}` : ''}`,
    )
  }
  async setItem(sku: string, quantity: number) {
    const c = await this.req('GET', `/v1/customer/cart`, { quiet: true })
    return this.req(
      'PUT',
      `/v1/customer/cart/items/${encodeURIComponent(sku)}${this.addressId ? `?addressId=${this.addressId}` : ''}`,
      {
        body: { quantity },
        headers: { 'If-Match': `"cart-${c.body.version}"` },
      },
    )
  }
  async removeItem(sku: string) {
    const c = await this.req('GET', `/v1/customer/cart`, { quiet: true })
    return this.req(
      'DELETE',
      `/v1/customer/cart/items/${encodeURIComponent(sku)}${this.addressId ? `?addressId=${this.addressId}` : ''}`,
      {
        headers: { 'If-Match': `"cart-${c.body.version}"` },
      },
    )
  }
  async slot(): Promise<string> {
    const r = await this.req('GET', '/v1/customer/delivery/slots?pin=560001&days=3', {
      quiet: true,
    })
    const s =
      (r.body.slots as any[]).find((x) => x.status === 'AVAILABLE' && x.label === 'Evening') ??
      (r.body.slots as any[]).find((x) => x.status === 'AVAILABLE')
    if (!s) throw new Error('no AVAILABLE delivery slot')
    return s.slotId
  }
  async quote(idem = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 12)) {
    const c = await this.req('GET', `/v1/customer/cart`, { quiet: true })
    return this.req('POST', '/v1/customer/checkout/quote', {
      body: { addressId: this.addressId },
      headers: { 'If-Match': `"cart-${c.body.version}"`, 'Idempotency-Key': idem },
    })
  }
  place(quoteId: string, slotId: string) {
    return this.req('POST', '/v1/customer/orders', {
      body: { quoteId, paymentMethod: 'COD', deliverySlotId: slotId },
    })
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Storefront (real browser against the production server)
// ---------------------------------------------------------------------------------------------------------------------
let visitorCounter = 0
/** A distinct visitor address per page (the storefront trusts the rightmost X-Forwarded-For, as behind the ALB). */
export async function visitor(page: Page): Promise<string> {
  visitorCounter += 1
  const ip = `203.0.113.${(Number(RUN.slice(-3)) % 100) + visitorCounter}`
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': ip })
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as any).__csp = seen
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.violatedDirective} ${e.blockedURI}`),
    )
  })
  return ip
}
export const cspViolations = (page: Page) =>
  page.evaluate(() => (window as any).__csp ?? []) as Promise<string[]>

/** Sign in through the real /login page: phone -> Send code -> code from the gateway stand-in -> Sign in. */
export async function uiSignIn(
  page: Page,
  phone = freshPhone(),
  next = '/account',
): Promise<string> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel('Mobile number').fill(phone)
  const before = Date.now() - 1
  await page.getByRole('button', { name: 'Send code' }).click()
  const code = await otpFor(phone, before)
  await page.getByLabel('6-digit code').fill(code)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 })
  log(
    `  [browser] signed in as ${phone} via /login (code read from the gateway stand-in, not logged) -> ${new URL(page.url()).pathname}`,
  )
  return phone
}
export async function uiAddAddress(page: Page, phone: string, pin = '560001') {
  await page.goto('/account/addresses/new')
  const v: Record<string, string> = {
    'Full name': 'E2E Tester',
    'Mobile number': phone,
    'Address line 1': '12 MG Road',
    City: 'Bengaluru',
    State: 'Karnataka',
    'PIN code': pin,
  }
  for (const [label, value] of Object.entries(v))
    await page.getByLabel(label, { exact: true }).fill(value)
  await page.getByRole('button', { name: 'Save address' }).click()
  await page.waitForURL(/\/account\/addresses$/)
}

// ---- backend call counting through the proxy the storefront server uses ----
export interface ProxyEntry {
  seq: number
  t: number
  method: string
  path: string
  query: string
  caller: string | null
  callerSecretPresent: boolean
  bearer: boolean
  forwardedFor: string | null
  status: number
}
export async function proxyMark(): Promise<number> {
  return (await (await fetch(`${env.apiProxy}/__harness/log?since=999999999`)).json()).last
}
export async function proxySince(seq: number): Promise<ProxyEntry[]> {
  return (await (await fetch(`${env.apiProxy}/__harness/log?since=${seq}`)).json()).entries
}

// ---------------------------------------------------------------------------------------------------------------------
// images and object-store helpers
// ---------------------------------------------------------------------------------------------------------------------
/** A real, decodable PNG (solid colour with a contrasting band), no dependencies. */
export function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.alloc(1 + width * 3)
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const band = y > height * 0.4 && y < height * 0.6
    for (let x = 0; x < width; x++) {
      const c = band ? [255 - rgb[0], 255 - rgb[1], 255 - rgb[2]] : rgb
      row[1 + x * 3] = c[0]!
      row[2 + x * 3] = c[1]!
      row[3 + x * 3] = c[2]!
    }
    rows.push(Buffer.from(row))
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
/** A PNG whose HEADER declares a huge size but whose pixel data is tiny (decompression-bomb shape). */
export function pngBomb(width: number, height: number): Buffer {
  const b = Buffer.from(png(8, 8, [1, 2, 3]))
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(b.subarray(12, 29))) // IHDR CRC over type+data must stay valid
  crc.copy(b, 29)
  return b
}

let cmsOriginServers: Server[] = []
/** A real loopback HTTP server at the CMS origin (a page fulfilled by page.route has no address and fails Chromium's LNA check). */
export async function startCmsOrigin(): Promise<void> {
  if (cmsOriginServers.length) return
  const port = Number(new URL(env.cmsOrigin).port)
  for (const host of ['127.0.0.1', '::1']) {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>CMS origin (harness)</title><p>upload page</p>')
    })
    try {
      await new Promise<void>((ok, fail) => srv.once('error', fail).listen(port, host, () => ok()))
      cmsOriginServers.push(srv)
    } catch (e: any) {
      if (host === '127.0.0.1') throw e // IPv6 may be absent on this host
    }
  }
}
export async function stopCmsOrigin(): Promise<void> {
  await Promise.all(cmsOriginServers.map((s) => new Promise((ok) => s.close(ok))))
  cmsOriginServers = []
}
/** apps/admin/src/lib/upload.ts putToStorage: XHR PUT to the presigned URL from a page on the CMS origin, withCredentials=false. */
export async function browserPut(
  page: Page,
  target: any,
  bytes: Buffer,
  contentType: string,
): Promise<number> {
  await startCmsOrigin()
  await page.goto(`${env.cmsOrigin}/media-upload-harness`)
  const BROWSER_OWNED = ['content-length', 'host', 'connection', 'keep-alive', 'expect']
  const headers = Object.fromEntries(
    Object.entries(target.headers as Record<string, string>).filter(
      ([k]) => !BROWSER_OWNED.includes(k.toLowerCase()),
    ),
  )
  const status = await page.evaluate(
    async ({ url, headers, b64, contentType }) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const blob = new Blob([bin], { type: contentType })
      return await new Promise<number>((resolve) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', url, true)
        xhr.withCredentials = false
        for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v as string)
        xhr.onload = () => resolve(xhr.status)
        xhr.onerror = () => resolve(-1)
        xhr.send(blob)
      })
    },
    { url: target.url, headers, b64: bytes.toString('base64'), contentType },
  )
  log(
    `$ [browser @ ${env.cmsOrigin}] XHR PUT ${target.url}  headers=${JSON.stringify(headers)} bytes=${bytes.length}`,
  )
  log(`  -> ${status}`)
  return status
}
/** A non-browser PUT to the same presigned URL (write-once / tamper checks). */
export async function rawPut(
  target: any,
  bytes: Buffer,
  headerOverrides: Record<string, string> = {},
): Promise<number> {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(target.headers as Record<string, string>))
    if (k.toLowerCase() !== 'content-length') headers[k] = v
  Object.assign(headers, headerOverrides)
  const r = await fetch(target.url, { method: 'PUT', headers, body: bytes })
  log(`$ PUT ${target.url}  headers=${JSON.stringify(headers)} bytes=${bytes.length}`)
  log(`  -> ${r.status} ${(await r.text()).replace(/\s+/g, ' ').slice(0, 300)}`)
  return r.status
}

// ---------------------------------------------------------------------------------------------------------------------
// command evidence
// ---------------------------------------------------------------------------------------------------------------------
export function sh(
  cmd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { code: number; out: string } {
  let out = ''
  let code = 0
  try {
    out = execFileSync(cmd, args, {
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e: any) {
    code = e.status ?? 1
    out = (e.stdout ?? '') + (e.stderr ?? '')
  }
  const shown = [
    cmd === 'curl' ? 'curl' : cmd.replace(env.harness + '/', ''),
    ...args.map((a) => a.replace(env.harness + '/', '')),
  ].join(' ')
  log(`$ ${shown}`)
  log(
    out
      .trimEnd()
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
  )
  return { code, out }
}
export const cdnHead = (url: string) =>
  sh('curl', ['-sS', '-I', '--max-time', '5', '--cacert', env.certFile, url])
export const s3Head = (key: string) =>
  sh('node', [join(env.harness, 'lib/s3-admin.mjs'), 'head', key])
export const cdnCtl = (action: 'start' | 'stop' | 'status') =>
  sh(join(env.harness, 'scripts/cdn.sh'), [action])
export const mongosh = (js: string) =>
  sh('docker', [
    'exec',
    'tazzzo-e2e-mongo',
    'mongosh',
    '--quiet',
    `mongodb://localhost:${env.mongoPort}/tazzzo_e2e?replicaSet=rs0`,
    '--eval',
    js,
  ])
export const docker = (...args: string[]) => sh('docker', args)

export { expect }
