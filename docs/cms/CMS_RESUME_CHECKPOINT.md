# CMS resume checkpoint

Updated: 2026-10-06. Re-verify git and PR state before acting on anything below.

## Reconciliation (verified live)

- tazzzo-web `main` = `origin/main` = `e1a105619b09b431bd4c47c29ec16b6042412bb6` (PR #3 squash).
- PRs #1-#3 merged. PR #4 (`feature/w4-cms-shell`) OPEN, not merged; merging needs explicit user authorization.
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
