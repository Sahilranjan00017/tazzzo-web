import { expect, type APIRequestContext, type Page } from '@playwright/test'

export const OIDC = () => process.env.E2E_OIDC_URL!
export const BACKEND = () => process.env.E2E_BACKEND_URL!

/** Resets the fake backend, then signs the given subject in through the mock Google provider. */
export async function signInFresh(page: Page, sub: string) {
  await page.request.post(`${BACKEND()}/__control/reset`, { data: {} })
  await page.request.post(`${OIDC()}/__control/identity`, {
    data: { sub, email: `${sub}@tazzzo.test` },
  })
  await page.goto('/')
  await page.getByRole('link', { name: 'Sign in with Google' }).click()
  await expect(page.getByRole('button', { name: /Account menu/ })).toBeVisible()
}

export const control = (request: APIRequestContext, path: string, data: unknown = {}) =>
  request.post(`${BACKEND()}/__control/${path}`, { data })

export async function recorded(request: APIRequestContext) {
  return (await (await request.get(`${BACKEND()}/__control/requests`)).json()) as {
    method: string
    path: string
    sub?: string
    body: string
    authorization?: string
    headers: Record<string, string>
  }[]
}

export async function seedJob(
  request: APIRequestContext,
  spec: { status: string; rows?: number; note?: string; invalidRows?: number[] },
): Promise<string> {
  const res = await control(request, 'jobs/seed', spec)
  return ((await res.json()) as { id: string }).id
}

/** Waits for hydration so a click or a chosen file is not lost to a not-yet-attached handler. */
export const settled = (page: Page) => page.waitForLoadState('networkidle')
