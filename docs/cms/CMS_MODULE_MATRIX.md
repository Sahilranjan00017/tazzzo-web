# CMS module matrix

Labels: NOT_STARTED, IN_PROGRESS, UI_COMPLETE, BACKEND_CONNECTED, REAL_DATA_VERIFIED, BLOCKED_BY_*, READY.
Nothing is REAL_DATA_VERIFIED or READY: no real staging backend or credentials have been used. "Tests" means mock-backed
unit/component/integration/Playwright runs, never a real backend.

| #      | Module           | Slice  | Status                   | Evidence / blocker                                                                              |
| ------ | ---------------- | ------ | ------------------------ | ----------------------------------------------------------------------------------------------- |
| 1      | Dashboard        | CMS-01 | BACKEND_CONNECTED (mock) | Reads `GET /api/v1/admin/dashboard/summary`; reader/cms-writer only; real staging read not done |
| 12     | Profile & access | W4     | BACKEND_CONNECTED        | Merged PR #4; `/me` only                                                                        |
| others | all remaining    | -      | NOT_STARTED              |                                                                                                 |

Dashboard notes: the backend gives "last 24h" counts, not "today"; only open_confirmed / open_out_for_delivery for open
orders (no full by-status breakdown); no recent-activity feed (audit is a separate role). Shown exactly as stated.
