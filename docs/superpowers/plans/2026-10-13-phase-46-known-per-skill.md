# Phase 46 — Known per skill, known for good: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Victor said "go till PR": this plan runs inline with superpowers:executing-plans.

**Goal:** A skill counts once its stability has reached `KNOWN_STABILITY`, and a meaning once known stays known, family or not.

**Architecture:** `gloss_memory.reached_on` is set by the one pure `applySession` (so the live path and the recompute agree and the recompute rebuilds it); `vocabulary_entries.known_at` is stamped by `stockNext`'s refresh for every saved gloss; the families rule reads both. `gloss_family_members.known_at` stays but is no longer read or written (ADR 0010's rollout minute).

**Tech Stack:** TypeScript, Drizzle/Postgres, Jest.

**Spec:** `docs/superpowers/specs/2026-10-13-lang-tutor-phase-46-known-per-skill-design.md`

## Global Constraints

- `KNOWN_STABILITY` (7) from `apps/server/src/domain/chooseConstants.ts`; no second literal outside the migration.
- Migration `0032_known_per_skill`; it never drops `gloss_family_members.known_at` (ADR 0010).
- ADR 0001 R3: `domain/` stays pure. ADR 0002: no randomness or clock reached for in services.
- No lane is free (all 9 in use): run unit tests and typecheck directly; run an integration file with `TEST_DB_PREFIX=t_p46_ npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath <file>`, then drop `^t_p46_` databases. Never touch `lang_tutor`. CI runs the full integration and e2e suites.
- Unit file: `npm exec -w apps/server -- jest --selectProjects=unit --runTestsByPath src/domain/<file>.test.ts`.

## Review Focus

- A gloss reviewed once at ≥ 7 then lapsing in the same session keeps its `reachedOn` (Task 1 test).
- A gloss whose every skill lapsed after `known_at` was stamped stays known (Task 3 test).
- A gloss with no family that becomes known gets `known_at`, and a later-saved sibling then waits behind nothing (Task 3 integration).
- The old container's member upsert still names `known_at`: the column must remain (Task 2 migration test asserts it exists).
- An enrollment with no memory at all: no gloss known, nothing stamped, no write (Task 3 test).

---

### Task 1: `reachedOn` in memory

**Files:** `apps/server/src/domain/memoryUpdate.ts` (+ test), `apps/server/src/repo/memory.ts`, `apps/server/src/db/schema.ts` (`glossMemory.reachedOn: date('reached_on', { mode: 'string' })`).

**Produces:** `MemoryRow = { glossId; dimension; state: MemoryState; reachedOn: string | null }`.

- [ ] Failing tests in `memoryUpdate.test.ts`: a first Good review (stability 2.3) leaves `reachedOn` null; Good on day 0 then Good on day 1 (7.3) sets `reachedOn` to day 1; then an Again on day 4 keeps day 1; a row arriving with `reachedOn` keeps it whatever the review.
- [ ] Implement: in `applySession`, `const reachedOn = previous?.reachedOn ?? (state.stability >= KNOWN_STABILITY ? day : null)`. Every `MemoryRow` literal in tests gains `reachedOn: null`.
- [ ] Repo: `findRows` maps `reached_on`; `upsertRows` writes it in values and in the conflict `set`.
- [ ] Run the unit file, `day.test.ts`, server unit project, `npm run typecheck --workspace apps/server`. Commit `feat(domain): memory dates the day a skill first reached the bar (phase 46 D1)`.

### Task 2: Migration 0032 and the per-gloss column

**Files:** `apps/server/src/db/schema.ts` (`vocabularyEntries.knownAt: timestamp('known_at', { withTimezone: true })`; a comment on `glossFamilyMembers.knownAt`: no longer read or written since phase 46, kept for ADR 0010's rollout minute, to drop later), `apps/server/src/db/migrations/0032_known_per_skill.sql` (+ snapshot, journal) via `npx drizzle-kit generate --name known_per_skill` in `apps/server`, then append the spec's two `UPDATE` statements with their comments; `apps/server/tests/integration/db/migrations.test.ts`.

- [ ] Failing migration test: after 0032, a `gloss_memory` row seeded at stability 8 before it has `reached_on = last_day`, one at 5 has null; a member's `known_at` is copied to its entry; `gloss_family_members.known_at` still exists.
- [ ] Generate, append the backfill, run the test under `t_p46_`. Commit `feat(db): reached_on per skill, known_at per gloss, with their backfill (phase 46 D3, D4)`.

### Task 3: The families rule reads reached and known_at; the refresh stamps every gloss

**Files:** `apps/server/src/domain/glossFamilies.ts` (+ test), `apps/server/src/domain/glossFamilyRecord.ts` (+ test), `apps/server/src/repo/glossFamilies.ts`, `apps/server/src/repo/vocabulary.ts`, `apps/server/src/domain/session.ts` (`SavedGloss.knownAt: string | null`), `apps/server/src/services/sessions.ts` (`stockNext`), `tests/support/fakes.ts`, the families integration tests (`tests/integration/services/sessions.families.test.ts`, `tests/integration/repo/glossFamilies.test.ts`, the vocabulary repo test).

**Interfaces:**
- `FamilyInput.memory` rows carry `reachedOn: string | null`.
- `knownFrom(speakable, rows, live)`: every live skill (spoken productive only when speakable) has a row with `reachedOn !== null || state.stability >= KNOWN_STABILITY`.
- `glossFamilies` evaluates every saved gloss: `newlyKnown` = saved glosses with `knownAt === null` that are known by `knownFrom`. Family states read `known` = `knownAt !== null || newlyKnown.has`.
- `FamilyEvidence` gains `reached: Partial<Record<Dimension, string>>`; `FamilyEventEvidence` likewise.
- `StoredFamilyView` / repo `StoredMember` / both `FamilyWrite.members` lose `knownAt`; a member is written only when its family, state or position changes.
- `vocabulary.listSavedGlosses` returns `knownAt`; `vocabulary.markKnown({ enrollmentId, glossIds, at }): Promise<void>` sets `known_at = at` where null.
- `stockNext`: `knownAt` from the saved gloss; after `insertPreparingSession`, `markKnown` for `families.newlyKnown` when not empty (`at` = `new Date(at).toISOString()`), then the families write.

- [ ] Failing unit tests: a lapsed skill with `reachedOn` counts; a gloss in no family is in `newlyKnown`; a gloss with `knownAt` and every skill lapsed is known; evidence has `reached`; no memory → nothing known; in `familyChanges`, a member turning known writes its row and one `→ known` event, and an unchanged member writes nothing.
- [ ] Failing integration tests: `markKnown` sets only nulls; session creation stamps a known gloss in no family; a family reads the gloss's `known_at`.
- [ ] Implement; run the unit files, server unit project, the integration files under `t_p46_`, typecheck, `npm run lint:arch`. Commit `feat(server): known per skill, and known for good per gloss (phase 46 D2, D3, D5)`.

### Task 4: Day tests with phase 37's learner

**Files:** `apps/server/src/domain/day.test.ts`.

- [ ] The runner's memory rows carry `reachedOn` through `applySession`; `knownAt` lives per gloss in the runner (not per family member). The families-over-days run drops its `missEvery: 10` override and uses phase 37's 5; it asserts the second meaning arrives as `new_meaning` after the first is known. Run; commit `test(domain): the families run unlocks with phase 37's learner (phase 46 D6)`.

### Task 5: Verify and record

- [ ] `npm test`, typecheck, `lint:arch`; drop `^t_p46_` databases; fill the spec's "As built"; commit `docs(spec): phase 46 as built`.
