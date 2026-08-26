---
name: git-create-pr
description: Use when the user asks to create, open, or submit a pull request for the current branch's changes.
---

# Create PR

## Overview
Opens a PR from the current branch against `master`.

## Steps

1. Gather context in parallel: `git status`, `git diff master...HEAD`, `git log master..HEAD`, and whether the current branch already tracks a remote.
2. Draft a title (<70 chars) and a body (Summary bullets + Test plan checklist) from the full set of commits on the branch, not just the latest one.
3. Show the user the branch, base (`master`), title, and body, and get explicit confirmation before pushing or opening the PR — do not push automatically even though push is normally pre-approved.
4. Push the branch: `git push -u origin <branch>` (skip if already up to date with remote).
5. Open the PR: `gh pr create --base master --title "..." --body "..."` (body via heredoc for formatting).
6. Return the PR URL to the user.

## Notes

- Never force-push, amend published commits, or skip hooks (`--no-verify`) to make this succeed.
- If the branch has no diff against `master`, say so instead of opening an empty PR.
