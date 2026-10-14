# Phase 50 — A word that sounds the same is understood: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an unheard spoken transcript gets a second look by pronunciation score, so a homophone of the card's word (`sell` for `cell`) is understood.

**Architecture:** pure pair-building beside the spoken judge in core; a pure prompt/parse module and a new model-call kind on the server; a shared `pronunciation_scores` table read before and written after one text call on the `judge` client, all outside any transaction; `answerBySpeech` builds a server-only `{ heard, sounds_like }` answer that `evaluate` records as `understood`.

**Tech Stack:** TypeScript, Zod 4, Drizzle (Postgres), Jest, Playwright, MockServer, Gemini.

**Spec:** `docs/superpowers/specs/2026-10-14-lang-tutor-phase-50-sounds-alike-design.md`

## Global Constraints

- The transcriber's prompt and schema do not change (spec D1, Scope).
- Default threshold 0.95, env `SOUND_ALIKE_THRESHOLD`, a value not in (0, 1] falls back (D4).
- Every field of the model's answer schema is required; no optional strings (D2).
- At most 8 pairs per call; the forms' pairs first (D1).
- The read, the call and the insert each run outside any other transaction (ADR 0001 R8).
- A failed or unreadable score call leaves `unheard`, stores nothing, is no 502 (D6).
- No wire change and no app change (spec header).
- No lane in this worktree (all 9 in use): integration and e2e run in CI only.

## Review Focus

- An empty transcript, or one with no letters (`...`): no pairs, no call, `unheard`.
- The model answers a key it was not asked, a score outside 0–1, or leaves one out: that pair is unscored, never a crash.
- Two learners score the same pair at once: the second insert is a no-op, both answers stand.
- A `sounds_like` answer on a say-the-translation retry resolves the retry as `understood`.
- A client cannot claim a sound match: the next-step body has no `sounds_like`.

---

### Task 1: Core — pairs, the answer member, the schema

**Files:**
- Modify: `packages/core/src/domain/spoken.ts` (add `soundPairs`, `MAX_SOUND_PAIRS`)
- Modify: `packages/core/src/domain/quiz.ts` (`AnswerInput` member; `evaluate`)
- Modify: `packages/core/src/api/schemas.ts`, `packages/core/src/api/types.ts` (`LlmSoundAlikeSchema`, `LlmSoundAlike`)
- Modify: `apps/server/src/domain/session.ts` (`refusal` skips `sounds_like`)
- Test: `packages/core/src/domain/spoken.test.ts`, `packages/core/src/domain/quiz.test.ts`, `apps/server/src/domain/session.test.ts`

**Interfaces:**
- Produces: `type SoundPair = { heard: string; form: string }` (both `spokenWords(...).join(' ')`); `soundPairs(target: SpokenTarget, heard: string): SoundPair[]`; `AnswerInput` gains `{ heard: string; sounds_like: string }`; `LlmSoundAlikeSchema = z.object({ scores: z.array(z.object({ key: z.string(), score: z.number() })) })`.

- [ ] Tests first: `soundPairs` — `cell`/`sell` → `[{heard:'sell', form:'cell'}]`; `il gatto`/`gatto` (letter match) not asked here, but `il gatto` vs `un gato` gives `gato` against `gatto` and `un gato` against `il gatto`; a word inside more words (`i sell` → `sell` vs `cell`, `i` vs `cell`); a phrase form takes stretches of its length; dedup; the cap of 8, forms' pairs first; empty and letterless transcripts give `[]`; a stretch equal to the form is not a pair.
- [ ] Tests: `evaluate(READ, { heard: 'sell', sounds_like: 'cell' })` → `is_correct: true, verdict: 'understood', answer_string: 'sell'`; `evaluateRetry` on SAY with one → `understood`; `step` accepts a `sounds_like` answer whose letters are unheard, still refuses a bare one.
- [ ] Run and see them fail; implement; run `npx jest` in `packages/core` and `apps/server` (unit) and see them pass.
- [ ] Commit.

### Task 2: Server domain — the prompt, the parse, the threshold, the kind

**Files:**
- Create: `apps/server/src/domain/soundAlike.ts`, `apps/server/src/domain/soundAlike.test.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/config.test.ts`, `apps/server/src/services/llm.ts` (`'sound_alike'`)

**Interfaces:**
- Produces: `SOUND_ALIKE_MARKER = 'how alike they sound'`; `DEFAULT_SOUND_ALIKE_THRESHOLD = 0.95`; `buildSoundAlikePrompt(language: LanguageCode, pairs: readonly SoundPair[]): { system: string; user: string; schema: typeof LlmSoundAlikeSchema }` — the user part is JSON `{ pairs: [{ key: 'p1', a, b }] }`; `parseSoundAlike(raw: string, count: number): (number | null)[] | null` — null when unreadable, else one entry per pair, null for an unscored one; `soundAlikeThreshold(value: string | undefined): number`. Config gains `soundAlikeThreshold: number`.
- [ ] Tests first: the prompt carries the marker, the language name, every pair under its key, the anchored scale, and none of the eval's pairs; the parse maps keys back, drops unknown keys and scores outside 0–1, answers null for '', fenced JSON is read; the threshold: default, `0.9`, `0`, `1.5`, `abc`.
- [ ] Implement; run; commit.

### Task 3: The table, the migration, the repo

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`pronunciationScores`)
- Create: `apps/server/src/db/migrations/0034_*.sql` via `npx drizzle-kit generate` in `apps/server`
- Create: `apps/server/src/repo/pronunciationScores.ts`; Modify: `apps/server/src/services/transaction.ts` (`pronunciation` in `Repos`), `apps/server/src/composition.ts` (`bindRepos`)
- Test: `apps/server/tests/integration/repo/pronunciationScores.test.ts`; `apps/server/tests/integration/db/schema.test.ts` (`TABLES`)

**Interfaces:**
- Produces: `createPronunciationRepo(tx)` with `find(language: string, pairs: readonly { a: string; b: string }[]): Promise<{ a: string; b: string; score: number }[]>` and `insert(language: string, rows: readonly { a: string; b: string; score: number }[]): Promise<void>` (`ON CONFLICT DO NOTHING`). Callers pass `a < b`.
- [ ] Columns per spec D3; checks: `form_a < form_b`, each form 1–100 chars, score between 0 and 1.
- [ ] Integration test (CI): insert then find; a second insert of the same pair keeps the first score; the checks refuse a reversed pair and a score of 1.5.
- [ ] Typecheck; commit.

### Task 4: `answerBySpeech` — the second look

**Files:**
- Modify: `apps/server/src/services/sessions.ts`, `apps/server/src/composition.ts` (pass `soundAlikeThreshold`), `apps/server/src/index.ts` if it builds the io object
- Test: `apps/server/src/services/sessions.speech.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- [ ] After `spokenVerdict` returns `unheard` with a non-empty transcript: `soundPairs`, order each pair, `transaction(r => r.pronunciation.find(...))`, call `judge` for the missing ones with `{ kind: 'sound_alike', sessionId, enrollmentId, userId }`, `transaction(r => r.pronunciation.insert(...))` for the scored ones, take the best; at or above the threshold build `{ heard, sounds_like: form }` and record it through `submitAnswer`. The response's verdict is `understood`.
- [ ] Failure: catch around the call and parse, log `sound_alike_failed` (`session_id`, `question_type`, `sound_ms`, `reason`), verdict stays `unheard`.
- [ ] `speech_judged` gains `sound_score`, `sounds_like`, `sound_ms`, `sound_called` when the second look ran.
- [ ] Tests first: a stored pair calls nothing and is understood; a missing pair calls once, stores, is understood; 0.9 stays unheard and records nothing; a failed call stays unheard and logs; a letter match never reaches it; the retry clip gets it; existing unheard tests get a fake score.
- [ ] Run unit tests, typecheck, `./scripts/check-adrs.sh`; commit.

### Task 5: E2e

**Files:**
- Modify: `e2e/tests/support/mockServer.ts` (`expectSoundAlike(request, score)`), `e2e/tests/speaking.spec.ts`
- [ ] The read-aloud card (ромашка): `кошка` with a score of 0.1 is not understood; the try again is heard `рамашка` (unstressed о said а) with a score of 1, and the banner says "נכון! שמענו:" with `рамашка`.
- [ ] The stub answers key `p1` (one pair each time), matched on the marker, priority 10, once.
- [ ] Typecheck the e2e workspace; commit. Runs in CI.

### Task 6: Eval

**Files:**
- Modify: `apps/server/tests/eval/cases.ts` (`SOUND_ALIKE_CASES`), `apps/server/tests/eval/run.ts` (the group, its tier 1 and tier 2, the printed scores)
- [ ] The spec D8 table, one call per case, plus one tier 1 batch of three pairs.
- [ ] Run `npx tsx tests/ev?l/run.ts` filtered to the sound group from `apps/server` when a key is available; otherwise CI's `test-eval`. Compare the CI report against master's per row.
- [ ] Commit; spec rulings; finish (`git-create-pr`, `ci-green`).
