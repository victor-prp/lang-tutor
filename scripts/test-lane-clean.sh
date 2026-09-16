#!/usr/bin/env bash
#
# Tests scripts/lane-clean.sh against a throwaway git repository with real
# worktrees in every state the script has to tell apart: merged, unmerged, and
# locked. No database, no Docker, no npm install — the decisions are pure git,
# and this is what lets CI run it in the dependency-free check-adrs job.
#
# The decisions are what is tested, not the removals: lane-clean.sh prints its
# plan and changes nothing unless it is given --yes, so the plan IS the
# assertable surface. That is also why --yes is not the default — a script that
# drops databases and deletes worktrees should say what it intends first.

set -u

REPO=$(cd "$(dirname "$0")/.." && pwd -P)
FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT

status=0
checks=0

expect_contains() {
  local label="$1" needle="$2" hay="$3"
  checks=$((checks + 1))
  if printf '%s' "$hay" | grep -qF -- "$needle"; then
    printf '  ok         %s\n' "$label"
  else
    printf '\n  FAIL       %s\n             expected to find: %s\n             in:\n%s\n' \
      "$label" "$needle" "$hay" >&2
    status=1
  fi
}

expect_absent() {
  local label="$1" needle="$2" hay="$3"
  checks=$((checks + 1))
  if printf '%s' "$hay" | grep -qF -- "$needle"; then
    printf '\n  FAIL       %s\n             did NOT expect: %s\n             in:\n%s\n' \
      "$label" "$needle" "$hay" >&2
    status=1
  else
    printf '  ok         %s\n' "$label"
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

# --- the fixture -------------------------------------------------------------
MAIN="$FIXTURE/main"
mkdir -p "$MAIN"
git init -q -b master "$MAIN"
mkdir -p "$MAIN/scripts"
cp "$REPO/scripts/lane-clean.sh" "$MAIN/scripts/lane-clean.sh"
cp "$REPO/scripts/lane-env.sh" "$MAIN/scripts/lane-env.sh"
# As in the real repo: without this the fixture commits each worktree's .lane and
# the untracked-files check below would see every worktree as dirty.
printf '.lane\n' > "$MAIN/.gitignore"
git -C "$MAIN" add -A
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -qm init

# A worktree whose branch did some work and has since been merged: the one case
# to clean. The commit matters — a branch that never diverged is trivially an
# ancestor of master, which is a different state entirely (see `fresh` below).
# --no-ff because that is what merging a pull request produces, and a
# fast-forward would leave master's tip identical to the branch's.
git -C "$MAIN" worktree add -q -b done "$FIXTURE/done" master
(cd "$FIXTURE/done" && bash ./scripts/lane-env.sh --allocate > /dev/null)
echo done > "$FIXTURE/done/done.txt"
git -C "$FIXTURE/done" add -A
git -C "$FIXTURE/done" -c user.email=t@t -c user.name=t commit -qm shipped
git -C "$MAIN" -c user.email=t@t -c user.name=t merge -q --no-ff -m "merge done" done

# A worktree carrying a commit master does not have: work in progress.
git -C "$MAIN" worktree add -q -b wip "$FIXTURE/wip" master
(cd "$FIXTURE/wip" && bash ./scripts/lane-env.sh --allocate > /dev/null)
echo change > "$FIXTURE/wip/file.txt"
git -C "$FIXTURE/wip" add -A
git -C "$FIXTURE/wip" -c user.email=t@t -c user.name=t commit -qm wip

# Merged, but locked — a live session holds it.
git -C "$MAIN" worktree add -q -b busy "$FIXTURE/busy" master
(cd "$FIXTURE/busy" && bash ./scripts/lane-env.sh --allocate > /dev/null)
git -C "$MAIN" worktree lock --reason "claude session busy (pid 4242)" "$FIXTURE/busy"

# Merged, but someone left uncommitted work in it. Removal must not be attempted:
# lane:down runs before the removal, so attempting it would drop the databases of
# a worktree that then survives.
git -C "$MAIN" worktree add -q -b dirty "$FIXTURE/dirty" master
(cd "$FIXTURE/dirty" && bash ./scripts/lane-env.sh --allocate > /dev/null)
echo dirty > "$FIXTURE/dirty/dirty.txt"
git -C "$FIXTURE/dirty" add -A
git -C "$FIXTURE/dirty" -c user.email=t@t -c user.name=t commit -qm dirty
git -C "$MAIN" -c user.email=t@t -c user.name=t merge -q --no-ff -m "merge dirty" dirty
echo scratch > "$FIXTURE/dirty/scratch.txt"

# Brand new: a branch with no commits of its own. Trivially an ancestor of
# master, which is exactly why "is it merged?" cannot be the whole question —
# this is a lane somebody just made, possibly with uncommitted work in it.
git -C "$MAIN" worktree add -q -b fresh "$FIXTURE/fresh" master
(cd "$FIXTURE/fresh" && bash ./scripts/lane-env.sh --allocate > /dev/null)

echo "Testing scripts/lane-clean.sh"
echo

plan=$(cd "$MAIN" && bash ./scripts/lane-clean.sh 2>&1)

# --- what it decides ---------------------------------------------------------
expect_contains "a merged worktree is planned for cleaning"  "clean      done"   "$plan"
expect_contains "an unmerged worktree is skipped"            "skip       wip"    "$plan"
expect_contains "and says why"                               "not merged"        "$plan"
expect_contains "a locked worktree is skipped"               "skip       busy"   "$plan"
expect_contains "and says why"                               "locked"            "$plan"
expect_contains "and names who holds it"                     "pid 4242"          "$plan"
expect_contains "a merged worktree with uncommitted work is skipped" "skip       dirty" "$plan"
expect_contains "and says why"                               "uncommitted or untracked" "$plan"
expect_contains "a branch with no commits yet is skipped"    "skip       fresh"  "$plan"
expect_contains "and says why"                               "no commits of its own" "$plan"

# The main checkout is never a candidate: you cannot remove the tree you are in,
# and lane 0 is not a lane that gets retired.
expect_absent   "the main checkout is never cleaned"         "clean      master" "$plan"

# --- it changes nothing without --yes ----------------------------------------
checks=$((checks + 1))
if [ -d "$FIXTURE/done" ] && git -C "$MAIN" show-ref -q --verify refs/heads/done; then
  printf '  ok         a plan alone removes nothing\n'
else
  printf '\n  FAIL       a plan alone removes nothing (the worktree or branch is gone)\n' >&2
  status=1
fi

# --- refusals ----------------------------------------------------------------
expect_fails "it refuses to run from a worktree" \
  env -C "$FIXTURE/done" bash ./scripts/lane-clean.sh

echo
if [ "$status" -ne 0 ]; then
  echo "lane-clean.sh FAILED ($checks checks)" >&2
else
  echo "lane-clean.sh ok ($checks checks)"
fi
exit "$status"
