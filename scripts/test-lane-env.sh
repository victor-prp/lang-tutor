#!/usr/bin/env bash
#
# Tests scripts/lane-env.sh against a throwaway git repository with real
# worktrees. No database, no Docker, no npm install — the formula is pure text,
# and this is what lets CI run it in the dependency-free check-adrs job.
#
# The fixture repo gets a copy of scripts/ committed to it, so `git worktree
# add` brings lane-env.sh along exactly as it does in the real repo, and every
# invocation roots itself the same way production does (dirname "$0"/..).

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT

status=0
checks=0

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  checks=$((checks + 1))
  if [ "$expected" = "$actual" ]; then
    printf '  ok         %s\n' "$label"
  else
    printf '\n  FAIL       %s\n             expected: %s\n             actual:   %s\n' \
      "$label" "$expected" "$actual" >&2
    status=1
  fi
}

expect_fails() {
  local label="$1"; shift
  checks=$((checks + 1))
  if "$@" > /dev/null 2>&1; then
    printf '\n  FAIL       %s (the command succeeded; it must not)\n' "$label" >&2
    status=1
  else
    printf '  ok         %s\n' "$label"
  fi
}

# `lane-env.sh` with no arguments prints KEY=value; this pulls one out.
value_of() {
  local dir="$1" key="$2"
  (cd "$dir" && bash ./scripts/lane-env.sh 2>/dev/null) | sed -n "s/^$key=//p"
}

# --- the fixture -------------------------------------------------------------
MAIN="$FIXTURE/main"
mkdir -p "$MAIN"
git init -q -b master "$MAIN"
mkdir -p "$MAIN/scripts" "$MAIN/apps/mobile"
cp "$REPO/scripts/lane-env.sh" "$MAIN/scripts/lane-env.sh"
git -C "$MAIN" add -A
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -qm init

worktree() { # worktree <dir-name> <branch>
  git -C "$MAIN" worktree add -q -b "$2" "$FIXTURE/$1" master 2>/dev/null
  (cd "$FIXTURE/$1" && bash ./scripts/lane-env.sh --allocate > /dev/null)
}

echo "Testing scripts/lane-env.sh"
echo

# --- lane 0 ------------------------------------------------------------------
expect_eq "main checkout is lane main"            "main"       "$(value_of "$MAIN" LANE)"
expect_eq "main checkout is slot 0"               "0"          "$(value_of "$MAIN" LANE_SLOT)"
expect_eq "main checkout serves on 3001"          "3001"       "$(value_of "$MAIN" PORT)"
expect_eq "main checkout runs Metro on 8081"      "8081"       "$(value_of "$MAIN" METRO_PORT)"
expect_eq "main checkout e2e app is 8082"         "8082"       "$(value_of "$MAIN" E2E_APP_PORT)"
expect_eq "main checkout uses lang_tutor" \
  "postgres://postgres:postgres@localhost:5432/lang_tutor" "$(value_of "$MAIN" DATABASE_URL)"
expect_eq "main checkout e2e database" \
  "postgres://postgres:postgres@localhost:5432/lang_tutor_e2e" "$(value_of "$MAIN" E2E_DATABASE_URL)"
expect_eq "main checkout test prefix is bare"     "t_"         "$(value_of "$MAIN" TEST_DB_PREFIX)"
expect_eq "main checkout mock namespace"          "e2e"        "$(value_of "$MAIN" E2E_MOCK_NAMESPACE)"
expect_eq "MockServer is shared, not per lane" \
  "http://localhost:1080"                                      "$(value_of "$MAIN" MOCKSERVER_URL)"

# --- the first worktree ------------------------------------------------------
worktree wt1 feature
expect_eq "first worktree takes slot 1"           "1"          "$(value_of "$FIXTURE/wt1" LANE_SLOT)"
expect_eq "lane is named after the branch"        "feature"    "$(value_of "$FIXTURE/wt1" LANE)"
expect_eq "slot 1 serves on 4001"                 "4001"       "$(value_of "$FIXTURE/wt1" PORT)"
expect_eq "slot 1 runs Metro on 9081"             "9081"       "$(value_of "$FIXTURE/wt1" METRO_PORT)"
expect_eq "slot 1 e2e api is 4002" \
  "http://localhost:4002"                                      "$(value_of "$FIXTURE/wt1" E2E_API_URL)"
expect_eq "slot 1 e2e app is 9082" \
  "http://localhost:9082"                                      "$(value_of "$FIXTURE/wt1" E2E_APP_URL)"
expect_eq "slot 1 dev database" \
  "postgres://postgres:postgres@localhost:5432/lang_tutor_feature" \
  "$(value_of "$FIXTURE/wt1" DATABASE_URL)"
expect_eq "slot 1 e2e database" \
  "postgres://postgres:postgres@localhost:5432/lang_tutor_e2e_feature" \
  "$(value_of "$FIXTURE/wt1" E2E_DATABASE_URL)"
expect_eq "slot 1 test prefix"                    "t_feature_" "$(value_of "$FIXTURE/wt1" TEST_DB_PREFIX)"
expect_eq "slot 1 mock namespace"                 "e2e_feature" "$(value_of "$FIXTURE/wt1" E2E_MOCK_NAMESPACE)"
expect_eq "the app targets this lane's server" \
  "http://localhost:4001"                                      "$(value_of "$FIXTURE/wt1" EXPO_PUBLIC_API_URL)"

# --- allocation --------------------------------------------------------------
worktree wt2 second
expect_eq "the second worktree takes slot 2"      "2"          "$(value_of "$FIXTURE/wt2" LANE_SLOT)"
expect_eq "allocation is idempotent"              "2"          \
  "$(cd "$FIXTURE/wt2" && bash ./scripts/lane-env.sh --allocate)"

# A freed slot is reused: remove wt1 and the next worktree takes 1, not 3.
# The branch goes with it, which is both what a human does and what lets wt4
# below take a name under `feature/` — git cannot hold a ref and a directory of
# the same name at once.
git -C "$MAIN" worktree remove --force "$FIXTURE/wt1"
git -C "$MAIN" branch -q -D feature
worktree wt3 third
expect_eq "a freed slot is reused"                "1"          "$(value_of "$FIXTURE/wt3" LANE_SLOT)"

# --- names -------------------------------------------------------------------
worktree wt4 feature/a-very-long-branch-name-that-will-not-fit
long=$(value_of "$FIXTURE/wt4" LANE)
expect_eq "a long branch name is cut to 24"       "24"         "${#long}"
expect_eq "a long name keeps a readable head"     "feature_a_very_lo" "${long%_*}"
expect_eq "a long name ends in 6 hex" "yes" \
  "$(printf '%s' "$long" | grep -qE '_[0-9a-f]{6}$' && echo yes || echo no)"

worktree wt5 Feature/UPPER.and.dots
expect_eq "a name is slugged to [a-z0-9_]"        "feature_upper_and_dots" \
  "$(value_of "$FIXTURE/wt5" LANE)"

# --- refusals ----------------------------------------------------------------
# The slot is allocated first, deliberately: without a .lane file the derivation
# refuses one line earlier, for a different reason, and this check would pass
# whether or not the detached-HEAD branch exists at all.
git -C "$MAIN" worktree add -q --detach "$FIXTURE/wt6" master
(cd "$FIXTURE/wt6" && bash ./scripts/lane-env.sh --allocate > /dev/null)
expect_fails "a detached HEAD is refused" \
  env -C "$FIXTURE/wt6" bash ./scripts/lane-env.sh

worktree wt7 tmpl
expect_fails "the reserved name tmpl is refused" \
  env -C "$FIXTURE/wt7" bash ./scripts/lane-env.sh

worktree wt8 test
expect_fails "the reserved name test is refused" \
  env -C "$FIXTURE/wt8" bash ./scripts/lane-env.sh

# Fill every remaining slot, then ask for one more. Seven are taken at this point
# — wt2, wt3, wt4, wt5, wt6, wt7, wt8 — so two fills reach the cap of nine.
for n in 9 10; do worktree "wtfill$n" "fill$n"; done
git -C "$MAIN" worktree add -q -b overflow "$FIXTURE/wt_over" master
expect_fails "a tenth lane is refused" \
  env -C "$FIXTURE/wt_over" bash ./scripts/lane-env.sh --allocate

# --- the environment wins ----------------------------------------------------
expect_eq "a preset PORT is left alone"           "9999"       \
  "$(cd "$FIXTURE/wt3" && PORT=9999 bash ./scripts/lane-env.sh | sed -n 's/^PORT=//p')"
expect_eq "a preset DATABASE_URL is left alone"   "postgres://elsewhere/db" \
  "$(cd "$FIXTURE/wt3" && DATABASE_URL=postgres://elsewhere/db bash ./scripts/lane-env.sh \
     | sed -n 's/^DATABASE_URL=//p')"
expect_eq "LANE_API_HOST reaches the app url"     "http://192.168.1.50:4001" \
  "$(cd "$FIXTURE/wt3" && LANE_API_HOST=192.168.1.50 bash ./scripts/lane-env.sh \
     | sed -n 's/^EXPO_PUBLIC_API_URL=//p')"

# --- exec and export modes ---------------------------------------------------
expect_eq "it execs the command it wraps with the lane exported" "4001" \
  "$(cd "$FIXTURE/wt3" && bash ./scripts/lane-env.sh sh -c 'printf %s "$PORT"')"
expect_eq "--export is safe to eval" "4001" \
  "$(cd "$FIXTURE/wt3" && eval "$(bash ./scripts/lane-env.sh --export)" && printf %s "$PORT")"

echo
if [ "$status" -ne 0 ]; then
  echo "lane-env.sh FAILED ($checks checks)" >&2
else
  echo "lane-env.sh ok ($checks checks)"
fi
exit "$status"
