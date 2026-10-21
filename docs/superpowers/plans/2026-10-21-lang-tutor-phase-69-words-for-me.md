# Phase 69 — Words for me Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A learner answers two level questions once, then goes through rounds of model-proposed words ("אין לי מושג" or a typed Hebrew meaning) until they hold the goal's count of unknown words, unticks any on the list, and saves the rest to My words.

**Architecture:** A new `discovery` slice on the server: `domain/discovery.ts` (pure level rule, prompt, parser), `repo/discovery.ts` over three tables, `services/discovery.ts` (use cases plus one lookup job), `routes/discovery.ts`. The photo import's row lookup is extracted to a shared function, and its row shape (`PhotoImportItem`) and `saveEntriesInTx` are reused. In the app: one screen, `app/discover.tsx`, opened from מילים, reusing `PhotoImportRow`.

**Tech Stack:** Hono + `@hono/zod-openapi`, Drizzle + Postgres, pg-boss, Gemini (`LlmClient`), Expo Router, Playwright + MockServer.

**Spec:** `docs/superpowers/specs/2026-10-21-lang-tutor-phase-69-words-for-me-design.md`

## Global Constraints

- Every user-visible string is Hebrew, in `apps/mobile/src/strings.ts`, worded in the plural or gender-neutral (memory: hebrew-only-ui-copy). The spec's copy is verbatim.
- ADRs bind: no `db/` in services, one transaction per dependent write set, the model called outside transactions, jobs enqueued through `repos.jobs`, handlers registered in `worker.ts` only, every route through `createRoute`, wire schemas in `packages/core/src/api/schemas.ts`, types `z.infer`.
- LLM response schemas: every field required, no optional or nullable strings.
- No port or database name hardcoded. `API_LEVEL` stays 6.
- Constants (spec D3–D6): `LEVEL_MIN 1`, `LEVEL_MAX 12`, `FIRST_LEVEL { none: 1, basic: 2, simple: 3, everyday: 5, fluent: 7 }`, `SETTLE_MIN_ANSWERED 4`, `CANDIDATES 14`, `ROUND_SIZE 10`, `MAX_ROUNDS 8`, `EXCLUDE_IN_PROMPT 400`, `GOAL_CHOICES [5, 10, 15, 20, 30]`, `DEFAULT_GOAL 15`, `MAX_GOAL 30`, the marker `propose new words for a learner`.
- Commits: `git commit` in its own call; the plan's task-done script is not used (memory: task-done-script-refused).

## Review Focus

1. **A round racing an answer or a round.** Two `POST …/rounds` (a double tap) must write one round; an answer landing between the round's read and write must not be lost. Pinned in Task 4's tests.
2. **A replayed answer.** A retried POST after a lost response answers the first verdict and enqueues no second lookup. Pinned in Task 4.
3. **The goal reached on the last card of a round.** The run goes to its list and settles the level once; no next round is offered. Pinned in Task 4.
4. **A lookup finishing after a discard or a save.** The job writes nothing and does not throw. Pinned in Task 5.
5. **Resuming in the app.** Opening the screen with a run in `asking` and no unanswered card fetches the next round instead of showing an empty card. Pinned in Task 8's pure step function.

---

### Task 1: The wire contract and the pure rules

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `packages/core/src/api/types.ts`, `packages/core/src/api/index.ts`
- Create: `apps/server/src/domain/discovery.ts`, `apps/server/src/domain/discovery.test.ts`

**Interfaces — Produces:**
- Core schemas and their types: `DiscoverySelfLevelSchema` (`none|basic|simple|everyday|fluent`), `DiscoveryLearningContextSchema` (`school|course|self|family`), `DiscoveryProfileSchema { self_level, learning_context, level }`, `DiscoveryProfileCreateSchema { self_level, learning_context }`, `DiscoveryRunStatusSchema` (`asking|listing|saved|discarded`), `DiscoveryRunSchema { id, goal, status, unknown_count, round, cards: { position, word }[], items: PhotoImportItem[] }`, `DiscoveryStateSchema { profile: DiscoveryProfile | null, run: DiscoveryRun | null }`, `DiscoveryRunCreateSchema { goal: int 1..30 }`, `DiscoveryAnswerRequestSchema` = discriminated union on `kind`: `{ kind: 'unknown' }` | `{ kind: 'typed', text: string 1..300 }`, `DiscoveryAnswerResultSchema { known, meaning, run }`, `LlmDiscoverySchema { words: { word, part_of_speech: PartOfSpeechSchema, hebrew, alternatives: string[] }[] }`.
- `domain/discovery.ts`: the constants above; `firstLevel(self: DiscoverySelfLevel): number`; `levelAfter(level: number, answered: readonly { known: boolean }[]): number`; `bandOf(level: number): { cefr: 'A1'|'A2'|'B1'|'B2'|'C1'|'C2'; half: 'lower'|'upper' }`; `wordKey(text: string): string` (lower-cased `normalizeForm` after `stripStress`); `buildDiscoveryPrompt(input: { target: LanguageCode; level: number; age: number; learningContext: DiscoveryLearningContext; exclude: readonly string[] }): { system; user; schema }`; `type ProposedWord = { word; partOfSpeech; hebrew; alternatives: string[] }`; `parseDiscovery(raw: string, exclude: ReadonlySet<string>): { words: ProposedWord[]; dropped: number } | null`.

- [ ] **Step 1: Write the failing tests** in `domain/discovery.test.ts`:
  - `firstLevel`: none→1, basic→2, simple→3, everyday→5, fluent→7.
  - `levelAfter`: 3 answered → unchanged; at level 5 with 10 answered: 8 known → 7, 6 known → 6, 3 known → 5, 2 known → 5, 1 known → 4, 0 known → 3; clamps (level 12 + 10/10 → 12, level 1 + 0/10 → 1); 5 answered with 4 known (0.8) → +2.
  - `bandOf`: 1→A1 lower, 2→A1 upper, 7→B2 lower, 12→C2 upper.
  - `buildDiscoveryPrompt`: the system holds the marker, `14`, the language's name, `B1`, `upper`; the user JSON holds `age`, `learning_context` and `exclude` cut to the first 400 items.
  - `parseDiscovery`: drops a Hebrew-script word, an empty or over-`MAX_ITEM_LENGTH` one, a duplicate by `wordKey` (`Gatto` after `gatto`), one whose key is in `exclude`; keeps at most 10; counts the drops; `null` for non-JSON or a schema miss; trims `hebrew` and `alternatives`, dropping empty alternatives.

- [ ] **Step 2: Run** `npx jest src/domain/discovery.test.ts` from `apps/server`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement** the schemas and `domain/discovery.ts`. The prompt follows `domain/photoReading.ts`: the system names the task with the marker, the learner (a Hebrew speaker learning `{name}`), the band (`CEFR {cefr}, the {half} half of it`), and rules: 14 items; mostly single words, a short fixed expression only when it is one dictionary entry; dictionary form, no article; fit for the learner's age (a child gets no adult topics) and context (`school`: words of school curricula for that age; `course`: course-book vocabulary; `self`: practical everyday words; `family`: home and family talk); none whose dictionary form is in `exclude`; `hebrew` the main meaning, `alternatives` other right Hebrew meanings, possibly none; no niqqud. The user part is JSON `{ language, level: "B1 upper", age, learning_context, exclude }`. The Hebrew-script test is `/[֐-׿]/`.

- [ ] **Step 4: Run** the test again, then `npx tsc --noEmit -p packages/core` and `npx tsc --noEmit -p apps/server`. Expected: PASS, no type errors.

- [ ] **Step 5: Commit** `feat(server): phase 69 the discovery wire, level rule, prompt and parser`.

### Task 2: Storage

**Files:**
- Modify: `apps/server/src/db/schema.ts`; generate `apps/server/src/db/migrations/0048_discovery.sql` and its snapshot (`npx drizzle-kit generate --name discovery` from `apps/server`)
- Create: `apps/server/src/repo/discovery.ts`, `apps/server/tests/support/discoveryRows.ts`, `apps/server/tests/integration/repo/discovery.test.ts`
- Modify: `apps/server/src/services/transaction.ts` (`discovery: DiscoveryRepo`), `apps/server/src/composition.ts` (`bindRepos`), `apps/server/src/repo/vocabulary.ts` (`savedLemmas`)

**Interfaces — Produces** (`createDiscoveryRepo(tx)`, rows in camelCase as `repo/photoImports.ts`):
- `ProfileRow { enrollmentId, selfLevel, learningContext, level }`; `RunRow { id, enrollmentId, goal, status, settledRound, createdAt, endedAt }`; `CardRow { runId, position, round, level, word, partOfSpeech, hebrew, alternatives, answer, typedText, verdict, known, judgedBy, answeredAt, lookupStatus, correctedForm, options, suggestedGlossId, chosenGlossId, ticked, hebrewMismatch, reason }`.
- `findProfile(enrollmentId)`, `insertProfile(input): Promise<ProfileRow | undefined>` (undefined on conflict), `setLevel(enrollmentId, level)`.
- `findOpenRun(enrollmentId)`, `insertRun({ enrollmentId, goal }): Promise<RunRow | undefined>` (undefined when the open-run index refuses), `findRun(id)`, `findRunForUpdate(id)`, `transition(id, from: RunStatus[], to: RunStatus): Promise<boolean>` (sets `ended_at` when `to` is not `asking`), `setSettledRound(id, round)`.
- `listCards(runId)` by position; `insertCards(runId, cards: { position; round; level; word; partOfSpeech; hebrew; alternatives }[])`; `answerCard(runId, position, a: { answer; typedText; verdict; known; judgedBy; lookupStatus: 'pending' | null; answeredAt: Date }): Promise<boolean>` (only where `answer is null`); `writeLookup(runId, position, result: ItemResult): Promise<boolean>` (only where `lookup_status = 'pending'`); `markLookupFailed(runId, position): Promise<boolean>`; `updateItem(runId, position, { ticked?; chosenGlossId? }): Promise<CardRow | undefined>`.
- `answeredWords(enrollmentId): Promise<string[]>`: words of answered cards in every run, newest answer first.
- Vocabulary: `savedLemmas(enrollmentId): Promise<string[]>`, newest save first.
- Support: `seedDiscoveryRun(db, { enrollmentId, status, goal?, cards: SeedCard[] }): Promise<string>`.

- [ ] **Step 1: Write the failing repo test** (`tests/integration/repo/discovery.test.ts`): a profile inserts once (second → undefined); a second open run → undefined, a saved one doesn't block a new one; `answerCard` twice → second false; `writeLookup` on a non-pending card → false; `transition` from a wrong status → false and sets `ended_at` when it moves; `answeredWords` excludes unanswered cards and orders newest first; cards cascade with the run; the checks refuse a goal of 31, a level of 13 and a tick without a gloss.

- [ ] **Step 2: Run** `npx jest --selectProjects=integration --runTestsByPath tests/integration/repo/discovery.test.ts` (memory: jest-select-projects-path). Expected: FAIL.

- [ ] **Step 3: Implement** the tables per spec D9 (checks named `discovery_*_known`, `discovery_runs_one_open_per_enrollment` partial unique index, FKs as `photo_imports`' with cascade from cards to runs), the migration, the repo, `savedLemmas`, the binding, the seed helper.

- [ ] **Step 4: Run** the repo test, `npm run db:migrate` (the lane's database), `npx tsc --noEmit -p apps/server`, `npm run lint:arch`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(server): phase 69 discovery tables and repository`.

### Task 3: One row lookup for photos and discovery

**Files:**
- Create: `apps/server/src/services/rowLookup.ts`
- Modify: `apps/server/src/services/photoImports.ts` (`lookUpItem` calls it), `apps/server/src/errors.ts` (`SenseMatchUnreadable` names a row of anything)

**Interfaces — Produces:** `lookUpRow(deps: { lookup; llm }, input: { enrolled: Enrollment; text: string; hebrew: string | null; record: ModelCallRecord; onUnreadable: () => Error }): Promise<{ result: ItemResult; matchedBy: MatchedBy | null }>`: the lookup, `optionsFrom`, `firstChoice`, the sense-match call and `choiceFromModel`, exactly as `lookUpItem` does today.

- [ ] **Step 1: Run** `npx jest src/services/photoImports` to record the green baseline.
- [ ] **Step 2: Extract** the block from `const response = await lookup(...)` to `result` into `lookUpRow`; `lookUpItem` calls it with `onUnreadable: () => new SenseMatchUnreadable(importId, position)`.
- [ ] **Step 3: Run** the same tests. Expected: PASS unchanged.
- [ ] **Step 4: Commit** `refactor(server): phase 69 a photo row's lookup is one shared function`.

### Task 4: The discovery service: profile, runs, rounds, answers

**Files:**
- Create: `apps/server/src/services/discovery.ts`, `apps/server/src/services/discovery.test.ts`
- Modify: `apps/server/src/domain/access.ts` (`'discovery.manage'`), `apps/server/src/services/llm.ts` (`ModelCallKind` + `'discovery'`), `apps/server/src/errors.ts` (`DiscoveryNotFound(id, position?)` 404, `DiscoveryConflict(id, reason)` 409, `InvalidDiscoveryItem(id, position, reason)` 400)

**Interfaces — Produces** `createDiscoveryService({ transaction, discover, judge, llm, lookup, now, logger, stockSaveDelaySeconds })`, type `DiscoveryService`:
- `state(actor, enrollmentId): Promise<DiscoveryState>`
- `createProfile(actor, enrollmentId, input: DiscoveryProfileCreate): Promise<DiscoveryProfile>` (409 when one exists)
- `start(actor, enrollmentId, goal): Promise<{ run: DiscoveryRun; created: boolean }>` (409 without a profile; the open run when one exists)
- `getRun(actor, runId): Promise<DiscoveryRun>`
- `nextRound(actor, runId): Promise<DiscoveryRun>`
- `answer(actor, runId, position, request: DiscoveryAnswerRequest): Promise<DiscoveryAnswerResult>`
- `end(actor, runId): Promise<DiscoveryRun>`
- internal `toRun(run: RunRow, cards: CardRow[]): DiscoveryRun`, `settle(repos, run, cards)` (writes `levelAfter` over the last unsettled round's answered cards and `settled_round`)

Every use case authorizes `discovery.manage` inside its transaction (`authorizeEnrollment`), a run through its enrollment.

- [ ] **Step 1: Write the failing tests** (fakes from `tests/support/fakes`, as `photoImports.jobs.test.ts`):
  - `createProfile` writes `level = firstLevel(self)`; a second → `DiscoveryConflict`.
  - `start` without a profile → `DiscoveryConflict`; with an open run → `created: false`, the same id.
  - `nextRound` on a run with an unanswered card answers the run as is, no model call; otherwise one `discover` call with `record.kind 'discovery'`, the exclude = answered words ∪ this run's words ∪ saved lemmas; writes 10 cards at round + 1 with positions continuing; settles the previous round (level moved, `settled_round` set); when the write finds a card written meanwhile it writes nothing and answers the run as is (Review Focus 1); at round 8 or a parse with no word the run goes to `listing` (settled) instead; an unreadable answer → `LlmUnavailable`.
  - `answer` `unknown` → `known: false`, `lookup_status 'pending'`, one `look-up-discovered-word` job; typed in Latin script → `WrongScript`, nothing written; typed matching `hebrew` or an alternative → known, `judged_by 'rule'`, no judge call; otherwise the judge (`JUDGE_MARKER`, `example: null`): `right` known, `other_sense` known, `wrong` unknown with a job; a judge that throws → unknown, `judged_by 'unavailable'`; a second answer of the same card → the first verdict, no job (Review Focus 2); the answer that reaches the goal moves the run to `listing` and settles the round, including on the round's last card (Review Focus 3); a run not `asking` → `DiscoveryConflict`.
  - `end` moves `asking` → `listing` and settles; on `listing` answers it as is.

- [ ] **Step 2: Run** `npx jest src/services/discovery.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `nextRound`: read (run, cards, profile, user's age, enrollment, exclude) in one transaction; `buildDiscoveryPrompt` → `discover` → `parseDiscovery` outside it; then one transaction: lock the run, recheck `asking`, recheck the card count unchanged, settle, insert, log `discovery_round`. `answer`: read and check in one transaction; `wrongScript`, `meaningRuleVerdict`, the judge outside; write in one transaction (lock, `answerCard`, enqueue, count unknown, maybe `transition` + settle), log `discovery_answered`. The judge's context: `{ language: target, explanation: source, form: word, lemma: word, partOfSpeech, meaning: hebrew, example: null, exampleTranslation: null, alternatives }`.

- [ ] **Step 4: Run** the tests, `npx tsc --noEmit -p apps/server`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(server): phase 69 discovery profile, rounds and answers`.

### Task 5: The list, its lookups, save and discard; jobs and wiring

**Files:**
- Modify: `apps/server/src/services/discovery.ts`, `apps/server/src/services/discovery.test.ts`, `apps/server/src/domain/jobs.ts` (`LOOK_UP_DISCOVERED_WORD = 'look-up-discovered-word'`, `_FAILED`, expiry 180, payload `{ run_id: uuid, position: int }`), `apps/server/src/db/jobs.ts` (queue options copied from `LOOK_UP_IMPORT_ITEM`), `apps/server/src/worker.ts`, `apps/server/src/composition.ts` (`discover` client: `thinkingBudget` from Task 7, default 0 until measured, `timeoutMs: io.discoveryTimeoutMs`; `discovery` service and `AppDeps.discovery`), `apps/server/src/config.ts` + `apps/server/src/index.ts` + `apps/server/tests/support/serverDeps.ts` (`discoveryTimeoutMs`, env `DISCOVERY_TIMEOUT_MS`, default 20 000)

**Interfaces — Produces:** `updateItem(actor, runId, position, update: PhotoImportItemUpdate): Promise<PhotoImportItem>`, `save(actor, runId): Promise<SaveVocabularyResponse>`, `discard(actor, runId): Promise<void>`, `lookUpWord(data: unknown): Promise<void>`, `failWord(data: unknown): Promise<void>`. The run's `items` are its unknown cards as `PhotoImportItem` (`text: word`, `hebrew`, `status: lookup_status`).

- [ ] **Step 1: Write the failing tests:** `updateItem` follows `refuseItemUpdate` (`not_ready` → 409, else 400) and only on `listing`; `save` refuses a pending row (409), saves the ticked rows through `saveEntriesInTx` and marks the run saved in one transaction, a second save answers the same ids; `discard` from `asking` or `listing`, idempotent, a saved run → 409; `lookUpWord` calls `lookUpRow` and writes, and on a discarded or saved run or a non-pending card makes no lookup and writes nothing (Review Focus 4); `failWord` marks the row failed.
- [ ] **Step 2: Run** `npx jest src/services/discovery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, then the job declarations, the worker registration (`localConcurrency` as the photo row's), the composition and config.
- [ ] **Step 4: Run** the tests, `npx tsc --noEmit -p apps/server`, `npm run lint:arch`, `npx jest` in `apps/server` (unit). Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): phase 69 discovery list, lookups, save and discard`.

### Task 6: Routes

**Files:**
- Create: `apps/server/src/routes/discovery.ts`, `apps/server/tests/integration/routes/discovery.test.ts`
- Modify: `apps/server/src/app.ts` (`app.route('/api', createDiscoveryRouter(deps.discovery))`), `apps/server/tests/integration/auth/matrix.test.ts` (a run seeded for the owner in `ids.discoveryRun`; a STRANGER fixture for each of the ten operations; `discovery_profiles`, `discovery_runs`, `discovery_cards` in `written()`)

The ten operations of spec D10, in the shape of `routes/photoImports.ts`. Status mapping: `AccessDenied` 403, `EnrollmentNotFound`/`DiscoveryNotFound` 404, `DiscoveryConflict` 409, `InvalidDiscoveryItem`/`InvalidVocabularyEntry` 400, `WrongScript` 422 (as `routes/sessions.ts`), `LlmUnavailable` 503 `{ error: 'words unavailable' }`. `POST …/runs` answers 201 when created, 200 when resumed; `POST …/profile` 201.

- [ ] **Step 1: Write the failing route test:** a whole run over HTTP with MockServer answering the discovery call (two rounds; the second round's prompt carries the first round's words in `exclude`) and the judge; a learner's typed right answer → `known: true`; reaching the goal → `listing`; the job run by hand (`tests/support/jobs.ts`) fills the rows; untick one; save; `GET /enrollments/{id}/vocabulary` holds exactly the ticked lemmas; `GET …/discovery` then shows the profile's moved level and no run.
- [ ] **Step 2: Run** `npx jest --selectProjects=integration --runTestsByPath tests/integration/routes/discovery.test.ts tests/integration/auth/matrix.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the router and the mount.
- [ ] **Step 4: Run** the two tests, then `npm run test:integration` if a lane allows, else push the branch for CI (memory: lanes-full-no-cleanup). Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): phase 69 discovery routes`.

### Task 7: The eval group and the thinking budget

**Files:**
- Modify: `apps/server/tests/eval/cases.ts` (`DiscoveryCase { label; input: Parameters<typeof buildDiscoveryPrompt>[0] }`, `DISCOVERY_CASES`), `apps/server/tests/eval/askModel.ts` (`askDiscovery`), `apps/server/tests/eval/run.ts` (a client with production's budget, the filter, `scoreDiscovery`, a `groups` entry)

Cases, labels starting `discover `: it A1 lower adult 34 self; it B1 upper adult 40 course with 60 common Italian words excluded; en A2 child 10 school; en B2 adult family; ru A1 upper teen 15 school. Tier 1: the call succeeds and `parseDiscovery` keeps at least 10. Tier 2, per case: no kept word's key in `exclude` (also checked on the raw answer: at most 1 of 14 excluded), no duplicate, every word in the target's script (Latin for it/en, Cyrillic for ru), every `hebrew` in Hebrew script.

- [ ] **Step 1: Add** the cases and scorer.
- [ ] **Step 2: Measure** with `DISCOVERY_THINKING` 0 and 512: `npx tsx tests/eval/run.ts "discover "` from `apps/server`, twice each; record each call's ms from the report. Pick the smaller budget whose tier 2 passes both runs; set it in `domain/discovery.ts` (`DISCOVERY_THINKING`) and composition.
- [ ] **Step 3: Run** the group twice more with the chosen budget. Expected: tier 1 0 failures, tier 2 ≥ 0.85, both runs. Then `rm tests/eval/.results/*.json` (memory: eval-results-trip-lane-check).
- [ ] **Step 4: Commit** `test(eval): phase 69 the discover group, thinking budget measured`.

### Task 8: The app's client, copy and step rules

**Files:**
- Modify: `apps/mobile/src/api/client.ts` (`discoveryState`, `createDiscoveryProfile`, `startDiscovery`, `getDiscoveryRun`, `nextDiscoveryRound`, `answerDiscoveryCard`, `endDiscovery`, `updateDiscoveryItem`, `saveDiscovery`, `discardDiscovery`), `apps/mobile/src/strings.ts`
- Create: `apps/mobile/src/discovery.ts`, `apps/mobile/src/discovery.test.ts`

**Interfaces — Produces** (`discovery.ts`): `type DiscoverStep = 'loading' | 'questions' | 'goal' | 'fetching' | 'card' | 'list'`; `stepOf(state: DiscoveryState): DiscoverStep` (no profile → questions; no run → goal; `asking` with cards → card; `asking` without → fetching; `listing` → list); `GOAL_CHOICES`, `DEFAULT_GOAL`; `verdictLine(result: DiscoveryAnswerResult): { tone: 'right' | 'wrong'; text: string }`; `itemsWaiting(run: DiscoveryRun): boolean` (a `pending` item); `tickedCount(run): number`.

Copy (spec D2, D5, D6, D8): `discoverEntry 'מילים חדשות בשבילי'`, `discoverTitle 'מילים חדשות'`, `discoverLevelQuestion(language) 'כמה {language} אתם כבר יודעים?'` with the five answers, `discoverContextQuestion(language) 'איפה אתם לומדים {language}?'` with the four, `discoverGoalQuestion 'כמה מילים חדשות?'`, `discoverStart 'התחלה'`, `discoverDontKnow 'אין לי מושג'`, `discoverPlaceholder 'מה זה בעברית?'`, check `'בדיקה'` (existing term), `discoverRight '✓ נכון'`, `discoverWrong(hebrew) 'לא בדיוק — {hebrew}'`, `discoverNext 'הבא'`, `discoverFound(n, goal) 'נמצאו {n} מתוך {goal} מילים'`, `discoverFetching 'מחפשים מילים בשבילכם…'`, `discoverToList 'לרשימה'`, `discoverListTitle`, `discoverListHint 'הורידו את הסימון ממילים שלא תרצו להוסיף'`, `discoverSave(n) 'הוספת {n} מילים'`, `discoverDiscard 'ביטול'` with a confirm, `discoverWriteHebrew 'כתבו בעברית'` (the 422), `discoverFailed` (+ `tryAgain`). Numbers through `isolateLtr`.

- [ ] **Step 1: Write the failing tests** for `stepOf` (all five cases, Review Focus 5), `verdictLine`, `itemsWaiting`, `tickedCount`.
- [ ] **Step 2: Run** `npx jest src/discovery.test.ts` in `apps/mobile`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, the client methods, the copy.
- [ ] **Step 4: Run** the tests and `npx tsc --noEmit -p apps/mobile`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): phase 69 discovery client, copy and steps`.

### Task 9: The screen and its entry

**Files:**
- Create: `apps/mobile/src/app/discover.tsx`, `apps/mobile/src/components/DiscoverCard.tsx`, `apps/mobile/src/components/DiscoverList.tsx`
- Modify: `apps/mobile/src/app/(tabs)/words.tsx` (the pale entry button under the title and in the empty state, testID `discover-entry`)

testIDs: `discover-option-{value}` (questions and goal chips), `discover-start`, `discover-word`, `discover-dont-know`, `discover-input`, `discover-check`, `discover-verdict`, `discover-next`, `discover-found`, `discover-to-list`, `discover-fetching`, `discover-save`, `discover-discard`, `discover-close`. The card step copies `session.tsx`'s frame: the word in a `ScrollView`, the input bar and the two buttons below it, all in a `KeyboardAvoidingView behavior="padding"`, no autofocus (memory: android-keyboard-edge-to-edge). The list renders `PhotoImportRow` per item, polls `getDiscoveryRun` every `IMPORT_POLL_INTERVAL_MS` while `itemsWaiting` and the screen is focused, sends ticks optimistically as `ImportsReview` does, and disables save while waiting or with nothing ticked. Save → `router.dismissTo({ pathname: '/', params: { photoSaved: n } })`. Look: phase 64's tokens (`theme.ts`, `cardButton`, `Group`, `ScreenHeader`).

- [ ] **Step 1: Build** the screen and entry.
- [ ] **Step 2: Run** `npx tsc --noEmit -p apps/mobile` and `npx jest` in `apps/mobile`. Expected: PASS.
- [ ] **Step 3: Commit** `feat(mobile): phase 69 words for me screen and its entry in מילים`.

### Task 10: e2e

**Files:**
- Create: `e2e/tests/discover.spec.ts`

Stubs (`expectGeminiMatching`): `propose new words for a learner` → one round of seven Italian words in no other spec and not in the seed, in order `cuscino, lampada, ombrello, forchetta, scarpa, zaino, cassetto`, each with its `hebrew`; `judge the learner's answer` → `{ verdict: 'wrong' }` (only `lampada` reaches it: `cuscino`'s answer matches by rule); a `lookupOf` per unknown word; `which numbered sense` → `{ sense: 0 }`.

Test `a learner finds five new words and keeps four`: sign up (`it`), מילים, `discover-entry`, the two questions, goal 5, התחלה; `cuscino` typed `כרית` → `discover-verdict` "✓ נכון", הבא; `lampada` typed `שולחן` → "לא בדיוק — מנורה", הבא; "אין לי מושג" on `ombrello`, `forchetta`, `scarpa`, `zaino` → the fifth unknown opens the list (`cassetto` is never shown); five rows; untick `zaino`; `discover-save`; the vocabulary API holds exactly `forchetta, lampada, ombrello, scarpa`; home shows `home-photo-saved`.

- [ ] **Step 1: Write** the spec.
- [ ] **Step 2: Run** `npm run e2e -- tests/discover` (memory: e2e-filter-worktree-path). Expected: PASS. Then `rm -rf e2e/test-results`.
- [ ] **Step 3: Commit** `test(e2e): phase 69 a learner finds new words and keeps some`.

### Task 11: Whole-branch check

- [ ] **Step 1:** `git fetch` and merge `origin/master` if it moved (memory: master-moves-mid-build; renumber the migration if 0048 is taken).
- [ ] **Step 2:** `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e`. Expected: all pass.
- [ ] **Step 3:** A fresh whole-branch review (`superpowers:requesting-code-review`), its findings fixed or ruled on in the spec's rulings.
- [ ] **Step 4:** `git-create-pr`, then `ci-green`.
