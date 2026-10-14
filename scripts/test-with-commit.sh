#!/usr/bin/env bash
#
# Tests scripts/with-commit.sh (phase 49, spec D2) in a throwaway repository:
# the commit is 7 characters, `-dirty` marks uncommitted changes, and a value
# already set (a release, the image) is never replaced.

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT

status=0
checks=0

expect() { # expect <label> <want> <got>
  checks=$((checks + 1))
  if [ "$2" = "$3" ]; then printf '  ok         %s\n' "$1"
  else printf '\n  FAIL       %s\n  wanted: %s\n  got:    %s\n' "$1" "$2" "$3" >&2; status=1; fi
}

# run <VAR> [env assignments...]: the value with-commit.sh hands its command.
run() {
  local var="$1"; shift
  (cd "$FIXTURE" && env -u APP_COMMIT -u EXPO_PUBLIC_APP_COMMIT "$@" \
    bash "$REPO/scripts/with-commit.sh" printenv "$var")
}

cd "$FIXTURE" || exit 1
git init -q
git -c user.email=t@t -c user.name=t commit -q --allow-empty -m one
head=$(git rev-parse --short=7 HEAD)

echo "Testing scripts/with-commit.sh"
echo

expect "a clean tree: the 7-character commit" "$head" "$(run APP_COMMIT)"
expect "the app's bundle gets the same value" "$head" "$(run EXPO_PUBLIC_APP_COMMIT)"

echo change > file
expect "an untracked file marks the tree dirty" "$head-dirty" "$(run APP_COMMIT)"

expect "a commit already set is kept" "a3f9c21" "$(run APP_COMMIT APP_COMMIT=a3f9c21)"
expect "and reaches the bundle too" "a3f9c21" "$(run EXPO_PUBLIC_APP_COMMIT APP_COMMIT=a3f9c21)"

rm -rf .git
expect "outside a repository: unknown" "unknown" "$(run APP_COMMIT)"

echo
if [ "$status" -ne 0 ]; then
  echo "with-commit.sh FAILED ($checks checks)" >&2
  exit 1
fi
echo "with-commit.sh ok ($checks checks)"
