# Phase 68 Step-Down Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Homework (a target's path) steps a missed skill down to see it, pick it, produce it in the next session, holds each type to 4 a session, and gets a matching board.

**Architecture:** A pure `domain/stepDown.ts` reads the path's answers into open step-downs; the target picker asks them first as `relearn` picks (slot-free, at most 3) and caps speaking and spelling picks; `planCards` turns a relearn pick into its cards, caps target types within the rung and adds a board. A miss on a target path asks the stock job (reason `miss`), which replaces a stock whose recorded step-downs (`session_targets.step_downs`) differ.

**Tech Stack:** TypeScript, Jest (unit + integration on the lane's Postgres), drizzle, pg-boss.

**Spec:** `docs/superpowers/specs/2026-10-21-lang-tutor-phase-68-step-down-design.md`

## Global Constraints

- `STEP_DOWNS_PER_SESSION = 3` and `MAX_PER_TYPE = 4` (existing), named in `chooseConstants.ts` / `plan.ts`.
- Reward rules unchanged: no edit to `gradesFor`, `applyReadiness`, `readinessSessionWrite`.
- Main path unchanged: every new branch is behind `target` (plan) or the target picker.
- Domain stays pure (ADR 0001 R3); a session belongs to its path (ADR 0014); jobs enqueued only through `repo/jobs.ts` (ADR 0007).
- Migration `0048_session_targets_step_downs.sql`: `step_downs text[]` nullable.

## Review Focus

- A word missed twice in one session owes one step-down per skill, not two (Task 1 test).
- A device that cannot listen never gets a spelling step-down asked (Task 2 test: dropped when not practised).
- A word taken out of the target after its miss gets no relearn pick (Task 2 test: not in the day).
- Five misses: three step-downs this session, the oldest misses first (Task 2 test).
- A word with no tiles and no gap, in a session that cannot speak: two cards, reverse choice then its recall card (Task 3 test).

---

### Task 1: Open step-downs (D1)

**Files:** Create `apps/server/src/domain/stepDown.ts`, `apps/server/src/domain/stepDown.test.ts`.

**Interfaces:**
- Produces: `type StepDown = { glossId: string; dimension: Dimension }`;
  `produces(type: QuestionType, dimension: Dimension): boolean` (the type is `dimension`'s card at the picker's rung: `RUNGS[dimension][rung-1]` with rung 1 for spelling, 2 otherwise);
  `openStepDowns(input: { answers: readonly (GradableAnswer & { glossId: string })[]; unanswered: readonly { glossId: string; type: QuestionType; intro: boolean }[] }): StepDown[]`, oldest miss first.
- `rungOf` moves from `targetPicker.ts` to `stepDown.ts` (exported), so both read one rule.

- [ ] Step 1: tests in `stepDown.test.ts`: a wrong typed translation opens writing; a wrong dictation opens spelling; a gave-up say translation opens speaking; a wrong reverse choice opens writing; a near miss, an alternative, a skip and an intro card open nothing; a later right produce card of the skill closes it, a right pick card (reverse choice) does not; two misses of one word and skill give one step-down, ordered by the latest miss; an unanswered produce card in flight closes it; a matching or multiple-choice miss opens nothing (no served skill).
- [ ] Step 2: run `npx jest --selectProjects=unit src/domain/stepDown.test.ts` from `apps/server`: FAIL (module missing).
- [ ] Step 3: implement. A miss: `correct === false`, or verdict `wrong` / `gave_up`; right: `correct === true`, or verdict `exact` / `near_miss` / `understood`. Skill: `servedSkill(type)`; null skips.
- [ ] Step 4: run again: PASS. Commit `feat(server): phase 68 open step-downs from a path's answers`.

### Task 2: The picker asks step-downs and caps speaking and spelling (D3, D4)

**Files:** Modify `apps/server/src/domain/targetPicker.ts`, `choose.ts` (`ChosenPick.relearn?: boolean`), `chooseConstants.ts` (`STEP_DOWNS_PER_SESSION = 3`); test `targetPicker.test.ts`.

**Interfaces:**
- Consumes: `StepDown`, `rungOf` (Task 1).
- Produces: `TargetPickInput.stepDowns?: readonly StepDown[]`; a relearn pick is `{ glossId, dimension, rung: rungOf(dimension), level, r: 1, cls: 'TARGET', ladder: false, relearn: true }`.

- [ ] Step 1: tests: step-downs come first in every mode, take no slot (a full owed session still holds them), at most 3 (the first three given), each one of its word's two picks and taking its skill out of the word's owed skills; a step-down whose word is not in the day, or whose skill is not practised, is dropped; a fifth speaking pick in a session goes to the word's next skill (owed mode and practice more), a word with no other skill waits; spelling the same; step-downs count toward the cap. Update the existing "no limit on speaking" expectations to the cap.
- [ ] Step 2: run `npx jest --selectProjects=unit src/domain/targetPicker.test.ts src/domain/targetBudget.test.ts`: FAIL.
- [ ] Step 3: implement: a `stepDown()` pass before `start`; `add` takes a `relearn` flag (no slot); a per-dimension count for `spoken_productive` and `spelling` checked in `owedWork`, `hardest`, `start` (known word) and `firstSay`, each falling to the word's next skill in its own order.
- [ ] Step 4: run again, plus `src/domain/day.test.ts`: PASS (day marks unchanged or better; never lower a mark). Commit `feat(server): phase 68 the target picker asks step-downs first and holds speaking and spelling to four`.

### Task 3: planCards: relearn cards, the target cap, the board (D2, D4, D5)

**Files:** Modify `apps/server/src/domain/plan.ts`; test `plan.test.ts`.

**Interfaces:**
- Produces: `PlanPick.relearn?: boolean`; `relearnCards(pick: Pick<PlanPick, 'dimension' | 'tiles' | 'speakable' | 'clozeGap' | 'r' | 'step'>, speaking: boolean, used: ReadonlyMap<QuestionType, number>, listening: boolean): { see: QuestionType | null; pick: QuestionType; produce: QuestionType }`.

- [ ] Step 1: tests: a writing relearn with tiles in a speaking session is read aloud, then a pick card (least used of reverse choice / choose-the-gap / letter tiles, ties in that order: reverse choice first), then a recall card, in that order with another card between each where the session has one; a session that cannot speak drops read aloud; spelling: letter tiles, else reverse choice, then dictation; speaking ends on say translation; read aloud ignores its level limit; target cap: six writing picks spread over typed translation, gap and sentence, no type past four, and a rung with every type full keeps its card (never multiple choice); a target session with four met words of distinct meanings gets one matching board of them as an extra card, relearn words first; no board with three, none on a ladder word, and the main path's board rules unchanged.
- [ ] Step 2: run `npx jest --selectProjects=unit src/domain/plan.test.ts`: FAIL.
- [ ] Step 3: implement: relearn picks join the stream (sees with the intros, picks and produces between the ladder practice stages); `cardFor` on a target tries the rung capped, then the rung uncapped, then the other rung; the target board from non-ladder picks via `boardPicks`, relearn ones first, its unit an extra card over picks that keep their own.
- [ ] Step 4: run again: PASS. Commit `feat(server): phase 68 planCards asks a step-down as see, pick, produce, caps target types and adds a board`.

### Task 4: Plumbing and the stock (D3, D6)

**Files:** Modify `apps/server/src/domain/jobs.ts` (pick `relearn` optional; `STOCK_REASONS` gains `miss`), `services/sessions.ts` (choosePicks, prepare job, readTarget's T3-m check reads non-relearn picks, stock job `miss`, submitAnswer), `services/targetDayRead.ts` (stepDowns), `repo/sessions.ts` (`findPathAnswers(enrollmentId, targetId)`; `findSessionCards` gains `answered: boolean`), `repo/targets.ts` + `db/schema.ts` + migration `0048` (`step_downs`), `domain/targetPicker.ts` (`StockChoice.stepDowns`, `stockServes` compares), `domain/session.ts` / `SessionTargetRow` (stepDowns). Tests: new `tests/integration/services/sessions.stepDown.test.ts`; update `sessions.targets.test.ts` ("a miss: it adds no card").

- [ ] Step 1: integration tests: a wrong answer on a target path asks a `miss` stock job; running it retires the stock chosen at the start and writes one whose `session_targets.step_downs` is `[glossId|written_productive]` and whose prepare payload has that word's pick with `relearn: true`; a right answer asks none; a `miss` job whose stock already records the step-down keeps it; the prepare job plans a relearn pick as read aloud, a pick card and a recall card. Unit: `stockServes` false when step-downs differ.
- [ ] Step 2: run `npm run test:integration -- --runTestsByPath tests/integration/services/sessions.stepDown.test.ts` from `apps/server`: FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: run again plus `sessions.targets.test.ts`, `stockSession.test.ts`, `prepareSession*.test.ts`: PASS. Commit `feat(server): phase 68 a miss on a target path restocks with its step-down`.

### Task 5: Whole-branch verification

- [ ] `npm test`, `npm run test:integration`, `npm run typecheck` (or the repo's equivalent), `npm run lint:arch` from the root: all pass.
- [ ] Day simulation (`src/domain/day.test.ts`): compare five-phase aggregates with master; no mark lowered.
- [ ] Commit any fixes; then `superpowers:finishing-a-development-branch` → `git-create-pr` → `ci-green`.
