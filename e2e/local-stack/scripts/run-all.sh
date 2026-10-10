#!/usr/bin/env bash
# One fresh cycle: down -> up -> seed -> web -> journeys, timing each step. Evidence -> evidence/<date>/<label>/ (default label: run).
#   scripts/run-all.sh [label]
source "$(dirname "$0")/common.sh"
LABEL_RUN="${1:-run}"
export E2E_EVIDENCE_DIR="$HARNESS_DIR/evidence/$(date +%F)/$LABEL_RUN"
mkdir -p "$E2E_EVIDENCE_DIR"
S="$(dirname "$0")"
t() { local n=$1; shift; local s=$(date +%s); "$@"; echo "step $n: $(( $(date +%s) - s )) s" | tee -a "$E2E_EVIDENCE_DIR/cycle.txt"; }
: > "$E2E_EVIDENCE_DIR/cycle.txt"
t down "$S/down.sh"; t up "$S/up.sh"; t seed "$S/seed.sh"; t web "$S/web.sh" start
"$S/versions.sh" > "$E2E_EVIDENCE_DIR/versions.txt" 2>&1 || true
s=$(date +%s); rc=0; "$S/journeys.sh" || rc=$?; echo "step journeys: $(( $(date +%s) - s )) s (exit $rc)" | tee -a "$E2E_EVIDENCE_DIR/cycle.txt"
exit $rc
