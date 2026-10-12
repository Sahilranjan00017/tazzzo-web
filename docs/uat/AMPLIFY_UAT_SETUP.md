# UAT web hosting on AWS Amplify (storefront and CMS)

Status: **repository side complete; nothing here has been run against AWS** (no AWS credentials existed when this was written, and no AWS API was called). Every statement is tagged **VERIFIED** (checked in this repository, locally, or against a source quoted below), **ASSUMED** (taken from the change request or inferred) or **NOT VERIFIED** (needs a real Amplify app to confirm). Do not treat NOT VERIFIED items as facts.

Related: `amplify.yml`, `scripts/amplify/*`, `.github/workflows/deploy-uat-web.yml`, `apps/*/.env.example`, `docs/storefront/LAUNCH_SCOPE.md`, `docs/cms/CMS_LAUNCH_SCOPE.md`.

## 0. Open decision that blocks the CMS (read first)

**OPEN DECISION: where does the CMS session store live?** `apps/admin` needs a Redis/Valkey session store (`SESSION_STORE_URL`, `rediss://` in production, or loopback). Amplify Hosting compute is not inside our VPC (**ASSUMED from the change request, consistent with Amplify's managed compute; NOT VERIFIED against current docs**), so AWS ElastiCache is unreachable from it, and a loopback Redis is unreachable too. The storefront does **not** need Redis (section 8), so it is unaffected. Options, none chosen here:

| Option                                                                                                                                              | What it means                                                                                                                                                                                                                                                                                                                                                          | For                                                                                                                                                                                                                                                | Against                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Internet-reachable TLS Redis from a managed provider (a free-tier plan, e.g. a serverless Redis). **Provider, pricing and terms NOT VERIFIED.** | Create a database in the same region as Amplify compute, put its `rediss://:<password>@host:port` URL in the Amplify secret `SESSION_STORE_URL`.                                                                                                                                                                                                                       | No AWS infrastructure, no recurring AWS cost, nothing to patch. Only `GET`, `SET .. PX [XX]`, `GETDEL`, `DEL` are used (`apps/admin/src/server/store/redis-store.ts`), so most Redis-protocol services work if they support `GETDEL` (Redis 6.2+). | Session records (encrypted by the app with `SESSION_ENCRYPTION_KEY`, so the provider sees ciphertext and keys/TTLs) sit with a third party: needs a data-processing sign-off. Authentication is the password only (Lambda egress IPs are not fixed, so no IP allow-list). The store client has 2 s connect/command timeouts (`redis-store.ts`): a distant region can make logins flaky. Free tiers may have request or connection caps and no SLA (**NOT VERIFIED**).                                                                                   |
| (b) Valkey with TLS on the UAT EC2 instance, exposed to the internet.                                                                               | Run Valkey (TLS + `requirepass`/ACL) next to the backend, publish a hostname such as `redis-uat.tazzzo.com`, `SESSION_STORE_URL=rediss://...`.                                                                                                                                                                                                                         | No third party, no extra AWS resource, no incremental cost on an existing instance.                                                                                                                                                                | A datastore reachable from the whole internet on a shared UAT host: the security group would have to allow `0.0.0.0/0` on the TLS port (Amplify compute has no stable source addresses), so protection is the password, TLS, patching and rate-limiting only. Needs certificate issuance and renewal for the Redis hostname. Memory/CPU contention with the backend. A compromise of the store exposes session ciphertext, not plaintext, but allows deleting sessions (denial of service) and filling memory. Should be an explicit security sign-off. |
| (c) Run the CMS container on the UAT EC2 instead of Amplify.                                                                                        | `output: 'standalone'` already produces a self-contained server (`apps/admin/.next/standalone/apps/admin/server.js`, **VERIFIED**: CI asserts it). Needs a **Dockerfile (does not exist in this repo)**, TLS termination for `cms-uat.tazzzo.com` (Caddy/nginx/ALB), and Valkey on loopback (`redis://localhost` is accepted by `env.ts` in production, **VERIFIED**). | No internet-exposed datastore, no Amplify limits for the CMS (response size, timeouts), closest to the ratified ECS/Fargate container plan.                                                                                                        | More operational work on the shared host (deploy mechanism, restarts, logs), and the CMS then no longer deploys through Amplify (this workflow and `amplify.yml` would deploy the storefront only). Needs the Dockerfile and a deploy path to be built and reviewed.                                                                                                                                                                                                                                                                                    |

Also possible but **not recommended without approval**: a code change to a DynamoDB-backed session store (the repo policy test forbids in-memory stores; a new store is a security-sensitive change).

The configuration contract below works for any of (a), (b), (c): the only thing that changes is the value of `SESSION_STORE_URL` (or, for (c), where the container runs). Until this is decided, the **admin Amplify app must not be created**; the storefront can go ahead.

## 1. How the apps are built and run on Amplify

### Why the deployment specification and not Amplify's Next.js adapter

- Amplify's documentation for the managed Next.js support states support for Next.js **12 through 15** (**VERIFIED as a search-result excerpt of the official "Amplify support for Next.js" page; the page itself could not be fetched from this environment**). This repository is on **Next.js 16.3.8**, with a Node.js `src/proxy.ts` (the Next 16 name of middleware) carrying the per-request nonce CSP and the storefront rate limit. I found **no** source confirming that the managed adapter handles `proxy.ts`, so correct behaviour there is **NOT VERIFIED and risky**: a silent loss of `proxy.ts` would drop the CSP and the rate limit.
- Amplify also publishes a framework-neutral "deployment specification" (a `.amplify-hosting/` directory with `static/`, `compute/<name>/` and `deploy-manifest.json`; required manifest fields `version`, `routes` with a catch-all, `framework`; **VERIFIED as search excerpts of the official "Using the Amplify Hosting deployment specification" page**, third-party examples show `computeResources[].entrypoint/runtime`).
- This repository therefore ships Next's own **standalone server** as the compute bundle (`scripts/amplify/package-compute.mjs`). `next.config.ts` headers and `src/proxy.ts` run inside Next exactly as they do in the container build, whatever Amplify's adapter supports. **VERIFIED locally**: the packaged storefront and admin bundles were started with `node index.js` on Node 22 with the variables supplied only through `runtime-env.json`; both answered with the nonce CSP (a different nonce per request), `X-Frame-Options: DENY`, `Cache-Control: private, no-cache, no-store`, and the admin root redirected to `/login`. **NOT VERIFIED**: that Amplify accepts the manifest, starts `index.js`, listens on port 3000, or that its runtime string is valid.

### `output: 'standalone'`

Required by this approach (the bundle is the standalone tree) and harmless otherwise: with the managed adapter it would be at best ignored (**NOT VERIFIED**; community reports mention an Amplify build error "standalone directory not found" when it is missing, for Next 13). Keep it. It also keeps option (c) for the CMS open.

### Node versions

- Build: `nvm install "$(cat .nvmrc)"` (24.21.0) in `amplify.yml`, then `corepack enable` so `pnpm@12.8.1` from the root `packageManager` field is used, then `pnpm install --frozen-lockfile` at the workspace root. **NOT VERIFIED**: that the Amplify build image ships nvm and corepack (nvm is widely used in Amplify builds; the images' Node 24 availability is not confirmed).
- Compute runtime: `deploy-manifest.json` uses `nodejs22.x` (`DEFAULT_RUNTIME` in `package-compute.mjs`; override with the build variable `AMPLIFY_COMPUTE_RUNTIME`). `nodejs22.x` appears in Amplify's official Express example; excerpts of the user guide mention Node 20, 22 and 24 as supported but I could not confirm that `nodejs24.x` is a valid manifest value, and an older Repost thread lists only 20.x and 22.x. **Gap with the repo:** `engines` says Node `>=24.21 <25`; the UAT runtime would be Node 22. The standalone server ran on Node 22 here, but that is not a supported combination of this repo. Try `AMPLIFY_COMPUTE_RUNTIME=nodejs24.x` on the first deploy and keep it if Amplify accepts it.

### `amplify.yml`

One file, an `applications:` list with `appRoot: apps/storefront` and `appRoot: apps/admin`. Amplify matches the entry to the app by `AMPLIFY_MONOREPO_APP_ROOT` (**VERIFIED as a search excerpt of the official monorepo page**: the variable must equal the app's path; the console sets it for monorepo apps, set it by hand otherwise). Artifacts: `baseDirectory: .amplify-hosting`, `files: '**/*'`. Cache: `.next/cache/**/*` only. **NOT VERIFIED**: whether commands start in the repo root or in `appRoot` (every command first walks up to `pnpm-workspace.yaml`, so it does not matter), whether `baseDirectory` is relative to `appRoot` (assumed), and whether `customHeaders` under an application entry is applied to static assets. The pnpm store is deliberately not cached until the first real build shows the path semantics. If the first build reports that the artifact directory does not exist, the fix is a one-line `baseDirectory` change.

### Environment variables at runtime

Amplify console variables are available to the **build**, not to the SSR compute (**VERIFIED as a search excerpt of the official "Making environment variables accessible to server-side runtimes" page**, whose own recipe is `env | grep ... >> .env.production`). This repo does not use that recipe, because it forwards everything matching a pattern. Instead `scripts/amplify/runtime-env.mjs` is an explicit allow-list of **names**:

- only listed names are copied, into `compute/default/runtime-env.json` (mode 0600) and nowhere else; `index.js` loads it before the Next server starts; the static directory and the client bundles never receive it;
- the build fails (naming variables, never values) when a required variable is missing, an URL is not https, the CMS store URL is not `rediss://`, or a secret-like `NEXT_PUBLIC_` variable exists;
- the build fails if any secret **value** appears in the static output or in `.next/static` (in addition to the CI step that greps the client bundles for variable **names**);
- `GOOGLE_ISSUER` (a test seam) cannot be forwarded; `NODE_ENV` is forced to `production`.

Consequences to know: secrets end up inside the compute artifact held by Amplify (private, not served), so rotating a secret needs a redeploy; the bundle is not encrypted with a customer key. A stricter alternative (the compute reading SSM at runtime with a compute role) is possible but needs code in both apps and was not done (**not implemented**).

### Secrets (Amplify "secrets" and SSM)

Secret values are entered in the Amplify console and kept in SSM Parameter Store under `/amplify/<appId>/<branch>/<NAME>` as encrypted parameters; the build reads them as variables of the same name (**ASSUMED from the change request; the exact console location of the Secrets feature for Hosting apps and the parameter naming are NOT VERIFIED**). The app's **service role** must be allowed to read them:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
      "Resource": "arn:aws:ssm:<region>:<account-id>:parameter/amplify/<appId>/uat/*"
    }
  ]
}
```

Add `kms:Decrypt` on the key if the parameters use a customer-managed key (the default `aws/ssm` key needs nothing extra). The service role also needs the CloudWatch Logs permissions Amplify builds use; whether the minimal policy above plus the standard Amplify service-role policy is enough is **NOT VERIFIED**. If the Secrets feature is not offered for the app, fall back to plain console variables marked as secrets by convention (weaker: visible to anyone with Amplify console access) and record the exception. Never put a secret value in `amplify.yml`, in the repository, in a GitHub secret/variable, or in a `NEXT_PUBLIC_` variable. This repository is public: the workflow logs print repository variables (role ARN, Amplify app ids, URLs), which are identifiers and not credentials.

### Headers, `proxy.ts`, caching, images

- **Security headers** (`nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, `COOP`): set by `next.config.ts` and applied by the Next server on compute responses (**VERIFIED locally**). Files served by Amplify's static layer (`/_next/static/*`) do not pass through Next, so they carry only Amplify's defaults plus the `Cache-Control` from `customHeaders` (**NOT VERIFIED**). They are JavaScript/CSS/fonts under hashed names; the CSP and framing headers that matter are on the HTML.
- **Nonce CSP and rate limit in `src/proxy.ts`**: run in the Next server (**VERIFIED locally** for the packaged bundles; the build output lists `Proxy (Middleware)`). The `proxy.ts` file name is a Next 16 feature; Amplify's managed adapter support for it is **NOT VERIFIED** and is the reason for the packaging above.
- **HSTS** is not set by the apps (they leave it to the TLS edge). Amplify's CloudFront edge terminates TLS; whether it adds `Strict-Transport-Security` by default is **NOT VERIFIED**. If it does not, add it in the Amplify console custom headers for the UAT apps.
- **Cache behaviour**: all pages are dynamic (`ƒ` in the build output) with `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` (**VERIFIED locally**) because each response embeds a fresh nonce. A CDN cache in front must not store HTML; the smoke check (`scripts/amplify/smoke.mjs`) fails if the nonce repeats across two requests. Whether Amplify's CDN honours the origin `Cache-Control` is **NOT VERIFIED**; the smoke check is the test.
- **Images** are `images: { unoptimized: true }` by design (plain `<img>` from the media CDN, no `/_next/image`), so no `imageSettings` is written in the manifest and Amplify's image optimiser is not used.
- **Redirects**: none are defined in Amplify; the apps redirect in code (the admin `proxy.ts` redirects to `/login` with an absolute URL from `CMS_BASE_URL`).
- **Payload limits** (**NOT VERIFIED**, Lambda-style compute is typical): request and response bodies of a few MB. The admin streams `errors.csv` exports that can be tens of MB (`docs/ENGINEERING_STATUS.md`, C1), and the import wizard sends requests of up to ~1 MB; very large CSV downloads may fail on Amplify compute. Test an export with many rows in UAT.

## 2. Environment variable contract (names only)

Source of truth: `apps/*/src/server/env.ts`, `src/proxy.ts`, `src/lib/security/rate-limit.ts`, mirrored in `scripts/amplify/runtime-env.mjs` (a unit test fails if the apps read a name the contract lacks). Values for UAT given in the change request are shown; everything else is chosen per environment.

### Storefront (Amplify app `tazzzo-uat-storefront`, `AMPLIFY_MONOREPO_APP_ROOT=apps/storefront`)

| Name                                                                                                      | Secret  | Required                                                                                                        | Notes                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `TAZZZO_API_BASE_URL`                                                                                     | no      | yes                                                                                                             | `https://api-uat.tazzzo.com` (https enforced in production)                                            |
| `TAZZZO_SITE_URL`                                                                                         | no      | yes                                                                                                             | **not in the change request**, required by `env.ts`: the origin of this site, `https://uat.tazzzo.com` |
| `TAZZZO_MEDIA_BASE_URL`                                                                                   | no      | no (images placeholders if unset)                                                                               | `https://media-uat.tazzzo.com`                                                                         |
| `TAZZZO_CALLER_NAME`                                                                                      | no      | no, with the secret                                                                                             | `[a-z][a-z_]{0,19}`, not `unknown`; set both or neither                                                |
| `TAZZZO_CALLER_SECRET`                                                                                    | **yes** | no, with the name                                                                                               | 32-256 visible ASCII chars; must match the backend's trusted-caller config                             |
| `STOREFRONT_SESSION_SECRET`                                                                               | **yes** | **yes** in production                                                                                           | base64/base64url of at least 32 random bytes                                                           |
| `STOREFRONT_SESSION_SECRET_PREVIOUS`                                                                      | **yes** | no                                                                                                              | rotation only                                                                                          |
| `STOREFRONT_TRUST_PROXY`                                                                                  | no      | **`true`** in production when a session secret or caller credential is set (the app refuses to start otherwise) | see the proxy-hops note in section 8                                                                   |
| `STOREFRONT_TRUSTED_PROXY_HOPS`                                                                           | no      | no (default 1)                                                                                                  | how many proxies append to `X-Forwarded-For`                                                           |
| `STOREFRONT_ORDER_CANCEL_WINDOW_SECONDS`                                                                  | no      | no (default 0)                                                                                                  | mirror of the backend setting                                                                          |
| `STOREFRONT_RATE_LIMIT_PER_MINUTE`, `_BURST`, `_EXPENSIVE_PER_MINUTE`, `_EXPENSIVE_BURST`, `_MAX_CLIENTS` | no      | no                                                                                                              | per instance (section 8)                                                                               |

### Admin / CMS (Amplify app `tazzzo-uat-admin`, `AMPLIFY_MONOREPO_APP_ROOT=apps/admin`) - blocked on the open decision in section 0

| Name                                                  | Secret  | Required | Notes                                                                                               |
| ----------------------------------------------------- | ------- | -------- | --------------------------------------------------------------------------------------------------- |
| `CMS_BASE_URL`                                        | no      | yes      | `https://cms-uat.tazzzo.com` (origin only, https in production)                                     |
| `GOOGLE_CLIENT_ID`                                    | no      | yes      | must equal the backend's `tazzzo.admin.oidc.audience` for UAT                                       |
| `GOOGLE_CLIENT_SECRET`                                | **yes** | yes      |                                                                                                     |
| `GOOGLE_HOSTED_DOMAIN`                                | no      | yes      | Google Workspace domain allowed to sign in                                                          |
| `TAZZZO_BACKEND_URL`                                  | no      | yes      | ASSUMED `https://api-uat.tazzzo.com`; confirm that the admin API is served from the same UAT origin |
| `SESSION_STORE_URL`                                   | **yes** | yes      | `rediss://` only (the password is inside the URL, hence secret). Value depends on the open decision |
| `SESSION_ENCRYPTION_KEY`                              | **yes** | yes      | 32 random bytes, base64/base64url                                                                   |
| `SESSION_ENCRYPTION_PREVIOUS_KEY`                     | **yes** | no       | rotation only                                                                                       |
| `CMS_SESSION_MAX_SECONDS`, `CMS_SESSION_IDLE_SECONDS` | no      | no       | defaults 28800 / 1800                                                                               |
| `CMS_MEDIA_UPLOAD_ORIGIN`                             | no      | no       | exact https origin of the UAT upload bucket; unset disables direct upload                           |
| `CMS_MEDIA_PUBLIC_ORIGIN`                             | no      | no       | e.g. `https://media-uat.tazzzo.com`                                                                 |
| `NEXT_PUBLIC_IMPORT_UPLOAD_{POLL,SETTLE,MAXWAIT}_MS`  | no      | no       | build-time, inlined into the browser bundle by design (non-secret tuning); not forwarded at runtime |

Google OAuth: add `https://cms-uat.tazzzo.com/api/auth/google/callback` (check the exact path in `apps/admin/src/app/api/auth/google/callback`) as an authorised redirect URI of the UAT OAuth client.

## 3. Console steps (done by a human with AWS access; NOT RUN)

Prerequisite approvals (the infrastructure rules say no recurring-cost resource without approval; Month-1 target is $0): Amplify Hosting bills for build minutes, hosted storage, data transfer and SSR requests beyond any free tier, and custom domains may need a Route 53 hosted zone. **Pricing and free-tier terms were not verified.** Get explicit approval before step 1.

1. **Create each app manually from GitHub with the Amplify GitHub App** (no personal access token is stored anywhere): Amplify console > Create new app > GitHub > authorise the _AWS Amplify GitHub App_ for `Sahilranjan00017/tazzzo-web` only > repository `tazzzo-web` > branch `uat`.
2. **Monorepo**: tick "My app is a monorepo" and set the app root to `apps/storefront` (second app: `apps/admin`). Confirm that the app has the variable `AMPLIFY_MONOREPO_APP_ROOT` with that value.
3. **Platform**: the app must be a _Web compute_ (`WEB_COMPUTE`) app. Check afterwards: `aws amplify get-app --app-id <id> --query app.platform` returns `WEB_COMPUTE`. Name them e.g. `tazzzo-uat-storefront`, `tazzzo-uat-admin`.
4. **Build settings**: use the `amplify.yml` from the repository. Do not paste or save an override in the console (a console override wins over the file; **NOT VERIFIED**, so check the build log shows the repository's commands).
5. **Service role**: create an IAM role for Amplify (trusted service `amplify.amazonaws.com`) with the SSM statement in section 1, attach it to the app (App settings > General > Service role).
6. **Environment variables and secrets** (App settings > Environment variables, branch `uat`): non-secret names as plain variables; secret names through the Secrets feature (SSM `/amplify/<appId>/uat/<NAME>`). Names and which are secret: section 2. Also set `AMPLIFY_COMPUTE_RUNTIME` only if you override the default.
7. **Branch**: connect branch `uat` only; **turn off automatic builds for `uat`** (App settings > Branch settings, or `aws amplify update-branch --app-id <id> --branch-name uat --no-enable-auto-build`), and leave pull-request previews and branch auto-detection off. With auto-build on, a push to `uat` would deploy before CI passes. The GitHub Actions workflow is then the only thing that starts a build (`start-job`).
8. **Custom domains** (App settings > Domain management > Add domain): `tazzzo.com`, subdomain `uat` -> branch `uat` for the storefront app; `tazzzo.com`, subdomain `cms-uat` -> branch `uat` for the admin app. Amplify then displays the DNS records to create: a **certificate-validation CNAME** and a **CNAME for the subdomain pointing at its CloudFront distribution**. Create **exactly the records the console shows**; their values cannot be known from the repository. If the zone is outside Route 53, create them at the DNS provider. Wait for status _Available_. HTTPS only.
9. **GitHub**: create the environment `uat` (Settings > Environments; add required reviewers if a human gate before deploying is wanted) and the variables listed at the top of `.github/workflows/deploy-uat-web.yml`. The IAM role `AWS_UAT_WEB_DEPLOY_ROLE_ARN` belongs in the infrastructure repository (Terraform): trust the GitHub OIDC provider (`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`) with `sub` equal to `repo:Sahilranjan00017/tazzzo-web:environment:uat`, and allow only `amplify:StartJob` and `amplify:GetJob` on `arn:aws:amplify:<region>:<account-id>:apps/<appId>/branches/uat/jobs/*`. No AWS key goes into GitHub.
10. **Create the `uat` branch** from the commit to deploy (`git push origin <sha>:refs/heads/uat`); branch protection on `uat` should require the CI checks. The first push triggers the workflow.

### First-deploy checklist (everything here is NOT RUN)

- Build log: Node 24.21.0, pnpm 12.8.1, `pnpm install --frozen-lockfile` succeeded, "packaged ... (names only)" lines show the expected variable names, artifacts found under `.amplify-hosting`.
- Amplify accepts `deploy-manifest.json` (a validation error names the field; adjust `scripts/amplify/package-compute.mjs`) and starts `index.js` (no 502).
- `curl -I https://uat.tazzzo.com/`: the headers listed in section 1; `curl` twice and compare the nonce in `Content-Security-Policy`.
- Storefront: home, a product page and search show catalogue data; the images load from `media-uat.tazzzo.com`; a repeat load produces no backend call burst.
- Admin: Google sign-in round trip and a write that audits against the UAT backend (only after the open decision).
- `StartJob` with `--commit-id`: confirm that `get-job` reports the commit that CI passed on (the workflow fails when it does not).

## 4. Deploy workflow

`.github/workflows/deploy-uat-web.yml` runs on push to `uat` and on manual dispatch (from `uat` only):

1. `ci` job: calls `.github/workflows/ci.yml` (made callable with `workflow_call`): format, lint, typecheck, unit tests (now including `pnpm test:deploy-scripts`), integration tests, both Playwright suites, production build with the standalone and client-bundle checks, dependency audit. Nothing else starts until it passes.
2. `deploy` job (matrix: storefront, admin; `environment: uat`; `id-token: write`): exchanges the GitHub OIDC token for the role in `vars.AWS_UAT_WEB_DEPLOY_ROLE_ARN` with the AWS CLI's web-identity support (no third-party action, so no unpinned dependency; the token is masked and kept in a 0600 file), then `aws amplify start-job --job-type RELEASE --commit-id <github.sha>` for the app in `vars.AMPLIFY_UAT_*_APP_ID`, branch `uat`, polls `get-job` until `SUCCEED` (fail on `FAILED`/`CANCELLED`, 45 min limit), checks that Amplify built the same commit, smoke-checks the URL in `vars.UAT_*_URL`, and writes the deployed SHA to the step summary.

**NOT VERIFIED:** the `--job-type RELEASE` + `--commit-id` combination. The Amplify API describes `RELEASE` as a job for the latest change on the branch; whether `commitId` selects an older commit is not confirmed. For that reason the workflow compares the job's `commitId` with the gated SHA and fails otherwise.

The OIDC exchange via `ACTIONS_ID_TOKEN_REQUEST_URL` and `AWS_ROLE_ARN`/`AWS_WEB_IDENTITY_TOKEN_FILE` is the documented web-identity mechanism of the AWS CLI/SDKs (standard behaviour, not exercised here). The token is read when credentials are first requested; a job running past the STS session lifetime (1 hour default) would fail to refresh, which the 45 min limit avoids.

## 5. Rollback

- Preferred (**NOT VERIFIED**, console feature): Amplify console > the app > branch `uat` > the previous successful build > **Redeploy this version**.
- CLI (**NOT VERIFIED**): `aws amplify start-job --app-id <id> --branch-name uat --job-type RETRY --job-id <previous-successful-job-id>`.
- Git: `git revert` the bad commit on `uat` and push; the workflow deploys the revert after CI. Do not force-push `uat`.
- Do not rely on `start-job --job-type RELEASE --commit-id <older-sha>`: it may build the branch head instead (see above).
- The deployed SHA of each deploy is in the run summary of the workflow.

## 6. What a deploy does not cover

Backend deploys, DNS for `api-uat`/`media-uat`, CORS/CSRF settings on the UAT backend for these origins, and the IAM/OIDC resources are other repositories' work.

## 7. Verified versus not verified (summary)

| Item                                                                                                 | State                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Standalone build of both apps, packaging, runtime-env loading, CSP nonce, headers, `/login` redirect | VERIFIED locally (Node 22.22, Next 16.3.8, `pnpm --filter ... build`, `node index.js`)   |
| Env contract equals `env.ts` names; secrets never in static output; https/rediss checks              | VERIFIED by `pnpm test:deploy-scripts` (15 tests)                                        |
| Amplify managed Next.js support range 12-15                                                          | search excerpt of the official page; page not fetched (docs host unreachable here)       |
| Deployment-specification fields (`version`, `routes`, `framework`, `computeResources`)               | search excerpts of the official page and third-party examples; exact schema NOT VERIFIED |
| Port 3000, runtime string, `index.js` entrypoint accepted                                            | NOT VERIFIED                                                                             |
| `amplify.yml` working directory, `baseDirectory`, cache and `customHeaders` semantics                | NOT VERIFIED                                                                             |
| Amplify Secrets / SSM path and service-role sufficiency                                              | ASSUMED from the change request; NOT VERIFIED                                            |
| Managed adapter support for `proxy.ts`                                                               | NOT VERIFIED (avoided by design)                                                         |
| `start-job` RELEASE + commit id, rollback commands                                                   | NOT VERIFIED                                                                             |
| Anything that needs AWS: app creation, domains, build, deploy, smoke check against UAT URLs          | NOT RUN                                                                                  |

## 8. Runtime behaviour on a stateless, multi-instance SSR runtime

**Redis for the storefront:** none. `apps/storefront` has no Redis client; customer sessions are sealed cookies (AES-256-GCM with `STOREFRONT_SESSION_SECRET`), so any instance can open them (**VERIFIED in source**: no `ioredis` in `apps/storefront/package.json`). Instances must share the same secret, which the build-time forwarding guarantees.

**In-process state, honestly:**

- The **backend read memory** (`src/server/backend/client.ts`: 60 s bodies, 404 memory, stale-on-error, 429 back-off, in-flight de-duplication) lives on `globalThis` of **one server process**. On a runtime that starts many short-lived instances (Lambda-style, **NOT VERIFIED for Amplify compute**) each instance warms its own memory: the cache hit rate drops, backend calls grow roughly with the number of live instances, and a cold start always misses. A take-down is still visible within about a minute (each instance keeps the same 60 s rule), and nothing breaks functionally.
- The backend admission gate keys on the caller's IP. Compute instances have changing egress addresses (**NOT VERIFIED**), so the shared per-IP bucket is not predictable. Setting `TAZZZO_CALLER_NAME`/`TAZZZO_CALLER_SECRET` (the backend's trusted-caller bucket) is therefore strongly recommended for UAT; it also needs the backend to be configured with the same pair.
- The **per-visitor rate limiter** (`src/lib/security/rate-limit.ts`) is per instance, as `.env.example` already says: N instances admit up to N times the configured rate per visitor, and a new instance starts with full buckets. It is a courtesy limit here, not a hard guarantee; do not use UAT results as evidence of production rate-limit behaviour.
- `STOREFRONT_TRUST_PROXY=true` is mandatory in production mode (fail-closed in `env.ts`). The limiter reads `X-Forwarded-For` from the right by `STOREFRONT_TRUSTED_PROXY_HOPS` entries (default 1, written for an ALB). How many entries Amplify's CDN/compute append, and whether a client-supplied `X-Forwarded-For` is overwritten or appended to, is **NOT VERIFIED**; the default of 1 is an assumption. If Amplify appends no entry, requests fall into the shared `unresolved` bucket (fail closed: strict, one bucket for everybody); if it appends two, one proxy address becomes the key. Check with the first UAT traffic and set `STOREFRONT_TRUSTED_PROXY_HOPS` accordingly.

**Admin:** sessions and login transactions are in the shared store (stateless instances are fine once the open decision is settled). Its Redis client is created lazily per process with 2 s timeouts; every cold instance pays a TLS handshake to the store.
