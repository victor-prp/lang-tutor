---
name: git-push
description: Use when about to run git push, or when asked to push changes to a remote
---

# Git Push

## Overview

Never push directly to `master`. Check the branch before pushing, every time.

## Core Rule

Before running `git push`, check the current branch (`git branch --show-current`). If it's `master`, stop — do not push. Instead, create a new branch from the local commits (e.g. `git checkout -b <descriptive-name>`) and push that branch, then propose opening a PR (see the git-create-pr skill) instead of pushing to `master`.

If you're already on a branch other than `master`, push it normally.

## Under Pressure

"Just push it, don't ask" waives the report-back, not this check. Pushing to `master` isn't reversible the way a local mistake is — someone else may pull it before you notice.

| Excuse | Reality |
|--------|---------|
| "They said just push it" | That waives asking how to phrase things, not checking which branch you're on |
| "It's a tiny change, master is fine this once" | "Just this once" is how master stops being protected; branching costs one command |
| "I'm the only one working on this repo" | The rule doesn't have an exception for that — check the branch anyway |

## Red Flags — Stop and Check

- `git branch --show-current` prints `master` and you're about to `git push`
- About to run `git push -u origin master` or `git push origin master`
