# Architecture decisions

Before designing or implementing anything under `apps/server` or `apps/mobile`, read the
ADRs in `docs/adr/` — each one is a binding constraint, not a suggestion. A Stop hook
(`.claude/settings.json`) already re-runs `scripts/check-adrs.sh` once per turn, when a
turn touched files under those trees, and CI enforces the same script (also runnable as
`npm run lint:arch`) — so a violation surfaces at the end of the turn rather than at
review time. `check-adrs.sh` discovers every `scripts/check-adr-*.sh` automatically, so
adding a new ADR never means updating this wiring.

Use the `create-adr` skill when a new structural decision needs recording.
