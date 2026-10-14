# Phase 53 — Prepare for homework or a בוחן: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Targets (a kind, a due date, saved words) that sessions serve — target words first, then a share set by readiness for the date, the kind and the days left — created through a wizard in the app.

**Architecture:** Pure rules in `apps/server/src/domain/targets.ts` (readiness, wish, split, pace) and `domain/targetSession.ts` (one call that splits a session between targets and the main path by running the existing picker over several pools with shared state). The session service feeds it and records the split; a targets service owns the CRUD and the wire; the app adds a home block, a wizard and a target screen.

**Tech Stack:** TypeScript, Hono + `@hono/zod-openapi`, Drizzle (Postgres), pg-boss, Jest; Expo Router (React Native, web build for e2e), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-lang-tutor-phase-53-targets-design.md` (read its D1–D13 before your task). Rulings that amend it are in the "Rulings against the spec" section below and bind you.

## Global Constraints

- Work only in `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-53-targets`. Every shell command starts with `cd /Users/victorprp/git/lang-tutor/.claude/worktrees/phase-53-targets && …`. Never read, write or run anything in `/Users/victorprp/git/lang-tutor` itself (the main checkout). Never use `git stash`.
- All lanes are taken, so this worktree has no `.lane`: run unit tests (`npx jest --selectProjects=unit --runTestsByPath <files>` from `apps/server`; `npx jest <files>` from `apps/mobile` or `packages/core`), `npm run typecheck` in the workspace you touched, and `./scripts/check-adrs.sh` from the root. Do NOT run `npm run e2e`, `npm run test:integration`, `npm run server`, `npm run mobile` or any `db:` script: write integration and e2e tests, CI runs them.
- The shell guard refuses any command containing the word "eval" (also inside commit messages): commit with `git commit -F <message file in /private/tmp/claude-501/-Users-victorprp-git-lang-tutor/a50318b9-1b5a-47c9-93e6-d5c28db97f1f/scratchpad/>`. Heredocs must not contain `${` or backticks.
- Commit messages: `feat(server): … (phase 53)` style, ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Kinds: `homework` | `exam` (Hebrew: שיעורי בית | בוחן). Readiness labels: `not_started` עוד לא התחלנו, `on_the_way` בדרך, `almost` כמעט מוכנה, `ready` מוכנה.
- Readiness thresholds: homework almost ≥ 0.6, ready ≥ 0.8; exam almost ≥ 0.7, ready ≥ 0.9.
- Wishes (out of `SESSION_LENGTH` = 10): exam with 1 day left → 10, exclusive; exam with 2 days left → 10; not all ready → 10; all ready → homework 3, exam 5; homework with 1 day left → 7 (10 if not all ready). The wish is the highest that applies.
- A target is active while `today < due_on` and `ended_at` is null; `today` comes only from `learnerDay(repos, enrolled.user_id, now())` (ADR 0013). `daysLeft = daysBetween(today, due_on)`.
- One speaking pick per session (`SPEAKING_PER_SESSION`), as today.
- No `API_LEVEL` change: every wire change is additive.
- ADRs bind: 0001 (domain is pure; no `../` imports in `domain/`, tests included), 0002 (no `jest.mock`), 0003 (every route `createRoute` + `.openapi()`, schemas only in `@lang-tutor/core/api/schemas`, types only `z.infer`), 0006 (no hardcoded ports or database names), 0011 (learner tables reference `dict_glosses`, never `dict_senses`/`dict_var_translations`), 0013 (only `learnerDay` computes a day).
- App strings are Hebrew in `apps/mobile/src/strings.ts`; every number is wrapped in `isolateLtr`.
- Never lower a threshold to make a test pass.

## Rulings against the spec (bind every task)

- **R-D9 One import per photo.** The 3 MB request cap and the all-or-nothing reading job make one import of several photos a rewrite. Instead the app uploads each photo as its own import (today's endpoint, unchanged) and the target endpoints take `photo_import_ids`. Rows that resolve to the same gloss across those imports are one row: the first (import order, then position) decides, by `firstRowPerGloss` in `packages/core` used by both the app's review and the server's save. A failed import contributes nothing and counts as a photo not read.
- **R-D7 Pace is a floor, not a cap.** A target's run may introduce `max(owedNew, DAY_NEW_CAP − new words met today so far)` new words, where `owedNew = max(0, ceil((unmet + metToday) / max(1, daysLeft − 1)) − metToday)`. The even spread alone would let a 14-day list introduce 2 words a day and hand 8 of every 10 slots to the main path.
- **R-D6 Pools with shared state.** `chooseWords` becomes `choosePools(input, pools)`: one call, several pools in order, sharing the picked glosses, keys, families, family claims, per-dimension and hard counts, new-word count and the speaking pick. A pool that makes no speaking pick passes it on. Ruling 15 (new words past the cap) fires only when the whole session is empty.
- **R-D4 Speakable.** Readiness skips `spoken_productive` for a gloss that is not speakable (`speakable(form)` from core), as phase 46's known rule does.
- **R-D12 The stale check runs where home learns of the stock** (`currentSession` and `createNextSession`), not at start: the app ignores start's reply, and older apps and bots start by answering. Sessions get `chosen_on` (the learner day the words were chosen). Retiring a stock = `status 'skipped'` with no `practice_day`, only for an unstarted `list` stock, logged `session_retired`.
- **R-D12b A target change retires the unstarted list stock and requests a new one** through the stock job (`requestStock`, new reason `'target'`), in the change's transaction.
- **R-D10 Creating a target needs at least one word**; removing words later may empty it (an empty target gives its slots to the main path).
- **R-D11 Word display:** `form` = the saved form (`SavedGloss.form`), `meaning` = the gloss key (`SavedGloss.key`, the learner-language word).

## Review Focus

1. A gloss merge while a target holds the merged-away gloss: the target keeps the word under the survivor, no duplicate key, no lost row (Task 4).
2. Unsaving a word that is in a target: it leaves every target, with a `words_removed` event (Task 6).
3. A target change racing a start: only an unstarted `list` stock is retired; a started session or a seed is never touched (Tasks 5, 6).
4. Create/add with photo imports that are still reading, saved, discarded, failed or another enrollment's: refused, except a failed import, which is skipped (Task 6).
5. A due date on or before the learner's today (a bot's day included) is refused on create and on change (Task 6).

---

### Task 1: Target rules (pure)

**Files:**
- Create: `apps/server/src/domain/targets.ts`, `apps/server/src/domain/targets.test.ts`
- Modify: `apps/server/src/domain/chooseConstants.ts` (append the constants below)

**Interfaces — Produces:**

```ts
// chooseConstants.ts — appended, each with a doc comment "Phase 53 (spec D4/D5). …"
export const TARGET_READY = { homework: 0.8, exam: 0.9 } as const;
export const TARGET_ALMOST = { homework: 0.6, exam: 0.7 } as const;
export const TARGET_STEADY_SLOTS = { homework: 3, exam: 5 } as const;
export const HOMEWORK_LAST_DAY_SLOTS = 7;
export const EXAM_RUN_UP_DAYS = 2;

// targets.ts
export const TARGET_KINDS = ['homework', 'exam'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
export const READINESS = ['not_started', 'on_the_way', 'almost', 'ready'] as const;
export type Readiness = (typeof READINESS)[number];
export type ShareReason = 'exclusive' | 'run_up' | 'not_ready' | 'steady';

/** Chance of remembering the gloss on dueOn in its weakest skill: min over the
 *  live skills (without spoken_productive when !speakable) of
 *  retrievability(state, dueOn), a skill with no row counting 0. Null when the
 *  gloss has no memory row at all: not met. */
export function recallOnDue(
  rows: readonly { dimension: Dimension; state: MemoryState }[],
  live: readonly Dimension[],
  speakable: boolean,
  dueOn: string,
): number | null;

export function readinessOf(kind: TargetKind, recall: number | null): Readiness;
// null → not_started; ≥ TARGET_READY[kind] → ready; ≥ TARGET_ALMOST[kind] → almost; else on_the_way

export function targetWish(kind: TargetKind, daysLeft: number, allReady: boolean): { wish: number; exclusive: boolean; reason: ShareReason };

export type SplitInput = { targetId: string; dueOn: string; wish: number; exclusive: boolean };
/** Spec D6. Any exclusive: the exclusive ones share `total` evenly, the rest 0.
 *  Else wishes summing to ≤ total are granted; else proportional by largest
 *  remainder. Every tie (remainder, even share) goes to the nearer dueOn, then
 *  the smaller targetId. Every input id is a key of the result. */
export function splitSlots(wishes: readonly SplitInput[], total: number): Map<string, number>;

/** Ruling R-D7: new words this target still owes today to be fully met before its last day. */
export function owedNew(unmet: number, metToday: number, daysLeft: number): number;
```

`targetWish` exactly:

```ts
export function targetWish(kind: TargetKind, daysLeft: number, allReady: boolean) {
  if (kind === 'exam') {
    if (daysLeft <= 1) return { wish: SESSION_LENGTH, exclusive: true, reason: 'exclusive' as const };
    if (daysLeft <= EXAM_RUN_UP_DAYS) return { wish: SESSION_LENGTH, exclusive: false, reason: 'run_up' as const };
  }
  if (!allReady) return { wish: SESSION_LENGTH, exclusive: false, reason: 'not_ready' as const };
  if (kind === 'homework' && daysLeft <= 1) return { wish: HOMEWORK_LAST_DAY_SLOTS, exclusive: false, reason: 'run_up' as const };
  return { wish: TARGET_STEADY_SLOTS[kind], exclusive: false, reason: 'steady' as const };
}
```

`owedNew` exactly: `const days = Math.max(1, daysLeft - 1); return Math.max(0, Math.ceil((unmet + metToday) / days) - metToday);`

Imports: `retrievability`, `SESSION_LENGTH`, `Dimension`, `MemoryState` from `@lang-tutor/core/domain`; constants from `./chooseConstants`.

- [ ] **Step 1: Write the failing tests** in `targets.test.ts` (import from `@jest/globals`; build `MemoryState` literals with `params: 'fsrs6-default'` and an explicit `lastDay`):
  - `recallOnDue`: no rows → `null`; a live skill with no row → `0`; `spoken_productive` ignored when `speakable` is false and counted when true; a dueOn on or before every `lastDay` → `1`; returns the minimum over live skills (two rows with different stability → the weaker one's retrievability).
  - `readinessOf`: exam 0.9 → ready, 0.8999 → almost, 0.7 → almost, 0.6999 → on_the_way, null → not_started; homework 0.8 → ready, 0.6 → almost, 0.5999 → on_the_way.
  - `targetWish` table: exam/1/false → 10 exclusive; exam/1/true → 10 exclusive; exam/2/true → 10 run_up; exam/5/false → 10 not_ready; exam/5/true → 5 steady; homework/1/false → 10 not_ready; homework/1/true → 7 run_up; homework/5/true → 3 steady.
  - `splitSlots`: `[3, 5]` → 3, 5; `[10, 10]` → 5, 5; `[10 (due 2026-10-20), 3 (due 2026-10-25)]` → 8, 2; three of 10 → 4, 3, 3 with the 4 to the nearest due; one exclusive + one 3 → 10, 0; two exclusive → 5, 5; `[]` → empty map.
  - `owedNew`: (20, 0, 14) → 2; (20, 0, 2) → 20; (20, 0, 1) → 20; (5, 3, 3) → 1; (0, 0, 5) → 0; (10, 10, 4) → 0.
- [ ] **Step 2: Run** `cd …/apps/server && npx jest --selectProjects=unit --runTestsByPath src/domain/targets.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `targets.ts` and the constants.
- [ ] **Step 4: Run** the test again (PASS), then `npm run typecheck` in `apps/server` and `./scripts/check-adrs.sh`.
- [ ] **Step 5: Commit** `feat(server): target rules — readiness, wish, split, pace (phase 53)`.

---

### Task 2: The picker over pools, and a session with targets

**Files:**
- Modify: `apps/server/src/domain/choose.ts`
- Create: `apps/server/src/domain/targetSession.ts`, `apps/server/src/domain/targetSession.test.ts`
- Test (must pass unchanged): `apps/server/src/domain/choose.test.ts`, `apps/server/src/domain/day.test.ts`

**Interfaces — Consumes:** Task 1's `recallOnDue`, `readinessOf`, `targetWish`, `splitSlots`, `owedNew`, `TargetKind`, `ShareReason`.

**Interfaces — Produces:**

```ts
// choose.ts
export type Pool = {
  /** The glosses this pool may pick; null: every saved gloss no other pool lists (the main path). */
  glossIds: ReadonlySet<string> | null;
  /** Picks this pool aims for; what it leaves unpicked passes to the next pool. */
  slots: number;
  /** Ruling R-D7: new words this pool may introduce whatever the daily cap says (a target's pace); 0 for the main path. */
  owedNew: number;
};
/** One call per session. Returns each pool's picks, in pool order. */
export function choosePools(input: ChoiceInput, pools: readonly Pool[]): ChosenPick[][];
/** Unchanged signature and behaviour: choosePools(input, [{ glossIds: null, slots: SESSION_LENGTH, owedNew: 0 }])[0]. */
export function chooseWords(input: ChoiceInput): ChosenPick[];

// targetSession.ts
export type ActiveTarget = { id: string; kind: TargetKind; dueOn: string; glossIds: readonly string[] };
export type TargetSessionInput = {
  choice: ChoiceInput;                          // saved = every saved gloss, as today
  targets: readonly ActiveTarget[];             // active on choice.today; glossIds ⊆ saved
  speakable: ReadonlyMap<string, boolean>;      // per saved gloss id
  introducedToday: ReadonlySet<string>;         // glosses first met on choice.today
};
export type TargetSplit = {
  targetId: string; wish: number; slots: number; picked: number;
  reason: ShareReason; daysLeft: number; readyCount: number; wordCount: number;
};
export function chooseWithTargets(input: TargetSessionInput): { picks: ChosenPick[]; split: TargetSplit[] };
/** The split alone (no picking): what D12's stale check compares. */
export function targetSplit(input: TargetSessionInput): TargetSplit[]; // picked = 0
```

**`choosePools` — how today's `chooseWords` body becomes per pool (keep every existing comment that still applies):**
- Before the pools: compute `live`, `memory`, `levels`, `steps`/`waiting` and ALL candidates exactly as today, and the family `claims` from every return across all pools (session-wide, so a family's claiming return keeps priority whichever pool holds it).
- Session-wide state, created once: `taken` (gloss ids), `keys`, `pickedFamilies`, `perDimension`, `hard`, `newCount`, `spoken` (speaking picks made).
- For each pool in order, with `carry` (slots the previous pools left): its candidates are the candidates whose gloss is in `pool.glossIds` (for `null`: in no other pool's `glossIds`) and that are `free` now. `n = Math.min(pool.slots + carry, groups among those candidates)` (the union-find count, over this pool's free candidates only). `newLeft = Math.max(pool.owedNew, Math.max(0, DAY_NEW_CAP - (input.newToday + newCount)))`. `speak = input.speaking && n >= 2 ? Math.max(0, SPEAKING_PER_SESSION - spoken) : 0`. `room` and `reserve` as today from this pool's lists. Steps 1–9 as today, over this pool's class lists, with `picks.length` read as this pool's pick count. Step 10 (ruling 15) only in the last pool and only when no pool picked anything. `carry = pool.slots + carry - poolPicks.length`.
- With one pool `{ glossIds: null, slots: SESSION_LENGTH, owedNew: 0 }` the result must equal today's for every input: `choose.test.ts` and `day.test.ts` pass with no edit.

**`chooseWithTargets`:** `live = liveDimensions(listening, speaking)`. Per target: `daysLeft = daysBetween(today, dueOn)` (from `./progress`); per word `recallOnDue(rows of that gloss, live, speakable.get(id) ?? true, dueOn)` → `readinessOf`; `readyCount`, `wordCount`, `allReady = readyCount === wordCount`; `targetWish`. `splitSlots(wishes, SESSION_LENGTH)`. Pools: targets ordered by `dueOn`, then `id`, each `{ glossIds: new Set(target.glossIds), slots, owedNew: owedNew(unmet, metToday, daysLeft) }` where `unmet` = its words with no memory row and `metToday` = its words in `introducedToday`; then the main pool `{ glossIds: null, slots: SESSION_LENGTH - Σ slots, owedNew: 0 }`. `picks` = the pools' picks concatenated in pool order; `split` per target with `picked` = its pool's pick count. No targets → exactly `chooseWords(choice)`.

- [ ] **Step 1: Write failing tests** in `targetSession.test.ts` (reuse the builder style of `choose.test.ts`: copy what you need locally — ADR 0001 R3 forbids importing from a sibling test). Cases:
  1. No targets: `chooseWithTargets({ choice, targets: [], … }).picks` deep-equals `chooseWords(choice)` for three different inputs (fresh list, list with due words, list with returns), and `split` is `[]`.
  2. An exam due in 10 days whose 20 words are all unmet, beside 30 known main words: all 10 picks are target words; split `{ reason: 'not_ready', slots: 10, picked: 10, readyCount: 0, wordCount: 20 }`.
  3. The same exam with every word ready (memory states with high stability, `lastDay` = today): 5 target picks, 5 main; reason `steady`.
  4. That exam with 1 day left, plus a homework target: exam gets 10 (`exclusive`), homework 0 slots and 0 picks.
  5. A target of 3 words wishing 10: 3 target picks, 7 main (hand-off).
  6. One gloss in two targets: picked once; it counts in both targets' `wordCount`.
  7. Speaking on; the target's words all unmet; the main words have memory in every live skill but `spoken_productive`: exactly one pick has `cls === 'SPEAK'`, and it is a main word (the target pool, all NEW, could not make it and passed it on).
  8. A target word and a main word in one family (`families.familyOf`): never both in one session.
  9. Pace: exam due in 2 days, 20 unmet, `newToday` = 15 (cap spent): the target pool still introduces new words (10 `NEW` picks); the main pool introduces none.
  10. Shared cap: an exam due in 20 days with 10 unmet words (`owedNew` = 1) and `newToday` = 13 (2 left under `DAY_NEW_CAP`), beside main words that include 5 unmet ones: the session has exactly 2 `NEW` picks, both target words (the target pool spent the cap; the main pool's `newLeft` is 0).
- [ ] **Step 2: Run** `npx jest --selectProjects=unit --runTestsByPath src/domain/targetSession.test.ts` — FAIL.
- [ ] **Step 3: Refactor `choose.ts`** to `choosePools` + the `chooseWords` wrapper; run `choose.test.ts` and `day.test.ts` — both PASS untouched.
- [ ] **Step 4: Implement `targetSession.ts`**; run all three test files — PASS.
- [ ] **Step 5:** typecheck, `./scripts/check-adrs.sh`; commit `feat(server): the picker runs pools with shared state; a session splits between targets and the main path (phase 53)`.

---

### Task 3: The day simulation with targets (the done-means)

**Files:** Modify `apps/server/src/domain/day.test.ts` (and `day.fixture.ts` only if a fixture is cleaner there).

**Interfaces — Consumes:** `chooseWithTargets`, `ActiveTarget`, `TargetSplit` (Task 2); `recallOnDue`, `readinessOf` (Task 1).

- [ ] **Step 1: Extend `runDays`** with an optional `targetsOn?: (day: number, date: string) => ActiveTarget[]`. When given, each session calls `chooseWithTargets({ choice: input, targets: targetsOn(day, date).filter(active on date), speakable: all true, introducedToday: introduced })` instead of `chooseWords(input)`, and stores `split` on the `Session`. Without it, behaviour is unchanged (every existing describe passes untouched).
- [ ] **Step 2: A list for the scenarios:** `LANE0_DAY`'s saved glosses, memory and progress as the main path, plus 20 synthetic target glosses (`t01`…`t20`, distinct keys, no families, saved on day 0, no memory). Six sessions a day, `MISS_EVERY` = 5.
- [ ] **Step 3: One describe per scenario** (spec §2), each asserting day by day from the recorded `split` and picks (`day = Math.floor(at / count)`):
  1. Exam due in 14 days: every target word met before the last day (has memory before the first session with `daysLeft` 1); every session whose split reason is `not_ready` has 10 target picks; every `steady` session has exactly 5 (when the target has ≥ 5 free words); `daysLeft` 2 → 10 target picks; `daysLeft` 1 → 10 target picks and `exclusive`; from the due date on, no split and no target-only session. The test also asserts at least one `steady` session occurs; if none does in 14 days, STOP and report BLOCKED with, per day, the ready count — the controller rules on it.
  2. Homework, same list and date: `steady` sessions have 3 target picks; `daysLeft` 1 with all ready → 7.
  3. Exam due in 4 days: every session before the due date is all target; every word met before the last day.
  4. Homework due in 10 days and an exam due in 6 days, overlapping words disjoint: each session's target slots follow `splitSlots` of the recorded wishes; the exam's `daysLeft` 1 day has 10 exam picks and 0 homework picks.
  5. Exam due in 6 days whose date moves to day 10 on day 2, and 5 words added on day 3: after each change the pace (`NEW` target picks per day) follows `owedNew` for the new numbers, and every word is met before the new last day.
  6. In every scenario: no session holds two glosses of one family (`expectOneGlossPerFamily`); at most one speaking pick per session; on the days after the due date, main-path due words are picked again.
- [ ] **Step 4: The ready share on the due date.** For scenarios 1 and 2, compute after the last session before the due date the share of target words with `readinessOf(kind, recallOnDue(…, dueOn)) === 'ready'`. Print it once in the test name (e.g. `ready on the due date: 0.85 (pass ≥ 0.80)`) and assert it is ≥ a constant `READY_ON_DUE_PASS` set to the measured value rounded DOWN to the nearest 0.05, with the comment `// Measured 2026-10-14: <value>. Never lowered to let a change pass (spec §2).` Report the measured values in your report.
- [ ] **Step 5:** Run `npx jest --selectProjects=unit --runTestsByPath src/domain/day.test.ts` (PASS, report the run time), typecheck; commit `test(server): the day simulation runs targets — the phase 53 scenarios (phase 53)`.

---

### Task 4: Storage — tables, migration, repo, merges

**Files:**
- Modify: `apps/server/src/db/schema.ts` (four tables + `sessions.chosen_on`), `apps/server/src/repo/sessions.ts`, `apps/server/src/repo/glosses.ts` (`mergeGlosses`, `MergeCounts`), `apps/server/src/services/transaction.ts` (`Repos`), `apps/server/src/composition.ts` (`bindRepos`), `apps/server/tests/support/fakes.ts` (`createFakeTransaction`: a `target` repo whose default `listActive` returns `[]`, `findSessionSplit` returns `[]`, `listEndedUnrecorded` returns `[]`, and the write methods are no-ops that record their arguments; every other method `unreachable`)
- Create: `apps/server/src/repo/targets.ts`, migration via drizzle-kit, `apps/server/tests/integration/repo/targets.test.ts`
- Modify test: `apps/server/tests/integration/repo/glosses.merge.test.ts` (a target case)

**Tables** (Drizzle, following the existing style: named FKs and checks, `timestamp(..., { withTimezone: true })`, `date(..., { mode: 'string' })`):
- `targets`: `id` uuid pk defaultRandom; `enrollment_id` text not null, FK `targets_enrollment_fk` → `enrollments.id`; `kind` text not null, check `targets_kind_known` in ('homework','exam'); `due_on` date not null; `created_at` timestamptz not null default now(); `ended_at` timestamptz null. Index `targets_enrollment_due_idx (enrollment_id, due_on)`.
- `target_words`: `target_id` uuid not null FK `target_words_target_fk` → `targets.id` on delete cascade; `gloss_id` text not null FK `target_words_gloss_fk` → `dict_glosses.id`; `added_at` timestamptz not null default now(); PK `target_words_pkey (target_id, gloss_id)`; index `target_words_gloss_idx (gloss_id)`.
- `target_events`: `id` uuid pk defaultRandom; `target_id` uuid not null FK → `targets.id` on delete cascade; `kind` text not null, check in ('created','words_added','words_removed','date_changed','ended_early','ended_on_date'); `before` jsonb null; `after` jsonb null; `actor_user_id` text null; `session_id` uuid null; `created_at` timestamptz not null default now(). Index `(target_id, created_at)`.
- `session_targets`: `session_id` uuid not null FK → `sessions.id` on delete cascade; `target_id` uuid not null FK → `targets.id` on delete cascade; `wish`, `slots`, `picked`, `days_left`, `ready_count`, `word_count` integer not null; `reason` text not null, check in ('exclusive','run_up','not_ready','steady'); PK `(session_id, target_id)`.
- `sessions.chosen_on` date null (Phase 53 comment: the learner day its words were chosen; null for a seed and for sessions before this phase).

Generate: `cd …/apps/server && npx drizzle-kit generate --name targets`; then `npm run db:check` is NOT runnable here (no lane) — check by eye that the SQL creates exactly the above, nothing else.

**`repo/targets.ts` — `createTargetRepo(tx: Tx)`, `export type TargetRepo = ReturnType<typeof createTargetRepo>`, bound as `repos.target` (the `Repos` key is `target`):**

```ts
export type TargetRow = { id: string; enrollmentId: string; kind: TargetKind; dueOn: string; createdAt: Date; endedAt: Date | null };
export type TargetEventInput = {
  targetId: string;
  kind: 'created' | 'words_added' | 'words_removed' | 'date_changed' | 'ended_early' | 'ended_on_date';
  before: unknown | null; after: unknown | null; actorUserId: string | null; sessionId: string | null;
};
insertTarget(row: { enrollmentId: string; kind: TargetKind; dueOn: string }): Promise<TargetRow>
findTarget(id: string): Promise<TargetRow | null>            // null for a non-uuid id
findTargetForUpdate(id: string): Promise<TargetRow | null>   // FOR UPDATE
listActive(enrollmentId: string, today: string): Promise<(TargetRow & { glossIds: string[] })[]>  // due_on > today, ended_at null, by due_on, id
listWordIds(targetId: string): Promise<string[]>
addWords(targetId: string, glossIds: readonly string[]): Promise<string[]>   // ON CONFLICT DO NOTHING; returns the newly added
removeWord(targetId: string, glossId: string): Promise<boolean>
removeGlossFromTargets(enrollmentId: string, glossId: string): Promise<string[]>  // ids of the targets it left
setDueOn(id: string, dueOn: string): Promise<void>
end(id: string, at: Date): Promise<boolean>                  // only where ended_at is null
listEndedUnrecorded(enrollmentId: string, today: string): Promise<TargetRow[]>  // due_on <= today, ended_at null, no 'ended_on_date' event
insertEvent(event: TargetEventInput): Promise<void>
insertSessionSplit(sessionId: string, rows: readonly TargetSplit[]): Promise<void>
findSessionSplit(sessionId: string): Promise<TargetSplit[]>
```

**`repo/sessions.ts`:** `insertPreparingSession(userId, enrollmentId, devices, chosenOn: string)` writes `chosen_on`; new `findStockChoice(sessionId): Promise<{ chosenOn: string | null; listening: boolean; speaking: boolean } | undefined>`; new `retireStock(sessionId): Promise<boolean>` — `UPDATE sessions SET status = 'skipped' WHERE id = $1 AND status IN ('preparing','ready') AND started_at IS NULL AND source = 'list'` (no `practice_day`).

**`mergeGlosses`:** before the `vocabulary_entries` rewrite, for `target_words`: delete the merged-away gloss's row where the same target already holds the survivor, then `UPDATE target_words SET gloss_id = survivor WHERE gloss_id = merged`; count it in `MergeCounts.targetWords`.

- [ ] **Step 1:** Integration tests (written, run in CI): `repo/targets.test.ts` — the constraints (unknown kind refused; a gloss twice in one target refused by the key; cascade from targets), each repo method incl. `listActive` excluding ended and past-due targets and ordering, `listEndedUnrecorded`, `addWords` returning only new ids, `insertSessionSplit`/`findSessionSplit` round trip; `repo/sessions.test.ts` gains `retireStock` (unstarted list stock → true; started, seed, completed → false) and `chosen_on` written. `glosses.merge.test.ts` gains: a target holding the merged gloss → re-pointed; a target holding both → one row left.
- [ ] **Step 2:** Implement schema, migration, repos, `Repos`/`bindRepos`/fakes, the merge step.
- [ ] **Step 3:** `npm run typecheck` (server), the server unit project in full (`npx jest --selectProjects=unit` from `apps/server` — fakes changed), `./scripts/check-adrs.sh`.
- [ ] **Step 4:** Commit `feat(server): targets, their words, events and the session split are stored (phase 53)`.

---

### Task 5: The session service serves targets

**Files:**
- Modify: `apps/server/src/services/sessions.ts`, `apps/server/src/domain/jobs.ts` (`STOCK_REASONS` gains `'target'`)
- Test: `apps/server/src/services/sessions.stock.test.ts` (unit, fakes), create `apps/server/tests/integration/services/sessions.targets.test.ts`

**Interfaces — Consumes:** `chooseWithTargets`, `targetSplit` (Task 2); `TargetRepo`, `retireStock`, `findStockChoice`, `insertPreparingSession(…, chosenOn)` (Task 4).

- [ ] **Step 1: Failing unit tests** (`sessions.stock.test.ts` style, fakes): (a) with no active target, `stockNext`'s picks are unchanged and no split row is written; (b) with an active target, `insertSessionSplit` gets one row per target and `insertPreparingSession` gets `chosenOn` = today; (c) a target whose `due_on` ≤ today with no `ended_on_date` event gets one, naming the session; (d) `currentSession` with an unstarted list stock chosen yesterday whose recorded split differs from today's: the stock is retired (`retireStock` called), a new one stocked, `current` is the new preparing session, and `session_retired { reason: 'stale_split' }` is logged; (e) same but the split is equal: nothing retired (phase 43 R5); (f) a started session, a seed, or a stock with `chosen_on` null or = today: never retired; (g) `createNextSession` applies the same check before returning the stock.
- [ ] **Step 2: Implement.** Extract from `stockNext` a private `readChoice(repos, enrolled, devices)` returning everything `chooseWords` needs plus `today`, `at`, the active targets (`repos.target.listActive(enrolled.id, today)`), the `speakable` map (`speakable(gloss.form)`, already computed for families) and `introduced`. `stockNext` calls `chooseWithTargets`, then (after `insertPreparingSession(…, today)`) `insertSessionSplit(sessionId, split)` when non-empty and, for each `listEndedUnrecorded(enrollmentId, today)`, an `ended_on_date` event `{ before: null, after: { due_on }, actorUserId: null, sessionId }` and log `target_ended { target_id, how: 'on_date' }`. A private `replaceIfStale(repos, enrolled, stock)` implements R-D12: only for `stock.source === 'list'` and unstarted, with `chosenOn !== null && chosenOn < today`; compares `targetSplit(...)` by `targetId → slots` with `findSessionSplit(stock.id)`; if different, `retireStock` then `stockNext` with the stock's devices. `createNextSession` calls it under its lock before returning the stock; `currentSession` takes `lockNextSession` and calls it only when the cheap test (list, unstarted, `chosen_on < today`) holds.
- [ ] **Step 3: Integration test** `sessions.targets.test.ts` (CI): a learner with saved words and an active exam target — the stocked session's `session_targets` row exists and the session's `chosen_on` is the learner day; a stock whose split changed across a bot day change (`users.bot_day`, via the bots repo/route helpers the existing tests use) is replaced on the home read.
- [ ] **Step 4:** server unit project in full, typecheck, `./scripts/check-adrs.sh`; commit `feat(server): sessions serve targets and record their split; a stale stock is replaced (phase 53)`.

---

### Task 6: The targets service, and saving from imports and typed words in one transaction

**Files:**
- Create: `packages/core/src/domain/importRows.ts` (+ export from the core domain index) and `importRows.test.ts`; `apps/server/src/services/targets.ts`; `apps/server/src/services/targets.test.ts`; `apps/server/tests/integration/services/targets.test.ts`
- Modify: `apps/server/src/services/vocabulary.ts` (extract `saveEntriesInTx`; `unsave` removes the gloss from targets), `apps/server/src/services/photoImports.ts` (extract `saveImportsInTx`), `apps/server/src/domain/access.ts` (`'targets.manage'` in `PERMISSIONS`, in no role), `apps/server/src/errors.ts`, `apps/server/src/composition.ts` (`AppDeps.targets`), `apps/server/tests/support/fakes.ts` (`createFakeAppDeps` stub)

**Interfaces — Produces:**

```ts
// core importRows.ts — Ruling R-D9
/** Rows that resolve to the same gloss are one row: the first decides (import order, then position).
 *  A row whose gloss is null (not looked up yet, or failed) is always kept. */
export function firstRowPerGloss<T>(rows: readonly T[], glossOf: (row: T) => string | null): T[];

// services/vocabulary.ts
export async function saveEntriesInTx(repos: Repos, logger: Logger, input: {
  enrolled: Enrollment; actorUserId: string; entries: readonly VocabularyEntryInput[]; stockSaveDelaySeconds: number;
}): Promise<string[]>   // the saved gloss ids (resolved through merges), in order

// services/photoImports.ts
export async function saveImportsInTx(repos: Repos, logger: Logger, input: {
  enrolled: Enrollment; actorUserId: string; importIds: readonly string[]; now: number; stockSaveDelaySeconds: number;
}): Promise<{ glossIds: string[]; failedPhotos: number }>
// Each import: locked FOR UPDATE, must belong to `enrolled`; 'failed' → skipped and counted; 'read' with no pending row → its rows
// join; anything else (reading, saved, discarded, expired, another enrollment's) → PhotoImportConflict / PhotoImportNotFound as
// photoImports.save does today. Rows of all imports in order → firstRowPerGloss(by chosenGlossId) → entriesToSave → firstPerGloss
// → the same writes photoImports.save does; each read import transitions read → saved. photoImports.save becomes a call to it
// with one id (its behaviour, events and responses unchanged: its tests pass untouched).

// errors.ts
export class TargetNotFound extends Error { constructor(readonly targetId: string) }
export class InvalidTarget extends Error { constructor(readonly reason: 'due_date' | 'no_words') }
export class TargetClosed extends Error { constructor(readonly targetId: string) }

// services/targets.ts — createTargetService({ transaction, logger, now, stockSaveDelaySeconds })
list(actorUserId: string, enrollmentId: string): Promise<TargetList>
get(actorUserId: string, targetId: string): Promise<Target>
create(actorUserId: string, enrollmentId: string, request: CreateTargetRequest): Promise<Target>
addWords(actorUserId: string, targetId: string, request: AddTargetWordsRequest): Promise<Target>
removeWord(actorUserId: string, targetId: string, glossId: string): Promise<void>   // idempotent
changeDate(actorUserId: string, targetId: string, request: ChangeTargetDateRequest): Promise<Target>
end(actorUserId: string, targetId: string): Promise<void>                          // idempotent on an ended target
export type TargetService = ReturnType<typeof createTargetService>;
```

**Core wire schemas — add them in THIS task** to `packages/core/src/api/schemas.ts` (beside the vocabulary schemas), so the service compiles; Task 7 adds the routes:

```ts
export const TargetKindSchema = z.enum(['homework', 'exam']);
export const TargetReadinessSchema = z.enum(['not_started', 'on_the_way', 'almost', 'ready']);
export const LearnerDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const TargetSummarySchema = z.object({
  id: z.string(), kind: TargetKindSchema, due_on: LearnerDaySchema, days_left: z.number().int(),
  word_count: z.number().int(), ready_count: z.number().int(),
});
export const TargetListSchema = z.object({ today: LearnerDaySchema, targets: z.array(TargetSummarySchema) });
export const TargetWordSchema = z.object({ gloss_id: z.string(), form: z.string(), meaning: z.string(), readiness: TargetReadinessSchema });
export const TargetSchema = TargetSummarySchema.extend({ words: z.array(TargetWordSchema) });
export const TargetWordsInputSchema = z.object({
  photo_import_ids: z.array(z.string().min(1)).max(10),
  entries: z.array(VocabularyEntryInputSchema).max(50),
});
export const CreateTargetRequestSchema = TargetWordsInputSchema.extend({ kind: TargetKindSchema, due_on: LearnerDaySchema });
export const AddTargetWordsRequestSchema = TargetWordsInputSchema.refine(
  (body) => body.photo_import_ids.length + body.entries.length > 0, { message: 'nothing to add' });
export const ChangeTargetDateRequestSchema = z.object({ due_on: LearnerDaySchema });
```

Types in `types.ts` (`z.infer`) and the `export type` barrel in `index.ts`: `TargetKind`, `TargetReadiness`, `TargetSummary`, `TargetList`, `TargetWord`, `Target`, `CreateTargetRequest`, `AddTargetWordsRequest`, `ChangeTargetDateRequest`.

**Behaviour:**
- Every use case authorizes `'targets.manage'` (owner only) on the target's enrollment, in one `transaction`.
- `today = learnerDay(repos, enrolled.user_id, now())`. A `due_on` ≤ today → `InvalidTarget('due_date')`. A change, add, remove or end on a target that is not active (ended, or `due_on` ≤ today) → `TargetClosed` (except `end` on an already ended target: no-op).
- `create`: saves `saveImportsInTx` then `saveEntriesInTx`; the union of their gloss ids (import ones first, duplicates dropped) must be non-empty, else `InvalidTarget('no_words')`; `insertTarget`, `addWords`, event `created { after: { kind, due_on, gloss_ids } }`; then the stock rule below; log `target_created { enrollment_id, target_id, kind, word_count }` after commit.
- `addWords`: same saving; `addWords`; event `words_added { after: { gloss_ids: newly added } }` when any; log `target_changed { target_id, change: 'words_added', count }`.
- `removeWord`: `removeWord`; when it removed one, event `words_removed { before: { gloss_ids: [id] }, after: { reason: 'removed' } }`.
- `changeDate`: `setDueOn`, event `date_changed { before: { due_on }, after: { due_on } }`.
- `end`: `end(id, new Date(now()))`, event `ended_early`, log `target_ended { target_id, how: 'early' }`.
- **The stock rule (R-D12b)**, in every change's transaction: `lockNextSession(enrollmentId)`; `const { stock } = await repos.session.findOpen(enrollmentId)`; if `stock?.source === 'list'` and `retireStock(stock.id)`, log `session_retired { session_id, reason: 'target_changed' }`; then `requestStock(repos, { enrollment_id, reason: 'target' })`.
- `vocabulary.unsave`: after deleting the entry, `removeGlossFromTargets(enrollmentId, glossId)` and a `words_removed { before: { gloss_ids: [id] }, after: { reason: 'unsaved' } }` event per target it left.
- Read model (`list`/`get`): active targets only for `list` (`listActive`), any of the enrollment's targets for `get`. Per word: `form` and `meaning` from `vocabulary.listSavedGlosses` (R-D11); `readiness = readinessOf(kind, recallOnDue(memory rows, live, speakable(form), due_on))` with `live = liveDimensions` of `session.findNewestDevices(enrollmentId)` (both false when none); `ready_count` counts `ready`; `days_left = daysBetween(today, due_on)`; words ordered as added. `list` answers `{ today, targets }`, targets by `due_on`, then id.

- [ ] **Step 1:** `importRows.test.ts` (null gloss kept; second row of a gloss dropped; order kept). `services/targets.test.ts` with fakes: each behaviour bullet above, incl. Review Focus 2–5. Existing `vocabulary` and `photoImports` service tests pass untouched.
- [ ] **Step 2:** Implement (extract first, run the existing tests, then the new service).
- [ ] **Step 3:** Integration test `tests/integration/services/targets.test.ts` (CI): create from two seeded photo imports (`seedPhotoImport`) whose rows share a gloss + one typed entry → one target with the union, both imports `saved`, one `created` event; unsave → `words_removed`; a bot learner's `bot_day` decides `InvalidTarget('due_date')`.
- [ ] **Step 4:** core and server unit tests in full, typecheck (core, server), `./scripts/check-adrs.sh`; commit `feat(server): the targets service, saving photos and typed words with the target in one transaction (phase 53)`.

---

### Task 7: The wire — routes and contract

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `types.ts`, `index.ts`, `schemas.test.ts` (schemas may already exist from Task 6: add tests); `apps/server/src/app.ts` (mount); `apps/server/src/openapi.test.ts` (paths and statuses)
- Create: `apps/server/src/routes/targets.ts`, `apps/server/tests/integration/routes/targets.test.ts`

**Interfaces — Consumes:** the core schemas and types Task 6 added to `packages/core/src/api/schemas.ts`: `TargetListSchema`, `TargetSchema`, `CreateTargetRequestSchema`, `AddTargetWordsRequestSchema`, `ChangeTargetDateRequestSchema` (and their `z.infer` types); `TargetService` from `apps/server/src/services/targets.ts` (methods `list`, `get`, `create`, `addWords`, `removeWord`, `changeDate`, `end`); errors `TargetNotFound`, `InvalidTarget` (`reason: 'due_date' | 'no_words'`), `TargetClosed`.

**Routes** (`createRoute` + `router.openapi`, `defaultHook` → 400 `{ error: 'invalid request' }`, `...learnerResponses`, `403: forbidden('…the list owner only…')`):

| Method, path | 2xx | Errors |
|---|---|---|
| GET `/enrollments/{id}/targets` | 200 `TargetList` | 403, 404 `enrollment not found` |
| POST `/enrollments/{id}/targets` | 201 `Target` | 400 (`invalid request`, `invalid target` with the reason), 403, 404, 409 `photo import not ready` |
| GET `/targets/{id}` | 200 `Target` | 403, 404 `target not found` |
| PATCH `/targets/{id}` (`ChangeTargetDateRequest`) | 200 `Target` | 400, 403, 404, 409 `target closed` |
| POST `/targets/{id}/end` | 204 | 403, 404 |
| POST `/targets/{id}/words` (`AddTargetWordsRequest`) | 200 `Target` | 400, 403, 404, 409 (`target closed`, `photo import not ready`) |
| DELETE `/targets/{id}/words/{glossId}` | 204 | 403, 404, 409 `target closed` |

`InvalidTarget` → 400 `{ error: 'invalid target', reason }`; `PhotoImportNotFound` (an import id unknown or another enrollment's) → 400 `{ error: 'invalid target', reason: 'unknown_import' }`; `PhotoImportConflict` → 409 `{ error: 'photo import not ready' }`; `InvalidVocabularyEntry` (and `GlossLanguageMismatch`) → 400 `{ error: 'invalid vocabulary entry' }`; `TargetNotFound` → 404 `{ error: 'target not found' }`; `TargetClosed` → 409 `{ error: 'target closed' }`; `AccessDenied` → 403; `EnrollmentNotFound` → 404.

- [ ] **Step 1:** `schemas.test.ts` cases (bad day format, unknown kind, add with nothing refused, limits); `openapi.test.ts`: the seven operations in the path list and their exact status sets; `tests/integration/routes/targets.test.ts` (CI): each route's 2xx through `actAs`, a stranger's 403, a closed target's 409, and the POST create 201 body shape.
- [ ] **Step 2:** Implement routes and mount (`app.route('/api', createTargetsRouter(deps.targets))` beside vocabulary); `createFakeAppDeps` stubs.
- [ ] **Step 3:** server and core unit tests in full, typecheck, `./scripts/check-adrs.sh`; commit `feat(server): the targets endpoints (phase 53)`.

---

### Task 8: App — client, provider and the pure pieces

**Files:**
- Modify: `apps/mobile/src/api/client.ts` (+ `client.test.ts`), `apps/mobile/src/photos.ts` (+ test), `apps/mobile/src/app/_layout.tsx` (the picker engine's multiple selection; the `TargetsProvider` in the provider stack), `apps/mobile/src/hooks/useTranslation.tsx` (a collect mode), `apps/mobile/src/strings.ts` (+ `strings.test.ts`)
- Create: `apps/mobile/src/targets.ts` (+ test), `apps/mobile/src/targetWizard.ts` (+ test), `apps/mobile/src/hooks/useTargets.tsx`

**Interfaces — Produces:**

```ts
// api/client.ts
listTargets(enrollmentId: string): Promise<TargetList>
getTarget(targetId: string): Promise<Target>
createTarget(enrollmentId: string, request: CreateTargetRequest): Promise<Target>
addTargetWords(targetId: string, request: AddTargetWordsRequest): Promise<Target>
removeTargetWord(targetId: string, glossId: string): Promise<void>
changeTargetDate(targetId: string, request: ChangeTargetDateRequest): Promise<Target>
endTarget(targetId: string): Promise<void>

// photos.ts — PhotoEngine gains chooseMany; createPhotoPicker gains chooseMany(): Promise<Photo[]> (each resized as `choose` does; [] when cancelled)

// targets.ts (pure)
export function dueDateChoices(today: string, count?: number): { day: string; label: string }[]; // the `count` (default 60) days after today
export function targetTitle(kind: TargetKind): string;                    // שיעורי בית | בוחן
export function daysLeftLabel(daysLeft: number): string;                  // מחר | בעוד N ימים
export function readyLabel(ready: number, total: number): string;         // "N מתוך M מוכנות"
export function readinessName(readiness: TargetReadiness): string;        // the four Hebrew labels

// targetWizard.ts (pure)
export type WizardMode = 'create' | 'add-photos' | 'add-words' | 'change-date';
export type WizardStep = 'kind' | 'photos' | 'review' | 'words' | 'date';
export function stepsFor(mode: WizardMode): WizardStep[];
// create: kind, photos, review, words, date · add-photos: photos, review · add-words: words · change-date: date
export type PickedEntry = { gloss_id: string; variant_id: string; form: string; meaning: string };
export type WizardState = {
  mode: WizardMode; step: WizardStep; kind: TargetKind | null; photos: Photo[]; importIds: string[];
  entries: PickedEntry[]; dueOn: string | null;
};
export type WizardAction =
  | { type: 'kind'; kind: TargetKind } | { type: 'photos'; photos: Photo[] } | { type: 'remove-photo'; index: number }
  | { type: 'uploaded'; importIds: string[] } | { type: 'toggle-entry'; entry: PickedEntry } | { type: 'date'; dueOn: string }
  | { type: 'next' } | { type: 'back' };
export function initialWizard(mode: WizardMode): WizardState;
export function wizardReducer(state: WizardState, action: WizardAction): WizardState; // 'next' from photos with 0 photos skips review
export function canAdvance(state: WizardState, reviewSettled: boolean): boolean;
export function createRequest(state: WizardState): CreateTargetRequest;  // throws if kind or dueOn missing
export function addRequest(state: WizardState): AddTargetWordsRequest;

// hooks/useTargets.tsx — Context provider keyed by the active enrollment (the useVocabulary pattern: generation counter, reset on switch, stable callbacks)
export type TargetsContext = { list: TargetList | null; reload(): Promise<void> };
export function useTargets(): TargetsContext;

// hooks/useTranslation.tsx — TranslationProvider gains `collect?: { isPicked(glossId: string): boolean; toggle(entry: PickedEntry): void }`.
// With it, the save button and save-all call collect.toggle instead of the API, and a card reads "saved" from isPicked.
// Without it, nothing changes (its existing behaviour and the lookup e2e specs stay as they are).
```

- [ ] **Step 1:** Unit tests (pure modules: `targets.test.ts`, `targetWizard.test.ts` — every action, `stepsFor` per mode, skip of review with no photos, `canAdvance` per step, `createRequest`/`addRequest`; `client.test.ts` — paths, methods, bodies of the seven calls; `photos.test.ts` — `chooseMany` resizes each and returns `[]` on cancel; `strings.test.ts` exact texts).
- [ ] **Step 2:** Implement. Composition: in `_layout.tsx` the engine's `chooseMany` calls `ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsMultipleSelection: true, selectionLimit: 10 })` and returns every asset.
- [ ] **Step 3:** `npx jest` (mobile), `npm run typecheck` (mobile), `./scripts/check-adrs.sh`; commit `feat(mobile): targets client, wizard state and multi-photo picking (phase 53)`.

---

### Task 9: App — home block, wizard and target screen

**Files:**
- Create: `apps/mobile/src/components/TargetsSection.tsx`, `apps/mobile/src/components/PhotoImportRow.tsx`, `apps/mobile/src/components/ImportsReview.tsx`, `apps/mobile/src/app/targets/new.tsx`, `apps/mobile/src/app/targets/[id].tsx`
- Modify: `apps/mobile/src/components/LearningSection.tsx` (render `TargetsSection` above the entry buttons; reload targets on focus), `apps/mobile/src/app/photo-imports/[id].tsx` (use the extracted `PhotoImportRow`; behaviour unchanged), `apps/mobile/src/strings.ts`

**Behaviour:**
- **Home (`TargetsSection`)**: one row per active target from `useTargets().list` — `targetTitle(kind)`, `daysLeftLabel(days_left)`, `readyLabel(ready_count, word_count)` — tapping opens `/targets/{id}`; below, a **New** button → `/targets/new`. testIDs: `targets-section`, `target-row-{id}`, `target-new`.
- **Wizard (`/targets/new?mode=…&targetId=…`, default mode `create`)**, one step on screen at a time, a back button (previous step, or leave on the first) and Cancel (discards the wizard's imports with `api.discardPhotoImport`, then leaves):
  - `kind`: two buttons (`wizard-kind-homework`, `wizard-kind-exam`).
  - `photos`: Take (`wizard-photo-take`) and Choose (`wizard-photo-choose`, multiple) add thumbnails (`wizard-photo-{i}`, each removable); Next (`wizard-next`) uploads each photo with `api.createPhotoImport` (one import per photo, R-D9), sequentially, then goes to review. No photos: Next skips review.
  - `review` (`ImportsReview`): loads every import, polls every `IMPORT_POLL_INTERVAL_MS` while any is unsettled (`shouldPollImport`), shows the rows of all imports in order, de-duplicated with core `firstRowPerGloss` on `chosen_gloss_id`, each with `PhotoImportRow` (tick and sense change through `api.updatePhotoImportItem`, as the import screen does), and a note when some photos could not be read. Next enabled once every import is settled.
  - `words`: `LookupPanel` inside a nested `TranslationProvider` in collect mode; the picked words listed with remove buttons (`wizard-entry-{gloss_id}`).
  - `date`: a scrollable list of `dueDateChoices(list.today)` (`wizard-date-{day}`); the `today` comes from the targets list.
  - Done (`wizard-done`): `create` → `api.createTarget(enrollmentId, createRequest(state))` → `router.replace('/targets/{id}')`; `add-photos`/`add-words` → `api.addTargetWords` → back to the target screen; `change-date` → `api.changeTargetDate` → back.
- **Target screen (`/targets/[id]`)**: title, kind, due date, `readyLabel`; each word (`target-word-{gloss_id}`) with its `form`, `meaning`, `readinessName(readiness)` and a remove button (`target-word-remove-{gloss_id}`); actions: add photos (`target-add-photos` → wizard `add-photos`), add a word (`target-add-word` → `add-words`), change the date (`target-change-date` → `change-date`), end (`target-end`, with `confirm()`).

- [ ] **Step 1:** Implement (pure helpers already tested in Task 8; components hold no logic beyond wiring). Keep `photo-imports/[id].tsx` behaviour identical after extracting `PhotoImportRow`.
- [ ] **Step 2:** `npx jest` (mobile), `npm run typecheck` (mobile); `npx expo export --platform web` from `apps/mobile` must build (this is what e2e serves; run it once, delete its `dist/` output after).
- [ ] **Step 3:** Commit `feat(mobile): targets on home, the wizard and the target screen (phase 53)`.

---

### Task 10: The e2e walk

**Files:** Create `e2e/tests/targets.spec.ts`.

- [ ] **Step 1:** Following `photo-import.spec.ts` (fixture `e2e/fixtures/word-list.jpg`, `uploadFromGallery` pattern with `setFiles`, `expectGeminiMatching` for `'read the word list in this photo'` and the per-word lookups, `clearGemini` in `beforeEach`) and `translate.spec.ts` (lookup mocks), a unique username: sign up a learner, open home, `target-new` → `wizard-kind-exam` → choose one photo → `wizard-next` → wait for the review rows → `wizard-next` → look up one word and pick it → `wizard-next` → pick the first date → `wizard-done`; the target screen lists the photo's ticked words and the typed word; back home `target-row-…` shows the kind and a days-left label; on the target screen remove one word (`target-word-remove-…`, wait for the DELETE) and change the date (wait for the PATCH), and the screen shows the new date.
- [ ] **Step 2:** Typecheck the e2e workspace if it has one (`npx tsc --noEmit -p e2e` when `e2e/tsconfig.json` exists). Do not run Playwright (no lane); CI runs it.
- [ ] **Step 3:** Commit `test(e2e): the target wizard end to end (phase 53)`.
