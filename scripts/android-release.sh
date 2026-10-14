#!/usr/bin/env bash
#
# Phase 32 (spec D5–D7). Ships the Android app for one release tag: an
# over-the-air update when the tag's native layer matches the build friends
# already have, a new Play build when it does not. Run by release.yml's
# android job, after the server answers /health with the tag, from the tag's
# checkout.
#
#   scripts/android-release.sh              a release
#   scripts/android-release.sh --rollback   a rollback: never builds
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
#                                   marker that the build reached Play, so a rerun
#                                   after a failed submit submits again; each
#                                   message names its build, because after a
#                                   reverted native change an older build of the
#                                   same runtime has updates of its own)
#   different, a release            eas build, eas submit, eas update
#   different, a rollback           nothing: Play cannot downgrade an app
#
# Env: TAG (the release tag); ANDROID_RELEASE, the repository variable that
# turns Android releases on (only the exact value "on" ships); EXPO_TOKEN;
# MOBILE_DIR (default apps/mobile; the test points it at a fixture).

set -euo pipefail

rollback=0
[ "${1:-}" = --rollback ] && rollback=1
: "${TAG:?TAG must name the release tag}"

cd "$(dirname "$0")/.."
MOBILE_DIR=${MOBILE_DIR:-apps/mobile}
# Phase 49 (spec D2). The tag's commit, inlined beside the tag for the About screen.
commit=$(git rev-parse --short=7 HEAD)

if [ ! -f "$MOBILE_DIR/eas.json" ]; then
  echo "::notice::$TAG predates the Android release (no eas.json): nothing to ship."
  exit 0
fi
if [ "${ANDROID_RELEASE:-}" != on ]; then
  echo "::notice::Android releases are off: the repository variable ANDROID_RELEASE is '${ANDROID_RELEASE:-}', not 'on' (docs/runbooks/android.md). Skipped."
  exit 0
fi
if [ -z "${EXPO_TOKEN:-}" ]; then
  echo "::notice::No EXPO_TOKEN secret: the Android release is not set up yet (README, Android app). Skipped."
  exit 0
fi
if ! jq -e '.expo.extra.eas.projectId // empty' "$MOBILE_DIR/app.json" > /dev/null; then
  echo "::notice::app.json has no EAS project id: run eas init (README, Android app). Skipped."
  exit 0
fi

cd "$MOBILE_DIR"

# npm prints its notices on the same stream in some setups; the JSON is the one
# line that starts with a brace.
fp=$(npx expo-updates fingerprint:generate --platform android 2> /dev/null | grep '^{' | jq -r '.hash // empty')
if [ -z "$fp" ]; then
  echo "::error::Could not compute the Android fingerprint."
  exit 1
fi

newest=$(eas build:list --platform android --build-profile production --status finished --limit 1 --json --non-interactive)
newest_id=$(jq -r '.[0].id // empty' <<< "$newest")
newest_runtime=$(jq -r '.[0].runtime.version // empty' <<< "$newest")
echo "fingerprint $fp; newest build ${newest_id:-none} (runtime ${newest_runtime:-none})"

# Whether the runtime's newest update on production was published for this build.
update_names_build() {
  eas update:list --branch production --runtime-version "$fp" --limit 1 --json --non-interactive \
    | jq -e --arg marker "for build $1" '(.currentPage // [])[0].message // "" | contains($marker)' > /dev/null
}
submit() {
  eas submit --platform android --profile production --id "$1" --wait --non-interactive
}
publish() { # publish <the build it targets>
  EXPO_PUBLIC_APP_VERSION="$TAG" EXPO_PUBLIC_APP_COMMIT="$commit" eas update --branch production --platform android \
    --environment production --message "$TAG for build $1" --non-interactive
}

if [ "$fp" = "$newest_runtime" ]; then
  if update_names_build "$newest_id"; then
    echo "Same native layer as build $newest_id: publishing $TAG over the air."
  else
    echo "Build $newest_id has no update yet, so it never reached Play: submitting it first."
    submit "$newest_id"
  fi
  publish "$newest_id"
elif [ "$rollback" = 1 ]; then
  echo "::warning::$TAG's native layer differs from the build on Play ($newest_id), and Play cannot downgrade an installed app. Nothing was published: phones keep the newer app against the older server. If that is broken, release a fix forward."
else
  echo "The native layer changed: building, submitting to the internal track, then publishing $TAG."
  build_id=$(eas build --platform android --profile production --wait --json --non-interactive | jq -r '.[0].id // empty')
  if [ -z "$build_id" ]; then
    echo "::error::eas build returned no build id."
    exit 1
  fi
  submit "$build_id"
  publish "$build_id"
fi
