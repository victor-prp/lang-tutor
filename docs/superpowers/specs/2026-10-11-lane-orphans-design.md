# Lane orphans: listing and cleaning them — Design

**Status:** approved in chat, 2026-10-11

## Problem

`npm run lane:clean` walks `git worktree list`, so it never sees a lane database whose
worktree is already gone. `npm run lane:list` marks those ORPHAN and prints a
`lane:down` command per lane, which leaves cleaning them up as a by-hand job.

## Decisions

- **D1 — An orphan lane is one whose every stamped database points at a worktree
  that is gone.** "Gone" means `stamp.root` no longer exists on disk, the same test
  `lane:list` already applies. A lane with even one database stamped by a worktree
  that still exists is not an orphan: `lane:down` would drop the live one's too.
  The rule lives in one pure function, `findOrphans` in `apps/server/src/db/lanes.ts`,
  so the listing and the clean cannot disagree.
- **D2 — Lane 0 is never an orphan.** `lang_tutor` and `lang_tutor_e2e` are excluded by
  name and a stamp saying `lane=main` is ignored. `dropLaneDatabases` already refuses
  `main`; this keeps the plan from proposing what the drop would refuse.
- **D3 — A database with no lane stamp is reported, never dropped.** Nothing says who owns
  it, so `--orphans` lists it as "unowned" for a human to judge.
- **D4 — `npm run lane:list -- --orphans`** prints only the orphan lanes, their databases
  and the unowned ones, and ends with the command that drops the orphans. `--names` adds a
  tab-separated form for scripts: `orphan<TAB><lane><TAB><db> <db>…` and `unowned<TAB><db>`.
- **D5 — `npm run lane:clean -- --orphans`** prints a plan and changes nothing; with
  `--yes` it runs the existing `npm run lane:down -- <lane>` per orphan lane. It does not
  walk worktrees as well: one command, one job. It runs from the main checkout only, like
  plain `lane:clean`.
- **D6 — `lane:down`'s per-test pattern tightens from `t_<lane>_.*` to
  `t_<lane>_(test|tmpl)_.*`**, the only shapes `tests/support/dbNames.ts` creates. The old
  prefix match also took the test databases of a lane whose name extends this one's
  (`phase_31` reached `t_phase_31_glosses_*`), which a bulk clean makes more likely to bite.
  The new one is still a prefix match for a lane named `<lane>_test…`; that residue is
  accepted.

## Known limit

A worktree recreated at a different path on the same branch carries its old `root` stamp
until its first `db:migrate`, which re-stamps. Until then it reads as an orphan. The
plan step is where a human sees that before anything is dropped.

## Testing

- Unit: `findOrphans` with an injected exists-check (`src/db/lanes.test.ts`).
- Integration: `lanes.test.ts` gains a neighbouring lane's test database that the drop
  must leave alone.
- `scripts/test-lane-clean.sh`: an `npm` stub on `PATH` feeds `--orphans` its input and
  records the `lane:down` calls, so the plan, `--yes` and the refusal are all asserted
  without a database.
