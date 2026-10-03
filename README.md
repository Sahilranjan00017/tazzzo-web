# tazzzo-web

Tazzzo web surfaces. Today this repository contains only the **internal Admin/CMS foundation** (`apps/admin`). The
customer-facing web app will be added later as `apps/web`.

## Current state (W1: foundation)

`apps/admin` is a Next.js App Router application that will become the Tazzzo CMS and its same-origin BFF. W1 provides
the production-oriented foundation only:

- pnpm workspace, strict TypeScript, ESLint, Prettier, Vitest, GitHub Actions CI
- server-only boundary (`src/server/**` uses `server-only`; client-safe code may not import it)
- validated server environment (`src/server/env.ts`)
- security headers and a per-request, nonce-based Content Security Policy (`src/proxy.ts`)
- placeholder sign-in page and app shell
- standalone production output (container-ready for the planned AWS ECS/Fargate host)

**Not implemented yet** (W2/W3): Google sign-in (OAuth/OIDC), CMS sessions and cookies, backend integration (including
`GET /api/v1/admin/me`), the BFF API, and every CMS business module. The sign-in button is intentionally disabled; nothing
in W1 can produce an authenticated state.

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
pnpm build        # production build (standalone output)
```

## Layout

```
apps/admin/
  src/app/            routes: (auth)/login, (app) shell, root layout
  src/proxy.ts        per-request CSP nonce (no authentication)
  src/lib/security/   header and CSP policy (pure, client-safe)
  src/server/         server-only modules (environment)
  tests/unit/         Vitest suites, including repository policy checks
```

## Security notes

- No identity, token or role is ever stored in `localStorage`, `sessionStorage` or script-visible cookies (lint and
  tests enforce this).
- Secret-like values must never use the `NEXT_PUBLIC_` prefix (validated at runtime and by tests).
- HSTS is owned by the TLS-terminating edge (ALB) in production, not the app.
