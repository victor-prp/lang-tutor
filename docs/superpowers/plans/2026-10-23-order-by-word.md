# Order by word Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `planCards` orders a session's cards by word, so no card of a new word can precede its meet card.

**Architecture:** `PlanPick` carries its `glossId`. `planCards` builds one sequence of units per word (ladder, step-down, other cards in pick order; the board as its own) and places them in one pass by the spec's six criteria, replacing the ladder stream, `ordered()` and the even merge. Card choice, board choice and step-down cards are untouched.

**Tech Stack:** TypeScript, Jest (unit project), `apps/server/src/domain`.

**Spec:** `docs/superpowers/specs/2026-10-23-lang-tutor-order-by-word-design.md`

## Global Constraints

- `domain/plan.ts` stays pure (ADR 0001 R3): no clock, rng, env or I/O; every tie falls to a fixed order.
- `PlanPick.glossId: string` is required; two picks with one `glossId` are one word.
- A return is offered only once every unit that is neither a return nor of a ladder's or a step-down's word is placed (phase 37 D6).
- An intro stage's cards stay back to back (phase 55 D3).
- Never lower a day-simulation mark (day-simulation note).

## Review Focus

- A target board shares its four words with other cards: it must not sit next to a card of its words when another card can go between.
- A list session with returns: the type test counts only units placeable before the returns (D4), so it never costs a repeat today's order avoided.
- A session of one word (a ladder and its say card): its cards in sequence order, say last, nothing else to interleave.
- Two ladders with their say cards: both meets first, say A and say B last (R3).
- A device that cannot speak: the 67b say pick falls back to multiple choice and is still its word's last card, after the meet.

---

### Task 1: Order by word in `planCards`

**Files:**
- Modify: `apps/server/src/domain/plan.ts` (`PlanPick`, `planCards` from the units to the merge; delete `ordered()`)
- Modify: `apps/server/src/services/sessions.ts:1770-1790` (pass `glossId: row.glossId`)
- Modify: `apps/server/src/domain/day.test.ts` (both `planned` maps pass `glossId: pick.glossId`)
- Test: `apps/server/src/domain/plan.test.ts`

**Interfaces:**
- Produces: `PlanPick.glossId: string`; `planCards(picks, input): SessionPlan`, signature unchanged.

- [ ] **Step 1: Give the test fixtures words, and write the failing tests**

`pick(n)` gains `glossId: \`g${n}\``. A second pick of one word is `pick(n, { ... })` with the same `n`. New tests in the ladder describe, plus a new `describe('planCards: order by word (2026-10-23)')`:

```ts
it("asks a new word's say card after its typed translation, never before its meet", () => {
  // dad95389: a ladder, its say card, then four other cards (target session).
  const list = [ladder(0), at(0, SK, 2, { r: 1 }), at(1, WP, 2, { r: 1 }), at(2, WP, 2, { r: 1 }), at(1, SP, 1, { r: 1 }), at(2, SP, 1, { r: 1 })];
  const plan = planCards(list, { ...ALL, target: true });
  const word0 = plan.types.filter((_, k) => list[plan.order[k]].glossId === 'g0');
  expect(word0).toEqual([...INTRO, ...PRACTICE, 'say_translation']);
  expect(plan.types[0]).toBe('meet');
});
it('alternates one ladder with three others: its intro stage, then one other between each two of its cards');
// order by word: ['L','L','L','o','L','o','L','o','L']
it('ends two ladders with their say cards, after both typed translations');
// two ladders + say each, target: both meets lead; the last two cards are say_translation of g0, g1
it('asks a one-word session in its sequence: intro, practice, say');
it("keeps a target board away from its words' cards when another card can go between");
it('keeps the fallback of a say card that cannot be said last in its word, after the meet');
// speaking false: the SK pick is multiple_choice, the last of g0's cards
```

Plus the seeded sweep (`testRng` from `../../tests/support/testRng`): 2,000 random sessions (target or list; listening and speaking on or off; 0–2 ladders, some with a 67b say pick; 0–2 new meanings; 2–10 plain picks, some words with a second pick; returns on list sessions; 0–2 step-downs on target sessions; a target board sometimes). Each must hold: the plan's cards are the multiset its picks' cards give; each ladder's intro is first and back to back, then multiple choice, reverse choice, typed; a step-down's intro cards come before its produce card; no card of a ladder's word before its meet; returns after every unit that is neither a return nor of a ladder's or a step-down's word; the board's four positions are consecutive.

- [ ] **Step 2: Run them to see the new ones fail**

Run: `npx jest src/domain/plan.test.ts` (in `apps/server`)
Expected: the say-card test fails (say at position 0); the sweep fails on "card before its meet".

- [ ] **Step 3: Implement D1–D4 in `plan.ts`; pass `glossId` in `sessions.ts` and `day.test.ts`**

The sequences and the pass as the spec's D2 and D3 say. The criteria compare as a tuple `[sameWord, wordsInseparable, sameType, typesInseparable, −behind, −p, firstIndex]`, smallest first. D4: while a return waits, the type test's counts hold only the units that can be placed before the returns.

- [ ] **Step 4: Restate the three tests that pin phase 54's stage order as the rules they guard**

`merges three ladders, nothing else, by stage…` → every intro stage first, in pick order, and each ladder's practice cards in order. `spreads three ladders evenly through the one other card` → the other card sits after every intro stage and between two practice cards. `asks the returns after every other card…` → the returns follow every other card, and each ladder keeps its order.

- [ ] **Step 5: Find, with the sweep, a list session where counting the returns in the type test gives a type repeat, and pin it**

Expected: the pinned test has no two cards of one type in a row before the returns.

- [ ] **Step 6: Run the unit suite and the typecheck**

Run: `npx jest --selectProjects=unit` and `npx tsc --noEmit` (in `apps/server`)
Expected: all pass, except a day-simulation gate that Task 2 measures.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/domain/plan.ts apps/server/src/domain/plan.test.ts apps/server/src/domain/day.test.ts apps/server/src/services/sessions.ts
git commit -m "fix(server): order a session's cards by word, so no card precedes its word's meet"
```

### Task 2: Measure against lane 0 and the day simulation

**Files:**
- Modify (only if a mark is restated as an aggregate, never lowered): `apps/server/src/domain/day.test.ts`

- [ ] **Step 1: Replay lane 0's prepare payloads with the branch's `plan.ts`**

The POC's read-only replay (scratchpad `replay.ts`, pointed at this branch's `plan.ts`) and its compare script. Expected: 0 cards before their meet; same-word and same-type repeats no worse than the POC's 5 and 41.

- [ ] **Step 2: Measure the moved day-simulation gate across miss rhythms**

A temporary describe looping `missEvery` 4–8 × every phase × both kinds, run on this branch and with master's `plan.ts` (via a scratch Jest config mapping `./plan`). Expected: the branch's aggregate is within about a point of master's, or above. Revert the temporary describe.

- [ ] **Step 3: If the gate's mark falls only to rhythm noise, restate it as the measured aggregate held to master's; commit**

```bash
git commit -m "test(server): hold the practice-more gate to master's aggregate across rhythms"
```

- [ ] **Step 4: Run `npm run lint:arch` from the worktree root**

Expected: no output, exit 0.
