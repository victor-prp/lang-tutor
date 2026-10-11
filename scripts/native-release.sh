#!/usr/bin/env bash
#
# Phase 32 (spec D5–D7), phase 36 (spec D3–D5). Ships one native app for one
# release tag: an over-the-air update when the tag's native layer matches the
# build friends already have, a new store build when it does not. Run by
# release.yml's android and ios jobs, after the server answers /health with
# the tag, from the tag's checkout.
#
#   scripts/native-release.sh <android|ios>              a release
#   scripts/native-release.sh <android|ios> --rollback   a rollback: never builds
#
# The runtime version is the fingerprint (app.json), so an update reaches only
# builds with the same native layer. The decision compares the tag's
# fingerprint with the NEWEST finished build's, not with any build's:
# reverting a native change must build again, because no phone still runs the
# older build an update would target.
#
#   same, update published for it   eas update
#   same, no update for it yet      eas submit that build, then eas update
#                                   (the update after a successful submit is the
#                                   marker that the build reached the store, so a
#                                   rerun after a failed submit submits again; each
#                                   message names its build, because after a
#                                   reverted native change an older build of the
#                                   same runtime has updates of its own)
#   different, a release            eas build, eas submit, eas update
#   different, a rollback           nothing: no store downgrades an installed app
#
# What differs by platform:
#
#                    android                 ios
#   switch           ANDROID_RELEASE         IOS_RELEASE
#   setup check      -                       submit.production.ios.ascAppId in eas.json
#   builds go to     Play's internal track   TestFlight
#   too old          never                   80 days: a TestFlight build stops
#                                            launching at 90, and an update does
#                                            not reset that, so a release builds
#                                            anew (a rollback only warns)
#
# Env: TAG (the release tag); the platform's switch, a repository variable
# (only the exact value "on" ships); EXPO_TOKEN; MOBILE_DIR (default
# apps/mobile; the test points it at a fixture); NOW (epoch seconds, default
# the clock; the test fixes it).

set -euo pipefail

platform=${1:-}
case "$platform" in
  android) switch_var=ANDROID_RELEASE store="Play's internal track" max_age_days= runbook=android ;;
  ios) switch_var=IOS_RELEASE store=TestFlight max_age_days=80 runbook=ios ;;
  *)
    echo "::error::usage: native-release.sh <android|ios> [--rollback]"
    exit 2 ;;
esac
rollback=0
[ "${2:-}" = --rollback ] && rollback=1
: "${TAG:?TAG must name the release tag}"

cd "$(dirname "$0")/.."
MOBILE_DIR=${MOBILE_DIR:-apps/mobile}

if [ ! -f "$MOBILE_DIR/eas.json" ]; then
  echo "::notice::$TAG predates the native release (no eas.json): nothing to ship."
  exit 0
fi
if [ "${!switch_var:-}" != on ]; then
  echo "::notice::$platform releases are off: the repository variable $switch_var is '${!switch_var:-}', not 'on' (docs/runbooks/$runbook.md). Skipped."
  exit 0
fi
if [ -z "${EXPO_TOKEN:-}" ]; then
  echo "::notice::No EXPO_TOKEN secret: the $platform release is not set up yet (docs/runbooks/$runbook.md). Skipped."
  exit 0
fi
if ! jq -e '.expo.extra.eas.projectId // empty' "$MOBILE_DIR/app.json" > /dev/null; then
  echo "::notice::app.json has no EAS project id: run eas init (docs/runbooks/$runbook.md). Skipped."
  exit 0
fi
if [ "$platform" = ios ] && ! jq -e '.submit.production.ios.ascAppId // empty' "$MOBILE_DIR/eas.json" > /dev/null; then
  echo "::notice::eas.json has no submit.production.ios.ascAppId, the App Store Connect app id: the iOS release is not set up yet (docs/runbooks/ios.md). Skipped."
  exit 0
fi

cd "$MOBILE_DIR"

# npm prints its notices on the same stream in some setups; the JSON is the one
# line that starts with a brace.
fp=$(npx expo-updates fingerprint:generate --platform "$platform" 2> /dev/null | grep '^{' | jq -r '.hash // empty')
if [ -z "$fp" ]; then
  echo "::error::Could not compute the $platform fingerprint."
  exit 1
fi

newest=$(eas build:list --platform "$platform" --build-profile production --status finished --limit 1 --json --non-interactive)
newest_id=$(jq -r '.[0].id // empty' <<< "$newest")
newest_runtime=$(jq -r '.[0].runtime.version // empty' <<< "$newest")
echo "fingerprint $fp; newest build ${newest_id:-none} (runtime ${newest_runtime:-none})"

# Whether the newest build is past its platform's age limit. No limit, or no
# readable createdAt, is never too old: an unknown age must not cost a build.
too_old=false
if [ -n "$max_age_days" ]; then
  too_old=$(jq -r --argjson now "${NOW:-$(date +%s)}" --argjson days "$max_age_days" '
    (.[0].createdAt // "" | sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch null) as $t
    | if $t == null then false else ($now - $t) > ($days * 86400) end' <<< "$newest")
fi

# Whether the runtime's newest update on production was published for this build.
update_names_build() {
  eas update:list --branch production --runtime-version "$fp" --limit 1 --json --non-interactive \
    | jq -e --arg marker "for build $1" '(.currentPage // [])[0].message // "" | contains($marker)' > /dev/null
}
submit() {
  eas submit --platform "$platform" --profile production --id "$1" --wait --non-interactive
}
publish() { # publish <the build it targets>
  EXPO_PUBLIC_APP_VERSION="$TAG" eas update --branch production --platform "$platform" \
    --environment production --message "$TAG for build $1" --non-interactive
}
build_submit_publish() {
  build_id=$(eas build --platform "$platform" --profile production --wait --json --non-interactive | jq -r '.[0].id // empty')
  if [ -z "$build_id" ]; then
    echo "::error::eas build returned no build id."
    exit 1
  fi
  submit "$build_id"
  publish "$build_id"
  if [ "$platform" = ios ]; then
    echo "::notice::New iOS build $build_id is on TestFlight. External testers get it only once it is in their group: TestFlight → Friends → Builds → + (docs/runbooks/ios.md)."
  fi
}

if [ "$fp" = "$newest_runtime" ] && [ "$too_old" = true ] && [ "$rollback" = 0 ]; then
  echo "Build $newest_id is more than $max_age_days days old and TestFlight expires it at 90: building anew, submitting to $store, then publishing $TAG."
  build_submit_publish
elif [ "$fp" = "$newest_runtime" ]; then
  if update_names_build "$newest_id"; then
    echo "Same native layer as build $newest_id: publishing $TAG over the air."
  else
    echo "Build $newest_id has no update yet, so it never reached $store: submitting it first."
    submit "$newest_id"
  fi
  publish "$newest_id"
  if [ "$too_old" = true ]; then
    echo "::warning::Build $newest_id is more than $max_age_days days old, and TestFlight stops it launching at 90 days. A rollback never builds: release forward soon so a new build replaces it."
  fi
elif [ "$rollback" = 1 ]; then
  echo "::warning::$TAG's native layer differs from the build on $store ($newest_id), and no store downgrades an installed app. Nothing was published: phones keep the newer app against the older server. If that is broken, release a fix forward."
else
  echo "The native layer changed: building, submitting to $store, then publishing $TAG."
  build_submit_publish
fi
