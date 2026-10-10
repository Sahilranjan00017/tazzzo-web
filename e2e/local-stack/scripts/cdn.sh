#!/usr/bin/env bash
# CDN stand-in control: start | stop | status. `stop` is the TEST 14 outage switch.
source "$(dirname "$0")/common.sh"
ensure_env
case "${1:-status}" in
  start)  start_bg cdn node "$HARNESS_DIR/lib/cdn-proxy.mjs"; wait_http "$E2E_CDN/" 15 -k ;;
  stop)   stop_bg cdn ;;
  status) if curl -sk -o /dev/null --max-time 2 "$E2E_CDN/"; then echo "cdn UP ($E2E_CDN)"; else echo "cdn DOWN ($E2E_CDN)"; fi ;;
  *) echo "usage: cdn.sh start|stop|status" >&2; exit 2 ;;
esac
