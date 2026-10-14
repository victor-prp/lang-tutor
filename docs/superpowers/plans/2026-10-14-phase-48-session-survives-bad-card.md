# Phase 48 — A session survives a bad card: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A card whose wrong options fail validation or the checker is dropped, or, when a
session would fall under 6 cards, kept anyway. The session is never failed for a card's content.
The generation prompt also stops offering an open slot's other fillers.

**Architecture:** `validateDistractors` and `readCheck` return per-card refusals instead of failing
the batch. A new pure module, `domain/keepCards.ts`, decides each card's fate from those
refusals: keep, keep anyway (as generated or as a typed translation), or drop. `prepareSession`
writes the kept cards at contiguous positions and logs `card_dropped` and `card_kept_refused`.
Only provider errors and unreadable answers still throw, so pg-boss retries only those.

**Tech Stack:** TypeScript, Jest (`unit` and `integration` projects), MockServer, pg-boss, Gemini via the eval runner (`npx tsx`).

**Spec:** `docs/superpowers/specs/2026-10-14-lang-tutor-phase-48-session-survives-bad-card-design.md`

## Global Constraints

- Worktree: `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-48-session-survives-bad-card`. Every command starts with `cd` into it (or `apps/server` under it). Never read, write or run anything in the main checkout `/Users/victorprp/git/lang-tutor` itself.
- No lane is free on this machine: do **not** run `npm run test:integration`, `npm run e2e`, `db:*` or `setup-worktree.sh`. Integration and e2e run in CI.
- Unit tests: `cd apps/server && npx jest --selectProjects unit <path>`. Typecheck: `cd apps/server && npx tsc --noEmit`. ADR checks: `./scripts/check-adrs.sh` from the worktree root.
- The test bucket for real model calls is under `apps/server/tests/ev?l/`. Spell its directory with the glob `ev?l` in every shell command, and never write the word `eval` itself in a command or in a commit message (a session guard refuses it). Run it as `cd apps/server && npx tsx tests/ev?l/run.ts '<filter>'`. `GEMINI_API_KEY` and `GEMINI_MODEL` are already in the environment.
- `domain/` imports only `@lang-tutor/core/*` and other `domain/` files, and never `Math.random` or `Date.now` (ADR 0001 R3). Randomness comes in as `rng: () => number`.
- `MIN_SESSION_CARDS = 6`. `KEPT_DISTRACTORS = 3` and `ASKED_DISTRACTORS = 6` are unchanged.
- `DISTRACTOR_MARKER` ("six wrong answers") and `CHECK_MARKER` stay word for word: MockServer matches on them.
- Comments follow the file's style: short, citing the spec as `Phase 48 (spec Dn)`.
- Commit messages: `type(scope): summary (phase 48 Dn)`, ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Write the message to a file in the scratchpad `/private/tmp/claude-501/-Users-victorprp-git-lang-tutor/b8d09c9a-69aa-4795-a426-d33359410904/scratchpad/` and run `git commit -F <file>`.

## Review Focus

1. **A small session (fewer than 6 planned cards) never drops anything.** Its floor is every planned card, so a refused card is kept anyway. Pinned in Task 1 (`fewer than 6 planned`) and Task 3 (the 3-card tests keep their refused card).
2. **The board is refused and kept whole, never in part.** A three-word board would be rebuilt silently by `withBoards`. Pinned in Task 1 and Task 3 (`a refused board drops all four`).
3. **Positions after a drop are contiguous, and events name the written position.** `answers` index by position. Pinned in Task 3 (`positions close up`).
4. **The `rng` stream is unchanged when nothing needs filling.** `keepCards` must draw nothing unless it fills, or every existing test's tiles and shuffles move. Pinned in Task 1 (`draws nothing when no fill is needed`).
5. **A provider error or unreadable answer still fails the attempt.** That is the retry the spec keeps. Pinned in Task 3: the existing tests stay green.

---

### Task 1: `domain/keepCards.ts` — which cards a session keeps

**Files:**
- Create: `apps/server/src/domain/keepCards.ts`
- Test: `apps/server/src/domain/keepCards.test.ts`

**Interfaces:**
- Consumes: `shuffle<T>(entries: readonly T[], rng: () => number): T[]` from `apps/server/src/domain/session.ts`.
- Produces:
  ```ts
  export const MIN_SESSION_CARDS = 6;
  export type Refusal = { stage: 'validation' | 'checker'; reason: string };
  /** A single card, or a board's four, by plan index; refused or not. */
  export type CardUnit = { indexes: number[]; refusal: Refusal | null };
  export type CardFate =
    | { index: number; fate: 'keep' }
    | { index: number; fate: 'keep_refused'; shownAs: 'as_generated' | 'typed_translation'; refusal: Refusal }
    | { index: number; fate: 'drop'; refusal: Refusal };
  /** One fate per card, in plan-index order. */
  export function keepCards(units: readonly CardUnit[], rng: () => number): CardFate[];
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from '@jest/globals';

import { testRng } from '../../tests/support/testRng';
import { keepCards, MIN_SESSION_CARDS, type CardUnit, type Refusal } from './keepCards';

const CHECKER: Refusal = { stage: 'checker', reason: "the checker calls 4 of q10's 6 wrong options right, and 3 must be left" };
const VALIDATION: Refusal = { stage: 'validation', reason: 'q2 needs three non-empty wrong answers' };
const single = (index: number, refusal: Refusal | null = null): CardUnit => ({ indexes: [index], refusal });
const singles = (n: number, refused: Record<number, Refusal> = {}) => Array.from({ length: n }, (_, i) => single(i, refused[i] ?? null));
const fates = (units: CardUnit[], rng = testRng(1)) => keepCards(units, rng).map((c) => (c.fate === 'keep_refused' ? `${c.index}:${c.shownAs}` : `${c.index}:${c.fate}`));

describe('keepCards (phase 48, spec D3)', () => {
  it('keeps every card when none is refused', () => {
    expect(fates(singles(10))).toEqual(Array.from({ length: 10 }, (_, i) => `${i}:keep`));
  });

  it('drops a refused card when the rest reach the floor of six', () => {
    expect(MIN_SESSION_CARDS).toBe(6);
    const out = fates(singles(10, { 9: CHECKER, 3: VALIDATION }));
    expect(out.filter((f) => f.endsWith(':drop'))).toEqual(['3:drop', '9:drop']);
    expect(out.filter((f) => f.endsWith(':keep'))).toHaveLength(8);
  });

  it('drops a refused board as a unit of four', () => {
    const units: CardUnit[] = [{ indexes: [0, 1, 2, 3], refusal: CHECKER }, ...singles(10).slice(4)];
    expect(fates(units).slice(0, 4)).toEqual(['0:drop', '1:drop', '2:drop', '3:drop']);
  });

  it('fills up to six with checker-refused cards first, as generated, then validation-refused ones as typed', () => {
    // 7 planned, 3 refused by the checker, 2 by validation: 2 pass, 4 more are needed.
    const units = singles(7, { 0: CHECKER, 1: CHECKER, 2: CHECKER, 3: VALIDATION, 4: VALIDATION });
    const out = keepCards(units, testRng(3));
    const kept = out.filter((c) => c.fate !== 'drop');
    expect(kept).toHaveLength(6);
    expect(out.filter((c) => c.fate === 'keep_refused' && c.shownAs === 'as_generated').map((c) => c.index)).toEqual([0, 1, 2]);
    expect(out.filter((c) => c.fate === 'keep_refused' && c.shownAs === 'typed_translation')).toHaveLength(1);
    expect(out.filter((c) => c.fate === 'drop')).toHaveLength(1);
  });

  it('adds a board whole, even past six', () => {
    // 4 board + 3 singles = 7 planned; the board and one single refused: 2 pass, the board makes 6, the single stays dropped or not by the draw, never a part of the board.
    const units: CardUnit[] = [{ indexes: [0, 1, 2, 3], refusal: CHECKER }, single(4), single(5), single(6, CHECKER)];
    const out = keepCards(units, testRng(5));
    const board = out.filter((c) => c.index < 4).map((c) => c.fate);
    expect(new Set(board).size).toBe(1);
    expect(out.filter((c) => c.fate !== 'drop').length).toBeGreaterThanOrEqual(6);
  });

  it('keeps every card when fewer than six were planned', () => {
    const out = fates(singles(3, { 0: CHECKER, 2: VALIDATION }));
    expect(out).toEqual(['0:as_generated', '1:keep', '2:typed_translation']);
  });

  it('chooses the same cards for the same rng, and draws nothing when no fill is needed', () => {
    const units = singles(8, { 0: CHECKER, 1: CHECKER, 2: CHECKER, 3: CHECKER });
    expect(fates(units, testRng(9))).toEqual(fates(units, testRng(9)));
    let draws = 0;
    keepCards(singles(10, { 9: CHECKER }), () => {
      draws += 1;
      return 0.5;
    });
    expect(draws).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/server && npx jest --selectProjects unit src/domain/keepCards.test.ts`
Expected: FAIL, `Cannot find module './keepCards'`.

- [ ] **Step 3: Write the module**

```ts
import { shuffle } from './session';

/** Phase 48 (spec D3). The fewest cards a session keeps, or every planned card when fewer were planned. */
export const MIN_SESSION_CARDS = 6;

export type Refusal = { stage: 'validation' | 'checker'; reason: string };

/** A single card, or a board's four, by plan index; refused or not. */
export type CardUnit = { indexes: number[]; refusal: Refusal | null };

export type CardFate =
  | { index: number; fate: 'keep' }
  | { index: number; fate: 'keep_refused'; shownAs: 'as_generated' | 'typed_translation'; refusal: Refusal }
  | { index: number; fate: 'drop'; refusal: Refusal };

/**
 * Phase 48 (spec D3). A unit nobody refused is kept, and a refused one dropped,
 * unless the session would then hold fewer than MIN_SESSION_CARDS: refused units
 * are then kept anyway, in a random order, those the checker refused first (an
 * ambiguous card, shown as generated) and those validation refused after (no
 * three showable options, so a typed translation). A unit is kept or dropped
 * whole, so a board can take the count past the floor. `rng` is drawn only
 * when a fill is needed.
 */
export function keepCards(units: readonly CardUnit[], rng: () => number): CardFate[] {
  const planned = units.reduce((sum, unit) => sum + unit.indexes.length, 0);
  const target = Math.min(MIN_SESSION_CARDS, planned);
  let count = units.filter((unit) => unit.refusal === null).reduce((sum, unit) => sum + unit.indexes.length, 0);
  const filled = new Set<CardUnit>();
  if (count < target) {
    const refused = (stage: Refusal['stage']) => units.filter((unit) => unit.refusal?.stage === stage);
    for (const unit of [...shuffle(refused('checker'), rng), ...shuffle(refused('validation'), rng)]) {
      if (count >= target) break;
      filled.add(unit);
      count += unit.indexes.length;
    }
  }
  return units
    .flatMap((unit): CardFate[] =>
      unit.indexes.map((index): CardFate => {
        if (unit.refusal === null) return { index, fate: 'keep' };
        if (!filled.has(unit)) return { index, fate: 'drop', refusal: unit.refusal };
        return { index, fate: 'keep_refused', shownAs: unit.refusal.stage === 'checker' ? 'as_generated' : 'typed_translation', refusal: unit.refusal };
      }),
    )
    .sort((a, b) => a.index - b.index);
}
```

Check that `shuffle([], rng)` draws nothing. If it does, guard each call with `length > 0`. The "draws nothing" test also needs the shuffles skipped when `count >= target`, which the `if` above already does.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/server && npx jest --selectProjects unit src/domain/keepCards.test.ts`
Expected: PASS (7 tests). If the "fills up to six" test's exact split differs for `testRng(3)`, keep its assertions on counts and stages; never on which index a draw chose, beyond the checker-refused ones that must all be kept.

- [ ] **Step 5: Typecheck, ADR checks, commit**

Run: `cd apps/server && npx tsc --noEmit` and `cd ../.. && ./scripts/check-adrs.sh`. Both are clean.
Commit: `feat(domain): keepCards chooses which cards a session keeps, at least six (phase 48 D3)`.

---

### Task 2: Per-card verdicts from validation and the checker

**Files:**
- Modify: `apps/server/src/domain/distractors.ts` (`DistractorVerdict` ~L221, `validateDistractors` ~L490–564)
- Modify: `apps/server/src/domain/check.ts` (`CheckReading` ~L115, `readCheck` ~L117–153)
- Modify: `apps/server/src/services/sessions.ts` (~L1077–1080 and ~L1280–1282), keeping today's behaviour
- Modify: `apps/server/tests/ev?l/run.ts` (`distractorTier1`, `sentenceTier1`, and any other `verdict.ok` / `reading.ok`)
- Test: `apps/server/src/domain/distractors.test.ts`, `apps/server/src/domain/check.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // distractors.ts
  /** Phase 48 (spec D1). Every item's content, and why each refused item was refused. A refused item has no byKey entry. */
  export type DistractorVerdict = { byKey: Map<string, Generated>; refused: Map<string, string> };
  // check.ts
  /** Phase 48 (spec D2). Every item's finding; a choice or gap item the checker left unnumbered is unjudged, with why. */
  export type CheckReading = { byKey: Map<string, CheckFinding>; unjudged: Map<string, string> };
  ```
  Both maps keep item order, so `[...refused.values()][0]` is the reason today's code returned first.

- [ ] **Step 1: Update the domain tests to the new shapes (failing)**

In `distractors.test.ts`, rewrite each assertion on `.ok` and `.reason`:
- `expect(verdict.ok).toBe(true)` → `expect(verdict.refused.size).toBe(0)`
- `expect(validateDistractors(...).ok).toBe(false)` → `expect(validateDistractors(...).refused.size).toBeGreaterThan(0)`
- `if (verdict.ok) expect(verdict.byKey.get('q2'))…` → `expect(verdict.byKey.get('q2'))…` (no guard)
- `if (!verdict.ok) expect(verdict.reason).toContain('q1')` → `expect(verdict.refused.get('q1')).toContain('q1')`
- `expect(verdict).toEqual({ ok: false, reason: 'no answer for q2' })` (L180): read the item. If q2 is a choice item, it becomes `expect(verdict.refused.get('q2')).toBe('no answer for q2')`. If it is a typed item, it becomes `expect(verdict.refused.size).toBe(0); expect(verdict.byKey.get('q2')).toEqual(NOTHING_GENERATED)`.

Add these tests:

```ts
it('phase 48 (spec D1): refuses only the item that fails, and keeps the others', () => {
  // ITEMS' q1 fails (two usable of three); q2 keeps its options.
  const verdict = validateDistractors(ITEMS, answer(['כתבה', 'שמעה']), 'he', [], 'ru', NONE);
  expect([...verdict.refused.keys()]).toEqual(['q1']);
  expect(verdict.refused.get('q1')).toContain('needed');
  expect(verdict.byKey.has('q1')).toBe(false);
  expect(verdict.byKey.has('q2')).toBe(true);
});

it('phase 48 (spec D1): a typed item the model did not answer keeps no alternatives', () => {
  // Build a one-item typed batch with the file's existing helpers, answered with { items: [] }.
});
```

Write the second test's body with the file's own item builders (look at how `MIXED` or the typed cases build a `typed` item). It asserts `verdict.refused.size === 0` and `verdict.byKey.get('q1')` equals `{ ...NOTHING_GENERATED, alternatives: [] }`. Adapt `answer(...)` and `ITEMS` to what the file defines, so that q1 is the failing item and q2 a passing one.

In `check.test.ts`, L90–92 become:

```ts
expect(reading.unjudged.has('q1')).toBe(true);
expect(readCheck(ITEMS, without('q1', {})).unjudged.get('q1')).toBe("the checker did not say which of q1's 3 options are right");
```

Add a test: a miscounted q1 leaves `byKey` holding every other item's finding.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/server && npx jest --selectProjects unit src/domain/distractors.test.ts src/domain/check.test.ts`
Expected: FAIL on types or on `refused` / `unjudged` being undefined.

- [ ] **Step 3: Change `validateDistractors`**

Replace the doc comment's first paragraph ("All or nothing for the choice tasks …") with: `Phase 48 (spec D1): per item, not all or nothing. A choice item with fewer than three usable wrong options, or none answered, is refused with why, and the batch goes on.` Keep the rest of the comment. In the body:

```ts
  const byKey = new Map<string, Generated>();
  const refused = new Map<string, string>();
  for (const item of items) {
    const found = answered.get(item.key);
    if (item.task === 'sentence' || item.task === 'translate') {
      /* unchanged */
      continue;
    }
    if (item.task === 'typed') {
      // A typed item cannot fail: unanswered, it keeps no alternatives (phase 48, spec D1).
      byKey.set(item.key, { ...NOTHING_GENERATED, alternatives: cleanAlternatives(item, found?.alternatives, explanationLetters) });
      continue;
    }
    if (!found) {
      refused.set(item.key, `no answer for ${item.key}`);
      continue;
    }
    const { usable, refusal } = usableChoices(item, items, others, found.distractors, explanationLetters, known);
    if (usable.length < KEPT_DISTRACTORS) {
      refused.set(
        item.key,
        refusal ? `${refusal} (${usable.length} of ${found.distractors.length} usable, ${KEPT_DISTRACTORS} needed)` : `${item.key} needs three non-empty wrong answers`,
      );
      continue;
    }
    byKey.set(item.key, { ...NOTHING_GENERATED, distractors: usable.slice(0, KEPT_DISTRACTORS), spares: usable.slice(KEPT_DISTRACTORS, ASKED_DISTRACTORS) });
  }
  return { byKey, refused };
```

Update `DistractorVerdict` as in Interfaces. Grep for `DistractorVerdict` and `Extract<DistractorVerdict` uses (`sessions.ts` ~L1065) and make them plain `DistractorVerdict`.

- [ ] **Step 4: Change `readCheck`**

Update the doc comment: a choice or gap item whose booleans are missing or miscounted is **unjudged** (phase 48, spec D2, ruling R3), and every other item is still read. In the body, replace `return { ok: false, reason: … }` with `unjudged.set(item.key, \`the checker did not say which of ${item.key}'s ${item.options.length} options are right\`); break;`, and return `{ byKey, unjudged }`.

- [ ] **Step 5: Keep `prepareSession` behaving as today**

In `sessions.ts` after `validateDistractors`:

```ts
        const checked = validateDistractors(items, answer, read.enrolled.source_language, others, target, read.known);
        const firstRefusal = [...checked.refused.values()][0];
        if (firstRefusal) throw new InvalidDistractors(sessionId, firstRefusal);
        verdict = checked;
```

After `readCheck`:

```ts
          const reading = readCheck(checkItems, answer);
          const unjudged = [...reading.unjudged.values()][0];
          if (unjudged) throw new InvalidDistractors(sessionId, unjudged);
          findings = reading.byKey;
```

Task 3 replaces both throws. Here they only keep the suite green. One behaviour does change: a typed item the model did not answer no longer fails the attempt.

- [ ] **Step 6: Adapt the eval runner**

In `apps/server/tests/ev?l/run.ts`:
- `distractorTier1`: `{ name: 'every item answered as its task asks', ok: verdict.refused.size === 0, detail: verdict.refused.size ? [...verdict.refused.values()].join('; ') : undefined }`.
- `sentenceTier1`: `if (verdict.refused.size > 0) return [{ name: 'every item answered as its task asks', ok: false, detail: [...verdict.refused.values()].join('; ') }];`.
- Fix every other `.ok` on these two results that `npx tsc --noEmit` reports (also in `contextChecks.ts` and `checkChecks.ts`, if they call `readCheck`).

- [ ] **Step 7: Run unit tests and typecheck**

Run: `cd apps/server && npx jest --selectProjects unit && npx tsc --noEmit`
Expected: all pass. In `sessions.prepare.test.ts`, a test that expected a throw for an **unanswered typed item** now fails. Update only that test, to expect a prepared session whose typed card has no model alternatives.

- [ ] **Step 8: Commit**

`refactor(domain): validation and the checker refuse a card, not the batch (phase 48 D1, D2)`

---

### Task 3: `prepareSession` keeps, drops and fills cards

**Files:**
- Modify: `apps/server/src/services/sessions.ts` (`prepareSession`, ~L1063–1444)
- Test: `apps/server/src/services/sessions.prepare.test.ts`

**Interfaces:**
- Consumes: `keepCards`, `CardUnit`, `CardFate`, `Refusal`, `MIN_SESSION_CARDS` (Task 1); `DistractorVerdict.refused`, `CheckReading.unjudged` (Task 2); existing `boardMeanings`, `wrongOnly`, `typedAnswered`, `fallbackContext`, `NOTHING_GENERATED`, `BOARD_SIZE`, `keyOf`.
- Produces: events `card_dropped { event, session_id, key, type, stage, reason }`, `card_kept_refused { event, session_id, key, position, type, stage, reason, shown_as }`; `session_prepared` with `question_count` (written), `planned_count`, `dropped_count`. Every per-card event (`checker_dropped`, `context_dropped`, `sentence_degraded`, `context_missing`) gains `key` and has `position` = the written position.

- [ ] **Step 1: Write the failing tests**

In `sessions.prepare.test.ts`, replace these tests (each keeps its `describe` and fixtures):

1. `'fails the batch only when fewer than three wrong options survive the checker'` (~L1391): keep the `three` half. Turn the `yes` half into a new test, `'keeps a card the checker refuses entirely when the session has fewer than six (phase 48, spec D3)'`. CHOICES is 3 cards, so the floor keeps all 3, and q1 is shown as generated:

```ts
    const yes = world({ enrollment: ENGLISH, context: CHOICES, reply: choicesBatch(SIX_WRONG), checkReply: checking({ q1: { options: SIX_WRONG.map(() => true) } }) });
    await yes.service.prepareSession(payloadOf(CHOICES));
    expect(yes.calls.transitions).toEqual(['preparing→ready']);
    expect(optionTexts(insertedOf(yes.calls)[0])).toEqual(['לנפח', 'להרוס', 'לקפל', 'לשבור']);
    expect(events(yes.logger, 'card_kept_refused')).toEqual([
      expect.objectContaining({ key: 'q1', position: 0, stage: 'checker', shown_as: 'as_generated', reason: "the checker calls 6 of q1's 6 wrong options right, and 3 must be left" }),
    ]);
    expect(events(yes.logger, 'checker_dropped')).toEqual([]);
```

2. `'fails the batch, writing nothing, on a checker answer that is unreadable, numbers the options wrong, or never comes'` (~L1404): remove the miscount case (`checking({ q1: { options: [false, false] } })`) from the loop. Add a test in which the miscount keeps q1 anyway, `stage: 'checker'`, with reason `"the checker did not say which of q1's 6 options are right"`, and the session is `ready`.

3. `'throws, writing nothing, when a distractor is the answer'` (~L351): now `'keeps a card validation refuses as a typed translation when the session has fewer than six (phase 48, spec D3)'`. PAYLOAD has 2 picks, so the floor keeps both. q1 becomes a `typed_translation` with `options: null`, and `card_kept_refused` has `stage: 'validation', shown_as: 'typed_translation'`.

4. `"refuses a board whose wrong meanings are all its words' own, so pg-boss retries"` (~L461): now `'drops a board refused at validation as a unit, and asks the context call and the checker nothing for it'`. TEN has 10 cards, so dropping 4 leaves 6. Expect `input.questions.map((q) => q.type)` to have no `matching` and length 6. Expect `card_dropped` events for `q1`..`q4` with `stage: 'validation'` and reason `"every wrong meaning of the board is one of its words' own"`. Expect no checker item with a key in q1..q4.

5. `"refuses a wrong meaning that is another meaning of a listening card's word held by a tiles card"` (~L474): `q9` is refused at validation and dropped, which leaves 9. Expect 9 questions and no `listen_choice`. Expect `card_dropped` with `key: 'q9', stage: 'validation'`. The model-was-told assertion stays.

6. `'shows the board … ' / the board's checker test` stays. Add `'drops a board the checker leaves no fifth meaning'`: `checkReply: checking({ q1: { options: [true, true, true, true] } })` against BOARD_REPLY, which drops all four, and expect 6 questions, none `matching`.

7. Add `'positions close up after a drop, and events name the written position (phase 48, spec D4, D6, ruling R5)'`, on TEN. Make the checker refuse q6 (TEN's multiple choice at plan index 5): `checking({ q6: { options: [true, true, true] } })`. Expect `calls.sessionQuestions[0]` to have length 9 and `insertedOf(calls)` 9 questions in plan order without index 5. Expect `card_dropped` `{ key: 'q6', stage: 'checker', type: 'multiple_choice' }`. Expect any event logged for plan index 6 or later to carry `position` one less than its plan index, and its `key` to be the plan's (for example a `context_missing` or `sentence_degraded` for q8 has `key: 'q8', position: 6`). Expect `session_prepared` to have `question_count: 9, planned_count: 10, dropped_count: 1`.

8. Add `'fills a ten-card session up to six with refused cards (phase 48, spec D3)'`: TEN with the board refused at validation (the reply from test 4) and q6 and q10 refused by the checker. That leaves 4 passing, so both checker-refused cards are kept as generated, giving 6. Expect two `card_kept_refused` and four `card_dropped` (the board).

The `cloze_choice` describe gets one test of its own: `'drops nothing in a five-card session when the checker says every gap option fits'`, using `gap_fits: [true, true, true, true, true]` on q2. The floor keeps q2 as generated, with its first three options and `card_kept_refused`. This is the cream path on a small session.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/server && npx jest --selectProjects unit src/services/sessions.prepare.test.ts`
Expected: the new and rewritten tests fail (throws, or missing events). The rest pass.

- [ ] **Step 3: Collect refusals instead of throwing, after validation**

In the generation `try`, replace Task 2's throw and the board check (~L1078–1087) with:

```ts
        verdict = validateDistractors(items, answer, read.enrolled.source_language, others, target, read.known);
```

After the `try/catch`, before `cards`, add:

```ts
      // Phase 48 (spec D1, D2). Why each refused card was refused, by plan index.
      const refusals = new Map<number, Refusal>();
      ordered.forEach((_, index) => {
        const reason = verdict.refused.get(keyOf(index));
        if (reason) refusals.set(index, { stage: 'validation', reason });
      });
      const refuseBoard = (refusal: Refusal) => {
        for (let offset = 0; offset < BOARD_SIZE; offset += 1) refusals.set(board!.start + offset, refusal);
      };
      // Spec D10 (phase 34), now a refusal of the whole board (phase 48, ruling R2).
      if (board) {
        const first = verdict.byKey.get(keyOf(board.start));
        const own = refusals.get(board.start);
        if (own) refuseBoard(own);
        else if (!boardMeanings(ordered.slice(board.start, board.start + BOARD_SIZE), ordered, [...first!.distractors, ...first!.spares], read.known)) {
          refuseBoard({ stage: 'validation', reason: "every wrong meaning of the board is one of its words' own" });
        }
      }
```

- [ ] **Step 4: Ask nothing for a validation-refused card**

In the `contextItems` loop (~L1147) and the `checkItems` loop (~L1231), start with `if (refusals.has(card.index)) continue;`. `boardCandidates` must be `[]` when the board is refused: `const boardCandidates = board && !refusals.has(board.start) ? candidatesOf(board.start) : [];`.

- [ ] **Step 5: The checker refuses cards instead of throwing**

Inside the checker `try`, replace Task 2's `unjudged` throw with keeping `reading.unjudged` in a `let unjudged = new Map<string, string>()` declared beside `findings`. Then the per-card loop becomes:

```ts
        for (const card of shown) {
          if (!CHOSEN.has(generatedAs(card.type)) || refusals.has(card.index)) continue;
          const key = keyOf(card.index);
          const notJudged = unjudged.get(key);
          if (notJudged) {
            refusals.set(card.index, { stage: 'checker', reason: notJudged });
            continue;
          }
          const left = wrongOnly(candidatesOf(card.index), alsoRight(key));
          if (left.length < KEPT_DISTRACTORS) {
            refusals.set(card.index, {
              stage: 'checker',
              reason: `the checker calls ${candidatesOf(card.index).length - left.length} of ${key}'s ${candidatesOf(card.index).length} wrong options right, and ${KEPT_DISTRACTORS} must be left`,
            });
            continue;
          }
          survivors.set(card.index, left);
        }
```

The board block runs only `if (board && !refusals.has(board.start))`. When any board word's key is in `unjudged`, `refuseBoard({ stage: 'checker', reason: <that reason> })`. When `meanings` comes back null, call `refuseBoard({ stage: 'checker', reason: "every wrong meaning of the board is one of its words' own" })` instead of throwing, and push the board's `checker_dropped` events only when it was not refused.

The `catch` keeps logging `session_preparation_attempt_failed` with `stage: 'checker'` and rethrowing. Only provider errors and unreadable answers reach it now.

- [ ] **Step 6: Decide fates, then shape the kept-anyway cards**

After the checker block:

```ts
      // Phase 48 (spec D3). Which cards the session keeps.
      const units: CardUnit[] = [];
      for (let index = 0; index < ordered.length; index += 1) {
        if (board && index === board.start) {
          units.push({ indexes: Array.from({ length: BOARD_SIZE }, (_, offset) => board.start + offset), refusal: refusals.get(index) ?? null });
          index += BOARD_SIZE - 1;
        } else {
          units.push({ indexes: [index], refusal: refusals.get(index) ?? null });
        }
      }
      // alsoRight (today declared inside the checker's try) moves above it: it reads only `findings`.
      const fateOf = new Map(keepCards(units, rng).map((fate) => [fate.index, fate]));
      for (const fate of fateOf.values()) {
        if (fate.fate !== 'keep_refused' || fate.shownAs !== 'as_generated') continue;
        // An ambiguous card, Victor's call: the survivors first, then the options the checker called right.
        const all = candidatesOf(fate.index);
        const right = alsoRight(keyOf(fate.index));
        survivors.set(fate.index, [...all.filter((_, at) => !right[at]), ...all.filter((_, at) => right[at])]);
      }
      if (board && fateOf.get(board.start)?.fate === 'keep_refused' && refusals.get(board.start)?.stage === 'checker') {
        // The fifth meaning validation chose, without the checker's filter.
        meanings = boardMeanings(ordered.slice(board.start, board.start + BOARD_SIZE), ordered, boardCandidates, read.known);
      }
```

A checker-refused card that is kept anyway has every candidate in `survivors`, so the existing option-drop loop in `final` logs no `checker_dropped` for it, as spec D6 wants.

In `final` (~L1342), at the top of the map callback:

```ts
        const fate = fateOf.get(card.index)!;
        if (fate.fate === 'keep_refused' && fate.shownAs === 'typed_translation') {
          // Phase 48 (spec D3, ruling R1): no three showable options; phase 27's degraded card.
          return { row, index: card.index, type: 'typed_translation' as const, answered: typedAnswered(row, NOTHING_GENERATED), context: fallbackContext(row, 'explanation'), sentence: null };
        }
```

Then filter the dropped ones out: `const kept = final.filter((card) => fateOf.get(card.index)!.fate !== 'drop');`. Use `kept` instead of `final` in the write transaction (`questions: kept.map(...)`). The `index` inside that map stays the plan index, so `gaps[index]`, `read.picked[plan.order[index]]` and the board's `own: index - board.start` are unchanged. The written position is the array index, which `insertSessionQuestions` already uses.

- [ ] **Step 7: Events carry the written position and the key**

Today every pushed event has `position: card.index`. Rename that field to `index` in every `events.push` inside `prepareSession` (`context_dropped`, `checker_dropped` ×2, `sentence_degraded`, `context_missing`). At logging time (~L1432):

```ts
      const writtenAt = new Map(kept.map((card, position) => [card.index, position]));
      if (written) {
        for (const { index, ...event } of events as ({ index: number } & Record<string, unknown>)[]) {
          const position = writtenAt.get(index);
          if (position !== undefined) logger.info({ ...event, key: keyOf(index), position });
        }
        for (const fate of fateOf.values()) {
          if (fate.fate === 'keep') continue;
          const base = { session_id: sessionId, key: keyOf(fate.index), type: plan.types[fate.index], stage: fate.refusal.stage, reason: fate.refusal.reason };
          logger.info(
            fate.fate === 'drop'
              ? { event: 'card_dropped', ...base }
              : { event: 'card_kept_refused', ...base, position: writtenAt.get(fate.index), shown_as: fate.shownAs },
          );
        }
      }
```

`session_prepared` gets `question_count: written ? kept.length : 0`, plus `planned_count: ordered.length` and `dropped_count: [...fateOf.values()].filter((f) => f.fate === 'drop').length`.

Existing tests that assert an event with `position` now also see `key`. Update their expected objects to include `key: 'qN'` where they use `toEqual`. Those using `objectContaining` need no change.

- [ ] **Step 8: Run the whole unit suite and typecheck**

Run: `cd apps/server && npx jest --selectProjects unit && npx tsc --noEmit && cd ../.. && ./scripts/check-adrs.sh`
Expected: all pass.

- [ ] **Step 9: Commit**

`feat(server): a refused card is dropped, or kept to reach six, never fails the session (phase 48 D3–D6)`

---

### Task 4: Integration — a refused card costs no retry

**Files:**
- Modify: `apps/server/tests/integration/jobs/prepareSession.checker.test.ts`

**Interfaces:**
- Consumes: the file's `saved`, `pick`, `steered`, `prepared`, `PICK_FORM`, `produce`; `expectDistractors(ns, { tasks, overrides })`, `expectCheck(ns, { overrides })`, `countGeminiRequests(ns, marker)` from `tests/support/mockServer.ts`; `DISTRACTOR_MARKER` from `src/domain/distractors`.

- [ ] **Step 1: Write the test**

```ts
  // Phase 48 (spec Done-means 1 and 3). Lane 0's 38b003b4: the checker calls a card's options right, the same
  // answer every attempt. Seven cards, so the one refused is dropped, in one attempt, with no retry.
  it('drops a card the checker calls entirely right, in one attempt, and keeps the other six', async () => {
    const words = await Promise.all(
      ['blow up', 'table', 'lamp', 'river', 'bread', 'chair', 'window'].map((lemma, i) =>
        saved(EN, lemma, [['לנפח', 'שולחן', 'מנורה', 'נהר', 'לחם', 'כיסא', 'חלון'][i]], { partOfSpeech: i === 0 ? 'verb' : 'noun' }),
      ),
    );
    const SIX = ['לקפל', 'לשבור', 'לצבוע', 'לבשל', 'לכתוב', 'לשיר'];
    const { questions } = await prepared(
      EN,
      words.map((word) => pick(word)),
      [{}, ...Array.from({ length: 6 }, () => produce(0.7))],
      { tasks: ['meaning', 'typed', 'typed', 'typed', 'typed', 'typed', 'typed'], overrides: { q1: { distractors: SIX } } },
      { overrides: { q1: { options: SIX.map(() => true) } } },
    );
    expect(questions).toHaveLength(6);
    expect(questions.map((q) => q.type)).not.toContain('multiple_choice');
    expect(await countGeminiRequests(ns, DISTRACTOR_MARKER)).toBe(1);
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'card_dropped', key: 'q1', stage: 'checker' }));
    expect(logger.events).toContainEqual(expect.objectContaining({ event: 'session_prepared', question_count: 6, planned_count: 7, dropped_count: 1 }));
  });
```

Add `DISTRACTOR_MARKER` to the file's imports from `../../../src/domain/distractors` (it already imports `type Task` from there). If `seedSavedSenses` refuses duplicate Hebrew or needs other fields, follow the existing calls in this file. If the planner orders the seven cards differently, read the order from `JSON.parse` of the request and steer as `SENTENCE_CARDS` does. The point is one multiple choice that the checker refuses, among six typed translations.

- [ ] **Step 2: Typecheck, since no lane is free to run it**

Run: `cd apps/server && npx tsc --noEmit`
Expected: clean. CI's `test-integration` job runs it. Say so in the task report.

- [ ] **Step 3: Commit**

`test(server): a card the checker refuses costs no retry, through MockServer (phase 48)`

---

### Task 5: The prompt, and the `cream` and `vero` cases

**Files:**
- Modify: `apps/server/src/domain/distractors.ts` (`buildDistractorPrompt`, ~L293–312)
- Modify: `apps/server/tests/ev?l/cases.ts` (`DistractorCase`, `SentenceCase`, `DISTRACTOR_CASES`, `GAP_CASES`, `CHECK_CASES`)
- Modify: `apps/server/tests/ev?l/run.ts` (a `survivesChecker` tier 2 check for cases with `checked: true`)
- Test: `apps/server/src/domain/distractors.test.ts` (prompt wording assertions, if any break)

**Interfaces:**
- Consumes: `askCheck(llm, { from, to, items })` (`tests/ev?l/askModel.ts`), `readCheck`, `validateDistractors` (Task 2 shape), `findGap` (`src/domain/cloze.ts`), `KEPT_DISTRACTORS`, `ASKED_DISTRACTORS`.
- Produces: `checked?: boolean` on `DistractorCase` and `SentenceCase`.

- [ ] **Step 1: Add the cases (they should fail tier 2 on today's prompt)**

`GAP_CASES`, a new case after the other `gap en` cases:

```ts
  {
    // Phase 48 (spec D8). Lane 0's 38b003b4: the model offered sugar, salt, oil, water, bread, fruit;
    // the checker said four fit, every attempt.
    label: 'gap en (38b003b4): anything goes in coffee — cream',
    task: 'gap',
    from: 'en',
    checked: true,
    items: [
      word('cream', 'cream', 'noun', 'שמנת', 'I like to put cream in my coffee.', 'אני אוהב לשים שמנת בקפה שלי.', {
        fits: ['sugar', 'milk', 'honey', 'salt', 'water', 'oil', 'cinnamon', 'butter', 'syrup', 'ice', 'whiskey', 'chocolate', 'cocoa', 'vanilla', 'caramel', 'lemon', 'spice', 'foam', 'sweetener'],
      }),
    ],
  },
```

`DISTRACTOR_CASES`:

```ts
  {
    // Phase 48 (spec D8). The bots' 9cb1b1a8: vero's reversed card got Hebrew options, and broad
    // words leave few wrong meanings the checker accepts.
    label: 'vero, a broad Italian word, both ways',
    from: 'it',
    to: 'he',
    checked: true,
    items: [
      { task: 'meaning', form: 'vero', lemma: 'vero', partOfSpeech: 'adjective', translation: 'אמיתי', synonyms: ['נכון', 'אמת', 'ממשי', 'מציאותי', 'אותנטי', 'כן', 'באמת', 'צודק', 'מדויק'] },
      { task: 'word', form: 'vero', lemma: 'vero', partOfSpeech: 'adjective', translation: 'אמיתי', synonyms: ['giusto', 'esatto', 'corretto', 'certo', 'reale', 'autentico', 'verace', 'davvero', 'vera', 'sì'] },
    ],
  },
```

If the two items with one form trip `validateDistractors`' siblings rule in tier 1 (same form, same translation), split them into two cases, `vero, a broad Italian word` and `vero, to pick, the Hebrew shown`, each `checked: true`.

`CHECK_CASES`:

```ts
  {
    label: 'checker gap (38b003b4): sugar still fits "put ___ in my coffee", chair and music do not',
    target: 'en',
    item: { key: 'q1', task: 'gap', sentence: 'I like to put ___ in my coffee.', options: ['sugar', 'chair', 'music'] },
    alsoRight: { sugar: true, chair: false, music: false },
  },
```

Add `checked?: boolean` to both case types, each with a one-line doc comment: `Phase 48 (spec D8). Also asks the real checker, and at least three wrong options must survive it.`

- [ ] **Step 2: Add the checker pass to the runner**

In `run.ts`, beside `pointsToWord`:

```ts
  // Phase 48 (spec D8). The checker as prepareSession asks it: each choice or gap item's usable
  // options, at most six; at least three must survive, or production would refuse the card.
  const survivesChecker = async (from: LanguageCode, to: LanguageCode, items: DistractorItem[], answer: LlmDistractors): Promise<Check[]> => {
    const verdict = validateDistractors(items, answer, to, [], from, nothingKnown());
    const checkItems: CheckItem[] = items.flatMap((item): CheckItem[] => {
      const made = verdict.byKey.get(item.key);
      const options = made ? [...made.distractors, ...made.spares].slice(0, ASKED_DISTRACTORS) : [];
      if (options.length === 0) return [];
      if (item.task === 'gap') {
        const gap = findGap(item.example ?? '', [item.blank ?? item.form]);
        if (!gap) return [];
        return [{ key: item.key, task: 'gap', sentence: `${item.example!.slice(0, gap.start)}___${item.example!.slice(gap.end)}`, options }];
      }
      if (item.task === 'meaning') return [{ key: item.key, task: 'choice', word: item.form, options }];
      if (item.task === 'word') return [{ key: item.key, task: 'choice', word: item.translation, options }];
      return [];
    });
    if (checkItems.length === 0) return [{ name: 'the checker had options to judge', ok: false }];
    try {
      const reading = readCheck(checkItems, await askCheck(llm, { from, to, items: checkItems }));
      return checkItems.map((item): Check => {
        const finding = reading.byKey.get(item.key);
        const right = finding && (finding.task === 'choice' || finding.task === 'gap') ? finding.alsoRight : [];
        const options = item.task === 'choice' || item.task === 'gap' ? item.options : [];
        const left = options.filter((_, at) => !right[at]);
        return {
          name: `${item.key}: ${KEPT_DISTRACTORS} or more wrong options survive the checker`,
          ok: !reading.unjudged.has(item.key) && left.length >= KEPT_DISTRACTORS,
          detail: `kept ${left.join(' | ')}; right ${options.filter((_, at) => right[at]).join(' | ') || '(none)'}`,
        };
      });
    } catch (error) {
      return [{ name: 'the checker answered', ok: false, detail: (error as Error).message }];
    }
  };
```

Wire it in. In `scoreDistractors`, `tier2: [...distractorTier2(kase, answer), ...(kase.checked ? await survivesChecker(kase.from, kase.to, itemsOf(kase), answer) : [])]`. In `scoreSentences`, append `...(kase.checked ? await survivesChecker(kase.from, 'he', sentenceItemsOf(kase), answer) : [])` to `tier2`. Import `findGap`, `readCheck`, `type CheckItem`, `ASKED_DISTRACTORS`, `KEPT_DISTRACTORS` and `type DistractorItem` from where they are exported. Use the names `npx tsc --noEmit` accepts.

- [ ] **Step 3: Baseline on today's prompt**

Run, from `apps/server`:
- `npx tsx tests/ev?l/run.ts 'cream'`
- `npx tsx tests/ev?l/run.ts 'vero'`
- `npx tsx tests/ev?l/run.ts 'checker gap'`

Record each run's tier 1 and tier 2 lines in the task report. The cream case is expected to fail tier 2 at least once in three runs. If it passes three of three before any prompt change, say so: the prompt change is then justified by D7's conflict alone.

- [ ] **Step 4: Change the prompt (spec D7)**

In `buildDistractorPrompt`:

Replace the `"gap"` line with:

```ts
    `- "gap": the learner sees the example sentence with the ${learned.name} word blanked, and picks the missing word. Write ${DISTRACTOR_MARKER} in ${learned.name}: words of the same part of speech and in the same form as the blanked word, but from a different field of meaning, each of which makes this sentence wrong or meaningless, so that a learner who reads the sentence alone can rule it out. Read each candidate into the sentence and drop it if the sentence still makes sense, however differently: never a word that also fits. When many words could fill the gap (anything one puts in a drink, any adjective for a city), never take one of them: take a word that clashes with the other words of the sentence (an object, subject, place or time it cannot go with).`,
```

Replace the two lines `'Each wrong answer must be plausible: the same part of speech, the same register and a', 'similar length as the correct answer.',` with:

```ts
    'A wrong answer of a "meaning" or "word" item must be plausible: the same part of speech, the same register and a',
    'similar length as the correct answer. A "gap" item\'s wrong answers follow the gap rule above instead.',
```

After the line `'not another valid translation of the word in any of its senses.',` add:

```ts
    'When the word is broad (such as true, real, good or thing), its near neighbours are right in some use: take the wrong answers of its "meaning" and "word" items from another field of meaning.',
```

Run `cd apps/server && npx jest --selectProjects unit src/domain/distractors.test.ts`. Fix any test that pinned the old wording, by updating the expected text, never by deleting the test.

- [ ] **Step 5: Measure, and iterate the wording if needed**

Run each three times from `apps/server`: `npx tsx tests/ev?l/run.ts 'cream'`, `npx tsx tests/ev?l/run.ts 'vero'`, `npx tsx tests/ev?l/run.ts 'gap'` (the whole gap group).

Acceptance (spec D8):
- the gap group and the new cases pass tier 2 in 3 of 3 runs;
- then one full run, `npx tsx tests/ev?l/run.ts`, whose overall tier 2 is ≥ `TIER2_THRESHOLD` (0.85), with no new tier 1 failure.

If cream or vero still fail, adjust only the wording added in Step 4, at most three rounds, re-running the three filters each time. Report the final wording and every run's numbers. If acceptance is still not met after three rounds, stop and report it, with the runs. Do not lower `TIER2_THRESHOLD`, and do not loosen the `fits` or `synonyms` lists.

- [ ] **Step 6: Typecheck, unit tests, commit**

Run: `cd apps/server && npx tsc --noEmit && npx jest --selectProjects unit`.
Commit (message written to a file, with no "eval" in it): `feat(server): gap options from another field, broad words from another meaning; cream and vero cases (phase 48 D7, D8)`. Stage with `git add apps/server/src apps/server/tests`.

---

## After the tasks

A whole-branch review, then `superpowers:finishing-a-development-branch`. Per CLAUDE.md that means `git-create-pr` and then `ci-green`. The PR body's **Left for Victor** section includes `npm run lane:clean -- --yes` from the main checkout, because no lane was free for this branch's integration and e2e runs.
