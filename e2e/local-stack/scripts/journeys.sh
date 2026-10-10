#!/usr/bin/env bash
# Run every journey (tests/*.spec.ts) against the running stack (up.sh + seed.sh + web.sh start).
# Adds no dependency: node_modules is a git-ignored symlink to the repo's installed packages (@playwright/test + Chromium).
# Evidence -> evidence/<date>/ (transcript.txt, results.json, screens/). Exit code: 0 only if every journey PASSED.
#   scripts/journeys.sh                      all journeys
#   scripts/journeys.sh -g 'J1[0-9]'         a subset (Playwright --grep)
source "$(dirname "$0")/common.sh"
ensure_env
disk_guard
mkdir -p "$EVIDENCE_DIR"
export PATH="/tmp/claude-0/bin:$PATH"
[[ -d "$WEB_DIR/node_modules/.bin" ]] || { echo "dependencies missing: run 'pnpm install --frozen-lockfile' at the repo root" >&2; exit 1; }
# a root node_modules of the workspace holds only dev tooling; Playwright is the storefront's pinned devDependency
PW="$STORE_APP/node_modules/.bin/playwright"
[[ -x "$PW" ]] || { echo "@playwright/test not installed for apps/storefront" >&2; exit 1; }
rm -rf "$HARNESS_DIR/node_modules"; ln -s "$STORE_APP/node_modules" "$HARNESS_DIR/node_modules"
export E2E_HARNESS_DIR="$HARNESS_DIR" E2E_EVIDENCE_DIR="$EVIDENCE_DIR" E2E_RUN_DIR="$RUN_DIR"
export E2E_BACKEND_PIN=1   # a mid-run backend restart (J08) must run the SAME build, never a newer origin/main
export E2E_API_PROXY_PORT="${E2E_API_PROXY_PORT:-8081}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
rm -rf "$RUN_DIR/sms" ; mkdir -p "$RUN_DIR/sms"
cd "$HARNESS_DIR"
START=$(date +%s)
set +e
"$PW" test -c playwright.config.ts "$@" 2>&1 | tee "$EVIDENCE_DIR/playwright-output.txt"
set -e
node "$HARNESS_DIR/lib/redact-evidence.mjs" --check "$EVIDENCE_DIR" || echo "REDACTION CHECK FAILED"
node "$HARNESS_DIR/lib/summary.mjs" "$EVIDENCE_DIR/results.json" "$(( $(date +%s) - START ))" | tee "$EVIDENCE_DIR/summary.txt"
exit "${PIPESTATUS[0]}"
