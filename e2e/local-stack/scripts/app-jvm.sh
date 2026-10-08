#!/usr/bin/env bash
# App contract checkpoint (tazzzo-app PR #24): runs app-jvm/LocalBackendE2ETest.kt — the app's real shared Kotlin
# (ApiClient + RemoteContentDataSource + mapping, RemoteCatalogDataSource, KtorImageFetcher) on the JVM against the live
# local backend and CDN stand-in. NOT on-device rendering.
#   app-jvm.sh <checkpoint-name>   with optional env:
#     E2E_APP_EXPECT_ORDER='Title A|Title B'   titles that must appear in this relative order
#     E2E_APP_EXPECT_ABSENT='Title C'           titles that must not reach the app
#     E2E_APP_EXPECT_IMAGES=ok|unavailable      banner (and PDP) image fetch outcome
#     E2E_APP_PDP=TZP-…                         also read this PDP and fetch its first gallery image
# The test file is copied into the app worktree's androidUnitTest source set for this run only and removed on exit
# (the app branch is never modified or committed). Output: evidence/<date>/app-<checkpoint>.txt
source "$(dirname "$0")/common.sh"
ensure_env
disk_guard
name="${1:?checkpoint name}"
DEST_DIR="$APP_DIR/composeApp/src/androidUnitTest/kotlin/com/tazzzo/app/e2e"
DEST="$DEST_DIR/LocalBackendE2ETest.kt"
created_src_root=0
[[ -d "$APP_DIR/composeApp/src/androidUnitTest" ]] || created_src_root=1
cleanup() {
  rm -f "$DEST"
  if (( created_src_root )); then rm -rf "$APP_DIR/composeApp/src/androidUnitTest"; fi
}
trap cleanup EXIT
mkdir -p "$DEST_DIR"
cp "$HARNESS_DIR/app-jvm/LocalBackendE2ETest.kt" "$DEST"
out="$EVIDENCE_DIR/app-$name.txt"
set +e
(cd "$APP_DIR" && env ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}" TAZZZO_E2E_BACKEND="$E2E_BACKEND" TAZZZO_E2E_CDN="$E2E_CDN" TAZZZO_E2E_CDN_CERT="$E2E_CERT_DIR/cdn.crt" \
  E2E_APP_CHECKPOINT="$name" ./gradlew --offline -q :composeApp:testDebugUnitTest \
  --tests 'com.tazzzo.app.e2e.LocalBackendE2ETest' --rerun) > "$RUN_DIR/logs/app-jvm-$name.log" 2>&1
rc=$?
set -e
xml="$APP_DIR/composeApp/build/test-results/testDebugUnitTest/TEST-com.tazzzo.app.e2e.LocalBackendE2ETest.xml"
{
  echo "\$ scripts/app-jvm.sh $name   (gradle exit $rc)"
  [[ -f "$xml" ]] && python3 -c 'import sys,xml.etree.ElementTree as E
r=E.parse(sys.argv[1]).getroot()
print("junit: tests=%s failures=%s errors=%s skipped=%s" % (r.get("tests"), r.get("failures"), r.get("errors"), r.get("skipped")))
for tc in r.iter("testcase"):
  for f in list(tc.findall("failure"))+list(tc.findall("error")): print("FAILURE:", (f.get("message") or "")[:600])
so=r.find("system-out"); print((so.text or "").rstrip())' "$xml"
  (( rc == 0 )) || tail -30 "$RUN_DIR/logs/app-jvm-$name.log"
} | tee "$out"
exit $rc
