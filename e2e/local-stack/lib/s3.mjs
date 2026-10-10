// Minimal AWS SigV4 S3 client for a LOCAL S3-compatible store (Versity S3 Gateway) only.
// No SDK, no profile, no credential files: endpoint and the local root key pair come from the
// environment written by scripts/up.sh (run/stack.env, git-ignored). Refuses non-loopback endpoints
// so it can never be pointed at AWS by accident.
import { createHash, createHmac } from 'node:crypto'
import http from 'node:http'

const REGION = 'us-east-1'

function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex')
}
function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest()
}
function encodeRfc3986(s) {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

export function s3Config() {
  const endpoint = process.env.E2E_S3_ENDPOINT
  const accessKey = process.env.E2E_S3_ACCESS_KEY
  const secretKey = process.env.E2E_S3_SECRET_KEY
  const bucket = process.env.E2E_S3_BUCKET
  if (!endpoint || !accessKey || !secretKey || !bucket)
    throw new Error('E2E_S3_* environment is incomplete (source run/stack.env)')
  const u = new URL(endpoint)
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) {
    throw new Error('refusing a non-loopback S3 endpoint: this helper is for the local store only')
  }
  return { endpoint: u, accessKey, secretKey, bucket }
}

/**
 * One signed request. `path` is the already-separated object path ("/bucket/key"), `query` a plain
 * object. Returns {status, headers, body: Buffer}. Streams nothing: objects here are small images.
 */
export function s3Request(
  cfg,
  method,
  path,
  { query = {}, headers = {}, body = Buffer.alloc(0), timeoutMs = 2000 } = {},
) {
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const payloadHash = sha256hex(body)
  const host = cfg.endpoint.host
  const canonicalUri = path.split('/').map(encodeRfc3986).join('/')
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k] ?? '')}`)
    .join('&')
  const allHeaders = {
    ...Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]),
    ),
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  const signedNames = Object.keys(allHeaders).sort()
  const canonicalHeaders = signedNames.map((k) => `${k}:${allHeaders[k]}\n`).join('')
  const signedHeaders = signedNames.join(';')
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const scope = `${day}/${REGION}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n')
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + cfg.secretKey, day), REGION), 's3'), 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  const reqHeaders = { ...allHeaders, authorization }
  if (body.length) reqHeaders['content-length'] = String(body.length)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: cfg.endpoint.hostname,
        port: cfg.endpoint.port,
        method,
        path: canonicalUri + (canonicalQuery ? '?' + canonicalQuery : ''),
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        )
      },
    )
    req.on('timeout', () => req.destroy(new Error('s3 request timed out')))
    req.on('error', reject)
    req.end(body)
  })
}
