# Phase 59 — Easier translate-sentence card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Victor said "continue till PR": inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sentence-translation cards built from the learner's practised words, 3–5 words long, with every Hebrew word tappable for the Italian the answer needs; taps graded per the spec's D4.

**Architecture:** The batch call's `translate` rule gets the practised words and the new length. The context call's `mark` task (which already reads the Hebrew and its reference) also returns the word map; the server validates it into spans stored on the question and served on the wire. Taps travel on the judged answer and the pass, are stored in `answer_taps`, and a tap on a list word enters the session's evidence as a written-productive miss on that gloss.

**Tech Stack:** Hono + Drizzle + Postgres (server), Zod in `packages/core`, Expo / React Native (app), Gemini (prompts), Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-16-lang-tutor-phase-59-easier-translate-sentence-design.md`

## Global Constraints

- `TRANSLATE_MAX_WORDS` = 5; `SENTENCE_MIN_WORDS` stays 3.
- Practised words: list entries with at least one `gloss_memory` row; at most 200, most recently reviewed first.
- A bad word map never refuses a card or the session.
- Request fields are optional: `API_LEVEL` unchanged (ADR 0012).
- A tap miss counts in memory, progress and `dayState`; never in the score or the missed list (R5).
- A new field in an LLM response schema is measured first (`npx tsx tests/eval/measureSchema.ts --context` in `apps/server`) for a 400 and for the wait; record the numbers in the schema's comment, as the existing ones do.
- UI copy is Hebrew.
- Never hardcode a port or database name; run everything through the npm scripts.

## Review Focus

1. A non-target map entry carrying the target's Italian (multi-word *ci sono*): dropped, so no free reveal — Task 2 test.
2. A null mark: the entry whose Italian is the gap becomes the target; with neither, no target entry — Task 2 test.
3. A judged answer replayed or a second try re-sending the same taps: one miss per word per card — Task 3 test.
4. Giving up (show answer) after tapping a list word: the miss still lands, via the pass — Task 3 test.
5. A card stored before this phase (no `words`): served with `words: null`, answered as today; only the mark is tappable — Tasks 3 and 4 tests.

---

### Task 1: Generation — practised words and short sentences

**Files:**
- Modify: `apps/server/src/domain/sentences.ts` (`TRANSLATE_MAX_WORDS`)
- Modify: `apps/server/src/domain/distractors.ts` (`buildDistractorPrompt` input gains `learnerWords`)
- Modify: `apps/server/src/repo/vocabulary.ts` (or the repo holding list reads): `findPractisedWords`
- Modify: `apps/server/src/services/sessions.ts` (read it in the prepare read, pass it to both prompts)
- Test: `sentences.test.ts`, `distractors.test.ts`, the repo's integration test

**Interfaces:**
- Produces: `type LearnerWord = { key: string; glossId: string; word: string; meaning: string }` (key `w1`, `w2`, … in list order), exported from `domain/distractors.ts`.
- Produces: `findPractisedWords({ enrollmentId, limit }): Promise<{ glossId: string; word: string; meaning: string }[]>` — the variant's form and the gloss's translation, ordered by latest `gloss_memory.last_day` desc.
- Produces: `buildDistractorPrompt({ items, from, to, others, learnerWords })`.

- [ ] Tests: a 6-word Hebrew translate sentence is refused, a 5-word one kept; the prompt's user JSON carries `learner_words: [{ key, word, meaning }]` only when a `translate` item exists; the system text's translate rule says 3 to 5 words and to build the translation from `learner_words` as much as it can; the repo returns only practised entries, at most `limit`, newest first.
- [ ] Run, see them fail. Implement. Run `npm test` in the server and the repo's integration test; pass.
- [ ] Commit `feat(server): translate sentences from the learner's practised words, 3 to 5 words`.

### Task 2: The word map — context call, validation, storage, wire

**Files:**
- Modify: `packages/core/src/api/schemas.ts`: `LlmContextSchema` items gain `sentence_words: z.array(z.object({ hebrew: z.string(), translation: z.string(), word: z.string() })).optional()`; `SentenceTranslationQuestionSchema` gains `words: z.array(z.object({ start, end, text, target: z.boolean() })).nullable()`.
- Modify: `apps/server/src/domain/context.ts`: the `mark` rule (translation cards only, flagged by `MarkItem.map: true`) asks for `sentence_words`; the user JSON carries `learner_words` when a mapped item exists; `wordMapFor`.
- Create: migration `0041_sentence_words.sql` (via drizzle-kit): `questions.words jsonb` nullable; table `answer_taps` (Task 3 uses it; created here so one migration).
- Modify: `apps/server/src/db/schema.ts`, `services/sessions.ts` (store), `repo/questions.ts` (serve, without gloss ids).
- Test: `context.test.ts`, `sessions.prepare.test.ts`, `measureSchema.ts --context` run.

**Interfaces:**
- Produces: `type MapWord = { start: number; end: number; text: string; glossId: string | null; target: boolean }`.
- Produces: `wordMapFor(item: MarkItem, found: Found | undefined, mark: Mark | null, gap: string, learner: readonly LearnerWord[]): MapWord[] | null` — null when nothing usable.
- `answer_taps(session_id uuid, position int, word_index int, kind text check in ('target','list','free'), gloss_id text null, PK (session_id, position, word_index), FK (session_id, position) → answers on delete cascade)`.

Rules for `wordMapFor` (spec D2 as amended):
- Each entry's `hebrew` is located in the sentence left to right from the previous entry's end (exact text, then `comparable`); unlocated → dropped.
- `translation` must occur in the reference (`comparable` word sequence, as `holds` does) → else dropped.
- `target`: the entry's span overlaps the mark; with no mark, the entry whose `comparable(translation)` equals the gap's.
- A non-target entry whose translation's words overlap the gap's words → dropped.
- `word` naming a learner key → that `glossId`, unless it is the card's own gloss; any other value → null.
- Overlapping spans: keep the first.

- [ ] Measure the schema first: add the field, run `measureSchema.ts --context` with ten items including three mapped marks; record result in the comment. If it 400s or hangs, stop and fall back to a separate call (spec ruling to add).
- [ ] Tests for every rule above; a prepare test that a mapped translation card stores `words` and the served question has `words` without gloss ids; an unmapped one stores null.
- [ ] Implement; `npm test`, the prepare tests, `npm run lint:arch`; pass.
- [ ] Commit `feat(server): the word map of a translation card's Hebrew`.

### Task 3: Taps — wire, record, grade

**Files:**
- Modify: `packages/core/src/api/schemas.ts`: `JudgedAnswerRequestSchema` and `NextStepRequest`'s pass answer gain `tapped: z.array(z.number().int().min(0)).max(20).optional()`.
- Modify: `apps/server/src/services/sessions.ts` (`answerJudged`, the pass path), a repo `insertTaps`, `repo/progress.ts` (`findSessionEvidence`, `lockSessionGlosses`), `repo/sessions.ts` (`findAnswersOn`), `repo/glosses.ts` (merge re-keys `answer_taps.gloss_id`).
- Test: session service integration tests, `progress` repo integration test.

**Interfaces:**
- Consumes: `MapWord` stored on the question.
- Produces: `classifyTaps(words: MapWord[] | null, tapped: number[]): { index: number; kind: 'target' | 'list' | 'free'; glossId: string | null }[]` (pure, `domain/`), dropping out-of-range and duplicate indexes.

Behaviour:
- Taps are stored with the card's answer, `ON CONFLICT DO NOTHING`: a replay or a second try re-sending them adds only new indexes.
- A `target` tap sets the answer helped (as `helped: true`), on a first answer or a second try.
- Evidence: each `list` tap is one more evidence row after its card's answer — `gloss_id` the tap's, `type` `sentence_translation`, `verdict` `wrong`, `retry_verdict` null, `intro` false — ordered by `(position, 0)` for the answer and `(position, 1 + word_index)` for taps, in both `findSessionEvidence` and `findAnswersOn` (the latter joining `vocabulary_entries` on the tap's gloss). Score and missed list read `answers` only: untouched.
- `answer_judged` (and the pass log) gain `taps` (count) and `tap_misses` (gloss ids).

- [ ] Tests: classify rules; a list tap writes written productive Again on its own gloss and nothing on the score; a target tap stores helped; a free tap grades nothing; a replay and a second try with the same taps write one row each; a pass with taps records them; a pre-phase question with `tapped` ignores them; `findAnswersOn` returns the tap row after its card's.
- [ ] Implement; `npm run test:all`; pass.
- [ ] Commit `feat(server): a tapped word is recorded, and a list word's tap is a miss`.

### Task 4: The app — tappable words

**Files:**
- Modify: `apps/mobile/src/quiz.ts` (state gains `tapped: number[]`, reset per card like `help`; `tapPressedState(current, index, word)`: a target tap sets `help` to `steps(answer).length`), `hooks/useSession.tsx` (`pressWord`, `tapped` on judged and pass bodies for `sentence_translation`), `app/session.tsx` (`translatePrompt` renders `TappableSentence`).
- Create: `apps/mobile/src/components/TappableSentence.tsx`: the Hebrew sentence as runs; a tappable run underlined dotted, a tapped one shows its `text` under it; with `words` null, the mark is the one tappable run (help only, no index).
- Test: `quiz.test.ts`, e2e `sentence` spec.

- [ ] Tests: tap state per card, order of first taps, no duplicate; target tap fully reveals help and marks helped; bodies carry `tapped` only when non-empty; e2e: tap a non-target word and see its Italian, tap the target and see the help banner state, answer, check the body.
- [ ] Implement; `npm test` (mobile), `npm run e2e`; pass.
- [ ] Commit `feat(mobile): tap a word of the Hebrew sentence to see its Italian`.

### Task 5: Prompt evals

**Files:**
- Modify: `apps/server/tests/eval/cases.ts`, `run.ts` (translate cases gain Victor's-size learner list; checks: Hebrew 3–5 words, always; list share of the reference's content words ≥ threshold set from the first runs; word map located and target found).

- [ ] Add the checks, run evals locally (scratchpad script, `npx tsx`, per memory), set the threshold from what passes on three runs, commit `test(eval): translate sentences use the learner's words, and map them`.
- [ ] Push; compare the CI eval-report against master's per row.
