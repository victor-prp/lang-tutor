#!/usr/bin/env bash
#
# `npm run mobile:prod`: Expo Go on a phone against the hosted server (phase 30,
# spec D3). Production mode reads apps/mobile/.env.production, which names
# https://app.wordspal.ai. Two things would silently beat that file, and both
# point the phone at a laptop instead, a test that looks like it passed:
#
#   1. The shell. scripts/lane-env.sh exports EXPO_PUBLIC_API_URL for this lane,
#      and Expo keeps a variable the shell already set instead of reading the
#      file. So it is unset below, just before Expo starts.
#   2. A .env.local or .env.production.local that sets the URL. Expo ranks both
#      above .env.production. This script refuses to start rather than guess.
#
# --check-only runs the refusal and exits. MOBILE_DIR, defaulting to this
# checkout's app, exists for scripts/test-mobile-prod.sh.

set -u

cd "$(dirname "$0")/.." || exit 1
MOBILE_DIR="${MOBILE_DIR:-apps/mobile}"

blocked=""
for file in .env.local .env.production.local; do
  if [ -f "$MOBILE_DIR/$file" ] &&
    grep -qE '^[[:space:]]*(export[[:space:]]+)?EXPO_PUBLIC_API_URL=' "$MOBILE_DIR/$file"; then
    blocked="$blocked $MOBILE_DIR/$file"
  fi
done

if [ -n "$blocked" ]; then
  echo "mobile:prod refused: EXPO_PUBLIC_API_URL is set in:$blocked" >&2
  echo "Expo ranks that file above .env.production, so the phone would reach a laptop," >&2
  echo "not production. The lane's URL belongs in apps/mobile/.env.development.local;" >&2
  echo "./scripts/setup-worktree.sh moves an old .env.local there." >&2
  exit 1
fi

[ "${1:-}" = "--check-only" ] && exit 0

unset EXPO_PUBLIC_API_URL
exec npm run start:prod --workspace apps/mobile
