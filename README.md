# tazzzo-web

Tazzzo web surfaces: the **internal Admin/CMS** (`apps/admin`) and the **customer website** (`apps/storefront`, see
[its README](apps/storefront/README.md)).

## Current state

`apps/admin` is a Next.js App Router application: the Tazzzo CMS and its same-origin BFF.

- **W1 (complete):** pnpm workspace, strict TypeScript, ESLint, Prettier, Vitest, CI, server-only boundary, validated
  server environment, security headers and a per-request nonce-based CSP (`src/proxy.ts`), standalone output.
- **W2 (in review):** Google sign-in (authorization code + state + OIDC nonce + PKCE S256 via `openid-client`), a
  server-side session in Valkey/Redis (opaque `__Host-` HttpOnly cookie; the ID token encrypted at rest; no access or
  refresh tokens kept), CSRF-checked logout, and the backend `GET /api/v1/admin/me` bootstrap with the human's ID token.

- **W3 (in review):** a narrow BFF mutation layer (explicit routes only, no generic proxy; CSRF, JSON-only, 16 KiB
  bodies, strict schemas, the human's ID token as the only backend credential, no redirects, 5 s timeout, no retries)
  with one reference route, `PATCH /api/bff/catalog/products/{id}/title`, and Playwright E2E.

**Not implemented yet:** CMS business modules, audit read, scheduler, deployment. The backend stays the
authorization boundary for every request; UI role gating is UX only.

### Sign-in flow

1. `GET /api/auth/google/start` stores `{state, oidcNonce, codeVerifier, returnTo}` in Valkey (600 s, single use) and
   redirects to Google with only an opaque transaction cookie.
2. `GET /api/auth/google/callback` consumes the transaction, lets `openid-client` validate state, PKCE, nonce and the ID
   token, then creates a fresh session (expiry = min(ID token exp - 60 s, `CMS_SESSION_MAX_SECONDS`), idle timeout
   `CMS_SESSION_IDLE_SECONDS`) and redirects.
3. Protected pages call `requireAdmin()`: session validated server-side, then `/me` with `Authorization: Bearer <ID
token>`. Backend 401 ends the session; 403 shows access denied (session kept). There is no service-token fallback.
4. `POST /api/auth/logout` (same Origin + `X-Tazzzo-CSRF: 1`) deletes the session and expires the cookie.

### Configuration

See [`apps/admin/.env.example`](apps/admin/.env.example). **`GOOGLE_CLIENT_ID` must equal the backend's
`tazzzo.admin.oidc.audience`.** All OAuth URLs derive from `CMS_BASE_URL`, never the request Host. Production requires
an https `CMS_BASE_URL`, Google as the only issuer and a TLS (`rediss://`) session store. Plain-http local development
uses separate `*_dev` cookie names without `Secure`; production cookie settings are never relaxed.

## Toolchain

| Tool    | Version                                             |
| ------- | --------------------------------------------------- |
| Node.js | `24.21.0` (LTS; `.nvmrc`, `engines`, CI)            |
| pnpm    | `12.8.1` (`packageManager`; enable with `corepack`) |
| Next.js | `16.3.8` (App Router, `proxy.ts`)                   |
| React   | `19.3.0`                                            |

TypeScript is pinned to `6.0.3`: `typescript-eslint` (used by `eslint-config-next`) supports TypeScript `< 6.1`.

## Commands (from the repository root)

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev          # http://localhost:3000
pnpm lint         # ESLint
pnpm format:check # Prettier
pnpm typecheck    # route type generation + tsc
pnpm test         # Vitest unit tests
pnpm test:integration # Valkey (Testcontainers, needs Docker) + mock OIDC + fake backend + real Next runtime
pnpm test:e2e     # Playwright (Chromium) end to end; first run: pnpm --filter admin exec playwright install chromium
pnpm build        # production build (standalone output)
pnpm dev:storefront     # customer website
pnpm test:e2e:storefront # storefront Playwright E2E (fake public API + fake media host)
```

`pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` run for every app.

## Layout

```
apps/admin/
  src/app/            routes: (auth)/login, (app) shell, root layout
  src/proxy.ts        per-request CSP nonce (no authentication)
  src/lib/security/   header and CSP policy (pure, client-safe)
  src/server/         server-only modules: env, auth (OIDC, transaction, cookies, CSRF), session, store, backend, bff
  tests/unit/         Vitest unit suites, including repository policy checks
  tests/integration/  Valkey + mock OIDC provider + fake backend; real-runtime flow
  tests/e2e/          Playwright browser tests against the real runtime
```

## Security notes

- No identity, token or role is ever stored in `localStorage`, `sessionStorage` or script-visible cookies (lint and
  tests enforce this).
- Secret-like values must never use the `NEXT_PUBLIC_` prefix (validated at runtime and by tests).
- HSTS is owned by the TLS-terminating edge (ALB) in production, not the app.
