#!/usr/bin/env bash
# Writes the exact versions and SHAs of what is under test to stdout (journeys.sh saves it as evidence/<date>/versions.txt).
source "$(dirname "$0")/common.sh"
ensure_env
echo "date (UTC): $(date -u +%FT%TZ)"
echo "web repo:     $(git -C "$WEB_DIR" rev-parse HEAD) (branch $(git -C "$WEB_DIR" rev-parse --abbrev-ref HEAD)); base origin/main $(git -C "$WEB_DIR" rev-parse origin/main 2>/dev/null || echo ?)"
echo "backend:      $(git -C "$BACKEND_DIR" rev-parse HEAD) (clean worktree of origin/main; $(git -C "$BACKEND_DIR" log -1 --format=%s | cut -c1-90))"
JAR=$(ls "$BACKEND_DIR"/services/catalog-service/target/catalog-service-*.jar | head -1)
echo "backend jar:  $(basename "$JAR") $(stat -c %s "$JAR") bytes; Spring-Boot-Version $(unzip -p "$JAR" META-INF/MANIFEST.MF | tr -d '\r' | awk -F': ' '/^Spring-Boot-Version/ {print $2}')"
echo "java:         $("$JAVA_HOME/bin/java" -version 2>&1 | grep -v 'Picked up' | head -1)"
echo "node:         $(node -v)   pnpm: $(PATH=/tmp/claude-0/bin:$PATH pnpm -v 2>/dev/null | tail -1)"
echo "next:         $(node -p "require('$STORE_APP/node_modules/next/package.json').version")   react: $(node -p "require('$STORE_APP/node_modules/react/package.json').version")"
echo "playwright:   $(node -p "require('$STORE_APP/node_modules/@playwright/test/package.json').version")   chromium: $(ls "${PLAYWRIGHT_BROWSERS_PATH:-/tmp/claude-0/pw}" | tr '\n' ' ')"
echo "docker:       $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
for i in mongo:7 redis:7-alpine "$VERSITYGW_IMAGE"; do echo "image:        $i -> $(docker image inspect "$i" --format '{{.Id}}' 2>/dev/null | cut -c1-19)"; done
echo "mongod:       $(docker exec tazzzo-e2e-mongo mongod --version 2>/dev/null | head -1)"
echo "redis:        $(docker exec tazzzo-e2e-redis redis-server --version 2>/dev/null)"
echo "migrations applied: $(docker exec tazzzo-e2e-mongo mongosh --quiet --port "$MONGO_PORT" tazzzo_e2e --eval 'db.schema_migrations.find({},{_id:1}).sort({_id:1}).toArray().map(d=>d._id.slice(0,5)).join(",")' 2>/dev/null)"
echo "os:           $(uname -sr)"
