#!/usr/bin/env bash
#
# Decides whether a commit's CI allows a release (phase 30, spec D6). Reads the
# commit's latest check runs as JSON on stdin:
#
#   [{"name": "test-unit", "status": "completed", "conclusion": "success"}, ...]
#
# Prints one word: `ok` (exit 0), `pending` (exit 3) or `failed` (exit 1), with
# the reason on stderr. A failure wins over a job still running.
#
# test-eval is deliberately not required: it calls a third party and can go red
# with nothing wrong in the commit (CLAUDE.md), and a model update must not block
# a release. Its result is still on the commit for anyone who wants it.

set -u

REQUIRED="check-adrs check-types test-unit test-integration test-e2e build-image terraform-plan"

runs=$(cat)
pending=""
failed=""

for name in $REQUIRED; do
  run=$(printf '%s' "$runs" | jq -c --arg n "$name" '[.[] | select(.name == $n)] | first // empty')
  if [ -z "$run" ]; then
    pending="$pending $name"
    continue
  fi
  state=$(printf '%s' "$run" | jq -r '.status')
  conclusion=$(printf '%s' "$run" | jq -r '.conclusion // ""')
  if [ "$state" != completed ]; then
    pending="$pending $name"
  elif [ "$conclusion" != success ]; then
    failed="$failed $name($conclusion)"
  fi
done

if [ -n "$failed" ]; then
  echo failed
  echo "release-guard: CI did not pass:$failed" >&2
  exit 1
fi
if [ -n "$pending" ]; then
  echo pending
  echo "release-guard: still waiting on:$pending" >&2
  exit 3
fi
echo ok
