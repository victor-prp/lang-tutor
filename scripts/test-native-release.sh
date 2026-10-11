#!/usr/bin/env bash
#
# Tests scripts/native-release.sh (phase 32, spec D5–D7; phase 36, spec D3–D5)
# against stub `eas` and `npx` commands that answer from fixtures and record
# what they were asked. Every case runs for both platforms; the iOS-only rules
# (the App Store Connect app id, the 80-day build age) have cases of their own.
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
# empty, created at CREATED, no createdAt when CREATED is empty), the build the
# runtime's newest update on production was published for (UPDATE_FOR, none
# when empty; the script names it in the message), a new build's id (NEW_ID),
# and a submit that fails (SUBMIT_FAILS).
cat > "$STUB/eas" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  build:list)
    if [ -z "$LATEST_RT" ]; then echo '[]'
    elif [ -z "$CREATED" ]; then
      printf '[{"id":"%s","status":"FINISHED","runtime":{"id":"r","version":"%s"}}]\n' "$LATEST_ID" "$LATEST_RT"
    else
      printf '[{"id":"%s","status":"FINISHED","createdAt":"%s","runtime":{"id":"r","version":"%s"}}]\n' "$LATEST_ID" "$CREATED" "$LATEST_RT"; fi
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
    echo "eas $* APP_VERSION=${EXPO_PUBLIC_APP_VERSION:-unset}" >> "$LOG" ;;
  *) echo "eas $*" >> "$LOG"; exit 2 ;;
esac
STUB
chmod +x "$STUB/npx" "$STUB/eas"

# A mobile directory with what the script reads: app.json and eas.json.
MOBILE="$FIXTURE/mobile"
mkdir -p "$MOBILE"
with_project() {
  printf '{"expo":{"extra":{"eas":{"projectId":"p1"}}}}\n' > "$MOBILE/app.json"
  echo '{"submit":{"production":{"ios":{"ascAppId":"123"}}}}' > "$MOBILE/eas.json"
}
with_project

# The newest build's age: CREATED is fixed, NOW is CREATED plus some days.
CREATED_AT=2026-01-01T00:00:00.000Z
CREATED_EPOCH=1767225600
days_later() { echo $((CREATED_EPOCH + $1 * 86400)); }

OUT="$FIXTURE/out"
# run <args...>, with the fixture variables already exported; sets $code.
run() {
  : > "$LOG"
  PATH="$STUB:$PATH" LOG="$LOG" MOBILE_DIR="$MOBILE" TAG=v2026.10.11.1 \
    bash "$REPO/scripts/native-release.sh" "$@" > "$OUT" 2>&1
  code=$?
}
# fixture <fp> <newest build id> <newest runtime> <build the newest update names> [submit fails]
# Both switches are on and the newest build is a day old unless a case says otherwise.
fixture() {
  export FP="$1" LATEST_ID="$2" LATEST_RT="$3" UPDATE_FOR="$4" NEW_ID=b-new SUBMIT_FAILS="${5:-0}" EXPO_TOKEN=t \
    ANDROID_RELEASE=on IOS_RELEASE=on CREATED="$CREATED_AT" NOW="$(days_later 1)"
}

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
said() { # said <label> <pattern>: the script's output contains it
  if grep -q -- "$2" "$OUT"; then ok "$1"; else fail "$1" "$(cat "$OUT")"; fi
}

echo "Testing scripts/native-release.sh"

for platform in android ios; do
  case "$platform" in
    android) switch=ANDROID_RELEASE other=IOS_RELEASE ;;
    ios) switch=IOS_RELEASE other=ANDROID_RELEASE ;;
  esac
  echo
  echo "$platform"

  fixture fp1 b1 fp1 b1; run "$platform"
  expect_calls "same fingerprint, already shipped: publishes an update only" 0 \
    "yes:eas update --branch production --platform $platform" "no:eas build " "no:eas submit"
  expect_calls "the update carries the tag and the build it targets as its message, and the tag as the app version" 0 \
    "yes:--message v2026.10.11.1 for build b1" "yes:APP_VERSION=v2026.10.11.1" "yes:--environment production"
  expect_calls "the fingerprint and the newest build are this platform's" 0 \
    "yes:npx expo-updates fingerprint:generate --platform $platform" \
    "yes:eas build:list --platform $platform --build-profile production"
  expect_calls "the marker is asked for this fingerprint on production" 0 \
    "yes:update:list --branch production --runtime-version fp1"

  fixture fp1 b1 fp1 ''; run "$platform"
  expect_calls "same fingerprint, never shipped: submits that build, then updates" 0 \
    "yes:eas submit --platform $platform --profile production --id b1 --wait" "yes:eas update --branch production" "no:eas build "

  fixture fp2 b1 fp1 b1; run "$platform"
  expect_calls "new fingerprint: builds, submits the new build, then updates" 0 \
    "yes:eas build --platform $platform --profile production --wait" "yes:--id b-new" "yes:eas update --branch production"
  order=$(awk '$2 == "build" || $2 == "submit" || $2 == "update" { printf "%s ", $2 }' "$LOG")
  if [ "$order" = "build submit update " ]; then ok "build, then submit, then update, in that order"
  else fail "build, then submit, then update, in that order" "got: $order"; fi

  fixture fp1 b1 "" ''; run "$platform"
  expect_calls "no build yet: builds" 0 "yes:eas build --platform $platform" "yes:eas update --branch production"

  # Reverting a native change: fp equals an OLDER build's runtime, not the newest.
  # The script asks only for the newest, so the stub's newest is fp2 here.
  fixture fp1 b2 fp2 b2; run "$platform"
  expect_calls "a reverted native change builds again, never updates an older runtime" 0 \
    "yes:eas build --platform $platform" "no:update:list --branch production --runtime-version fp1 "

  fixture fp1 b2 fp2 b2; run "$platform" --rollback
  expect_calls "a rollback across a native change publishes nothing" 0 \
    "no:eas build " "no:eas submit" "no:eas update "
  said "and says so in a warning" '::warning::'

  fixture fp1 b1 fp1 b1; run "$platform" --rollback
  expect_calls "a rollback with the same fingerprint publishes the old tag's JavaScript" 0 \
    "yes:eas update --branch production" "no:eas build "

  fixture fp2 b1 fp1 b1 1; run "$platform"
  expect_calls "a failed submit fails the job and publishes no update" 1 \
    "yes:eas submit" "no:eas update "

  # The platform's repository variable: the job ships only when it is "on".
  fixture fp1 b1 fp1 b1; export "$switch="; run "$platform"
  expect_calls "$switch unset: skips, green, calling nothing" 0 "no:eas " "no:npx "
  said "and the notice names the flag" "$switch"

  fixture fp1 b1 fp1 b1; export "$switch=off"; run "$platform"
  expect_calls "$switch=off: skips, green, calling nothing" 0 "no:eas " "no:npx "

  fixture fp1 b1 fp1 b1; export "$switch=yes"; run "$platform"
  expect_calls "any value but on skips: the flag is explicit" 0 "no:eas " "no:npx "

  fixture fp1 b1 fp1 b1; export "$switch=off" "$other=on"; run "$platform"
  expect_calls "the other platform's switch does not count" 0 "no:eas " "no:npx "

  fixture fp2 b1 fp1 b1; export "$switch=off"; run "$platform" --rollback
  expect_calls "a rollback honours the flag too" 0 "no:eas " "no:npx "

  fixture fp1 b1 fp1 b1; export EXPO_TOKEN=''; run "$platform"
  expect_calls "no EXPO_TOKEN: skips, green, calling nothing" 0 "no:eas " "no:npx "
  said "and leaves a notice" '::notice::'

  fixture fp1 b1 fp1 b1; echo '{"expo":{}}' > "$MOBILE/app.json"; run "$platform"
  expect_calls "no EAS project id yet: skips, green, calling nothing" 0 "no:eas " "no:npx "
  with_project

  fixture fp1 b1 fp1 b1; rm "$MOBILE/eas.json"; run "$platform"
  expect_calls "a tag from before phase 32 (no eas.json): skips, green" 0 "no:eas " "no:npx "
  with_project

  # Review finding: a rerun after a reverted native change whose submit failed.
  # The runtime's newest update was published for an older build of the same
  # runtime, so it proves nothing about the newest build: submit it.
  fixture fp1 b3 fp1 b1; run "$platform"
  expect_calls "an update for an older build of the same runtime does not count: submits the newest" 0 \
    "yes:eas submit --platform $platform --profile production --id b3 --wait" "yes:--message v2026.10.11.1 for build b3"

  fixture "" b1 fp1 b1; run "$platform"
  expect_calls "no fingerprint: fails before asking EAS anything" 1 "no:eas "
done

echo
echo "ios only"

# The App Store Connect app id: eas submit --non-interactive refuses to run without it.
fixture fp1 b1 fp1 b1; echo '{}' > "$MOBILE/eas.json"; run ios
expect_calls "no ascAppId in eas.json: skips, green, calling nothing" 0 "no:eas " "no:npx "
said "and the notice names it" 'ascAppId'
fixture fp1 b1 fp1 b1; run android
expect_calls "android does not need it" 0 "yes:eas update --branch production --platform android"
with_project

# TestFlight builds stop launching 90 days after upload; at 80 the release builds anew.
fixture fp1 b1 fp1 b1; export NOW="$(days_later 81)"; run ios
expect_calls "a matching build 81 days old: builds, submits and updates" 0 \
  "yes:eas build --platform ios --profile production --wait" "yes:eas submit --platform ios --profile production --id b-new" \
  "yes:--message v2026.10.11.1 for build b-new"

fixture fp1 b1 fp1 b1; export NOW="$(days_later 79)"; run ios
expect_calls "a matching build 79 days old: updates only" 0 \
  "yes:eas update --branch production --platform ios" "no:eas build " "no:eas submit"

fixture fp1 b1 fp1 b1; export NOW="$(days_later 81)"; run ios --rollback
expect_calls "a rollback with an 81-day-old build still never builds, and updates" 0 \
  "yes:eas update --branch production --platform ios" "no:eas build " "no:eas submit"
said "and warns that a release forward is due" '::warning::'

fixture fp1 b1 fp1 b1; export NOW="$(days_later 81)" CREATED=''; run ios
expect_calls "a build with no createdAt is not treated as old" 0 \
  "yes:eas update --branch production --platform ios" "no:eas build "

fixture fp1 b1 fp1 b1; export NOW="$(days_later 81)"; run android
expect_calls "android builds never expire: 81 days old still updates only" 0 \
  "yes:eas update --branch production --platform android" "no:eas build "

# Final review: every case above fixes NOW, so production's default needs its own.
fixture fp1 b1 fp1 b1; unset NOW; run ios
expect_calls "NOW unset: the clock is read (a build from 2026-01-01 is long past 80 days)" 0 \
  "yes:eas build --platform ios --profile production --wait"

# A new iOS build reaches external testers only once it is in their group.
fixture fp2 b1 fp1 b1; run ios
said "a new iOS build: a notice says to add it to TestFlight's Friends group" '::notice::.*b-new.*Friends'
fixture fp1 b1 fp1 b1; export NOW="$(days_later 81)"; run ios
said "and so does the 80-day rebuild, which nobody asked for" '::notice::.*b-new.*Friends'
fixture fp1 b1 fp1 b1; run ios
if grep -q 'Friends' "$OUT"; then fail "an update alone says nothing about the group" "$(cat "$OUT")"
else ok "an update alone says nothing about the group"; fi
fixture fp2 b1 fp1 b1; run android
if grep -q 'Friends' "$OUT"; then fail "android has no such group" "$(cat "$OUT")"
else ok "android has no such group"; fi

echo
echo "arguments"

fixture fp1 b1 fp1 b1; run
expect_calls "no platform: fails, calling nothing" 2 "no:eas " "no:npx "
fixture fp1 b1 fp1 b1; run windows
expect_calls "an unknown platform: fails, calling nothing" 2 "no:eas " "no:npx "

echo
if [ "$status" -ne 0 ]; then
  echo "native-release.sh FAILED ($checks checks)" >&2
else
  echo "native-release.sh ok ($checks checks)"
fi
exit "$status"
