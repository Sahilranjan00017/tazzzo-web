#!/usr/bin/env node
// LOCAL OTP gateway stand-in. The backend's LOGGING OTP provider never writes the code (by design: LoggingOtpDeliveryProvider
// logs a masked phone only), so a local sign-in can only be completed through the real HTTP adapter (HttpOtpDeliveryProvider,
// docs/ops/OTP_GATEWAY.md) pointed at a loopback receiver. This is that receiver: it checks the credential header the backend
// is configured with, writes the latest message per phone to run/sms/<digits>.json (git-ignored, never committed) and answers 202.
// It binds 127.0.0.1 only and never forwards anything.
import http from 'node:http'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const port = Number(new URL(process.env.E2E_SMS_URL).port)
const token = process.env.E2E_SMS_TOKEN
const dir = join(process.env.E2E_RUN_DIR, 'sms')
mkdirSync(dir, { recursive: true })

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const ok = req.method === 'POST' && req.url === '/sms' && req.headers['authorization'] === token
      if (!ok) {
        res.writeHead(req.headers['authorization'] === token ? 404 : 401).end()
        process.stdout.write(`${new Date().toISOString()} sms REFUSED ${req.method} ${req.url}\n`)
        return
      }
      try {
        const m = JSON.parse(body)
        const digits = String(m.to).replace(/\D/g, '')
        const code = /\b(\d{4,8})\b/.exec(String(m.message))?.[1] ?? ''
        writeFileSync(join(dir, `${digits}.json`), JSON.stringify({ to: m.to, code, at: Date.now() }))
        appendFileSync(join(dir, 'count.log'), `${digits}\n`)
        // the log line never carries the code or the full number
        process.stdout.write(`${new Date().toISOString()} sms accepted to=***${digits.slice(-4)}\n`)
        res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":true}')
      } catch {
        res.writeHead(400).end()
      }
    })
  })
  .listen(port, '127.0.0.1', () => process.stdout.write(`otp sink on 127.0.0.1:${port}\n`))
