# Engineering status

| Area                                                | State       | Record                                                                                      |
| --------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| W1 CMS foundation scaffold (`apps/admin`)           | COMPLETE    | PR #1, squash `ddcec0ac3be4a806f66bb8c61e849c8164015c01`, merged-main CI 37102719951, 28/28 |
| W2 Google OIDC + server-side CMS session + `/me`    | IN REVIEW   |                                                                                             |
| BFF mutation routes, Playwright/cross-repo E2E (W3) | NOT STARTED |                                                                                             |
| CMS business modules                                | NOT STARTED |                                                                                             |
| Customer web app (`apps/web`)                       | NOT STARTED |                                                                                             |

**W2 (in review):** Google authorization-code sign-in started by a GET link (`openid-client` v6: state, OIDC nonce,
PKCE S256, ID-token signature/issuer/audience/expiry checks), a single-use login transaction and an opaque session in
Valkey/Redis (keys are SHA-256 of the identifiers; the Google ID token is AES-256-GCM encrypted at rest; access and
refresh tokens are never kept), `__Host-` HttpOnly Secure SameSite=Lax cookies, session expiry capped at the ID token's
expiry minus 60 s (8 h absolute cap, 30 min idle), CSRF-checked POST logout, and the backend `GET /api/v1/admin/me`
bootstrap with the human ID token (401 ends the session; 403 shows access denied; never a service-token fallback).

**Not yet:** production deployment, humans moved off the shared `cms-writer` token, audit-read API, fine-grained
permissions, the six backend deployment gates, Pricing LOW-1 (before Pricing Admin). Sensitive admin modules are not
ready. Payment is deferred and comes last.
