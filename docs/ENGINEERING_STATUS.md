# Engineering status

| Area                                                | State       | Record                                                                                                  |
| --------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| W1 CMS foundation scaffold (`apps/admin`)           | COMPLETE    | PR #1, squash `ddcec0ac3be4a806f66bb8c61e849c8164015c01`, merged-main CI 37102719951, 28/28             |
| W2 Google OIDC + server-side CMS session + `/me`    | COMPLETE    | PR #2, squash `85b1cfc664a622b1eb2cb08649fd526321badbd5`, merged-main CI 37111882071, 67 + 30 = 97      |
| W3 narrow BFF mutation layer + auth/audit hardening | COMPLETE    | PR #3, merged 2026-10-03, squash `e1a105619b09b431bd4c47c29ec16b6042412bb6`, merged-main CI 37114859716 |
| W4 CMS shell (nav, roles, toasts, dialogs, states)  | IN REVIEW   | Profile & access page is BACKEND_CONNECTED (`/me`); every other module is NOT STARTED                   |
| CMS business modules                                | NOT STARTED |                                                                                                         |
| Scheduler / cron                                    | NOT STARTED | Architecture note below                                                                                 |
| Customer web app (`apps/web`)                       | NOT STARTED |                                                                                                         |

**W3 (merged, PR #3):** a narrow BFF mutation layer (`src/server/bff/mutation.ts`). There is no generic proxy: every route
declares its one backend path, method, strict request schema, response schema and header allowlist. Each mutation
checks the CSRF rule (exact Origin + `X-Tazzzo-CSRF: 1`), requires `application/json`, bounds the body at 16 KiB, needs
a valid server-side session, and makes one backend call with only the human's Google ID token (no cookies, no
forwarded headers, no redirects followed, 5 s timeout, never retried). Backend 401 ends the session; 403 keeps it.
Responses are normalized `no-store` JSON with a BFF correlation id and the backend's own `X-Request-Id`. Reference
route: `PATCH /api/bff/catalog/products/{id}/title` -> backend `PATCH /api/v1/products/{id}` (If-Match). Playwright E2E
(Chromium) drives the real runtime with a mock OIDC provider, a token-verifying fake backend and Valkey.

**Deferred:** a cross-repo run against the real backend. The backend accepts only Google's issuer and the web mock
issuer cannot impersonate it without weakening production validation. HUMAN_ADMIN attribution of product mutations
is proven on the backend side (`HumanAdminOidcIT`); cross-repo human audit verification through the CMS moves to the
first real admin mutation slice.

**Not yet:** production deployment, humans moved off the shared `cms-writer` token, audit-read API, fine-grained
permissions, the six backend deployment gates, Pricing LOW-1 (before Pricing Admin). Sensitive admin modules are not
ready. Payment is deferred and comes last.

**Backend contracts:** `docs/backend-contracts/` holds the endpoint references extracted from the backend PRs
(#54-#81, read from an integration checkout, not from `main`). Most of those endpoints are not on backend `main` yet,
so every module built against them is UI-only until it is verified on staging. Notable: concurrency uses
`expectedVersion` in the body (products use `If-Match: <int>`), there is no notification-outbox admin API, no price or
inventory list API, and media uploads return 503 until a storage provider exists.

## Scheduler / cron (architecture note, not implemented)

Production scheduled work will not run inside the CMS. Planned model: AWS EventBridge Scheduler (or a scheduled ECS
task) -> backend internal job/service -> database/queue; the CMS only displays and manages it. A later dedicated CMS
"Scheduler" page would show job name, schedule, enabled state, last/next run, status, duration, retry count, a manual
"Run now" (through a narrow BFF mutation) and execution history.
