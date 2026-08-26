---
name: git-commit
description: Use when about to run git commit, when the working tree has more than one kind of change staged or unstaged, or when asked to "just commit this" without further guidance
---

# Git Commit

## Overview

Committing is not just running `git commit`. Before every commit: verify the change actually works, split unrelated changes into separate commits, and never silently fold in a change you can't explain. Skipping any of these is how broken code, unreviewable commits, and accidental changes land in history.

## Core Rule

**Verify → Split → Flag.** Do all three before drafting the commit message, not after.

1. **Verify** — find the project's test/build/lint command (`package.json` scripts, `Makefile`, CI config) and run it against the change you're about to commit. A change that breaks the build is a reason to stop and fix it, not a footnote in the commit body.
2. **Split** — read the full diff, not just the file list. If two hunks solve different problems (a bug fix + a new feature, an unrelated formatting pass, a version bump), they're separate commits — stage specific files/hunks (`git add <file>`, `git add -p`) instead of one `git add -A` for everything that happens to be modified.
3. **Flag** — if the diff contains a change you didn't make for this task and can't explain, stop and ask before committing it. Do not describe it in the commit message as if it were intentional — that makes an unreviewed change look reviewed.

Message style (format, tone, imperative vs. not) should match what `git log` already shows for the repo — check it, don't invent a new convention.

## Under Pressure

"Just commit it, don't ask questions" waives the report-back and the clarifying questions about *wording*. It does not waive verification or flagging — those aren't optional politeness, they're how you know the commit is correct.

| Excuse | Reality |
|--------|---------|
| "They said just commit it, don't bother them" | That waives asking permission for how to phrase things, not checking whether the change works |
| "This failing test looks unrelated to what I changed" | If your diff touches code the test exercises, it's related — run it and look, don't guess |
| "I'll mention the stray change in the commit message so it's transparent" | Writing it down isn't flagging it — the user still never approved including it |
| "Splitting into multiple commits takes longer" | A few extra `git add <file>` calls cost seconds; an unreviewable bundled commit costs a revert later |
| "It's a small project, verification is overkill" | Small projects still have tests for a reason; "small" isn't "no consequences" |

## Red Flags — Stop and Check

- About to run `git commit` and haven't run the project's test/build command this session
- `git diff` spans more than one concern and you're reaching for `git add -A`
- `git status` shows a modified file you don't remember touching or can't tie to the current task
- Drafting commit body text that explains away a change instead of asking about it

## When This Doesn't Apply

- No test/build/lint command exists in the project — say so rather than skipping silently.
- The user explicitly says to skip verification for a specific, named reason (e.g. "commit as WIP, tests are known-broken right now"). A blanket "just commit it" is not that.
