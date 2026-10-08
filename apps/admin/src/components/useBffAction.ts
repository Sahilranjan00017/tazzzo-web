'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'
import { useToast } from '@/components/ui/Toast'
import { callBff, type BffResult } from '@/lib/bff-client'

type Failed = Extract<BffResult<unknown>, { ok: false }>

/**
 * One guarded BFF mutation at a time. 401 sends the person to sign in again; success refreshes the server data;
 * a 404/409 also refreshes so the screen shows the authoritative state. Failures toast operator-friendly text.
 * Never retries (the backend has no idempotency keys).
 */
export function useBffAction(describe: (failure: Failed) => string) {
  const router = useRouter()
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async <T>(
      path: string,
      method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      body: unknown,
      success: string,
    ): Promise<BffResult<T>> => {
      setBusy(true)
      const result = await callBff<T>(path, method, body)
      setBusy(false)
      if (result.ok) {
        toast('success', success)
        router.refresh()
      } else if (result.status === 401) {
        router.replace('/login?error=expired')
        router.refresh()
      } else {
        toast('error', describe(result))
        if (result.status === 409 || result.status === 404) router.refresh()
      }
      return result
    },
    [router, toast, describe],
  )
  return { run, busy }
}
