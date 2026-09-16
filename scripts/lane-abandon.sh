#!/usr/bin/env bash
#
# Gives up on one lane: drops its databases, removes its worktree, deletes its
# branch — including work that is not finished and not merged.
#
# This is the counterpart to lane-clean.sh, and deliberately a separate command
# rather than a flag on it. `lane:clean` is housekeeping: it takes no target, is
# safe to run on reflex, and cannot destroy unfinished work. This one exists to
# destroy exactly that, so it takes one named target, never `--all`, and prints
# what it is about to delete before it will do anything.
#
# Folding the two together as `lane:clean --force` would put a safe habitual
# command one mistyped flag away from deleting every unmerged branch in the
# repository. Two verbs keep shell history honest as well: `lane:clean` never
# appears next to something dangerous.
#
# Order is the same as lane-clean.sh and for the same reason: `npm run lane:down`
# runs INSIDE the worktree, so it has to happen before the worktree is removed.
# Getting it backwards fails silently — the databases survive as orphans that
# nothing mentions until someone runs `npm run lane:list`.

set -u

cd "$(dirname "$0")/.." || exit 1

ROOT=$(pwd -P)
MAIN=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)/.." 2>/dev/null && pwd -P) \
  || { echo "lane-abandon.sh: not a git repository" >&2; exit 1; }

if [ "$ROOT" != "$MAIN" ]; then
  echo "lane-abandon.sh: run this from the main checkout ($MAIN)." >&2
  echo "It removes a worktree, and a worktree cannot remove itself." >&2
  exit 1
fi

APPLY=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --yes) APPLY=1 ;;
    -*)    echo "lane-abandon.sh: unknown option $arg" >&2; exit 1 ;;
    *)     [ -z "$TARGET" ] && TARGET=$arg || { echo "lane-abandon.sh: name one lane, not several." >&2; exit 1; } ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "lane-abandon.sh: name the lane to abandon." >&2
  echo "  ./scripts/lane-abandon.sh <name>          what it would destroy" >&2
  echo "  ./scripts/lane-abandon.sh <name> --yes    destroy it" >&2
  echo "'npm run lane:list' and 'npm run lane:clean' both print the names." >&2
  exit 1
fi

BASE=master
git show-ref -q --verify refs/remotes/origin/master && BASE=origin/master

# Find the worktree by directory name or by branch — both are names a human uses,
# and lane-clean.sh prints the directory one.
wt_path=""; wt_branch=""; wt_locked=0; wt_reason=""
found_path=""; found_branch=""; found_locked=0; found_reason=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*) wt_path=${line#worktree }; wt_branch=""; wt_locked=0; wt_reason="" ;;
    "branch "*)   wt_branch=${line#branch }; wt_branch=${wt_branch#refs/heads/} ;;
    "locked"*)    wt_locked=1; wt_reason=${line#locked}; wt_reason=${wt_reason# } ;;
    "")
      [ -n "${wt_path:-}" ] || continue
      if [ "$(basename "$wt_path")" = "$TARGET" ] || [ "$wt_branch" = "$TARGET" ]; then
        found_path=$wt_path; found_branch=$wt_branch
        found_locked=$wt_locked; found_reason=$wt_reason
      fi
      wt_path=""
      ;;
  esac
done <<EOF
$(git worktree list --porcelain)

EOF

[ -n "$found_path" ] || { echo "lane-abandon.sh: no worktree called '$TARGET'." >&2; exit 1; }

if [ "$found_path" = "$MAIN" ]; then
  echo "lane-abandon.sh: '$TARGET' is the main checkout. It is lane 0, not a lane to give up on." >&2
  exit 1
fi

if [ "$found_locked" -eq 1 ]; then
  echo "lane-abandon.sh: '$TARGET' is locked — ${found_reason:-a session is using it}." >&2
  echo "That is somebody's live session. If you are certain, 'git worktree unlock $found_path' first." >&2
  exit 1
fi

# --- what would be destroyed -------------------------------------------------
echo "Abandoning lane '$TARGET' would destroy:"
echo
echo "  worktree   $found_path"
echo "  branch     ${found_branch:-(detached HEAD)}"

dirty=$(git -C "$found_path" status --porcelain 2>/dev/null)
if [ -n "$dirty" ]; then
  echo
  echo "  uncommitted or untracked files:"
  printf '%s\n' "$dirty" | sed 's/^/    /'
else
  echo
  echo "  no uncommitted files."
fi

if [ -n "$found_branch" ]; then
  lost=$(git log --oneline "$BASE..$found_branch" 2>/dev/null)
  if [ -n "$lost" ]; then
    echo
    echo "  commits not in $BASE:"
    printf '%s\n' "$lost" | sed 's/^/    /'
  else
    echo
    echo "  no commits of its own."
  fi
fi

pushed=0
if [ -n "$found_branch" ] && git show-ref -q --verify "refs/remotes/origin/$found_branch"; then
  pushed=1
  echo
  echo "  origin/$found_branch exists, so the pushed commits survive on the remote."
  echo "  This command does NOT delete the remote branch."
fi

echo
echo "  databases: whatever 'npm run lane:down' finds for this lane."
echo

if [ "$APPLY" -ne 1 ]; then
  echo "Nothing has been destroyed. To go ahead:"
  # The bare `--` is load-bearing: npm keeps `--yes` for itself otherwise.
  echo "    npm run lane:abandon -- $TARGET --yes      (the bare -- is required)"
  echo "    ./scripts/lane-abandon.sh $TARGET --yes    (same thing, without npm)"
  exit 0
fi

# --- do it -------------------------------------------------------------------
if [ -d "$found_path/node_modules" ]; then
  ( cd "$found_path" && npm run lane:down --silent ) 2>&1 | sed 's/^/  /'
else
  echo "  no node_modules, so lane:down cannot run here."
  echo "  Any databases this lane owns will show as ORPHAN in 'npm run lane:list'."
fi

git worktree remove --force "$found_path" || {
  echo "lane-abandon.sh: could not remove $found_path. The branch is untouched." >&2
  exit 1
}
echo "  removed $found_path"

if [ -n "$found_branch" ]; then
  git branch -D "$found_branch" > /dev/null 2>&1 \
    && echo "  deleted branch $found_branch" \
    || echo "  branch $found_branch kept (git refused to delete it)"
fi

git worktree prune

if [ "$pushed" -eq 1 ]; then
  echo
  echo "The remote branch is still there. To delete it too:"
  echo "    git push origin --delete $found_branch"
fi
