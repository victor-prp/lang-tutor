#!/usr/bin/env bash
#
# Tests scripts/release-guard.sh (phase 30) against hand-written check-run lists.

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
status=0
checks=0

ALL="check-adrs check-types test-unit test-integration test-e2e build-image terraform-plan"

runs() { # runs <name:status:conclusion>... -> the JSON GitHub's API returns, trimmed
  local first=1
  printf '['
  for spec in "$@"; do
    IFS=: read -r name state conclusion <<< "$spec"
    [ "$first" = 1 ] || printf ','
    first=0
    if [ -n "$conclusion" ]; then
      printf '{"name":"%s","status":"%s","conclusion":"%s"}' "$name" "$state" "$conclusion"
    else
      printf '{"name":"%s","status":"%s","conclusion":null}' "$name" "$state"
    fi
  done
  printf ']'
}

all_passed() { for n in $ALL; do printf '%s:completed:success ' "$n"; done; }

expect() { # expect <label> <verdict> <runs json>
  local label="$1" want="$2" json="$3" got
  checks=$((checks + 1))
  got=$(printf '%s' "$json" | bash "$REPO/scripts/release-guard.sh" 2> /dev/null)
  if [ "$got" = "$want" ]; then
    printf '  ok         %s\n' "$label"
  else
    printf '\n  FAIL       %s (expected %s, got %s)\n' "$label" "$want" "$got" >&2
    status=1
  fi
}

echo "Testing scripts/release-guard.sh"
echo

# shellcheck disable=SC2046
expect "every required job passed" ok "$(runs $(all_passed))"
# shellcheck disable=SC2046
expect "a red test-eval alone does not block" ok "$(runs $(all_passed) test-eval:completed:failure)"
expect "a failed e2e run blocks" failed \
  "$(runs check-adrs:completed:success check-types:completed:success test-unit:completed:success \
          test-integration:completed:success test-e2e:completed:failure build-image:completed:success \
          terraform-plan:completed:success)"
expect "a skipped required job blocks" failed \
  "$(runs check-adrs:completed:skipped check-types:completed:success test-unit:completed:success \
          test-integration:completed:success test-e2e:completed:success build-image:completed:success \
          terraform-plan:completed:success)"
expect "a job still running means wait" pending \
  "$(runs check-adrs:completed:success check-types:completed:success test-unit:completed:success \
          test-integration:completed:success test-e2e:completed:success build-image:in_progress: \
          terraform-plan:completed:success)"
expect "a job not yet started means wait" pending \
  "$(runs check-adrs:completed:success check-types:completed:success test-unit:completed:success \
          test-integration:completed:success test-e2e:completed:success build-image:completed:success)"
expect "a failure wins over a job still running" failed \
  "$(runs check-adrs:completed:failure check-types:in_progress: test-unit:completed:success \
          test-integration:completed:success test-e2e:completed:success build-image:completed:success \
          terraform-plan:completed:success)"

echo
if [ "$status" -ne 0 ]; then
  echo "release-guard.sh FAILED ($checks checks)" >&2
else
  echo "release-guard.sh ok ($checks checks)"
fi
exit "$status"
