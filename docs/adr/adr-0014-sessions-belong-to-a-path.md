# ADR 0014: Every session belongs to one path, and each path has its own stock and started session

- **Status:** Accepted
- **Date:** 2026-10-16 (phase 57)
- **Source:** [phase 57 design](../superpowers/specs/2026-10-16-lang-tutor-phase-57-target-skills-design.md) — D1 for paths, D2 for the stock and lifecycle per path

## Decision

A **path** is the main path ("My words") or one target. `sessions.target_id` names a session's
path: a target's id, or null for the main path. Phase 43's two open sessions, one in stock and one
started, are per path, not per enrollment: the database holds the rule in two unique indexes on
`(enrollment_id, coalesce(target_id, nil uuid))`, so the main path is a path of its own and the
code before this phase, which names no `target_id`, writes the main path's sessions. Everything
that makes or reads a path's next session names the path (`Path = string | null`): its
next-session lock, `findOpen`, the stock job's payload and singleton key, create and current. The
main path asks only saved words in no active target; a target's path asks only that target's.

```
  enrollment ─┬─ main path   (target_id null)  ── stock ≤ 1, started ≤ 1   words in no active target
              ├─ target A    (target_id = A)   ── stock ≤ 1, started ≤ 1   A's words only
              └─ target B    (target_id = B)   ── stock ≤ 1, started ≤ 1   B's words only

  locks:  next-session:<enrollment>:main  →  next-session:<enrollment>:<target>…  (id order)
          → retire stocks → progress:<enrollment> → enqueue stocks
          (progress: every session end, and a word taken out of a target)
```

Memory, levels and target skills are the enrollment's, written by every path's session ends; the
progress lock serializes those ends, which phase 43's one started session used to do.

## Rules

| # | Subject | Must | Must not |
|---|---|---|---|
| R1 | `apps/server/src/db/schema.ts` | declare `sessions_one_stock_per_path` and `sessions_one_started_per_path`, each on `(enrollment_id, coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid))` | — |
| R2 | every `.ts` file under `apps/server/src` | — | name a per-enrollment open-session index, or take the next-session lock without its path (`` `next-session:${enrollmentId}` ``) |

## Rules that are not import rules

- **R3 — The main path asks no word an active target holds.** A filter in `readMain`, not a name a
  regex can see: enforced by `tests/integration/services/sessions.targets.test.ts` and
  `src/services/sessions.stock.test.ts`.
- **R4 — Lock order.** A use case that takes several next-session locks takes the main path's,
  then the targets' in id order (`services/stock.ts` `lockPaths`), all before the progress lock.
  One that takes the progress lock (a word out of a target, an unsave, a level's removal) retires
  stocks before it (a skip holds its stock's row, then that lock) and asks for stocks only after it
  (a session end holds that lock, then enqueues its path's stock under the same singleton key,
  whose uncommitted row a stately insert waits on). Enforced by review, the call orders
  `src/services/targets.test.ts` asserts, and `tests/integration/services/sessions.targets.test.ts`
  ("a removal beside a session end").

## How to detect a violation

`npm run lint:arch` runs the commands below alongside the other ADRs';
`scripts/check-adr-0014-sessions-belong-to-a-path.sh` mirrors this block verbatim. Paste the block
at the repo root, then run `r1` and `r2`: each must print nothing.

```bash
# R1 — the open-session indexes are per path: both named, both on the path's expression.
r1() { { [ "$(grep -cE "uniqueIndex\('sessions_one_(stock|started)_per_path'\)" apps/server/src/db/schema.ts)" = 2 ] || echo "apps/server/src/db/schema.ts: the per-path open-session indexes are not both declared"; [ "$(grep -cF ".on(t.enrollmentId, sql\`coalesce(\${t.targetId}, '00000000-0000-0000-0000-000000000000'::uuid)\`)" apps/server/src/db/schema.ts)" = 2 ] || echo "apps/server/src/db/schema.ts: the open-session indexes are not on the path"; }; }

# R2 — nothing names a per-enrollment open session or takes the next-session lock without its path.
r2() { grep -rnE --include='*.ts' 'sessions_one_(stock|started)_per_enrollment|next-session:\$\{enrollmentId\}`' apps/server/src; }
```

### What the rules cover

- R1 reads `apps/server/src/db/schema.ts` only, and fails when either declaration is missing, not
  only when a wrong one is present.
- R2 scans every `.ts` file under `apps/server/src`, tests included. `db/migrations/` is `.sql`
  and its snapshots `.json`, so the history that drops the old indexes is out of the scan.
- `apps/mobile`, `packages/core` and `bots/` hold no session table or lock, and no command scans them.

## Why

- **R1 looks like schema detail and is the rule.** The indexes, not a read-then-insert check, are
  what turn a second open session of a path into SessionOpen under a race; dropped to a
  per-enrollment index, a target's stock and the main path's could not coexist.
- **R2's lock key looks cosmetic.** A key without the path serializes every path's stock behind
  one another and lets a stale per-enrollment caller skip the path's own lock.

## Related

- [ADR 0001](adr-0001-layered-architecture.md) R8 — one transaction per use case: a path's stock
  is written with its `session_targets` row and its preparation job.
- [ADR 0007](adr-0007-background-jobs.md) R2 — the stock job is enqueued through `repo/jobs.ts`,
  its singleton key per path.
- [ADR 0010](adr-0010-single-container-migrations.md) — the old container's sessions, with no
  `target_id`, are the main path's.
- [ADR 0013](adr-0013-learner-day.md) R1 — a target's days are learner days.
