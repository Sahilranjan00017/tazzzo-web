#!/usr/bin/env bash
# Start the local stack: MongoDB 7 (single-node replica set), Redis 7, Versity S3 Gateway (bucket + CORS),
# the HTTPS CDN stand-in, and the backend (tazzzo-backend main, clean worktree) as a real Java process.
# Then the storefront: scripts/web.sh. Seed: scripts/seed.sh. Stop everything: scripts/down.sh.
source "$(dirname "$0")/common.sh"
disk_guard
ensure_env

echo "== containers (label $LABEL)"
run_container() {   # run_container <name> <docker run args...>
  local name=$1; shift
  if docker ps --format '{{.Names}}' | grep -qx "$name"; then echo "$name already running"; return; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --label "$LABEL" "$@" >/dev/null
  echo "$name started"
}
run_container tazzzo-e2e-mongo -p 127.0.0.1:$MONGO_PORT:$MONGO_PORT mongo:7 \
  mongod --replSet rs0 --bind_ip_all --port $MONGO_PORT
run_container tazzzo-e2e-redis -p 127.0.0.1:$REDIS_PORT:6379 redis:7-alpine redis-server --save '' --appendonly no
run_container tazzzo-e2e-s3 -p 127.0.0.1:$S3_PORT:7070 \
  -e ROOT_ACCESS_KEY="$E2E_S3_ACCESS_KEY" -e ROOT_SECRET_KEY="$E2E_S3_SECRET_KEY" \
  "$VERSITYGW_IMAGE" --port :7070 posix /tmp

echo "== mongo replica set"
for _ in $(seq 1 60); do
  docker exec tazzzo-e2e-mongo mongosh --port $MONGO_PORT --quiet --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1 && break
  sleep 1
done
docker exec tazzzo-e2e-mongo mongosh --port $MONGO_PORT --quiet --eval \
  "try { rs.status(); print('rs0 already initiated') } catch (e) { rs.initiate({_id:'rs0', members:[{_id:0, host:'localhost:$MONGO_PORT'}]}); print('rs0 initiated') }"
for _ in $(seq 1 30); do
  [[ "$(docker exec tazzzo-e2e-mongo mongosh --port $MONGO_PORT --quiet --eval 'db.hello().isWritablePrimary')" == "true" ]] && break
  sleep 1
done

echo "== bucket + CORS (S3 API: CreateBucket, PutBucketCors)"
wait_http "$E2E_S3_ENDPOINT" 30
node "$HARNESS_DIR/lib/s3-admin.mjs" create-bucket
node "$HARNESS_DIR/lib/s3-admin.mjs" put-cors "$E2E_CMS_ORIGIN" "http://127.0.0.1:$CMS_ORIGIN_PORT"

echo "== CDN stand-in certificate (self-signed, localhost + 127.0.0.1, 2 days)"
if [[ ! -f "$E2E_CERT_DIR/cdn.crt" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout "$E2E_CERT_DIR/cdn.key" -out "$E2E_CERT_DIR/cdn.crt" 2>/dev/null
fi
"$(dirname "$0")/cdn.sh" start

echo "== backend (java -jar, provider=s3 against versitygw, public-base-url=$E2E_CDN)"
JAR=$(ls "$BACKEND_DIR"/services/catalog-service/target/catalog-service-*.jar 2>/dev/null | head -1 || true)
if [[ -z "$JAR" ]]; then
  echo "building backend jar (skip tests) in $BACKEND_DIR"
  (cd "$BACKEND_DIR/services/catalog-service" && ./mvnw -q -DskipTests package)
  JAR=$(ls "$BACKEND_DIR"/services/catalog-service/target/catalog-service-*.jar | head -1)
fi
start_bg backend env \
  MONGODB_URI="mongodb://localhost:$MONGO_PORT/tazzzo_e2e?replicaSet=rs0" MONGODB_DATABASE=tazzzo_e2e \
  TAZZZO_MIGRATION_MODE=APPLY_ON_STARTUP TAZZZO_MIGRATION_ENVIRONMENT=local \
  TAZZZO_SCHEDULER_ENABLED=true \
  TAZZZO_CMS_TOKEN="$E2E_CMS_TOKEN" TAZZZO_READ_TOKEN="$E2E_READ_TOKEN" \
  TAZZZO_CONSUMER_RATE_LIMIT_MODE=REDIS TAZZZO_RATE_LIMIT_REDIS_URL="redis://localhost:$REDIS_PORT" \
  TAZZZO_TRUSTED_PROXY_CIDRS=10.99.99.0/24 \
  TAZZZO_RATE_LIMIT_IP_CAPACITY=100000 TAZZZO_RATE_LIMIT_IP_REFILL=100000 \
  TAZZZO_RATE_LIMIT_INSTALL_CAPACITY=100000 TAZZZO_RATE_LIMIT_INSTALL_REFILL=100000 \
  TAZZZO_CONSUMER_CURSOR_HMAC_KEY_B64="$E2E_CURSOR_KEY" \
  TAZZZO_MEDIA_STORAGE_PROVIDER=s3 TAZZZO_MEDIA_S3_BUCKET="$E2E_S3_BUCKET" TAZZZO_MEDIA_S3_REGION=us-east-1 \
  TAZZZO_MEDIA_S3_ENDPOINT="$E2E_S3_ENDPOINT" TAZZZO_MEDIA_S3_PATH_STYLE=true \
  TAZZZO_MEDIA_S3_ACCESS_KEY="$E2E_S3_ACCESS_KEY" TAZZZO_MEDIA_S3_SECRET_KEY="$E2E_S3_SECRET_KEY" \
  "$JAVA_HOME/bin/java" -jar "$JAR" --server.port=$BACKEND_PORT --server.address=127.0.0.1 \
  --tazzzo.media.public-base-url="$E2E_CDN" \
  --tazzzo.freshness.enabled=true --tazzzo.scheduler.card-projection-enabled=true --tazzzo.scheduler.card-rebuild-ms=3000
wait_http "$E2E_BACKEND/health/ready" 120 --fail
echo "backend ready: $(curl -s "$E2E_BACKEND/health/ready")"
grep 'media_storage provider' "$RUN_DIR/logs/backend.log" | tail -1 || true
