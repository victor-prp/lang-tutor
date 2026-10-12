# Phase 42 — Honest second try Implementation Plan

> **For agentic workers:** superpowers:executing-plans (Victor: "go till PR", inline). Checkbox steps.

**Goal:** A wrong typed second try shows a wrong banner, and the meaning judge's `other_sense`
means a real sense.

**Spec:** `docs/superpowers/specs/2026-10-12-lang-tutor-phase-42-honest-second-try-design.md`

## Global Constraints

- No server logic, wire, migration or `API_LEVEL` change. `TIER2_THRESHOLD` is never lowered.
- Lanes are full: unit, typecheck, `lint:arch`, evals locally; integration and e2e in CI.

## Review Focus

1. A judged card's give-up (`{ text: '', judged: 'wrong' }`) must keep the first answer's banner.
2. Whitespace-only text on a second try is a give-up (the server trims it to one).
3. A second try that is another accepted word keeps its "right" banner.
4. The tighter `other_sense` must not turn the existing real-sense cases `wrong`.

---

### Task 1: The banner (app)

**Files:** `apps/mobile/src/feedback.ts`, `feedback.test.ts`.

- [ ] Flip the "wrong second try" test: typed, cloze, say (typed), translation and meaning cards
  give `{ tone: 'wrong', title: strings.feedbackWrong, line: <right answer>, verdict: 'wrong' }`;
  add `'  '` to the give-up cases. Run: FAIL.
- [ ] `feedbackFor`: swap to the first answer's banner only when the second try is a `pass` or
  its text is blank. Run the mobile suite and tsc: PASS. Commit `fix(mobile): …`.

### Task 2: The judge prompt (server)

**Files:** `apps/server/src/domain/judge.ts`, `judge.test.ts`, `tests/eval/cases.ts`.

- [ ] Test: the prompt says a dictionary would list the sense on its own, and that a related or
  associated word is wrong. Run: FAIL. Change the two lines. PASS. Commit `fix(domain): …`.
- [ ] Add the *imagination* cases; run the judge group of the eval; tier 2 ≥ 85% and the existing
  `other_sense` cases green. Commit `test(server): …`.

### Task 3: E2E

**Files:** `e2e/tests/ambiguous-questions.spec.ts`.

- [ ] A typed card's alternative, then a wrong word: `feedback-wrong`, התשובה הנכונה:, the saved
  word; the score still counts the card. tsc; commit `test(e2e): …`.
