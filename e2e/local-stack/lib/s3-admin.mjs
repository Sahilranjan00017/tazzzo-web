#!/usr/bin/env node
// Bucket setup and inspection for the LOCAL Versity S3 Gateway (see lib/s3.mjs for the guard rails).
//   create-bucket                 PUT /<bucket> (idempotent: 409 "already owned by you" is fine)
//   put-cors <origin> [...]       PutBucketCors: PUT from the given origins with content-type + if-none-match
//   get-cors                      GetBucketCors (prints the XML)
//   head <key>                    HeadObject (status, content-type, content-length, etag)
//   ls [prefix]                   ListObjectsV2 (key and size per line)
import { s3Config, s3Request } from './s3.mjs'
import { createHash } from 'node:crypto'

const cfg = s3Config()
const [cmd, ...args] = process.argv.slice(2)
const bucketPath = '/' + cfg.bucket

function fail(msg, r) {
  console.error(msg, r ? `HTTP ${r.status} ${r.body.toString()}` : '')
  process.exit(1)
}

if (cmd === 'create-bucket') {
  const r = await s3Request(cfg, 'PUT', bucketPath)
  if (r.status === 200) console.log(`bucket ${cfg.bucket} created`)
  else if (r.status === 409) console.log(`bucket ${cfg.bucket} already exists`)
  else fail('create-bucket failed', r)
} else if (cmd === 'put-cors') {
  if (!args.length) fail('put-cors needs at least one origin')
  const origins = args.map((o) => `<AllowedOrigin>${o}</AllowedOrigin>`).join('')
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<CORSRule>${origins}<AllowedMethod>PUT</AllowedMethod>` +
    `<AllowedHeader>content-type</AllowedHeader><AllowedHeader>if-none-match</AllowedHeader>` +
    `<ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>600</MaxAgeSeconds></CORSRule></CORSConfiguration>`
  const body = Buffer.from(xml)
  const md5 = createHash('md5').update(body).digest('base64')
  const r = await s3Request(cfg, 'PUT', bucketPath, {
    query: { cors: '' },
    headers: { 'content-type': 'application/xml', 'content-md5': md5 },
    body,
  })
  if (r.status !== 200) fail('put-cors failed', r)
  console.log(
    `cors set on ${cfg.bucket}: PUT from ${args.join(', ')} with content-type, if-none-match`,
  )
} else if (cmd === 'get-cors') {
  const r = await s3Request(cfg, 'GET', bucketPath, { query: { cors: '' } })
  if (r.status !== 200) fail('get-cors failed', r)
  console.log(r.body.toString())
} else if (cmd === 'head') {
  const r = await s3Request(cfg, 'HEAD', `${bucketPath}/${args[0]}`)
  console.log(
    `HEAD ${args[0]} -> ${r.status} content-type=${r.headers['content-type']} content-length=${r.headers['content-length']} etag=${r.headers.etag}`,
  )
  if (r.status !== 200) process.exit(2)
} else if (cmd === 'ls') {
  const query = { 'list-type': '2' }
  if (args[0]) query.prefix = args[0]
  const r = await s3Request(cfg, 'GET', bucketPath, { query })
  if (r.status !== 200) fail('ls failed', r)
  const xml = r.body.toString()
  for (const m of xml.matchAll(
    /<Contents>.*?<Key>(.*?)<\/Key>.*?<Size>(\d+)<\/Size>.*?<\/Contents>/gs,
  ))
    console.log(`${m[2].padStart(8)}  ${m[1]}`)
} else {
  fail(
    'usage: s3-admin.mjs create-bucket | put-cors <origin...> | get-cors | head <key> | ls [prefix]',
  )
}
