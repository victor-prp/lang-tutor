# Homework sessions ready between sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A homework learner finds the next session ready when one ends, and a session grown by
its step-downs prepares instead of failing.

**Architecture:** Two fixes to phase 68 (PR #231). (1) A miss no longer re-asks the stock job and
nothing replaces a stock for its step-downs: a step-down missed in session N is asked by the stock
chosen when N+1 starts. (2) The prepare job's payload takes the picks the picker can choose, a
full session plus its step-downs on top.

**Tech Stack:** TypeScript, zod, Jest (unit + integration with pg-boss on a test Postgres).

**Spec:** `docs/superpowers/specs/2026-10-21-lang-tutor-phase-68-step-down-design.md` (D2, D6),
amended by Task 2's ruling. Evidence: lane 0 logs 2026-10-21 23:17 → 2026-10-22 01:39 — 6 of 7
homework completions waited 16–57 s (0 of 31 the day before, but one 28 s); 15 of 17 stale
retirements came from the miss-asked stock job; five prepare jobs dead-lettered on
`picks: Too big: expected array to have <=10 items` (11 picks: 10 + one practice step-down).

## Global Constraints

- `STEP_DOWNS_PER_SESSION` stays 3, `SESSION_LENGTH` stays 10; the picker is unchanged.
- `STOCK_REASONS` keeps `'miss'`: a stock job queued before the deploy must still parse.
- `session_targets.step_downs` is still written (derived state is recorded, phase 39).

## Review Focus

- A stock chosen on an earlier learner day is still replaced at serve time when its cap or owed
  words differ (phase 53) — Task 2 keeps `stockToCheck`/`stockServes`' other comparisons.
- A practice-more stock is still replaced when a miss leaves owed work it does not serve (ruling
  T3-m) — Task 2 keeps the owed-words comparison; its existing test stays.
- A step-down is not lost by being skipped once: the next stock chosen asks it — Task 2's
  "next start" test.

---

### Task 1: the prepare payload takes a session grown by its step-downs

**Files:**
- Modify: `apps/server/src/domain/jobs.ts` (picks `.max`)
- Test: `apps/server/src/domain/jobs.test.ts`, `apps/server/src/domain/targetPicker.test.ts`

**Interfaces:**
- Produces: `MAX_SESSION_PICKS = SESSION_LENGTH + STEP_DOWNS_PER_SESSION` (13), exported from
  `domain/jobs.ts`.

- [ ] **Step 1: Failing tests.** jobs.test: `PrepareSessionPayloadSchema` parses a payload of
  `SESSION_LENGTH + 1` picks and of `MAX_SESSION_PICKS` picks, and refuses `MAX_SESSION_PICKS + 1`.
  targetPicker.test (step-downs describe): a full owed session (8 owed words, `slotsOf === SESSION_LENGTH`)
  with four step-downs on done words gets `MAX_SESSION_PICKS` picks.
- [ ] **Step 2: Run** `npx jest --selectProjects=unit src/domain/jobs.test.ts src/domain/targetPicker.test.ts` — the 11-pick parse fails.
- [ ] **Step 3: Implement** `.max(MAX_SESSION_PICKS)`, with a phase 68 D2 comment.
- [ ] **Step 4: Run** the same — PASS.
- [ ] **Step 5: Commit** `fix(sessions): prepare a target session grown past ten picks by its step-downs`.

### Task 2: a miss keeps the next session

**Files:**
- Modify: `apps/server/src/services/sessions.ts` (submitAnswer's miss request; `replaceForStepDowns`
  and its call in `stockSession`), `apps/server/src/domain/targetPicker.ts` (`stockServes`,
  `sameStepDowns`), `apps/server/src/domain/jobs.ts` (`'miss'` comment)
- Modify: `docs/superpowers/specs/2026-10-21-lang-tutor-phase-68-step-down-design.md` (D6 ruling)
- Test: `apps/server/tests/integration/services/sessions.stepDown.test.ts`,
  `apps/server/src/domain/targetPicker.test.ts`, `apps/server/tests/support/sessionRows.ts` (`markReady`)

- [ ] **Step 1: Failing tests** in sessions.stepDown.test (describe renamed "a miss on a target path keeps the next session"):
  - a miss asks for no stock: `boss.fetch(STOCK_SESSION)` is `[]`, the stock is still `preparing`;
  - the session's end, last card missed, keeps the stock: the `complete` job leaves it `preparing` and logs no `session_retired`;
  - the next start's stock asks the step-down: the kept stock made ready (`markReady`) and started, the `start` job's stock records `apple|written_productive`;
  - the practice-more-on-top case, rebuilt on that flow (same expected picks);
  - right answer → no stock, and the board case, unchanged.
  targetPicker.test: `stockServes` serves a stock whatever step-downs it or today asks.
- [ ] **Step 2: Run** `npm run test:integration -- --runTestsByPath tests/integration/services/sessions.stepDown.test.ts` and the picker unit test — the new ones fail.
- [ ] **Step 3: Implement.** Drop the miss/tap `requestStock` block in submitAnswer; `stockSession`
  answers `{ why: 'stocked' }` for any stock; delete `replaceForStepDowns`; `stockServes` drops
  `sameStepDowns`, which goes. Comments say why (the ruling). Spec D6 gets
  `Ruling (2026-10-22, Victor): …`.
- [ ] **Step 4: Run** the step-down, stock and picker tests, then `npm test` and `npm run typecheck` — PASS; `npm run lint:arch` clean.
- [ ] **Step 5: Commit** `fix(sessions): a miss keeps the prepared next session; its step-down waits a session`.
