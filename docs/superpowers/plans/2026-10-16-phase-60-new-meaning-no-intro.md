# Phase 60 — a new meaning gets no intro stage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A family's current meaning, once it has a known sibling, is never a ladder, even after its new-meaning card was missed.

**Architecture:** `glossFamilies` returns a new set, `newMeanings`. `ChoiceInput.families.introductions` (a set) is renamed `newMeanings` and fed from it; `chooseWords` reads it for the ladder rule. The `new_meaning` card still comes from the `introductions` map.

**Tech Stack:** TypeScript, Jest (server unit project).

**Spec:** `docs/superpowers/specs/2026-10-16-lang-tutor-phase-60-new-meaning-no-intro-design.md`

## Global Constraints

- No change to the new-meaning card, its copy, or to `Families.introductions` (the map).
- Day-simulation marks are compared with master's; none is lowered.

## Review Focus

- A missed new meaning (one Again row, return owed) — no ladder, one slot. Task 1, Task 2 tests.
- A target-listed waiting member with a known sibling keeps its ladder (not current). Task 1 test.
- A family with no known member: its current gloss still ladders. Task 1 test.

---

### Task 1: `newMeanings` in glossFamilies

**Files:** Modify `apps/server/src/domain/glossFamilies.ts`; Test `apps/server/src/domain/glossFamilies.test.ts`

**Produces:** `Families.newMeanings: ReadonlySet<string>`, the current gloss of every family with ≥1 known member, practised or not.

- [ ] Add `describe('glossFamilies: newMeanings (phase 60)')` with: a never-asked current gloss is in it (`'b'`, as in introductions); a practised current gloss with an Again row (`mem('b', WR, …)`) is in it while `introductions.size` is 0; no known gloss → empty; a waiting third member (`'c'`) is not.
- [ ] Run `npx jest --selectProjects=unit apps/server/src/domain/glossFamilies.test.ts` from repo root → FAIL.
- [ ] Implement: in the family loop, `if (current && known.size >= 1) newMeanings.add(current.glossId)`.
- [ ] Run → PASS. Commit `feat(server): glossFamilies names each family's new meaning`.

### Task 2: chooseWords reads `newMeanings` for the ladder

**Files:** Modify `domain/choose.ts` (type + `pickOf`), `services/sessions.ts:424`; rename the field in `choose.test.ts`, `targetSession.test.ts`, `day.test.ts` (setup ~223 and `isLadder` ~940).

**Consumes:** `Families.newMeanings`.

- [ ] Rename `ChoiceInput.families.introductions` → `newMeanings` everywhere (sessions.ts passes `families.newMeanings`; day.test.ts passes `families.newMeanings`).
- [ ] Add to choose.test.ts: "does not ladder a missed new meaning (phase 60)": `{ id: 'meaning', state: { [WR]: again() } }` owed a return, in `newMeanings` → `{ cls: 'NEW', ladder: false }`, session length `SESSION_LENGTH`; outside it → ladder true.
- [ ] Run unit project → PASS (typecheck: `npx tsc --noEmit -p apps/server`).
- [ ] Run `day.test.ts` and compare with master's run; no lowered mark.
- [ ] Commit `fix(server): a missed new meaning comes back without a ladder`.

### Task 3: Finish

- [ ] `npm test`, `npm run lint:arch`, `npm run test:all`, `npm run e2e`.
- [ ] `superpowers:finishing-a-development-branch` → `git-create-pr`, `ci-green`.
