# Phase 65 — Readiness as a grade, and today as a budget: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A target's readiness becomes the grade the learner would get on the due date (a pure rule over a per-target copy of the FSRS memory), and the card counts today in sessions as a budget that never grows.

**Architecture:** The rule is pure in `packages/core/src/domain/readiness.ts`. The server records a readiness row per (target, word, skill) and an event log in the session-end transaction, rebuilt by the recompute; a pure play-forward of the unchanged target picker sets the day's session budget at the path's first session. The target view puts both on the wire; the app draws the approved card, the target screen's word skills and the "practice more" sheet.

**Tech Stack:** TypeScript, Hono + zod-openapi, Drizzle/Postgres (drizzle-kit migrations), Jest, Expo React Native, AsyncStorage, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-19-lang-tutor-phase-65-readiness-grade-design.md` (D1–D11, rulings R1–R4). Read it before your task.

## Global Constraints

- Work only in the worktree `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-65-readiness-grade` (branch `phase-65-readiness-grade`). Never write in `/Users/victorprp/git/lang-tutor` (the main checkout); after each task its `git status` must be unchanged.
- ADR 0001: `domain/` and `packages/core/src/domain` are pure (no clock, no `Math.random`, no I/O); services own the transaction; repos only from `services/` as types.
- ADR 0013: the progress day is `sessions.practice_day`; never derive a date another way in `apps/server/src`.
- ADR 0014: target budgets are per path; no new next-session lock without its path.
- ADR 0012: `API_LEVEL` goes from 5 to 6 in this PR (readiness changes meaning).
- ADR 0006: never hardcode a port or database name; run DB-backed tests through `npm run test:integration` (lane wrapper).
- UI copy is Hebrew only, hard-coded, RTL. Strings live in `apps/mobile/src/strings.ts`.
- Readiness constants (core, R3): `READINESS_BONUS_SHARE = 0.25`, `READINESS_BONUS_PER_DAY = 2`, `READINESS_EXAM_HOLD = 0.5`, `READINESS_WORD_READY = 90`, `READINESS_LITTLE = 2`.
- Counted skills (D1): homework `written_productive`, `spelling`, `spoken_productive`; exam `written_productive`, `spelling`; each ∩ the word's live skills.
- Readiness = `floor(100 × mean of word chances)`; a word's chance = product of its counted skills' chances; a live counted skill with no state = 0.
- Never lower a day-simulation mark (`READY_ON_DUE_PASS`, phase 57 gates). If one moves, compare five-phase aggregates against master's.
- Commit after each task with a `feat(...)`/`test(...)`/`docs(...)` message like `git log` shows, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Do not run `expo lint` in `apps/mobile`. Delete `e2e/test-results` traces and `apps/server/tests/eval/.results/*.json` before finishing (they trip ADR 0006's check).

## Review Focus

1. A word the device cannot speak (or a learner whose sessions never record): homework readiness must not be 0 for it — `spoken_productive` is dropped from its counted skills (live skills, as `readTargetDay`). Test in Task 4.
2. A word added to a target mid-day after it was practised in My words that morning: its first target answer that day is a same-day answer (bonus), not a new first try, because the row starts from `gloss_memory` with `day = lastDay` (R1). Test in Task 1 (`readinessFromMemory` then `applyReadiness`).
3. The due date moved later after bonuses were stored: chances re-read for the new date, rows unchanged, nothing throws (no division by zero when `lastDay` is far from the new date). Test in Task 1.
4. A session that started yesterday and ends today (Sun 21:51 → Mon 11:55): its answers count on its `practice_day` (Monday), and the budget counts it as Monday's session. Test in Task 3.
5. Two sessions of two paths ending at once for a word in two targets: each target's rows are written against its own kind and date, once. Test in Task 2 (two targets, one session).

---

### Task 1: The readiness rule in core

**Files:**
- Create: `packages/core/src/domain/readiness.ts`
- Modify: `packages/core/src/domain/index.ts` (export it)
- Create: `packages/core/src/domain/readiness.fixture.ts` (from `/Users/victorprp/git/lang-tutor/drafts/2026-10-19-readiness-grade-evidence/answers.json`: `export const HOMEWORK_2026_10_17: readonly ReplayAnswer[] = [...]`, each `{ session, day, word, type, correct?, verdict?, intro? }`, same order)
- Test: `packages/core/src/domain/readiness.test.ts`, `packages/core/src/domain/readiness.replay.test.ts`

**Interfaces:**
- Consumes: `review`, `retrievability`, `MemoryState`, `Grade` (`memory.ts`); `Dimension`; `gradesFor` (replay test only).
- Produces:
  ```ts
  export type ReadinessKind = 'homework' | 'exam';
  export type ReadinessRow = { state: MemoryState; day: string; missedToday: boolean; bonusUsed: number; held: boolean };
  export type ReadinessWhy = 'first_right' | 'first_miss' | 'miss' | 'bonus';
  export function countedSkills(kind: ReadinessKind, live: readonly Dimension[]): Dimension[];
  export function readinessFromMemory(state: MemoryState): ReadinessRow;
  export function applyReadiness(row: ReadinessRow | null, grade: Grade, day: string, dueOn: string, kind: ReadinessKind):
    { row: ReadinessRow; why: ReadinessWhy } | null; // null = ignored
  export function skillChance(row: ReadinessRow | null, dueOn: string): number; // 0..1
  export function wordChance(chances: readonly number[]): number;               // product; [] → 0
  export function readinessPct(wordChances: readonly number[]): number;          // floor(100·mean); [] → 0
  export function readinessGainBound(words: readonly (readonly (ReadinessRow | null)[])[], today: string, dueOn: string, kind: ReadinessKind): number;
  // + the five READINESS_* constants
  ```

- [ ] **Step 1: Write the failing unit tests** (`readiness.test.ts`), one `it` each:
  - `countedSkills('homework', ['written_receptive','written_productive','spelling','spoken_receptive','spoken_productive'])` → `['written_productive','spelling','spoken_productive']`; `countedSkills('exam', …same)` → `['written_productive','spelling']`; `countedSkills('homework', ['written_productive','spelling'])` → `['written_productive','spelling']`.
  - First answer of a day is a long-term review: `applyReadiness(null, 3, '2026-10-17', '2026-10-22', 'homework')` → `why 'first_right'`, `row.state` equals `review(null, 3, '2026-10-17')`, `bonusUsed 0`, `missedToday false`.
  - A miss counts once a day: after a first miss, a second `applyReadiness(row, 1, sameDay, …)` → `null`; after a first right, the first later miss → `why 'miss'` with `state` = `review(prev.state, 1, day)`, a second → `null`.
  - The bonus: a later right the same day → `why 'bonus'`, `skillChance` after = `r + 0.25·(1 − r)` (to 1e-9), `lastDay` and `difficulty` unchanged; the third later right → `null`.
  - Exam hold: first answer of a day a miss → `held true`, `skillChance` = `0.5 × retrievability(state, due)`; a later-day first right → `held false`; homework never holds.
  - Frozen: any `applyReadiness` with `day >= dueOn` → `null`.
  - Nothing moves overnight: `skillChance(row, due)` takes no today; the same row read twice gives the same number (document by test name).
  - `readinessFromMemory(state)` → `{ state, day: state.lastDay, missedToday: false, bonusUsed: 0, held: false }`; then a right on `state.lastDay` is a `bonus` (Review Focus 2).
  - The date moved later: a row given bonuses for `2026-10-22` read with `skillChance(row, '2026-11-05')` is finite, in (0, 1), and lower than for `2026-10-22` (Review Focus 3).
  - `wordChance([0.54, 0.97, 0.88])` ≈ 0.461; `readinessPct([0.46, 0.89])` → 67; `readinessPct([])` → 0.
  - `readinessGainBound`: for words whose every skill has `day === today` and `bonusUsed === 2` → 0; for a word whose skill has no row → > 0.

- [ ] **Step 2: Run them to see them fail** — `npx jest packages/core/src/domain/readiness.test.ts` (from the worktree root, or `npm test -w packages/core -- readiness`). Expected: FAIL, module not found.

- [ ] **Step 3: Implement `readiness.ts`.** Rules exactly as spec D3:
  - first answer of `day` (`row === null || row.day !== day`): `review(row?.state ?? null, grade, day)`; `missedToday = grade === 1`; `bonusUsed = 0`; exam: `held = grade === 1` (a right lifts it), homework `held = false`.
  - later miss: if `!missedToday` → `review(state, 1, day)`, `missedToday = true`; else `null`.
  - later right (grade 2 or 3): if `bonusUsed < READINESS_BONUS_PER_DAY` → set stability so `retrievability(state, dueOn) = r + SHARE·(1 − r)`: with `w20 = 0.1542`, `F = 0.9^(−1/w20) − 1`, `t = days(lastDay → dueOn)`, `stability = F·t / (target^(−1/w20) − 1)`; if `t <= 0` or `r >= 0.9999` return the row unchanged but still count the bonus; else `null`.
  - `skillChance = row ? retrievability(row.state, dueOn) × (row.held ? HOLD : 1) : 0`.
  - `readinessGainBound`: new pct − current pct if every skill got one more right `today` (no row → `applyReadiness(null, 3, …)`; `row.day !== today` → a first right; else one bonus if any left), each word's chances multiplied, `readinessPct` over words.
  - Read `w20` from the parameter set (`FSRS6_DEFAULT.w[20]`) rather than a literal.

- [ ] **Step 4: Write the replay test** (`readiness.replay.test.ts`, spec Done 4, R4): feed `HOMEWORK_2026_10_17` in order through `gradesFor` (skip pieces not counted), all three skills live for all 15 words, due `2026-10-22`; read `readinessPct` after each fixture `session`. Assert the last value of each day:
  - homework: `{ '2026-10-17': 45, '2026-10-18': 70, '2026-10-19': 83 }`
  - exam: `{ '2026-10-17': 53, '2026-10-18': 55, '2026-10-19': 77 }`, and the 18 Oct sequence contains the step 60 → 46.

- [ ] **Step 5: Run core's tests and typecheck** — `npm test -w packages/core && npm run typecheck -w packages/core`. Expected: PASS.

- [ ] **Step 6: Commit** — `feat(core): phase 65 readiness rule — first try decides, one miss a day, a limited same-day bonus, an exam hold`.

---

### Task 2: Record readiness at session end, rebuild it in the recompute

**Files:**
- Modify: `apps/server/src/db/schema.ts` (three tables), create the migration with `npm run db:generate -w apps/server` (expect `0045_*.sql`; name it `0045_target_readiness.sql` via drizzle-kit's `--name`)
- Create: `apps/server/src/domain/readinessWrite.ts`, `apps/server/src/repo/targetReadiness.ts`
- Modify: `apps/server/src/domain/targetSkills.ts` (`HoldingTarget` gains `kind`), `apps/server/src/repo/targets.ts` (`listActiveHolding` selects `t.kind`), `apps/server/src/services/transaction.ts` (or wherever `Repos` is built: add `targetReadiness`), `apps/server/src/services/sessionEnd.ts`, `apps/server/src/db/progressRecompute.ts`
- Test: `apps/server/src/domain/readinessWrite.test.ts`, `apps/server/tests/integration/db/progressRecompute.test.ts`, an integration test beside the existing target session-end ones (`apps/server/tests/integration/services/sessions.targets.test.ts`)

**Interfaces:**
- Consumes: Task 1's `applyReadiness`, `countedSkills`, `readinessFromMemory`, `skillChance`, `ReadinessRow`, `ReadinessKind`; `MemoryRow` (`domain/memoryUpdate.ts`); `TimedTargetAnswer`.
- Produces:
  ```ts
  // domain/readinessWrite.ts
  export type TargetReadinessRow = { targetId: string; glossId: string; dimension: Dimension; row: ReadinessRow; sessionId: string | null };
  export type TargetReadinessEvent = { targetId: string; glossId: string; dimension: Dimension; sessionId: string; day: string;
    before: number; after: number; why: ReadinessWhy }; // before/after = skillChance as read, 0..1
  export function readinessSessionWrite(input: { sessionId: string; day: string; targets: readonly HoldingTarget[];
    before: readonly TargetReadinessRow[]; memory: readonly MemoryRow[]; answers: readonly TimedTargetAnswer[] }):
    { rows: TargetReadinessRow[]; events: TargetReadinessEvent[] };
  // HoldingTarget: { id; dueOn; kind: 'homework' | 'exam'; words }
  // repo/targetReadiness.ts: createTargetReadinessRepo(tx) → { findRows(targetIds, glossIds), upsertRows(rows),
  //   insertEvents(events, at), findFirstEventsOn(targetId, day): { glossId; dimension; before }[], deleteAll() }
  ```
- Tables (schema.ts, comments in the file's style, "derive, then record"):
  - `target_readiness`: `target_id uuid`, `gloss_id text`, `dimension text`, `stability real`, `difficulty real`, `last_day date`, `reps integer`, `lapses integer`, `params text`, `day date`, `missed_today boolean`, `bonus_used smallint`, `held boolean`, `session_id uuid` null; PK (target_id, gloss_id, dimension); FK (target_id, gloss_id) → `target_words` on delete/update cascade; checks: dimension in the three counted skills, `bonus_used between 0 and 2`, `stability > 0`.
  - `target_readiness_events`: `id uuid` pk default random, `target_id` (FK targets cascade), `gloss_id`, `dimension`, `session_id`, `day date`, `before real`, `after real`, `why text` in ('first_right','first_miss','miss','bonus'), `created_at timestamptz`; index (target_id, day).
  - `target_budgets` (used by Task 3): `target_id uuid` FK targets cascade, `day date`, `sessions smallint`, `cards smallint`, `miss_room smallint`, `created_at timestamptz default now()`; PK (target_id, day).

- [ ] **Step 1: Write the failing domain tests** (`readinessWrite.test.ts`):
  - A target with no row and a `gloss_memory` row: the first right of a new day is a `first_right` from that memory state (R1); the event's `before` = `skillChance(readinessFromMemory(memory), due)`.
  - Answers before the word's `addedAt` are not counted (as `targetSessionWrite`).
  - Pieces of uncounted skills write nothing (an exam target ignores `spoken_productive`; nobody writes `written_receptive`).
  - A session on or after `dueOn` writes nothing (D3.7).
  - Two targets holding the gloss, a homework and an exam, one session with a first miss: two rows, the exam's `held true`, the homework's `held false` (Review Focus 5).
  - Ignored answers write no event; each applied answer writes one.

- [ ] **Step 2: Run** `npx jest apps/server/src/domain/readinessWrite.test.ts` — FAIL.

- [ ] **Step 3: Implement** `readinessSessionWrite` (pure: answers in order, `gradesFor` pieces, `countedSkills(kind, all three)`), the schema, the migration, the repo, `kind` on `HoldingTarget`/`listActiveHolding`.

- [ ] **Step 4: Wire the write.** In `sessionEnd.ts` add `recordReadiness(repos, sessionId, evidence)` and call it in `recordProgress` **before** `recordLevelsAndMemory` (it reads `gloss_memory` as it stood before this session, R1): `listActiveHolding` → `targetReadiness.findRows` → `memory.findRows` → `readinessSessionWrite` → `upsertRows` → `insertEvents(events, evidence.lastAnsweredAt)`. In `progressRecompute.ts`: `targetReadiness.deleteAll()` beside `targetSkills.deleteAll()`, and the same call in the same place, call for call.

- [ ] **Step 5: Integration tests.** Extend the recompute test so a rebuilt `target_readiness` and its events equal the live ones (rows and the ordered `(gloss, dimension, why, before, after)` of the log); add a session-end test: a homework target, one session answering a word right then wrong then right → one row, events `first_right`, `miss`, `bonus`.

- [ ] **Step 6: Run** `npm test -w apps/server` and `npm run test:integration` (from the worktree) — PASS; `npm run lint:arch` — clean.

- [ ] **Step 7: Commit** — `feat(server): phase 65 readiness rows and log, written at session end and rebuilt by the recompute`.

---

### Task 3: Today's session budget

**Files:**
- Create: `apps/server/src/domain/targetBudget.ts`, `apps/server/src/repo/targetBudgets.ts`
- Modify: `apps/server/src/domain/targetPicker.ts` (export `cardOf`), `apps/server/src/services/targetDayRead.ts` (extract the picker input builder from `services/sessions.ts` `readTarget` into `readTargetPickInput`), `apps/server/src/services/sessions.ts` (`readTarget` uses it; `startSession` writes the budget)
- Test: `apps/server/src/domain/targetBudget.test.ts`, `apps/server/src/services/sessions.stock.test.ts` or the service test that covers `startSession`, an integration test in `tests/integration/services/sessions.targets.test.ts`

**Interfaces:**
- Consumes: `targetDay`, `TargetWordInput`, `chooseTargetPicks`, `TargetPickInput`, `applyTargetSession`, `cardOf`, `LADDER_SLOTS`, `SESSION_LENGTH`, `dimensionsTested`.
- Produces:
  ```ts
  // domain/targetBudget.ts
  export function playTodayForward(input: { pick: Omit<TargetPickInput, 'day' | 'mode' | 'inFlight'>; today: string;
    createdOn: string; dueOn: string; words: readonly TargetWordInput[]; skills: readonly TargetSkillRow[];
    rightToday: ReadonlySet<string>; answeredToday: boolean }): { sessions: number; cards: number };
  export function budgetSessions(play: { sessions: number; cards: number }, missRate: number): number;
  //   = play.sessions + ceil(play.cards × missRate / SESSION_LENGTH)
  export const DEFAULT_MISS_RATE = 0.1; // fewer than 20 graded answers in the last 3 practice days
  export function missRateOf(answers: readonly GradableAnswer[]): number; // share with an Again piece; < 20 → DEFAULT
  // services/targetDayRead.ts
  export async function readTargetPickInput(repos, enrolled, target, devices, today): Promise<{ read; input: TargetPickInput } | null>;
  // repo/targetBudgets.ts: { find(targetId, day), insert(row) /* on conflict do nothing */ }
  ```
- `playTodayForward`: loop (at most 30): `day = targetDay(…)`; stop when `day.state !== 'owed'`; `picks = chooseTargetPicks({ …pick, day, mode: 'owed', inFlight: [] })`; stop when empty; count a session and its slots (`LADDER_SLOTS` for a `ladder` pick, else 1); then answer every pick right: a ladder sets the word's `startedOn = today` and grades nothing; a `TARGET` pick is one right answer of `cardOf(dimension, rung)` through `applyTargetSession` (cap of `today`) and adds its `dimensionsTested` to `rightToday`.

- [ ] **Step 1: Write the failing domain tests:**
  - Nothing owed → `{ sessions: 0, cards: 0 }`.
  - One started word, one live skill 8 halves below the cap, typed-translation recall gives +4 a session → `sessions === 2` (one change per skill per session).
  - Five new words due tomorrow (`NEW_PER_SESSION = 2` ladders a session) → `sessions >= 3`, and every word is started by the end of the play.
  - `budgetSessions({ sessions: 4, cards: 38 }, 0.09)` → 5; `budgetSessions({ sessions: 4, cards: 38 }, 0)` → 4.
  - `missRateOf` of 19 answers → 0.1; of 45 answers with 4 misses → 4/45.

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `targetBudget.ts` and export `cardOf`.

- [ ] **Step 4: Extract** `readTargetPickInput` from `readTarget` without changing `readTarget`'s behaviour (its existing tests must pass unchanged).

- [ ] **Step 5: Write the budget at the first session.** In `startSession`, for a target path, when `targetBudgets.find(target.id, today)` is empty, inside the starting transaction: `readTargetPickInput` → `playTodayForward` (from the day as it stands, no session in flight) → `missRateOf` over the enrollment's answers on its last 3 practice days (a repo read beside `findAnswersOn`) → `insert({ targetId, day: today, sessions: budgetSessions(…), cards, missRoom })`. The count is never rewritten (`on conflict do nothing`).
  - Test: a second start the same day leaves the row as it was; a session started Sunday and ended Monday counts as Monday's when the view counts sessions done (Review Focus 4: `sessions_done` reads `practice_day`, Task 4).

- [ ] **Step 6: Run** `npm test -w apps/server`, `npm run test:integration`, `npm run lint:arch` — PASS.

- [ ] **Step 7: Commit** — `feat(server): phase 65 today's session budget, set once at the first session by playing the picker forward`.

---

### Task 4: The wire and the target view

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (`TargetSummarySchema`, `TargetWordSchema`), `packages/core/src/apiLevel.ts` (5 → 6, history line "phase 65: readiness is the expected grade; ready_count counts words at 90; word skills are chances"), `apps/server/src/services/targets.ts` (`view()`), `apps/server/src/openapi.test.ts`
- Test: `apps/server/src/services/targets.test.ts`, `apps/server/src/routes/targets.test.ts`, `packages/core/src/api/schemas.test.ts`, integration `tests/integration/routes/…targets…`

**Interfaces:**
- Consumes: Tasks 1–3 (`readinessPct`, `wordChance`, `skillChance`, `countedSkills`, `readinessFromMemory`, `readinessGainBound`, `READINESS_WORD_READY`, `READINESS_LITTLE`; `targetReadiness` and `targetBudgets` repos; `readTargetPickInput`, `playTodayForward`, `budgetSessions`).
- Produces (wire, D10):
  - `TargetSummary`: `readiness_pct` (int 0–100, the new readiness), `readiness_start_pct` (int 0–100), `ready_count` (words with chance ≥ 90), `practice_more_little` (boolean), `today` gains `sessions_budget: int | null`, `sessions_offer: int`, `sessions_done: int`, `ended_early: boolean`, `minutes: int`; `today.state` keeps `'owed' | 'done' | 'rest' | 'due_today'`.
  - `TargetWord`: `readiness_pct` (the word's chance × 100, floored), `skills: { dimension, chance: int 0–100, held: boolean }[]` (counted ∩ live, in `countedSkills` order).
- `view()` rules:
  - Per word: counted skills = `countedSkills(target.kind, live of the word)` (live as `readTargetDay`: speaking dropped for an unspeakable word or a non-recording device — Review Focus 1); each skill's row from `target_readiness`, else `readinessFromMemory(gloss_memory row)`, else none.
  - `readiness_start_pct`: the same, with each skill's chance replaced by the `before` of its first event on `today` when it has one (`findFirstEventsOn`).
  - On and after the due date: values as stored (D3.7 freezes them).
  - `today.state`: `due_today` when `daysLeft <= 0`; else `done` when `sessions_budget !== null && sessions_done >= sessions_budget`; else `owed` when the plan's day is `owed`; else the plan's (`done`/`rest`). `ended_early`: state `done` and (`sessions_budget === null || sessions_done < sessions_budget`).
  - `sessions_done`: the path's completed sessions with `practice_day = today`. `sessions_offer`: the stored budget, else `budgetSessions(playTodayForward(…), missRate)` computed now. `minutes`: `round(cards × 0.5)` (≈ 30 s a card).
  - `practice_more_little`: `readinessGainBound(…) < READINESS_LITTLE`.

- [ ] **Step 1: Write failing tests:** schema round-trips the new keys; `openapi.test.ts` pins them; `targets.test.ts`: a homework word that cannot be said is counted on write and spell only and is not 0 (Review Focus 1); `ready_count` counts 90 and above; `today.state` is `done` when the budget is met with a word still owed, and `owed` before; `ended_early` when no word is owed after 3 of 5; `readiness_start_pct` reads the first events' `before`; `practice_more_little` false on a day with first tries left, true when every skill has had its first try and both bonuses.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** the schemas, `API_LEVEL = 6`, and `view()`.
- [ ] **Step 4: Run** `npm test`, `npm run test:integration`, `npm run typecheck`, `npm run lint:arch` — PASS (the app's typecheck may fail on the changed `skills` shape until Task 6; if so, make the smallest app type fix that keeps it compiling and leave behaviour to Task 6).
- [ ] **Step 5: Commit** — `feat(api): phase 65 readiness and today's budget on the target summary (API level 6)`.

---

### Task 5: The day simulation

**Files:**
- Modify: `apps/server/src/domain/day.test.ts`

**Interfaces:**
- Consumes: core's readiness functions (Task 1), `readinessSessionWrite` (Task 2), `playTodayForward`/`budgetSessions` (Task 3).

- [ ] **Step 1: Rename** the phase 57 measures that say "readiness" (100% on the eve, the 2026-10-16 replay's "ready", the 3-day exam's "100% only on the eve") so their names say "plan" or "target skills"; their assertions do not change. `READY_ON_DUE_PASS` stays a gate, unchanged.
- [ ] **Step 2: Keep the learner playing past the budget** (spec D11): the simulated learner's day still ends when no target reads `owed` in the plan (`TargetDay.state`), which is already "practise past the budget until no work is owed". Add, per target day, the budget (`budgetSessions(playTodayForward(…), missRateOf(recent))`) computed before its first session, and report (console table like the file's other reports, not gated) the share of days on which the sessions played were ≤ the budget, and the eves on which they were not.
- [ ] **Step 3: Readiness measures, gated:** run `readinessSessionWrite` over every simulated session end and assert, in every scenario: readiness (`readinessPct` over the target's words) never changes between the last session of a day and the first of the next; never drops across a session whose answers about the target were all right; the day's budget is computed once.
- [ ] **Step 4: The anti-goal scenario:** an exam, 10 words, due in 5 days, a learner who answers right except the first try of the same two skills (two words' `written_productive`) on each of the last two days before the date → readiness on the date < 90.
- [ ] **Step 5: Report** readiness on the due date beside the FSRS share in each scenario's report (not gated).
- [ ] **Step 6: Run** `npx jest apps/server/src/domain/day.test.ts` — PASS; if a phase 57 gate moved, run `EVERY_PHASE` on master's code and the branch and compare aggregates (memory: never lower a mark). **Step 7: Commit** — `test(server): phase 65 day simulation — readiness never moves overnight, the budget is set once`.

---

### Task 6: The target card

**Files:**
- Modify: `apps/mobile/src/targets.ts`, `apps/mobile/src/components/TargetCard.tsx`, `apps/mobile/src/strings.ts`
- Test: `apps/mobile/src/targets.test.ts`

**Interfaces:**
- Consumes: the Task 4 wire fields.
- Produces (pure, `targets.ts`):
  ```ts
  export function readinessBar(t: TargetSummary): { start: number; gain: number; label: string | null }; // gain may be < 0
  export function sessionDots(t: TargetSummary): ('done' | 'todo' | 'faded' | 'bonus')[];
  export function sessionsLine(t: TargetSummary): { text: string; side: string | null }; // "היום: 3 מתוך 5 תרגולים" / "עוד 2"
  ```
- Copy (`strings.ts`; placeholders from the mockup, finish the wording in Hebrew):
  - big number label: `'מוכנות'` + `TARGET_FOR[kind]` ("לשיעורי הבית", "לבוחן"); gain: `` `+${n}% היום` `` (bright), a lower day `` `−${n}% היום` `` in grey, none before any answer today.
  - today: `'היום: ${done} מתוך ${budget} תרגולים'`, side `'עוד ${left}'`; before the first session `'היום: ${offer} תרגולים'`, side `'כ-${minutes} דקות'`; met `'סיימת להיום ✓'`; early `'${done} במקום ${budget}'`; past the budget `'+${extra} בונוס'`.

- [ ] **Step 1: Failing tests** in `targets.test.ts`: the bar's parts for 70 → 83 (`{ start: 70, gain: 13, label: '+13% היום' }`), for no answer today (`label: null`), for 74 → 70 (grey `−4% היום`); dots for 3 of 5 (`done×3, todo×2`), for ended early after 4 of 5 (`done×4, faded`), for 6 done of 5 (`done×5, bonus`); `sessionsLine` for each; `readinessName` says "מוכנה" at 90; R9's outlined rule and `urgencyOf` read `ready_count === word_count` (90 per word); `withoutWord` decrements `ready_count` for a word at ≥ 90; `targetButtonSolid` is solid on `due_today` until every word is ready.
- [ ] **Step 2: Run** `npm test -w apps/mobile -- targets` — FAIL. **Step 3: Implement** the helpers and the copy.
- [ ] **Step 4: Redraw `TargetCard.tsx`** as `card-approved.html` (main checkout `.superpowers/brainstorm/86053-1792407295/content/`): under the header, the big readiness in `readinessColor`, its label beside it, then the bar (pale start, bright gain at its end, label only when there is one), then the sessions line and dots (green done, grey to do, dashed faded, blue bonus), then the button. Keep testIDs that e2e uses; add `target-readiness-big`, `target-readiness-gain`, `target-sessions`, `target-session-dot`.
- [ ] **Step 5: Run** `npm test -w apps/mobile`, `npm run typecheck -w apps/mobile` — PASS. **Step 6: Commit** — `feat(mobile): phase 65 the target card — readiness first, today's gain on its bar, today as a budget`.

---

### Task 7: The target screen's words

**Files:**
- Modify: `apps/mobile/src/app/targets/[id].tsx`, `apps/mobile/src/targets.ts`, `apps/mobile/src/strings.ts`
- Test: `apps/mobile/src/targets.test.ts`

- [ ] **Step 1: Failing tests:** the word pill shows its `readiness_pct` and "מוכנה" at ≥ 90; the skills panel lists the counted skills in order with `chance` out of 100 and, for `held`, the note `'חצי עד שתענה נכון מחר'`; no cap line or 0–10 value remains.
- [ ] **Step 2–3: Implement** the pill and the panel (bars out of 100, `strings.dimensionName`, green at ≥ 90). The groups (`screenGroups`) and the header's reuse of `targetCardState` stay; the header shows Task 6's big readiness, bar and sessions line.
- [ ] **Step 4: Run** the app's tests and typecheck — PASS. **Step 5: Commit** — `feat(mobile): phase 65 the target screen reads each word's chance and its skills`.

---

### Task 8: The "practice more" sheet and its setting

**Files:**
- Create: `apps/mobile/src/practiceMoreAsk.ts` (an AsyncStorage store built like `createRememberedEnrollmentStore` in `apps/mobile/src/currentUser.ts`, key per username), `apps/mobile/src/components/PracticeMoreSheet.tsx`
- Modify: `apps/mobile/src/components/LearningSection.tsx` (`practiceTarget`), `apps/mobile/src/app/(tabs)/settings.tsx` (a switch), `apps/mobile/src/app/_layout.tsx` (inject the store), `apps/mobile/src/strings.ts`
- Test: `apps/mobile/src/practiceMoreAsk.test.ts`, the pure decision in `targets.ts` with its test

**Interfaces:**
- Produces: `createPracticeMoreAskStore(storage, prefix) → { shouldAsk(username): Promise<boolean>; stopAsking(username): Promise<void>; askAgain(username): Promise<void> }` (reads/writes wrapped so a storage failure means "ask"); `askBeforePracticeMore(t: TargetSummary, optedOut: boolean): boolean` = `t.today.state === 'done' && t.practice_more_little && !optedOut`.
- Copy: title `'סיימת את התרגול של היום'`; body `'עוד תרגול היום יעלה את המוכנות רק מעט. מחר, אחרי לילה, התרגול יעזור הרבה יותר.'` (no number, Victor); main button `'אחזור מחר'` (closes); secondary `'לתרגל בכל זאת'` (starts the session); tick box `'אל תציג לי את זה שוב'` (applies to both buttons); settings switch `'לשאול לפני תרגול נוסף'`.

- [ ] **Step 1: Failing tests:** the store (default asks; `stopAsking` then `shouldAsk` → false; `askAgain` → true; a throwing storage → asks); `askBeforePracticeMore` true only for `done` + `practice_more_little` + not opted out (false on `owed`, on `due_today`, when not little).
- [ ] **Step 2–3: Implement** the store, the sheet (a bottom-sheet `Modal`, the look of `practice-more-confirm.html`), the call in `practiceTarget` before `create`, and the switch in הגדרות. testIDs: `practice-more-sheet`, `practice-more-anyway`, `practice-more-later`, `practice-more-stop-asking`, `settings-practice-more-ask`.
- [ ] **Step 4: Run** the app's tests and typecheck — PASS. **Step 5: Commit** — `feat(mobile): phase 65 ask before practising past the day's budget`.

---

### Task 9: e2e

**Files:**
- Modify: `e2e/tests/targets.spec.ts`, `e2e/tests/photo-import.spec.ts`; add `e2e/tests/practice-more.spec.ts` if the flow does not fit `targets.spec.ts`

- [ ] **Step 1:** Update every assertion on readiness labels (`targets.spec.ts` around :293-320, :446-447, :502-507, :548-555; `photo-import.spec.ts:176`) to the new card: the big readiness, the bar, the sessions line.
- [ ] **Step 2:** Add: a target whose budget is met (play its sessions with the existing helpers) shows "סיימת להיום ✓"; "לתרגל עוד" opens `practice-more-sheet` when `practice_more_little`; "לתרגל בכל זאת" starts a session; with the tick box set the next tap starts the session directly; the הגדרות switch brings the sheet back.
- [ ] **Step 3: Run** `npm run e2e -- tests/targets` (path filter, not a bare word) and the new spec — PASS; then the whole `npm run e2e`. Remove `e2e/test-results` afterwards.
- [ ] **Step 4: Run** `npm test`, `npm run test:all`, `npm run lint:arch` — all PASS. **Step 5: Commit** — `test(e2e): phase 65 the readiness card, the session budget and the practice-more sheet`.
