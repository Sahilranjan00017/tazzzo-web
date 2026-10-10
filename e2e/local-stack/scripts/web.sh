#!/usr/bin/env bash
# Storefront (apps/storefront of this repo) against the local backend (through the counting proxy) and the CDN stand-in.
#   web.sh start      `next build` (once; E2E_WEB_REBUILD=1 forces) + `next start`, NODE_ENV=production
#   web.sh stop
# Production-mode settings (apps/storefront/src/server/env.ts): STOREFRONT_SESSION_SECRET (random, run/stack.env),
# STOREFRONT_TRUST_PROXY=true (visitor = rightmost X-Forwarded-For, as behind the ALB), the trusted-caller credential the
# backend was started with, and a per-visitor rate limit loosened ONLY so ~30 browser journeys from one address do not trip
# it (the journeys use a distinct X-Forwarded-For per visitor for the limiter controls, as the repo's own prod E2E does).
source "$(dirname "$0")/common.sh"
ensure_env
NEXT="$STORE_APP/node_modules/.bin/next"   # call next directly (the pnpm shim is not needed to run a built app)
[[ -x "$NEXT" ]] || { echo "storefront dependencies missing: run 'pnpm install --frozen-lockfile' at the repo root" >&2; exit 1; }
case "${1:-start}" in
  start)
    disk_guard
    export E2E_API_PROXY_PORT="${E2E_API_PROXY_PORT:-8081}"
    start_bg apiproxy node "$HARNESS_DIR/lib/api-proxy.mjs"
    wait_http "http://127.0.0.1:$E2E_API_PROXY_PORT/__harness/log" 15 --fail
    web_env=(NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
      TAZZZO_API_BASE_URL="http://127.0.0.1:$E2E_API_PROXY_PORT" TAZZZO_MEDIA_BASE_URL="$E2E_CDN"
      TAZZZO_SITE_URL=https://www.tazzzo.test
      TAZZZO_CALLER_NAME="$E2E_CALLER_NAME" TAZZZO_CALLER_SECRET="$E2E_CALLER_SECRET"
      STOREFRONT_SESSION_SECRET="$E2E_SESSION_SECRET" STOREFRONT_TRUST_PROXY=true
      STOREFRONT_RATE_LIMIT_PER_MINUTE=6000 STOREFRONT_RATE_LIMIT_BURST=2000
      STOREFRONT_RATE_LIMIT_EXPENSIVE_PER_MINUTE=1200 STOREFRONT_RATE_LIMIT_EXPENSIVE_BURST=400)
    if [[ ! -f "$STORE_APP/.next/BUILD_ID" || "${E2E_WEB_REBUILD:-0}" == 1 ]]; then
      echo "building storefront (production)"
      (cd "$STORE_APP" && env "${web_env[@]}" "$NEXT" build) > "$RUN_DIR/logs/web-build.log" 2>&1 \
        || { tail -40 "$RUN_DIR/logs/web-build.log"; exit 1; }
    fi
    start_bg web env -C "$STORE_APP" "${web_env[@]}" "$NEXT" start -p "$STORE_PORT" -H 127.0.0.1
    wait_http "$E2E_STORE/robots.txt" 120 --fail
    echo "storefront (production) up at $E2E_STORE"
    ;;
  stop) stop_bg web; stop_bg apiproxy ;;
  *) echo "usage: web.sh start | stop" >&2; exit 2 ;;
esac
