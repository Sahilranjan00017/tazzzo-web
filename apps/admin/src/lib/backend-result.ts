/** Outcome of a backend read: a closed union so every page renders each case distinctly. Client-safe. */
export type BackendReadResult<T> =
  | { kind: 'ok'; data: T; httpStatus?: number; backendRequestId?: string }
  | { kind: 'unauthenticated' }
  | { kind: 'forbidden'; backendRequestId?: string }
  | { kind: 'not_found'; backendRequestId?: string }
  | { kind: 'rate_limited'; retryAfterSeconds?: number; backendRequestId?: string }
  | {
      kind: 'unavailable'
      reason: 'timeout' | 'network' | 'status' | 'shape'
      /** For `status` only: the backend's HTTP status and its stable machine code (e.g. 503 `LIST_TIMEOUT`), if well-formed. */
      httpStatus?: number
      code?: string
      backendRequestId?: string
    }
