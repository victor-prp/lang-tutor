# Phase 74 — Words for me with choices: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (Victor: "go till PR", inline).
> Steps use checkbox (`- [ ]`) syntax.

**Goal:**
- Words for me cards become five-row multiple choice with a suggested add / don't add.
- Words join My words as their lookups land.
- A session is stocked after the 2nd word.
- The app sends a learner here when there are no words, or no new ones.

**Architecture:**
- **Server:** the phase 69 discovery modules change in place (domain, service, routes, repo,
  migration 0052). The stock gets one new trigger, and the current read and the new-word limits
  each gain one field.
- **App:** the Words for me screen keeps its step machine, with a new card, two sheets and an end
  screen in place of the typed card and the list.

**Tech stack:** Hono and OpenAPI with zod, Drizzle and Postgres, pg-boss, Expo Router, React
Native, Jest and Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-lang-tutor-phase-74-words-for-me-choices-design.md`
(D1–D12).

## Global Constraints

- **Copy:** all copy is Hebrew, in `apps/mobile/src/strings.ts`. The exact lines are in spec D2,
  D8, D9 and D10.
- **API level:** `API_LEVEL` is 7, with a note in `packages/core/src/apiLevel.ts`.
- **Every Gemini schema field is required** (no optional strings).
- **The model is called between transactions,** never inside one (ADR 0001 R8).
- **Jobs** are enqueued only through `repos.jobs` (ADR 0007 R2).
- **No port or database literal** (ADR 0006). Remove `tests/eval/.results/*.json` and
  `e2e/test-results` after reading them, or the Stop hook trips.

## Review Focus

1. **A double tap on a choice or on add.** The first answer stands, the card isn't answered
   twice, and no second lookup starts (service test: a second answer is a replay, and one job is
   enqueued).
2. **Two lookups landing at once at the 2nd save.** Exactly one immediate stock request (the job
   holds the run's row; service test with two saves).
3. **A run that ends with every added lookup still pending.** The saves after the end still
   happen and ask for the stock (service test: a job for an ended run saves and stocks).
4. **A model round whose wrong meanings repeat the right one** (with niqqud, or a different
   spacing). The word is dropped or the option filtered (domain test with `normaliseHebrew`
   cases).
5. **The end screen opened with no word saved and nothing pending.** It shows "לא נוספו מילים"
   and never polls forever (app unit test of `endStep`).

---

### Task 1: Wire contract, migration, repo

**Files:**
- `packages/core/src/api/schemas.ts`, `packages/core/src/apiLevel.ts`
- `apps/server/src/db/schema.ts`, `apps/server/src/db/migrations/0052_discovery_choices.sql` (from
  `npm run db:generate -w apps/server`, then the data UPDATE appended by hand)
- `apps/server/src/repo/discovery.ts`, `apps/server/src/repo/users.ts` (discover_count)
- Tests: `apps/server/tests/integration/repo/discovery.test.ts`

**Interfaces (Produces):**
- **The run on the wire:** `DiscoveryRunSchema` is `{ id, goal, status, started_by:
  'learner'|'app', added_count, round, cards: [{position, word, choices: string[], right}], added:
  [{position, word, meaning, status: 'pending'|'saved'|'failed'}] }`.
- **The run's requests:** `DiscoveryRunCreateSchema` is `{ goal: int 1–30 | null }`, and
  `DiscoveryAnswerRequestSchema` is `{ pick: int 0–3 | null, add: boolean }`.
  `DiscoveryAnswerResultSchema` is dropped; the answer returns `DiscoveryRun`.
- **Other wire changes:** `LlmDiscoverySchema` items gain `wrong: string[]`.
  `NewWordLimitsSchema` gains `discover_count: int 1–30`, and `CurrentSessionResponseSchema` gains
  `needs_new_words: boolean`.
- **The repo's card row:** `CardRow` gains `choices: string[]`, `rightChoice`, `picked` and
  `suggested` (each `'add'|'skip'|null`), `added: boolean|null` and `savedAt: Date|null`.
  `CardAnswer` is `'unknown'|'typed'|'choice'`, and `NewCard` gains `choices` and `rightChoice`.
- **The repo's run row and writes:** `RunRow` gains `startedBy`. `insertRun({ enrollmentId,
  goal, startedBy })`. `answerCard` writes `{ answer, picked, suggested, added, known,
  lookupStatus, answeredAt }`. `markSaved(runId, position): Promise<boolean>`.
  `appRunStartedSince(enrollmentId, since: Date): Promise<Date[]>` returns the creation times of
  app-started runs, for the learner-day check.
- **Users:** `users.findNewWordLimits` and `setNewWordLimits` carry `discoverCount: number|null`.

- [ ] **Step 1:** Change the schemas, raise `API_LEVEL` to 7, and add the columns and checks of
  spec D11 to `schema.ts`.
- [ ] **Step 2:** Run `npm run db:generate -w apps/server`, rename the migration to
  `0052_discovery_choices`, and append the open-run UPDATE: `update discovery_runs set status =
  'discarded', ended_at = now() where status in ('asking','listing');`. Fix the journal tag to
  match.
- [ ] **Step 3:** Update the repo primitives. In the repo integration test, an inserted card keeps
  `choices` and `rightChoice`; an `answerCard` writes `added`; `markSaved` stamps `saved_at` once.
- [ ] **Step 4:** Run `npm run typecheck`. Expect the type errors that tasks 2–6 resolve; the
  schema compiles.

### Task 2: Domain, the prompt and the choices

**Files:** `apps/server/src/domain/discovery.ts`, `apps/server/src/domain/discovery.test.ts`

**Interfaces (Produces):**
- `ProposedWord` gains `wrong: string[]` (exactly 3).
- `parseDiscovery(raw, exclude)` returns `{ words, dropped, droppedForWrong }`.
- `choicesOf(hebrew: string, wrong: readonly string[], rng: () => number): { choices: string[];
  right: number }`.
- `PHRASES_FROM_LEVEL = 7`.

- [ ] **Step 1: Failing tests.**
  - The prompt at level 7 contains "about 4 of the 14 items are multi-word"; at level 6 it does
    not.
  - Every prompt asks for "wrong" meanings and has the useful-words rule.
  - `parseDiscovery` drops a word whose wrong meanings include `hebrew` with niqqud
    (`חַלּוֹן`/`חלון`). It drops one with only 2 Hebrew wrongs (one is Latin), and dedupes the
    wrongs. It keeps 3 of 4 valid wrongs and counts `droppedForWrong`.
  - `choicesOf` returns 4 entries, `choices[right] === hebrew`, with the order from `rng`
    (`() => 0` versus `() => 0.99` differ).
- [ ] **Step 2:** Run `npx jest src/domain/discovery.test.ts` in `apps/server`; expect FAIL.
- [ ] **Step 3:** Implement. The wrong meaning check uses `normaliseHebrew` (export it from
  `domain/judge.ts` if it is not already exported). The shuffle is Fisher–Yates over the four
  meanings.
- [ ] **Step 4:** Run the same test; expect PASS. Commit "feat(server): Words for me rounds bring
  three wrong meanings, phrases from B2, useful words (phase 74 D4)".

### Task 3: Service, routes, job, stock

**Files:**
- `apps/server/src/services/discovery.ts`, `apps/server/src/routes/discovery.ts`,
  `apps/server/src/composition.ts`
- `apps/server/src/services/vocabulary.ts` (`stockSaveDelaySeconds: number | null`),
  `apps/server/src/domain/jobs.ts` (`STOCK_REASONS` gains `'discovery'`),
  `apps/server/src/errors.ts` (drop what only the list used)
- Tests: `apps/server/src/services/discovery.test.ts`,
  `apps/server/tests/integration/routes/discovery.test.ts`,
  `apps/server/tests/integration/auth/matrix.test.ts`, `apps/server/tests/support/discoveryRows.ts`

**Interfaces (Produces):**
- `createDiscoveryService({ transaction, discover, llm, lookup, now, rng, logger })`, with `judge`
  and `stockSaveDelaySeconds` removed.
- Methods:
  - `state`, `createProfile`;
  - `start(actor, enrollmentId, goal: number | null)` → `{ run, created }`;
  - `getRun`, `nextRound`;
  - `answer(actor, runId, position, { pick, add })` → `DiscoveryRun`;
  - `end(actor, runId)` → `DiscoveryRun`;
  - `lookUpWord(data)`, `failWord(data)`.
- **Removed:** `updateItem`, `save`, `discard` and their routes.

- [ ] **Step 1: Failing service tests** (fakes, as today's file):
  - **start:** `start` with `null` uses the user's `discoverCount ?? 10` and `startedBy 'app'`;
    with 15, `'learner'`.
  - **answer:**
    - a right pick with add false gives `known` true, suggested `'skip'` and no job;
    - a wrong pick with add gives `known` false, suggested `'add'` and one lookup job;
    - `pick: null` with add enqueues;
    - pick 4 gives `InvalidDiscoveryAnswer` (a 400);
    - a second answer replays, with no write and no job;
    - the answer reaching `goal` added ends the run (`saved`), logging `discovery_ended` with
      reason `goal` and asking for an immediate stock only if a word is saved.
  - **the job:**
    - an added card with a gloss is saved (`saveEntriesInTx` called with
      `stockSaveDelaySeconds: null`) and stamped;
    - the run's 2nd saved word enqueues `stock-session` with reason `discovery`, and the 1st does
      not;
    - a save after the run ended enqueues it;
    - a lookup with no gloss is not saved;
    - a discarded run takes no write.
  - **end:** it ends an asking run, and asks for a stock when one word is saved.
- [ ] **Step 2:** Run `npx jest src/services/discovery.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.**
  - `toRun` maps the spec D11 shape. An `added` row's meaning is the saved gloss's translation
    from `options` when saved, else `choices[rightChoice]`, and its word is `correctedForm ??
    word`.
  - `nextRound` writes `choicesOf(...)` per word with `rng`.
  - The job's write transaction locks the run (`findRunForUpdate`), then writes the lookup.
    - If the card is added and its entries are not empty, it calls `saveEntriesInTx` and
      `markSaved`, then counts the saved cards; at 2, or with `status === 'saved'`, it calls
      `requestStock(repos, { enrollment_id, reason: 'discovery' })`.
    - It logs `discovered_word_saved` with `hebrew_mismatch`.
- [ ] **Step 4: Routes.**
  - The answer body is the new schema.
  - The runs POST takes `goal` as `number | null`.
  - The items PATCH, save and discard routes are deleted, and so are their auth matrix rows.
- [ ] **Step 5: Integration test.** Profile, then a run with goal null, a round from MockServer
  (the existing fixture gains `wrong`), and answers. It checks the 400 on a bad pick and `end`.
- [ ] **Step 6:** Run `npx jest src/services/discovery.test.ts` and
  `npx jest --selectProjects=integration --runTestsByPath tests/integration/routes/discovery.test.ts tests/integration/repo/discovery.test.ts tests/integration/auth/matrix.test.ts`;
  expect PASS. Commit "feat(server): choice answers, add per card, saves as lookups land, a stock at
  the 2nd word (phase 74 D2, D3, D5, D6)".

### Task 4: `needs_new_words` and `discover_count`

**Files:**
- `apps/server/src/services/sessions.ts` (the current read near line 1042),
  `apps/server/src/repo/vocabulary.ts` or `repo/memory.ts` (a count primitive)
- `apps/server/src/services/users.ts` and its route (new-word limits)
- Tests: the current read's integration test file (find it with
  `grep -rln "due_count" apps/server/tests/integration`), and the new-word limits' route test

**Interfaces (Produces):**
- On the main path, `current` answers `needs_new_words = saved > 0 && unmet === 0 &&
  !appRunToday`. `unmet` counts the main path's saved glosses (less those a target holds) with no
  memory row and not introduced today; `appRunToday` takes the learner day of each
  `appRunStartedSince(enrollmentId, now − 48 h)` time through `learnerDays`, equal to today. On a
  target's path the field is false.
- The PUT of new-word limits stores `discover_count`, and the GET returns it, 10 when null.

- [ ] **Step 1: Failing integration tests.**
  - `needs_new_words` is false with an unmet word, true after every word has a memory row, and
    false again once an app-started run was created today.
  - A word only a target holds is ignored.
  - `discover_count` round-trips, and the default is 10.
- [ ] **Step 2:** Implement; the tests pass. Commit "feat(server): the current read says when My
  words needs new words; the learner's Words for me count (phase 74 D7, D10)".

### Task 5: Eval

**Files:** `apps/server/tests/eval/cases.ts`, `apps/server/tests/eval/run.ts`

- [ ] **Step 1:** Add the case `discover it C1 lower, an adult on their own` (level 9). In
  `scoreDiscovery`, tier 2 gains three checks:
  - "at most 2 words dropped for their wrong meanings", from `droppedForWrong`;
  - "every wrong meaning in Hebrew";
  - at level ≥ 7, "at least 2 phrases kept" (a kept word with a space).
- [ ] **Step 2:** Run `npx tsx tests/eval/run.ts "discover "` twice in `apps/server`, with the
  lane's `GEMINI_*`. Every row passes both times. Read the report, then `rm
  tests/eval/.results/*.json`. If a row fails, fix the prompt (not the check) and rerun twice.
  Commit "test(eval): Words for me wrong meanings and phrases (phase 74 D4)".

### Task 6: App

**Files:**
- `apps/mobile/src/discovery.ts` (+test), `apps/mobile/src/components/DiscoverCard.tsx`
  (rewrite), `apps/mobile/src/components/DiscoverSheet.tsx` (new: the two bottom sheets),
  `apps/mobile/src/components/DiscoverEnd.tsx` (new)
- `apps/mobile/src/app/discover.tsx`, `apps/mobile/src/api/client.ts`,
  `apps/mobile/src/nextSession.ts` (+test), `apps/mobile/src/app/new-words.tsx`,
  `apps/mobile/src/newWordLimits.ts` (+test), `apps/mobile/src/strings.ts`
- Delete: `DiscoverList.tsx`, `discoverAfterSave.ts` (+test)

**Interfaces (Produces, `discovery.ts`):**
- `stepOf(state, fromApp: boolean): 'questions'|'goal'|'starting'|'fetching'|'card'|'end'`. With
  no run, `'goal'` when learner-started and `'starting'` when app-started (the screen then starts
  with `goal: null`). A run whose status is `saved` is `'end'`.
- `suggestionOf(pick: number | null, right: number): 'add'|'skip'`.
- `sheetCaseOf(suggested, chosen): 'knew'|'new'|null`: `knew` when skip is suggested and add was
  chosen, `new` for the reverse.
- `closeStep(addedCount: number, step): 'end'|'warn'|'leave'`: `'end'` when the step is card and
  the count is at least 2; `'warn'` when the step is card and the count is below 2; `'leave'`
  otherwise.
- `warnEscape(fromApp: boolean, savedCount: number): 'practise'|'leave'`.
- `endStep(run, current: CurrentSession | null, created: boolean):
  'start'|'wait'|'create'|'empty'|'failed'`.
- `GOAL_CHOICES = [5,10,15,20,30]` and `DEFAULT_GOAL = 15`; `DISCOVER_COUNT_OPTIONS = [5,10,15,20,30]`.

`nextSession.ts`: `homeActionOf(state, { forReminder = false })`. Its second rule is `!forReminder
&& state.needs_new_words`, which gives `discover`. `reminderStartOf`'s caller passes
`forReminder: true`.

- [ ] **Step 1: Failing unit tests** for each function above, with the spec's cases. Two of them:
  - `endStep` with a run of 0 saved, 0 pending and no session gives `'empty'`;
  - `homeActionOf` with `needs_new_words` and a ready session gives `discover`, `resume` stays
    `resume`, and the reminder flavour gives `start`.
- [ ] **Step 2:** Run `npx jest src/discovery.test.ts src/nextSession.test.ts` in `apps/mobile`;
  expect FAIL. Implement; expect PASS.
- [ ] **Step 3: UI.**
  - **The card:** `DiscoverCard` shows the word card and five `OptionButton` rows (`right` gives
    correct, the wrong pick gives wrong, a picked "אין לי מושג" gives selected, the rest dimmed),
    then the add row. Its testIDs: `discover-word`, `discover-choice-{i}`, `discover-dont-know`,
    `discover-add` and `discover-skip` (each with `-suggested` in its `accessibilityHint`), and
    `discover-found`.
  - **The sheets:** `DiscoverSheet` is a `Modal` bottom sheet, as `NewWordCapSheet`, for the
    `knew` and `new` cases and for the ✕ warning. Its testIDs are `discover-sheet-add`,
    `discover-sheet-skip`, `discover-warn-continue` and `discover-warn-leave`.
  - **The end screen:** `DiscoverEnd` has the testIDs `discover-end-count`, `discover-end-word`,
    `discover-end-start` and `discover-end-home`.
  - **The screen:** `discover.tsx` wires these with polling of the run and the session every
    `POLL_INTERVAL_MS` while `endStep` is `'wait'`. ✕ follows `closeStep` and `warnEscape`.
  - **Settings:** `new-words.tsx` gains the D10 chips (`settings-discover-count-{n}`).
- [ ] **Step 4:** Run `npx tsc --noEmit` and `npx jest` in `apps/mobile`; expect PASS. Commit
  "feat(mobile): Words for me choice cards, add sheets, ✕ warning, end screen; the count setting
  (phase 74 D1, D2, D7–D10)".

### Task 7: E2E

**Files:** `e2e/tests/discover.spec.ts`, plus the MockServer fixture for the round (it gains
`wrong`)

- [ ] **Step 1:** Rewrite the spec's flow:
  1. home with no words, then Words for me;
  2. the two questions;
  3. straight to cards with no chips (app-started);
  4. pick wrong, then the suggested add;
  5. pick right, then add, the `knew` sheet, then add;
  6. ✕, which with ≥ 2 added shows the end screen with 2 words;
  7. להתחיל תרגול once the session is ready, which reaches `/session`.

  A second test: from the מילים tab the chips show.
- [ ] **Step 2:** Run `npm run e2e -- tests/discover.spec.ts`; expect PASS, then `rm -rf
  e2e/test-results`. Commit "test(e2e): Words for me with choices (phase 74)".

### Task 8: Whole branch

- [ ] Run `npm run typecheck`, `npm test`, `npm run test:all` and `npm run lint:arch`; all pass.
- [ ] Final review, then `git-create-pr` and `ci-green`, as CLAUDE.md's *Finishing a branch* says.
