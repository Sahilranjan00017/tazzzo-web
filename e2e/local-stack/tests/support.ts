// Shared helpers for the local media + CMS content journey. Every backend admin call here is the exact call the CMS BFF
// makes (method, path, body shape) — see the citations next to each helper — sent with a LOCAL static service token
// (tazzzo.auth.cms-token / read-token) because the CMS's only login is Google OIDC, which the backend accepts only from
// Google's issuer (no local login exists without adding an auth bypass, which this harness refuses to do).
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import type { Page } from '@playwright/test'

export const env = {
  backend: must('E2E_BACKEND'),
  cdn: must('E2E_CDN'),
  store: must('E2E_STORE'),
  cmsOrigin: must('E2E_CMS_ORIGIN'),
  cmsToken: must('E2E_CMS_TOKEN'),
  readToken: must('E2E_READ_TOKEN'),
  certFile: join(must('E2E_CERT_DIR'), 'cdn.crt'),
  harness: must('E2E_HARNESS_DIR'),
  evidence: must('E2E_EVIDENCE_DIR'),
}

function must(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set: run through scripts/journeys.sh`)
  return v
}

// ---------- transcript (committed evidence; tokens and presigned query strings never written) ----------
const TRANSCRIPT = () => join(env.evidence, 'transcript.txt')
export function resetTranscript(header: string) {
  writeFileSync(TRANSCRIPT(), header + '\n')
}
export function redact(s: string): string {
  let out = s.replace(/\?X-Amz-[^"\s]*/g, '?X-Amz-…(presigned query redacted)')
  out = out.replace(
    /<AWSAccessKeyId>[^<]*<\/AWSAccessKeyId>/g,
    '<AWSAccessKeyId>(redacted)</AWSAccessKeyId>',
  ) // store error bodies echo it
  const secrets = [
    env.cmsToken,
    env.readToken,
    process.env.E2E_S3_ACCESS_KEY,
    process.env.E2E_S3_SECRET_KEY,
    process.env.E2E_CURSOR_KEY,
  ]
  for (const secret of secrets) if (secret) out = out.split(secret).join('<redacted>')
  return out
}
export function log(line: string) {
  appendFileSync(TRANSCRIPT(), redact(line) + '\n')
}

// ---------- backend admin calls (role is printed, never the token) ----------
export type Role = 'cms-writer' | 'reader' | 'anonymous'
export interface Res {
  status: number
  body: any
  headers: Headers
}

export async function call(
  method: string,
  path: string,
  opts: { role?: Role; body?: unknown; quiet?: boolean } = {},
): Promise<Res> {
  const role = opts.role ?? 'cms-writer'
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (role === 'cms-writer') headers.Authorization = `Bearer ${env.cmsToken}`
  if (role === 'reader') headers.Authorization = `Bearer ${env.readToken}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await fetch(env.backend + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await r.text()
  let body: any = text
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* keep text */
  }
  if (!opts.quiet) {
    log(
      `$ ${method} ${path}  [${role}]${opts.body === undefined ? '' : '  ' + JSON.stringify(opts.body)}`,
    )
    log(
      `  -> ${r.status} ${typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 900)}`,
    )
  }
  return { status: r.status, body, headers: r.headers }
}

/** apps/admin/src/server/bff/media-actions.ts requestUploadMutation -> POST /api/v1/admin/media/uploads (body passed through). */
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

/** media-actions.ts setMutation: PUT /api/v1/admin/media/{ownerType}/{ownerId} {assets, ...(expectedVersion ? {expectedVersion} : {})}. */
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

/** home-content-actions.ts requestContentUploadMutation -> POST /api/v1/admin/content/uploads {contentType, sizeBytes}. */
export const contentUploadTarget = (
  contentType: string,
  sizeBytes: number,
  role: Role = 'cms-writer',
) => call('POST', '/api/v1/admin/content/uploads', { role, body: { contentType, sizeBytes } })

/** home-content-actions.ts createHomeBlockMutation -> POST /api/v1/admin/content/blocks {placement:'HOME', ...v}. */
export const createBlock = (v: Record<string, unknown>, role: Role = 'cms-writer') =>
  call('POST', '/api/v1/admin/content/blocks', { role, body: { placement: 'HOME', ...v } })

/** content-actions.ts status mutation -> POST /api/v1/admin/content/blocks/{id}/status {to, expectedVersion}. */
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

/** home-content-actions.ts reorderHomeMutation -> POST /api/v1/admin/content/blocks/reorder {placement:'HOME', order}. */
export const reorder = (
  order: { blockId: string; expectedVersion: number }[],
  role: Role = 'cms-writer',
) =>
  call('POST', '/api/v1/admin/content/blocks/reorder', { role, body: { placement: 'HOME', order } })

/** server/backend/home-content.ts list (per status) -> GET /api/v1/admin/content/blocks?placement=HOME&status=. */
export async function listBlocks(status?: string): Promise<any[]> {
  const q = status ? `&status=${status}` : ''
  const r = await call('GET', `/api/v1/admin/content/blocks?placement=HOME${q}`, { quiet: true })
  if (r.status !== 200) throw new Error(`list blocks ${r.status}`)
  return r.body.items
}

/** server/backend/home-content.ts preview -> GET /api/v1/admin/content/preview/home?channel=&drafts=&at=. */
export const preview = (channel: 'app' | 'web', drafts: boolean, at?: string) =>
  call(
    'GET',
    `/api/v1/admin/content/preview/home?channel=${channel}&drafts=${drafts}${at ? `&at=${encodeURIComponent(at)}` : ''}`,
  )

/** The public endpoint, anonymous, exactly as the clients call it. */
export async function publicHome(channel?: 'app' | 'web'): Promise<Res> {
  return call('GET', `/v1/content/home${channel ? `?channel=${channel}` : ''}`, {
    role: 'anonymous',
  })
}
export const titles = (home: Res) => (home.body.blocks as any[]).map((b) => b.title as string)

// ---------- images ----------
/** A real, decodable PNG (solid colour with a contrasting band), no dependencies. */
export function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.alloc(1 + width * 3)
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const band = y > height * 0.4 && y < height * 0.6
    for (let x = 0; x < width; x++) {
      const c = band ? [255 - rgb[0], 255 - rgb[1], 255 - rgb[2]] : rgb
      row[1 + x * 3] = c[0]
      row[2 + x * 3] = c[1]
      row[3 + x * 3] = c[2]
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
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * A real loopback HTTP server at the CMS origin serving one blank page. It must be a real local server: a page
 * fulfilled by page.route has no address, and Chromium's Local Network Access check then refuses its requests to the
 * loopback store ("Permission was denied for this request to access the `loopback` address space").
 */
let cmsOriginServers: Server[] = []
export async function startCmsOrigin(): Promise<void> {
  if (cmsOriginServers.length) return
  const port = Number(new URL(env.cmsOrigin).port)
  for (const host of ['127.0.0.1', '::1']) {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>CMS origin (harness)</title><p>upload page</p>')
    })
    await new Promise<void>((ok, fail) => srv.once('error', fail).listen(port, host, () => ok()))
    cmsOriginServers.push(srv)
  }
}
export async function stopCmsOrigin(): Promise<void> {
  await Promise.all(cmsOriginServers.map((s) => new Promise((ok) => s.close(ok))))
  cmsOriginServers = []
}

/**
 * The CMS's browser-direct upload (apps/admin/src/lib/upload.ts putToStorage): XMLHttpRequest PUT to the presigned URL
 * from a page on the CMS origin, withCredentials=false, exactly the target's headers minus the browser-owned ones.
 * The page is served by the harness at the CMS origin (the CMS app cannot sign in locally); the PUT goes over the real
 * network to versitygw, so the CORS preflight and the SigV4/If-None-Match checks are the store's own.
 */
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
        xhr.onerror = () => resolve(-1) // CORS refusal or network failure
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

// ---------- command evidence ----------
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

/** `curl -sI` against the CDN stand-in, verifying its certificate with the throwaway CA file (not -k). */
export const cdnHead = (url: string) =>
  sh('curl', ['-sS', '-I', '--max-time', '5', '--cacert', env.certFile, url])
export const s3Head = (key: string) =>
  sh('node', [join(env.harness, 'lib/s3-admin.mjs'), 'head', key])
export const cdnCtl = (action: 'start' | 'stop' | 'status') =>
  sh(join(env.harness, 'scripts/cdn.sh'), [action])
export const appCheckpoint = (name: string, expect: Record<string, string>) =>
  sh(join(env.harness, 'scripts/app-jvm.sh'), [name], expect)

export const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
