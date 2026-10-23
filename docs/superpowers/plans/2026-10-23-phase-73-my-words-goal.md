# Phase 73 — My words daily goal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-course daily session goal for My words, today's progress tiles, a day row that records
both, My words' results screen continuing straight into the next session, and a learner with no
words sent to Words for me and on into a first session.

**Architecture:** Server: a goal column on `enrollments`, a `my_words_days` table upserted by the
session-completion transaction and the goal PUT, a `today` block on the main path's current read, an
optional `kind` on the session read, and the seed rule narrowed. App: pure line/dots/tiles rules, one
`MyWordsToday` component drawn by the home card and by results, one My words press hook shared by
both, a settings screen, and Words for me ending in a session when opened from the card.

**Tech Stack:** Hono + zod-openapi, Drizzle/Postgres, Jest (unit + integration), Expo Router / React
Native, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-23-lang-tutor-phase-73-my-words-goal-design.md` — read it
first; every task argues from its decisions (D1–D9).

## Global Constraints

- Read `docs/adr/` before touching `apps/server` or `apps/mobile`; `npm run lint:arch` must stay
  clean (layers ADR 0001, closures ADR 0002, one wire contract ADR 0003, learner day ADR 0013, paths
  ADR 0014).
- No `API_LEVEL` change: every wire addition is optional.
- Goal: per enrollment; stored null = 3 (`DEFAULT_MY_WORDS_GOAL`), 0 = off, 1–20 (`MAX_MY_WORDS_GOAL`);
  a saved 3 is stored as null. Wire: `{ goal: number | null }`, null = off.
- Counted session: `target_id IS NULL`, `kind = 'practice'`, `source = 'list'`, `status = 'completed'`,
  `practice_day = day`.
- Copy, verbatim (Hebrew, RTL; numbers through `isolateLtr` as `strings.ts` does):
  - start: `היעד של היום: 3 תרגולים` (1: `היעד של היום: תרגול אחד`, reuse `targetSessionsGoal`), side
    `כ-15 דקות` (reuse `targetSessionsMinutes`)
  - in progress: `כל הכבוד! עוד 2 תרגולים להיום` (1 left: `כל הכבוד! עוד תרגול אחד להיום`)
  - met: `כל הכבוד! עשית 3 תרגולים היום` (1: `כל הכבוד! עשית תרגול אחד היום`)
  - tiles: `מילים חדשות היום` / `מילה חדשה היום`; `עלו רמה היום` / `עלתה רמה היום`
  - results block title: `המילים שלי · היום`; results button: `להמשיך לתרגל` (exists from phase 72)
  - settings row and screen: `יעד יומי`; screen title `יעד יומי · <language name>`; stepper value
    `3 תרגולים` / `תרגול אחד`
- Colours: line grey `#344054` before met, `colors.correct` bold when met; dots as `TargetCard.tsx`'s
  `DOT_STYLES` (done green, todo grey, extra = `bonus` blue); tiles: big number in `colors.primary`.
- Each task: its tests pass, `npm run lint:arch` passes, then commit (message style as `git log`,
  e.g. `feat(server): …`, ending with the `Co-Authored-By` line the repo uses).
- Integration tests: `npm run test:integration -- --selectProjects=integration --runTestsByPath <file>`
  from the repo root (see memory: `--selectProjects` eats a following path).

## Review Focus

1. A session started before local midnight and finished after counts on the day it ended
   (`practice_day`) — Task 2 integration test.
2. A goal lowered below the sessions done turns the card met at once; raised again, it shows
   "עוד N" — Task 3 integration (row rewritten) + Task 5 unit (line from numbers).
3. Two courses: each enrollment its own goal, its own row — Task 2 and Task 3 integration tests.
4. A word that rose in a target session and in a My words session the same day counts once; a word
   first answered in a target session (any day) is not "new" in My words — Task 1 unit, Task 2
   integration.
5. Results opened when the main path's next session is preparing or failed, and a press still in
   flight when the learner leaves: the button shows preparing/retry; a late press opens nothing —
   Task 7 unit (button state) + e2e in Task 10.

---

### Task 1: Schema, migration and the pure rules

**Files:**
- Modify: `apps/server/src/db/schema.ts` (enrollments: `myWordsGoal`; new `myWordsDays`)
- Create: `apps/server/src/db/migrations/0051_my_words_goal.sql` (+ `meta/` via `npm run db:generate -w apps/server`)
- Create: `apps/server/src/domain/myWordsGoal.ts`, `apps/server/src/domain/myWordsGoal.test.ts`
- Create: `apps/server/src/domain/myWordsDay.ts`, `apps/server/src/domain/myWordsDay.test.ts`

**Interfaces:**
- Produces: `DEFAULT_MY_WORDS_GOAL = 3`, `MAX_MY_WORDS_GOAL = 20`;
  `goalOf(stored: number | null): number | null` (null → 3, 0 → null, n → n);
  `storedGoal(goal: number | null): number | null` (null → 0, 3 → null, n → n);
  `goalMinutes(goal: number): number` = `Math.round(goal * SESSION_LENGTH * CARD_SECONDS / 60)`
  (`SESSION_LENGTH` from core `domain/quiz`, `CARD_SECONDS` from `domain/targetSummary`);
  `myWordsDayCounts(input: { counted: readonly string[]; firstAnswers: readonly { glossId: string; sessionId: string }[]; snapshots: readonly { sessionId: string; rows: readonly SnapshotRead[] }[] }): { sessionsDone: number; newWords: number; movedUp: number }`
  — sessionsDone = counted.length; newWords = distinct glossIds whose sessionId ∈ counted; movedUp =
  distinct glossIds with `levelAfter > levelBefore` in `progressChanges(rows, LIVE_DIMENSIONS)` of a
  snapshot whose sessionId ∈ counted.
- Table `my_words_days`: `enrollment_id text not null` (FK enrollments, cascade), `day date not null`,
  `goal smallint` (check 1–20 or null), `sessions_done smallint not null`, `new_words smallint not null`,
  `moved_up smallint not null`, `last_session_id uuid`, `updated_at timestamptz not null default now()`;
  PK `(enrollment_id, day)`. `enrollments.my_words_goal smallint` null, check `between 0 and 20`.
  Comments in schema.ts as the file does (phase, spec D-number, what null means).

- [ ] **Step 1: Write failing unit tests** — `myWordsGoal.test.ts`: `goalOf(null) === 3`, `goalOf(0) === null`,
  `goalOf(7) === 7`; `storedGoal(3) === null`, `storedGoal(null) === 0`, `storedGoal(20) === 20`;
  `goalMinutes(3) === 15`, `goalMinutes(1) === 5`. `myWordsDay.test.ts`: a word raised in two counted
  sessions → movedUp 1; a word raised only in a non-counted session id → 0; a skill rise that leaves
  the badge → 0; a first answer in a non-counted session → newWords 0; three counted ids → sessionsDone 3.
- [ ] **Step 2:** Run `npx jest src/domain/myWords -w apps/server` (or `npm test -w apps/server -- myWords`); expect FAIL (modules missing).
- [ ] **Step 3:** Implement both modules (pure: ADR 0001 R3, core imports only besides sibling domain files).
- [ ] **Step 4:** Add the schema, generate 0051, check the SQL holds both checks and the FK; run `npm run db:migrate` (the lane's own database) and the unit tests; expect PASS.
- [ ] **Step 5:** `npm run lint:arch`; commit `feat(server): the My words goal column, the day table and their rules (phase 73 D1-D3)`.

### Task 2: Record the day on a counted session's completion

**Files:**
- Create: `apps/server/src/repo/myWordsDays.ts`; wire it in `services/transaction.ts` (`Repos.myWordsDays`) and `composition.ts` as the other repos are
- Modify: `apps/server/src/repo/sessions.ts` (two reads), `apps/server/src/repo/enrollments.ts` (goal read/write)
- Modify: `apps/server/src/services/sessions.ts` (completion, after `recordProgress`)
- Create: `apps/server/src/services/myWordsDay.ts` (the shared write)
- Test: `apps/server/tests/integration/services/myWordsDay.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `session.findCountedMainSessions(enrollmentId: string, day: string): Promise<string[]>`
  - `session.findFirstAnswerSessions(enrollmentId: string, day: string): Promise<{ glossId: string; sessionId: string }[]>` — per saved gloss, the session of its first answer given while saved (over all sessions, every path), kept when that session's `practice_day = day`.
  - `enrollment.findMyWordsGoal(enrollmentId: string): Promise<number | null>` (stored value) and `enrollment.setMyWordsGoal(enrollmentId: string, stored: number | null): Promise<void>`
  - `myWordsDays.find(enrollmentId, day): Promise<MyWordsDayRow | undefined>`, `myWordsDays.upsert(row: MyWordsDayRow): Promise<void>` with `MyWordsDayRow = { enrollmentId; day; goal: number | null; sessionsDone; newWords; movedUp; lastSessionId: string | null }`
  - `recordMyWordsDay(repos: Repos, logger: Logger, input: { enrollmentId: string; day: string; sessionId: string | null; reason: 'session' | 'goal_changed' }): Promise<MyWordsDayRow>` — reads the three inputs (snapshots through `repos.progress.findSnapshot` per counted id), computes with `myWordsDayCounts`, upserts with `goal = goalOf(stored)`, logs `{ event: 'my_words_day_recorded', enrollment_id, day, goal, sessions_done, new_words, moved_up, session_id }` or `reason: 'goal_changed'`.
- Completion calls it only when the completed session is counted (main path, `kind` practice, `source` list), inside the same transaction, after `recordProgress`.

- [ ] **Step 1: Failing integration tests:** completing a counted session writes the row (goal 3, sessions 1, new/moved as answered); a second completion rewrites it (sessions 2, a word raised twice counted once); a target session's completion and a seed write no row; a session started 23:50 and completed 00:10 in the learner's zone lands on the new day; two enrollments of one learner get separate rows; a word first answered in a target session is not counted new by a later My words session; goal 0 stored → row `goal` null.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Implement repo reads (raw SQL in the style of `findIntroducedOn`, `onPath(null)`), the repo, the write, the completion call.
- [ ] **Step 4:** Run the file, then `npm test -w apps/server`; expect PASS. If the stock/session unit tests assert the call order of the completion transaction, add the new call to them, not around them.
- [ ] **Step 5:** lint:arch; commit `feat(server): a counted My words session records its day (phase 73 D2, D3)`.

### Task 3: The goal routes, today's read, the session kind

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (+ `types.ts`, `index.ts` exports): `MyWordsGoalSchema = z.object({ goal: z.number().int().min(1).max(20).nullable() })`; `CurrentSessionResponseSchema.today` optional `MyWordsTodaySchema = { goal: int|null, sessions_done, new_words, moved_up, minutes }`; `SessionViewSchema.kind` optional `z.enum(['practice', 'question_types'])` (match the stored values; check `sessions.kind`'s writer)
- Modify: `apps/server/src/domain/access.ts` (`'my_words_goal.manage'`, in no role)
- Create: `apps/server/src/services/myWordsGoal.ts` (`createMyWordsGoalService`) and `apps/server/src/routes/myWordsGoal.ts`; mount in `app.ts`, wire in `composition.ts`
- Modify: `apps/server/src/services/sessions.ts` (`currentSession` main path → `today`; session read → `kind`), `apps/server/src/routes/sessions.ts`
- Test: `tests/integration/routes/myWordsGoal.test.ts`, `tests/integration/auth/matrix.test.ts` (STRANGER fixtures for both routes), the sessions route test (`today`, `kind`)

**Interfaces:**
- Consumes: Task 2 (`recordMyWordsDay`, enrollment goal read/write, `myWordsDays.find`).
- Produces: `GET /api/enrollments/{id}/my-words-goal` → `{ goal }` (3 when never set, null when off); `PUT` same body → stored result; the PUT, in its transaction, calls `recordMyWordsDay(..., { reason: 'goal_changed', sessionId: null })` only when today's row exists (today = `learnerDay`). `today` on the main path's current read: row counts or zeros, `goal = goalOf(stored)`, `minutes = goal ? goalMinutes(goal) : 0`; absent on a target path. Client methods in `apps/mobile/src/api/client.ts`: `myWordsGoal(enrollmentId): Promise<MyWordsGoal>`, `putMyWordsGoal(enrollmentId, body): Promise<MyWordsGoal>`.

- [ ] **Step 1: Failing tests:** GET default 3; PUT 5 → 5 and stored 5; PUT 3 → stored null; PUT null → GET null; PUT 21 / 0 → 400; a stranger → 403 (matrix); PUT on a day with a row rewrites its goal and logs `goal_changed`; PUT on a day without a row writes none; current read `today` before and after a counted session; lowering the goal to 1 after 2 sessions → `today.goal 1, sessions_done 2`; `kind` on a practice session's read.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement (routes via `createRoute`, descriptions in the house style; `authorizeEnrollment` with the new permission).
- [ ] **Step 4:** Run the files, `npm test -w apps/server`, `npm run test -w packages/core` if it has tests; expect PASS. The openapi tests must still pass.
- [ ] **Step 5:** lint:arch; commit `feat(server): the My words goal on the wire, today's numbers on home's read (phase 73 D1, D4, D7)`.

### Task 4: The seed only for an enrollment with neither sessions nor words

**Files:**
- Modify: `apps/server/src/domain/session.ts` (`nextSource(hasAnySession: boolean, hasSavedWords: boolean): SessionSource` → `'seed'` only when both false), its callers in `services/sessions.ts` (create and `currentSession`; saved = the main path's saved count, `savedOn(repos, enrolled, null)`)
- Test: `apps/server/src/domain/session.test.ts`, the sessions service/route tests that assert a first create is the seed

**Interfaces:** Produces the new `nextSource` signature; `next_source` on the wire follows it.

- [ ] **Step 1: Failing tests:** `nextSource(false, false) === 'seed'`, `nextSource(false, true) === 'list'`, `nextSource(true, false) === 'list'`; a first create for an enrollment with saved words answers a list session; with none, the seed (unchanged).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement; fix tests that relied on "first create = seed" with saved words by expecting a list session (do not delete them).
- [ ] **Step 4:** `npm run test:all` (server unit, integration, bots, mobile). The day simulation (`day.test`) must report the same measures as master; if one moves, stop and report it rather than changing a mark.
- [ ] **Step 5:** commit `feat(server): the seed only for an enrollment with no session and no word (phase 73 D6)`.

### Task 5: The app's pure rules for today

**Files:**
- Create: `apps/mobile/src/myWordsToday.ts`, `apps/mobile/src/myWordsToday.test.ts`
- Modify: `apps/mobile/src/strings.ts` (the copy in Global Constraints), `apps/mobile/src/nextSession.ts` (`homeActionOf`: `start-seed` and `save-words-first` → `{ kind: 'discover' }`; `myWordsBand`: no seed branch — saved count)

**Interfaces:**
- Produces: `todayLine(today: MyWordsToday): { text: string; side: string | null; tone: 'plain' | 'done' } | null` (null when goal null); `todayDots(today): ('done' | 'todo' | 'bonus')[]` ([] when goal null; `min(done, goal)` done, `goal − done` todo, `done − goal` bonus); `todayTiles(today): { newWords: { count: number; label: string }; movedUp: { count: number; label: string } } | null` (null when both 0); `todaySpoken(today): string`; `myWordsButton(today: MyWordsToday | undefined, action: HomeAction | null): { label: string; filled: boolean }` (met → `לתרגל עוד`, pale; else today's `mainButtonSolid` + `לתרגל עכשיו`). `HomeAction` gains `{ kind: 'discover' }`.

- [ ] **Step 1: Failing unit tests** for every row of the spec's D5 table and the one/plural forms: goal 3 done 0 → start line + side `כ-15 דקות`, 3 todo dots, tiles null; done 1 → `כל הכבוד! עוד 2 תרגולים להיום`; done 2 → `…עוד תרגול אחד להיום`; done 3 → met, 3 done dots; done 4 → `עשית 4 תרגולים היום`, 3 done + 1 bonus; goal 1 done 1 → `עשית תרגול אחד היום`; goal null → line null, dots [], tiles shown when counts > 0; tiles labels singular at 1; new 0 moved 2 → tiles shown with 0; `homeActionOf` with `next_source: 'seed'` or no saved words → `discover`; `myWordsBand` with seed → saved count.
- [ ] **Step 2:** `npm test -w apps/mobile -- myWordsToday nextSession`; expect FAIL.
- [ ] **Step 3:** Implement; update existing `nextSession.test.ts` cases that expected `start-seed` / `save-words-first`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** commit `feat(mobile): today's line, dots and tiles for My words (phase 73 D5)`.

### Task 6: The home card and the shared press

**Files:**
- Create: `apps/mobile/src/components/MyWordsToday.tsx` (line + dots + tiles, `testID` prefix passed in, so home and results can scope)
- Create: `apps/mobile/src/hooks/usePracticeMyWords.tsx`
- Modify: `apps/mobile/src/components/MyWordsCard.tsx`, `apps/mobile/src/components/LearningSection.tsx`

**Interfaces:**
- Consumes: Task 5, `current.today` (Task 3 types).
- Produces: `<MyWordsToday today={…} testID="home-my-words-today" />` drawing nothing when line and tiles are both null; `usePracticeMyWords({ run, openSession, onDiscover }): { press: (action: HomeAction) => void; makeNext: () => Promise<void>; skip: (sessionId: string) => void; makeFailed: boolean }` — the start/resume/create/retry/skip logic moved out of `LearningSection` unchanged, plus `discover` → `onDiscover()` (home: `router.push({ pathname: '/discover', params: { from: 'my-words' } })`). The auto-create effect stays in home.
- The card: `MyWordsToday` above the button; the button's label/fill from `myWordsButton`; the `save-words-first` note goes; the all-in-targets note stays above the button when that is the reason.

- [ ] **Step 1: Failing tests:** component tests in the style the repo uses for cards (if none, unit-test what the card passes: the hook's press per action kind with fakes — `discover` calls `onDiscover`, `start` calls `openSession(id, true)`, `resume` `openSession(id, false)`, `create` sends create).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement; home's behaviour otherwise unchanged (its existing tests and e2e stay green).
- [ ] **Step 4:** `npm test -w apps/mobile`; typecheck (`npx tsc --noEmit -p apps/mobile`); expect PASS.
- [ ] **Step 5:** commit `feat(mobile): the My words card shows today and opens Words for me with no words (phase 73 D5, D6, D8)`.

### Task 7: My words' results screen

**Files:**
- Modify: `apps/mobile/src/hooks/useSession.tsx` (keep `source` and `kind` with the entered session, as `targetId` is), `apps/mobile/src/hooks/useNextSession.tsx` (`refresh(): Promise<boolean>`: the read, resolving whether it landed), `apps/mobile/src/app/results.tsx`
- Create (if the logic grows): `apps/mobile/src/resultsMyWords.ts` + test

**Interfaces:**
- Consumes: Tasks 5–6.
- Produces: for a counted session (`targetId` null, `source` 'list', `kind` 'practice' or absent), results calls `refresh()` on focus, then draws a block (`testID="results-my-words"`, title `המילים שלי · היום`, `<MyWordsToday testID="results-my-words-today" />`) when the read landed and there is something to draw; the primary button `results-continue`, label `להמשיך לתרגל`, always filled, pressing `usePracticeMyWords().press(homeActionOf(current))` with `openSession` replacing the screen (phase 72's `openSession`, `shown` guard); preparing → disabled preparing look + poll every `POLL_INTERVAL_MS` while focused; failed → note + retry. Seed and question-types sessions: today's screen (`results-next-session`).

- [ ] **Step 1: Failing unit tests** of the pure choice: which screen for (targetId, source, kind); the button state per action (start/resume → enabled, preparing → preparing, failed → retry, discover/none → go home).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement; keep the finished session's view held as phase 72 does.
- [ ] **Step 4:** `npm test -w apps/mobile`, typecheck; expect PASS.
- [ ] **Step 5:** commit `feat(mobile): My words' results show today and continue straight on (phase 73 D7)`.

### Task 8: The יעד יומי settings screen

**Files:**
- Create: `apps/mobile/src/app/my-words-goal.tsx`, `apps/mobile/src/myWordsGoal.ts` (+ test: `stepGoal(goal, +1|-1)` clamped 1–20, `goalLabel(n)`)
- Modify: `apps/mobile/src/app/(tabs)/settings.tsx` (row `settings-my-words-goal` next to `settings-new-words`), `strings.ts`

**Interfaces:** Consumes Task 3's client methods and the active enrollment (`useCurrentUser().active`). Screen: title `יעד יומי · ${strings.languageName(active.target_language)}`, a `Switch` (`my-words-goal-on`), when on the reminders screen's − / + stepper (`my-words-goal-less`, `my-words-goal-more`, value `my-words-goal-value`), saved through `createSaver` as `new-words.tsx` saves; turning on restores 3; load/failed states as `new-words.tsx`.

- [ ] **Step 1: Failing unit tests:** `stepGoal(20, +1) === 20`, `stepGoal(1, -1) === 1`, `stepGoal(3, +1) === 4`; `goalLabel(1) === 'תרגול אחד'`, `goalLabel(3)` → `3 תרגולים`.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement. **Step 4:** tests + typecheck PASS.
- [ ] **Step 5:** commit `feat(mobile): set My words' daily goal per course (phase 73 D1)`.

### Task 9: Words for me from the card ends in a session

**Files:** Modify `apps/mobile/src/app/discover.tsx` (+ a pure helper and test if the branch grows)

**Interfaces:** Consumes the `from: 'my-words'` param (Task 6) and `useNextSession().create`. When `from === 'my-words'`, `save` → `api.saveDiscovery` → `next.create()`: `ready` → `session.enter(id)`, `next.start(id)`, `router.replace('/session')`; `preparing` → keep the save button in the preparing look (`strings.preparingQuestions`) and `refresh()` every `POLL_INTERVAL_MS` until ready, then open as above; create rejects (`no_saved_words`, `not enough questions`, anything) → `router.dismissTo({ pathname: '/', params: { photoSaved } })` as today. Back from the session lands on home (replace, not push). Without the param: unchanged.

- [ ] **Step 1: Failing unit test** of the pure step `afterSave(from, created | error)` → `'open' | 'wait' | 'home'`.
- [ ] **Step 2–4:** FAIL → implement → PASS (tests + typecheck).
- [ ] **Step 5:** commit `feat(mobile): Words for me from My words goes straight into a session (phase 73 D6)`.

### Task 10: e2e

**Files:** Create `e2e/tests/my-words-goal.spec.ts`; modify specs that played the seed from home's card, and helpers in `e2e/tests/support/`

- [ ] **Step 1:** Write the spec: (a) a learner with saved words plays My words sessions (API helpers for speed, UI for the last) and the card shows the start line, `כל הכבוד! עוד 2 תרגולים להיום`, then met and the bonus dot, with tiles; (b) finish a session in the UI → `results-my-words` shows the same line → `results-continue` opens the next session's first card with no `GET …/sessions/current` request between the press and the first card → back lands on home; (c) settings → יעד יומי → goal 1 → home card met; switch off → no line; (d) a fresh enrollment with no words → card → `discover` screen → (mocked rounds as `discover.spec.ts` does) save → a session's first card, home never shown. Locators on results scoped to `results-my-words`.
- [ ] **Step 2:** `npm run e2e -- tests/my-words-goal` (filter by `tests/<name>`, not a bare name); fix until green.
- [ ] **Step 3:** Run the whole suite `npm run e2e`; fix specs broken by the seed change (start them from saved words or the API helpers) without weakening their assertions. Remove `e2e/test-results` traces after reading (ADR 0006 R2).
- [ ] **Step 4:** `npm run test:all`, `npm run lint:arch` green.
- [ ] **Step 5:** commit `test(e2e): My words' goal, results and Words for me into a session (phase 73)`.
