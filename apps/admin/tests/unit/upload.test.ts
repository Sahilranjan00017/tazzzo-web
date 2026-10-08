import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTRACT_MAX_UPLOAD_BYTES,
  checkImageFile,
  forgetMaxBytes,
  sizeLimitOf,
  uploadLimit,
  percent,
  prepareTargetHeaders,
  putToStorage,
  sniffImageType,
  targetFailureRetryable,
  uploadImage,
  uploadReducer,
  type UploadState,
  type UploadTarget,
} from '@/lib/upload'
import { FakeXhr, JPEG_HEAD, PNG_HEAD, WEBP_HEAD, imageFile } from '../support/fake-xhr'

const target = (over: Partial<UploadTarget> = {}): UploadTarget => ({
  assetKey: 'p/product/TZP-1/abc.png',
  method: 'PUT',
  url: 'https://media-bucket.s3.ap-south-1.amazonaws.com/p/product/TZP-1/abc.png?X-Amz-Signature=x',
  headers: { 'Content-Type': 'image/png', 'Content-Length': '32', 'If-None-Match': '*' },
  expiresAt: '2026-10-08T10:00:00Z',
  maxBytes: 5 * 1024 * 1024,
  ...over,
})
const png = () => imageFile('a.png', 'image/png', PNG_HEAD) // 12 + 20 = 32 bytes

beforeEach(() => {
  FakeXhr.reset()
  forgetMaxBytes()
})

describe('magic-byte sniff (mirrors the backend MediaSniffer)', () => {
  it('detects JPEG, PNG and WebP and nothing else', () => {
    expect(sniffImageType(new Uint8Array(JPEG_HEAD))).toBe('image/jpeg')
    expect(sniffImageType(new Uint8Array(PNG_HEAD))).toBe('image/png')
    expect(sniffImageType(new Uint8Array(WEBP_HEAD))).toBe('image/webp')
    expect(
      sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')),
    ).toBe(undefined)
    expect(sniffImageType(new TextEncoder().encode('GIF89a'))).toBe(undefined)
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBe(undefined) // truncated
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WAVE'))).toBe(undefined)
  })
})

describe('local file checks', () => {
  it('accepts a real image whose label matches its bytes', async () => {
    expect(await checkImageFile(png())).toEqual({ ok: true, contentType: 'image/png' })
    expect(await checkImageFile(imageFile('a.jpg', 'image/jpeg', JPEG_HEAD))).toEqual({
      ok: true,
      contentType: 'image/jpeg',
    })
    // No browser-reported type: the bytes decide.
    expect(await checkImageFile(imageFile('a', '', WEBP_HEAD))).toEqual({
      ok: true,
      contentType: 'image/webp',
    })
  })
  it('refuses SVG (by type or name), other types, empty and oversize files', async () => {
    const svg = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })
    expect(await checkImageFile(svg)).toMatchObject({ ok: false, message: /SVG/ })
    expect(await checkImageFile(new File(['x'], 'x.svg', { type: '' }))).toMatchObject({
      ok: false,
      message: /SVG/,
    })
    expect(
      await checkImageFile(new File(['GIF89a'], 'a.gif', { type: 'image/gif' })),
    ).toMatchObject({ ok: false, message: /JPEG, PNG or WebP/ })
    expect(await checkImageFile(new File([], 'a.png', { type: 'image/png' }))).toMatchObject({
      ok: false,
      message: /empty/,
    })
    expect(await checkImageFile(png(), 31)).toMatchObject({ ok: false, message: /limit/ })
  })
  it('refuses spoofed contents and a label that disagrees with the bytes', async () => {
    const html = new File(['<html><script>x</script></html>'], 'a.png', { type: 'image/png' })
    expect(await checkImageFile(html)).toMatchObject({
      ok: false,
      message: /contents do not match/,
    })
    const jpegAsPng = imageFile('a.png', 'image/png', JPEG_HEAD)
    expect(await checkImageFile(jpegAsPng)).toMatchObject({
      ok: false,
      message: 'The file is labelled PNG but its contents are JPEG. Re-export it and try again.',
    })
  })
})

describe('target validation before any byte is sent', () => {
  it('keeps the signed headers, drops the ones the browser computes itself', () => {
    expect(prepareTargetHeaders(target(), { size: 32 }, 'image/png')).toEqual({
      'Content-Type': 'image/png',
      'If-None-Match': '*',
    })
  })
  it('refuses credentials, mismatched size/type, insecure or credentialed URLs, non-PUT', () => {
    const f = { size: 32 }
    expect(
      prepareTargetHeaders(target({ headers: { Authorization: 'Bearer x' } }), f, 'image/png'),
    ).toBeUndefined()
    expect(
      prepareTargetHeaders(target({ headers: { cookie: 'a=b' } }), f, 'image/png'),
    ).toBeUndefined()
    expect(prepareTargetHeaders(target(), { size: 33 }, 'image/png')).toBeUndefined()
    expect(prepareTargetHeaders(target(), f, 'image/jpeg')).toBeUndefined()
    expect(
      prepareTargetHeaders(target({ url: 'http://bucket.example/p/x' }), f, 'image/png'),
    ).toBeUndefined()
    expect(
      prepareTargetHeaders(target({ url: 'https://u:p@bucket.example/p/x' }), f, 'image/png'),
    ).toBeUndefined()
    expect(
      prepareTargetHeaders(target({ url: 'javascript:alert(1)' }), f, 'image/png'),
    ).toBeUndefined()
    expect(
      prepareTargetHeaders(target({ method: 'POST' as 'PUT' }), f, 'image/png'),
    ).toBeUndefined()
    expect(
      prepareTargetHeaders(
        target({ headers: { 'X-Amz-Meta': 'a\r\nInjected: 1' } }),
        f,
        'image/png',
      ),
    ).toBeUndefined()
    // Loopback http is the local S3-compatible store / test fake.
    expect(
      prepareTargetHeaders(target({ url: 'http://127.0.0.1:9090/b/p/x' }), f, 'image/png'),
    ).toBeDefined()
  })
})

describe('storage PUT', () => {
  it('PUTs the raw file with exactly the signed headers, no credentials, reporting progress', async () => {
    const progress: number[] = []
    const file = png()
    const p = putToStorage(target(), file, 'image/png', {
      createXhr: FakeXhr.factory,
      onProgress: (l, t) => progress.push(percent(l, t)),
    })
    const x = FakeXhr.last()
    expect(x.method).toBe('PUT')
    expect(x.url).toBe(target().url)
    expect(x.withCredentials).toBe(false)
    expect(x.headers).toEqual({ 'Content-Type': 'image/png', 'If-None-Match': '*' })
    expect(x.body).toBe(file)
    x.progress(8, 32)
    x.progress(32, 32)
    x.respond(200)
    expect(await p).toEqual({ ok: true })
    expect(progress).toEqual([25, 100])
  })
  it.each([
    [412, 'already_used'],
    [403, 'rejected'],
    [400, 'rejected'],
    [500, 'storage_error'],
  ])('maps storage status %s to %s', async (status, reason) => {
    const p = putToStorage(target(), png(), 'image/png', { createXhr: FakeXhr.factory })
    FakeXhr.last().respond(status)
    expect(await p).toEqual({ ok: false, reason, status })
  })
  it('maps network failure, abort and an invalid target (which never opens a request)', async () => {
    const n = putToStorage(target(), png(), 'image/png', { createXhr: FakeXhr.factory })
    FakeXhr.last().fail()
    expect(await n).toEqual({ ok: false, reason: 'network' })
    const ac = new AbortController()
    const a = putToStorage(target(), png(), 'image/png', {
      createXhr: FakeXhr.factory,
      signal: ac.signal,
    })
    ac.abort()
    expect(await a).toEqual({ ok: false, reason: 'aborted' })
    FakeXhr.reset()
    expect(
      await putToStorage(target({ url: 'http://evil.example/x' }), png(), 'image/png', {
        createXhr: FakeXhr.factory,
      }),
    ).toEqual({ ok: false, reason: 'invalid_target' })
    expect(FakeXhr.instances).toHaveLength(0)
  })
})

describe('one upload attempt', () => {
  const describeFail = () => 'described'
  const ok = () => Promise.resolve({ ok: true as const, data: target() })

  it('requests a FRESH target per attempt (single-use URLs) and returns the issued key', async () => {
    const requestTarget = vi.fn(ok)
    const phases: string[] = []
    const first = uploadImage(png(), 'image/png', {
      requestTarget,
      describe: describeFail,
      createXhr: FakeXhr.factory,
      onPhase: (p) => phases.push(p),
    })
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    FakeXhr.last().respond(412)
    expect(await first).toMatchObject({ ok: false, reason: 'already_used', retryable: true })
    const second = uploadImage(png(), 'image/png', {
      requestTarget,
      describe: describeFail,
      createXhr: FakeXhr.factory,
    })
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(2))
    FakeXhr.last().respond(200)
    expect(await second).toEqual({
      ok: true,
      assetKey: target().assetKey,
      contentType: 'image/png',
    })
    expect(requestTarget).toHaveBeenCalledTimes(2)
    expect(requestTarget).toHaveBeenCalledWith('image/png', 32)
    expect(phases).toEqual(['requesting', 'uploading'])
  })
  it('a 403 from storage (expired/mismatch) is retryable; an unusable target is not', async () => {
    const p = uploadImage(png(), 'image/png', {
      requestTarget: ok,
      describe: describeFail,
      createXhr: FakeXhr.factory,
    })
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    FakeXhr.last().respond(403)
    expect(await p).toMatchObject({ ok: false, reason: 'rejected', retryable: true })
    const bad = await uploadImage(png(), 'image/png', {
      requestTarget: () => Promise.resolve({ ok: true, data: { assetKey: 'x' } }),
      describe: describeFail,
    })
    expect(bad).toMatchObject({ ok: false, retryable: false })
  })
  it('respects a smaller backend ceiling before sending', async () => {
    const r = await uploadImage(png(), 'image/png', {
      requestTarget: () => Promise.resolve({ ok: true, data: target({ maxBytes: 10 }) }),
      describe: describeFail,
      createXhr: FakeXhr.factory,
    })
    expect(r).toMatchObject({ ok: false, retryable: false })
    expect(FakeXhr.instances).toHaveLength(0)
  })
  it('target-request failures: outages retry, configuration/validation/permission do not', () => {
    const f = (status: number, code?: string) => ({ ok: false as const, status, error: 'x', code })
    expect(targetFailureRetryable(f(502, 'MEDIA_STORAGE_UNAVAILABLE'))).toBe(true)
    expect(targetFailureRetryable(f(0))).toBe(true)
    expect(targetFailureRetryable(f(504))).toBe(true)
    expect(targetFailureRetryable(f(502, 'MEDIA_STORAGE_NOT_CONFIGURED'))).toBe(false)
    expect(targetFailureRetryable(f(503, 'UPLOAD_ORIGIN_NOT_CONFIGURED'))).toBe(false)
    expect(targetFailureRetryable(f(422, 'INVALID_MEDIA'))).toBe(false)
    expect(targetFailureRetryable(f(403))).toBe(false)
  })
})

describe('upload state machine', () => {
  const run = (
    events: Parameters<typeof uploadReducer>[1][],
    from: UploadState = { phase: 'idle' },
  ) => events.reduce(uploadReducer, from)

  it('select -> check -> request -> upload with progress -> done', () => {
    const s = run([
      { type: 'select', fileName: 'a.png' },
      { type: 'start' },
      { type: 'uploading' },
      { type: 'progress', loaded: 50, total: 100 },
    ])
    expect(s).toEqual({ phase: 'uploading', fileName: 'a.png', attempt: 1, loaded: 50, total: 100 })
    expect(run([{ type: 'succeed', assetKey: 'k' }], s)).toEqual({
      phase: 'done',
      fileName: 'a.png',
      assetKey: 'k',
    })
  })
  it('a retryable failure can be retried as a NEW attempt; a final one cannot', () => {
    const failed = run([
      { type: 'select', fileName: 'a.png' },
      { type: 'start' },
      { type: 'uploading' },
      { type: 'fail', message: 'm', retryable: true },
    ])
    expect(failed).toMatchObject({ phase: 'failed', attempt: 1, retryable: true })
    expect(run([{ type: 'start' }], failed)).toMatchObject({ phase: 'requesting', attempt: 2 })
    const final = run([{ type: 'fail', message: 'm', retryable: false }], {
      phase: 'requesting',
      fileName: 'a',
      attempt: 1,
    })
    expect(run([{ type: 'start' }], final)).toBe(final)
  })
  it('ignores stray events: no new file while busy, no progress outside an upload, invalid only while checking', () => {
    const busy: UploadState = { phase: 'requesting', fileName: 'a', attempt: 1 }
    expect(run([{ type: 'select', fileName: 'b' }], busy)).toBe(busy)
    expect(run([{ type: 'reset' }], busy)).toBe(busy)
    expect(run([{ type: 'progress', loaded: 1, total: 2 }], { phase: 'idle' })).toEqual({
      phase: 'idle',
    })
    expect(run([{ type: 'invalid', message: 'x' }], { phase: 'idle' })).toEqual({ phase: 'idle' })
    expect(
      run([
        { type: 'select', fileName: 'x.gif' },
        { type: 'invalid', message: 'no' },
      ]),
    ).toEqual({ phase: 'invalid', fileName: 'x.gif', message: 'no' })
    expect(percent(5, 0)).toBe(0)
    expect(percent(150, 100)).toBe(100)
  })
})

describe('backend upload limit', () => {
  const describeFail = () => 'described'
  it('before the backend has said anything, only the 50 MiB contract ceiling applies locally', () => {
    expect(uploadLimit()).toEqual({ bytes: CONTRACT_MAX_UPLOAD_BYTES, known: false })
  })
  it('learns maxBytes from an issued target and enforces it on the next file', async () => {
    const p = uploadImage(png(), 'image/png', {
      requestTarget: () =>
        Promise.resolve({ ok: true, data: target({ maxBytes: 10 * 1024 * 1024 }) }),
      describe: describeFail,
      createXhr: FakeXhr.factory,
    })
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    FakeXhr.last().respond(200)
    await p
    expect(uploadLimit()).toEqual({ bytes: 10 * 1024 * 1024, known: true })
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    expect(await checkImageFile(big, uploadLimit().bytes)).toMatchObject({
      ok: false,
      message: 'The file is 11 MiB; the limit is 10 MiB.',
    })
  })
  it('a size refusal names the backend limit and teaches it', async () => {
    const r = await uploadImage(png(), 'image/png', {
      requestTarget: () =>
        Promise.resolve({
          ok: false,
          status: 422,
          error: 'invalid_request',
          code: 'INVALID_MEDIA',
          detail: { reason: 'size', maxBytes: 2 * 1024 * 1024 },
        }),
      describe: describeFail,
    })
    expect(r).toEqual({
      ok: false,
      message: 'The file is 1 KiB; this backend accepts images up to 2 MiB. Nothing was uploaded.',
      retryable: false,
      status: 422,
    })
    expect(uploadLimit()).toEqual({ bytes: 2 * 1024 * 1024, known: true })
    expect(sizeLimitOf({ detail: { reason: 'other', maxBytes: 1 } })).toBeUndefined()
  })
})

describe('cancel', () => {
  it('a cancel while the target is being requested sends nothing; a cancel mid-upload aborts the PUT; both can be retried', async () => {
    const ac = new AbortController()
    const r = await uploadImage(png(), 'image/png', {
      requestTarget: async () => {
        ac.abort()
        return { ok: true, data: target() }
      },
      describe: () => 'x',
      signal: ac.signal,
      createXhr: FakeXhr.factory,
    })
    expect(r).toMatchObject({ ok: false, reason: 'aborted', retryable: true })
    expect(FakeXhr.instances).toHaveLength(0)
    const ac2 = new AbortController()
    const p = uploadImage(png(), 'image/png', {
      requestTarget: () => Promise.resolve({ ok: true, data: target() }),
      describe: () => 'x',
      signal: ac2.signal,
      createXhr: FakeXhr.factory,
    })
    await vi.waitFor(() => expect(FakeXhr.instances).toHaveLength(1))
    ac2.abort()
    expect(FakeXhr.last().aborted).toBe(true)
    expect(await p).toMatchObject({ ok: false, reason: 'aborted', retryable: true })
  })
})
