# Architecture decisions

Before designing or implementing anything under `apps/server` or `apps/mobile`, read the
ADRs in `docs/adr/` — each one is a binding constraint, not a suggestion. A Stop hook
(`.claude/settings.json`) already re-runs `scripts/check-adrs.sh` once per turn, when a
turn touched files under those trees, and CI enforces the same script (also runnable as
`npm run lint:arch`) — so a violation surfaces at the end of the turn rather than at
review time. `check-adrs.sh` discovers every `scripts/check-adr-*.sh` automatically, so
adding a new ADR never means updating this wiring.

When adding a check to any `scripts/check-adr-*.sh`, plant a violation of the rule first
and confirm the script reports it. A check that cannot fire prints nothing, exactly like a
check that passes, so "it printed nothing" is not evidence on its own.

Use the `create-adr` skill when a new structural decision needs recording.

# Worktrees

`git worktree add` brings tracked files and nothing else, so a new worktree is missing
exactly what `.gitignore` covers — `apps/mobile/.env.local` and `node_modules`. Run
`./scripts/setup-worktree.sh` before running the app, the tests or the e2e suite; it is
idempotent, and a SessionStart hook (`.claude/settings.json`) says so when either is
absent. Skipping it makes the app throw `EXPO_PUBLIC_API_URL is not set` at module scope,
which surfaces as three misleading expo-router errors about a missing default export.

**Never run `npm run db:up` from a worktree** while another checkout's Postgres holds port
5432: compose derives its project name from the directory, so it starts a second container
and fails. Reuse the running one — integration tests clone a per-test database off it
either way.
