#!/usr/bin/env bash
#
# The lane formula, and the only place it lives.
#
# A "lane" is a checkout together with everything it needs to run alone: ports,
# databases, a MockServer namespace, a test-database prefix. The main checkout
# is lane 0 and every value below is what it has always used, so an unset
# environment behaves exactly as this repo did before lanes existed.
#
# Three modes:
#   lane-env.sh                 print KEY=value lines (the hook and humans read this)
#   lane-env.sh --export        print KEY='value' lines, safe to eval
#   lane-env.sh --allocate      claim the lowest free slot, write .lane, print it
#   lane-env.sh <command...>    export everything and exec the command
#
# Anything already set in the environment WINS over the derived value. That is
# what keeps CI, nightly-qa/ and a one-off override working without knowing this
# file exists.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$ROOT" || exit 1

fail() { echo "lane-env.sh: $1" >&2; exit 1; }

# --- which checkout is this? -------------------------------------------------
# The main checkout is the one whose --git-common-dir resolves to itself. This
# is the same test setup-worktree.sh uses, and it is true whatever branch the
# main checkout happens to hold.
MAIN=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)/.." 2>/dev/null && pwd -P) \
  || fail "not a git repository"
IS_MAIN=0
[ "$ROOT" = "$MAIN" ] && IS_MAIN=1

MAX_SLOT=9

# --- slots -------------------------------------------------------------------
# Every worktree's .lane file, read through `git worktree list` so this works
# from any checkout and never guesses at directory layout.
claimed_slots() {
  git worktree list --porcelain \
    | sed -n 's/^worktree //p' \
    | while IFS= read -r dir; do
        [ "$dir" = "$MAIN" ] && continue
        [ "$dir" = "$ROOT" ] && continue
        [ -f "$dir/.lane" ] && cat "$dir/.lane"
      done
}

allocate_slot() {
  [ "$IS_MAIN" -eq 1 ] && fail "the main checkout is lane 0; it needs no .lane file"
  if [ -f .lane ]; then
    cat .lane
    return 0
  fi
  local taken slot
  taken=$(claimed_slots)
  for slot in $(seq 1 "$MAX_SLOT"); do
    if ! printf '%s\n' "$taken" | grep -qx "$slot"; then
      printf '%s\n' "$slot" > .lane
      printf '%s\n' "$slot"
      return 0
    fi
  done
  fail "all $MAX_SLOT lanes are in use. Free one with 'npm run lane:down' and 'git worktree remove'."
}

# Handled before the derivation below, and it has to be: a fresh worktree has no
# .lane file yet, which is precisely what the derivation refuses to run without.
if [ "${1:-}" = "--allocate" ]; then
  allocate_slot
  exit 0
fi

# --- the name ----------------------------------------------------------------
# [a-z0-9_] only, so every identifier derived from it is a legal Postgres
# identifier that needs no quoting, and every character is one byte — which is
# what makes the 24-character cap a byte budget as well.
slug_of() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/_/g' \
    | sed -E 's/^_+//; s/_+$//'
}

lane_name_of() {
  local branch="$1" slug hash
  slug=$(slug_of "$branch")
  [ -n "$slug" ] || fail "branch '$branch' slugs to nothing"
  if [ "${#slug}" -gt 24 ]; then
    # 17 + '_' + 6 = 24. The hash is of the FULL branch name, so two branches
    # sharing a 17-character head still get different lanes.
    hash=$(printf '%s' "$branch" | shasum | cut -c1-6)
    slug=$(printf '%s' "$slug" | cut -c1-17 | sed -E 's/_+$//')_$hash
  fi
  printf '%s' "$slug"
}

# --- derive ------------------------------------------------------------------
if [ "$IS_MAIN" -eq 1 ]; then
  LANE_SLOT=0
  LANE=main
  LANE_BRANCH=$(git branch --show-current)
else
  [ -f .lane ] || fail "no .lane file here. Run ./scripts/setup-worktree.sh first."
  LANE_SLOT=$(tr -d '[:space:]' < .lane)
  case "$LANE_SLOT" in
    ''|*[!0-9]*) fail ".lane does not contain a number" ;;
  esac
  [ "$LANE_SLOT" -ge 1 ] && [ "$LANE_SLOT" -le "$MAX_SLOT" ] \
    || fail ".lane holds $LANE_SLOT, which is outside 1..$MAX_SLOT"
  LANE_BRANCH=$(git branch --show-current)
  [ -n "$LANE_BRANCH" ] || fail "HEAD is detached; a lane takes its name from a branch"
  LANE=$(lane_name_of "$LANE_BRANCH")
  # `t_test_` and `t_tmpl_` are lane 0's own test-database prefixes; a lane
  # named test or tmpl would make its databases indistinguishable from them,
  # and lane 0's sweep would drop them.
  case "$LANE" in
    test|tmpl) fail "'$LANE' is reserved; rename the branch" ;;
  esac
fi

PG_HOST="${PGHOST:-localhost}"
PG_PORT="${PGPORT:-5432}"
pg_url() { printf 'postgres://postgres:postgres@%s:%s/%s' "$PG_HOST" "$PG_PORT" "$1"; }

if [ "$LANE_SLOT" -eq 0 ]; then
  d_db=lang_tutor
  d_e2e_db=lang_tutor_e2e
  d_prefix=t_
  d_ns=e2e
else
  d_db="lang_tutor_$LANE"
  d_e2e_db="lang_tutor_e2e_$LANE"
  d_prefix="t_${LANE}_"
  d_ns="e2e_$LANE"
fi

# A thousand per lane: easy to hold in your head, and no slot can reach
# nightly-qa's reserved 3101 and 8092.
d_port=$((3001 + 1000 * LANE_SLOT))
d_e2e_api_port=$((3002 + 1000 * LANE_SLOT))
d_metro_port=$((8081 + 1000 * LANE_SLOT))
d_e2e_app_port=$((8082 + 1000 * LANE_SLOT))

# The host a phone or simulator uses to reach this lane's server. Taken from the
# main checkout's .env.local so a LAN IP set once serves every lane; the port is
# always this lane's own.
api_host() {
  [ -n "${LANE_API_HOST:-}" ] && { printf '%s' "$LANE_API_HOST"; return; }
  local from_main
  from_main=$(sed -n 's#^EXPO_PUBLIC_API_URL=http://\([^:/]*\).*#\1#p' \
    "$MAIN/apps/mobile/.env.local" 2>/dev/null | head -1)
  printf '%s' "${from_main:-localhost}"
}
HOST=$(api_host)

LANE_ROOT="$ROOT"
PORT="${PORT:-$d_port}"
METRO_PORT="${METRO_PORT:-$d_metro_port}"
E2E_APP_PORT="${E2E_APP_PORT:-$d_e2e_app_port}"
DATABASE_URL="${DATABASE_URL:-$(pg_url "$d_db")}"
E2E_DATABASE_URL="${E2E_DATABASE_URL:-$(pg_url "$d_e2e_db")}"
E2E_API_URL="${E2E_API_URL:-http://localhost:$d_e2e_api_port}"
E2E_APP_URL="${E2E_APP_URL:-http://localhost:$E2E_APP_PORT}"
E2E_MOCK_NAMESPACE="${E2E_MOCK_NAMESPACE:-$d_ns}"
TEST_DB_PREFIX="${TEST_DB_PREFIX:-$d_prefix}"
EXPO_PUBLIC_API_URL="${EXPO_PUBLIC_API_URL:-http://$HOST:$PORT}"
# Shared by every lane and not derived from the slot — one container, namespaced
# per caller. It is here because this file is where an address is allowed to be
# written down, not because it varies.
MOCKSERVER_URL="${MOCKSERVER_URL:-http://localhost:1080}"

KEYS="LANE LANE_SLOT LANE_ROOT LANE_BRANCH PORT METRO_PORT DATABASE_URL \
E2E_API_URL E2E_APP_URL E2E_APP_PORT E2E_DATABASE_URL E2E_MOCK_NAMESPACE \
MOCKSERVER_URL TEST_DB_PREFIX EXPO_PUBLIC_API_URL"

case "${1:-}" in
  '')
    for key in $KEYS; do eval "printf '%s=%s\n' \"\$key\" \"\$$key\""; done
    ;;
  --export)
    # Single-quoted, with embedded quotes escaped the POSIX way, so a worktree
    # path containing a space survives `eval`.
    for key in $KEYS; do
      eval "value=\$$key"
      printf "export %s='%s'\n" "$key" "$(printf '%s' "$value" | sed "s/'/'\\\\''/g")"
    done
    ;;
  *)
    # shellcheck disable=SC2086
    export $KEYS
    exec "$@"
    ;;
esac
