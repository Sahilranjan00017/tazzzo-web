# Local E2E harness: media + CMS home content (Phase 8 "E2E-MEDIA", local)

This harness runs the media and CMS-content stack end to end on one Mac. It exists because staging S3 and CloudFront are not
approved yet. **Nothing here touches AWS or any shared environment.** No AWS profile, SDK, CLI or credential file is
used. All secrets are local random values generated into `run/stack.env`, which is git-ignored.

| Piece        | What runs                                                                                                                                                                                                              | Where                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Backend      | `tazzzo-backend` `integration/media-content` (PR #105), the built jar run with `java -jar` (Java 21)                                                                                                                   | `http://localhost:8080`  |
| MongoDB 7    | single-node replica set `rs0` (transactions need it), started like the dev compose stack                                                                                                                               | `127.0.0.1:27117`        |
| Redis 7      | consumer rate limiter (REDIS mode, permissive local budgets)                                                                                                                                                           | `127.0.0.1:6391`         |
| Object store | Versity S3 Gateway, **the same image digest `S3SignatureEnforcementIT` pins** (SigV4 + `If-None-Match` enforcing). `posix` backend in the container, ephemeral                                                         | `http://127.0.0.1:7070`  |
| CDN stand-in | `lib/cdn-proxy.mjs`: HTTPS, self-signed cert. GET/HEAD for `p/*` and `c/*` only. Reads the private bucket with **signed** S3 calls (like CloudFront OAC) and adds `Cache-Control: public, max-age=31536000, immutable` | `https://localhost:8443` |
| Website      | `tazzzo-web` `web/01-storefront` (PR #20), `apps/storefront`, **production build** (`next build` + `next start`, the way the repo's own prod E2E runs it)                                                              | `http://localhost:3100`  |
| CMS origin   | a harness page served by a real loopback server at the CMS origin, used only for the browser-direct presigned PUT (see "CMS: what is UI-driven")                                                                       | `http://localhost:3000`  |
| App          | `tazzzo-app` `feature/app-home-content` (PR #24): the app's shared Kotlin running on the JVM (see "App")                                                                                                               | n/a                      |

Backend configuration:

- `tazzzo.media.storage.provider=s3`, with the endpoint pointing at versitygw, path-style addressing and static local credentials (`docs/ops/MEDIA_STORAGE.md`).
- `tazzzo.media.public-base-url=https://localhost:8443`.
- `tazzzo.freshness.enabled=true` and `tazzzo.scheduler.card-projection-enabled=true`, so the grid and rail cards rebuild after price and media writes.
- `TAZZZO_MIGRATION_MODE=APPLY_ON_STARTUP` with `TAZZZO_MIGRATION_ENVIRONMENT=local`. This is the documented local path, and it applies the frozen taxonomy seed.
- Static admin tokens `tazzzo.auth.cms-token` and `read-token`, set to local random values.

## Usage

```bash
cd e2e/local-stack
./scripts/up.sh          # containers, bucket + CORS (PutBucketCors), cert, CDN stand-in, backend
./scripts/seed.sh        # release R1, 3 products (TZP-90000101..103), prices
./scripts/web.sh start   # storefront, production mode (`web.sh start dev` for next dev)
./scripts/journeys.sh    # tests/media-content.spec.ts; evidence -> evidence/<date>/
./scripts/down.sh        # stops every process and container this harness started (by pid file / label only)
```

Individual controls:

- `scripts/cdn.sh stop|start|status`: the TEST 14 outage switch.
- `scripts/app-jvm.sh <name>`: one app checkpoint.
- `node lib/s3-admin.mjs ls|head <key>|get-cors`: inspect the bucket.

Requirements:

- Docker running, with `mongo:7`, `redis:7-alpine` and the pinned `versity/versitygw` image already present. The harness pulls nothing else.
- Temurin 21.
- The three feature worktrees (paths in `scripts/common.sh`, overridable with `E2E_*_DIR`) with their `node_modules` installed.
- The Android SDK, for the app's JVM unit-test toolchain.

Every script stops if less than 3 GB is free on `/System/Volumes/Data`.

**No dependency is added.** Playwright is the storefront worktree's installed `@playwright/test` 1.63.0, reached through a
git-ignored `node_modules` symlink, and it uses Chromium from the local Playwright cache. The S3 calls use
`lib/s3.mjs`, a ~80-line SigV4 signer that refuses any non-loopback endpoint.

## Seeding (as the ITs do)

- **Taxonomy:** the migration runner applies the frozen seed at startup. `seed.sh` then creates and publishes release `R1` through the CMS API, as `LOCAL_DEVELOPMENT.md` §2 describes.
- **Products:** validator-conformant documents inserted the way `AbstractConsumerIT.product(...)` does it: active, confirmed, vertical `TZV-000001`.
  - Ids are numeric because the app's rail and link mapping accepts only `^TZP-[0-9]+$`.
- **Prices:** set through `PUT /api/v1/admin/prices/{sku}`.

## CMS: what is UI-driven and what is API-driven

The CMS (`apps/admin`, PR #22) has only one login: Google OIDC. Its BFF calls the backend with the signed-in human's
Google ID token, and the backend accepts ID tokens **only from Google's issuer**. The CMS's own E2E uses a mock OIDC
provider together with a **fake** backend. The real backend has no local issuer and no dev session, so the CMS UI can
only be driven against it by adding an auth bypass, and this harness refuses to add one.

What the journeys do instead:

- **API-driven:** every CMS step sends the exact backend call the BFF makes. Method, path and body shape are copied
  from `apps/admin/src/server/bff/*-actions.ts`, and `tests/support.ts` cites the source file next to each call.
- **Token:** those calls use the backend's static local `cms-token` (cms-writer) or `read-token` (reader).
- **Browser-driven:** the presigned PUT is the CMS's `putToStorage` logic (`apps/admin/src/lib/upload.ts`). A real
  Chromium XHR sends it from a page on the CMS origin `http://localhost:3000` to versitygw, so the CORS preflight is the
  store's own (bucket CORS set with `PutBucketCors`).
- **The page is a real server, on purpose.** The CMS-origin page comes from a loopback HTTP server, not from
  `page.route`. A route-fulfilled page has no address, so Chromium's Local Network Access check refuses its requests to
  the loopback store. No Chromium flag is changed.
- **Not run:** the CMS UI screens themselves (editor, preview page, media manager).

## App

The app's debug build cannot reach a local backend without app changes:

- **Base URL:** it is fixed to an enum of https hosts, and `ReleaseHardeningTest` forbids loopback entries.
- **Cleartext:** `usesCleartextTraffic="false"` is set, and there is no debug network-security config.
- **Images:** banner and gallery images must be https.

So **on-device rendering is NOT verified**. Instead, `scripts/app-jvm.sh` copies `app-jvm/LocalBackendE2ETest.kt` into the
app worktree's `androidUnitTest` source set **for one run** and deletes it again on exit, so the app branch is never
modified. It runs that test with `testDebugUnitTest` (OkHttp engine, real HTTP). The test uses the app's real `ApiClient`,
`RemoteContentDataSource` with its `toDomain()` mapping, `RemoteCatalogDataSource.product`, and `KtorImageFetcher`.

For image fetches it uses the app's own fetcher configuration, trusting only the stand-in's certificate. Decoding to a
bitmap and Compose rendering are not exercised: `BitmapFactory` is a stub on the JVM.

The test skips itself unless `TAZZZO_E2E_BACKEND` is set.

## Caching you will see

- **Public `/v1/content/home`:** `Cache-Control: public, max-age=60`. The backend itself does not cache, so a change is visible to the next request.
- **Storefront home and PDP reads:** cached for 60 s, and one stale copy is served while the cache revalidates. The journeys reload until the expected state appears and log how long that took.
- **CDN objects:** immutable. Keys are write-once (`If-None-Match: *` is signed), so a replaced image always gets a new key.

## Safety

- **Containers:** they carry the label `tazzzo-e2e-local`, and `down.sh` removes only those.
- **Processes:** the harness tracks them through pid files under `run/pids`.
- **Network exposure:** every port binds to loopback.
- **The certificate:** it is self-signed and valid for 2 days. Only the test browser (`ignoreHTTPSErrors`) and curl/JVM checks via `--cacert` or an explicit trust store accept it. No system trust store is touched.
- **Evidence files:** the role is printed in place of any token, and presigned query strings are redacted.
