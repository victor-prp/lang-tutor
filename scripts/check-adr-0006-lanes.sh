#!/usr/bin/env bash
#
# Enforces docs/adr/adr-0006-lanes.md.
#
# Each rule below is the command printed in that ADR's "How to detect a
# violation" section, verbatim. The two must stay in sync: the ADR is the
# explanation, this file is the enforcement, and a rule that lives in only one
# of them is a rule nobody is keeping.
#
# grep's exit codes run backwards from what this needs — a match means a
# VIOLATION, and finding nothing (exit 1) is the passing case — so nothing here
# relies on exit status, and `set -e` is deliberately absent.
#
# The three files excluded from R1 are excluded by exact name, never by
# directory: lane-env.sh IS the formula, test-lane-env.sh asserts the numbers it
# produces, and this script carries them in its own pattern. Excluding
# scripts/ wholesale would delete the rule.

set -u

cd "$(dirname "$0")/.." || exit 1

status=0

check() {
  rule="$1"
  fn="$2"
  output=$("$fn" 2>/dev/null)
  if [ -n "$output" ]; then
    printf '\n  VIOLATION  %s\n' "$rule" >&2
    printf '%s\n' "$output" | sed 's/^/             /' >&2
    status=1
  else
    printf '  ok         %s\n' "$rule"
  fi
}

OWNERS='^(scripts/lane-env\.sh|scripts/test-lane-env\.sh|scripts/check-adr-0006-lanes\.sh):'

# -w, not an explicit (^|[^0-9]) guard. BSD grep does not support an empty left
# alternative and silently matches nothing with that form, so on macOS the rule
# would print `ok` against a tree full of violations — a check that cannot fire
# looks exactly like a check that passes. Verified on both greps: -w reports
# `localhost:3001` and ignores `13001` and `33001`.
r1() {
  grep -rnwE "(3001|3002|8081|8082)" \
    e2e apps/server/tests scripts package.json \
    --include='*.ts' --include='*.sh' --include='*.json' 2>/dev/null \
    | grep -vE "$OWNERS"
}

# A string literal or a URL path, not the word in prose: a comment explaining
# that the e2e database is dropped every run is accurate documentation, not a
# hardcoded address. apps/server/tests/ is outside this rule — the lane tests
# name databases because naming them is their subject.
r2() {
  grep -rnE "['\"\`/]lang_tutor" e2e scripts package.json \
    --include='*.ts' --include='*.sh' --include='*.json' 2>/dev/null \
    | grep -vE "$OWNERS"
}

r3() {
  # db:down, lane:clean and lane:abandon are absent on purpose: all act on the
  # shared world from the main checkout rather than as a lane, so none of them
  # take lane values. The two lane commands delegate lane:down to the worktree
  # they are acting on, which is where the lane values are read.
  for key in server mobile e2e test:integration db:up db:migrate db:reseed \
             dict:export dict:restore lane:list lane:down; do
    line=$(grep -E "^    \"$key\": " package.json)
    if [ -z "$line" ]; then
      echo "\"$key\" is missing from package.json scripts"
      continue
    fi
    printf '%s' "$line" | grep -q 'lane-env.sh' || echo "$line"
  done
}

r4_addresses() {
  grep -nE '^export const (API_URL|APP_URL|MOCKSERVER_URL) =' e2e/urls.ts | grep -v requireEnv
}

r4_namespace() {
  grep -n 'E2E_MOCK_NAMESPACE = ' e2e/tests/support/mockServer.ts | grep -v requireEnv
}

r4_tmp() {
  grep -rn '/tmp/' scripts --include='*.sh' | grep -v 'mktemp'
}

echo "Checking the tree against ADR 0006 (lanes)"
echo

check "R1  no lane-0 port literal outside the owners"               r1
check "R2  no lane-0 database name outside the owners"              r2
check "R3  every start-or-test script runs through the wrapper"     r3
check "R4  the e2e addresses come from the environment"             r4_addresses
check "R4  the e2e MockServer namespace comes from the environment" r4_namespace
check "R4  no hardcoded temp path in scripts/"                      r4_tmp

echo
if [ "$status" -ne 0 ]; then
  echo "ADR 0006 violations found. See docs/adr/adr-0006-lanes.md." >&2
fi

exit "$status"
