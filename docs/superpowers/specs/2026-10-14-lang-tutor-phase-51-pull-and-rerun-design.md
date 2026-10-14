# Phase 51 — Pull and rerun in one command

- **Status:** Scoped with Victor on 2026-10-14 in a one-pager, then "go till PR": the design
  questions were answered by Claude with its recommendation, and are the rulings at the end.
- **Date:** 2026-10-14
- **Source:** `drafts/2026-10-14-pull-and-rerun-one-pager.md`
- **Builds on:** phase 15 (lanes, ADR 0006), phase 49 (`with-commit.sh`; `/health` and the About
  screen name the commit a process started on, and a process left running keeps its old one).
- **Touches:** a new `scripts/rerun.sh` and its test, the root `rerun` script, ADR 0006's R3 list
  and its check, the CI `check-adrs` job, the README's "Running it". No app or server code.

---

## Goal

After a PR merges, Victor pulls `master` in the main checkout, then by hand stops the server and
Metro, runs `npm install` and `npm run db:migrate`, and starts both again in two terminals. A
missed step surfaces later as a confusing failure on the phone, and a server or Metro left
running keeps serving the commit it started on.

**Done means:** after `npm run rerun`, the phone's About screen and `/health` both show the commit
just pulled, with nothing done by hand.

**Out:** worktree lanes; anything automatic (nothing watches for merges); the hosted server and
releases; native rebuilds; running tests.

## Design

**D1 — One command, lane 0 on `master`.** `npm run rerun` runs
`bash scripts/lane-env.sh bash scripts/rerun.sh`. It refuses, saying why, unless `LANE_SLOT` is 0
and the branch is `master`.

**D2 — Six steps, in order.** Each prints its name as it starts. The first that fails stops the
command and names itself; nothing is stopped until the first three have succeeded.

1. **pull** — `git pull --ff-only origin master`.
2. **install** — `npm install`, only when `package-lock.json` differs from the one `node_modules`
   was last installed from, which a stamp in `node_modules` records after each install that
   succeeds.
3. **migrate** — `npm run db:migrate`.
4. **stop** — whatever listens on lane 0's `PORT` and `METRO_PORT` (D3).
5. **server** — `npm run server` in the background, every line prefixed `[server] ` in this
   terminal. The command waits until `/health` names the expected commit (D5).
6. **metro** — `npm run mobile` in the foreground: the QR code and Expo's keys, as today.

**D3 — Stopping only what is ours.** The listener is found with `lsof`. It is stopped only when
its working directory is inside this checkout and not under `.claude/worktrees/`; anything else
is refused, naming the pid and command. The whole process group is stopped (TERM, then KILL
after 10 s), so a hand-started `npm run server` in another terminal returns to its prompt and
its `tsx watch` cannot restart the server. A group led by a shell, or this command's own group,
is refused.

**D4 — One terminal.** The server's output shares the terminal with Metro, which owns its input.
When the command ends (Ctrl-C, Metro exits, a failed check), it stops the server it started.

**D5 — The check.** The expected commit is `with-commit.sh`'s value, the same one the server
reads. Metro does not start until `/health` answers with it; a different commit, the server
exiting, or 90 s without an answer fails the command and names both values.

Considered and not chosen: detached processes with pid and log files (loses Metro's interactive
terminal, and adds a log to go and find); tmux or terminal tabs (a new dependency for one
person's loop).

## Testing

`scripts/test-rerun.sh`, in throwaway repositories (an origin and a lane-0 clone), with a stub
`npm` on `PATH`, a python3 stand-in for the server's `/health`, and real listeners for D3. It
covers: each refusal in D1; a diverged `master` failing at **pull**; install run only when the
lockfile changed; a failing migrate leaving a running listener alone; an in-checkout listener
stopped with its group; an outside listener refused; `/health` with the wrong commit failing;
and the whole run (HEAD moved, the server answered with the new commit, Metro started). It runs
in CI's `check-adrs` job beside the other script tests. `rerun` joins ADR 0006 R3; the check is
seen to fire on a planted violation first.

## Rulings

1. **A failed step** (the one-pager's open question) stops the command and names itself, and
   nothing is stopped before pull, install and migrate succeed. A running `tsx watch` server
   reloads pulled files by itself, so "left running" means whatever it picked up, not the old
   commit.
2. **The name is `rerun`**, Victor's own verb; the README says it pulls first.
3. **Install only when the lockfile changed since the last install.** `npm install` on every
   pull spends a minute for nothing; it is the command `setup-worktree.sh` already uses. The
   comparison is against a stamp of the last installed lockfile, not against what this pull
   changed (amended after the final review): that would skip the retry after a failed install,
   and a pull done by hand beforehand. The first run after this ships installs once.
4. **No native-change notice.** The one-pager's Out allowed one "at most"; not built.
5. **`rerun` joins ADR 0006 R3.** It starts the server and Metro, so it runs through
   `lane-env.sh` like `server` and `mobile`.

## Risks

- **Expo Go after Metro restarts** may show itself disconnected until reloaded. If it does, `r`
  in the same terminal reloads it. Only a run on Victor's Android phone can tell.
- **Stopping a whole group** takes the other terminal's whole job. An interactive shell makes
  each command of a hand-typed `npm run server; something` a job of its own, so only a pipeline
  or a wrapper script shares the server's fate.
