#!/usr/bin/env bash
# Stop every process and container this harness started. Leaves nothing running; touches nothing else
# (containers are matched by the harness label only; processes by the pid files under run/pids).
source "$(dirname "$0")/common.sh"
for p in "$RUN_DIR"/pids/*.pid; do [[ -e "$p" ]] && stop_bg "$(basename "$p" .pid)"; done
ids=$(docker ps -aq --filter "label=$LABEL")
if [[ -n "$ids" ]]; then docker rm -f $ids >/dev/null && echo "removed containers: $(echo $ids | wc -w | tr -d ' ')"; fi
echo "remaining harness containers: $(docker ps -aq --filter "label=$LABEL" | wc -l | tr -d ' ')"
rm -rf "$RUN_DIR/sms" "$RUN_DIR/counts" 2>/dev/null || true
