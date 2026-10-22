# Typed cards' answer field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The typed card's answer bar draws one field, help's shelf above the input, with עזרה and בדיקה inside it.

**Architecture:** A layout change inside `TypedAnswerView`'s bar only. The locked box in the card, the bar's rules and help's rules do not change. A `focused` state from the input's focus events colours the field.

**Tech Stack:** Expo SDK 57, React Native 0.86, Playwright e2e on web.

**Spec:** `docs/superpowers/specs/2026-10-22-lang-tutor-answer-field-design.md`

## Global Constraints

- Touch only `TypedAnswerView.tsx`, `theme.ts` and `e2e/tests/help.spec.ts`.
- Keep every test ID in the spec's D5.

---

### Task 1: The field, tested first

**Files:**
- Modify: `e2e/tests/help.spec.ts` (the typed card section)
- Modify: `apps/mobile/src/components/TypedAnswerView.tsx`
- Modify: `apps/mobile/src/theme.ts`

- [ ] **Step 1:** In help.spec's typed card section, assert עזרה and בדיקה lie inside `typed-box`; the field's top border is `rgb(59, 91, 219)` after a click in the input and `rgb(227, 228, 236)` after a blur; `typed-box`'s height is equal before and after the first עזרה press.
- [ ] **Step 2:** Run `npm run e2e -- tests/help.spec.ts`; expect the new assertions to fail.
- [ ] **Step 3:** Build the field in `TypedAnswerView`'s bar per D1–D4: `shadows.focus` in `theme.ts`, a `focused` state, the shelf with `HelpButton` and the reading, the hairline, the answer line with בדיקה inside.
- [ ] **Step 4:** Run help.spec again; expect a pass. Then `npm run typecheck` and `npm test`.
- [ ] **Step 5:** Commit.

### Task 2: Every typed card still works

- [ ] **Step 1:** Run the e2e specs that answer typed cards: `tests/meaning-recall.spec.ts`, `tests/sentence-cards.spec.ts`, `tests/speaking.spec.ts`, `tests/listening-variety.spec.ts`, then the whole suite.
- [ ] **Step 2:** Screenshot the bar on web (empty, after a press, a sentence) and compare with mock B; fix what differs.
- [ ] **Step 3:** Commit any fix.
