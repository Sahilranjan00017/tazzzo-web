/**
 * Scriptable XMLHttpRequest stand-in for upload tests: records what the code under test set (method, URL, headers,
 * credentials mode, body) and lets the test drive progress and the outcome.
 */
export class FakeXhr {
  static instances: FakeXhr[] = []
  method = ''
  url = ''
  headers: Record<string, string> = {}
  withCredentials = false
  timeout = 0
  status = 0
  body: unknown
  sent = false
  aborted = false
  upload: {
    onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null
  } = {
    onprogress: null,
  }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onabort: (() => void) | null = null

  constructor() {
    FakeXhr.instances.push(this)
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  send(body: unknown) {
    this.sent = true
    this.body = body
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total })
  }
  respond(status: number) {
    this.status = status
    this.onload?.()
  }
  fail() {
    this.onerror?.()
  }

  static reset() {
    FakeXhr.instances = []
  }
  static last(): FakeXhr {
    const x = FakeXhr.instances.at(-1)
    if (!x) throw new Error('no XHR created')
    return x
  }
  static factory = () => new FakeXhr() as unknown as XMLHttpRequest
}

/** Minimal real image headers (the sniff only reads the first bytes). */
export const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]
export const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]
export const WEBP_HEAD = [...'RIFF']
  .map((c) => c.charCodeAt(0))
  .concat(
    [0, 0, 0, 0],
    [...'WEBPVP8 '].map((c) => c.charCodeAt(0)),
  )

export const imageFile = (name: string, type: string, head: number[], extra = 20) =>
  new File([new Uint8Array([...head, ...new Array<number>(extra).fill(7)])], name, { type })
