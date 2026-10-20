# Phase 66b — The sentence's own signal: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Victor: "go till PR", inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a translation card says "word → correct, sentence → needs correction" at the moment of
its grade. The server runs the explainer beside the judge in the one judged-answer request. The
card shows a second banner line, an orange input, the corrected sentence under it, and the reasons
behind הסבר.

**Architecture:** `answerJudged` starts the explain promise (it never rejects) before the judge's
call. After `submitAnswer` it stores or drops the result, then returns `explanation` beside the
verdict. In the app, the explanation lands in `QuizState` with the answer. `FeedbackBanner`,
`TypedAnswerView` and a small `SentenceCorrection` component read it.

**Spec:** `docs/superpowers/specs/2026-10-21-lang-tutor-phase-66b-sentence-signal-design.md`

## Global Constraints

- The grade is never lost to the sentence check: a failed or slow check means `explanation: null`
  and today's card.
- No prompt, budget or eval-case changes. No `API_LEVEL` bump. `/explain` stays.
- No transaction is open while a model call runs (ADR 0001 R8). The explanation row is its own
  write: independent and idempotent.
- Wire types are inferred from zod (ADR 0003).
- Hebrew copy: `המילה נכונה`, `המשפט נכון`, `המשפט צריך תיקון`, `הסבר`.

## Review Focus

1. An answer held for its second try returns `explanation: null` and stores nothing, and the
   retry returns the retry text's explanation.
2. When the explainer fails, the verdict is still recorded and returned (200), with
   `explanation: null`.
3. A replay makes no explain call and returns the stored row, or the rule result.
4. A new card clears the explanation and closes the details.
5. A wrong word keeps the red border even when the sentence has mistakes.

---

### Task 1: The wire and the server

**Files:** `packages/core/src/api/schemas.ts` (JudgedAnswerResponseSchema), `apps/server/src/services/sessions.ts` (answerJudged, JudgedResult), `apps/server/src/routes/sessions.ts` (judgedAnswerRoute description and handler); tests `apps/server/src/services/sessions.judge.test.ts`, `apps/server/tests/integration/routes/sessions.explain.test.ts`.

- [ ] Failing unit tests: a translation judged by the model returns the explainer's explanation;
      a failing explainer still returns the verdict, with `explanation` null; an `other_word`
      first answer returns null.
- [ ] Failing integration tests, the spec's list: model path stores one row; reference as typed,
      no call; show the answer, null; failing stub, 200 and null; pending, then the retry; replay
      with no call; typed meaning has no field. Update phase 66's `/explain` tests for the row the
      judged answer now stores.
- [ ] Implement: schema field, the explain promise in `answerJudged`, store or drop after
      `submitAnswer`, replay lookup, route mapping and description.
- [ ] `npm run typecheck`, the server's unit tests and these integration files are green. Commit.

### Task 2: The app

**Files:** `apps/mobile/src/judging.ts`, `quiz.ts`, `hooks/useSession.tsx`, `explain.ts` (sentence helpers), `feedback.ts` (exact title), `strings.ts`, `components/FeedbackBanner.tsx`, `components/TypedAnswerView.tsx` (border, `below` slot), new `components/SentenceCorrection.tsx`, `app/session.tsx`; delete `components/SentenceExplain.tsx`, `api.explainAnswer`; tests `explain.test.ts`, `quiz.test.ts`, `feedback.test.ts`.

- [ ] Failing unit tests: `sentenceLine` (right / fix / none); `inputTone` (wrong word red, fix
      orange, otherwise the verdict's); `correctedRuns` (changed words marked, punctuation and case
      ignored); `landed` sets and `applyQueued` clears the explanation; the exact title with and
      without an explanation.
- [ ] Implement the helpers, the state, the banner's second line and its הסבר pill, the input
      border, the corrected sentence and details under the input, the scroll to the end on open,
      and the strings. Remove `SentenceExplain` and `explainAnswer`.
- [ ] The app's typecheck and unit tests are green. Commit.

### Task 3: e2e

**Files:** `e2e/tests/sentence-cards.spec.ts`, and any spec that checks a translation card's `feedback-title`.

- [ ] The translate card answered with a mistake: both banner lines, the orange input
      (`typed-box` style), `sentence-corrected`, and הסבר opening and closing `explain-panel`.
      Specs whose translation cards now read "המילה נכונה" are updated.
- [ ] `npm run e2e -- tests/sentence-cards` and the touched specs pass. Commit.

### Task 4: Whole-suite check

- [ ] `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e`. Fix, commit, then
      `superpowers:finishing-a-development-branch` (CLAUDE.md: PR, then ci-green).
