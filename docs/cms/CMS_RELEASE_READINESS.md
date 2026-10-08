# CMS release readiness

Date of assessment: 2026-10-07. Evidence: see CMS_INTEGRATION_EVIDENCE.md, CMS_SECURITY_REVIEW.md, CMS_VISUAL_QA.md,
CMS_MODULE_MATRIX.md. All figures are engineering judgements with the stated denominators, not measurements of a running system.

## The five numbers

| Measure                  | Value | Denominator and basis                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CMS CODE COMPLETENESS    | ~89%  | 16 of 18 modules: 15 built to their full backend-supported scope (dashboard, products, taxonomy, imports, pricing, inventory, orders, serviceability, slots, support, RBAC, FAQ, app config, audit, system status), 2 half (media: no upload; notifications: counters only), 1 not built (home content, gated). Within "built", advanced catalogue operations are not built (bundles/variant packs, merge, taxonomy move/merge/split, attribute schemas, evidence, classify, GTIN bind) |
| CMS BACKEND-INTEGRATION  | ~89%  | Same 16/18 are coded against endpoints that exist on backend main and are contract-matched in tests. Caveat: only against a mock; no module is verified against the deployed backend                                                                                                                                                                                                                                                                                                    |
| CMS REAL-DATA VERIFIED   | 0%    | 0 of 18 modules read or wrote real backend data                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CMS STAGING READINESS    | ~20%  | Build, CI and tests are green, env vars are documented, but there is no staging backend wired to the CMS Google client id, no role test accounts, no run against staging, and backend gates are open                                                                                                                                                                                                                                                                                    |
| CMS PRODUCTION READINESS | ~5%   | Security/deployment gates open (backend PR #91, real-data verification, staging, media provider, notification provider, legal content, DNS/TLS/deploy config), nothing deployed                                                                                                                                                                                                                                                                                                         |

## Go / no-go

| Question                  | Decision               | Why                                                                                                                                 |
| ------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Demo                      | GO (mock data, say so) | All built modules render and run end to end against the mock                                                                        |
| Internal development use  | GO                     | Developers can build against it; checks are green                                                                                   |
| Test against staging      | CONDITIONAL GO         | Needs a staging backend with matching OIDC audience and five role accounts; first run will surface integration bugs the mock cannot |
| Release to internal staff | NO-GO                  | Zero real-data verification; no idempotency keys on the backend; home content, image upload and advanced catalogue ops missing      |
| Promote to production     | NO-GO                  | Security/deployment gates open; no real-environment evidence                                                                        |

## Blockers by owner

- Backend: channel/audience change (approved direction, implementation not authorized); notification, price-list, stock-list and release-list endpoints; idempotency keys; text search; banner media owner type; backend security PR #91.
- External: media storage provider and CDN; notification provider; staging environment and credentials; legal policy content; DNS/TLS/deployment; website design and repo.
- Product: promotions model (separate gap doc); legacy content default is decided (BOTH).
- CMS (independently executable, not done): advanced catalogue operations; taxonomy move/merge/split and attribute schemas; deeper a11y/contrast audit; dark-mode review; fuller visual QA of error/empty states.
