# Shared settings for the local E2E stack. Sourced by every script; never run directly.
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$HARNESS_DIR/run"            # git-ignored: generated local secrets, certs, logs, pids
mkdir -p "$RUN_DIR/logs" "$RUN_DIR/pids" "$RUN_DIR/certs"
# Committed evidence (command output, screenshots). Never contains a token, key or presigned query string.
EVIDENCE_DIR="${E2E_EVIDENCE_DIR:-$HARNESS_DIR/evidence/$(date +%F)}"
mkdir -p "$EVIDENCE_DIR"

WORKSPACE="${TAZZZO_WORKSPACE:-/Users/user/Documents/CEO/Final/tazzzo-workspace}"
BACKEND_DIR="${E2E_BACKEND_DIR:-$WORKSPACE/tazzzo-backend-e2e}"        # integration/media-content
STORE_DIR="${E2E_STORE_DIR:-$WORKSPACE/tazzzo-web-store}"              # web/01-storefront
CMS_DIR="${E2E_CMS_DIR:-$WORKSPACE/tazzzo-web-cms20}"                  # cms/21-home-content
APP_DIR="${E2E_APP_DIR:-$WORKSPACE/tazzzo-app-content}"                # feature/app-home-content

# Ports (all loopback). Chosen to avoid the developer compose stack (27017/6379/6380) and the apps' own E2E ports.
MONGO_PORT=27117
REDIS_PORT=6391
S3_PORT=7070
CDN_PORT=8443
BACKEND_PORT=8080
STORE_PORT=3100
CMS_ORIGIN_PORT=3000        # the CMS origin (CMS_BASE_URL in local dev); the bucket CORS rule allows it

LABEL=tazzzo-e2e-local      # every container we start carries this label; down.sh removes exactly these
VERSITYGW_IMAGE='versity/versitygw@sha256:30292fc2eeacc67a36993b01f7a7a5e3361a19cced0e80c1d71cfa2a4b0a2499'  # = S3SignatureEnforcementIT

export JAVA_HOME="${JAVA_HOME_21:-$(/usr/libexec/java_home -v 21)}"

disk_guard() {
  local avail_kb
  avail_kb=$(df -k /System/Volumes/Data | awk 'NR==2 {print $4}')
  if (( avail_kb < 3 * 1024 * 1024 )); then
    echo "STOP: less than 3 GB free on /System/Volumes/Data ($((avail_kb / 1024)) MB)" >&2
    exit 3
  fi
}

# Generated once per checkout; LOCAL random values only, never committed (run/ is git-ignored).
ensure_env() {
  local f="$RUN_DIR/stack.env"
  if [[ ! -f "$f" ]]; then
    umask 077
    cat > "$f" <<EOF
E2E_S3_ENDPOINT=http://127.0.0.1:$S3_PORT
E2E_S3_BUCKET=tazzzo-media-local
E2E_S3_ACCESS_KEY=local$(openssl rand -hex 6)
E2E_S3_SECRET_KEY=$(openssl rand -hex 20)
E2E_CMS_TOKEN=cms-$(openssl rand -hex 24)
E2E_READ_TOKEN=read-$(openssl rand -hex 24)
E2E_CURSOR_KEY=$(openssl rand -base64 32)
E2E_CDN_PORT=$CDN_PORT
E2E_CERT_DIR=$RUN_DIR/certs
E2E_BACKEND=http://localhost:$BACKEND_PORT
E2E_CDN=https://localhost:$CDN_PORT
E2E_STORE=http://localhost:$STORE_PORT
E2E_CMS_ORIGIN=http://localhost:$CMS_ORIGIN_PORT
EOF
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
  # set -m: the job gets its own process group (pgid = pid), so stop_bg can end the whole tree (next dev forks).
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
