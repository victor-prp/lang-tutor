# Phase 41 — Gap fits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (Victor: "go till PR", inline). Steps use checkbox (`- [ ]`) syntax.

**Goal:** A fill-in sentence points to its word, and an unlisted word that fits the gap is
`alternative`, not `wrong`.

**Architecture:** One clause in the `sentence` prompt. A `check_fit` flag on the next-step text
request makes the server ask the judge client whether a rule-wrong first `cloze_typed` answer
fits; `fits` reaches `step` as an option that widens the card's alternatives for that answer. The
app sends the flag and waits for the response on the `server` route.

**Tech Stack:** TypeScript, zod, Hono, Jest, Playwright, MockServer, Gemini.

**Spec:** `docs/superpowers/specs/2026-10-12-lang-tutor-phase-41-gap-fits-design.md`

## Global Constraints

- No migration; `API_LEVEL` stays 3; `check_fit` is optional.
- The judge is called outside any transaction (ADR 0001 R8).
- `TIER2_THRESHOLD` is never lowered.
- Lanes are full in this run: unit, typecheck, `lint:arch` and evals run locally; integration and
  e2e are written here and proven in CI.

## Review Focus

1. A resent fit-checked answer (lost response) must replay, never call the judge again: pinned in
   Task 3's service test.
2. A fit-checked answer whose response holds the card must open the retry, not be resent as the
   second try (`mayOpen`): pinned in Task 4.
3. A judge failure must record `wrong` and still advance: Task 3.
4. `check_fit` on a non-`cloze_typed` card, on a retry or on a listed word makes no call: Task 3.
5. A wrong-alphabet text with `check_fit` is refused before any call: Task 3.

---

### Task 1: Core — the request flag and the judge schema

**Files:** `packages/core/src/api/schemas.ts`, its test.

- [ ] Test: `NextStepRequestSchema` parses `{ question_id, text, check_fit: true }` and refuses
  `check_fit: 'yes'`; `LlmFitJudgeSchema` parses `{ verdict: 'fits' }` and refuses `'right'`.
- [ ] Add `check_fit: z.boolean().optional()` to the text form, with a phase 41 comment, and
  `LlmFitJudgeSchema = z.object({ verdict: z.enum(['fits', 'wrong']) })` beside
  `LlmMeaningJudgeSchema`.
- [ ] Run the core tests and typecheck; commit `feat(core): …`.

### Task 2: Server domain — the prompt clause, the fit judge, `step`'s option

**Files:** `apps/server/src/domain/{distractors,judge,session}.ts` and their tests.

**Produces:** `buildFitJudgePrompt(question: ClozeTypedQuestion, language: LanguageCode, answer: string)`
→ `{ system, user, schema }`; `parseFitJudge(raw: string): 'fits' | 'wrong' | null`;
`step(…, { retry, languages, fits?: boolean })`.

- [ ] Tests: the sentence line says the other words point to the word and names
  *Please ___ the file.*; the fit prompt carries `JUDGE_MARKER`, the sentence with its gap as
  `___`, the word meant and the answer, and not the translation; `parseFitJudge` reads both
  verdicts, fenced or not, and null for anything else; `step` with `fits` on a first `cloze_typed`
  text records `alternative` pending; with `fits` on a retry it judges by the rule.
- [ ] Implement. `step`: on `attempt.kind === 'answer'`, `fits` and `cloze_typed`, evaluate
  `{ ...question, alternatives: [...question.alternatives, answer.text] }`.
- [ ] Run server unit tests; commit `feat(domain): …`.

### Task 3: Server service and route — `answerText`

**Files:** `apps/server/src/services/sessions.ts`, `routes/sessions.ts`,
`services/sessions.judge.test.ts`, `tests/support/mockServer.ts` (`expectJudge` takes `'fits'`),
`tests/integration/routes/sessions.hint.test.ts` (or a new `sessions.fit.test.ts`).

**Consumes:** Task 2. **Produces:** `service.answerText(actor, sessionId, { questionId, text, hintOpened, checkFit })`
returning what `submitAnswer` returns.

- [ ] Service tests (fakes): fits → `alternative` pending, one judge call; `wrong` → `wrong`;
  judge throws → `wrong`, logged `answer_fit_check_failed`; listed word, empty text, retry,
  another card type, no `checkFit` → no call; replay → no call; wrong alphabet → `WrongScript`,
  no call.
- [ ] Implement: a read transaction (authorize, load, `attemptOf`, rule check, gate), the judge
  call outside it, then `submitAnswer(…, { hintOpened, fits })`. `submitAnswer` passes `fits` to
  `step`. The route calls `answerText` when `check_fit` is true; the description names the field.
- [ ] Integration test (CI): fits / wrong / failure stored as the spec says; no flag → no call.
- [ ] Unit tests, typecheck, `lint:arch`; commit `feat(server): …`.

### Task 4: App — route, flag, `mayOpen`

**Files:** `apps/mobile/src/quiz.ts`, `feedback.ts` (`checksFit`), `hooks/useSession.tsx`, tests.

- [ ] Tests: `checksFit` is true only for a non-empty first-answer text that `evaluate` calls
  wrong on `cloze_typed`; `answerRoute` returns `server` for it; `nextStepRequest` sets
  `check_fit` only for it; `metHold` returns null for it when the response holds the card.
- [ ] Implement; `answerWith` passes the flag through `nextStepRequest`.
- [ ] Mobile tests and typecheck; commit `feat(mobile): …`.

### Task 5: E2E

**Files:** `e2e/tests/support/mockServer.ts` (`expectJudge` takes `'fits'`),
`e2e/tests/sentence-cards.spec.ts`.

- [ ] A typed fill-in answered with an unlisted word, the stub answering `fits`: the retry notice
  shows, the Hebrew is open, the saved word on the retry is right. Typecheck; commit `test(e2e): …`.

### Task 6: Eval

**Files:** `apps/server/tests/eval/{cases,run}.ts`, an `askFitJudge` beside `askJudge`.

- [ ] Fit cases (tier 2): *Please ___ the file.* with `edit`, `upload` → fits; `downloads`,
  `banana` → wrong; Italian `una nuova ___` with `casa` → fits, `fiore` → wrong; one Russian case.
- [ ] Sentence tier 2 check: the judge client's three likeliest fills, given the gapped sentence
  alone, include the gap word or one of its accepted answers.
- [ ] Run the sentence and fit groups; tier 2 ≥ 85% each; commit `test(eval): …`.
