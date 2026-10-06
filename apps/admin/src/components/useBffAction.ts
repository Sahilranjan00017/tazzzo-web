'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState, useSyncExternalStore, useTransition } from 'react'
import { useToast } from '@/components/ui/Toast'
import { callBff, type BffResult } from '@/lib/bff-client'

type Failed = Extract<BffResult<unknown>, { ok: false }>

/**
 * App-wide "a server refresh is in flight" flag. After a mutation the page re-reads authoritative data; until that lands,
 * every action on the page still holds the OLD version and would only produce a stale-version conflict. All action
 * buttons therefore stay disabled while a refresh is pending, across components.
 */
let refreshing = false
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
const setRefreshing = (v: boolean) => {
  refreshing = v
  listeners.forEach((l) => l())
}

/**
 * One guarded BFF mutation at a time. 401 sends the person to sign in again; success refreshes the server data;
 * a 404/409 also refreshes so the screen shows the authoritative state. Failures toast operator-friendly text.
 * Never retries (the backend has no idempotency keys). `busy` is true while a call OR the follow-up refresh is running.
 */
export function useBffAction(describe: (failure: Failed) => string) {
  const router = useRouter()
  const { toast } = useToast()
  const [calling, setCalling] = useState(false)
  const [isPending, startTransition] = useTransition()
  const anyRefreshing = useSyncExternalStore(
    subscribe,
    () => refreshing,
    () => false,
  )

  useEffect(() => {
    if (!isPending) return
    setRefreshing(true)
    return () => setRefreshing(false)
  }, [isPending])

  const run = useCallback(
    async <T>(
      path: string,
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      body: unknown,
      success: string,
    ): Promise<BffResult<T>> => {
      setCalling(true)
      const result = await callBff<T>(path, method, body)
      setCalling(false)
      if (result.ok) {
        toast('success', success)
        startTransition(() => router.refresh())
      } else if (result.status === 401) {
        router.replace('/login?error=expired')
        router.refresh()
      } else {
        toast('error', describe(result))
        if (result.status === 409 || result.status === 404) startTransition(() => router.refresh())
      }
      return result
    },
    [router, toast, describe],
  )
  return { run, busy: calling || isPending || anyRefreshing }
}
