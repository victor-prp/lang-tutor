# Phase 61 — Every question type for one word: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (Victor said "go till PR": inline). Steps use checkbox (`- [ ]`) syntax.

**Goal:** a tester starts, from a saved sense on a word's page, a session with one card per chosen question type, and sees which types the word cannot have and why.

**Architecture:** a pure domain module (`domain/questionTypes.ts`) owns the type order, the availability rule, the fixed rendering, the plan and the keep rule. A new service and route file serve the read and the create. `prepareSession` gains a `question_types` mode that replaces `planCards` and the fallbacks. The app adds one screen.

**Tech Stack:** Hono + zod-openapi, Drizzle, pg-boss, Jest; Expo Router; Playwright.

**Spec:** `docs/superpowers/specs/2026-10-16-lang-tutor-phase-61-word-question-types-design.md`

## Global Constraints

- `API_LEVEL` stays 4: only added endpoints and added response fields (ADR 0012).
- Routes → services → domain/repo; domain pure; transactions in services (ADR 0001). Every route through `createRoute` (ADR 0003). The job enqueued inside the transaction (ADR 0007).
- Access: `authorizeEnrollment(... 'session.practice')`, then `tester`, else 403 `not_a_tester`.
- `sessions.source` stays `'list'`; the new session has `kind = 'question_types'` and `chosen_on = null` (so `mayBeStale` never touches it).
- All app copy Hebrew.
- Never hardcode a port or database name; tests through `npm run` scripts.

## Review Focus

1. A word with one gloss of several member senses: the read and the session use the same rendering. Pinned in Task 4 (create sends back the read's `sense_id`; a mismatched `sense_id` is 400).
2. Every chosen card refused: the session is `failed` at once with `skipped_types`, not thrown. Pinned in Task 5.
3. A tester with a started session, or with an unstarted seed: 409, nothing written. Pinned in Task 4.
4. A non-tester or a tutor grantee calling either endpoint: 403. Pinned in Task 4.
5. `meet` chosen alone: one card, kept (no `dropLoneMeets`). Pinned in Task 5.

---

### Task 1: Tester flag, session columns, wire fields

**Files:**
- Modify: `apps/server/src/db/schema.ts` (users: `tester boolean not null default false`; sessions: `kind text not null default 'practice'` with check `sessions_kind_known` in `('practice','question_types')`, `skipped_types jsonb` nullable), then `npm run db:generate --workspace apps/server` for the migration.
- Modify: `apps/server/src/repo/users.ts` (user row → `tester`; `setTester(email, on): Promise<'set' | 'no_such_account'>` by the auth user's email).
- Modify: `apps/server/src/db/cli.ts` (`--set-tester --email <a> [--off]`), `apps/server/package.json` (`db:tester`), root `package.json` (`db:tester` through `lane-env.sh`).
- Modify: `packages/core/src/api/schemas.ts`: `UserSchema.tester: z.boolean()`.
- Test: `apps/server/tests/integration/repo/users.tester.test.ts`, and `routes/me.test.ts` (an added assertion).

- [ ] Write tests: `setTester('a@x.io', true)` → `'set'` and `/api/me` returns `user.tester === true`; `--off` → false; an unknown email → `'no_such_account'`; a new user's `tester` is false.
- [ ] Run `npm run test:integration -- --runTestsByPath <paths>`: FAIL.
- [ ] Implement it, then generate the migration.
- [ ] Run the tests: PASS. Run `npm run typecheck` (mobile fixtures typed `User` gain `tester: false`).
- [ ] Commit `feat(server): a tester flag per account, set by db:tester`.

### Task 2: Domain — `domain/questionTypes.ts`

**Interfaces (Produces):**
- `QUESTION_TYPE_ORDER: readonly QuestionType[]`: `meet, multiple_choice, new_meaning, typed_meaning, reverse_choice, cloze_choice, letter_tiles, typed_translation, cloze_typed, sentence_translation, listen_choice, dictation, read_aloud, say_translation, matching` (each dimension's recognition before recall).
- `UNAVAILABLE_REASONS = ['no_voice','no_microphone','too_long','no_tiles','no_example_gap','no_other_meaning','needs_more_words'] as const`, plus `type UnavailableReason`. The tuple is exported from core (`packages/core/src/domain/quiz.ts`) so the wire schema and the app share it.
- `type WordFlags = { tiles: boolean; speakable: boolean; clozeGap: boolean; otherMeanings: number }`.
- `questionTypesFor(word: WordFlags, devices: Devices): { type: QuestionType; available: boolean; reason?: UnavailableReason }[]` in `QUESTION_TYPE_ORDER`. The rules are the spec's D2 table. When several reasons apply, the first in the table's row order wins: devices before the word.
- `renderingFlags(row: { form; answerForm; lemma; example; exampleTranslation }): Pick<WordFlags,'tiles'|'speakable'|'clozeGap'>` moves the three expressions out of `prepareSession`'s `planCards` call, which then calls it too.
- `fixedRendering(gloss: Omit<SavedGloss,'savedAt'>, renderings: readonly GlossRendering[], variantId: string): GlossRendering | undefined` returns the first of `askableRenderings(gloss, renderings)` whose `variantId` matches, else undefined.
- `questionTypesPlan(types: readonly QuestionType[]): SessionPlan` returns `{ order: types.map(() => 0), types: [...types], intro: types.map((t) => t === 'meet'), board: null }`, with `types` already in `QUESTION_TYPE_ORDER`.
- `keepQuestionTypeCards(units: readonly CardUnit[], typeOf: (i) => QuestionType): CardFate[]`. An unrefused card is `keep`. A card refused by the checker whose generated type is a choice type (`CHOSEN`) is `keep_refused` / `as_generated`. Every other refused card is `drop`.

- [ ] Write `domain/questionTypes.test.ts`: each D2 reason, with `read_aloud` available at any level, speaking on with one word, and `matching` always `needs_more_words`. Order matches `QUESTION_TYPE_ORDER`. The plan of `['meet','dictation']` is order `[0,0]`, intro `[true,false]`. The keep rule covers each of its three branches. `fixedRendering` picks the matching variant's first sense.
- [ ] Run `npm test --workspace apps/server -- questionTypes`: FAIL. Implement. PASS. Run `domain/plan.test.ts` and the sessions service tests too, since `renderingFlags` moved.
- [ ] Commit `feat(server): which question types one word can have`.

### Task 3: Core wire schemas

**Produces** (in `packages/core/src/api/schemas.ts`):
- `UnavailableReasonSchema = z.enum(UNAVAILABLE_REASONS)`.
- `QuestionTypesQuerySchema { gloss_id, variant_id, listening: boolish, speaking: boolish }`, following the existing query boolean idiom.
- `QuestionTypesResponseSchema { sense_id: string; types: { type: QuestionTypeSchema; available: boolean; reason?: UnavailableReasonSchema }[] }`.
- `CreateQuestionTypeSessionRequestSchema { gloss_id, variant_id, sense_id, types: z.array(QuestionTypeSchema).min(1), listening: boolean, speaking: boolean }`, refined to have no repeats.
- `CreateQuestionTypeSessionResponseSchema { session_id, status }`.
- `SessionViewSchema.skipped_types: z.array(z.object({ type: QuestionTypeSchema, reason: z.literal('not_generated') })).optional()`.

- [ ] Add them, plus a core unit test that a repeated type is refused. `npm run typecheck` passes. Commit with Task 4.

### Task 4: Service and routes

**Files:**
- Create: `apps/server/src/services/questionTypes.ts`, as `createQuestionTypesService(deps)` composed in the composition root like its siblings.
- Create: `apps/server/src/routes/questionTypes.ts`, mounted where `vocabulary` is:
  - `GET /enrollments/{id}/vocabulary/question-types`
  - `POST /enrollments/{id}/question-type-sessions`
- Modify: `repo/sessions.ts`. `insertPreparingSession` takes an optional `{ kind?: 'practice' | 'question_types' }`, and `chosenOn` becomes `string | null`.
- Errors, mapped where the other domain errors map:
  - `NotATester` → 403 `not_a_tester`
  - `QuestionTypeUnavailable` → 400 `question_type_unavailable`
  - `GlossNotSaved` → 404 `gloss_not_saved`
  - `RenderingMismatch` → 400 `rendering_mismatch`
  - `SeedPending` → 409 `seed_pending`
  - `SessionOpen` stays as it is.
- Test: `apps/server/tests/integration/routes/questionTypes.test.ts`.

**Read (`readQuestionTypes`):** in one transaction: authorize, then tester. Find the saved gloss in `vocabulary.listSavedGlosses`, filtered by id. Get `dict.findGlossRenderings` for it, then `fixedRendering`, then `question.findGenerationContext` for that one rendering, then `usableAnswerForm`, then `renderingFlags`. `otherMeanings` counts the saved glosses with the same `lexemeId`, this one excluded. The response is `{ sense_id, types: questionTypesFor(flags, devices) }`.

**Create (`createQuestionTypeSession`):**
1. The same read. Then `sense_id` must equal the fixed rendering's. Every requested type must be available.
2. `lockNextSession`, then `findOpen`. A started session throws `SessionOpen`. A stock whose source is `'seed'` throws `SeedPending`. Any other stock goes through `retireStock`.
3. `insertPreparingSession(user, enrollment, devices, null, { kind: 'question_types' })`.
4. Enqueue `PREPARE_SESSION` with one pick: `{ gloss_id, sense_id, variant_id, known_meanings: <other saved glosses' key> when new_meaning is chosen }`, plus `question_types: types sorted by QUESTION_TYPE_ORDER`, `listening` and `speaking`.

- [ ] Write the integration tests:
  - The read lists 15 types. A word without an example gap shows `cloze_choice` `no_example_gap`. `listening=false` makes `dictation` `no_voice`.
  - Non-tester: 403 on both. Tutor grantee who is a tester: 403.
  - An unavailable type, or a wrong `sense_id`: 400.
  - An unsaved gloss: 404.
  - A started session: 409 `session_open`. Seed stock: 409 `seed_pending`.
  - A list stock is retired (status `skipped`) and the new session has kind `question_types`, `chosen_on` null, and a `PREPARE_SESSION` job with `question_types`.
- [ ] Run them: FAIL. Implement. PASS. Run `npm run lint:arch`.
- [ ] Commit `feat(server): read a word's question types and start a session of them`.

### Task 5: `prepareSession` question-types mode

**Files:**
- Modify: `apps/server/src/domain/jobs.ts`. `PrepareSessionPayloadSchema` gains `question_types: z.array(QuestionTypeSchema-enum).min(1).optional()`.
- Modify: `apps/server/src/services/sessions.ts` (`prepareSession`).
- Modify: `repo/sessions.ts`:
  - `setSkippedTypes(sessionId, skipped)`
  - `loadSession` returns `skippedTypes`
  - `getSession` → the route puts `skipped_types` on the view only when it is non-null
- Test: `apps/server/tests/integration/jobs/prepareSession.questionTypes.test.ts`, modelled on `prepareSession.cards.test.ts`.

With `const qt = payload.question_types`:
- `plan = qt ? questionTypesPlan(qt) : planCards(...)`.
- In `cards`, a degraded sentence card under `qt` keeps its planned type and becomes a validation refusal (`refusals.set(index, { stage: 'validation', reason })`).
- In `final`, the checker's translate rejection under `qt` marks the index in a `notGenerated` set, instead of degrading it.
- `fateOf` uses `keepQuestionTypeCards(units, i => plan.types[i])` under `qt`, without `dropLoneMeets`. Otherwise it is unchanged.
- `kept` also excludes `notGenerated`. `skipped` is `[...dropped, ...notGenerated].map(i => ({ type: plan.types[i], reason: 'not_generated' }))`.
- If `qt` and `kept.length === 0`, then in one transaction: `transition(['preparing'],'failed')`, then `setSkippedTypes`, then log `session_preparation_failed` with `reason: 'no_card_generated'`, then return.
- Otherwise the write transaction also calls `setSkippedTypes` when `qt`.

- [ ] Write the tests (Gemini stubbed as the cards test does):
  - All 13 non-matching, device-gated types are chosen with both devices on, and give exactly those cards in order.
  - A `sentence_translation` with no usable sentence is absent, and `skipped_types` names it, rather than giving a `typed_translation`.
  - A choice card short of distractors is dropped and named.
  - A checker-ambiguous choice card is kept.
  - `['meet']` alone gives one card.
  - Every card refused gives status `failed`, `skipped_types` set, no throw.
  - Completing a question-types session writes progress for the gloss.
  - The `GET /sessions/{id}` view carries `skipped_types`.
- [ ] Run: FAIL. Implement. PASS. Re-run the whole `prepareSession.*` group.
- [ ] Commit `feat(server): prepare a session of the chosen question types`.

### Task 6: App

**Files:**
- Modify: `apps/mobile/src/api/client.ts`. Add `questionTypes(enrollmentId, { glossId, variantId, listening, speaking })` and `createQuestionTypeSession(enrollmentId, body)`, parsed with Task 3's schemas.
- Create: `apps/mobile/src/questionTypes.ts`, a pure module. It holds `QUESTION_TYPE_NAMES: Record<QuestionType, string>` and `REASON_TEXT: Record<UnavailableReason, string>` (Hebrew), plus `initialSelection(types): Set<QuestionType>`, which ticks every available type. Its test is `apps/mobile/src/questionTypes.test.ts`.
- Create: `apps/mobile/src/app/vocabulary/question-types.tsx`, params `glossId`, `variantId`:
  - It reads with the device flags `useNextSession` uses (`voicesRead`, `canRecord`).
  - Each row is a type name, either with a checkbox or greyed with its reason.
  - "התחל" posts the selection, then polls `getSession` every second until `ready`, then calls `start`, `enter(sessionId)` and `router.push('/session')`.
  - On `failed`, it shows "לא נוצרה אף שאלה" and the skipped list. On 409 it shows "יש תרגול פתוח — סיימו אותו קודם", or for `seed_pending` "סיימו קודם את התרגול הראשון".
- Modify: `apps/mobile/src/app/vocabulary/word.tsx`. Each saved sense gets a link "בדיקת סוגי שאלות" when `useCurrentUser().me?.user?.tester`, pushing to the new screen.
- Modify: `apps/mobile/src/app/results.tsx`. When `skipped_types` is non-empty, it shows "לא נוצרו:" and the names.
- Each new element gets a `testID` for e2e: `question-types-link`, `question-type-<type>`, `question-types-start`, `skipped-types`.

- [ ] Write `questionTypes.test.ts`: every type and reason has a non-empty Hebrew name, and `initialSelection` ticks only the available types. Run `npm test --workspace apps/mobile -- questionTypes`: FAIL. Implement. PASS.
- [ ] Build the screen, the link and the results lines. `npm run typecheck` passes.
- [ ] Commit `feat(mobile): a tester starts a session of a word's question types`.

### Task 7: e2e

**Files:** Create `e2e/tests/word-question-types.spec.ts`. Set the flag with the e2e database helper (`update users set tester = true` for the signed-up learner), as `support/memory.ts` writes the DB.

- [ ] Write the spec:
  - A learner saves a `SINGLE_WORDS` word and sees no link on its page.
  - After the flag is set and the app reloads, the link shows.
  - The screen lists `matching` greyed. The tester unticks every type except `multiple_choice` and `typed_translation`, then starts. Gemini is stubbed through `expectGeneration` / `expectCheck`.
  - Both cards are answered, and the results screen shows.
- [ ] Run `npm run e2e -- word-question-types`: PASS. Then `npm test`, `npm run typecheck`, `npm run lint:arch`.
- [ ] Commit `test(e2e): a tester runs a word's question types`.
