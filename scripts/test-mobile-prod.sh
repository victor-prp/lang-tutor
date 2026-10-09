#!/usr/bin/env bash
#
# Tests scripts/mobile-prod.sh's refusal (phase 30) against throwaway app
# directories. No Expo, no network: --check-only stops before Expo starts.

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT

status=0
checks=0

expect() { # expect <label> <pass|refuse> <dir>
  local label="$1" want="$2" dir="$3" got
  checks=$((checks + 1))
  if MOBILE_DIR="$dir" bash "$REPO/scripts/mobile-prod.sh" --check-only > /dev/null 2>&1; then
    got=pass
  else
    got=refuse
  fi
  if [ "$got" = "$want" ]; then
    printf '  ok         %s\n' "$label"
  else
    printf '\n  FAIL       %s (expected %s, got %s)\n' "$label" "$want" "$got" >&2
    status=1
  fi
}

app() { mkdir -p "$FIXTURE/$1"; printf '%s\n' "$FIXTURE/$1"; }

echo "Testing scripts/mobile-prod.sh"
echo

d=$(app clean)
expect "no local env file starts" pass "$d"

d=$(app dev); printf 'EXPO_PUBLIC_API_URL=http://192.168.1.5:4999\n' > "$d/.env.development.local"
expect "the lane URL in .env.development.local starts" pass "$d"

d=$(app legacy); printf 'EXPO_PUBLIC_API_URL=http://192.168.1.5:4999\n' > "$d/.env.local"
expect "an old .env.local that sets the URL is refused" refuse "$d"

d=$(app exported); printf 'export EXPO_PUBLIC_API_URL=http://192.168.1.5:4999\n' > "$d/.env.local"
expect "an exported URL in .env.local is refused" refuse "$d"

d=$(app prodlocal); printf 'EXPO_PUBLIC_API_URL=http://192.168.1.5:4999\n' > "$d/.env.production.local"
expect "a .env.production.local that sets the URL is refused" refuse "$d"

d=$(app other); printf 'SOMETHING_ELSE=1\n' > "$d/.env.local"
expect "a .env.local without the URL starts" pass "$d"

d=$(app commented); printf '# EXPO_PUBLIC_API_URL=http://192.168.1.5:4999\n' > "$d/.env.local"
expect "a commented-out URL starts" pass "$d"

echo
if [ "$status" -ne 0 ]; then
  echo "mobile-prod.sh FAILED ($checks checks)" >&2
else
  echo "mobile-prod.sh ok ($checks checks)"
fi
exit "$status"
