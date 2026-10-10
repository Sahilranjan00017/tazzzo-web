# Shared settings for the local E2E stack. Sourced by every script; never run directly.
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$(cd "$HARNESS_DIR/../.." && pwd)"                       # this repo (tazzzo-web) root
RUN_DIR="$HARNESS_DIR/run"            # git-ignored: generated local secrets, certs, logs, pids
mkdir -p "$RUN_DIR/logs" "$RUN_DIR/pids" "$RUN_DIR/certs"
# Committed evidence (transcripts, screenshots). Never contains a token, key, OTP or presigned query string.
EVIDENCE_DIR="${E2E_EVIDENCE_DIR:-$HARNESS_DIR/evidence/$(date +%F)}"

[[ -f "$HARNESS_DIR/local.env" ]] && source "$HARNESS_DIR/local.env"   # optional, git-ignored: E2E_BACKEND_REPO / E2E_BACKEND_DIR / JAVA_HOME_21 ...

# Backend: a CLEAN worktree of tazzzo-backend origin/main (scripts/backend-build.sh creates and builds it).
BACKEND_REPO="${E2E_BACKEND_REPO:-$WEB_DIR/../tazzzo-backend}"
BACKEND_DIR="${E2E_BACKEND_DIR:-$WEB_DIR/../tazzzo-backend-e2e-main}"
STORE_APP="$WEB_DIR/apps/storefront"
ADMIN_APP="$WEB_DIR/apps/admin"

# Ports (all loopback only). Chosen to avoid the backend's dev compose stack (27017/6379/6380).
MONGO_PORT="${E2E_MONGO_PORT:-27117}"
REDIS_PORT="${E2E_REDIS_PORT:-6391}"
S3_PORT="${E2E_S3_PORT:-7070}"
CDN_PORT="${E2E_CDN_PORT:-8443}"
BACKEND_PORT="${E2E_BACKEND_PORT:-8080}"
STORE_PORT="${E2E_STORE_PORT:-3100}"
CMS_ORIGIN_PORT="${E2E_CMS_ORIGIN_PORT:-3000}"   # the CMS origin; the bucket CORS rule allows it
SMS_PORT="${E2E_SMS_PORT:-7181}"                 # OTP gateway stand-in (HttpOtpDeliveryProvider target)
IDP_PORT="${E2E_IDP_PORT:-7182}"                 # JWKS stand-in for the human-admin OIDC trust (staff-role steps only)

LABEL=tazzzo-e2e-local      # every container we start carries this label; down.sh removes exactly these
# Same image digest S3SignatureEnforcementIT pins (SigV4 + If-None-Match enforcing).
VERSITYGW_IMAGE='versity/versitygw@sha256:30292fc2eeacc67a36993b01f7a7a5e3361a19cced0e80c1d71cfa2a4b0a2499'

export JAVA_HOME="${JAVA_HOME_21:-/usr/lib/jvm/java-21-openjdk-amd64}"
# Loopback must never go through a corporate/agent proxy.
export NO_PROXY="localhost,127.0.0.1,::1${NO_PROXY:+,$NO_PROXY}" no_proxy="localhost,127.0.0.1,::1${no_proxy:+,$no_proxy}"

disk_guard() {
  local avail_kb
  avail_kb=$(df -k "$RUN_DIR" | awk 'NR==2 {print $4}')
  if (( avail_kb < 3 * 1024 * 1024 )); then
    echo "STOP: less than 3 GB free ($((avail_kb / 1024)) MB)" >&2
    exit 3
  fi
}

b64() { head -c 32 /dev/urandom | base64 -w0; }

# Generated once per checkout; LOCAL random values only, never committed (run/ is git-ignored).
ensure_env() {
  local f="$RUN_DIR/stack.env"
  if [[ ! -f "$f" ]]; then
    umask 077
    cat > "$f" <<EOT
E2E_S3_ENDPOINT=http://127.0.0.1:$S3_PORT
E2E_S3_BUCKET=tazzzo-media-local
E2E_S3_ACCESS_KEY=local$(openssl rand -hex 6)
E2E_S3_SECRET_KEY=$(openssl rand -hex 20)
E2E_CMS_TOKEN=cms-$(openssl rand -hex 24)
E2E_READ_TOKEN=read-$(openssl rand -hex 24)
E2E_CURSOR_KEY=$(b64)
E2E_CUSTOMER_ACCESS_KEY=$(b64)
E2E_CUSTOMER_REFRESH_KEY=$(b64)
E2E_OTP_HMAC_KEY=$(b64)
E2E_SMS_TOKEN=sms-$(openssl rand -hex 24)
E2E_CALLER_NAME=storefront
E2E_CALLER_SECRET=$(openssl rand -hex 24)
E2E_SESSION_SECRET=$(b64)
E2E_ADMIN_AUDIENCE=e2e-local-admin-$(openssl rand -hex 6).apps.local
E2E_ADMIN_HD=e2e.tazzzo.test
E2E_CDN_PORT=$CDN_PORT
E2E_CERT_DIR=$RUN_DIR/certs
E2E_BACKEND=http://localhost:$BACKEND_PORT
E2E_CDN=https://localhost:$CDN_PORT
E2E_STORE=http://localhost:$STORE_PORT
E2E_CMS_ORIGIN=http://localhost:$CMS_ORIGIN_PORT
E2E_SMS_URL=http://127.0.0.1:$SMS_PORT
E2E_IDP_URL=http://127.0.0.1:$IDP_PORT
E2E_MONGO_PORT=$MONGO_PORT
EOT
  fi
  set -a; source "$f"; set +a
}

wait_http() {   # wait_http <url> <seconds> [curl args...]
  local url=$1 secs=$2; shift 2
  for _ in $(seq 1 "$secs"); do
    if curl -s -o /dev/null --max-time 2 "$@" "$url"; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for $url" >&2
  return 1
}

start_bg() {    # start_bg <name> <command...>   (pid in run/pids/<name>.pid, log in run/logs/<name>.log)
  local name=$1; shift
  if [[ -f "$RUN_DIR/pids/$name.pid" ]] && kill -0 "$(cat "$RUN_DIR/pids/$name.pid")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$RUN_DIR/pids/$name.pid"))"; return 0
  fi
  : > "$RUN_DIR/logs/$name.log"
  # set -m: the job gets its own process group (pgid = pid), so stop_bg can end the whole tree (next forks).
  ( set -m; nohup "$@" >> "$RUN_DIR/logs/$name.log" 2>&1 & echo $! > "$RUN_DIR/pids/$name.pid" )
  echo "$name started (pid $(cat "$RUN_DIR/pids/$name.pid"), log run/logs/$name.log)"
}

stop_bg() {     # stop_bg <name>  — TERM the process group we started, then KILL if needed
  local f="$RUN_DIR/pids/$1.pid"
  [[ -f "$f" ]] || return 0
  local pid; pid=$(cat "$f")
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$pid" 2>/dev/null || true
    echo "$1 stopped (pid $pid)"
  fi
  rm -f "$f"
}
