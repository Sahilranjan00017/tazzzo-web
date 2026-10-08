# CMS resume checkpoint

Updated: 2026-10-06. Re-verify git and PR state before acting on anything below.

## Reconciliation (verified live)

- tazzzo-web `main` = `175e6092c364fb84f9be18c3354be23b00261462` (PR #4 squash, merged 2026-10-06 on user authorization after head a6a091e had full green CI).
- PRs #1-#4 merged. Later PRs are never merged without explicit user approval.
- One worktree, no stashes, only untracked `.serena/` (left alone).
- web-ci green on PR #4 at the prior head `c1777b0` (run 37372527853).
- Backend `origin/main` = `c3306b6e894cf5d2b09cc2ef0171b36f3d50d6dc`; security PR #91 still open; Dependabot PRs #82-#89 open.

## Milestone 1: PR #4 hardening (done locally, pushed)

| Item                              | Fix                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| A. inline style in `global-error` | imports `globals.css`, uses `.fatal` class; repo-policy test bans `style=` in source          |
| B. closed mobile drawer focusable | `visibility:hidden` on closed `.sidebar` under 900px (delayed on close); Escape closes drawer |
| C. account menu ARIA              | plain disclosure (`aria-expanded`/`aria-controls`), no `role=menu`/`menuitem`/`aria-haspopup` |
| D. status contradiction           | W3 shown COMPLETE and "merged" consistently, with squash SHA and CI run                       |

Local gates on the hardening commit: eslint clean, `tsc --noEmit` clean, vitest unit+component 106/106, `next build` OK,
prettier clean. Integration and Playwright suites were NOT re-run (they need Valkey / Docker); CI is the evidence.

## Backend contract matrix (done, agent-written, spot-checked)

`docs/cms/CMS_BACKEND_CONTRACT_MATRIX.md` covers backend main `c3306b6` with file:line citations. Only the dashboard and
notification rows were spot-checked by me; treat the rest as unverified until the slice that uses it re-reads source.
Headlines: exactly five roles; dashboard readable only by `reader`/`cms-writer`; orders/support need the human's own OIDC
token; no `Idempotency-Key` anywhere; no notification, price-list or inventory-list endpoints; product edit is title-only
with no text search; release API exists but cannot list/discover the open release; `/publish` is claim-publish and the
product lifecycle action is `/activate`; docs/backend-contracts has no drift against main.

## Next independent tasks

1. Add the matrix sharpenings (audit-reader conditions, reader/cms-writer cannot reach orders/support) to `docs/backend-contracts/*`.
2. CMS-01 dashboard on a new branch stacked on `feature/w4-cms-shell` (PR #4 unmerged).
3. Then CMS-02.. in the order of the master prompt, one PR per slice.

## Approvals required

- Merge of PR #4 (and any later PR). No deploys, no staging mutations without credentials.

## Update: CMS-01 dashboard (branch `cms/01-dashboard`, stacked on `cms/00-contract-matrix`, which is docs-only off main 175e609)

Added: `src/server/backend/{read,session-read,dashboard}.ts` (narrow server-side GET, human token only, no redirects, 5 s,
closed result union), `src/lib/{backend-result,dashboard,format}.ts`, `components/dashboard/DashboardView.tsx`,
`RefreshButton`, `/dashboard` page, green accent tokens, dashboard fake-backend endpoint. `moduleHref()` makes metric links
appear only once the target module is `available` in nav.
Local gates: eslint, tsc, 124 unit+component, 37 integration, 10 Playwright (mock backend), build, prettier: all pass.
NOT done: screenshots/visual QA at 360-1440px, real staging read.
Convention for later slices: flip the module to `available` in `src/lib/nav.ts`, read via `readAsAdmin`.
