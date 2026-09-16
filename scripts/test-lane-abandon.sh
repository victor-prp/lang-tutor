#!/usr/bin/env bash
#
# Tests scripts/lane-abandon.sh against a throwaway git repository. No database,
# no Docker, no npm install.
#
# abandon is the counterpart to clean, and the tests are shaped by what makes it
# different: clean protects unfinished work and takes no target, abandon destroys
# unfinished work and takes exactly one. So what is asserted here is mostly what
# it REFUSES, and that its report names the work it is about to delete — because
# that report is the only thing standing between a tired human and a lost day.

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

MAIN="$FIXTURE/main"
mkdir -p "$MAIN"
git init -q -b master "$MAIN"
mkdir -p "$MAIN/scripts"
cp "$REPO/scripts/lane-abandon.sh" "$MAIN/scripts/lane-abandon.sh"
cp "$REPO/scripts/lane-env.sh" "$MAIN/scripts/lane-env.sh"
printf '.lane\n' > "$MAIN/.gitignore"
git -C "$MAIN" add -A
git -C "$MAIN" -c user.email=t@t -c user.name=t commit -qm init

# The lane being given up on: a commit master does not have, and uncommitted work
# on top. Exactly what clean refuses to touch.
git -C "$MAIN" worktree add -q -b giveup "$FIXTURE/giveup" master
(cd "$FIXTURE/giveup" && bash ./scripts/lane-env.sh --allocate > /dev/null)
echo half > "$FIXTURE/giveup/half.txt"
git -C "$FIXTURE/giveup" add -A
git -C "$FIXTURE/giveup" -c user.email=t@t -c user.name=t commit -qm "half a feature"
echo scratch > "$FIXTURE/giveup/scratch.txt"

# Someone else's live session.
git -C "$MAIN" worktree add -q -b held "$FIXTURE/held" master
(cd "$FIXTURE/held" && bash ./scripts/lane-env.sh --allocate > /dev/null)
git -C "$MAIN" worktree lock --reason "claude session held (pid 4242)" "$FIXTURE/held"

echo "Testing scripts/lane-abandon.sh"
echo

report=$(cd "$MAIN" && bash ./scripts/lane-abandon.sh giveup 2>&1)

# --- the damage report -------------------------------------------------------
expect_contains "names the branch it would destroy"      "giveup"          "$report"
expect_contains "names the commits that would be lost"   "half a feature"  "$report"
expect_contains "names the uncommitted work"             "scratch.txt"     "$report"
expect_contains "says it has not done anything yet"      "--yes"           "$report"

checks=$((checks + 1))
if [ -d "$FIXTURE/giveup" ] && git -C "$MAIN" show-ref -q --verify refs/heads/giveup; then
  printf '  ok         a report alone destroys nothing\n'
else
  printf '\n  FAIL       a report alone destroys nothing\n' >&2
  status=1
fi

# --- refusals ----------------------------------------------------------------
expect_fails "refuses with no target named" \
  env -C "$MAIN" bash ./scripts/lane-abandon.sh

expect_fails "refuses a name it cannot find" \
  env -C "$MAIN" bash ./scripts/lane-abandon.sh no-such-lane

expect_fails "refuses a locked worktree" \
  env -C "$MAIN" bash ./scripts/lane-abandon.sh held --yes

expect_fails "refuses to run from a worktree" \
  env -C "$FIXTURE/giveup" bash ./scripts/lane-abandon.sh giveup

# The main checkout is not a lane and cannot remove itself.
expect_fails "refuses to abandon the main checkout" \
  env -C "$MAIN" bash ./scripts/lane-abandon.sh main --yes

# --- it does the thing when told ---------------------------------------------
done_out=$(cd "$MAIN" && bash ./scripts/lane-abandon.sh giveup --yes 2>&1)
expect_contains "reports what it removed" "removed" "$done_out"

checks=$((checks + 1))
if [ ! -d "$FIXTURE/giveup" ] && ! git -C "$MAIN" show-ref -q --verify refs/heads/giveup; then
  printf '  ok         --yes removes the worktree and deletes the branch\n'
else
  printf '\n  FAIL       --yes removes the worktree and deletes the branch\n' >&2
  status=1
fi

# The locked one is untouched by all of the above.
checks=$((checks + 1))
if [ -d "$FIXTURE/held" ]; then
  printf '  ok         the locked worktree is still there\n'
else
  printf '\n  FAIL       the locked worktree is still there\n' >&2
  status=1
fi

echo
if [ "$status" -ne 0 ]; then
  echo "lane-abandon.sh FAILED ($checks checks)" >&2
else
  echo "lane-abandon.sh ok ($checks checks)"
fi
exit "$status"
