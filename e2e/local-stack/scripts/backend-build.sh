#!/usr/bin/env bash
# Build the backend jar from a CLEAN worktree of tazzzo-backend origin/main (Java 21). Idempotent: a worktree that already
# exists is fast-forwarded to origin/main (detached), and the jar is rebuilt only when the commit changed since the last build.
#   E2E_BACKEND_REPO  the tazzzo-backend clone (default ../tazzzo-backend)
#   E2E_BACKEND_DIR   where the clean worktree lives (default ../tazzzo-backend-e2e-main)
# The backend repo is only read (git fetch + git worktree); nothing in it is modified.
source "$(dirname "$0")/common.sh"
[[ -x "$JAVA_HOME/bin/java" ]] || { echo "Java 21 not found at JAVA_HOME=$JAVA_HOME (set JAVA_HOME_21)" >&2; exit 1; }
if [[ "${E2E_BACKEND_PIN:-0}" != 1 ]]; then   # journeys.sh pins the build it started with (a crash-restart must not pick up a newer main)
  git -C "$BACKEND_REPO" fetch -q origin
fi
if [[ "${E2E_BACKEND_PIN:-0}" == 1 ]]; then :
elif [[ ! -d "$BACKEND_DIR/.git" && ! -f "$BACKEND_DIR/.git" ]]; then
  git -C "$BACKEND_REPO" worktree add --detach "$BACKEND_DIR" origin/main
else
  git -C "$BACKEND_DIR" checkout -q --detach origin/main
fi
SHA=$(git -C "$BACKEND_DIR" rev-parse HEAD)
MARK="$RUN_DIR/backend-built.sha"
JAR=$(ls "$BACKEND_DIR"/services/catalog-service/target/catalog-service-*.jar 2>/dev/null | head -1 || true)
if [[ -z "$JAR" || "$(cat "$MARK" 2>/dev/null || true)" != "$SHA" ]]; then
  echo "building backend $SHA (skip tests)"
  (cd "$BACKEND_DIR/services/catalog-service" && ./mvnw -q -B -DskipTests package)
  echo "$SHA" > "$MARK"
fi
echo "backend jar: $(ls "$BACKEND_DIR"/services/catalog-service/target/catalog-service-*.jar | head -1) @ $SHA"
