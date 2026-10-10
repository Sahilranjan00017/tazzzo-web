'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { getBff } from '@/lib/bff-client'
import {
  JOB_ID,
  POLL_MAX_FAILURES,
  POLL_START_MS,
  STATUS_LABEL,
  isWorking,
  jobSchema,
  nextPollDelay,
  progressPercent,
  type ImportJob,
} from '@/lib/import-jobs'

/**
 * Live status while the background worker owns the job (VALIDATING or APPLYING). It polls the BFF for the one job with a
 * growing wait (3 s, then 1.5x per unchanged answer up to 15 s; doubled after a failure), never overlaps two requests, waits
 * while the tab is hidden, and STOPS for good on the first answer that is not a working state, after five failures in a row,
 * on sign-out, or when the page goes away. Whenever the job changed it asks the page to re-read itself once.
 * No other status is polled: OPEN, VALIDATED, REJECTED and PAUSED only change when a person acts.
 */
export function JobPoller({ job }: { job: ImportJob }) {
  const router = useRouter()
  // Kept in a ref so a router object that changes identity can never restart the polling schedule.
  const routerRef = useRef(router)
  useEffect(() => {
    routerRef.current = router
  })
  // The newest answer wins: a polled job replaces the server-rendered one only while it is newer. The parent keys this
  // component by status, so a new status (or a fresh page) starts with a clean slate.
  const [polled, setPolled] = useState<ImportJob>()
  const [stopped, setStopped] = useState<string>()
  const live = polled && polled.version > job.version ? polled : job

  useEffect(() => {
    if (!isWorking(job.status) || !JOB_ID.test(job.id)) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let ended = false
    let delay = POLL_START_MS
    let failures = 0
    let signature = `${job.status}:${job.version}:${job.nextRow}`

    const schedule = () => {
      if (!ended) timer = setTimeout(() => void poll(), delay)
    }
    const stop = (reason?: string) => {
      ended = true
      if (timer) clearTimeout(timer)
      if (reason) setStopped(reason)
    }
    async function poll() {
      if (ended) return
      if (document.hidden) return schedule() // checked again after the next wait, and at once on becoming visible
      const result = await getBff<unknown>(`/api/bff/imports/jobs/${encodeURIComponent(job.id)}`)
      if (ended) return
      if (!result.ok) {
        if (result.status === 401) {
          stop()
          routerRef.current.replace('/login?error=expired')
          routerRef.current.refresh()
          return
        }
        if (result.status === 403 || result.status === 404)
          return stop('Live updates stopped: the job can no longer be read.')
        failures += 1
        if (failures >= POLL_MAX_FAILURES)
          return stop('Live updates stopped after repeated failures. Use Refresh to check the job.')
        delay = nextPollDelay(delay, true)
        return schedule()
      }
      const parsed = jobSchema.safeParse(result.data)
      if (!parsed.success)
        return stop('Live updates stopped: the job came back in an unexpected format.')
      failures = 0
      setPolled(parsed.data)
      const next = `${parsed.data.status}:${parsed.data.version}:${parsed.data.nextRow}`
      if (next !== signature) {
        signature = next
        delay = POLL_START_MS
        routerRef.current.refresh()
      } else delay = nextPollDelay(delay, false)
      if (!isWorking(parsed.data.status)) return stop()
      schedule()
    }
    const onVisible = () => {
      if (!document.hidden && !ended) {
        if (timer) clearTimeout(timer)
        void poll()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    schedule()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisible)
    }
    // The starting signature is read once per run on purpose: a later server refresh must not restart the schedule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, job.status])

  if (!isWorking(live.status) && !stopped) return null
  const percent = progressPercent(live)
  const what = live.status === 'APPLYING' ? 'Applying' : 'Validating'
  return (
    <section className="panel" aria-labelledby="job-live-h">
      <h2 id="job-live-h">
        {isWorking(live.status) ? `${what} in the background` : 'Live status'}
      </h2>
      {isWorking(live.status) ? (
        <>
          <progress
            value={Math.min(live.nextRow, live.rowsTotal)}
            max={Math.max(live.rowsTotal, 1)}
            aria-label={`${what} progress`}
          />
          <p role="status">
            {STATUS_LABEL[live.status]}: row {Math.min(live.nextRow, live.rowsTotal)} of{' '}
            {live.rowsTotal} ({percent}%). This page checks again every few seconds and stops by
            itself when the job needs you or finishes.
          </p>
        </>
      ) : null}
      {stopped ? (
        <p className="notice" role="status">
          {stopped}
        </p>
      ) : null}
    </section>
  )
}
