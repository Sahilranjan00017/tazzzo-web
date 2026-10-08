import 'server-only'
import { z } from 'zod'
import { setInput, uploadRequestInput } from '@/lib/media'
import type { BffMutationSpec } from './mutation'

const setOut = z.object({ ownerType: z.string(), ownerId: z.string(), version: z.number().int() })

/**
 * `PUT /api/v1/admin/media/{ownerType}/{ownerId}`: whole-set replace (metadata: role, order, alt text, removal). While no
 * storage provider is configured the backend accepts keys UNVERIFIED; this CMS therefore never adds new keys, it only
 * edits the set the backend already holds. A stale version gives 409 STALE_VERSION.
 */
export const putMediaSetMutation: BffMutationSpec<
  z.infer<typeof setInput>,
  z.infer<typeof setOut>,
  z.infer<typeof setOut>
> = {
  routeId: 'media.set',
  method: 'PUT',
  input: setInput,
  backend: ({ ownerType, ownerId, assets, expectedVersion }) => ({
    path: `/api/v1/admin/media/${ownerType}/${encodeURIComponent(ownerId)}`,
    body: { assets, ...(expectedVersion ? { expectedVersion } : {}) },
  }),
  output: setOut,
  toClient: (o) => o,
}

const uploadOut = z.object({ assetKey: z.string(), expiresAt: z.string().nullish() })

/**
 * `POST /api/v1/admin/media/uploads`: asks the backend for a signed upload target. The signed URL, method and headers in
 * the backend response are deliberately NOT forwarded to the browser: this build has no direct-upload step (provider and
 * CSP origin pending), so it only reports whether the backend could issue a target (storage readiness). Today the answer
 * is 503 MEDIA_STORAGE_NOT_CONFIGURED.
 */
export const requestUploadMutation: BffMutationSpec<
  z.infer<typeof uploadRequestInput>,
  z.infer<typeof uploadOut>,
  { ready: true }
> = {
  routeId: 'media.upload-request',
  method: 'POST',
  input: uploadRequestInput,
  backend: (input) => ({ path: '/api/v1/admin/media/uploads', body: input }),
  output: uploadOut,
  toClient: () => ({ ready: true }),
}
