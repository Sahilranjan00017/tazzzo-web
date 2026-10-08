import 'server-only'
import { z } from 'zod'
import { setInput, uploadRequestInput } from '@/lib/media'
import type { UploadTarget } from '@/lib/upload'
import type { BffMutationSpec } from './mutation'
import {
  sizeLimitDetail,
  toUploadTarget,
  uploadOriginPrecondition,
  uploadTargetOut,
} from './upload-target'

const setOut = z.object({ ownerType: z.string(), ownerId: z.string(), version: z.number().int() })

/**
 * `PUT /api/v1/admin/media/{ownerType}/{ownerId}`: whole-set replace (role, order, alt text, removal, and new keys from
 * uploads). With storage configured the backend verifies every NEWLY referenced key (issued for this owner, present in
 * storage, an allowed image of the declared type, within the size ceiling) and answers 422 INVALID_MEDIA otherwise,
 * 503 MEDIA_STORAGE_UNAVAILABLE on a storage outage. New keys only ever come from targets the backend issued, which it
 * does only while storage is configured. A stale version gives 409 STALE_VERSION.
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
  errorDetail: sizeLimitDetail,
}

/**
 * `POST /api/v1/admin/media/uploads`: a presigned, single-use, direct-to-storage target for one server-generated key
 * (bound to the declared type and size, write-once). Forwarded to the browser only after validation: the URL must be on
 * the configured `CMS_MEDIA_UPLOAD_ORIGIN` (the only extra CSP `connect-src`) and the headers carry no credential. With
 * no origin configured the backend is not called (503 UPLOAD_ORIGIN_NOT_CONFIGURED). Storage off on the backend: 503
 * MEDIA_STORAGE_NOT_CONFIGURED (passed through by code).
 */
export const requestUploadMutation: BffMutationSpec<
  z.infer<typeof uploadRequestInput>,
  z.infer<typeof uploadTargetOut>,
  UploadTarget
> = {
  routeId: 'media.upload-request',
  method: 'POST',
  input: uploadRequestInput,
  backend: (input) => ({ path: '/api/v1/admin/media/uploads', body: input }),
  output: uploadTargetOut,
  toClient: toUploadTarget,
  precondition: uploadOriginPrecondition,
  errorDetail: sizeLimitDetail,
}
