# Phase 46 — Known means each skill reached the bar once, and stays known

- **Status:** Designed on 2026-10-13. Victor made the two decisions in the conversation that followed phase 39
  (PR #144), then said "go till PR": the design is self-approved (CLAUDE.md, *Continue till PR*).
- **Date:** 2026-10-13
- **Builds on:** phase 39 (PR #144: gloss families, `KNOWN_STABILITY`, "known once, known for the family"),
  phase 35 (memory, `applySession`, the recompute) and phase 43 (PR #148: `stockNext`, where the refresh now runs).
- **Touches:** `domain/memoryUpdate.ts`, `domain/glossFamilies.ts`, `domain/glossFamilyRecord.ts`; the memory,
  vocabulary and families repos; `stockNext` in `services/sessions.ts`; migration 0032; the day tests. No wire
  change, no app change, no new secret.

---

## Goal

Phase 39 holds a word's next meaning back until its current meaning is **known**: every live skill at stability
≥ `KNOWN_STABILITY` (7) **at the same moment**, and "known once, known for the family" recorded only for glosses
already in a family. Two weak spots:

- **One slip resets the wait.** A miss drops that skill to about 1, and it climbs back only through a right answer
  on a later day. On a list asked many times a day some skill is nearly always mid-recovery. On lane 0 on
  2026-10-13: 63 glosses in 20 families, 42 waiting, **1** ever known. Phase 39's day tests found that a learner who
  misses one card in five never unlocks a second meaning.
- **Known for good covers family members only.** A meaning learned alone (say pick up → להרים) has no `known_at`;
  saving pick up → לאסוף weeks later judges להרים from that day's memory, and one lapsed skill makes לאסוף wait. A
  gloss also loses its `known_at` when its family dissolves.

Victor's decisions:

1. **Each skill counts once it has reached 7**, even if it later slips. A meaning is known once every live skill
   has reached the bar at some point.
2. **Once known, a meaning stays known for good**, whether or not it had a sibling at the time.

**Done means:**

1. A skill that has reached 7 keeps counting after a lapse (D1, D2).
2. A meaning known once stays known, family or not, and a family reads that (D3).
3. Phase 39's families-over-days simulation, run with phase 37's learner who misses one card in five, now brings
   the second meaning (D6).

`npm test`, `npm run test:all`, `npm run lint:arch` and `npm run e2e` pass.

## Scope

**In:** the per-skill reached date, the per-gloss known date, the migration with its backfill, the day test.

**Out:** the bar itself (every live skill, `KNOWN_STABILITY` 7, speaking only when speakable); the families rule's
structure (D1–D5 of phase 39); the `new_meaning` card; any app or wire change; dropping the old
`gloss_family_members.known_at` column (D4).

---

## D1. A skill's reached date

`gloss_memory` gains `reached_on date`, nullable: the learner day on which this gloss and dimension's stability
first reached `KNOWN_STABILITY`. It is never cleared.

`MemoryRow` (`domain/memoryUpdate.ts`) gains `reachedOn: string | null`. `applySession` keeps a row's `reachedOn`,
and sets it to the session's `day` when it is null and the review leaves stability ≥ `KNOWN_STABILITY`.

The live path (`recordProgress`) and the recompute (`db/progressRecompute.ts`) both run `applySession`, so the
recompute, which deletes memory and replays every ended session, rebuilds `reached_on` exactly from the answer
history. That is the "rebuildable from history" Victor asked for, at no extra cost.

The memory repo reads and writes the column; an upsert sets it with the rest of the row.

## D2. Known

A gloss is **known** when its `known_at` is set (D3), or when every live skill has **reached** the bar:

- a skill has reached it when its memory row has a `reached_on`, or its stability is ≥ `KNOWN_STABILITY` now (the
  second arm covers rows written without a date: by the old container during a rollout, or inserted directly);
- the live skills are the session's, as in phase 39: written receptive, written productive and spelling always,
  spoken receptive with listening, spoken productive with speaking when the gloss is speakable.

`knownNow` (`domain/glossFamilies.ts`) reads this; a row's current stability no longer has to be ≥ 7 for a skill
that reached it before.

## D3. Known for good, per gloss

`vocabulary_entries` gains `known_at timestamptz`, nullable: when a refresh first saw the gloss known.

- `glossFamilies` evaluates **every** saved gloss, not only family members: `newlyKnown` holds every saved gloss
  without `known_at` that is known by D2. Families read `known_at` from the saved gloss (`FamilyGloss.knownAt`).
- `listSavedGlosses` returns `knownAt`. A new `vocabulary.markKnown({ enrollmentId, glossIds, at })` sets
  `known_at = at` where it is null. `stockNext` calls it in the transaction that records the refresh, after the
  session row exists, for `newlyKnown` when it is not empty.
- `gloss_family_members.known_at` is no longer read or written: `StoredFamilyView`, `FamilyWrite` and the repo's
  member upsert drop it. A member row changes only when its family, state or position does.
- A newly known **family member** still logs its `→ known` event, with its evidence; a gloss in no family has no
  family event, and its `known_at` is its trace.

## D4. Migration 0032 and the old column

`0032_known_per_skill.sql`:

```sql
ALTER TABLE gloss_memory ADD COLUMN reached_on date;
-- Phase 46 (spec D4). A skill at KNOWN_STABILITY (7) today has reached it; last_day is the best date at hand.
-- A skill that reached it and has since slipped is found only by the recompute's replay (Left for Victor).
UPDATE gloss_memory SET reached_on = last_day WHERE stability >= 7;
ALTER TABLE vocabulary_entries ADD COLUMN known_at timestamptz;
-- Phase 39 stamped known_at on family members only; it moves to the gloss.
UPDATE vocabulary_entries ve SET known_at = m.known_at
FROM gloss_family_members m
WHERE m.enrollment_id = ve.enrollment_id AND m.gloss_id = ve.gloss_id AND m.known_at IS NOT NULL;
```

`gloss_family_members.known_at` **stays**: during a rollout the old container serves for about a minute after the
new one migrates (ADR 0010), and its refresh reads and writes that column. Dropping it is a later phase's one-line
migration, once no deployed code names it. Its schema comment says so.

## D5. Evidence

A family event's evidence gains `reached: { <dimension>: <learner day> }` beside `stability`, so "why is this
meaning still current?" shows which skill has not reached the bar.

## D6. Testing

**Unit.**
- `memoryUpdate.test.ts`: a review that leaves stability ≥ 7 sets `reachedOn` to the day; a later review keeps it,
  a lapse included; one below 7 leaves it null; an existing `reachedOn` is never moved.
- `glossFamilies.test.ts`: a lapsed skill with `reachedOn` still counts; a skill at ≥ 7 with no `reachedOn` counts;
  a gloss in no family is in `newlyKnown` when known; `knownAt` from the gloss holds after every skill lapsed;
  evidence holds `reached`.
- `glossFamilyRecord.test.ts`: members carry no `knownAt`; a newly known member logs one `→ known` event.

**Integration.**
- the memory repo round-trips `reached_on`;
- `listSavedGlosses` returns `known_at`; `markKnown` sets it only where null;
- the migration test: 0032 backfills `reached_on` for a row at ≥ 7 and not below, and moves a member's `known_at`
  to its entry;
- the recompute rebuilds `reached_on` on the day stability first reached 7, and keeps it after a later lapse;
- session creation stamps `known_at` on a known gloss in no family, and a family reads it.

**Day tests.** The families-over-days run uses phase 37's learner, a miss every fifth card, instead of phase 39's
one in ten, and asserts that the second meaning still arrives, as a `new_meaning` card, after the first is known.

No e2e change is expected: the app and the wire are unchanged.

## Left for Victor

After merge, from the main checkout:

```bash
git pull
npm run db:migrate              # lane 0 gets 0032
npm run db:progress:recompute   # optional, recommended: dates every skill that reached 7 and has since slipped
# restart lane 0's server
```

The recompute rebuilds memory and levels from the answer log exactly as phase 35's command always has; with this
phase it also dates `reached_on`. Without it, a skill that reached 7 and has since slipped counts only once it
climbs back. Production can take the same command from the laptop (`DATABASE_URL="$PROD_DB" npm run
db:progress:recompute`, the hosting runbook's pattern).

## Risks

- **Second meanings come sooner, by design.** A meaning whose skills each reached 7 once, at different times,
  unlocks its sibling. That is decision 1; `KNOWN_STABILITY` stays the knob.
- **The backfill dates are approximate** (`last_day`). Nothing reads the date except the evidence; the recompute
  makes them exact.
- **Two `known_at` columns until a later phase drops the old one** (D4). Only `vocabulary_entries.known_at` is read.

## As built

Rulings made while building. The text above stands unless a line here says otherwise.

- **The gloss-merge tool keeps the earliest of each (D1, D3).** `repo/glosses.ts` folds two glosses one
  enrollment saved; per dimension it still keeps the row with the larger stability, but `reached_on` becomes the
  earlier of the two rows' dates, and the surviving entry's `known_at` the earlier of the two entries'. A skill
  reached, or a gloss known, under either gloss was reached or known.
- **`markKnown` runs only when something is newly known (D3)**, as the spec says; a refresh that stamps nothing
  touches `vocabulary_entries` not at all.
- **`familyChanges` no longer takes the clock.** Its `at` existed only for `known_at`, which `stockNext` now
  stamps on the gloss with the same `now()`.
- **The families-over-days run lasts twenty-five days, not ten (D6).** With phase 37's learner, missing every
  fifth card, the five-meaning word is asked in all six sessions a day; it is known on day 20 (session 118), and
  its second meaning arrives as `new_meaning` in that session. The homograph's first meaning is known on day 3
  (session 15). Five days past day 20 keep a day's drift in the picker from turning the test red. Under phase
  39's rule (shown by removing the reached arm) no second meaning ever came, sixty days included.
- **Support helpers (ADR 0004).** The families service test reads `known_at` and dates `reached_on` through
  `readKnownAt` and `setReachedOn` in `tests/support`, not raw SQL.
- **No lane was free** while building: unit tests, typecheck and the ADR checks ran locally, every touched
  integration file ran under its own `TEST_DB_PREFIX`, and CI runs the full integration and e2e suites.
