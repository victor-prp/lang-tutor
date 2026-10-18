---
name: ci-green
description: Use right after opening a pull request or pushing to a branch that has one, when CI is still running, has failed, or passed only on a rerun, or when asked to get a PR's checks green
---

# CI Green

## Overview

A PR is finished when its checks are green, not when it is open. ci-green owns
every red check on the branch, whatever caused it: this diff, something already
on master, model drift in `test-eval`, a flaky e2e spec. Find the root cause, fix
it, and watch CI again. Whose fault it is decides where the fix goes, never
whether it happens.

## Steps

1. **Watch in the background.** CI runs on `push` (see `.github/workflows/ci.yml`),
   so its checks attach to the branch tip and show on the PR. Run the watch with
   the Bash tool's `run_in_background: true` — you are woken when it exits, so do
   not poll:

   ```bash
   source ~/.zshrc >/dev/null 2>&1; export PATH="/opt/homebrew/bin:$PATH"
   gh pr checks <pr> --watch --fail-fast --interval 20
   ```

   If it reports no checks yet, the run has not registered: wait one cycle and
   watch again. A whole run takes about 3 minutes.

2. **Green on the first attempt → done.** Report the PR URL and the passing
   checks. A check that went green only on a rerun is flaky, and flaky is red:
   go on to step 3 with the failed attempt (`--attempt 1`).

3. **Red → find the failing job and its log:**

   ```bash
   gh pr checks <pr>                                  # which job
   gh run view <run-id> [--attempt N] --log-failed    # why
   ```

   For `test-eval`, do **test-eval** below before anything else.

4. **Reproduce it locally.** REQUIRED SUB-SKILL: superpowers:systematic-debugging.
   Run the job's own command and watch it fail before changing anything. A
   flaky check fails only some of the time: repeat it until it fails.

   | Job | Local command |
   |-----|---------------|
   | `check-adrs` | `./scripts/check-adrs.sh` (and the `test-lane-*.sh` scripts it runs) |
   | `check-types` | `npm run typecheck` |
   | `test-unit` | `npm test` |
   | `test-integration` | `npm run test:integration` |
   | `test-e2e` | `npm run e2e -- <spec> --repeat-each=10` |
   | `test-eval` | `npx tsx tests/eval/run.ts "<group> "` from `apps/server`, at least twice |

5. **Fix the root cause where it lives:**
   - **In this branch's diff** → commit the fix here.
   - **Anywhere else** (the check also fails on master, or the cause is in code,
     a prompt or a test this branch did not touch) → open a separate fix PR now,
     yourself: a worktree and branch from `origin/master` (CLAUDE.md, *Lanes*),
     the fix, the git-create-pr skill, then this skill on the fix PR. Keep its
     commits off this branch. Link it from this PR's body, and put the order
     under **Left for Victor**: merge the fix PR, `gh pr update-branch <this-pr>`,
     then merge this one once its CI is green.

6. **Prove it.** Run the reproduction from step 4 again, repeatedly, and see it
   pass every time: the e2e spec with `--repeat-each`, an eval group at least
   twice. A fix you have not seen fail and then pass is a guess.

7. **Push and watch again.** Commit with the git-commit skill, `git push`
   (plain — never force, never `--no-verify`), and go back to step 1 on the PR
   that carries the fix. Each push cancels the previous run (`cancel-in-progress`),
   so only the newest run counts.

8. **Stop after 3 fix rounds** still red on one PR. Report the failing job, what
   each round tried, and the root cause found so far with its evidence, and
   leave the branch as it is.

## test-eval

`test-eval` calls a real model, so it can go red with nothing wrong in the diff.
That moves the fix to a separate PR; it does not cancel it. Before changing
anything:

1. Download this run's report and master's latest (CLAUDE.md, *Prompt evals*):

   ```bash
   gh run list --branch master --workflow ci.yml --limit 5   # master's latest test-eval run
   gh run download <run-id> -p '*-report' -D <scratchpad>/eval-<run-id>
   ```

2. Compare tier 2 per row. A row that fails on master too is a separate fix PR;
   a row that passes on master and fails here is this branch's.
3. Reproduce with the group's local runs (step 4), then fix the prompt, the
   code or the case's own bug, and prove it with at least two runs per group,
   read row by row.

## Never

- Lower `TIER2_THRESHOLD`, loosen an assertion, or skip or delete a case or
  test to get green. Fix the prompt, the code or the test's own bug.
- Count a rerun as a fix. A rerun measures how often it fails, nothing more.
- Merge, or tell Victor to merge past a red check. Anything only Victor can do
  (merging, secrets, `terraform apply`) goes under **Left for Victor** in the PR
  body and the final message, with the exact commands in order.

## Red Flags

| Thought | Reality |
|---------|---------|
| "Not this branch's problem — master fails it too" | ci-green owns it. Not this diff means a separate fix PR, opened now. |
| "Wrong place for the fix: one line of work, one PR" | Right — so open the fix PR. |
| "Want me to fix it on its own branch?" / "Not tonight" | Don't offer the fix PR. Open it. |
| "The rerun went green, so it's done" | Green only on a rerun is flaky. Root-cause it. |
| "I'll file an issue / note it in memory" | A note is not a fix. |
| "Likely cause: that commit" | Reproduce it locally and prove it before you say it. |
| "Lower the threshold / delete the brittle row" | That makes it pass, not work. Fix the prompt, code or test's bug. |
| "Third round failed, one more try" | Three rounds is the limit. Report the root cause so far. |
| "The PR is open, I'll let them watch CI" | Open is not done. Watch it. |
