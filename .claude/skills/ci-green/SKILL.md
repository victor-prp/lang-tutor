---
name: ci-green
description: Use right after opening a pull request or pushing to a branch that has one, when CI is still running or has failed, or when asked to get a PR's checks green
---

# CI Green

## Overview

A PR is finished when its checks are green, not when it is open. Watch CI on the
branch tip, fix what fails, push, and watch again — without waiting to be told
it went red.

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

2. **Green → done.** Report the PR URL and the passing checks. That is the end
   of the work.

3. **Red → find the failing job and its log:**

   ```bash
   gh pr checks <pr>                     # which job
   gh run view <run-id> --log-failed     # why
   ```

4. **Fix it.** REQUIRED SUB-SKILL: superpowers:systematic-debugging. Reproduce
   locally with the job's own command before changing anything:

   | Job | Local command |
   |-----|---------------|
   | `check-adrs` | `./scripts/check-adrs.sh` (and the `test-lane-*.sh` scripts it runs) |
   | `check-types` | `npm run typecheck` |
   | `test-unit` | `npm test` |
   | `test-integration` | `npm run test:integration` |
   | `test-e2e` | `npm run e2e` |
   | `test-eval` | see **test-eval** below — do not start by changing code |

   Commit the fix with the git-commit skill, `git push` (plain — never force,
   never `--no-verify`), and go back to step 1. Each push cancels the previous
   run (`cancel-in-progress`), so only the newest run counts.

5. **Stop after 3 fix rounds** still red. Report the failing job, what each round
   tried, and your current hypothesis, and leave the branch as it is.

## test-eval

`test-eval` calls a real model and can go red with nothing wrong in the diff.
Before touching code, download and read the report:

```bash
gh run download <run-id> -n eval-report -D <scratchpad>/eval-report
```

- Failures tied to prompts or code this branch changed → fix like any other job.
- Failures in cases this branch did not touch → model drift. Do not fix; report
  it with the evidence and stop. A `gh run rerun <run-id> --failed` is fair once,
  to rule out a transient error.
- Never lower `TIER2_THRESHOLD`, loosen an assertion, or skip a case to get green.

## Red Flags

| Thought | Reality |
|---------|---------|
| "The PR is open, I'll report and let them watch CI" | Open is not done. Watch it. |
| "It's flaky, re-run until it passes" | Re-run once at most, then debug it like any failure. |
| "Skip/loosen the failing test so it goes green" | That makes it pass, not work. Fix the cause or stop and report. |
| "Third round failed, one more try" | Three rounds is the limit. Report what you know. |
