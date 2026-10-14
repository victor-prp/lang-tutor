# Phase 51 — Pull and rerun Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run rerun` in the main checkout pulls `master`, installs when the lockfile changed,
migrates, stops this checkout's server and Metro, and brings both back up on the new commit in one
terminal.

**Architecture:** One bash script, `scripts/rerun.sh`, run through `lane-env.sh` for `PORT` and
`METRO_PORT`. It reuses `npm run server`, `npm run mobile`, `npm run db:migrate` and
`with-commit.sh` rather than repeating them. A shell test drives it in throwaway repositories with
a stub `npm` on `PATH`.

**Tech Stack:** bash 3.2 (macOS) and 5 (CI), git, lsof, ps, pgrep, curl, python3 (test only).

**Spec:** `docs/superpowers/specs/2026-10-14-lang-tutor-phase-51-pull-and-rerun-design.md`

## Global Constraints

- bash 3.2: no associative arrays, `mapfile`, `${x,,}` or `wait -n`.
- ADR 0006 R1/R2/R4: no literal `3001`/`8081`/`3002`/`8082`, no `lang_tutor` string, no
  `/tmp/` path that is not from `mktemp`, anywhere under `scripts/`.
- Portable between BSD and GNU: `awk … fflush()`, never `sed -u`/`sed -l`.
- Nothing is stopped until pull, install and migrate have succeeded (spec D2).

## Review Focus

1. **A tracked file edited and left uncommitted** in the main checkout: the pull still
   fast-forwards, and the commit expected from `/health` is `<sha>-dirty`, as `with-commit.sh`
   says. Test in Task 1.
2. **Nothing new on origin**: the command still restarts both, says it is already on the commit,
   and skips install. Test in Task 1.
3. **The command is stopped while Metro runs** (Ctrl-C, or a second `rerun` from another
   terminal): the server it started stops too and `PORT` is free. Test in Task 1 (TERM to the
   running command).
4. **Postgres not running**: migrate fails, named, and nothing is stopped. The migrate-failure
   test covers it.
5. **A slow first server boot** (tsx compiling): the 90 s cap. Not tested; the cap is a constant.

---

### Task 1: `scripts/rerun.sh` and its test

**Files:**
- Create: `scripts/rerun.sh`
- Create: `scripts/test-rerun.sh`

**Interfaces:**
- Consumes: env `LANE_SLOT`, `PORT`, `METRO_PORT` (from `lane-env.sh`); `npm run db:migrate`,
  `npm run server`, `npm run mobile`, `npm install`; `scripts/with-commit.sh printenv APP_COMMIT`.
- Produces: exit 0 after Metro exits normally; exit 1 with `rerun: <step>: <reason>` on stderr on
  any failure.

- [ ] **Step 1: Write the test.** `scripts/test-rerun.sh` follows `test-with-commit.sh`'s shape
  (`expect`, `checks`, `status`, a `mktemp -d` fixture removed on exit). Fixture: a bare
  `origin.git`; a `seed` clone holding `scripts/rerun.sh`, `scripts/with-commit.sh` (both copied
  from the repo), `package-lock.json`, `apps/server/`, `apps/mobile/`, a `.gitignore` with
  `node_modules/`; a `main` clone (lane 0) with `node_modules/`. A stub `bin/npm` logs `npm $*`
  to `npm.log` and: `install` → 0; `run db:migrate` → 1 when `FAKE_MIGRATE_FAILS` is set;
  `run server` → `exec python3 fake_server.py $PORT <commit>` from `apps/server`, the commit
  being `FAKE_HEALTH_COMMIT` or `with-commit.sh`'s value; `run mobile` → sleeps
  `FAKE_MOBILE_SLEEPS` seconds, default 0. Free ports come from python3. Listeners for D3 are
  `python3 -m http.server` started under `set -m` (own process group): in-checkout with
  `(cd main/apps/server && exec python3 …) &`, outside with a cwd in another temp dir, in a
  worktree with a cwd under `main/.claude/worktrees/x`, shell-led with `(cd … && python3 …; true) &`.

  Cases, each an `expect`:
  1. no lane environment → refused, mentions `npm run rerun`
  2. `LANE_SLOT=4` → refused, `lane 0 only`
  3. main on a branch `review` → refused, `not master`
  4. origin gains a lockfile change → exit 0; main's HEAD is origin's; `npm.log` is
     install, db:migrate, server, mobile; output names the new short commit; `PORT` free after
  5. origin gains a README change → `npm.log` has no install
  6. nothing new → exit 0, output says `already on`
  7. a tracked file edited, origin gains a commit → exit 0, server answered with `<sha>-dirty`
  8. in-checkout listener on `PORT`, `FAKE_MIGRATE_FAILS=1` → exit 1, `migrate:`, listener alive,
     no `run server` in the log
  9. the same listener plus one on `METRO_PORT`, normal run → exit 0, both listener pids gone
  10. outside listener → exit 1, `not this checkout's`, listener alive
  11. worktree listener → exit 1, `belongs to a worktree`, listener alive
  12. shell-led listener → exit 1, `started straight from a shell`, listener alive
  13. `FAKE_HEALTH_COMMIT=0000000` → exit 1, `answered with 0000000`, `PORT` free after
  14. `FAKE_MOBILE_SLEEPS=30`, the command sent TERM once `npm.log` shows `run mobile` → it
      exits, `PORT` free
  15. main has a local commit and origin a new one → exit 1, `pull:`

- [ ] **Step 2: Run it, see it fail** — `./scripts/test-rerun.sh` → every case FAILs on the
  missing `scripts/rerun.sh`.

- [ ] **Step 3: Write `scripts/rerun.sh`.**

```bash
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$ROOT" || exit 1
HEALTH_TIMEOUT=90
STOP_TIMEOUT=10
STEP=
SERVER=

fail() { echo "rerun: ${STEP:+$STEP: }$1" >&2; exit 1; }
step() { STEP="$1"; printf '\n== %s\n' "$1"; }

# Guards (D1): LANE_SLOT/PORT/METRO_PORT set; LANE_SLOT=0; branch master.

step pull      # before=HEAD; git pull --ff-only origin master || fail; print old -> new or "already on"
step install   # [ ! -d node_modules ] || ! git diff --quiet "$before" "$after" -- package-lock.json
step migrate   # npm run db:migrate || fail

listener() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }
cwd_of()   { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }
stop_port() { # D3: refuse a cwd outside $ROOT or under $ROOT/.claude/worktrees/, a shell-led
              # group, our own group; else kill -TERM -- -pgid, KILL after STOP_TIMEOUT, wait free
              :; }
step stop      # stop_port server "$PORT"; stop_port metro "$METRO_PORT"

descendants() { local c; for c in $(pgrep -P "$1"); do echo "$c"; descendants "$c"; done; }
stop_server() { [ -n "$SERVER" ] || return 0; kill -TERM "$SERVER" $(descendants "$SERVER") 2>/dev/null; SERVER=; }
trap stop_server EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

step server    # expected=$(bash scripts/with-commit.sh printenv APP_COMMIT)
               # npm run server < /dev/null > >(awk '{ print "[server] " $0; fflush() }') 2>&1 &
               # SERVER=$!; poll /health every 0.5 s: server gone → fail; "commit" read → compare
step metro     # npm run mobile  (not exec: the EXIT trap must still run)
```

- [ ] **Step 4: Run the test until it passes** — `./scripts/test-rerun.sh` → `rerun.sh ok (N checks)`.

- [ ] **Step 5: Commit** — `feat(scripts): npm run rerun pulls master and restarts the server and Metro (phase 51)`.

### Task 2: Wiring — the npm script, ADR 0006 R3, CI, README

**Files:**
- Modify: `package.json` (add `rerun` after `server`)
- Modify: `scripts/check-adr-0006-lanes.sh` (R3 key list)
- Modify: `docs/adr/adr-0006-lanes.md` (R3 row, Date line, How-to-detect R3 list)
- Modify: `.github/workflows/ci.yml` (check-adrs job)
- Modify: `README.md` ("Running it")

- [ ] **Step 1: Plant the violation.** Add `rerun` to R3's key list in the check script only, run
  `./scripts/check-adr-0006-lanes.sh` → `VIOLATION R3 … "rerun" is missing`. Add
  `"rerun": "bash scripts/rerun.sh"` (no wrapper) → `VIOLATION R3` naming that line.
- [ ] **Step 2: Fix it.** `"rerun": "bash scripts/lane-env.sh bash scripts/rerun.sh"` → R3 `ok`.
  Mirror the key list in the ADR's R3 row and its How-to-detect block; add
  `R3's key list gains \`rerun\` 2026-10-14 (phase 51)` to the Date line.
- [ ] **Step 3: CI.** In `check-adrs`, after `test-with-commit.sh`'s neighbours:
  `# Phase 51. rerun.sh, against a stub npm and throwaway repositories.` /
  `- run: ./scripts/test-rerun.sh`.
- [ ] **Step 4: README.** Under the two-terminal block in "Running it", a paragraph:
  **After a merge**, `npm run rerun` in the main checkout does all of it, what it stops, that the
  server's lines are prefixed `[server]`, that Metro starts only once `/health` names the commit
  just pulled, and lane 0 on `master` only.
- [ ] **Step 5: Verify** — `./scripts/check-adrs.sh`, `./scripts/test-rerun.sh`,
  `./scripts/test-lane-env.sh`, `npm run typecheck`.
- [ ] **Step 6: Commit** — `feat(scripts): wire npm run rerun through the lane wrapper (ADR 0006 R3), CI and the README`.
