---
name: feature-one-pager
description: Use when the user wants to scope a feature or the next phase before brainstorming it — asks for a scoping discussion, a one-pager, a feature brief, or to "talk about what phase N should be" before any design
---

# Feature One-Pager

## Overview

A short scoping conversation whose output is a draft one-pager in the user's words. It
records **what** and **why**, never **how**. Its only consumer is
`superpowers:brainstorming`, which reads it as the intent it would otherwise have to discover.

Design is brainstorming's job. A one-pager that already chose tables, endpoints or
algorithms has done brainstorming badly and without the user.

## The conversation

1. **Read scope, not code.** The latest phase spec's Goal and Out list, and any spec or
   draft the user names. That is enough to know what exists and what was deferred. Source
   code is for brainstorming. A phase still in progress keeps its spec on its own branch or
   untracked in the main checkout, so a worktree's `docs/` can lack the newest one: check
   `git branch` and read it with `git show <branch>:<path>`.
2. **Ask 3–5 questions, one per message**, multiple choice when the options are obvious, in
   this order, skipping any the user already answered:
   1. What problem does this solve, and for which learner?
   2. What does the smallest useful version do?
   3. How will we know it worked — what can someone see or count?
   4. What is explicitly out?
   5. (only if needed) The one scope question still open.
3. **When the user asks a design question** (schema, endpoint, algorithm, library), answer in
   one line that it belongs to brainstorming, add it to the one-pager's parked list, and ask
   your next scope question.
4. **Write the draft** after the questions are answered, or sooner if the user asks for it.
5. **Hand off:** give the path, invite corrections, then offer to start
   `superpowers:brainstorming` with the one-pager as its input.

## The one-pager

Path: `drafts/YYYY-MM-DD-<topic>-one-pager.md` in the **main checkout**, even from a worktree
(`$(git rev-parse --git-common-dir)/../drafts/`). `drafts/` is gitignored, and a worktree's
copy is deleted by `lane:clean`. The spec brainstorming writes cites it as its Source.

Under 300 words. Exactly these sections:

```markdown
# <Feature> — one-pager (draft)

- **Date:** YYYY-MM-DD
- **Builds on:** <phase / spec, one line>

## Problem
<who is stuck and why, 2–3 sentences>

## Done means
1. <observable outcome the user stated>

## In
- <capability, not mechanism>

## Out
- <deferred item>

## Open questions
- <scope question the user left undecided, in their words>

## Parked for brainstorming
- <design question raised during the talk>
```

Every line comes from the user's answers. If you add an item yourself, end it with
`(assumed)` so the user can strike it. When the user said "not sure" or "maybe", the item goes
under Open questions as they phrased it, not under In or Out.

## Common mistakes

| Mistake | Fix |
|---|---|
| Draft on the first turn without being asked | Ask the questions first; the draft is the summary of answers |
| Four questions in one message | One per message |
| Reading repo code, then writing table names, endpoints, ordering rules | Those are Parked lines at most |
| "Maybe store results only" written as a decision | Open question, verbatim |
| Done-means invented with specific numbers | Only what the user stated, or `(assumed)` |
| A rationale section arguing for the scope | The user chose it; a one-pager does not defend it |
| Draft saved in the worktree's `drafts/` | Main checkout's `drafts/` |
