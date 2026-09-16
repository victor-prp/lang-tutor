#!/usr/bin/env bash
#
# Retires the lanes whose work is done: drops each one's databases, removes its
# worktree, deletes its branch.
#
# Prints a plan and changes NOTHING unless given --yes. A command that drops
# databases and deletes worktrees should say what it intends first, and the plan
# is also what scripts/test-lane-clean.sh asserts.
#
# Three kinds of worktree are left alone, and the reasons are the whole point:
#
#   locked      a live session holds it. `git worktree lock` is how Claude Code
#               marks a worktree it is working in, and pulling one out from under
#               a running session loses whatever is uncommitted.
#   not merged  it carries a commit master does not have. That is unfinished
#               work, and dropping its databases and branch would lose it.
#   the main    lane 0 is not a lane that gets retired, and you cannot remove the
#   checkout    worktree you are standing in — which is also why this refuses to
#               run from anywhere else.
#
# Order matters and is not adjustable: `npm run lane:down` runs INSIDE the
# worktree, so it has to happen before the worktree is removed. Reverse them and
# the databases become orphans — findable with `npm run lane:list`, which reports
# a lane whose worktree is gone, but only if someone thinks to look.

set -u

cd "$(dirname "$0")/.." || exit 1

ROOT=$(pwd -P)
MAIN=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)/.." 2>/dev/null && pwd -P) \
  || { echo "lane-clean.sh: not a git repository" >&2; exit 1; }

if [ "$ROOT" != "$MAIN" ]; then
  echo "lane-clean.sh: run this from the main checkout ($MAIN)." >&2
  echo "It removes worktrees, and a worktree cannot remove itself." >&2
  exit 1
fi

APPLY=0
[ "${1:-}" = "--yes" ] && APPLY=1

# Merged against origin/master when it exists, falling back to the local branch.
# origin/master is the authoritative answer to "is this work in?", and a stale
# local master would otherwise report a just-merged lane as unfinished. Erring
# that way is safe — it skips — but it is needless friction.
BASE=master
git show-ref -q --verify refs/remotes/origin/master && BASE=origin/master

plan_count=0
clean_count=0

# `git worktree list --porcelain` emits a record per worktree, blank-line
# separated: `worktree <path>`, then `branch <ref>` or `detached`, and `locked`
# when it is held. Parsed as records rather than line-by-line so a path
# containing a space survives.
while IFS= read -r line; do
  case "$line" in
    "worktree "*) wt_path=${line#worktree }; wt_branch=""; wt_locked=0 ;;
    "branch "*)   wt_branch=${line#branch }; wt_branch=${wt_branch#refs/heads/} ;;
    "detached")   wt_branch="" ;;
    "locked"*)    wt_locked=1 ;;
    "")
      [ -n "${wt_path:-}" ] || continue
      [ "$wt_path" = "$MAIN" ] && { wt_path=""; continue; }

      name=$(basename "$wt_path")
      plan_count=$((plan_count + 1))

      if [ "$wt_locked" -eq 1 ]; then
        printf '  skip       %-28s locked — a session is using it\n' "$name"
      elif [ -z "$wt_branch" ]; then
        printf '  skip       %-28s detached HEAD — nothing to judge merged\n' "$name"
      elif [ "$(git rev-parse "$wt_branch" 2>/dev/null)" = "$(git rev-parse "$BASE" 2>/dev/null)" ]; then
        # A branch that has never diverged is trivially an ancestor of the base,
        # so "is it merged?" would answer yes for a lane somebody created five
        # minutes ago and has not committed in yet. Caught by running the plan
        # against the real repo, where this script's own lane reported itself
        # ready to be deleted.
        printf '  skip       %-28s no commits of its own — nothing finished here yet\n' "$name"
      elif ! git merge-base --is-ancestor "$wt_branch" "$BASE" 2>/dev/null; then
        printf '  skip       %-28s not merged into %s\n' "$name" "$BASE"
      else
        printf '  clean      %-28s merged into %s\n' "$name" "$BASE"
        clean_count=$((clean_count + 1))
        if [ "$APPLY" -eq 1 ]; then
          # Inside the worktree, and before it is removed: this is the only place
          # `lane:down` can find the lane it belongs to.
          if [ -d "$wt_path/node_modules" ]; then
            ( cd "$wt_path" && npm run lane:down --silent ) 2>&1 | sed 's/^/               /'
          else
            printf '               no node_modules; its databases (if any) will show as ORPHAN in lane:list\n'
          fi
          git worktree remove "$wt_path" \
            || { printf '               could not remove %s — leaving the branch alone\n' "$name"; wt_path=""; continue; }
          git branch -d "$wt_branch" > /dev/null 2>&1 \
            && printf '               removed, branch %s deleted\n' "$wt_branch" \
            || printf '               removed; branch %s kept (git refused to delete it)\n' "$wt_branch"
        fi
      fi
      wt_path=""
      ;;
  esac
done <<EOF
$(git worktree list --porcelain)

EOF

echo
if [ "$plan_count" -eq 0 ]; then
  echo "No worktrees besides the main checkout."
elif [ "$APPLY" -eq 1 ]; then
  git worktree prune
  echo "Cleaned $clean_count of $plan_count. Orphaned databases, if any: npm run lane:list"
elif [ "$clean_count" -eq 0 ]; then
  echo "Nothing to clean. This was a plan; nothing was changed."
else
  echo "This was a plan; nothing was changed. Run './scripts/lane-clean.sh --yes' to carry it out."
fi
