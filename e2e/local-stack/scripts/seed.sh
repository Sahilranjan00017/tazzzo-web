#!/usr/bin/env bash
# Seed the running backend through its admin API (release R1, service areas, delivery windows, 4 products with price + stock).
# Idempotent. No direct database writes. Run after scripts/up.sh.
source "$(dirname "$0")/common.sh"
ensure_env
node "$HARNESS_DIR/lib/seed.mjs"
