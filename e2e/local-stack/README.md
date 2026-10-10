# Local cross-stack E2E harness (Phase 13)

Runs the real Tazzzo backend jar, the real storefront (production build) and a real Chromium against real MongoDB, Redis and
an S3-compatible object store, all on one machine, loopback only. It exists because staging is not approved yet.
**Nothing here touches AWS or any shared environment.** No AWS profile, SDK, CLI or credential is used. Every secret is a
random local value generated into `run/stack.env` (git-ignored). Evidence files never contain a token, OTP, session token or
presigned query string.

It ports and extends the Phase 8 media/content harness (PR #23): same stack, now on current `main` of both repos, with the
whole shopper path (sign-in, cart, delivery, checkout, orders), imports, inventory and staff operations added.
**Not wired into CI, on purpose:** it needs a Docker daemon, three container images (`mongo:7`, `redis:7-alpine`, the pinned
`versity/versitygw`), Java 21, a ~3 min Maven build of the backend, a Next.js production build and Chromium, and a full run takes
about 20 minutes (the storefront's documented 60 s read cache makes several journeys wait). The repo's own CI jobs (unit,
component and fake-backend E2E) stay fast and hermetic.

## What runs

| Piece | What | Where |
| --- | --- | --- |
| Backend | `tazzzo-backend` `origin/main`, built from a clean worktree (`scripts/backend-build.sh`), `java -jar`, Java 21. Migrations V0001..V0018 applied by its normal startup path (`TAZZZO_MIGRATION_MODE=APPLY_ON_STARTUP`, `TAZZZO_MIGRATION_ENVIRONMENT=local`, `docs/database/DATABASE_MIGRATION_RUNBOOK.md`) | `127.0.0.1:8080` |
| MongoDB 7 | single-node replica set `rs0` (transactions) | `127.0.0.1:27117` |
| Redis 7 | consumer + OTP rate-limit store (`TAZZZO_CONSUMER_RATE_LIMIT_MODE=REDIS`) | `127.0.0.1:6391` |
| Object store | Versity S3 Gateway, the image digest `S3SignatureEnforcementIT` pins (SigV4, `If-None-Match`), bucket CORS via `PutBucketCors` | `127.0.0.1:7070` |
| CDN stand-in | `lib/cdn-proxy.mjs`: HTTPS, self-signed cert, GET/HEAD of `p/*` and `c/*` only, reads the private bucket with signed S3 calls, `Cache-Control: public, max-age=31536000, immutable` | `https://localhost:8443` |
| OTP gateway stand-in | `lib/otp-sink.mjs`: receiver for the backend's real `HttpOtpDeliveryProvider` (see "OTP" below) | `127.0.0.1:7181` |
| Admin JWKS stand-in | `lib/idp.mjs`: public key set for the human-admin trust (see "Admin credentials") | `127.0.0.1:7182` |
| Counting proxy | `lib/api-proxy.mjs`: between the storefront server and the backend; records method/path/query and which trusted-caller headers were present (never secrets, bodies) | `127.0.0.1:8081` |
| Storefront | `apps/storefront` of this repo, `next build` + `next start`, `NODE_ENV=production` | `http://localhost:3100` |
| CMS origin | a loopback page at the CMS origin used only for the browser-direct presigned PUT | `http://localhost:3000` |

## Usage (one command per step; idempotent and re-runnable)

```bash
cd e2e/local-stack
./scripts/down.sh          # stop and remove everything this harness started (by label / pid file only)
./scripts/up.sh            # containers, bucket + CORS, cert, stand-ins, backend jar (built from backend origin/main if needed)
./scripts/seed.sh          # release R1, service areas, delivery windows, 4 products + prices + stock, through the admin API
./scripts/web.sh start     # storefront production build + server (counting proxy first)
./scripts/journeys.sh      # 28 journeys + 6 controls; evidence -> evidence/<date>/ ; exit 0 only if all PASS
```

A subset: `./scripts/journeys.sh -g 'J1[0-9]'`. `down` before `up` gives a fresh database every cycle. `up.sh` and `seed.sh` can
be re-run on a running stack; `web.sh stop` stops the storefront and the proxy; `scripts/cdn.sh stop|start|status` is the CDN outage switch.

Requirements: Docker (images present or pullable), Java 21 (`JAVA_HOME_21`, default `/usr/lib/jvm/java-21-openjdk-amd64`), Node 22+ and
`pnpm install --frozen-lockfile` at the repo root (the harness adds no dependency: Playwright is the storefront's pinned
`@playwright/test`, reached through a git-ignored `node_modules` symlink; Chromium comes from `PLAYWRIGHT_BROWSERS_PATH`), `openssl`, `curl`.
The backend repo is only read: `E2E_BACKEND_REPO` (default `../tazzzo-backend`) gets a `git fetch` and a detached worktree at
`E2E_BACKEND_DIR` (default `../tazzzo-backend-e2e-main`). Put local overrides in the git-ignored `local.env`.
Every script stops if less than 3 GB is free.

## How the journeys are driven

- **Storefront journeys** run in a real Chromium against the production server: sign-in through `/login`, the address form, PDP, cart, delivery slots, review and place.
- **Admin (CMS) steps** are the exact calls the CMS BFF makes (`apps/admin/src/server/bff/*-actions.ts`, `server/backend/*.ts`; every helper in `tests/support.ts` names its source). The CMS UI itself is not driven: its only login is Google OIDC.
  Features the CMS on `main` has no BFF for yet (async import jobs, the admin stock list) are called per `docs/ops/BULK_IMPORT.md` / the OpenAPI.
- **Admin credentials.** `cms-writer` and `reader` steps use the backend's static local tokens. The staff roles (`order-ops`, `support-agent`) are human-only in the backend,
  so those steps send an RS256 ID token minted with a throwaway key whose public half `lib/idp.mjs` serves as the backend's JWKS (`tazzzo.admin.oidc.jwks-uri`, the documented
  loopback override). The backend still verifies issuer, audience, `hd`, `email_verified`, the allowlisted `sub` and its role. No auth bypass exists in this harness.
- **OTP.** `TAZZZO_OTP_PROVIDER_MODE=LOGGING` cannot be used to sign in: `LoggingOtpDeliveryProvider` logs a masked phone and never the code (by design). The harness therefore
  runs the backend's real HTTP adapter (`provider-mode=HTTP`, `docs/ops/OTP_GATEWAY.md`) against `lib/otp-sink.mjs`, which writes the delivered code to `run/sms/` (git-ignored).
- **Trusted caller.** The backend is started with `TAZZZO_CONSUMER_TRUSTEDCALLERS_0_*`; the storefront with the same `TAZZZO_CALLER_NAME/SECRET`, plus `STOREFRONT_SESSION_SECRET` and
  `STOREFRONT_TRUST_PROXY=true` (production fail-closed rules in `apps/storefront/src/server/env.ts`). The per-visitor rate limit is loosened for the run and each browser gets its own `X-Forwarded-For`.
- **Test accelerators** (set by `up.sh`, defaults are production values): OTP resend cooldown 2 s, import lease 60 s / tick budget 20 s, card projection every 3 s.

## Caching you will see

- Public `/v1/content/home` is `Cache-Control: public, max-age=60`; the backend itself does not cache.
- The storefront caches backend reads for 60 s and serves one stale copy while revalidating, so admin changes reach product, home and category pages within roughly 60-120 s.
  Journeys poll the page and log the elapsed time. The cart, checkout and order pages are never cached.
- Scheduling is verified on the real clock (a block whose window opens ~100 s after publishing), not by mocking time.

## Evidence

`evidence/<date>/transcript.txt` (every HTTP exchange and command, redacted, with `CHECK PASS|FAIL` lines), `results.json`, `summary.txt`, `playwright-output.txt`, `screens/*.png`.
`EVIDENCE_<date>.md` summarises a run (versions, SHAs, per-journey verdicts with transcript line references, product bugs found).

## Safety

Containers carry the label `tazzzo-e2e-local` and `down.sh` removes only those; processes are tracked by pid file under `run/pids`; every port binds to loopback; the CDN certificate
is self-signed and trusted only by the test browser (`ignoreHTTPSErrors`) and by `curl --cacert`. No system trust store is touched.
