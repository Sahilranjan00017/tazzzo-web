#!/usr/bin/env bash
# Start the local stack: MongoDB 7 (single-node replica set), Redis 7, Versity S3 Gateway (bucket + CORS), the HTTPS CDN
# stand-in, the OTP gateway stand-in, the admin JWKS stand-in, and the backend (tazzzo-backend origin/main) as a real Java
# process. Then: scripts/seed.sh, scripts/web.sh start, scripts/journeys.sh. Stop everything: scripts/down.sh.
# Everything binds 127.0.0.1. No AWS profile, SDK, CLI or credential is used.
source "$(dirname "$0")/common.sh"
disk_guard
ensure_env
"$(dirname "$0")/backend-build.sh"
JAR=$(ls "$BACKEND_DIR"/services/catalog-service/target/catalog-service-*.jar | head -1)
export E2E_RUN_DIR="$RUN_DIR"

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
if [[ ! -f "$E2E_CERT_DIR/cdn.crt" ]] || ! openssl x509 -checkend 3600 -noout -in "$E2E_CERT_DIR/cdn.crt" >/dev/null; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout "$E2E_CERT_DIR/cdn.key" -out "$E2E_CERT_DIR/cdn.crt" 2>/dev/null
fi
"$(dirname "$0")/cdn.sh" start

echo "== OTP gateway stand-in + admin JWKS stand-in"
start_bg sms node "$HARNESS_DIR/lib/otp-sink.mjs"
start_bg idp node "$HARNESS_DIR/lib/idp.mjs"
wait_http "$E2E_IDP_URL/jwks" 15 --fail

echo "== backend (java -jar, media=s3 on versitygw, OTP=HTTP adapter -> loopback sink, rate limiter=REDIS)"
# Structured settings go in SPRING_APPLICATION_JSON (relaxed env names for nested/list keys are easy to get wrong).
SPRING_APPLICATION_JSON=$(node -e '
const e = process.env
const user = (sub, email, roles) => ({ provider: "google", subject: sub, email, roles, enabled: true })
console.log(JSON.stringify({
  tazzzo: {
    media: { "public-base-url": e.E2E_CDN },
    freshness: { enabled: true },
    scheduler: { "card-projection-enabled": true, "card-rebuild-ms": 3000, "import-jobs-tick-ms": 1000 },
    "customer-auth": { otp: { http: { url: e.E2E_SMS_URL + "/sms", "auth-header-value": e.E2E_SMS_TOKEN, sender: "TAZZZO" } } },
    admin: {
      oidc: { issuer: "https://accounts.google.com", audience: e.E2E_ADMIN_AUDIENCE, "hosted-domain": e.E2E_ADMIN_HD,
              "credential-label": "e2e-local", "jwks-uri": e.E2E_IDP_URL + "/jwks" },
      users: [
        user("e2e-sub-ops", "ops@" + e.E2E_ADMIN_HD, ["order-ops"]),
        user("e2e-sub-support", "support@" + e.E2E_ADMIN_HD, ["support-agent"]),
        user("e2e-sub-writer", "writer@" + e.E2E_ADMIN_HD, ["cms-writer"]),
        user("e2e-sub-reader", "reader@" + e.E2E_ADMIN_HD, ["reader"]),
      ],
    },
  },
}))')
export SPRING_APPLICATION_JSON
start_bg backend env \
  MONGODB_URI="mongodb://localhost:$MONGO_PORT/tazzzo_e2e?replicaSet=rs0" MONGODB_DATABASE=tazzzo_e2e \
  TAZZZO_MIGRATION_MODE=APPLY_ON_STARTUP TAZZZO_MIGRATION_ENVIRONMENT=local \
  TAZZZO_SCHEDULER_ENABLED=true TAZZZO_IMPORT_JOBS_ENABLED=true \
  TAZZZO_IMPORT_JOBS_LEASE_MS=60000 TAZZZO_IMPORT_JOBS_TICK_BUDGET_MS=20000 \
  TAZZZO_CMS_TOKEN="$E2E_CMS_TOKEN" TAZZZO_READ_TOKEN="$E2E_READ_TOKEN" \
  TAZZZO_CONSUMER_RATE_LIMIT_MODE=REDIS TAZZZO_RATE_LIMIT_REDIS_URL="redis://localhost:$REDIS_PORT" \
  TAZZZO_TRUSTED_PROXY_CIDRS=10.99.99.0/24 \
  TAZZZO_RATE_LIMIT_IP_CAPACITY=100000 TAZZZO_RATE_LIMIT_IP_REFILL=100000 \
  TAZZZO_RATE_LIMIT_INSTALL_CAPACITY=100000 TAZZZO_RATE_LIMIT_INSTALL_REFILL=100000 \
  TAZZZO_CONSUMER_CURSOR_HMAC_KEY_B64="$E2E_CURSOR_KEY" \
  TAZZZO_CONSUMER_TRUSTEDCALLERS_0_NAME="$E2E_CALLER_NAME" TAZZZO_CONSUMER_TRUSTEDCALLERS_0_SECRET="$E2E_CALLER_SECRET" \
  TAZZZO_CUSTOMER_AUTH_ACCESS_TOKEN_HMAC_KEY_B64="$E2E_CUSTOMER_ACCESS_KEY" \
  TAZZZO_CUSTOMER_SESSION_REFRESH_HMAC_KEY_B64="$E2E_CUSTOMER_REFRESH_KEY" \
  TAZZZO_CUSTOMER_AUTH_OTP_HMAC_KEY_B64="$E2E_OTP_HMAC_KEY" \
  TAZZZO_OTP_PROVIDER_MODE=HTTP TAZZZO_OTP_RESEND_COOLDOWN_SECONDS=2 \
  TAZZZO_OTP_REQUEST_IP_CAPACITY=500 TAZZZO_OTP_REQUEST_IP_REFILL=50 \
  TAZZZO_OTP_REQUEST_PHONE_CAPACITY=5 TAZZZO_OTP_REQUEST_PHONE_REFILL=0.01 \
  TAZZZO_OTP_VERIFY_IP_CAPACITY=500 TAZZZO_OTP_VERIFY_IP_REFILL=50 \
  TAZZZO_OTP_VERIFY_CHALLENGE_CAPACITY=20 TAZZZO_OTP_VERIFY_CHALLENGE_REFILL=1 \
  TAZZZO_MEDIA_STORAGE_PROVIDER=s3 TAZZZO_MEDIA_S3_BUCKET="$E2E_S3_BUCKET" TAZZZO_MEDIA_S3_REGION=us-east-1 \
  TAZZZO_MEDIA_S3_ENDPOINT="$E2E_S3_ENDPOINT" TAZZZO_MEDIA_S3_PATH_STYLE=true \
  TAZZZO_MEDIA_S3_ACCESS_KEY="$E2E_S3_ACCESS_KEY" TAZZZO_MEDIA_S3_SECRET_KEY="$E2E_S3_SECRET_KEY" \
  "$JAVA_HOME/bin/java" -jar "$JAR" --server.port=$BACKEND_PORT --server.address=127.0.0.1
wait_http "$E2E_BACKEND/health/ready" 180 --fail
echo "backend ready: $(curl -s "$E2E_BACKEND/health/ready")"
grep -E 'media_storage provider|otp' "$RUN_DIR/logs/backend.log" | head -3 | sed -E 's/(token|secret|key)=[^ ]+/\1=<redacted>/Ig' || true
