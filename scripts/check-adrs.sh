#!/usr/bin/env bash
#
# Runs every ADR enforcement script and fails if any of them do. This is the
# one thing that should ever be wired into package.json, CI, or a hook —
# never an individual check-adr-*.sh, so that adding a new ADR's script does
# not also mean hunting down every caller of the old ones.
#
# Discovery is by naming convention, not a list maintained here:
# scripts/check-adr-*.sh, plus scripts/check-architecture.sh — ADR 0001's
# script predates the convention and keeps its historical name (see the
# create-adr skill). A new ADR's script is picked up automatically as long as
# it is named scripts/check-adr-NNNN-<slug>.sh; nothing here needs editing.
#
# Runs every script even if an earlier one fails: `&&` would stop at the
# first failure and hide every other ADR's result.

set -u
cd "$(dirname "$0")/.." || exit 1

status=0
ran=0

for script in scripts/check-architecture.sh scripts/check-adr-*.sh; do
  [ -e "$script" ] || continue
  ran=$((ran + 1))
  bash "$script"
  status=$((status | $?))
done

if [ "$ran" -eq 0 ]; then
  echo "check-adrs.sh found no ADR check scripts — expected at least check-architecture.sh" >&2
  exit 1
fi

exit "$status"
