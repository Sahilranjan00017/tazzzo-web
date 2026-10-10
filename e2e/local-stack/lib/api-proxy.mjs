#!/usr/bin/env node
// LOCAL counting reverse proxy between the storefront server and the backend (127.0.0.1 only). The storefront's
// TAZZZO_API_BASE_URL points here; every request is forwarded unchanged to the backend and recorded (method, path, query,
// which trusted-caller / auth headers were PRESENT, X-Forwarded-For presence, status). It records the caller NAME but never
// the caller secret, bearer token or any body. The journeys use it to count backend calls per page (e.g. one products:batch
// call per rail) and to prove the trusted-caller headers are what the storefront sends.
//   GET /__harness/log?since=<seq>   -> {last, entries[]}   (only this proxy answers /__harness/*; it is never forwarded)
import http from 'node:http'

const listen = Number(process.env.E2E_API_PROXY_PORT || 8081)
const target = new URL(process.env.E2E_BACKEND.replace('localhost', '127.0.0.1'))
const entries = []
let seq = 0

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/__harness/log') {
      const since = Number(url.searchParams.get('since') || 0)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ last: seq, entries: entries.filter((e) => e.seq > since) }))
      return
    }
    const entry = {
      seq: ++seq,
      t: Date.now(),
      method: req.method,
      path: url.pathname,
      query: url.search,
      caller: req.headers['x-tazzzo-caller'] ?? null,
      callerSecretPresent: Boolean(req.headers['x-tazzzo-caller-secret']),
      bearer: Boolean(req.headers['authorization']),
      forwardedFor: req.headers['x-forwarded-for'] ?? null,
      status: 0,
    }
    entries.push(entry)
    if (entries.length > 20000) entries.splice(0, 5000)
    const up = http.request(
      { host: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers },
      (r) => {
        entry.status = r.statusCode
        res.writeHead(r.statusCode, r.headers)
        r.pipe(res)
      },
    )
    up.on('error', () => {
      entry.status = 502
      res.writeHead(502).end()
    })
    req.pipe(up)
  })
  .listen(listen, '127.0.0.1', () => process.stdout.write(`api proxy on 127.0.0.1:${listen} -> ${target.origin}\n`))
