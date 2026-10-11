# Phase 34 — Ambiguous questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every card either pins the reading it wants or accepts every right reading of what it shows, and a right answer that is not the saved word earns a second try.

**Architecture:** A stored, per-rendering accepted-answers list (new `accept` job, enqueued lazily by session preparation); a wider wrong-option filter plus a checker model call in `prepareSession`; generated context sentences and marked words stored on each question; a pending-answer state in the session step rule for the second try; app views that show the new hints.

**Tech Stack:** TypeScript, Hono, Drizzle + Postgres, pg-boss, Zod 4 (`packages/core`), Gemini via `providers/gemini.ts`, Expo / React Native, Jest, Playwright e2e, MockServer.

**Spec:** `docs/superpowers/specs/2026-10-11-lang-tutor-phase-34-ambiguous-questions-design.md`. Read it before your task: decision numbers (D1…D13, D4a) below refer to it. The audit it cites, with every flagged card id, is `drafts/2026-10-11-ambiguous-questions-findings.md` in the **main checkout** (`/Users/victorprp/git/lang-tutor/drafts/`).

## Global Constraints

- Work only in the worktree `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-34-ambiguous-questions`. Never write to `/Users/victorprp/git/lang-tutor` itself (the main checkout); run `git -C /Users/victorprp/git/lang-tutor status --short` after your task and expect no output.
- Read `CLAUDE.md` and every ADR in `docs/adr/` before touching `apps/server` or `apps/mobile`. `npm run lint:arch` must pass.
- Never hardcode a port or database name; run everything through the npm scripts (`npm test`, `npm run test:integration`, `npm run e2e`, `npm run db:migrate`), which go through `scripts/lane-env.sh`.
- Running one integration file: `cd apps/server && bash ../../scripts/lane-env.sh npx jest --selectProjects=integration --runTestsByPath tests/integration/<file>.test.ts`.
- The judge's rules do not change (D11): `judgeTyped`, `judgeSpoken`, the meaning and translation judges keep their logic. Never lower `TIER2_THRESHOLD`.
- Exact app strings (D9): `יש מילה נוספת ששמרת — נסו שוב` and `יש פירוש נוסף — נסו שוב`; the line before them is `✓ נכון, <answer> מתאים כאן.`
- Caps: accepted answers at most 10, here and on `questions.alternatives` (raised from 5). Spare wrong options: 6 asked, 3 kept (unless Task 1's measurement lowers it).
- Commit after each task with a conventional message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Match the surrounding comment style: phase/spec references (`Phase 34 (spec D6).`).
- Any new LLM call needs a MockServer expectation so `npm run test:integration` and `npm run e2e` stay off the network (see how existing tests stub Gemini under `apps/server/tests/support` and `e2e/`).

## Review Focus

1. A network retry of the first answer on a card whose answer went pending must re-open the second try, not advance or 409 (Task 7 tests it on all three routes).
2. The last card of a session going pending must not complete the session or write progress until the retry resolves; skipping with a pending retry must still write progress once (Task 7).
3. A rendering whose `accept` job found nothing must never be re-enqueued (stamp, not list, decides) (Task 3).
4. A Hebrew mark that cannot be found keeps the sentence unmarked rather than dropping it (Task 5).
5. A checker that says "yes" to every option must fail the batch only when fewer than three spares survive, and the eval must catch a checker that does so (Task 6).

---

### Task 1: Measure the batch schema against the live API (D4a)

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (`LlmDistractorsSchema`, ~line 955; add `LlmContextSchema` only if the measurement says so)
- Create: `apps/server/tests/eval/measureSchema.ts` (kept: future schema changes re-run it)

**Produces:** the final shape of `LlmDistractorsSchema` items, which Tasks 4–6 rely on:
```ts
{ key: string; distractors: string[] /* max 6 */; alternatives?: string[]; sentence?: string; gap?: string; translation?: string;
  context?: string;            // D6: the sentence the card shows
  context_translation?: string; // D6/D7: its hidden other half
  context_word?: string;        // D6: the marked word as it appears in `context`
  sentence_word?: string;       // D8: the practised word as it appears in the Hebrew sentence
}
```
If the live API refuses that, the four context fields move to a separate `LlmContextSchema = z.object({ items: z.array(z.object({ key, context, context_translation, context_word, sentence_word })).max(10) })` sent as its own call, and the distractor cap is measured down (6 → 5 → 4).

- [ ] **Step 1:** Write `measureSchema.ts`: builds a full-size request (10 items, every task kind, from `distractorItems` on hand-made `GenerationContext` rows) with `buildDistractorPrompt`, sends it through `createGeminiClient(loadGeminiConfig())`, and prints `accepted` or the provider error. It must exit non-zero on a 400. Run with `cd apps/server && npx tsx tests/eval/measureSchema.ts` (the key is in the shell env as `GEMINI_API_KEY`; `GEMINI_MODEL` too — if missing, read it from `.github/workflows` and export it for the run).
- [ ] **Step 2:** Run it against today's schema: expect `accepted` (baseline).
- [ ] **Step 3:** Change the schema to the shape above; run again. Then run once more with a deliberately oversized variant (distractors `.max(20)`, every field duplicated) and confirm the script reports the refusal — a check that cannot fail proves nothing (CLAUDE.md).
- [ ] **Step 4:** If refused, apply the fallback in **Produces** and measure again until accepted. Write the outcome and the numbers as a comment above `LlmDistractorsSchema`, in the style of the existing comment above `entries`.
- [ ] **Step 5:** `npm test` and `npm run typecheck --workspaces --if-present` pass (parsers must tolerate the new optional fields). Commit.

### Task 2: Migration — every new column and check (D1, D2, D6, D8, D9, D12)

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`dictVarTranslations`, `questions`, `answers`)
- Create: `apps/server/drizzle/0027_ambiguous_questions.sql` via `npm run db:generate --workspace apps/server`, hand-edited for checks as the earlier migrations are
- Modify: `apps/server/src/repo/dictionary.ts` (the stale-form repair's delete and re-insert, ~line 850)
- Modify: `apps/server/src/db/dictExport.ts` and the import it pairs with (`dict:restore`)
- Test: `apps/server/tests/integration/` — extend the existing dictionary-repair and dict export/import tests

**Produces (columns):**
- `dict_var_translations`: `accepted_answers text[] not null default '{}'` (check: cardinality ≤ 10), `answer_form text`, `accepted_at timestamptz`.
- `questions`: `context text`, `context_translation text`, `context_mark_start int`, `context_mark_end int`, `sentence_mark_start int`, `sentence_mark_end int`, `answer_form text`; `alternatives` check raised to ≤ 10; the shape check allows a context only on `typed_translation`, `say_translation`, `reverse_choice`, `typed_meaning`, `multiple_choice`, sentence marks only on `cloze_typed` and `sentence_translation`, and both mark columns null together.
- `answers`: `retry_state text` (null | `pending` | `resolved`), `retry_text text`, `retry_verdict text`. Checks: `retry_state is not null` only when `verdict = 'alternative'`; `retry_text`/`retry_verdict` set exactly when `retry_state = 'resolved'`; `retry_verdict` in the same list as `verdict`; `length(retry_text) <= 300`.

- [ ] **Step 1:** Failing integration tests: (a) the repair keeps `accepted_answers`, `answer_form`, `accepted_at` on a (variant, sense) whose `translation` is unchanged, and leaves them empty/null on one whose translation changed or is new; (b) export then restore round-trips the three columns; (c) each new check refuses a bad row (one `expect(...).rejects` per check).
- [ ] **Step 2:** Run them; they fail.
- [ ] **Step 3:** Schema + migration; in the repair, read the three columns for the variant before the delete and write them back for unchanged rows; add the three columns to the export's select and the restore's insert.
- [ ] **Step 4:** `npm run db:migrate`, the tests pass, `npm run db:check --workspace apps/server` is clean. Commit.

### Task 3: The `accept` job, lazy enqueue and backfill (D1, D2, D13)

**Files:**
- Create: `apps/server/src/domain/accept.ts` (+ `accept.test.ts`)
- Modify: `packages/core/src/api/schemas.ts` (add `LlmAcceptSchema = z.object({ answers: z.array(z.string()), answer_form: z.string().nullable() })`, no array caps), `packages/core/src/api/types.ts`
- Modify: `apps/server/src/domain/jobs.ts` (`ACCEPT_RENDERING = 'accept-rendering'`, `ACCEPT_RENDERING_FAILED`, expiry 120 s, payload `{ variant_id, sense_id, user_language_code }`)
- Modify: the worker registration (follow `RENDER_LEMMA` through `worker.ts` / `composition.ts`), `apps/server/src/repo/dictionary.ts` (read one rendering with its lexeme; write the list), a service method `acceptRendering(data)` (put it beside `renderLemma`, wherever that lives)
- Modify: `apps/server/src/services/sessions.ts` `prepareSession` (lazy enqueue), `apps/server/src/db/cli.ts` + both `package.json`s (`dict:accept` → `--accept-renderings`)
- Modify: `apps/server/tests/eval/cases.ts`, `askModel.ts`, `run.ts` (accept cases)
- Test: unit `accept.test.ts`; integration for the job, the enqueue and the CLI

**Interfaces:**
- `buildAcceptPrompt(input: { form: string; lemma: string; partOfSpeech: string; rendering: string; example: string | null; exampleTranslation: string | null; target: LanguageCode; explanation: LanguageCode }): { system: string; user: string; schema: typeof LlmAcceptSchema }`
- `parseAccept(raw: string): LlmAccept | null`
- `validateAccept(input: { form: string; lemma: string; target: LanguageCode; explanation: LanguageCode }, answer: LlmAccept): { answers: string[]; answerForm: string | null }` — trims, drops empties, the explanation script, anything containing `one's`/`someone`/`qualcuno`/`кто-то` placeholders, the form itself; dedupes with `comparable`; at most 10. `answerForm` is null when it equals the form under `comparable`.
- Repo: `findRenderingForAccept({ variantId, senseId, userLanguageCode })`, `storeAccepted({ variantId, senseId, userLanguageCode, answers, answerForm, at })` (sets `accepted_at`).

The prompt (D1): every right translation of the Hebrew rendering into the target language **in this sense**, inflected to agree with the rendering; placeholders written out as one entry per possessive/pronoun; for a verb form whose subject the rendering implies, also the form with its subject pronoun (יש לי → `ho`, `io ho`); and `answer_form`: the form of the lemma that agrees with the rendering in number and person (שעות → `ore`).

- [ ] **Step 1:** Unit tests for `validateAccept` (placeholder dropped, explanation script dropped, cap 10, `answerForm` null when equal to the form) and `parseAccept`.
- [ ] **Step 2:** Integration: preparing a session whose picks include a rendering with null `accepted_at` enqueues `ACCEPT_RENDERING` once per rendering (singleton key `${variant}:${sense}:${lang}`), and none for a stamped rendering **with an empty list**; running the job stores answers, form and stamp; the session's own `typed` alternatives never reach `dict_var_translations`; `dict:accept` enqueues only null stamps of saved glosses' member renderings. Stub Gemini through MockServer as the render-lemma tests do.
- [ ] **Step 3:** Implement. The enqueue goes in `prepareSession`'s read transaction (ADR 0007: enqueue in the same transaction as the read that decided it). The job is: read (tx), call (no tx), write (tx) — ADR 0001 R8.
- [ ] **Step 4:** Eval cases (`ACCEPT_CASES`): `fratello`/אח (במסדר דתי) includes `frate`; `poi`/אז includes `allora`; `ho`/יש לי includes `io ho`; `blow up`/להתפרץ בכעס has no `one's` and includes `lose my temper`; `ora`/שעות returns `answer_form` `ore`. Run `cd apps/server && npx tsx tests/eval/run.ts` and read the accept rows of the scorecard (tier 2 must not drop).
- [ ] **Step 5:** `npm test`, the integration files touched, `npm run lint:arch` pass. Commit.

### Task 4: Cards read the stored list and the answer form (D1, D2, D12)

**Files:**
- Modify: `apps/server/src/repo/questions.ts` (`findGenerationContext` returns `acceptedAnswers: string[]`, `answerForm: string | null` per row; insert stores `answer_form`)
- Modify: `apps/server/src/domain/distractors.ts` (`GenerationContext` gains the two fields; `generatedContent`; `withSiblingAlternatives` takes the stored list first), `apps/server/src/services/sessions.ts` (tiles from the answer form)
- Modify: `packages/core/src/api/schemas.ts` question schemas: the typed/spoken/tiles cards' right answer and the choice cards' shown form come from `answer_form ?? form`
- Test: `distractors.test.ts`, `sessions.prepare.test.ts`, an integration test rebuilding audit card 2260df83 (G)

Rules: a `typed_translation` / `say_translation` card's `alternatives` = stored `accepted_answers`, then that session's `typed` alternatives, then siblings, deduped, at most 10. `cloze_typed` keeps only the sentence task's alternatives (D1: not the stored list). When `answer_form` is set, the card asks for it: typed/spoken answer, tiles built from it, multiple choice / listen / reverse show it beside the rendering. The lemma rule is untouched, so `ora` still passes on the שעות card.

- [ ] **Step 1:** Failing tests: G — a rendering שעות with `answer_form = 'ore'` gives a typed card whose answer is `ore`, tiles containing `o r e`; `ora` on it is still `exact` by the lemma rule; on a שעה card `ore` is `wrong`. B — two sessions for `poi`/אז with a stored list `['allora','dopo']` both accept `allora` whatever the session's typed alternatives were. D — `io ho` accepted when the stored list holds it. Cloze typed ignores the stored list.
- [ ] **Step 2–4:** Run (fail), implement, run (pass). `npm test`, touched integration files. Commit.

### Task 5: Context sentences, marks and part of speech — server and wire (D6, D7, D8, D10)

**Files:**
- Modify: `apps/server/src/domain/distractors.ts` (prompt asks for `context`, `context_translation`, `context_word` on the D6 types and `sentence_word` on `sentence`/`translate` items; validation), or the separate context call if Task 1 chose it
- Create: `apps/server/src/domain/marks.ts` (+ test): `findMark(sentence: string, word: string): { start: number; end: number } | null` — exact match first, then after a Hebrew one-letter prefix (ו ה ב כ ל מ ש), ignoring niqqud; null when absent
- Modify: `apps/server/src/services/sessions.ts` (fallback; store columns), `apps/server/src/repo/questions.ts` (store and load; `findRecentContexts` for the "differs from last" rule; `findJudgeContext` returns the card's pair, else the saved example — D7)
- Modify: `packages/core/src/api/schemas.ts`: `ContextSchema = z.object({ text: z.string(), mark: z.object({ start: z.number().int(), end: z.number().int() }).nullable() })`; `context: ContextSchema.nullable()` on `MultipleChoice`, `ReverseChoice`, `TypedTranslation`, `SayTranslation`, `TypedMeaning`; `mark` on `ClozeTyped` and `SentenceTranslation` (into `sentence_translation`); `part_of_speech: z.string()` on `ListenChoice` and on each word of `MatchingBoardSchema`
- Modify: `apps/server/src/domain/judge.ts` meaning-judge prompt input stays `{ example, example_translation }`, now filled from the card's pair
- Modify: eval cases (context; meaning judge on a generated pair)

Rules (D6): Hebrew context on typed translation, say the translation, reverse choice; target-language context on typed meaning and multiple choice. Dropped (→ fallback) when a Hebrew context contains the target answer (form, lemma, answer form, any accepted answer, under `comparable`) or equals one of the gloss's recent contexts for that type. Mark not found → keep, `mark: null`. Fallback: the saved example's matching half (Hebrew: `exampleTranslation`; target: `example`), unmarked, with the other half as the hidden translation; no example → `context: null` and log `context_missing`. Sentence cards (D8): `sentence_word` located in `sentence_translation` with `findMark`; null mark is allowed.

- [ ] **Step 1:** Failing unit tests: `findMark` (exact, prefixed הורידה/להוריד-style misses return null, niqqud ignored); context rules (contains answer → fallback; repeat → fallback; no example → null); C rebuild — audit card d388f738 (`download`/להוריד) gets a Hebrew context; E rebuild — 71b0b407 (`saw`/לנסר) gets a target-language context and `findJudgeContext` returns it; H rebuild — a7d6bdb4 multiple choice gets a context; F rebuild — eb95d246-style sentence card carries a mark; matching words and listen cards carry `part_of_speech`.
- [ ] **Step 2–4:** Run (fail), implement, run (pass).
- [ ] **Step 5:** Eval: a context case for `saw`/לנסר (the generated sentence's checked meaning is לנסר, not ראה — use the checker from Task 6 if done, else assert the model's `context_word` is a form of `saw` and the sentence is not a *see* sentence by a hand list), and a meaning-judge case on a generated pair. Commit.

### Task 6: Known-right filter, spares and the checker (D3, D4, D5)

**Files:**
- Modify: `apps/server/src/repo/dictionary.ts` or `questions.ts`: `findKnownRight({ lexemeIds, variantIds, prompts, userLanguageCode, targetLanguage }): KnownRight` with `KnownRight = { meaningsByLexeme: Map<string, string[]>; wordsByPrompt: Map<string, string[]> }` — meanings: every rendering, gloss key and gloss alternative of every sense of the lexeme **and** of every homograph lexeme (another lexeme in the language with a variant of the same written form, lowercased); words: every `accepted_answers` entry of renderings with that exact Hebrew text in that language pair
- Modify: `apps/server/src/domain/distractors.ts`: `badChoice` refuses an option in the known-right set; choice items ask for 6 and `validateDistractors` keeps the first 3 passing (fails only under 3); `boardMeanings` uses the same set; `apps/server/src/domain/plan.ts` `boardPicks` refuses two words whose meanings overlap under it
- Create: `apps/server/src/domain/check.ts` (+ test): `buildCheckPrompt(items: CheckItem[], from, to)`, `parseCheck(raw): LlmCheck | null`, with `LlmCheckSchema` in core: `{ items: [{ key, options?: boolean[] /* true = also right */, context_meaning?: string, natural_translation?: string, gap_fits?: boolean[] }] }`
- Modify: `apps/server/src/services/sessions.ts` `prepareSession`: after validation, one checker call over every item; drop "yes" options (spares refill; under 3 → `InvalidDistractors`); drop a context whose `context_meaning` is outside the gloss's meanings (target-language context) or whose fitting words miss the form, lemma, answer form and accepted answers (Hebrew context) → D6 fallback; drop a `sentence_translation` / `cloze_typed` sentence whose `natural_translation` uses neither the practised word nor an accepted answer → phase 27's degraded path; cloze choice uses `gap_fits`. Unreadable checker answer → `InvalidDistractors` (retried). Log `checker_ms` on `session_prepared`.
- Modify: eval (`CHECK_CASES`)

- [ ] **Step 1:** Failing unit tests on audit cards: c49ddbec (*pick up*: להרים refused, a spare takes its place), 0fa3fc06 (תכף: `presto` refused via `wordsByPrompt`), the `saw` homograph (ראה refused on a `saw` card), board 1d268882 (אחר כך refused as the fifth meaning), `main`/`mainstream` not on one board; spares: 6 given, 2 refused → first 3 passing kept; 4 refused → failure; checker: a "yes" drops the option, a context outside the meanings falls back, בואו נשלב כוחות with natural translation "Let's join forces" degrades.
- [ ] **Step 2–4:** Run (fail), implement, run (pass). Integration: a session prepared through MockServer stubs (generation + checker) stores the filtered options.
- [ ] **Step 5:** Eval `CHECK_CASES`: *blow up*/להרוס → yes; *pick up*/להרים → yes; *blow up*/לקפל → no; *blow up*/לשבור → no; בואו נשלב כוחות → natural translation not using *combine*. Run the eval; read the scorecard. Commit.

### Task 7: The second try on the server (D9)

**Files:**
- Modify: `packages/core/src/api/schemas.ts`: `AnswerRecordSchema` gains `retry_state: z.enum(['pending','resolved']).nullable()`, `retry_answer_string: z.string().nullable()`, `retry_verdict: AnswerVerdictSchema.nullable()`; `NextStepRequestSchema`, `JudgedAnswerRequestSchema`, `SpeechAnswerRequestSchema` gain `retry: z.boolean().optional()`; `NextStepRequestSchema` also accepts `{ give_up: true, retry: true }`
- Modify: `packages/core/src/domain/quiz.ts` (`evaluate` marks `retry_state: 'pending'` when the verdict is `alternative` on `typed_translation`, `say_translation`, `typed_meaning`, `cloze_typed`, `sentence_translation`; `score` uses the first verdict)
- Modify: `apps/server/src/domain/session.ts` `step` / `currentQuestion`; `apps/server/src/services/sessions.ts` (`submitAnswer`, `answerJudged`, `answerBySpeech`, `skipSession`); `apps/server/src/repo/sessions.ts` (insert pending, resolve); `apps/server/src/repo/progress.ts` `findSessionEvidence`
- Test: `apps/server/src/domain/session.test.ts`, `sessions.test.ts`, `sessions.judge.test.ts`, `sessions.speech.test.ts`, `sessions.progress.test.ts`, integration

`step` rules:
```ts
const last = record.answers.at(-1);
const pending = last?.retry_state === 'pending' ? last : undefined;
// currentQuestion: while pending, the pending card is current.
// complete only when answers.length === questions.length && !pending.
if (pending && questionId === pending.question_id) {
  if (answer.retry) return resolve(record, pending, answer);   // judged as the first was; 'advanced', justCompleted when last card
  return { status: 'replayed', record, justCompleted: false };  // network retry of the first answer: pending flag in the record
}
if (pending) return { status: 'invalid_question' };
// existing rules; a request with `retry` at a resolved position replays; `retry` anywhere else is invalid_question
```
Progress evidence: `retry_verdict` when the retry resolved as `exact`, `near_miss` or `understood`; the first verdict otherwise. `skipSession` resolves a pending retry as `gave_up` before `recordProgress`. The judged and spoken routes check the pending state in their read transaction, call the model only for a fresh first answer or a fresh retry, and replay otherwise.

- [ ] **Step 1:** Failing tests, each on the typed, judged **and** spoken route: alternative → pending, session not advanced; first-answer replay returns pending; retry `exact` resolves and moves progress for the gloss; retry give-up resolves without progress; retry-of-retry replays with no model call (assert the judge/transcriber stub's call count); on the **last card** the session completes and `session_progress` is written only when the retry resolves (no duplicate-key error); a skip with a pending retry writes progress once; an unrelated question id while pending → desync.
- [ ] **Step 2–4:** Run (fail), implement, run (pass): `npm test`, the touched integration files. Commit.

### Task 8: The app (D6, D8, D9, D10)

**Files:**
- Create: `apps/mobile/src/components/ContextLine.tsx` (sentence, marked span bold, `writingDirection` by language: Hebrew RTL, others LTR)
- Modify: `apps/mobile/src/app/session.tsx` (context line on the five D6 cards; the mark in `translatePrompt` and `gapPrompt`), `TypedAnswerView.tsx`, `SpeakingCardView.tsx`, `MultipleChoiceView.tsx` (part of speech on listen choice), `MatchingBoardView.tsx` (part of speech under each word), the session hook that owns `submitText` / `submitJudged` / `submitSpeech` (pending state, `retry: true`, give-up), `apps/mobile/src/feedback.ts` (retry feedback), `apps/mobile/src/strings.ts`
- Test: `feedback.test.ts`, the session hook's tests, component tests where they exist

Behaviour: on a pending answer the card stays, showing `✓ נכון, <answer> מתאים כאן.` and `יש מילה נוספת ששמרת — נסו שוב` (typed meaning: `יש פירוש נוסף — נסו שוב`); the input is cleared, except sentence translation, which keeps the first sentence; the speaking card offers the microphone again; `הצגת התשובה` sends the give-up and shows the saved word as today's banner. Resuming a session whose last answer is pending opens the second try.

- [ ] **Step 1:** Failing tests: feedback for a pending answer and both strings; the hook sends `retry: true` on the second submit; resume lands on the second try; `ContextLine` marks the span and renders unmarked when `mark` is null.
- [ ] **Step 2–4:** Run (fail), implement, run (pass): `npm test --workspace apps/mobile`, `npm run typecheck --workspaces --if-present`. Commit.

### Task 9: MockServer, e2e and the full suite

**Files:**
- Modify: `e2e/` specs and their MockServer expectations for the checker and `accept` calls and the batch's new fields
- Create/modify: an e2e spec: a typed card shows its context line; an alternative answer gets the second try and the saved word then counts on the results screen; a sentence card shows its marked word

- [ ] **Step 1:** Add the expectations and the e2e spec; `npm run e2e` passes (if it fails only on `speaking.spec`'s known local flake, see memory; CI decides).
- [ ] **Step 2:** Done-means 1: confirm one test per category A–H exists, named `category <X> (<audit id>)`; add any missing.
- [ ] **Step 3:** `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e`, and the eval (`cd apps/server && npx tsx tests/eval/run.ts`) pass. Add an "As built" section to the spec for any departure. Commit.
