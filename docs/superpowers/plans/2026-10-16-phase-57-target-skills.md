# Phase 57 — Target skills and a path per target: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (Victor's
> `go till PR, subagents`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each active target gets its own sessions, picker and 0–10 target skills capped by days left;
home and the target screen show today's work and readiness for the date; FSRS stays as it is.

**Architecture:** Pure domain first: the cap table, the per-session update, the plan and "work today",
readiness and the target picker (`targetSkills.ts`, `targetDay.ts`, `targetPicker.ts`). Then storage
(`sessions.target_id`, `target_skills`, its event log, `target_words.started_on`), the session-end
write, and sessions per path (stock, start, create, current keyed by `(enrollment, target | main)`).
Then the wire and the app (home cards in priority order, the target card, the target screen), the day
simulation, e2e.

**Tech Stack:** TypeScript, Zod 4, Hono + OpenAPI, Drizzle/Postgres, pg-boss jobs, Jest, Expo/React
Native, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-16-lang-tutor-phase-57-target-skills-design.md` (D1–D13).
Every task's implementer reads the spec's decisions it names.

## Global Constraints

- FSRS memory, levels and "known" are written exactly as today from every session (spec Done 1).
- Values and caps are stored in **half-points** (integers 0–20); the wire shows values as numbers 0–10
  in steps of 0.5 and readiness as an integer percent.
- Cap table (spec D5), in `chooseConstants.ts` as `TARGET_CAP_HALVES`: days left 1→20, 2→16, 3→10,
  4→8, 5→7, 9→6, 14→5, 20→4, 27→3; any other day takes the entry of the smallest table day ≥ it; past
  27 → 2; days left ≤ 0 (the due date) → 20.
- Points (spec D4), `TARGET_POINTS_HALVES = { recall: 4, recognition: 2, miss: 4 }`.
- `TARGET_SPEAKING_PER_SESSION = 3`; the main path keeps `SPEAKING_PER_SESSION = 1`.
- `API_LEVEL` 4 → 5 (ADR 0012): `ready_count` changes meaning and the word's `readiness` enum is removed.
- Hebrew only, RTL; the strings are the spec's (D10–D12); weekdays Sunday first.
- ADR 0001 (domain pure: the day is passed in), 0003 (every schema in core `api/schemas.ts`), 0004
  (database tests under `tests/integration/`), 0007 (enqueue via `repo/jobs.ts` in the write's
  transaction), 0010 (new columns have defaults or are nullable), 0011 (key on `gloss_id`), 0013 (the
  day from `learnerDay` only).
- Never hardcode a port or database name; integration and e2e run through `scripts/lane-env.sh` (this
  worktree is lane 7).
- Day-simulation marks are never lowered (spec §7): FSRS ready-on-due exam 0.57, homework 0.85.
- Rulings made during the run are recorded in the spec as `R1.`, `R2.`… with the line `Ruling:` in the
  task report.

## Review Focus

1. A target whose date is moved earlier after values were earned: values stay, the cap rises, work is
   owed at once (Task 2, `targetDay.test.ts` "date moved earlier").
2. A gloss in two active targets answered in one target's session: both targets' rows move, each
   against its own cap (Task 4, integration).
3. A session started before a target was created and finished after: answers given before the word's
   `added_at` move no target value (Task 4).
4. A stock built for a target while that target's previous session is in flight asks the next owed
   skill, not the same one (Task 3, `targetPicker.test.ts` "in flight").
5. Home with two targets, one owed and one done, and a reminder tap: the owed target's session opens
   (Task 9, `nextSession.test.ts`).

---

### Task 1: Target skills math

**Files:** Create `apps/server/src/domain/targetSkills.ts`, `targetSkills.test.ts`; modify
`chooseConstants.ts`.

**Produces:**
- `capHalves(daysLeft: number): number`
- `practiceDays(): readonly number[]` (the table's days, descending) and
  `nextPracticeIn(daysLeft: number): number | null` (days until the next table day below `daysLeft`;
  null when none before the date)
- `isRecallCard(type: QuestionType): boolean` (recall: typed_meaning, typed_translation, cloze_typed,
  sentence_translation, dictation, say_translation)
- `type TargetSkillRow = { targetId: string; glossId: string; dimension: Dimension; halves: number; sessionId: string | null; day: string | null }`
- `type TargetAnswer = GradableAnswer & { glossId: string; helped: boolean }`
- `type TargetSkillEvent = { targetId; glossId; dimension; sessionId; before: number; after: number; why: 'miss' | 'recall' | 'recognition' }`
- `applyTargetSession(input: { targetId: string; sessionId: string; day: string; capHalves: number; glossIds: ReadonlySet<string>; before: readonly TargetSkillRow[]; answers: readonly TargetAnswer[] }): { rows: TargetSkillRow[]; events: TargetSkillEvent[] }`

- [ ] Tests: `capHalves` for 1, 2, 3, 4, 5, 6, 9, 10, 14, 20, 21, 27, 28, 100, 0 and −1 (20, 16, 10, 8, 7,
  6, 6, 5, 5, 4, 3, 3, 2, 2, 20, 20); `nextPracticeIn(19) === 5`, `(9) === 4`, `(1) === null`;
  `applyTargetSession`: one right recall answer on a skill at 0 with cap 20 → 4; recognition only → 2;
  a miss and a right recall in the same session → −4 floored at 0; three right recalls in one session →
  +4 once; a gain stops at the cap (cap 5, value 4, recall → 5); a value above the cap stays (cap 4,
  value 10, recall → 10); an intro answer, a `read_aloud` and a `meet` change nothing; a helped answer
  changes nothing; a dictation near miss is a miss for spelling and a right recall for spoken receptive
  (via core's `gradesFor`); answers about a gloss not in `glossIds` are ignored; each change yields one
  event with `before`/`after`/`why`; an untouched skill yields no row change and no event.
- [ ] Run `npx jest apps/server/src/domain/targetSkills.test.ts` from `apps/server` (fails), implement
  with `gradesFor` (a piece with grade 1 is a miss), run (passes), commit
  `feat(server): target skills, their cap and per-session update (phase 57)`.

### Task 2: The plan, work today and readiness

**Files:** Create `apps/server/src/domain/targetDay.ts`, `targetDay.test.ts`.

**Consumes:** Task 1.
**Produces:**
- `type TargetWordInput = { glossId: string; addedOn: string; startedOn: string | null; live: readonly Dimension[] }` (live: the word's live skills, speaking dropped for an unspeakable word)
- `type WordDay = { glossId: string; state: 'owed' | 'done' | 'extra' | 'later'; toStart: boolean; owed: Dimension[]; checks: Dimension[]; readinessPct: number; skills: { dimension: Dimension; halves: number }[] }`
- `type TargetDay = { daysLeft: number; capHalves: number; state: 'owed' | 'done' | 'rest' | 'due_today'; planned: number; done: number; extra: number; nextPracticeIn: number | null; readinessPct: number; readyCount: number; words: WordDay[] }`
- `targetDay(input: { today: string; createdOn: string; dueOn: string; words: readonly TargetWordInput[]; skills: readonly TargetSkillRow[]; rightToday: ReadonlySet<string> /* `${glossId}|${dimension}` */; answeredToday: boolean }): TargetDay`

The plan (spec D6), the algorithm the signature does not fix:

```text
total = daysBetween(createdOn, dueOn) (≥ 1); half = ceil(total / 2)
introDays = [total] ∪ { d in practiceDays() : half ≤ d < total }        // days left, descending
k = |{ d in introDays : d ≥ daysLeft }|                                   // intro days reached
words ordered by (addedOn, glossId); quota = ceil(N × k / |introDays|)
planned(word i) = i < quota || daysLeft(addedOn) < half || (startedOn !== null && startedOn < today)
```

Work today: a planned, unstarted word is `toStart`; a planned, started word owes its live skills with
`halves < capHalves` (`owed`) and, when `startedOn` is yesterday and `daysLeft > 0`, each live skill not
in `rightToday` (`checks`); a word started today but not planned is `extra` (owes nothing); an unplanned
unstarted word is `later`. Target state: `due_today` when `daysLeft ≤ 0`; `owed` when any word owes;
else `done` when `answeredToday`, else `rest`. `planned`/`done` count planned words; readiness: a word's
`round(100 × Σhalves / (20 × |live|))`, the target's over all words' sums; `readyCount` words at 100.
`nextPracticeIn` is 1 when a word was started today (tomorrow's check), else Task 1's.

- [ ] Tests (each a named `it`): homework due tomorrow (created today): every word `toStart`, cap 20;
  exam created 20 days out with 20 words: day 0 plans 10 (introDays 20, 14) and day 6 plans 20; nothing
  owed on day 2 after day 0 and 1 were finished → `rest`, `nextPracticeIn` 4; day 1 owes the
  next-day checks of day 0's words; Victor's case: 20 words, 2 started 3 days ago at a 20-day exam →
  `owed` with the 8 unstarted planned words `toStart`; a word started early today → `extra`, target
  stays `done`, `extra` 1; the same word the next day owes the cap like the rest; a word added after
  halfway is planned at once; date moved earlier: values kept, more owed; an unspeakable word's
  readiness ignores speaking; `due_today` on the date with no checks owed.
- [ ] Run, implement, run, commit `feat(server): a target's plan, its work today and readiness (phase 57)`.

### Task 3: The target picker

**Files:** Create `apps/server/src/domain/targetPicker.ts`, `targetPicker.test.ts`; modify
`chooseConstants.ts` (`TARGET_SPEAKING_PER_SESSION`), `choose.ts` (`ChoiceClass` gains `'TARGET'`).

**Consumes:** Tasks 1–2; `ChosenPick`, `ORDER`, `RUNGS` (plan.ts), `LADDER_SLOTS`, `NEW_PER_SESSION`,
`SESSION_LENGTH`.
**Produces:** `chooseTargetPicks(input: { day: TargetDay; mode: 'owed' | 'more' | 'last_review'; levels: ReadonlyMap<string, number> /* `${glossId}|${dimension}` → main level */; known: ReadonlySet<string> /* glosses with main memory: start without a ladder */; keys: ReadonlyMap<string, string>; inFlight: readonly { glossId: string; type: QuestionType }[] }): ChosenPick[]`

Rules (spec D7, D10): `mode` is `owed` when `day.state === 'owed'`, `last_review` on `due_today`, else
`more`. Owed: words to start first (a ladder pick for a new word, at most `NEW_PER_SESSION`; a recall
pick for a `known` one), then owed words furthest below cap first: the skill furthest below cap, ties to
the skill whose recall card moves the most still-owed skills (typed translation: WR, WP, spelling; say
translation: SR, SK; dictation: SR, spelling), then `ORDER`; rung 1 when the skill is at 0, else 2;
speaking always rung 2; next-day checks after below-cap work, rung 2. At most two picks per word, for
different skills; one gloss per key; `SESSION_LENGTH` slots (a ladder takes `LADDER_SLOTS`); at most
`TARGET_SPEAKING_PER_SESSION` speaking picks. `more`: `extra` words below cap first, then the next
`later` words as extra ladders, then one rung-2 pick per planned word in spelling, written productive
or speaking, the least recently practised first (ties by gloss id). `last_review`: skills below 20
furthest first, then `more`'s hardest cards. Picks carry `cls: 'TARGET'` (a ladder: `'NEW'`,
`ladder: true`), `r: 1` (null for a ladder), `level` from `levels` (1 when absent). `inFlight` answers
are credited as right before choosing (each card's `dimensionsTested` with its points), so a stock
built mid-session asks the next skill.

- [ ] Tests: the 2026-10-16 replay shape (6 words, due tomorrow, all started, written receptive at the
  cap, spelling and speaking below) asks spelling and speaking, never written receptive; a word at 0
  gets rung 1; speaking is rung 2; two picks per word at most, different skills; four speaking
  picks are cut to 3; owed words to start come before owed skills; a `known` word starts without a
  ladder; `more` picks `extra` words below cap before new ladders; `last_review` asks a skill at 16
  before hardest cards; "in flight": a stock with the in-flight session's typed translation for word A
  asks A's speaking next; with nothing owed and `mode: 'owed'` the result is empty.
- [ ] Run, implement, run, commit `feat(server): the target picker (phase 57)`.

### Task 4: Storage and the session-end write

**Files:** `apps/server/src/db/schema.ts` + a generated migration (`npm run db:generate --workspace
apps/server`, then `npm run db:migrate`), `repo/targets.ts` (or a new `repo/targetSkills.ts` wired in
`repo/index`/`composition`), `repo/progress.ts` (`findSessionEvidence` adds `a.helped` and
`a.answered_at`), `services/sessions.ts` (`recordProgress`), `db/progressRecompute.ts`; tests
`tests/integration/services/sessions.targetSkills.test.ts`, `tests/integration/db/progressRecompute.test.ts`,
`tests/integration/db/schema.test.ts`.

**Consumes:** Task 1.
**Produces (schema):** `sessions.target_id uuid null` (FK `targets.id`); `target_skills(target_id,
gloss_id, dimension, halves smallint, session_id, day date)` PK `(target_id, gloss_id, dimension)`;
`target_skill_events(id, target_id, gloss_id, dimension, session_id, before smallint, after smallint,
why text, created_at)`; `target_words.started_on date null`; `session_targets`: `wish`, `slots`,
`picked`, `reason` nullable, new nullable `cap_halves`, `readiness_pct`, `fsrs_ready_count`.
**Produces (repo):** `targetSkills.findRows(targetIds: string[], glossIds: string[]): Promise<TargetSkillRow[]>`,
`targetSkills.upsertRows(rows)`, `targetSkills.insertEvents(events)`, `target.markStarted(targetId,
glossIds, day)`, `target.listActiveHolding(enrollmentId, glossIds, day)` (active targets with their
`dueOn`, `addedAt` per gloss).

- [ ] Integration tests first: completing a session with a target word writes `target_skills` and one
  event per change, in the same transaction as the memory write (a failure in either writes neither);
  a gloss in two active targets moves both, each against its own cap; answers before the word's
  `added_at` count for nothing; `started_on` is set on the first session that asks the word and never
  moved; a skip writes as a completion does; the recompute rebuilds `target_skills` and `started_on`
  equal to the live write for a recorded day; schema test: the new columns and the per-path indexes
  of Task 5 exist.
- [ ] Run `npm run test:integration -- --selectProjects=integration --runTestsByPath <files>` from the
  worktree root (fails), implement, run, commit
  `feat(server): target skills are recorded at session end (phase 57)`.

### Task 5: Sessions per path

**Files:** `db/schema.ts` (+ migration: replace `sessions_one_stock_per_enrollment` and
`sessions_one_started_per_enrollment` with the same rules per `(enrollment_id, coalesce(target_id,
'00000000-0000-0000-0000-000000000000'))`), `repo/sessions.ts`, `services/sessions.ts`,
`services/stock.ts`, `services/targets.ts`, `services/vocabulary.ts`, `domain/jobs.ts`
(`StockSessionPayload.target_id?: string`), `routes/sessions.ts`, core `api/schemas.ts`
(`CreateSessionRequest.target_id?`, `GET …/sessions/current?target_id=`, response `due_count`),
`docs/adr/adr-0014-sessions-belong-to-a-path.md`; delete `domain/targetSession.ts` and, in
`domain/targets.ts`, `targetWish`, `splitSlots`, `owedNew` and their tests (keep `recallOnDue`,
`readinessOf`, `TARGET_READY`/`TARGET_ALMOST` for the recorded yardstick). Tests: integration
`sessions.targets.test.ts` (rewritten), `sessions.test.ts`, `jobs/stockSession.test.ts`,
`routes/sessions.test.ts`, `openapi.test.ts`; unit tests that import the deleted code.

**Consumes:** Tasks 2–4.
**Produces:** `type Path = string | null` (a target id, or null for the main path) threaded through
`findOpen(enrollmentId, path)`, `lockNextSession(enrollmentId, path)` (key
`next-session:${enrollmentId}:${path ?? 'main'}`), `insertPreparingSession(…, path)`, `retireStock`,
`requestStock(repos, { enrollment_id, target_id?, reason })` (singleton key per path),
`createNextSession(actor, enrollmentId, devices, path)`, `currentSession(actor, enrollmentId, path)`;
`readChoice` splits: the main path reads `chooseWords` over saved glosses in no active target; a target
path builds Task 2's `TargetDay` and calls Task 3's picker, and its stock writes one `session_targets`
row (`days_left`, `cap_halves`, `readiness_pct`, `ready_count`, `word_count`, `fsrs_ready_count`).

- [ ] Integration tests first: a target's stock and the main stock coexist, each with its own started
  session (`session_open` only within a path); the main path never picks an active target's word, and
  picks it again after the target ends; a target change retires both stocks (`restockAfterTargetChange`)
  and asks for both; starting a target session requests that target's next stock only; the stale check
  replaces a target stock chosen on an earlier day when today's `TargetDay` differs in cap or owed words;
  a target stays active through its due date and ends the day after (`ended_on_date` written by the next
  stock); a create with an unknown or other learner's `target_id` is a 404/403; `current` without
  `target_id` answers the main path as before, with `due_count`; the bots' create/current calls work
  unchanged (`cd bots && npm test`).
- [ ] ADR 0014 (`create-adr` format; no check script — the rule lives in the indexes): every session
  belongs to one path, stock and started are per path, the main path asks no active target's words.
- [ ] Run unit + integration + `npm run lint:arch`, implement, run, commit
  `feat(server): each target has its own sessions (phase 57)`.

### Task 6: The targets wire

**Files:** core `api/schemas.ts`, `apiLevel.ts` (5, with its comment), `services/targets.ts` (`view`,
`list`, `getTarget`), `routes/targets.ts`; tests `routes/targets.test.ts`, integration `targets.test.ts`,
core `schemas.test.ts`, `openapi.test.ts`.

**Consumes:** Tasks 2, 5.
**Produces (wire):** `TargetSummary` gains `readiness_pct: int`, `today: { state: 'owed'|'done'|'rest'|'due_today'; done: int; planned: int; extra: int; next_practice_in: int | null }`,
`session: SessionSummary | null` (the target path's started ?? stock ?? failed newest, as `current`);
`ready_count` counts words at 100. `TargetWord` loses `readiness`, gains `readiness_pct`,
`today: 'owed'|'done'|'extra'|'later'`, `owed: Dimension[]`, `starts_in: int | null`,
`skills: { dimension: Dimension; value: number; cap: number }[]` (value and cap in points, halves ÷ 2).
The list holds targets through their due date.

- [ ] Tests: each field for a target in each state; `ready_count` 0 while no word is at 100; a target on
  its due date is listed with `today.state: 'due_today'`; an old `X-Api-Level: 4` client is answered 426.
- [ ] Run, implement, run, commit `feat(server): targets answer their day and readiness; API level 5 (phase 57)`.

### Task 7: The day simulation

**Files:** `apps/server/src/domain/day.test.ts` (the phase 53 target block rewritten), `day.fixture.ts`
only if a fixture is needed.

**Consumes:** Tasks 1–3, the main picker.
**Produces:** `runPaths(list, days, sessionsADay, targets, learner)`: per session the learner plays the
first card home shows (spec D11: an owed target, nearest date first, else "My words"), the target's
session from `chooseTargetPicks`, main from `chooseWords` over words in no active target; target values
updated with `applyTargetSession`, FSRS and levels as today.

- [ ] Scenarios and marks (spec §7): exam in 14 days and homework in 14 days, 20 words (FSRS ready on
  due, five-phase mean: exam ≥ 0.57, homework ≥ 0.85 — never lowered; report the measured values in
  the test name); homework due tomorrow, 6 words: target readiness 100% the same day within the day's
  sessions, and no target session asks a card that serves no owed work (the 2026-10-16 replay, spec Done
  7); exam in 3 days: 100% only on the eve; exam in 20 days: practice evenings ≤ 10 for a learner who
  never misses; a skipped day (no sessions on a practice day) is owed the next day; words added after
  halfway are started the same day; the date moved earlier. Delete the phase 53 split assertions.
- [ ] If an FSRS mark fails, tune `TARGET_CAP_HALVES` and the practice days (Global Constraints) and
  record a ruling; if tuning cannot meet it, stop and report (the spec sends it to Victor).
- [ ] Run `npx jest src/domain/day.test.ts` from `apps/server`, commit
  `test(server): the day simulation follows each target's path (phase 57)`.

### Task 8: Home — the target card and the order

**Files:** `apps/mobile/src/components/TargetsSection.tsx` (becomes `TargetCard.tsx` per target),
`components/LearningSection.tsx` (the "My words" card wraps today's session action; cards ordered),
`targets.ts` (pure: `homeOrder`, `targetCardState`, `readinessColor(pct)`), `strings.ts`,
`hooks/useTargets.tsx` (poll while any target session is preparing), `nextSession.ts`; tests
`targets.test.ts`, `nextSession.test.ts`, `strings.test.ts`.

**Consumes:** Task 6's wire.
**Produces:** `homeOrder(targets: TargetSummary[]): { first: 'main' | string; order: ('main' | string)[] }`
(owed targets by `due_on`, main, the rest; a `due_today` target first);
`readinessColor(pct: number): string` (hue 0 → 120 over 0–100, green at 100);
`targetSessionAction(target: TargetSummary): HomeAction` (as `homeActionOf` over `target.session`;
no session → `create`).

- [ ] Pure tests: order for owed/done/rest/due-today mixes; the first card's button filled; colour at
  0, 50, 100; strings: `targetCountdown(kind, days)` "בוחן בעוד 5 ימים" / "שיעורי בית מחר",
  `targetToday(done, planned)` "היום: 3 מתוך 8 מילים", `targetExtra(n)` "+2 נוספות",
  `targetReadinessPct(kind, pct)` "מוכנות לבוחן: 18%", `practiceNow` "לתרגל עכשיו", `practiceMore`
  "לתרגל עוד", `targetDonePraise` "כל הכבוד! סיימת להיום. נתראה מחר", `targetRest(n)`
  "היום אין תרגול לבוחן. התרגול הבא בעוד N ימים", `targetDueToday(kind)` "הבוחן היום",
  `targetGoodLuck` "בהצלחה!", `lastReview` "חזרה אחרונה", `myWords` "המילים שלי",
  `wordsWaiting(n)` "N מילים מחכות לחזרה".
- [ ] Views: the card per spec D11 (countdown title with the number large in `colors.primary`, today
  line and bar with the lighter green past the plan, readiness line and coloured bar, praise / rest /
  due-today lines, filled or outlined button); the target button creates (with `target_id`), polls,
  starts and enters the target session as `LearningSection` does for the main path; "My words" keeps
  `start-button` and every existing test id; the reminder tap enters the first card's path.
- [ ] Run `npm test --workspace apps/mobile` and `npm run typecheck`, commit
  `feat(mobile): home's cards by priority, the target card (phase 57)`.

### Task 9: The target screen

**Files:** `apps/mobile/src/app/targets/[id].tsx`, `targets.ts` (`wordGroups(words)`), `strings.ts`;
tests `targets.test.ts`.

**Consumes:** Task 6, Task 8's `readinessColor`, core's `DIMENSION_NAMES` (`strings.dimensionName`).
**Produces:** `wordGroups(words: TargetWord[]): { owed; done; extra; later }` in that order.

- [ ] Tests: grouping; a row's line "היום נשאר: איות, כתיבה" from `owed`; "היום ✓", "בונוס ✓",
  "נתחיל מחר"/"נתחיל בעוד N ימים" from `starts_in`; group titles "נשאר להיום", "סיימת להיום",
  "נוספו היום", "בהמשך".
- [ ] View: header as the card; groups; tapping a row toggles its skills (bars out of 10, a line at the
  cap, green at the cap); remove and the actions unchanged; test ids `target-word-${gloss_id}`,
  `target-word-skills-${gloss_id}`, `target-group-owed|done|extra|later`.
- [ ] Run, commit `feat(mobile): the target screen groups its words and opens their skills (phase 57)`.

### Task 10: e2e

**Files:** `e2e/tests/targets.spec.ts`, `next-session.spec.ts`, `reminders.spec.ts`, `support/sessions.ts`.

- [ ] Tests: a new homework shows its card first with "לתרגל עכשיו", which starts a session of its
  words only; after finishing every owed card the card shows the praise and "My words" moves first;
  "לתרגל עוד" starts another target session; the target screen's groups and a tapped word's skills;
  a target on its due date shows "בהצלחה!". Existing specs pressing `start-button` pass unchanged.
- [ ] Run `npm run e2e`, fix, commit `test(e2e): home's paths and the target card (phase 57)`.

### Task 11: Finish

- [ ] `npm test`, `npm run test:all`, `npm run lint:arch`, `npm run e2e`, `cd bots && npm test`.
- [ ] Add the run's rulings to the spec as `R1.`, `R2.`…, mark its Status as built, commit
  `docs(spec): phase 57 records the rulings of its run`.
- [ ] `superpowers:finishing-a-development-branch` → `git-create-pr` → `ci-green`.
