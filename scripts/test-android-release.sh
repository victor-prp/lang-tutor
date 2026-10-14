#!/usr/bin/env bash
#
# Tests scripts/android-release.sh (phase 32, spec D5–D7) against stub `eas`
# and `npx` commands that answer from fixtures and record what they were asked.
# No network, no Expo account, no node_modules: it runs in CI's setup-free
# check-adrs job beside test-release.sh.

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT

status=0
checks=0

ok() { checks=$((checks + 1)); printf '  ok         %s\n' "$1"; }
fail() { checks=$((checks + 1)); printf '\n  FAIL       %s\n%s\n' "$1" "$2" >&2; status=1; }

STUB="$FIXTURE/bin"
LOG="$FIXTURE/calls.log"
mkdir -p "$STUB"

# The fingerprint, as `npx expo-updates fingerprint:generate` prints it: npm's
# notices first, then one line of JSON.
cat > "$STUB/npx" <<'STUB'
#!/usr/bin/env bash
echo "npx $*" >> "$LOG"
echo "npm notice run npx"
printf '{"sources":[],"hash":"%s"}\n' "$FP"
STUB

# eas: the newest finished build (LATEST_ID/LATEST_RT, none when LATEST_RT is
# empty), the build the runtime's newest update on production was published
# for (UPDATE_FOR, none when empty; the script names it in the message), a new
# build's id (NEW_ID), and a submit that fails (SUBMIT_FAILS).
cat > "$STUB/eas" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  build:list)
    if [ -z "$LATEST_RT" ]; then echo '[]'; else
      printf '[{"id":"%s","status":"FINISHED","runtime":{"id":"r","version":"%s"}}]\n' "$LATEST_ID" "$LATEST_RT"; fi
    echo "eas $*" >> "$LOG" ;;
  update:list)
    echo "eas $*" >> "$LOG"
    if [ -n "$UPDATE_FOR" ]; then
      printf '{"name":"production","id":"b","currentPage":[{"group":"g","message":"\\"v2026.10.10 for build %s\\" (1 day ago by robot)"}]}\n' "$UPDATE_FOR"
    else echo '{"name":"production","id":"b","currentPage":[]}'; fi ;;
  build)
    echo "eas $*" >> "$LOG"
    printf '[{"id":"%s","status":"FINISHED"}]\n' "$NEW_ID" ;;
  submit)
    echo "eas $*" >> "$LOG"
    [ "$SUBMIT_FAILS" = 1 ] && { echo "submission failed" >&2; exit 1; }
    exit 0 ;;
  update)
    echo "eas $* APP_VERSION=${EXPO_PUBLIC_APP_VERSION:-unset} APP_COMMIT=${EXPO_PUBLIC_APP_COMMIT:-unset} API_URL=${EXPO_PUBLIC_API_URL:-unset}" >> "$LOG" ;;
  *) echo "eas $*" >> "$LOG"; exit 2 ;;
esac
STUB
chmod +x "$STUB/npx" "$STUB/eas"

# A mobile directory with what the script reads: app.json, eas.json and .env.production.
MOBILE="$FIXTURE/mobile"
mkdir -p "$MOBILE"
with_project() {
  printf '{"expo":{"extra":{"eas":{"projectId":"p1"}}}}\n' > "$MOBILE/app.json"
  echo '{}' > "$MOBILE/eas.json"
  printf '# a comment\nEXPO_PUBLIC_API_URL=https://app.example\n' > "$MOBILE/.env.production"
}
with_project

OUT="$FIXTURE/out"
# run <args...>, with the fixture variables already exported; sets $code.
run() {
  : > "$LOG"
  PATH="$STUB:$PATH" LOG="$LOG" MOBILE_DIR="$MOBILE" TAG=v2026.10.11.1 \
    bash "$REPO/scripts/android-release.sh" "$@" > "$OUT" 2>&1
  code=$?
}
# fixture <fp> <newest build id> <newest runtime> <build the newest update names> [submit fails]
fixture() { export FP="$1" LATEST_ID="$2" LATEST_RT="$3" UPDATE_FOR="$4" NEW_ID=b-new SUBMIT_FAILS="${5:-0}" EXPO_TOKEN=t ANDROID_RELEASE=on; }

logged() { grep -q -- "$1" "$LOG"; }
expect_calls() { # expect_calls <label> <want-exit> <yes/no pattern>...
  local label="$1" want="$2" detail=""; shift 2
  [ "$code" = "$want" ] || detail="exit $code, wanted $want"
  for spec in "$@"; do
    local mode="${spec%%:*}" pattern="${spec#*:}"
    if [ "$mode" = yes ] && ! logged "$pattern"; then detail="$detail; missing: $pattern"; fi
    if [ "$mode" = no ] && logged "$pattern"; then detail="$detail; unexpected: $pattern"; fi
  done
  if [ -z "$detail" ]; then ok "$label"; else fail "$label" "$detail
--- calls ---
$(cat "$LOG")
--- output ---
$(cat "$OUT")"; fi
}

echo "Testing scripts/android-release.sh"
echo

fixture fp1 b1 fp1 b1; run
expect_calls "same fingerprint, on Play: publishes an update only" 0 \
  "yes:eas update --branch production" "no:eas build " "no:eas submit"
expect_calls "the update carries the tag and the build it targets as its message, and the tag as the app version" 0 \
  "yes:--message v2026.10.11.1 for build b1" "yes:APP_VERSION=v2026.10.11.1" "yes:--environment production"
# Phase 49 (spec D2): the tag's commit, as the About screen shows it.
commit=$(cd "$REPO" && git rev-parse --short=7 HEAD)
expect_calls "the update carries the tag's commit" 0 "yes:APP_COMMIT=$commit"
# eas update --environment production reads no .env file, so an update built
# without this crashed at launch ("EXPO_PUBLIC_API_URL is not set") and every
# phone stayed on the build's own bundle.
expect_calls "the update carries the production API address from .env.production" 0 \
  "yes:API_URL=https://app.example"
expect_calls "the marker is asked for this fingerprint on production" 0 \
  "yes:update:list --branch production --runtime-version fp1"

fixture fp1 b1 fp1 ''; run
expect_calls "same fingerprint, never reached Play: submits that build, then updates" 0 \
  "yes:eas submit --platform android --profile production --id b1 --wait" "yes:eas update --branch production" "no:eas build "

fixture fp2 b1 fp1 b1; run
expect_calls "new fingerprint: builds, submits the new build, then updates" 0 \
  "yes:eas build --platform android --profile production --wait" "yes:--id b-new" "yes:eas update --branch production"
order=$(awk '$2 == "build" || $2 == "submit" || $2 == "update" { printf "%s ", $2 }' "$LOG")
if [ "$order" = "build submit update " ]; then ok "build, then submit, then update, in that order"
else fail "build, then submit, then update, in that order" "got: $order"; fi

fixture fp1 b1 "" ''; run
expect_calls "no build yet: builds" 0 "yes:eas build --platform android" "yes:eas update --branch production"

# Reverting a native change: fp equals an OLDER build's runtime, not the newest.
# The script asks only for the newest, so the stub's newest is fp2 here.
fixture fp1 b2 fp2 b2; run
expect_calls "a reverted native change builds again, never updates an older runtime" 0 \
  "yes:eas build --platform android" "no:update:list --branch production --runtime-version fp1 "

fixture fp1 b2 fp2 b2; run --rollback
expect_calls "a rollback across a native change publishes nothing" 0 \
  "no:eas build " "no:eas submit" "no:eas update "
grep -q '::warning::' "$OUT" && ok "and says so in a warning" || fail "and says so in a warning" "$(cat "$OUT")"

fixture fp1 b1 fp1 b1; run --rollback
expect_calls "a rollback with the same fingerprint publishes the old tag's JavaScript" 0 \
  "yes:eas update --branch production" "no:eas build "

fixture fp2 b1 fp1 b1 1; run
expect_calls "a failed submit fails the job and publishes no update" 1 \
  "yes:eas submit" "no:eas update "

# The ANDROID_RELEASE repository variable: the job ships only when it is "on".
fixture fp1 b1 fp1 b1; ANDROID_RELEASE='' run
expect_calls "ANDROID_RELEASE unset: skips, green, calling nothing" 0 "no:eas " "no:npx "
grep -q 'ANDROID_RELEASE' "$OUT" && ok "and the notice names the flag" || fail "and the notice names the flag" "$(cat "$OUT")"

fixture fp1 b1 fp1 b1; ANDROID_RELEASE=off run
expect_calls "ANDROID_RELEASE=off: skips, green, calling nothing" 0 "no:eas " "no:npx "

fixture fp1 b1 fp1 b1; ANDROID_RELEASE=yes run
expect_calls "any value but on skips: the flag is explicit" 0 "no:eas " "no:npx "

fixture fp2 b1 fp1 b1; ANDROID_RELEASE=off run --rollback
expect_calls "a rollback honours the flag too" 0 "no:eas " "no:npx "

fixture fp1 b1 fp1 b1; EXPO_TOKEN='' run
expect_calls "no EXPO_TOKEN: skips, green, calling nothing" 0 "no:eas " "no:npx "
grep -q '::notice::' "$OUT" && ok "and leaves a notice" || fail "and leaves a notice" "$(cat "$OUT")"

fixture fp1 b1 fp1 b1; echo '{"expo":{}}' > "$MOBILE/app.json"; run
expect_calls "no EAS project id yet: skips, green, calling nothing" 0 "no:eas " "no:npx "
with_project

fixture fp1 b1 fp1 b1; rm "$MOBILE/eas.json"; run
expect_calls "a tag from before phase 32 (no eas.json): skips, green" 0 "no:eas " "no:npx "
with_project

fixture fp1 b1 fp1 b1; printf '# nothing\n' > "$MOBILE/.env.production"; run
expect_calls "no API address in .env.production: fails before asking EAS anything" 1 "no:eas " "no:npx "
grep -q 'EXPO_PUBLIC_API_URL' "$OUT" && ok "and the error names the variable" || fail "and the error names the variable" "$(cat "$OUT")"
with_project

fixture fp1 b1 fp1 b1; rm "$MOBILE/.env.production"; run
expect_calls "no .env.production at all: fails the same way" 1 "no:eas " "no:npx "
grep -q '::error::.*EXPO_PUBLIC_API_URL' "$OUT" && ok "with the same error" || fail "with the same error" "$(cat "$OUT")"
with_project

# Review finding: a rerun after a reverted native change whose submit failed.
# The runtime's newest update was published for an older build of the same
# runtime, so it proves nothing about the newest build: submit it.
fixture fp1 b3 fp1 b1; run
expect_calls "an update for an older build of the same runtime does not count: submits the newest" 0 \
  "yes:eas submit --platform android --profile production --id b3 --wait" "yes:--message v2026.10.11.1 for build b3"

fixture "" b1 fp1 b1; run
expect_calls "no fingerprint: fails before asking EAS anything" 1 "no:eas "

echo
if [ "$status" -ne 0 ]; then
  echo "android-release.sh FAILED ($checks checks)" >&2
else
  echo "android-release.sh ok ($checks checks)"
fi
exit "$status"
