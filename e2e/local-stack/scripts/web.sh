#!/usr/bin/env bash
# Storefront (tazzzo-web PR #20, apps/storefront) against the local backend and the CDN stand-in.
#   web.sh start [prod|dev]   default prod: `next build` (once; E2E_WEB_REBUILD=1 forces) + `next start`
#   web.sh stop
# Production mode accepts the plain-http API because it is a loopback host (apps/storefront/src/server/env.ts);
# TAZZZO_SITE_URL must be https in production and is only used for canonical/Open Graph URLs, so a .test host is used.
source "$(dirname "$0")/common.sh"
ensure_env
APP="$STORE_DIR/apps/storefront"
NEXT="$APP/node_modules/.bin/next"   # pnpm on this machine cannot switch to the pinned pnpm@12.8.1; call next directly

case "${1:-start}" in
  start)
    disk_guard
    mode="${2:-prod}"
    common_env=(TAZZZO_API_BASE_URL="$E2E_BACKEND" TAZZZO_MEDIA_BASE_URL="$E2E_CDN" NEXT_TELEMETRY_DISABLED=1)
    if [[ "$mode" == prod ]]; then
      if [[ ! -f "$APP/.next/BUILD_ID" || "${E2E_WEB_REBUILD:-0}" == 1 ]]; then
        echo "building storefront (production)"
        (cd "$APP" && env NODE_ENV=production "${common_env[@]}" TAZZZO_SITE_URL=https://www.tazzzo.test "$NEXT" build) \
          > "$RUN_DIR/logs/web-build.log" 2>&1 || { tail -30 "$RUN_DIR/logs/web-build.log"; exit 1; }
      fi
      start_bg web env -C "$APP" NODE_ENV=production "${common_env[@]}" TAZZZO_SITE_URL=https://www.tazzzo.test \
        "$NEXT" start -p "$STORE_PORT" -H 127.0.0.1
    else
      start_bg web env -C "$APP" NODE_ENV=development "${common_env[@]}" TAZZZO_SITE_URL="$E2E_STORE" \
        "$NEXT" dev -p "$STORE_PORT" -H 127.0.0.1
    fi
    echo "$mode" > "$RUN_DIR/web.mode"
    wait_http "$E2E_STORE/" 120
    echo "storefront ($mode) up at $E2E_STORE"
    ;;
  stop) stop_bg web ;;
  *) echo "usage: web.sh start [prod|dev] | stop" >&2; exit 2 ;;
esac
