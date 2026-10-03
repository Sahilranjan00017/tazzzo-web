import 'server-only'
import { z } from 'zod'
import type { SessionStore } from '@/server/store/types'
import { newOpaqueId, txKey } from './ids'

export const TRANSACTION_TTL_SECONDS = 600

const transactionSchema = z.object({
  v: z.literal(1),
  state: z.string().min(1),
  oidcNonce: z.string().min(1),
  codeVerifier: z.string().min(43),
  returnTo: z.string().startsWith('/'),
  createdAt: z.number(),
  expiresAt: z.number(),
})

export type LoginTransaction = z.infer<typeof transactionSchema>

/** Stores the login transaction server-side; the browser only ever receives the opaque transaction id. */
export async function createTransaction(
  store: SessionStore,
  data: Pick<LoginTransaction, 'state' | 'oidcNonce' | 'codeVerifier' | 'returnTo'>,
  now: number,
): Promise<string> {
  const txId = newOpaqueId()
  const record: LoginTransaction = {
    v: 1,
    ...data,
    createdAt: now,
    expiresAt: now + TRANSACTION_TTL_SECONDS * 1000,
  }
  await store.set(txKey(txId), JSON.stringify(record), record.expiresAt)
  return txId
}

/** Single use: the record is deleted atomically whether or not the callback then succeeds. */
export async function consumeTransaction(
  store: SessionStore,
  txId: string,
  now: number,
): Promise<LoginTransaction | null> {
  const raw = await store.take(txKey(txId))
  if (raw === null) return null
  const parsed = transactionSchema.safeParse(JSON.parse(raw))
  if (!parsed.success || parsed.data.expiresAt <= now) return null
  return parsed.data
}
