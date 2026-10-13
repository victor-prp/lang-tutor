# Phase 45 — Second try, other word Implementation Plan

> **For agentic workers:** superpowers:executing-plans (Victor: "go till the end", inline). Checkbox steps.

**Goal:** Another accepted word on a second try gets a neutral "still not the word" banner, and
the translation judge counts a dropped manner word as a changed detail.

**Spec:** `docs/superpowers/specs/2026-10-13-lang-tutor-phase-45-second-try-other-word-design.md`

## Global Constraints

- No server logic, wire, migration or `API_LEVEL` change. `TIER2_THRESHOLD` is never lowered.
- Lanes are full: unit, typecheck, `lint:arch`, evals locally; integration and e2e in CI.

## Review Focus

1. A first answer that is another accepted word keeps today's green banner.
2. A spoken second try heard as another accepted word gets the `other` banner too.
3. Phase 42's repeat and give-up cases keep the first answer's banner.
4. The stricter detail rule must not turn word-order or slip cases `wrong`.

---

### Task 1: The banner (app)

**Files:** `apps/mobile/src/{feedback.ts,feedback.test.ts,strings.ts,components/FeedbackBanner.tsx}`.

- [ ] Test: `feedbackFor` with a hold and an `alternative` second try on typed, cloze, say (typed
  and heard), translation and meaning cards → `{ tone: 'other', title, line, verdict: null }`.
  Run: FAIL.
- [ ] Add the tone, the strings and the case; the banner draws `other`. Mobile suite + tsc: PASS.
  Commit `fix(mobile): …`.

### Task 2: The judge (server)

**Files:** `apps/server/src/domain/{judge.ts,judge.test.ts}`, `tests/eval/cases.ts`.

- [ ] Test the prompt wording: FAIL; change the sentence: PASS. Commit `fix(domain): …`.
- [ ] Eval cases; run the translation judge group under the old prompt (expect the dropped-word
  case to fail) and the new one (tier 2 ≥ 85%, existing cases green). Commit `test(server): …`.

### Task 3: E2E

**Files:** `e2e/tests/sentence-cards.spec.ts`.

- [ ] A translation with another word twice shows `feedback-other`. tsc; commit `test(e2e): …`.
