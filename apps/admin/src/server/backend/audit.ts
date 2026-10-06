import 'server-only'
import { auditListSchema, auditPath, type AuditQuery } from '@/lib/audit'
import { readAsAdmin } from './session-read'

export const readAudit = (q: AuditQuery) => readAsAdmin(auditPath(q), auditListSchema)
