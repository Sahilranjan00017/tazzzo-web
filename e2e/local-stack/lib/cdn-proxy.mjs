#!/usr/bin/env node
// LOCAL CDN stand-in (CloudFront + OAC in miniature). HTTPS on E2E_CDN_PORT with a throwaway self-signed
// certificate (run/certs, trusted only by the test browser via ignoreHTTPSErrors / curl -k).
// - Only GET and HEAD, only keys under p/ (product media) and c/ (CMS content imagery). Everything else: 403/405.
// - Reads the object from the private bucket with a SIGNED S3 request (the bucket is never public).
// - 200 responses carry `Cache-Control: public, max-age=31536000, immutable` (keys are write-once).
// - A missing object is 404 with `Cache-Control: no-store`; a store failure is 502. Nothing is cached in-process.
// Stop the process to simulate a CDN outage (TEST 14).
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { s3Config, s3Request } from './s3.mjs'

const cfg = s3Config()
const port = Number(process.env.E2E_CDN_PORT || 8443)
const certDir = process.env.E2E_CERT_DIR
const IMMUTABLE = 'public, max-age=31536000, immutable'
const SAFE_KEY = /^(p|c)\/[A-Za-z0-9._\/-]{1,512}$/

function log(method, path, status) {
  process.stdout.write(`${new Date().toISOString()} cdn ${method} ${path} -> ${status}\n`)
}

const tls = { key: readFileSync(`${certDir}/cdn.key`), cert: readFileSync(`${certDir}/cdn.crt`) }
const handler = async (req, res) => {
  const url = new URL(req.url, 'https://cdn.local')
  const key = decodeURIComponent(url.pathname.slice(1))
  const send = (status, headers = {}, body) => {
    res.writeHead(status, headers)
    res.end(body)
    log(req.method, url.pathname, status)
  }
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return send(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
  if (url.search || !SAFE_KEY.test(key) || key.includes('..') || key.includes('//'))
    return send(403, { 'cache-control': 'no-store' })
  try {
    const r = await s3Request(cfg, req.method, `/${cfg.bucket}/${key}`, { timeoutMs: 3000 })
    if (r.status === 404) return send(404, { 'cache-control': 'no-store' })
    if (r.status !== 200) return send(502, { 'cache-control': 'no-store' })
    const headers = {
      'content-type': r.headers['content-type'],
      'cache-control': IMMUTABLE,
      etag: r.headers.etag,
      'content-length': r.headers['content-length'],
      'x-content-type-options': 'nosniff',
    }
    if (r.headers['last-modified']) headers['last-modified'] = r.headers['last-modified']
    send(200, headers, req.method === 'HEAD' ? undefined : r.body)
  } catch (e) {
    send(502, { 'cache-control': 'no-store' })
  }
}
// Loopback only (both families when the host has IPv6, since "localhost" may resolve to either); never a LAN interface.
const banner = () =>
  process.stdout.write(
    `cdn stand-in listening on https://localhost:${port} (bucket ${cfg.bucket})\n`,
  )
https.createServer(tls, handler).listen(port, '127.0.0.1', banner)
const v6 = https.createServer(tls, handler)
v6.on('error', () => {}) // no IPv6 on this host: IPv4 loopback is enough
v6.listen(port, '::1')
