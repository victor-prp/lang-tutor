# Lane orphans — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-10-11-lane-orphans-design.md` (D1–D6).
Executed inline, TDD per task.

- [x] **Task 1 — `findOrphans` (D1–D3).** Unit tests in `apps/server/src/db/lanes.test.ts`
  first, then the pure function in `lanes.ts`.
- [x] **Task 2 — tighten the drop pattern (D6).** Add a neighbouring lane's test database
  to `tests/integration/serial/lanes.test.ts` and assert it survives; then change the pattern.
- [x] **Task 3 — `lane:list -- --orphans [--names]` (D4).** `cli.ts` prints the orphan
  view; root `package.json`'s `lane:list` gains the bare `--` so flags reach the CLI.
- [x] **Task 4 — `lane:clean -- --orphans [--yes]` (D5).** Tests in
  `scripts/test-lane-clean.sh` with an `npm` stub first, then `lane-clean.sh`.
- [x] **Task 5 — docs.** CLAUDE.md's Lanes section names both commands.
- [x] **Task 6 — verify and ship.** typecheck, unit, `test:lanes`, `lint:arch`, the lanes
  integration file, a real `lane:list -- --orphans` against the shared Postgres; PR; CI green.
