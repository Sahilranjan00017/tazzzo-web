import { z } from 'zod'

/** Backend `/health/live` and `/health/ready` (unauthenticated). Component values are short status words. */
export const healthSchema = z.object({
  status: z.string(),
  components: z.record(z.string(), z.string()).default({}),
})
export type Health = z.infer<typeof healthSchema>
