import 'server-only'
import { dashboardSchema, DASHBOARD_PATH } from '@/lib/dashboard'
import { readAsAdmin } from './session-read'

export const readDashboard = () => readAsAdmin(DASHBOARD_PATH, dashboardSchema)
