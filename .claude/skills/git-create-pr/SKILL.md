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
3. **Stop here.** Show the user the branch, base (`master`), title, and body, and end your turn waiting for their explicit approval. Do not run `git push` or `gh pr create` yet — approval of the PR content comes before either, not after.
4. Only once the user has approved: push the branch (`git push -u origin <branch>`, skip if already up to date) and open the PR. Write the body to a file and pass `--body-file` rather than `--body` with a heredoc — a long body with backticks, checklists and non-ASCII survives a file intact, and the file is also what the user pastes into the web UI if `gh` fails.

   ```bash
   source ~/.zshrc >/dev/null 2>&1          # see Environment
   export PATH="/opt/homebrew/bin:$PATH"
   gh pr create --base master --title "..." --body-file <path>
   ```
5. Return the PR URL to the user.

## Environment

Two things are set up such that `gh` fails from a tool-spawned shell, both fixed by the prelude in step 4. Run it rather than rediscovering these:

- **`gh` is not on `PATH`.** It lives at `/opt/homebrew/bin/gh`; a bare `gh` gives `command not found`. The same is true of `npm`, `node` and `docker`.
- **`GITHUB_TOKEN` is defined in `~/.zshrc`**, which non-interactive shells do not source — so `gh` reports "To get started with GitHub CLI, please run: `gh auth login`" even though the user has a valid token. `gh auth login` is an interactive browser flow and **cannot** be completed from a tool call, so never start one; source `~/.zshrc` instead. (`~/.zshenv` would fix this permanently for all shells — worth suggesting, not worth doing unasked.)

**The token is a secret.** Never echo `$GITHUB_TOKEN`, never `grep`/`cat` a dotfile in a way that prints the line defining it (use `grep -l` for filenames only), and redact any command output that could contain it — `gh auth status` prints a masked token but pipe it through `sed -E 's/(gh[pousr]_[A-Za-z0-9]+)/[REDACTED]/g'` anyway.

## Under Pressure

"Don't ask, don't wait, just get it done" does not skip step 3. That instruction waives back-and-forth on wording, not approval of what gets pushed and published — a PR is visible to other people the moment it opens.

| Excuse | Reality |
|--------|---------|
| "They said don't ask questions" | Showing the PR content and stopping isn't a question — it's the one checkpoint before something public happens |
| "The push is pre-approved, so the PR content must be too" | Push being generally pre-approved doesn't approve *this specific* title/body — that's exactly what step 3 exists to check |
| "I'll just push and open it, they can close it if wrong" | Closing a bad PR after the fact still means it existed publicly with the wrong content |

## Red Flags — Stop and Check

- About to run `git push` or `gh pr create` and the user hasn't seen the drafted title/body yet
- Treating "don't ask clarifying questions" as license to skip the step-3 approval checkpoint

## Notes

- Never force-push, amend published commits, or skip hooks (`--no-verify`) to make this succeed.
- If the branch has no diff against `master`, say so instead of opening an empty PR.
