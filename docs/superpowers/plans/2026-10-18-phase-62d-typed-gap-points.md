# Phase 62d — A typed gap points to its word: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every typed gap card's sentence is checked by a blind reader before the session is
written; one that does not point is rewritten once and checked again, or becomes a typed
translation.

**Architecture:** A new pure module `domain/pointing.ts` (prompt, parse, verdict) and a new call
kind `gap_point` on the gap check's client. `prepareSession` runs the point check beside 62c's gap
check, a sentence rewrite of its own beside 62c's gap rewrite, and the re-check beside the final
checker. The eval gains a `pointing check` group and runs the same rescue on typed gap rows.

**Tech Stack:** TypeScript, Zod 4 (`packages/core`), Gemini via `LlmClient`, Jest (unit), the
`tests/eval` runner (`npx tsx`).

**Spec:** `docs/superpowers/specs/2026-10-18-lang-tutor-phase-62d-typed-gap-points-design.md`

## Global Constraints

- The batch prompt as the session's main call sends it, and 62c's gap-rewrite prompt, stay
  byte-identical (spec anti-goals).
- Never lower `TIER2_THRESHOLD`, loosen an eval assertion, or skip or delete a case.
- The point check fails open: an error, timeout, unreadable answer or missing key keeps the card.
- A typed gap that fails its rewrite or its re-check becomes a typed translation (R3); in a
  question-types session it is not generated.
- A rewritten typed gap may have up to `SENTENCE_MAX_WORDS` (12) words; a first-written one keeps
  `SHORT_SENTENCE_MAX_WORDS` (8).
- `LlmPointSchema`: every field required, no optional strings.
- ADR 0001: `domain/pointing.ts` is pure; I/O stays in `services/sessions.ts`.

## Review Focus

- A capitalised saved form ("Treno") or a multi-word one ("ci sono"): a guess "treno" or "ci sono"
  must count as the word (Task 1 test).
- A reader answer with no guesses, an empty meaning, or a key missing: never throws; no guesses
  fails the card, a missing key keeps it (Task 1, Task 3 tests).
- A session with no typed gap asks no point call at all (Task 3 test).
- A question-types session drops the unclear typed gap instead of degrading it (Task 3 test).
- The card's generated `alternatives` never make a guess count as the word (Task 1 test).

---

### Task 1: The point check, pure

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (beside `LlmCheckSchema`), `packages/core/src/api/types.ts`, `packages/core/src/api/index.ts`
- Create: `apps/server/src/domain/pointing.ts`, `apps/server/src/domain/pointing.test.ts`
- Modify: `apps/server/src/services/llm.ts` (`ModelCallKind` gains `'gap_point'`)

**Interfaces:**
- Produces:
  - `LlmPointSchema = z.object({ items: z.array(z.object({ key: z.string(), guesses: z.array(z.string()), meaning: z.string(), clear: z.boolean() })) })`, type `LlmPoint`.
  - `POINT_MARKER: string` (a phrase only this prompt carries).
  - `type PointItem = { key: string; sentence: string }` (the sentence with `___`).
  - `pointItem(key: string, sentence: SentenceContent): PointItem`.
  - `buildPointPrompt(items: readonly PointItem[], from: string, to: string): { system: string; user: string; schema: typeof LlmPointSchema }`.
  - `parsePoint(raw: string): LlmPoint | null`.
  - `type PointFinding = { guesses: string[]; meaning: string; clear: boolean }`.
  - `readPoint(items: readonly PointItem[], answer: LlmPoint): Map<string, PointFinding>` (a key not answered is absent; first answer of a key counts; guesses trimmed, empties dropped).
  - `type PointTarget = { word: TypedTarget; meanings: readonly string[] }`.
  - `type PointVerdict = { points: true } | { points: false; fits: string[]; problem: string }`.
  - `judgePoint(finding: PointFinding, target: PointTarget): PointVerdict`.

- [ ] **Step 1: Write the failing tests** in `pointing.test.ts`:
  - `buildPointPrompt` system contains `POINT_MARKER`; the user JSON is `{ items: [{ key, sentence }] }` with no other field (blind).
  - `pointItem('q3', { sentence: 'Il cielo è qui.', gap: { start: 3, end: 8 }, ... })` → `{ key: 'q3', sentence: 'Il ___ è qui.' }`.
  - `parsePoint` reads a fenced answer; returns null for invalid JSON and for a missing `clear`.
  - `judgePoint`, target `{ word: { answer: 'cielo', lemma: 'cielo', alternatives: ['Cielo'] }, meanings: ['שמיים'] }`:
    - `{ guesses: ['cielo','mare','sole'], meaning: 'שמיים', clear: true }` → `{ points: true }`;
    - same with `clear: false` → `points: false`, `fits` `['mare','sole']`, `problem` names several meanings;
    - `{ guesses: ['tavolo','libro','gatto'], meaning: 'שולחן', clear: true }` → `points: false`, `fits` `['tavolo','libro','gatto']`, `problem` names `tavolo`;
    - first guess another word whose `meaning` is `'שמיים'` → `{ points: true }` (same meaning);
    - `guesses: []` → `points: false`;
    - target `{ answer: 'Treno', lemma: 'treno', alternatives: [] }`, guess `'treno'` → points; target `ci sono`, guess `'ci sono'` → points.
  - `readPoint` drops a key the model invented and keeps the first of two answers for a key.

- [ ] **Step 2: Run** `npx jest src/domain/pointing.test.ts` from `apps/server`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** the schema and `pointing.ts`. The prompt asks, per item, as a native
  reader who sees only the sentence: `guesses`, the three likeliest words for the gap in the form
  it needs, likeliest first; `meaning`, the first guess in the learner's language; `clear`, true
  when one meaning is clearly the likeliest, false when words of different meanings fit about as
  well. `judgePoint` uses `judgeTyped` (`@lang-tutor/core/domain`) and `meaningFits`
  (`domain/check.ts`).

- [ ] **Step 4: Run** `npx jest src/domain/pointing.test.ts` and `npm run typecheck` (root). Expected: PASS.

- [ ] **Step 5: Commit** `feat(server): a blind reader's guess tells whether a typed gap points`.

### Task 2: The sentence rewrite, pure

**Files:**
- Modify: `apps/server/src/domain/distractors.ts` (`buildDistractorPrompt`, `validateDistractors`), `apps/server/src/domain/sentences.ts` (`validateSentenceItem` input), `apps/server/src/domain/gapRewrite.ts`
- Test: `apps/server/src/domain/distractors.test.ts`, `apps/server/src/domain/gapRewrite.test.ts`

**Interfaces:**
- Consumes: `PointVerdict` (Task 1).
- Produces:
  - `GapFault.stage: 'validation' | 'checker' | 'pointing'`.
  - `pointFaults(input: { items: readonly DistractorItem[]; verdict: DistractorVerdict; failed: ReadonlyMap<string, { fits: string[]; problem: string }> }): GapFault[]` — one `pointing` fault per `sentence` item in `failed` with a written sentence, `rewrite: { sentence, fits, problem }`, in item order.
  - `rewriteItems` / `rewriteOthers` unchanged, used for sentence faults too.
  - `validateSentenceItem` input gains optional `maxWords` (default `SHORT_SENTENCE_MAX_WORDS`).

- [ ] **Step 1: Write the failing tests:**
  - `buildDistractorPrompt` for (a) a batch with no rewrite and (b) a gap-only rewrite returns exactly what master returns (pin both from master's output before editing).
  - A call with a rewritten `sentence` item carries the sentence rewrite rule (contains `REWRITE_MARKER`, "12 words", and "Leggo un ___ prima di dormire") and not 62c's gap rule; a gap-only rewrite carries 62c's rule and not the sentence rule.
  - `validateDistractors`: a rewritten `sentence` item of 10 Italian words validates; the same item without `rewrite` degrades with "the sentence has 10 words".
  - `pointFaults`: a failed sentence item yields `{ key, stage: 'pointing', rewrite: { sentence: 'Il cielo è qui.', fits: [...], problem } }`; an item not in `failed`, or with no written sentence, yields none.

- [ ] **Step 2: Run** `npx jest src/domain/distractors.test.ts src/domain/gapRewrite.test.ts`. Expected: the new tests FAIL, the pins PASS.

- [ ] **Step 3: Implement.** 62c's rule line is gated on `items.some((item) => item.rewrite && item.task === 'gap')`; the new line on `item.task === 'sentence'`, worded as spec D3.

- [ ] **Step 4: Run** the same tests and the whole unit suite (`npm test` from `apps/server`). Expected: PASS.

- [ ] **Step 5: Commit** `feat(server): a typed gap can be asked again, told what a reader guessed`.

### Task 3: `prepareSession` runs the check, the rewrite and the re-check

**Files:**
- Modify: `apps/server/src/services/sessions.ts` (`prepareSession`, around lines 1720–2240), `apps/server/src/domain/jobs.ts` (`PREPARE_SESSION_CALL_BUDGETS_MS`)
- Test: `apps/server/src/services/sessions.prepare.test.ts`, the test pinning the expiry (grep `840`)

**Interfaces:**
- Consumes: Task 1's `pointItem`, `buildPointPrompt`, `parsePoint`, `readPoint`, `judgePoint`; Task 2's `pointFaults`, `rewriteItems`, `rewriteOthers`.
- Produces: logs `point_check_failed { session_id, point_check_ms, reason }`; `gap_rewritten` with `type: 'cloze_typed'`, `reason` (`pointing: <problem>; guesses …`); `session_prepared` gains `point_check_ms`, `point_count`, `unpointed_count`.

- [ ] **Step 1: Write the failing service tests** (fakes, as 62c's do):
  - a session with one typed gap: a `gap_point` call is made beside the context call, with the sentence blanked and no word in it;
  - a session with no typed gap makes no `gap_point` call;
  - the point check fails a typed gap → a `gap_rewrite` call carrying the sentence rule → the re-check passes → the card is written as `cloze_typed` with the new sentence and the second word-map call's map;
  - a session with a gap fault and a typed fault makes two `gap_rewrite` calls, each with only its own rule;
  - the rewrite refused (or its call throwing) → the card is written as `typed_translation`, `sentence_degraded` logged;
  - the re-check fails it → `typed_translation`; the re-check call throws → the rewritten card is kept;
  - the point check throwing, or omitting the card's key → the card kept as written, `point_check_failed` logged for the throw;
  - a question-types session: an unclear typed gap is not generated (skipped type `not_generated`);
  - `PREPARE_SESSION_EXPIRY_SECONDS` is 1200.

- [ ] **Step 2: Run** `npx jest src/services/sessions.prepare.test.ts`. Expected: new tests FAIL.

- [ ] **Step 3: Implement.** In `rescueGaps`' `Promise.all` add a second branch, `rescuePoints`: point check on `gapCheckLlm` (`record('gap_point')`), `judgePoint` per card with `word: { answer: <gap text>, lemma: row.lemma, alternatives: [row.form, row.answerForm, ...row.acceptedAnswers] }` and `meanings: glossMeanings(row)` (move `glossMeanings` above), `pointFaults`, then the sentence rewrite on `gapRewriteLlm` (`record('gap_rewrite')`) validated with `validateDistractors`. A rescued typed card joins `rescued` (second word-map call, final checker). Start the re-check of rescued typed cards beside the final checker and await it after. Keep a `unpointed: Map<number, string>` and degrade those cards in `final` exactly as the `translate` test does; skip a known-unpointed card's `translate` check item. Budgets: add `GAP_CHECK_BUDGET_MS` twice and `GAP_REWRITE_BUDGET_MS` once, with the comment.

- [ ] **Step 4: Run** `npm test` (apps/server), `npm run typecheck`, `npm run lint:arch`. Expected: PASS.

- [ ] **Step 5: Run** `npm run test:integration` (lane). Expected: PASS; if a request count changes, read why before touching the test.

- [ ] **Step 6: Commit** `feat(server): a typed gap that points to nothing is rewritten once, or not shown`.

### Task 4: The evals measure it

**Files:**
- Modify: `apps/server/tests/eval/cases.ts` (`POINT_CASES`, the new `sentence` case), `apps/server/tests/eval/askModel.ts` (`askPoint`), `apps/server/tests/eval/run.ts` (the `pointing check` group, the typed gap rescue), `apps/server/tests/eval/measureSchema.ts` (`LlmPointSchema`)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `type PointCase = { label: string; from: LanguageCode; sentence: string; word: { answer: string; lemma: string }; meanings: string[]; points: boolean }`; `askPoint(llm, { from, to, items }): Promise<LlmPoint>`.

- [ ] **Step 1: Cases.** `POINT_CASES`: the spec's 20 English verdicts (`from: 'en'`, Hebrew meanings) and its 21 Italian ones, labels `point en: <sentence>` / `point it: <sentence>`. The new sentence case `sentence it, Victor's 2026-10-18 list: cielo, treno, porta, sedia, finestra, pesce, felice, grande`: learner words exactly as the 21:37 request sent them; each word's saved example and avoid list from lane 0's `model_calls` (read-only query).

- [ ] **Step 2: Runner.** The `pointing check` group (its own line, `TIER2_THRESHOLD`): tier 1 "the answer reads" (the key answered), tier 2 "`<word>` points"/"does not point" from `judgePoint`. For `sentence` rows, `rescuePoints` mirrors Task 3 with the same domain functions; tier 2 gains "`<form>`: the point check passes the sentence shown" (fails when production would degrade); the row's other checks read the last sentence written; `written` lines show old → new sentences and the guesses.

- [ ] **Step 3: Measure** `LlmPointSchema` with `measureSchema.ts` at full size (no 400, no hang). Record the timings in the schema's comment, as `LlmCheckSchema` has.

- [ ] **Step 4: Run** from `apps/server`: `npx tsx tests/eval/run.ts "point "` three times; `"sentence "` three times; `"gap "` once. Expected: each group ≥ 85%, tier 1 clean. Tune only the point prompt (Task 1) or the sentence rewrite rule (Task 2), never a case or a check.

- [ ] **Step 5: Run** the full suite once and compare per row with master's latest CI `eval-report`.

- [ ] **Step 6: Commit** `test(eval): a pointing check group, and the typed gap rows run production's rescue`.

### Task 5: Record and finish

- [ ] **Step 1:** Add the measured timings, eval results and any rulings made while building to the spec's Rulings; commit `docs(spec): phase 62d records what building measured`.
- [ ] **Step 2:** `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e`.
- [ ] **Step 3:** `superpowers:finishing-a-development-branch` → `git-create-pr` → `ci-green`.
