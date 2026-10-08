#!/usr/bin/env bash
# Run the journey spec (tests/media-content.spec.ts) against the running stack (up.sh + seed.sh + web.sh).
# Adds no dependency: node_modules is a git-ignored symlink to the storefront worktree's installed packages
# (@playwright/test 1.63.0 and its cached Chromium).
source "$(dirname "$0")/common.sh"
ensure_env
disk_guard
ln -sfn "$STORE_DIR/apps/storefront/node_modules" "$HARNESS_DIR/node_modules"
export E2E_HARNESS_DIR="$HARNESS_DIR" E2E_EVIDENCE_DIR="$EVIDENCE_DIR"
cd "$HARNESS_DIR"
set +e
./node_modules/.bin/playwright test -c playwright.config.ts "$@" 2>&1 | tee "$EVIDENCE_DIR/playwright-output.txt"
rc=${PIPESTATUS[0]}
set -e
echo "evidence: $EVIDENCE_DIR (transcript.txt, screens/, app-*.txt, playwright-output.txt)"
exit $rc
