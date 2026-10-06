# Integration evidence

Everything below ran against local doubles. NO test in this program touched the real backend, real Google Workspace, staging
or production data.

| Layer                                             | What ran                                                                                                                                         | Result at last run (stack head)                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Lint / typecheck / format                         | eslint, `tsc --noEmit`, prettier                                                                                                                 | clean                                                                              |
| Unit + component                                  | vitest (jsdom)                                                                                                                                   | 383 passed                                                                         |
| Integration                                       | vitest + Valkey container, real session/BFF code, fake backend                                                                                   | 37 passed                                                                          |
| Browser E2E                                       | Playwright Chromium, real Next runtime, mock OIDC provider, token-verifying fake backend, Valkey                                                 | 42 passed twice consecutively; + responsive sweep (5 tests)                        |
| Production build                                  | `next build`                                                                                                                                     | passes                                                                             |
| GitHub CI (web-ci, 7 jobs incl. dependency audit) | PRs #5-#14                                                                                                                                       | green (7/7 each) when last checked; later PRs pending/unchecked at time of writing |
| Contract check                                    | agent-extracted matrix of backend main `c3306b6` with file:line citations; spot-checked by hand for dashboard, notifications, content, order ids | not an automated contract test                                                     |

## What "BACKEND_CONNECTED (mock)" means

The page, BFF spec, schemas and tests were written from the backend source at `c3306b6`, and the fake backend mirrors those
rules (versions, error codes, role access). That proves the CMS is internally consistent with the documented contract. It does
NOT prove the deployed backend behaves that way. First real verification needs: a staging backend with the admin OIDC audience
set to the CMS Google client id, human test accounts for each of the five roles, and a non-production database.
