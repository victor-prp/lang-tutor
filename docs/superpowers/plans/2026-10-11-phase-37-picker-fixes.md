# Phase 37 picker fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Victor said "go till PR": this plan runs inline with superpowers:executing-plans.

**Goal:** Same-day returns as recall cards, recall decided by memory, a load-aware new-word reserve, a speaking pick, done words last, and the bots' (c) and (d) on the new rules.

**Architecture:** One new pure module, `domain/today.ts`, turns today's answers into the returns owed and the done set. `chooseWords` takes them and runs a new fill order. `planCards` asks returns last. Two repo queries replace phase 35's "asked today" and "new today" reads. The bots' analysis imports `dayState` and the new rung rule.

**Tech Stack:** TypeScript, Jest (server unit + integration), node:test (bots), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-10-11-lang-tutor-phase-37-picker-fixes-design.md`

## Global Constraints

- ADR 0001 R3: `domain/` imports `@lang-tutor/core/*` and its own siblings only, test files included. No `../`, no `Date.now`, no `Math.random`.
- ADR 0004: server unit tests are `src/**/*.test.ts` with no database; integration tests are under `tests/integration/`.
- ADR 0013: the day comes from `learnerDay`; nothing new computes a day.
- Constants live in `chooseConstants.ts`: `NEW_FLOOR = 1`, `NEW_PER_SESSION = 3`, `DAY_NEW_CAP = 15`, `RETURNS_PER_DAY = 3`, `SPEAKING_PER_SESSION = 1`, `PER_DIMENSION_CAP = 4` (expansions only), `RUNG_R = 0.75`, `HARD_CAP = 4`.
- The job payload stays backward compatible: `step` defaults to `false`.
- Never hardcode a port or a database name; run lane commands through the npm scripts.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A return whose dimension is not live this session (speaking turned off between sessions): it waits and is neither picked nor counted as done. Pinned in Task 2.
2. A one-word or two-word list on a heavy day: the session is never empty while saved words remain (pass 10 after DONE). Pinned in Task 2.
3. A job enqueued before the deploy (no `step` in its picks): it parses and plans as before. Pinned in Task 4.
4. A gloss answered today only with a skipped or alternative verdict: done, never a return. Pinned in Task 1.
5. Siblings with one normalised key, one of them a return: one pick per key still holds. Pinned in Task 2.

---

### Task 1: Same-day returns (`domain/today.ts`)

**Files:**
- Create: `apps/server/src/domain/today.ts`, `apps/server/src/domain/today.test.ts`
- Modify: `apps/server/src/domain/chooseConstants.ts` (add `RETURNS_PER_DAY = 3`)

**Interfaces:**
- Produces:
  - `type DayAnswer = GradableAnswer & { glossId: string; sessionId: string }`
  - `type Step = { glossId: string; dimension: Dimension; opened: number }`
  - `dayState(answers: readonly DayAnswer[], introduced: ReadonlySet<string>): { steps: Step[]; done: Set<string> }`

- [ ] **Step 1: Write the failing tests** in `today.test.ts`. Helpers: `mc(g, s, right)` and `typed(g, s, verdict, type = 'typed_translation')` build `DayAnswer`s. Cases:
  - a gloss introduced in s1 and answered right owes WR: `steps = [{ glossId: 'a', dimension: 'written_receptive', opened: 0 }]`, done empty;
  - introduced in s1, then `typed_meaning` exact in s2: settled, `a` done;
  - introduced in s1, then multiple choice right in s1 again (same session): still owed;
  - not introduced, multiple choice right: done, no step;
  - not introduced, multiple choice wrong in s1: WR owed, opened 0;
  - `typed_translation` near_miss in s2 while WR is owed: WR settled, SP opened at that answer's index;
  - reverse choice wrong (WP Again) in s1, then typed translation wrong in s2, s3 and s4: three returns, done;
  - two returns made and still owed: a step;
  - an Again in a later session replaces the open return's dimension and `opened`;
  - `say_translation` with verdict `skipped` or `alternative` only: done, not a step;
  - steps sorted by `opened` across glosses.

- [ ] **Step 2: Run** `npx jest --selectProjects=unit src/domain/today.test.ts` from `apps/server`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
import { gradesFor, type Dimension, type GradableAnswer } from '@lang-tutor/core/domain';
import { RETURNS_PER_DAY } from './chooseConstants';

export type DayAnswer = GradableAnswer & { glossId: string; sessionId: string };
export type Step = { glossId: string; dimension: Dimension; opened: number };

export function dayState(answers: readonly DayAnswer[], introduced: ReadonlySet<string>): { steps: Step[]; done: Set<string> } {
  type Owed = { dimension: Dimension; sessionId: string; opened: number };
  const tracks = new Map<string, { owed: Owed | null; returns: number }>();
  answers.forEach((answer, index) => {
    let track = tracks.get(answer.glossId);
    if (!track) {
      track = { owed: introduced.has(answer.glossId) ? { dimension: 'written_receptive', sessionId: answer.sessionId, opened: index } : null, returns: 0 };
      tracks.set(answer.glossId, track);
    }
    const grades = gradesFor(answer);
    const owed = track.owed;
    if (owed && owed.sessionId !== answer.sessionId) {
      track.returns += 1;
      if (grades.some((piece) => piece.dimension === owed.dimension && piece.grade >= 2)) track.owed = null;
    }
    for (const piece of grades) if (piece.grade === 1) track.owed = { dimension: piece.dimension, sessionId: answer.sessionId, opened: index };
  });
  const steps: Step[] = [];
  const done = new Set<string>();
  for (const [glossId, { owed, returns }] of tracks) {
    if (owed && returns < RETURNS_PER_DAY) steps.push({ glossId, dimension: owed.dimension, opened: owed.opened });
    else done.add(glossId);
  }
  return { steps: steps.sort((a, b) => a.opened - b.opened), done };
}
```

- [ ] **Step 4: Run** the test again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(domain): same-day returns from today's answers (phase 37 D1)`.

### Task 2: The word choice (`domain/choose.ts`)

**Files:**
- Modify: `apps/server/src/domain/choose.ts`, `apps/server/src/domain/chooseConstants.ts`, `apps/server/src/domain/choose.test.ts`

**Interfaces:**
- Consumes: `Step` from Task 1.
- Produces:
  - `ChoiceInput`: `askedToday` replaced by `steps: readonly Step[]` and `done: ReadonlySet<string>`.
  - `ChoiceClass = 'STEP' | 'NEW' | 'DUE' | 'EXPAND' | 'NOT_DUE' | 'DONE' | 'SPEAK'`.
  - `rungFor(r: number | null): 1 | 2`, exported: `r !== null && r >= RUNG_R ? 2 : 1`. A `STEP` pick is rung 2 regardless.
  - `ChosenPick` unchanged in shape: `{ glossId, dimension, rung, level, r, cls }`. Callers derive `step` as `cls === 'STEP'`.

- [ ] **Step 1: Constants.** Add `NEW_FLOOR = 1` and `SPEAKING_PER_SESSION = 1`, and remove the private `NEW_FLOOR` from `choose.ts`. Rewrite the doc comments of `PER_DIMENSION_CAP` (expansions only) and `RUNG_R` (with memory).

- [ ] **Step 2: Rewrite the tests.** The `input()` helper gains `steps: []` and `done: new Set()`, and defaults to `speaking: false` so only the speaking tests see the speaking pick. Replace or adjust:
  - **Class order** with every class present: `[NEW, STEP, DUE, EXPAND, NOT_DUE, DONE]` as `[new, step, due, expand, not-due, done]`.
  - **Rung by memory** (replaces "chooses the rung by level and R"):
    - level 1 at R 0.85 is rung 2;
    - level 5 at R 0.5 is rung 1;
    - no memory is rung 1;
    - a STEP whose dimension has R 0.5 is rung 2.
  - **Reserve under a backlog:** 12 DUE words and 5 NEW give 1 NEW and 9 DUE.
  - **Reserve with room:** 7 EXPAND words and 10 NEW give 3 NEW in pass 1. Every EXPAND is offered before more NEW.
  - **Daily limit:**
    - unchanged at `DAY_NEW_CAP − 1`;
    - at the limit, no NEW while others fill;
    - past the limit only when the session would be empty: `[known('a', { WP: 0.93 }), known('b', { SP: 0.93 }), ...3 NEW]` at the limit gives `['a', 'b']`;
    - an all-NEW list at the limit still gives its words.
  - **Returns:**
    - a STEP comes before a DUE word with lower R;
    - a STEP in SR with listening off is not picked and not DONE;
    - a STEP sibling sharing a normalised key with a DUE word: one pick, the STEP.
  - **DONE:**
    - a DONE word is never picked while a NOT_DUE word is left;
    - it is picked after what the hard cap held back;
    - in a list of two DONE and one NEW at the limit, the DONE words fill first and the NEW stays out.
  - **Dimension cap:**
    - 8 words EXPAND into SR and 6 written words NOT_DUE: 4 SR expansions;
    - 8 words DUE in SR and 2 written words NOT_DUE: 8 SR picks, since DUE is uncapped.
  - **Speaking pick** (`speaking: true`, N ≥ 2):
    - tier 1: a STEP in SK is the speaking pick;
    - tier 2: of two words DUE in SK, the lower-R one is picked as `DUE` with dimension SK;
    - tier 3: a not-due word with WR memory and no SK memory becomes `SPEAK` in SK, at rung 1, `r: null`;
    - tier 4: with every word DUE in WR, the highest-need one becomes `SPEAK`;
    - none when N < 2;
    - none when no word has memory.
  - Keep: one key per pick, the hard cap, live dimensions, small lists, the tie-break rng, the first-pick shape (now with `cls` from the new classes).

- [ ] **Step 3: Run** `npx jest --selectProjects=unit src/domain/choose.test.ts`. Expected: FAIL on the new cases.

- [ ] **Step 4: Implement** the D3 fill in `chooseWords`:
  - Classify each gloss:
    1. a live step makes it `STEP`, testing the step's dimension;
    2. else no memory makes it `NEW`;
    3. else `DUE`, `EXPAND` or `NOT_DUE` as before;
    4. then a gloss in `done` that is not a live step becomes `DONE`;
    5. a step whose dimension is not live leaves its gloss out of every class.
  - Then:

```ts
const n = Math.min(SESSION_LENGTH, new Set(candidates.map((c) => c.key)).size);
const newLeft = Math.max(0, DAY_NEW_CAP - input.newToday);
const speak = input.speaking && n >= 2 ? SPEAKING_PER_SESSION : 0;
const room = n - speak - steps.length - due.length;
const reserve = Math.min(fresh.length, newLeft, Math.min(NEW_PER_SESSION, Math.max(NEW_FLOOR, room)));
// 1 NEW reserve → 2 speaking pick → 3 STEP → 4 DUE → 5 EXPAND (dimension cap) → 6 more NEW to newLeft
// → 7 NOT_DUE → 8 deferred → 9 DONE → 10 NEW past the limit while picks.length === 0
```

  - Keep one `taken` set of gloss ids beside `keys`.
  - The dimension cap is checked only in pass 5.
  - `HARD_CAP` is checked in passes 3–7, as `offer` does today.
  - The speaking pick runs the four tiers of D4 over candidates not yet taken, excluding `DONE`.
  - Tiers 3 and 4 re-make the pick with `dimension: 'spoken_productive'`, `cls: 'SPEAK'`, and the SK `r`, level and `rungFor`.

- [ ] **Step 5: Run** the choose tests, then `npx tsc --noEmit -p apps/server`. Expected: PASS, apart from `services/sessions.ts`, which still passes `askedToday` (fixed in Task 4).
- [ ] **Step 6: Commit** `feat(domain): choose words with returns, a load-aware reserve and a speaking pick (phase 37 D2–D5)`.

### Task 3: Returns last (`domain/plan.ts`)

**Files:**
- Modify: `apps/server/src/domain/plan.ts`, `apps/server/src/domain/plan.test.ts`

**Interfaces:**
- Produces: `PlanPick.step: boolean`; `planCards` orders `step` units after all others.

- [ ] **Step 1: Tests.** The `pick()` helper gains `step: false`. Cases:
  - a step pick with p = 1 comes after a rung-1 pick with p = 0.7;
  - two steps keep the highest-p-first order between them;
  - the first step avoids the last non-step type when another step can go first (typed meaning last before the steps: the step with typed translation goes first);
  - the board still forms from multiple-choice picks with steps present.
- [ ] **Step 2: Run** `npx jest --selectProjects=unit src/domain/plan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `Unit` gains `step`.
  - `ordered(units, last)` takes the type to avoid first and returns `{ out, last }`.
  - `planCards` orders `units.filter((u) => !u.step)`, then the steps, starting from the first group's last type.
  - The board unit is never a step.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(domain): ask same-day returns last (phase 37 D6)`.

### Task 4: Reading today, and the session service

**Files:**
- Modify:
  - `apps/server/src/repo/sessions.ts`
  - `apps/server/src/repo/progress.ts` (export the answer decoding)
  - `apps/server/src/services/sessions.ts`
  - `apps/server/src/domain/jobs.ts`
- Tests:
  - `apps/server/src/services/sessions.test.ts`
  - `apps/server/tests/integration/repo/sessions.test.ts`
  - `apps/server/tests/integration/services/sessionsChoose.test.ts`
  - `apps/server/src/domain/jobs.test.ts`, if it parses payloads

**Interfaces:**
- Consumes: `dayState`, `DayAnswer` (Task 1); `ChoiceInput.steps`, `ChoiceInput.done` (Task 2); `PlanPick.step` (Task 3).
- Produces:
  - `SessionRepo.findAnswersOn(enrollmentId: string, day: string): Promise<DayAnswer[]>`: answers in sessions with `practice_day = day` or an open status, ordered by `a.answered_at, a.position`.
  - `SessionRepo.findIntroducedOn(enrollmentId: string, day: string): Promise<string[]>`: `countNewOn`'s query selecting the gloss ids, sorted.
  - Both replace `findGlossesAnsweredOn` and `countNewOn`.
  - The payload pick gains `step: z.boolean().default(false)`.

- [ ] **Step 1: Repo tests** (integration, replacing phase 35's two):
  - `findAnswersOn` returns D2's answers and the open session's, in answer order, each `{ glossId, sessionId, type, correct }`, with a wrong choice decoded as `correct: false`. Another enrollment's day is empty.
  - `findIntroducedOn` returns the same set the count test counted, as sorted ids.
- [ ] **Step 2: Implement the queries.**
  - Move `TEXT_TYPES` and the row-to-answer decoding in `repo/progress.ts` into an exported `decodeAnswer(row)`.
  - Use it in both `findSessionEvidence` and `findAnswersOn`.
- [ ] **Step 3: The service.**
  - `createNextSession` reads `findAnswersOn` and `findIntroducedOn`, then calls `dayState(answers, new Set(introduced))`.
  - It passes `steps`, `done` and `newToday: introduced.length`.
  - Each payload pick carries `step: choice.cls === 'STEP'`.
  - The prepare job passes `step` into `planCards`.
  - Update the unit test's stubs and its expectation:
    - one gloss answered wrong today becomes the STEP pick, at rung 2 with `step: true`, after the NEW pick and before the DUE pick;
    - the reads are `answers` and `introduced` on `[E, TODAY]`.
- [ ] **Step 4: Payload.**
  - A payload pick without `step` parses with `step: false`; add the test beside the existing default tests.
- [ ] **Step 5: Integration** (`sessionsChoose.test.ts`):
  - Rewrite the first test:
    - play words 0–5 a month ago so they are introduced then;
    - today, play words 0–3 with word 2 wrong;
    - the next session's picks are NEW 7 and 6, then word 2 as a STEP (WR, rung 2, `step: true`), then DUE 4 and 5 (WR, rung 1), then DONE 0, 1 and 3 (WP, rung 1, `r: null`).
  - Keep the next-day test.
- [ ] **Step 6: Run** the unit tests, `npm run typecheck`, and the two integration files:

```bash
bash scripts/lane-env.sh npm exec -w apps/server -- jest --selectProjects=integration --runTestsByPath tests/integration/repo/sessions.test.ts tests/integration/services/sessionsChoose.test.ts
```

  Expected: PASS.
- [ ] **Step 7: Commit** `feat(server): read today's answers and pass returns to the picker (phase 37 D7)`.

### Task 5: The day tests

**Files:**
- Create:
  - `apps/server/src/domain/day.fixture.ts`, generated from lane 0 by the scratch builder (`scratchpad/p37/lane0/build.ts`), one entry per line, typed;
  - `apps/server/src/domain/day.test.ts`.

**Interfaces:**
- Consumes: `dayState`, `chooseWords`, `planCards`, `applySession`, `evaluateSession`, `gradesFor`.

- [ ] **Step 1: The fixture.**
  - `export const LANE0_DAY: { source: string; today: string; sessions: number; saved: ...; memory: MemoryRow[]; progress: ProgressRow[] }`.
  - It holds 130 saved glosses, 139 memory rows and 142 progress rows.
- [ ] **Step 2: The runner** `runDay(fixture, sessions)`, inside the test file. Per session:
  1. `dayState` over the answers so far;
  2. `chooseWords` with listening and speaking on;
  3. `planCards` over the picks, each with `form: 'w<i>'`, a matching translation, and `tiles`, `speakable` and `clozeGap` true;
  4. answers from the fixed learner: every fifth card answered is wrong, and a read aloud is understood;
  5. `applySession` and `evaluateSession` on the day;
  6. update the introduced set.

  It returns the log of `{ session, glossId, cls, rung, dimension, type, right }` and, per session, the inputs used.
- [ ] **Step 3: The five assertions, for 9 and for 20 sessions.**
  1. While the limit allows, every session has a NEW pick.
  2. Every NEW before the last session has a rung-2 pick of that word later.
  3. Every wrong card before the last session is followed by a later pick of its word.
  4. Every session without a DONE pick has an SK pick.
  5. In a session with a DONE pick, its other picks equal `chooseWords` over the same inputs without the done glosses.

  Also assert:
  - the 20-session day introduces exactly `DAY_NEW_CAP`;
  - the 9-session day introduces more than 2.
- [ ] **Step 4: Run** `npx jest --selectProjects=unit src/domain/day.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `test(domain): lane 0's day and a twenty-session day hold the five outcomes (phase 37 D9)`.

### Task 6: The bots' numbers

**Files:**
- Modify: `bots/src/analysis.ts`, `bots/src/analysis.test.ts`, `bots/src/issue.ts`, `bots/src/issue.test.ts`, `docs/runbooks/bots.md`

**Interfaces:**
- Consumes: `dayState` (`../../apps/server/src/domain/today`) and `rungFor` (`../../apps/server/src/domain/choose`).

- [ ] **Step 1: Tests.**
  - `serverView` puts a word met in s1 and carded again in s2 the same day (typed meaning) on WR, rung 2, implied 2.
  - (d): a word met on day 1 and given a typed meaning on day 2 at level 1 is not a disagreement. A multiple choice at R ≥ 0.75 with memory is.
  - (c): same-day cards add no 0-day gaps. A word right on day 1 twice and day 3 gives a second-review gap of 2.
  - Update the existing server-view and (d) expectations to the new rule.
- [ ] **Step 2: Implement.**
  - `serverView` keeps today's `DayAnswer`s and an introduced set per date, and calls `dayState` before each session.
  - A step whose dimension is among the card type's options is chosen, at rung 2.
  - `implied = step ? 2 : rungFor(r)`.
  - (c) skips an entry when an earlier entry of the same word and dimension is on the same day.
  - The issue's legend and the runbook describe (c) as "first reviews of a day" and (d) as "off the rung memory implies".
- [ ] **Step 3: Run** `npm test -w bots`, or the bots' test command in its `package.json`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(bots): (c) and (d) follow phase 37's returns and recall rule (D8)`.

### Task 7: e2e and docs

**Files:**
- Modify: `e2e/tests/speaking.spec.ts`, `e2e/tests/support/memory.ts`

- [ ] **Step 1: Split `speaking.spec.ts` into two tests**, each with its own learner and one session.
  - Test 1 is session 1 as it is: a read aloud, say the translation, and two choices.
  - Test 2 is "can't speak now":
    - seeds ромашка SK at S 10 days with R 0.74 (so read aloud p ≈ 0.86) and черепаха SK at R 0.79, level 4;
    - two new words;
    - expected order: choice, read aloud, choice, then say the translation rendered typed.
  - Compute the seeds' `daysAgo` with `seededR`.
- [ ] **Step 2: Update `memory.ts`'s band comment.** Recall when the dimension has memory and R ≥ 0.75, or for a same-day return. A second session the same day brings returns.
- [ ] **Step 3: Run** `npm run e2e -- speaking.spec.ts` from the worktree, then the whole `npm run e2e`. Expected: PASS.
- [ ] **Step 4: Commit** `test(e2e): speaking's can't-speak-now in its own session (phase 37)`.

### Finish

- [ ] Run `npm test`, `npm run typecheck`, `npm run lint:arch`, `npm run test:integration` and `npm run e2e`.
- [ ] Add the spec's *As built* section if a ruling changed it.
- [ ] Final whole-branch review on the most capable model.
- [ ] Then `git-create-pr` and `ci-green`.
