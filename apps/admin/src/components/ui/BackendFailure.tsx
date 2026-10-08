import type { ReactNode } from 'react'
import type { BackendReadResult } from '@/lib/backend-result'
import { PageHeader } from './primitives'

type Failed = Exclude<BackendReadResult<unknown>, { kind: 'ok' | 'unauthenticated' }>

/** Page-level state for every failed backend read. Distinct copy per outcome; no stack traces, no partial data. */
export function BackendFailure({
  result,
  title,
  subject,
  forbiddenMessage,
  refresh,
}: {
  result: Failed
  title: string
  subject: string
  forbiddenMessage: string
  refresh?: ReactNode
}) {
  const trace = 'backendRequestId' in result ? result.backendRequestId : undefined
  let heading = `${subject} unavailable`
  let message = `The backend could not return ${subject.toLowerCase()}. Nothing is shown rather than partial data.`
  if (result.kind === 'forbidden') {
    heading = 'Not permitted'
    message = forbiddenMessage
  } else if (result.kind === 'not_found') {
    heading = `${subject} not found`
    message = 'The backend has nothing at this address. It may have been removed or never existed.'
  } else if (result.kind === 'rate_limited') {
    heading = 'Too many requests'
    message = result.retryAfterSeconds
      ? `Try again in ${result.retryAfterSeconds} seconds.`
      : 'Try again shortly.'
  } else if (result.reason === 'shape') {
    message = 'The backend answered in an unexpected format, so it was not displayed.'
  } else if (result.reason === 'timeout') {
    message = 'The backend took too long to answer.'
  }
  return (
    <>
      <PageHeader title={title} />
      <div className="panel panel-error" role="alert">
        <h2>{heading}</h2>
        <p>{message}</p>
        {trace ? <p className="muted">Reference: {trace}</p> : null}
        {result.kind === 'forbidden' || result.kind === 'not_found' ? null : refresh}
      </div>
    </>
  )
}
