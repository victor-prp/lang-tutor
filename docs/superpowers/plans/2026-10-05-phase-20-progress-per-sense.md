# Phase 20 — Progress per Sense Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every saved sense carries a level from 1 to 5 in each of five knowledge dimensions, the level only rises, and the saved list, the word detail and the results screen show it.

**Architecture:** Two new tables. `sense_progress` holds one row per (enrollment, sense, dimension), written with the vocabulary entry and cascaded away with it. `session_progress` records what each ended session did. A pure domain rule (`domain/progress.ts`) turns a session's answers into level changes, and it runs inside the transaction that ends a session, by completion or by skip. The list computes a word's badge in SQL as the rounded mean over its saved senses and the live dimensions, so it can sort and filter on it.

**Tech Stack:** Node 24, TypeScript, Hono + @hono/zod-openapi, Drizzle ORM 0.45 on node-postgres, Postgres 17, Jest 29 (Babel), Expo Router / React Native, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-lang-tutor-phase-20-progress-per-sense-design.md`. Read it before starting a task. Where this plan and the spec differ, this plan wins. The differences, all found while reading the code or measuring it, are:

- **`session_progress` stores all five dimensions of every practised saved sense**, not only the dimensions that received evidence. Unchanged rows have `level_before = level_after`. A results badge averages over every live dimension, and a live dimension the session did not exercise still needs its level at that moment.
- **The covering index `sense_progress_enrollment_dimension_idx (enrollment_id, dimension, sense_id, level)` is added from the start.** It was measured while planning at the plan test's volume. A 20k-word enrollment's first page took 35 ms without it and 12 ms with it, for every sort. The plan test pins it.
- **`GET …/vocabulary/words/{lexeme_id}` returns `level: null` for a word with nothing saved.** That route answers 200 for such a word, and such a word has no badge.
- **The session service returns `SessionResult = SessionRecord & { progress: ProgressChange[] }`** from `submitAnswer` and `getSession`. It is an intersection, so every existing caller that reads record fields keeps compiling.
- **Newest-sort cursors keep the phase 18 two-element encoding.** A cursor already in flight stays valid. A level-sort cursor carries four elements.
- **The recompute lives in `db/progressRecompute.ts`, behind a `--recompute-progress` flag on `db/cli.ts`.** ADR 0001 R4 forbids `db/` from importing `services/`, and `db/cli.ts` is the CLI's composition root. It repeats the session service's four-call orchestration, and its integration test pins the result.
- **The `LevelBadge` test is a test of `pipsFor`, a pure function.** Mobile tests in this repo are pure-module tests; nothing renders a component.
- **The app reads `progress` from the completing next-step response.** The read route also carries it, as the spec says, but the app does not need it.

## Global Constraints

- Dimensions, in this order: `written_receptive`, `written_productive`, `spoken_receptive`, `spoken_productive`, `spelling`.
- Live dimensions: `['written_receptive']`.
- Levels are integers 1 to 5. A new row is level 1 with both dates null.
- Gap days before a step from level 1, 2, 3, 4: **0, 1, 7, 21**. At most one step per row per UTC day. A wrong answer never lowers a level.
- Capped evidence can carry a row to level **3** and no further.
- A session's day is the **UTC date of its last answer**.
- A badge is the mean of levels over the live dimensions, **rounded to the nearest integer, ties up** (`Math.floor(mean + 0.5)` in TypeScript, `floor(avg(level) + 0.5)::int` in SQL).
- A word's list badge is the mean over **all its saved senses × the live dimensions**.
- List sorts: `newest` (default), `level_asc`, `level_desc`. Level sorts break ties by newest save, then lexeme id descending.
- Error bodies are unchanged: `{ error: 'invalid request' }` (400) for a bad `sort`, a bad `level`, or a cursor issued under another sort.
- **Hebrew strings:**

  | Key | Text |
  |---|---|
  | levels 1–5 | `חדשה`, `נחשפה`, `מוכרת`, `ידועה`, `בשליטה` |
  | dimensions | `זיהוי בכתב`, `כתיבה`, `הבנת הנשמע`, `דיבור`, `איות` |
  | notPractised | `טרם תורגל` |
  | sorts | `חדשות`, `רמה עולה`, `רמה יורדת` |
  | vocabularyEmptyLevel | `אין מילים ברמה הזו` |
  | resultsPractisedTitle | `המילים שתרגלת` |
  | levelRaised | `` `עלתה לרמה ${level}` `` |
- Never hardcode a port or a database name (ADR 0006). Run single integration test files through the lane wrapper: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- <paths>`.
- Every new route field is declared in `packages/core/src/api/schemas.ts` (ADR 0003). No module singletons, no optional collaborator parameters (ADR 0002).
- Each task ends green on `npm run typecheck`, `npm test`, and the task's own integration tests. Run `npm run lint:arch` before every commit that touches `apps/server` or `apps/mobile`.

## Review Focus

These are the failure modes the spec implies but no ordinary happy-path test exercises. Each has a pinned test in the task named.

1. **A session that spans UTC midnight.** It counts once, for the day of its last answer. The test is `findSessionEvidence` over answers at 23:59 and 00:01 UTC (Task 4).
2. **A sense unsaved while its session is open.** The session completes, nothing is written for that sense, and nothing throws. The test unsaves mid-session and then completes (Task 5).
3. **A sense answered right and wrong in one session.** Future phases repeat senses. The row does not step, and its wrong day is recorded (Task 2).
4. **A filtered, level-sorted walk across pages.** `?level=…&sort=level_desc&limit=…` pages through without repeating or losing a word (Task 7).
5. **A phase 18 cursor already held by an app.** It still decodes, as a newest-sort cursor (Task 7).

---

## File Structure

**Core (`packages/core`)**

| File | Change | Responsibility |
|---|---|---|
| `src/domain/progress.ts` | create | `DIMENSIONS`, `LIVE_DIMENSIONS`, `MIN_LEVEL`, `MAX_LEVEL`, `badge` |
| `src/domain/progress.test.ts` | create | badge rounding, dimensions match the wire |
| `src/domain/index.ts` | modify | export the above |
| `src/api/schemas.ts` | modify | dimension, level, progress, sort schemas; new fields on list, detail and session payloads |
| `src/api/types.ts`, `src/api/index.ts` | modify | inferred types for the new schemas |

**Server (`apps/server`)**

| File | Change | Responsibility |
|---|---|---|
| `src/domain/progress.ts` | create | `evidenceFor`, `advance`, `evaluateSession`, `progressChanges`, `daysBetween` |
| `src/domain/progress.test.ts` | create | the step rule |
| `src/db/schema.ts` | modify | `senseProgress`, `sessionProgress` |
| `src/db/migrations/0012_sense_progress.sql` | create (generated, then a backfill appended) | both tables, the index, five rows per existing entry |
| `src/repo/progress.ts` | create | `createProgressRepo(tx)` |
| `src/repo/vocabulary.ts` | modify | `insertEntries` writes five progress rows; `wordsPage` levels, sorts, filters |
| `src/services/transaction.ts` | modify | `Repos.progress` |
| `src/composition.ts` | modify | bind `createProgressRepo` |
| `src/services/sessions.ts` | modify | run the rule on completion and skip; `SessionResult` |
| `src/services/sessions.progress.test.ts` | create | the rule's wiring, with stubs |
| `src/routes/sessions.ts` | modify | the `progress` block |
| `src/domain/vocabulary.ts` | modify | sort-aware cursor, `level` on a page, progress on the detail |
| `src/services/vocabulary.ts` | modify | sort and filter; detail progress |
| `src/routes/vocabulary.ts` | modify | route descriptions |
| `src/db/progressRecompute.ts` | create | rebuild progress from the answer log |
| `src/db/cli.ts` | modify | `--recompute-progress` |
| `package.json` (server and root) | modify | `db:progress:recompute` |
| `tests/support/progressRows.ts` | create | progress fixtures and reads for tests |
| `tests/support/vocabularyRows.ts` | modify | save through the repository, so progress rows come with it |
| `tests/support/fakes.ts` | modify | `progress` in the fake transaction |

**Mobile (`apps/mobile`)**

| File | Change | Responsibility |
|---|---|---|
| `src/progress.ts` | create | `pipsFor`, `practisedRows`, `dimensionRows`, `nextLevelFilter` |
| `src/progress.test.ts` | create | those rules and the level names |
| `src/strings.ts` | modify | level, dimension, sort and results strings |
| `src/api/client.ts` | modify | `sort` and `level` on `listVocabulary` |
| `src/components/LevelBadge.tsx` | create | pips and name |
| `src/hooks/useVocabulary.tsx` | modify | the list query |
| `src/app/vocabulary/index.tsx` | modify | badges, sort and level chips |
| `src/app/vocabulary/[lexemeId].tsx` | modify | badges and dimensions |
| `src/hooks/useSession.tsx` | modify | `progress` from the completing answer |
| `src/app/results.tsx` | modify | the practised-words section |

**E2E:** `e2e/tests/progress.spec.ts` (create).

**Docs:** `docs/adr/adr-0002-di-with-closures.md` (factory list), the spec's status line.

---

### Task 1: Core — dimensions, levels, badge, and the new wire schemas

**Files:**
- Create: `packages/core/src/domain/progress.ts`
- Create: `packages/core/src/domain/progress.test.ts`
- Modify: `packages/core/src/domain/index.ts`
- Modify: `packages/core/src/api/schemas.ts` (a new block after `ScoreSchema`)
- Modify: `packages/core/src/api/types.ts`, `packages/core/src/api/index.ts`

**Interfaces:**
- Produces:
  - `DIMENSIONS: readonly ['written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling']`, `type Dimension`;
  - `LIVE_DIMENSIONS: readonly Dimension[]`, `MIN_LEVEL = 1`, `MAX_LEVEL = 5`;
  - `badge(levels: readonly number[]): number`;
  - schemas `KnowledgeDimensionSchema`, `LevelSchema`, `SenseProgressSchema`, `SessionProgressItemSchema`, `VocabularySortSchema`;
  - types `KnowledgeDimension`, `SenseProgress`, `SessionProgressItem`, `VocabularySort`.

No existing schema changes in this task. Each later task adds the fields it implements, so every task ends typechecking.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/domain/progress.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import { KnowledgeDimensionSchema } from '../api/schemas';
import { DIMENSIONS, LIVE_DIMENSIONS, MAX_LEVEL, MIN_LEVEL, badge } from './progress';

describe('badge', () => {
  it('is the level itself for one level', () => {
    expect(badge([3])).toBe(3);
  });

  it('rounds the mean to the nearest level', () => {
    expect(badge([1, 1, 2])).toBe(1);
    expect(badge([1, 2, 2])).toBe(2);
    expect(badge([2, 2, 3])).toBe(2);
    expect(badge([5, 1, 1])).toBe(2);
  });

  it('rounds a tie up', () => {
    expect(badge([1, 2])).toBe(2);
    expect(badge([4, 5])).toBe(5);
    expect(badge([1, 1, 2, 2])).toBe(2);
  });

  it('refuses no levels, which no sense can have', () => {
    expect(() => badge([])).toThrow();
  });
});

describe('dimensions', () => {
  it('are the five the wire publishes, in the same order', () => {
    expect(KnowledgeDimensionSchema.options).toEqual([...DIMENSIONS]);
  });

  it('has every live dimension among them', () => {
    expect(LIVE_DIMENSIONS.length).toBeGreaterThan(0);
    for (const dimension of LIVE_DIMENSIONS) expect(DIMENSIONS).toContain(dimension);
  });

  it('runs levels from 1 to 5', () => {
    expect([MIN_LEVEL, MAX_LEVEL]).toEqual([1, 5]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w packages/core -- src/domain/progress.test.ts`
Expected: FAIL, `Cannot find module './progress'`.

- [ ] **Step 3: Write the domain module**

Create `packages/core/src/domain/progress.ts`:

```ts
/**
 * Phase 20. How well a learner knows one saved sense, in five dimensions (spec
 * §1). In core rather than the server because the app shows the same ladder:
 * which dimensions are live, and how several levels become one badge.
 *
 * The wire publishes the same list as KnowledgeDimensionSchema. This module
 * cannot import it: core/domain is imported by the app at runtime, and the app
 * never loads Zod. progress.test.ts keeps the two equal.
 */
export const DIMENSIONS = [
  'written_receptive',
  'written_productive',
  'spoken_receptive',
  'spoken_productive',
  'spelling',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** The dimensions some exercise type feeds today. Multiple choice, target word
 *  to Hebrew, is the only exercise, and it evidences written_receptive alone. */
export const LIVE_DIMENSIONS: readonly Dimension[] = ['written_receptive'];

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 5;

/** The mean of `levels`, rounded to the nearest level, ties up. Mirrors
 *  `floor(avg(level) + 0.5)` in the list query. */
export function badge(levels: readonly number[]): number {
  if (levels.length === 0) throw new Error('a badge needs at least one level');
  const mean = levels.reduce((sum, level) => sum + level, 0) / levels.length;
  return Math.floor(mean + 0.5);
}
```

A tie only happens when the count is even, and then `sum / count` is exactly representable, so `Math.floor(mean + 0.5)` is exact.

Append to `packages/core/src/domain/index.ts`:

```ts
export { DIMENSIONS, LIVE_DIMENSIONS, MAX_LEVEL, MIN_LEVEL, badge } from './progress';
export type { Dimension } from './progress';
```

- [ ] **Step 4: Add the schemas**

In `packages/core/src/api/schemas.ts`, insert after `ScoreSchema`:

```ts
// Phase 20. Knowledge per saved sense: five dimensions, each with a level from
// 1 to 5 that only rises. packages/core/src/domain/progress.ts holds the same
// list as DIMENSIONS, and a test keeps the two equal.
export const KnowledgeDimensionSchema = z.enum([
  'written_receptive',
  'written_productive',
  'spoken_receptive',
  'spoken_productive',
  'spelling',
]);

export const LevelSchema = z.number().int().min(1).max(5);

// A saved sense's badge and its five levels. Only a saved sense has one.
export const SenseProgressSchema = z.object({
  level: LevelSchema,
  dimensions: z.object({
    written_receptive: LevelSchema,
    written_productive: LevelSchema,
    spoken_receptive: LevelSchema,
    spoken_productive: LevelSchema,
    spelling: LevelSchema,
  }),
});

// One practised saved sense on the results screen. Both levels are badges over
// the live dimensions. `form` is the prompt the learner saw; `translation` is
// the right answer.
export const SessionProgressItemSchema = z.object({
  sense_id: z.string(),
  form: z.string(),
  translation: z.string(),
  level_before: LevelSchema,
  level_after: LevelSchema,
});

// How the word list is ordered. The level sorts break a tie by newest save.
export const VocabularySortSchema = z.enum(['newest', 'level_asc', 'level_desc']);
```

In `packages/core/src/api/types.ts`, add the four schemas to the `import type { … } from './schemas'` list and these lines beside the other exports:

```ts
export type KnowledgeDimension = z.infer<typeof KnowledgeDimensionSchema>;
export type SenseProgress = z.infer<typeof SenseProgressSchema>;
export type SessionProgressItem = z.infer<typeof SessionProgressItemSchema>;
export type VocabularySort = z.infer<typeof VocabularySortSchema>;
```

In `packages/core/src/api/index.ts`, add `KnowledgeDimension`, `SenseProgress`, `SessionProgressItem` and `VocabularySort` to the `export type { … } from './types'` list, keeping it alphabetical.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -w packages/core && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): knowledge dimensions, levels and the badge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Server domain — the step rule

**Files:**
- Create: `apps/server/src/domain/progress.ts`
- Create: `apps/server/src/domain/progress.test.ts`

**Interfaces:**
- Consumes: `Dimension`, `MAX_LEVEL`, `badge` from `@lang-tutor/core/domain` (Task 1).
- Produces:
  - `type AnsweredQuestion = { senseId: string; type: Question['type']; correct: boolean }`;
  - `type Evidence = { dimension: Dimension; correct: boolean; capped: boolean }`;
  - `type ProgressRow = { senseId: string; dimension: Dimension; level: number; lastStepOn: string | null; lastWrongOn: string | null }`, dates `YYYY-MM-DD`;
  - `type SnapshotRow = { senseId: string; dimension: Dimension; levelBefore: number; levelAfter: number }`;
  - `type SnapshotRead = SnapshotRow & { form: string; translation: string; position: number }`;
  - `type ProgressChange = { senseId: string; form: string; translation: string; levelBefore: number; levelAfter: number }`;
  - `GAP_DAYS`, `CAPPED_MAX_LEVEL`;
  - `daysBetween(from: string, to: string): number`;
  - `evidenceFor(answer: AnsweredQuestion): Evidence[]`;
  - `advance(row: ProgressRow, pieces: readonly Evidence[], day: string): ProgressRow`, which returns `row` itself when nothing changes;
  - `evaluateSession(rows: readonly ProgressRow[], answers: readonly AnsweredQuestion[], day: string): { changed: ProgressRow[]; snapshot: SnapshotRow[] }`;
  - `progressChanges(rows: readonly SnapshotRead[], live: readonly Dimension[]): ProgressChange[]`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/domain/progress.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import { DIMENSIONS, type Dimension } from '@lang-tutor/core/domain';

import {
  advance,
  daysBetween,
  evaluateSession,
  evidenceFor,
  progressChanges,
  type AnsweredQuestion,
  type Evidence,
  type ProgressRow,
  type SnapshotRead,
} from './progress';

const row = (over: Partial<ProgressRow> = {}): ProgressRow => ({
  senseId: 's1',
  dimension: 'written_receptive',
  level: 1,
  lastStepOn: null,
  lastWrongOn: null,
  ...over,
});
const right: Evidence = { dimension: 'written_receptive', correct: true, capped: false };
const wrong: Evidence = { ...right, correct: false };
const cappedRight: Evidence = { ...right, capped: true };
const D = '2026-10-05';

describe('daysBetween', () => {
  it.each([
    ['2026-10-05', '2026-10-05', 0],
    ['2026-10-05', '2026-10-06', 1],
    ['2026-10-31', '2026-11-01', 1],
    ['2026-12-31', '2027-01-01', 1],
    ['2028-02-28', '2028-03-01', 2],
    ['2026-10-14', '2026-11-04', 21],
  ])('counts %s to %s as %i', (from, to, days) => {
    expect(daysBetween(from, to)).toBe(days);
  });
});

describe('evidenceFor', () => {
  it('reads a multiple-choice answer as uncapped written_receptive evidence', () => {
    expect(evidenceFor({ senseId: 's1', type: 'multiple_choice', correct: true })).toEqual([right]);
    expect(evidenceFor({ senseId: 's1', type: 'multiple_choice', correct: false })).toEqual([wrong]);
  });
});

describe('advance', () => {
  it('rises from level 1 on the first all-correct day', () => {
    expect(advance(row(), [right], D)).toEqual(row({ level: 2, lastStepOn: D }));
  });

  it.each([
    [2, '2026-10-05', '2026-10-06', 3],
    [3, '2026-10-06', '2026-10-13', 4],
    [3, '2026-10-06', '2026-10-12', 3],
    [4, '2026-10-14', '2026-11-04', 5],
    [4, '2026-10-14', '2026-11-03', 4],
  ])('from level %i, last step %s, on %s: level %i', (level, lastStepOn, day, expected) => {
    expect(advance(row({ level, lastStepOn }), [right], day).level).toBe(expected);
  });

  it('measures the gap from a mistake later than the last step', () => {
    const r = row({ level: 3, lastStepOn: '2026-10-06', lastWrongOn: '2026-10-07' });
    expect(advance(r, [right], '2026-10-13').level).toBe(3);
    expect(advance(r, [right], '2026-10-14').level).toBe(4);
  });

  it('records a wrong answer and never lowers the level', () => {
    const r = row({ level: 3, lastStepOn: '2026-10-01' });
    expect(advance(r, [wrong], D)).toEqual({ ...r, lastWrongOn: D });
  });

  // Review Focus 3: a sense asked twice in one session, right then wrong.
  it('does not step on a day with a wrong answer beside a right one', () => {
    expect(advance(row(), [right, wrong], D)).toEqual(row({ lastWrongOn: D }));
  });

  it('does not step after a mistake earlier the same day', () => {
    const r = row({ lastWrongOn: D });
    expect(advance(r, [right], D)).toBe(r);
  });

  it('steps at most once a day', () => {
    const r = row({ level: 2, lastStepOn: D });
    expect(advance(r, [right], D)).toBe(r);
  });

  it('never passes level 5', () => {
    const r = row({ level: 5, lastStepOn: '2026-01-01' });
    expect(advance(r, [right], D)).toBe(r);
  });

  it('carries capped evidence to level 3 and no further', () => {
    expect(advance(row({ level: 2, lastStepOn: '2026-10-01' }), [cappedRight], D).level).toBe(3);
    const atCap = row({ level: 3, lastStepOn: '2026-09-01' });
    expect(advance(atCap, [cappedRight], D)).toBe(atCap);
  });

  it('lifts the cap when one right piece is uncapped', () => {
    expect(advance(row({ level: 3, lastStepOn: '2026-09-01' }), [cappedRight, right], D).level).toBe(4);
  });

  it('changes nothing without evidence', () => {
    const r = row({ level: 2 });
    expect(advance(r, [], D)).toBe(r);
  });

  it('keeps the same row when a repeated wrong day changes nothing', () => {
    const r = row({ lastWrongOn: D });
    expect(advance(r, [wrong], D)).toBe(r);
  });
});

const fiveRows = (senseId: string, over: Partial<ProgressRow> = {}): ProgressRow[] =>
  DIMENSIONS.map((dimension) => row({ senseId, dimension, ...over }));
const answer = (senseId: string, correct: boolean): AnsweredQuestion => ({
  senseId,
  type: 'multiple_choice',
  correct,
});

describe('evaluateSession', () => {
  it('steps the right senses, records the wrong ones, and snapshots every dimension of each', () => {
    const rows = [...fiveRows('s1'), ...fiveRows('s2'), ...fiveRows('s3')];
    const outcome = evaluateSession(rows, [answer('s1', true), answer('s1', true), answer('s2', true), answer('s2', false)], D);

    expect(outcome.changed).toEqual([
      row({ senseId: 's1', level: 2, lastStepOn: D }),
      row({ senseId: 's2', lastWrongOn: D }),
    ]);
    expect(outcome.snapshot).toHaveLength(10);
    expect(outcome.snapshot.filter((s) => s.levelAfter !== s.levelBefore)).toEqual([
      { senseId: 's1', dimension: 'written_receptive', levelBefore: 1, levelAfter: 2 },
    ]);
    expect(outcome.snapshot.some((s) => s.senseId === 's3')).toBe(false);
  });

  it('ignores answers about a sense that has no rows, an unsaved one', () => {
    expect(evaluateSession(fiveRows('s1'), [answer('sX', true)], D)).toEqual({ changed: [], snapshot: [] });
  });
});

describe('progressChanges', () => {
  const read = (senseId: string, position: number, dimension: Dimension, before: number, after: number): SnapshotRead => ({
    senseId,
    dimension,
    levelBefore: before,
    levelAfter: after,
    form: `form-${senseId}`,
    translation: `tr-${senseId}`,
    position,
  });

  it('gives one change per sense, as badges over the live dimensions, in session order', () => {
    const rows = [
      ...DIMENSIONS.map((d) => read('s1', 3, d, 1, d === 'written_receptive' ? 2 : 1)),
      ...DIMENSIONS.map((d) => read('s2', 0, d, 2, 2)),
    ];
    expect(progressChanges(rows, ['written_receptive'])).toEqual([
      { senseId: 's2', form: 'form-s2', translation: 'tr-s2', levelBefore: 2, levelAfter: 2 },
      { senseId: 's1', form: 'form-s1', translation: 'tr-s1', levelBefore: 1, levelAfter: 2 },
    ]);
  });

  it('averages over every live dimension', () => {
    const rows = [
      read('s1', 0, 'written_receptive', 2, 3),
      read('s1', 0, 'written_productive', 1, 1),
      read('s1', 0, 'spelling', 5, 5),
    ];
    expect(progressChanges(rows, ['written_receptive', 'written_productive'])[0]).toMatchObject({
      levelBefore: 2,
      levelAfter: 2,
    });
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test -w apps/server -- src/domain/progress.test.ts`
Expected: FAIL, `Cannot find module './progress'`.

- [ ] **Step 3: Write the domain module**

Create `apps/server/src/domain/progress.ts`:

```ts
import type { Question } from '@lang-tutor/core/api';
import { MAX_LEVEL, badge, type Dimension } from '@lang-tutor/core/domain';

/**
 * Phase 20. The step rule (spec §3). Pure: the day is passed in, no clock is
 * read (ADR 0001 R3).
 */

/** One answer as the rule reads it: which sense, which exercise, right or wrong. */
export type AnsweredQuestion = { senseId: string; type: Question['type']; correct: boolean };

/** One piece of evidence about one dimension. Capped evidence can carry a
 *  dimension to CAPPED_MAX_LEVEL and no further. */
export type Evidence = { dimension: Dimension; correct: boolean; capped: boolean };

/** One row of sense_progress. Days are UTC calendar dates, `YYYY-MM-DD`. */
export type ProgressRow = {
  senseId: string;
  dimension: Dimension;
  level: number;
  lastStepOn: string | null;
  lastWrongOn: string | null;
};

/** What one ended session did to one row of a practised saved sense. */
export type SnapshotRow = { senseId: string; dimension: Dimension; levelBefore: number; levelAfter: number };

/** A snapshot row as the results read it back, with the question that asked it. */
export type SnapshotRead = SnapshotRow & { form: string; translation: string; position: number };

/** One practised saved sense, as badges. */
export type ProgressChange = {
  senseId: string;
  form: string;
  translation: string;
  levelBefore: number;
  levelAfter: number;
};

/** Whole days that must pass, since the later of the last step and the last
 *  mistake, before a row may rise from level 1, 2, 3, 4. Level 5 therefore
 *  needs four all-correct days spanning at least 29 days. */
export const GAP_DAYS: readonly number[] = [0, 1, 7, 21];

/** The highest level capped evidence alone can reach. */
export const CAPPED_MAX_LEVEL = 3;

const DAY_MS = 86_400_000;

function dayNumber(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date) / DAY_MS;
}

/** Whole UTC days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/**
 * What one answer says about which dimensions. Today every question is
 * multiple choice, target word to Hebrew, which is recognition: uncapped
 * written_receptive evidence. Spec §3's table lists the cases later exercise
 * types add here, including the downward credit a correct productive answer
 * gives its receptive dimension.
 */
export function evidenceFor(answer: AnsweredQuestion): Evidence[] {
  switch (answer.type) {
    case 'multiple_choice':
      return [{ dimension: 'written_receptive', correct: answer.correct, capped: false }];
  }
}

/** The later of two ISO dates; null only when both are. */
function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * Applies one session's evidence about one row. Returns `row` itself when
 * nothing changes, so a caller can tell a change by identity.
 *
 * - A wrong piece records the day. It never lowers the level.
 * - A step needs a right piece and no wrong one; no mistake earlier today; no
 *   step yet today; the gap for the current level since the later of the last
 *   step and the last mistake; and the new level within the cap.
 */
export function advance(row: ProgressRow, pieces: readonly Evidence[], day: string): ProgressRow {
  if (pieces.length === 0) return row;
  if (pieces.some((piece) => !piece.correct)) {
    return row.lastWrongOn === day ? row : { ...row, lastWrongOn: day };
  }
  if (row.lastWrongOn === day || row.lastStepOn === day) return row;
  if (row.level >= MAX_LEVEL) return row;
  const cap = pieces.every((piece) => piece.capped) ? CAPPED_MAX_LEVEL : MAX_LEVEL;
  if (row.level + 1 > cap) return row;
  const since = later(row.lastStepOn, row.lastWrongOn);
  if (since !== null && daysBetween(since, day) < GAP_DAYS[row.level - 1]) return row;
  return { ...row, level: row.level + 1, lastStepOn: day };
}

const keyOf = (senseId: string, dimension: Dimension) => `${senseId} ${dimension}`;

/**
 * One ended session over the progress rows of the senses it asked about.
 * `rows` holds rows for saved senses only, so an answer about an unsaved sense
 * finds none and counts for nothing.
 *
 * `changed` is what to write. `snapshot` is every row of every practised saved
 * sense, moved or not: a results badge averages over every live dimension,
 * including one this session did not exercise.
 */
export function evaluateSession(
  rows: readonly ProgressRow[],
  answers: readonly AnsweredQuestion[],
  day: string,
): { changed: ProgressRow[]; snapshot: SnapshotRow[] } {
  const pieces = new Map<string, Evidence[]>();
  for (const answer of answers) {
    for (const piece of evidenceFor(answer)) {
      const key = keyOf(answer.senseId, piece.dimension);
      pieces.set(key, [...(pieces.get(key) ?? []), piece]);
    }
  }
  const practised = new Set(answers.map((answer) => answer.senseId));

  const changed: ProgressRow[] = [];
  const snapshot: SnapshotRow[] = [];
  for (const row of rows) {
    if (!practised.has(row.senseId)) continue;
    const next = advance(row, pieces.get(keyOf(row.senseId, row.dimension)) ?? [], day);
    if (next !== row) changed.push(next);
    snapshot.push({
      senseId: row.senseId,
      dimension: row.dimension,
      levelBefore: row.level,
      levelAfter: next.level,
    });
  }
  return { changed, snapshot };
}

/** A session's snapshot as the results show it: one change per sense, badges
 *  over the live dimensions, in the order the session first asked each. */
export function progressChanges(
  rows: readonly SnapshotRead[],
  live: readonly Dimension[],
): ProgressChange[] {
  const bySense = new Map<string, SnapshotRead[]>();
  for (const row of rows) bySense.set(row.senseId, [...(bySense.get(row.senseId) ?? []), row]);
  return [...bySense.values()]
    .map((senseRows) => {
      const shown = senseRows.filter((row) => live.includes(row.dimension));
      const first = senseRows[0];
      return {
        position: Math.min(...senseRows.map((row) => row.position)),
        change: {
          senseId: first.senseId,
          form: first.form,
          translation: first.translation,
          levelBefore: badge(shown.map((row) => row.levelBefore)),
          levelAfter: badge(shown.map((row) => row.levelAfter)),
        },
      };
    })
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.change);
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w apps/server -- src/domain/progress.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint and commit**

Run: `npm run typecheck -w apps/server && npm run lint:arch`
Expected: no output from `lint:arch`, typecheck clean.

```bash
git add apps/server/src/domain/progress.ts apps/server/src/domain/progress.test.ts
git commit -m "feat(server): the progress step rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Schema and migration — `sense_progress` and `session_progress`

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/src/db/migrations/0012_sense_progress.sql` (generated, then edited), plus drizzle's `meta/` files
- Create: `apps/server/tests/integration/db/progress.schema.test.ts`
- Modify: `apps/server/tests/integration/db/migrations.test.ts`

**Interfaces:**
- Produces: tables `sense_progress` and `session_progress`; Drizzle tables `senseProgress` and `sessionProgress`; constraints `sense_progress_pkey`, `sense_progress_entry_fk`, `sense_progress_dimension_known`, `sense_progress_level_range`, `session_progress_pkey`, `session_progress_session_fk`, `session_progress_dimension_known`, `session_progress_levels_valid`; index `sense_progress_enrollment_dimension_idx`.

- [ ] **Step 1: Write the failing schema tests**

Create `apps/server/tests/integration/db/progress.schema.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { DIMENSIONS } from '@lang-tutor/core/domain';
import { sql } from 'drizzle-orm';

import { insertLexeme } from '../../support/dictRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;
let senseId: string;
const E = enrollmentOf('u_1');

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  const kite = await insertLexeme(t.db, {
    lemma: 'kite',
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'toy' }],
    variants: [
      {
        form: 'kite',
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'toy', rank: 0, translation: 'עפיפון', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
  senseId = kite.senseIds[0];
  // Directly, without progress rows: these tests write those rows themselves.
  await t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id)
    values (${E}, ${senseId}, ${kite.lexemeId}, ${kite.variantIds[0]})`);
});
afterEach(async () => {
  await t.close();
});

const violating = (constraint: string) =>
  expect.objectContaining({
    cause: expect.objectContaining({ message: expect.stringContaining(constraint) }),
  });

const progress = (over: { sense?: string; dimension?: string; level?: number } = {}) =>
  t.db.execute(sql`
    insert into sense_progress (enrollment_id, sense_id, dimension, level)
    values (${E}, ${over.sense ?? senseId}, ${over.dimension ?? 'written_receptive'}, ${over.level ?? 1})`);

describe('sense_progress', () => {
  it('takes one row per dimension and starts each at level 1 with no dates', async () => {
    for (const dimension of DIMENSIONS) {
      await t.db.execute(sql`
        insert into sense_progress (enrollment_id, sense_id, dimension) values (${E}, ${senseId}, ${dimension})`);
    }
    const rows = await t.db.execute<{ level: number; last_step_on: string | null; last_wrong_on: string | null }>(
      sql`select level, last_step_on, last_wrong_on from sense_progress`,
    );
    expect(rows.rows).toHaveLength(5);
    expect(rows.rows.every((r) => r.level === 1 && r.last_step_on === null && r.last_wrong_on === null)).toBe(true);
  });

  it('holds one row per (enrollment, sense, dimension)', async () => {
    await progress();
    await expect(progress()).rejects.toThrow(violating('sense_progress_pkey'));
  });

  it('refuses a dimension it does not know', async () => {
    await expect(progress({ dimension: 'reading' })).rejects.toThrow(violating('sense_progress_dimension_known'));
  });

  it.each([0, 6])('refuses level %i', async (level) => {
    await expect(progress({ level })).rejects.toThrow(violating('sense_progress_level_range'));
  });

  it('refuses a row for a sense that is not saved', async () => {
    await expect(progress({ sense: 'not-saved' })).rejects.toThrow(violating('sense_progress_entry_fk'));
  });

  it('goes with the entry when the sense is unsaved', async () => {
    await progress();
    await t.db.execute(sql`delete from vocabulary_entries where enrollment_id = ${E} and sense_id = ${senseId}`);
    const rows = await t.db.execute(sql`select 1 from sense_progress`);
    expect(rows.rows).toHaveLength(0);
  });
});

describe('session_progress', () => {
  async function session(): Promise<string> {
    const rows = await t.db.execute<{ id: string }>(sql`
      insert into sessions (user_id, enrollment_id, status, source)
      values ('u_1', ${E}, 'skipped', 'seed') returning id`);
    return rows.rows[0].id;
  }
  const snapshot = (sessionId: string, over: { dimension?: string; before?: number; after?: number } = {}) =>
    t.db.execute(sql`
      insert into session_progress (session_id, sense_id, dimension, level_before, level_after)
      values (${sessionId}, ${senseId}, ${over.dimension ?? 'written_receptive'}, ${over.before ?? 1}, ${over.after ?? 2})`);

  it('records a level that rose or stayed', async () => {
    const id = await session();
    await snapshot(id);
    await snapshot(id, { dimension: 'spelling', before: 1, after: 1 });
    const rows = await t.db.execute(sql`select 1 from session_progress`);
    expect(rows.rows).toHaveLength(2);
  });

  it('refuses a level that went down', async () => {
    const id = await session();
    await expect(snapshot(id, { before: 3, after: 2 })).rejects.toThrow(violating('session_progress_levels_valid'));
  });

  it('refuses a dimension it does not know', async () => {
    const id = await session();
    await expect(snapshot(id, { dimension: 'reading' })).rejects.toThrow(
      violating('session_progress_dimension_known'),
    );
  });

  it('goes with its session', async () => {
    const id = await session();
    await snapshot(id);
    await t.db.execute(sql`delete from sessions where id = ${id}`);
    const rows = await t.db.execute(sql`select 1 from session_progress`);
    expect(rows.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Write the failing migration test**

In `apps/server/tests/integration/db/migrations.test.ts`, add `import { DIMENSIONS } from '@lang-tutor/core/domain';` to the imports and append:

```ts
describe('0012_sense_progress', () => {
  it('gives every existing entry five level 1 rows', async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0011_session_status'));

    await db.execute(sql`
      insert into users (id, username, display_name, age, native_language)
        values ('u_1', 'u_1', 'one', 30, 'he');
      insert into enrollments (id, user_id, source_language, target_language)
        values ('e_1', 'u_1', 'he', 'en');
      insert into dict_lexemes (id, language_code, lemma, part_of_speech)
        values ('l1', 'en', 'kite', 'noun');
      insert into dict_senses (id, lexeme_id, sense_code)
        values ('s1', 'l1', 'toy'), ('s2', 'l1', 'bird');
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank)
        values ('v1', 'l1', 'en', 'kite', 'word', 0);
      insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank)
        values ('v1', 's1', 'he', 'עפיפון', 0), ('v1', 's2', 'he', 'דיה', 1);
      insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id)
        values ('e_1', 's1', 'l1', 'v1'), ('e_1', 's2', 'l1', 'v1');
    `);

    await runMigrations(db);

    const rows = await db.execute<{
      sense_id: string;
      dimension: string;
      level: number;
      last_step_on: string | null;
      last_wrong_on: string | null;
    }>(sql`select sense_id, dimension, level, last_step_on, last_wrong_on
           from sense_progress order by sense_id, dimension`);
    expect(rows.rows).toHaveLength(10);
    for (const sense of ['s1', 's2']) {
      expect(rows.rows.filter((r) => r.sense_id === sense).map((r) => r.dimension).sort()).toEqual(
        [...DIMENSIONS].sort(),
      );
    }
    expect(rows.rows.every((r) => r.level === 1 && r.last_step_on === null && r.last_wrong_on === null)).toBe(true);
  });
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/db/progress.schema.test.ts tests/integration/db/migrations.test.ts`
Expected: FAIL with `relation "sense_progress" does not exist`, in both files.

- [ ] **Step 4: Add the tables to the schema**

In `apps/server/src/db/schema.ts`, add `date` to the `drizzle-orm/pg-core` import list. Insert after the `vocabularyEntries` table:

```ts
/**
 * Phase 20. How well a learner knows one saved sense, per knowledge dimension
 * (spec §2). Five rows per vocabulary entry, written with it in the save
 * transaction (repo/vocabulary.ts insertEntries), so "not practised" is a level
 * 1 row and never a missing one, and a dimension that goes live later needs no
 * backfill.
 *
 * The level only rises. The two dates are the whole state the step rule needs
 * (domain/progress.ts): the UTC day of the last step and of the last mistake.
 * mode 'string' because node-postgres would otherwise turn a date into a JS Date
 * at local midnight.
 *
 * The FK into vocabulary_entries cascades: unsaving a sense drops its progress,
 * and a re-save starts at level 1. Only answers given while a sense is saved
 * count.
 *
 * The dimension CHECK lists the same five names as DIMENSIONS in
 * packages/core. A literal, because drizzle-kit reads this file on its own; the
 * schema tests insert every DIMENSIONS value, which keeps the two equal.
 *
 * sense_progress_enrollment_dimension_idx serves the list's level sort and
 * filter as an index-only scan of one enrollment's live-dimension rows.
 * Measured while planning at the plan test's volume: 35 ms without it, 12 ms
 * with it, for a 20k-word enrollment's first page. `level` is a key column
 * rather than INCLUDE because drizzle-kit cannot express INCLUDE.
 */
export const senseProgress = pgTable(
  'sense_progress',
  {
    enrollmentId: text('enrollment_id').notNull(),
    senseId: text('sense_id').notNull(),
    dimension: text('dimension').notNull(),
    level: integer('level').notNull().default(1),
    lastStepOn: date('last_step_on', { mode: 'string' }),
    lastWrongOn: date('last_wrong_on', { mode: 'string' }),
  },
  (t) => [
    primaryKey({ name: 'sense_progress_pkey', columns: [t.enrollmentId, t.senseId, t.dimension] }),
    foreignKey({
      name: 'sense_progress_entry_fk',
      columns: [t.enrollmentId, t.senseId],
      foreignColumns: [vocabularyEntries.enrollmentId, vocabularyEntries.senseId],
    }).onDelete('cascade'),
    check(
      'sense_progress_dimension_known',
      sql`${t.dimension} in ('written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling')`,
    ),
    check('sense_progress_level_range', sql`${t.level} between 1 and 5`),
    index('sense_progress_enrollment_dimension_idx').on(t.enrollmentId, t.dimension, t.senseId, t.level),
  ],
);
```

Insert after the `answers` table at the end of the file:

```ts
/**
 * Phase 20. What one ended session did to each progress row of each saved
 * sense it practised: all five dimensions, moved or not. It is what lets the
 * results be read again after the session ended, and what the recompute
 * rebuilds. No FK to sense_progress: a sense unsaved later keeps its history
 * here, and the results of an old session still read.
 */
export const sessionProgress = pgTable(
  'session_progress',
  {
    sessionId: uuid('session_id').notNull(),
    senseId: text('sense_id').notNull(),
    dimension: text('dimension').notNull(),
    levelBefore: integer('level_before').notNull(),
    levelAfter: integer('level_after').notNull(),
  },
  (t) => [
    primaryKey({ name: 'session_progress_pkey', columns: [t.sessionId, t.senseId, t.dimension] }),
    foreignKey({
      name: 'session_progress_session_fk',
      columns: [t.sessionId],
      foreignColumns: [sessions.id],
    }).onDelete('cascade'),
    check(
      'session_progress_dimension_known',
      sql`${t.dimension} in ('written_receptive', 'written_productive', 'spoken_receptive', 'spoken_productive', 'spelling')`,
    ),
    check(
      'session_progress_levels_valid',
      sql`${t.levelBefore} between 1 and 5 and ${t.levelAfter} between ${t.levelBefore} and 5`,
    ),
  ],
);
```

- [ ] **Step 5: Generate the migration**

Run: `npm run db:generate -w apps/server -- --name sense_progress`
Expected: `apps/server/src/db/migrations/0012_sense_progress.sql` and new files under `migrations/meta/`. The SQL holds two `CREATE TABLE`, two `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` and one `CREATE INDEX`. Leave those statements as generated.

- [ ] **Step 6: Add the comment and the backfill**

At the top of `0012_sense_progress.sql`, add:

```sql
-- Phase 20. Progress per saved sense, and what each ended session did to it.
-- Every entry saved before this phase gets its five rows at level 1: nothing
-- was practised from a saved list before phase 19, and only answers given
-- while a sense is saved count, so no session is re-evaluated.
```

Make the last generated statement end with `;--> statement-breakpoint`, then append:

```sql
INSERT INTO "sense_progress" ("enrollment_id", "sense_id", "dimension")
SELECT ve."enrollment_id", ve."sense_id", d."dimension"
FROM "vocabulary_entries" ve
CROSS JOIN (VALUES ('written_receptive'), ('written_productive'), ('spoken_receptive'),
                   ('spoken_productive'), ('spelling')) AS d("dimension");
```

- [ ] **Step 7: Check that the schema and the migrations agree**

Run: `npm run db:check -w apps/server`
Expected: `Everything's fine 🐶🔥` (or drizzle-kit's equivalent "no issues").

- [ ] **Step 8: Run the tests**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/db`
Expected: PASS, including the existing schema and migration tests.

- [ ] **Step 9: Migrate the lane database and commit**

Run: `npm run db:migrate`
Expected: `migrated and seeded …`.

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations apps/server/tests/integration/db
git commit -m "feat(server): sense_progress and session_progress tables

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The progress repository, and saving writes progress rows

**Files:**
- Create: `apps/server/src/repo/progress.ts`
- Modify: `apps/server/src/repo/vocabulary.ts` (`vocabularyQueries.insertEntries`)
- Modify: `apps/server/src/services/transaction.ts`, `apps/server/src/composition.ts`
- Modify: `apps/server/tests/support/fakes.ts`, `apps/server/src/services/sessions.test.ts`
- Create: `apps/server/tests/support/progressRows.ts`
- Modify: `apps/server/tests/support/vocabularyRows.ts`
- Create: `apps/server/tests/integration/repo/progress.test.ts`
- Modify: `apps/server/tests/integration/repo/vocabulary.test.ts`
- Modify: `docs/adr/adr-0002-di-with-closures.md` (R6 factory list)

**Interfaces:**
- Consumes: `AnsweredQuestion`, `ProgressRow`, `SnapshotRow`, `SnapshotRead` (Task 2); `senseProgress`, `sessionProgress` (Task 3); `DIMENSIONS` (Task 1).
- Produces:
  - `type SessionEvidence = { enrollmentId: string; day: string; lastAnsweredAt: string; answers: AnsweredQuestion[] }`;
  - `createProgressRepo(tx)` returning:
    - `findSessionEvidence(sessionId: string): Promise<SessionEvidence | undefined>`, undefined when the session has no answers;
    - `findRows(input: { enrollmentId: string; senseIds: string[]; savedBy: string | null }): Promise<ProgressRow[]>`;
    - `updateRows(input: { enrollmentId: string; rows: ProgressRow[] }): Promise<void>`;
    - `insertSnapshot(input: { sessionId: string; rows: SnapshotRow[] }): Promise<void>`;
    - `findSnapshot(sessionId: string): Promise<SnapshotRead[]>`;
    - `resetAll(): Promise<void>` and `listEndedSessions(): Promise<string[]>`, for the recompute;
  - `type ProgressRepo`; `Repos.progress: ProgressRepo`;
  - `vocabulary.insertEntries` now also writes five level 1 progress rows for each entry it creates;
  - test support: `insertProgressRows`, `setLevel`, `readProgress`, `readSnapshot`, `sessionDay`, `saveSessionSenses`, `insertAnsweredSession`, `failInsertsInto`.

- [ ] **Step 1: Write the test support module**

Create `apps/server/tests/support/progressRows.ts`:

```ts
import { randomUUID } from 'node:crypto';

import { DIMENSIONS, type Dimension } from '@lang-tutor/core/domain';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { Db } from '../../src/db/client';
import {
  answers,
  dictVariants,
  questions,
  senseProgress,
  sessionProgress,
  sessionQuestions,
  sessions,
} from '../../src/db/schema';
import { createVocabularyRepo } from '../../src/repo/vocabulary';
import { withTx } from './withTx';

/**
 * Progress fixtures and reads. tests/support/ is the test composition root, so
 * reaching db/schema.ts here is the carve-out ADR 0001 grants it; route and
 * service tests reach the progress tables only through these.
 */

/** Five level 1 rows for entries a test inserted directly, as the save path writes them. */
export async function insertProgressRows(db: Db, enrollmentId: string, senseIds: string[]): Promise<void> {
  if (senseIds.length === 0) return;
  await db
    .insert(senseProgress)
    .values(senseIds.flatMap((senseId) => DIMENSIONS.map((dimension) => ({ enrollmentId, senseId, dimension }))));
}

/** Puts one row at a level, so a test about sorting or badges need not answer weeks of sessions. */
export async function setLevel(
  db: Db,
  input: { enrollmentId: string; senseId: string; level: number; dimension?: Dimension },
): Promise<void> {
  await db
    .update(senseProgress)
    .set({ level: input.level })
    .where(
      and(
        eq(senseProgress.enrollmentId, input.enrollmentId),
        eq(senseProgress.senseId, input.senseId),
        eq(senseProgress.dimension, input.dimension ?? 'written_receptive'),
      ),
    );
}

export type StoredProgress = {
  senseId: string;
  dimension: string;
  level: number;
  lastStepOn: string | null;
  lastWrongOn: string | null;
};

/** Every progress row of one enrollment, ordered by sense and dimension. */
export async function readProgress(db: Db, enrollmentId: string): Promise<StoredProgress[]> {
  return db
    .select({
      senseId: senseProgress.senseId,
      dimension: senseProgress.dimension,
      level: senseProgress.level,
      lastStepOn: senseProgress.lastStepOn,
      lastWrongOn: senseProgress.lastWrongOn,
    })
    .from(senseProgress)
    .where(eq(senseProgress.enrollmentId, enrollmentId))
    .orderBy(asc(senseProgress.senseId), asc(senseProgress.dimension));
}

/** One session's snapshot rows, ordered by sense and dimension. */
export async function readSnapshot(db: Db, sessionId: string) {
  return db
    .select({
      senseId: sessionProgress.senseId,
      dimension: sessionProgress.dimension,
      levelBefore: sessionProgress.levelBefore,
      levelAfter: sessionProgress.levelAfter,
    })
    .from(sessionProgress)
    .where(eq(sessionProgress.sessionId, sessionId))
    .orderBy(asc(sessionProgress.senseId), asc(sessionProgress.dimension));
}

/** The UTC date of a session's last answer: the day the rule counts it for. */
export async function sessionDay(db: Db, sessionId: string): Promise<string> {
  const rows = await db.execute<{ day: string }>(sql`
    select ((max(answered_at)) at time zone 'UTC')::date::text as day
    from answers where session_id = ${sessionId}`);
  return rows.rows[0].day;
}

/**
 * Saves the senses of a session's questions at `positions`, through the
 * repository, so each gets its five progress rows. Returns the sense ids in
 * position order. The seed's shared questions are about real senses, which is
 * what lets a test practise saved words without the prepare-session job.
 */
export async function saveSessionSenses(
  db: Db,
  input: { sessionId: string; enrollmentId: string; positions: number[] },
): Promise<string[]> {
  const rows = await db
    .select({
      position: sessionQuestions.position,
      senseId: questions.senseId,
      variantId: questions.promptVariantId,
      lexemeId: dictVariants.lexemeId,
    })
    .from(sessionQuestions)
    .innerJoin(questions, eq(questions.id, sessionQuestions.questionId))
    .innerJoin(dictVariants, eq(dictVariants.id, questions.promptVariantId))
    .where(eq(sessionQuestions.sessionId, input.sessionId))
    .orderBy(asc(sessionQuestions.position));
  const picked = rows.filter((row) => input.positions.includes(row.position));
  await withTx(db, (tx) =>
    createVocabularyRepo(tx).insertEntries({
      enrollmentId: input.enrollmentId,
      entries: picked.map(({ senseId, variantId, lexemeId }) => ({ senseId, variantId, lexemeId })),
    }),
  );
  return picked.map((row) => row.senseId);
}

/**
 * A session with chosen answers at chosen times, written directly. One
 * enrollment-owned question per entry of `asked`, options [translation, x1,
 * x2, x3] with the translation right; a right answer picks it, a wrong one x1.
 */
export async function insertAnsweredSession(
  db: Db,
  input: {
    userId: string;
    enrollmentId: string;
    status: 'ready' | 'completed' | 'skipped';
    asked: { senseId: string; variantId: string; translation: string }[];
    answers: { position: number; correct: boolean; at: string }[];
  },
): Promise<string> {
  const questionIds = input.asked.map(() => `q-${randomUUID()}`);
  await db.insert(questions).values(
    input.asked.map((item, i) => ({
      id: questionIds[i],
      userId: input.userId,
      enrollmentId: input.enrollmentId,
      senseId: item.senseId,
      promptVariantId: item.variantId,
      targetLanguage: 'en',
      userLanguageCode: 'he',
      type: 'multiple_choice',
      options: [
        { position: 0, text: item.translation, is_correct: true },
        { position: 1, text: 'x1', is_correct: false },
        { position: 2, text: 'x2', is_correct: false },
        { position: 3, text: 'x3', is_correct: false },
      ],
    })),
  );
  const [session] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      enrollmentId: input.enrollmentId,
      status: input.status,
      source: 'list',
      completedAt: input.status === 'completed' ? sql`now()` : null,
    })
    .returning({ id: sessions.id });
  await db.insert(sessionQuestions).values(
    questionIds.map((questionId, position) => ({
      sessionId: session.id,
      position,
      questionId,
      optionOrder: [0, 1, 2, 3],
    })),
  );
  if (input.answers.length > 0) {
    await db.insert(answers).values(
      input.answers.map((a) => ({
        sessionId: session.id,
        position: a.position,
        questionId: questionIds[a.position],
        selectedOptionPosition: a.correct ? 0 : 1,
        answeredAt: sql`${a.at}::timestamptz`,
      })),
    );
  }
  return session.id;
}

/**
 * Makes every insert into `table` fail, to prove a write is all-or-nothing.
 * The database is the test's own clone, so the trigger goes with it.
 */
export async function failInsertsInto(db: Db, table: 'session_progress' | 'sense_progress'): Promise<void> {
  await db.execute(
    sql.raw(`
      create function fail_insert() returns trigger language plpgsql as $$
        begin raise exception 'planted failure'; end
      $$;
      create trigger fail_insert before insert on ${table}
        for each row execute function fail_insert();`),
  );
}
```

- [ ] **Step 2: Write the failing repository tests**

Create `apps/server/tests/integration/repo/progress.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { DIMENSIONS } from '@lang-tutor/core/domain';
import { sql } from 'drizzle-orm';

import { createProgressRepo } from '../../../src/repo/progress';
import { insertLexeme } from '../../support/dictRows';
import { insertAnsweredSession, insertProgressRows, readProgress } from '../../support/progressRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;
const E = enrollmentOf('u_1');
let kite: { lexemeId: string; variantIds: string[]; senseIds: string[] };

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  kite = await insertLexeme(t.db, {
    lemma: 'kite',
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'toy' }, { senseCode: 'bird' }],
    variants: [
      {
        form: 'kite',
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'toy', rank: 0, translation: 'עפיפון', exampleSource: null, exampleTarget: null },
          { senseCode: 'bird', rank: 1, translation: 'דיה', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
});
afterEach(async () => {
  await t.close();
});

const repo = <T>(fn: (r: ReturnType<typeof createProgressRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => fn(createProgressRepo(tx)));

/** Saves `senseIndexes` of kite at `at`, with their five rows. */
async function saveAt(at: string, senseIndexes: number[]) {
  for (const i of senseIndexes) {
    await t.db.execute(sql`
      insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id, created_at)
      values (${E}, ${kite.senseIds[i]}, ${kite.lexemeId}, ${kite.variantIds[0]}, ${at}::timestamptz)`);
  }
  await insertProgressRows(t.db, E, senseIndexes.map((i) => kite.senseIds[i]));
}

const asked = (i: number, translation: string) => ({
  senseId: kite.senseIds[i],
  variantId: kite.variantIds[0],
  translation,
});

describe('findSessionEvidence', () => {
  it("reads each answer in order, right or wrong, with the session's enrollment", async () => {
    const sessionId = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'completed',
      asked: [asked(0, 'עפיפון'), asked(1, 'דיה')],
      answers: [
        { position: 0, correct: true, at: '2026-10-05 10:00:00+00' },
        { position: 1, correct: false, at: '2026-10-05 10:01:00+00' },
      ],
    });
    expect(await repo((r) => r.findSessionEvidence(sessionId))).toEqual({
      enrollmentId: E,
      day: '2026-10-05',
      lastAnsweredAt: expect.any(String),
      answers: [
        { senseId: kite.senseIds[0], type: 'multiple_choice', correct: true },
        { senseId: kite.senseIds[1], type: 'multiple_choice', correct: false },
      ],
    });
  });

  // Review Focus 1: a session across UTC midnight counts for its last answer's day.
  it('dates a session by the UTC day of its last answer', async () => {
    const sessionId = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'skipped',
      asked: [asked(0, 'עפיפון'), asked(1, 'דיה')],
      answers: [
        { position: 0, correct: true, at: '2026-10-05 23:59:00+00' },
        { position: 1, correct: true, at: '2026-10-05 21:01:00-03' },
      ],
    });
    expect((await repo((r) => r.findSessionEvidence(sessionId)))?.day).toBe('2026-10-06');
  });

  it('answers undefined for a session with no answers', async () => {
    const sessionId = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'skipped',
      asked: [asked(0, 'עפיפון')],
      answers: [],
    });
    expect(await repo((r) => r.findSessionEvidence(sessionId))).toBeUndefined();
  });
});

describe('findRows and updateRows', () => {
  it('finds the five rows of each saved sense, and none for an unsaved one', async () => {
    await saveAt('2026-10-01 00:00:00+00', [0]);
    const rows = await repo((r) =>
      r.findRows({ enrollmentId: E, senseIds: [kite.senseIds[0], kite.senseIds[1]], savedBy: null }),
    );
    expect(rows.map((row) => row.dimension).sort()).toEqual([...DIMENSIONS].sort());
    expect(rows.every((row) => row.senseId === kite.senseIds[0] && row.level === 1)).toBe(true);
    expect(rows.every((row) => row.lastStepOn === null && row.lastWrongOn === null)).toBe(true);
  });

  it('leaves out a sense saved after `savedBy`', async () => {
    await saveAt('2026-10-05 12:00:00+00', [0]);
    const find = (savedBy: string) =>
      repo((r) => r.findRows({ enrollmentId: E, senseIds: [kite.senseIds[0]], savedBy }));
    expect(await find('2026-10-05 11:59:59+00')).toEqual([]);
    expect(await find('2026-10-05 12:00:00+00')).toHaveLength(5);
  });

  it('answers nothing for no senses, without a query', async () => {
    expect(await repo((r) => r.findRows({ enrollmentId: E, senseIds: [], savedBy: null }))).toEqual([]);
  });

  it('writes the named rows and no others', async () => {
    await saveAt('2026-10-01 00:00:00+00', [0, 1]);
    await repo((r) =>
      r.updateRows({
        enrollmentId: E,
        rows: [
          { senseId: kite.senseIds[0], dimension: 'written_receptive', level: 3, lastStepOn: '2026-10-06', lastWrongOn: '2026-10-04' },
        ],
      }),
    );
    const stored = await readProgress(t.db, E);
    expect(stored.find((row) => row.senseId === kite.senseIds[0] && row.dimension === 'written_receptive')).toEqual({
      senseId: kite.senseIds[0],
      dimension: 'written_receptive',
      level: 3,
      lastStepOn: '2026-10-06',
      lastWrongOn: '2026-10-04',
    });
    expect(stored.filter((row) => row.level !== 1)).toHaveLength(1);
  });
});

describe('insertSnapshot and findSnapshot', () => {
  it('reads each row back with the form and the right answer of the first question that asked it', async () => {
    await saveAt('2026-10-01 00:00:00+00', [0]);
    const sessionId = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'completed',
      asked: [asked(1, 'דיה'), asked(0, 'עפיפון'), asked(0, 'עפיפון')],
      answers: [],
    });
    await repo((r) =>
      r.insertSnapshot({
        sessionId,
        rows: [{ senseId: kite.senseIds[0], dimension: 'written_receptive', levelBefore: 1, levelAfter: 2 }],
      }),
    );
    expect(await repo((r) => r.findSnapshot(sessionId))).toEqual([
      {
        senseId: kite.senseIds[0],
        dimension: 'written_receptive',
        levelBefore: 1,
        levelAfter: 2,
        form: 'kite',
        translation: 'עפיפון',
        position: 1,
      },
    ]);
  });
});

describe("the recompute's reads", () => {
  it('resets every row and every snapshot', async () => {
    await saveAt('2026-10-01 00:00:00+00', [0]);
    await t.db.execute(sql`update sense_progress set level = 4, last_step_on = '2026-10-02'`);
    await repo((r) => r.resetAll());
    expect((await readProgress(t.db, E)).every((row) => row.level === 1 && row.lastStepOn === null)).toBe(true);
  });

  it('lists ended sessions with answers in the order of their last answer', async () => {
    const later = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'completed',
      asked: [asked(0, 'עפיפון')],
      answers: [{ position: 0, correct: true, at: '2026-10-06 10:00:00+00' }],
    });
    const earlier = await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'skipped',
      asked: [asked(0, 'עפיפון')],
      answers: [{ position: 0, correct: true, at: '2026-10-05 10:00:00+00' }],
    });
    await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'skipped',
      asked: [asked(0, 'עפיפון')],
      answers: [],
    });
    await insertAnsweredSession(t.db, {
      userId: 'u_1',
      enrollmentId: E,
      status: 'ready',
      asked: [asked(0, 'עפיפון')],
      answers: [{ position: 0, correct: true, at: '2026-10-07 10:00:00+00' }],
    });
    expect(await repo((r) => r.listEndedSessions())).toEqual([earlier, later]);
  });
});
```

Add to `apps/server/tests/integration/repo/vocabulary.test.ts`, inside `describe('insertEntries and deleteEntry', …)`, and add `import { DIMENSIONS } from '@lang-tutor/core/domain';` and `import { readProgress } from '../../support/progressRows';` to the imports:

```ts
  it('gives a new entry its five level 1 progress rows, and a repeat adds none', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITE)] }));
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITES)] }));
    const rows = await readProgress(t.db, E);
    expect(rows.map((row) => row.dimension).sort()).toEqual([...DIMENSIONS].sort());
    expect(rows.every((row) => row.senseId === kite.senseIds[TOY] && row.level === 1)).toBe(true);
  });

  it('takes the progress rows with the entry, and a re-save starts again at level 1', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITE)] }));
    await t.db.execute(sql`update sense_progress set level = 3`);
    await repo((r) => r.deleteEntry({ enrollmentId: E, senseId: kite.senseIds[TOY] }));
    expect(await readProgress(t.db, E)).toEqual([]);
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITE)] }));
    expect((await readProgress(t.db, E)).every((row) => row.level === 1)).toBe(true);
  });
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/repo/progress.test.ts tests/integration/repo/vocabulary.test.ts`
Expected: FAIL, `Cannot find module '../../../src/repo/progress'`.

- [ ] **Step 4: Write the progress repository**

Create `apps/server/src/repo/progress.ts`:

```ts
import type { Question } from '@lang-tutor/core/api';
import type { Dimension } from '@lang-tutor/core/domain';
import { sql } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { sessionProgress, type QuestionOption } from '../db/schema';
import type { AnsweredQuestion, ProgressRow, SnapshotRead, SnapshotRow } from '../domain/progress';
import { canonicalOptions } from './questions';

/** A session's answers as the rule reads them. */
export type SessionEvidence = {
  enrollmentId: string;
  /** The UTC date of the session's last answer: the day the session counts for. */
  day: string;
  /** The last answer's time as Postgres prints it. The recompute compares it with
   *  each entry's save time, and the `::text` round trip keeps microseconds. */
  lastAnsweredAt: string;
  answers: AnsweredQuestion[];
};

// `IN (...)` from a list. Every caller guards the empty list first.
const inList = (values: string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);

/**
 * Phase 20. sense_progress and session_progress. Every statement is scoped to
 * one session or to one enrollment's handful of senses, on a primary key; the
 * list's level aggregate lives in repo/vocabulary.ts.
 *
 * No row locks: an enrollment's progress is written only when one of its
 * sessions ends, its sessions end one at a time (the session row is locked by
 * loadSession and findState, and at most one is open), and the recompute is
 * an offline command.
 */
export function createProgressRepo(tx: Tx) {
  return {
    findSessionEvidence: async (sessionId: string): Promise<SessionEvidence | undefined> => {
      const rows = await tx.execute<{
        enrollment_id: string;
        sense_id: string;
        type: string;
        options: QuestionOption[];
        selected_option_position: number;
        day: string;
        last_answered_at: string;
      }>(sql`
        SELECT s.enrollment_id, q.sense_id, q.type, q.options, a.selected_option_position,
               ((max(a.answered_at) OVER ()) AT TIME ZONE 'UTC')::date::text AS day,
               (max(a.answered_at) OVER ())::text AS last_answered_at
        FROM answers a
        JOIN sessions s  ON s.id = a.session_id
        JOIN questions q ON q.id = a.question_id
        WHERE a.session_id = ${sessionId}
        ORDER BY a.position`);
      if (rows.rows.length === 0) return undefined;
      const first = rows.rows[0];
      return {
        enrollmentId: first.enrollment_id,
        day: first.day,
        lastAnsweredAt: first.last_answered_at,
        answers: rows.rows.map((row) => ({
          senseId: row.sense_id,
          type: row.type as Question['type'],
          // selected_option_position is canonical (sessions.insertAnswer), and
          // question_options_valid makes positions 0..n-1.
          correct: canonicalOptions(row.options)[row.selected_option_position].is_correct,
        })),
      };
    },

    /** The rows of the asked senses that are saved. `savedBy` leaves out a sense
     *  saved after that time: the recompute's "saved by the session's last
     *  answer". The live path passes null. */
    findRows: async (input: {
      enrollmentId: string;
      senseIds: string[];
      savedBy: string | null;
    }): Promise<ProgressRow[]> => {
      if (input.senseIds.length === 0) return [];
      const rows = await tx.execute<{
        sense_id: string;
        dimension: string;
        level: number;
        last_step_on: string | null;
        last_wrong_on: string | null;
      }>(sql`
        SELECT p.sense_id, p.dimension, p.level,
               p.last_step_on::text AS last_step_on, p.last_wrong_on::text AS last_wrong_on
        FROM sense_progress p
        JOIN vocabulary_entries ve ON ve.enrollment_id = p.enrollment_id
                                  AND ve.sense_id = p.sense_id
        WHERE p.enrollment_id = ${input.enrollmentId}
          AND p.sense_id IN (${inList(input.senseIds)})
          ${input.savedBy === null ? sql`` : sql`AND ve.created_at <= ${input.savedBy}::timestamptz`}
        ORDER BY p.sense_id, p.dimension`);
      return rows.rows.map((row) => ({
        senseId: row.sense_id,
        dimension: row.dimension as Dimension,
        level: row.level,
        lastStepOn: row.last_step_on,
        lastWrongOn: row.last_wrong_on,
      }));
    },

    updateRows: async (input: { enrollmentId: string; rows: ProgressRow[] }): Promise<void> => {
      if (input.rows.length === 0) return;
      await tx.execute(sql`
        UPDATE sense_progress p
        SET level = v.level,
            last_step_on = v.last_step_on::date,
            last_wrong_on = v.last_wrong_on::date
        FROM (VALUES ${sql.join(
          input.rows.map(
            (row) =>
              sql`(${row.senseId}::text, ${row.dimension}::text, ${row.level}::int, ${row.lastStepOn}::text, ${row.lastWrongOn}::text)`,
          ),
          sql`, `,
        )}) AS v(sense_id, dimension, level, last_step_on, last_wrong_on)
        WHERE p.enrollment_id = ${input.enrollmentId}
          AND p.sense_id = v.sense_id
          AND p.dimension = v.dimension`);
    },

    insertSnapshot: async (input: { sessionId: string; rows: SnapshotRow[] }): Promise<void> => {
      if (input.rows.length === 0) return;
      await tx.insert(sessionProgress).values(
        input.rows.map((row) => ({
          sessionId: input.sessionId,
          senseId: row.senseId,
          dimension: row.dimension,
          levelBefore: row.levelBefore,
          levelAfter: row.levelAfter,
        })),
      );
    },

    /** The snapshot with the form and right answer of the first question in
     *  the session that asked each sense. */
    findSnapshot: async (sessionId: string): Promise<SnapshotRead[]> => {
      const rows = await tx.execute<{
        sense_id: string;
        dimension: string;
        level_before: number;
        level_after: number;
        form: string;
        options: QuestionOption[];
        position: number;
      }>(sql`
        SELECT sp.sense_id, sp.dimension, sp.level_before, sp.level_after, f.form, f.options, f.position
        FROM session_progress sp
        JOIN LATERAL (
          SELECT v.form, q.options, sq.position
          FROM session_questions sq
          JOIN questions q     ON q.id = sq.question_id
          JOIN dict_variants v ON v.id = q.prompt_variant_id
          WHERE sq.session_id = sp.session_id
            AND q.sense_id = sp.sense_id
          ORDER BY sq.position
          LIMIT 1
        ) f ON true
        WHERE sp.session_id = ${sessionId}`);
      return rows.rows.map((row) => ({
        senseId: row.sense_id,
        dimension: row.dimension as Dimension,
        levelBefore: row.level_before,
        levelAfter: row.level_after,
        form: row.form,
        translation: canonicalOptions(row.options).find((option) => option.is_correct)!.text,
        position: row.position,
      }));
    },

    /** Recompute only: every row back to level 1, and no session's snapshot. */
    resetAll: async (): Promise<void> => {
      await tx.execute(sql`UPDATE sense_progress SET level = 1, last_step_on = NULL, last_wrong_on = NULL`);
      await tx.execute(sql`DELETE FROM session_progress`);
    },

    /** Recompute only: every completed or skipped session that has answers, in
     *  the order of its last answer. An enrollment's sessions run one at a time,
     *  so this is the order they ended in. */
    listEndedSessions: async (): Promise<string[]> => {
      const rows = await tx.execute<{ id: string }>(sql`
        SELECT s.id
        FROM sessions s
        JOIN answers a ON a.session_id = s.id
        WHERE s.status IN ('completed', 'skipped')
        GROUP BY s.id
        ORDER BY max(a.answered_at), s.id`);
      return rows.rows.map((row) => row.id);
    },
  };
}

export type ProgressRepo = ReturnType<typeof createProgressRepo>;
```

- [ ] **Step 5: Make saving write the progress rows**

In `apps/server/src/repo/vocabulary.ts`, add `import { DIMENSIONS } from '@lang-tutor/core/domain';` and replace `vocabularyQueries.insertEntries` with:

```ts
  /** Save: a primary-key insert, and the five progress rows of every entry it
   *  creates, in one statement. Named conflict target, not bare: only the PK
   *  may be swallowed, so an FK violation still raises. First form wins — a
   *  sense already saved keeps its variant, and RETURNING leaves it out, so its
   *  progress is untouched. */
  insertEntries: (input: { enrollmentId: string; entries: SaveableEntry[] }): SQL => sql`
    WITH inserted AS (
      INSERT INTO vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id)
      VALUES ${sql.join(
        input.entries.map(
          (e) => sql`(${input.enrollmentId}, ${e.senseId}, ${e.lexemeId}, ${e.variantId})`,
        ),
        sql`, `,
      )}
      ON CONFLICT (enrollment_id, sense_id) DO NOTHING
      RETURNING enrollment_id, sense_id
    )
    INSERT INTO sense_progress (enrollment_id, sense_id, dimension)
    SELECT i.enrollment_id, i.sense_id, d.dimension
    FROM inserted i
    CROSS JOIN (VALUES ${sql.join(
      DIMENSIONS.map((dimension) => sql`(${dimension}::text)`),
      sql`, `,
    )}) AS d(dimension)`,
```

- [ ] **Step 6: Bind the repository and teach the fakes about it**

In `apps/server/src/services/transaction.ts`, add `import type { ProgressRepo } from '../repo/progress';` and the member `progress: ProgressRepo;` to `Repos`.

In `apps/server/src/composition.ts`, add `import { createProgressRepo } from './repo/progress';` and `progress: createProgressRepo(tx),` to the `createTransaction` bind object.

In `apps/server/tests/support/fakes.ts`, add `progress: repos.progress ?? unreachableRepo('progress repo'),` to `createFakeTransaction`'s `bound` object.

In `apps/server/src/services/sessions.test.ts`, add `import type { ProgressRepo } from '../repo/progress';` beside the other repo imports, then, after the `vocabularyRepo` constant:

```ts
  // Phase 20. The one case here never completes or skips a session, so it never
  // reaches the progress rule.
  const unreachableProgress = () => {
    throw new Error('this case must not touch the progress tables');
  };
  const progressRepo: ProgressRepo = {
    findSessionEvidence: unreachableProgress,
    findRows: unreachableProgress,
    updateRows: unreachableProgress,
    insertSnapshot: unreachableProgress,
    findSnapshot: unreachableProgress,
    resetAll: unreachableProgress,
    listEndedSessions: unreachableProgress,
  };
```

and `progress: progressRepo,` in the object `fakeTransaction` passes to `run`.

- [ ] **Step 7: Save fixtures through the repository**

In `apps/server/tests/support/vocabularyRows.ts`, replace the import of `vocabularyEntries` with `import { createVocabularyRepo } from '../../src/repo/vocabulary';` and `import { withTx } from './withTx';`, and replace the `db.insert(vocabularyEntries).values(…)` call with:

```ts
  // Through the repository, so each entry gets its five progress rows exactly
  // as a real save writes them.
  await withTx(db, (tx) =>
    createVocabularyRepo(tx).insertEntries({
      enrollmentId: input.enrollmentId,
      entries: word.senseIds.map((senseId) => ({ senseId, variantId, lexemeId: word.lexemeId })),
    }),
  );
```

- [ ] **Step 8: Add the factory to ADR 0002**

In `docs/adr/adr-0002-di-with-closures.md`, R6's factory list, insert `` `createProgressRepo`, `` after `` `createVocabularyRepo`, ``.

- [ ] **Step 9: Run the tests**

Run: `npm run typecheck && npm test -w apps/server && bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/repo tests/integration/services tests/integration/jobs tests/integration/composition.test.ts`
Expected: PASS.

- [ ] **Step 10: Lint and commit**

Run: `npm run lint:arch`
Expected: no output.

```bash
git add apps/server docs/adr/adr-0002-di-with-closures.md
git commit -m "feat(server): progress repository; a save writes five progress rows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Session use cases — run the rule when a session ends

**Files:**
- Modify: `apps/server/src/services/sessions.ts`
- Create: `apps/server/src/services/sessions.progress.test.ts`
- Modify: `apps/server/tests/integration/services/sessions.test.ts`

**Interfaces:**
- Consumes: `evaluateSession`, `progressChanges`, `ProgressChange` (Task 2); `Repos.progress` (Task 4); `LIVE_DIMENSIONS` (Task 1).
- Produces:
  - `type SessionResult = SessionRecord & { progress: ProgressChange[] }`, exported from `services/sessions.ts`;
  - `submitAnswer(…): Promise<SessionResult>` and `getSession(id): Promise<SessionResult>`; `progress` is empty unless the session is completed;
  - `submitAnswer` runs the rule in the transaction that completes the session, and `skipSession` in the one that skips it.

- [ ] **Step 1: Write the failing unit tests**

Create `apps/server/src/services/sessions.progress.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import type { Question } from '@lang-tutor/core/api';
import { DIMENSIONS } from '@lang-tutor/core/domain';

import { createFakeLlmClient, createFakeLogger, createFakeTransaction } from '../../tests/support/fakes';
import { testRng } from '../../tests/support/testRng';
import type { ProgressRow, SnapshotRead } from '../domain/progress';
import type { SessionRecord, SessionState } from '../domain/session';
import type { ProgressRepo, SessionEvidence } from '../repo/progress';
import type { SessionRepo } from '../repo/sessions';
import { createSessionService } from './sessions';

// Only the methods a case names exist; any other reach fails with its name.
function stub<T extends object>(methods: Partial<T>): T {
  return new Proxy(methods, {
    get: (target, property) =>
      (target as Record<string | symbol, unknown>)[property] ??
      (() => {
        throw new Error(`${String(property)} is not stubbed`);
      }),
  }) as T;
}

const SESSION = '22222222-2222-2222-2222-222222222222';
const DAY = '2026-10-05';
const question = (n: number): Question => ({
  id: `q${n}`,
  type: 'multiple_choice',
  vocab_term_id: `l${n}`,
  question: `word${n}`,
  options: [`right${n}`, 'a', 'b', 'c'],
  correct_option: 0,
});
const QUESTIONS = Array.from({ length: 10 }, (_, i) => question(i));
const answered = (count: number) =>
  QUESTIONS.slice(0, count).map((q) => ({ question_id: q.id, is_correct: true, answer_string: q.options[0] }));
const record = (count: number): SessionRecord => ({
  user_id: 'u1',
  questions: QUESTIONS,
  answers: answered(count),
  complete: count === QUESTIONS.length,
  completed_at: count === QUESTIONS.length ? 1 : null,
  status: count === QUESTIONS.length ? 'completed' : 'ready',
  source: 'list',
});
const READY: SessionState = { id: SESSION, userId: 'u1', enrollmentId: 'e1', status: 'ready', source: 'list' };
const EVIDENCE: SessionEvidence = {
  enrollmentId: 'e1',
  day: DAY,
  lastAnsweredAt: '2026-10-05 12:00:00+00',
  answers: [
    { senseId: 's1', type: 'multiple_choice', correct: true },
    { senseId: 'sX', type: 'multiple_choice', correct: true },
  ],
};
const ROWS: ProgressRow[] = DIMENSIONS.map((dimension) => ({
  senseId: 's1',
  dimension,
  level: 1,
  lastStepOn: null,
  lastWrongOn: null,
}));
const SNAPSHOT: SnapshotRead[] = DIMENSIONS.map((dimension) => ({
  senseId: 's1',
  dimension,
  levelBefore: 1,
  levelAfter: dimension === 'written_receptive' ? 2 : 1,
  form: 'word0',
  translation: 'right0',
  position: 0,
}));
const CHANGE = [{ senseId: 's1', form: 'word0', translation: 'right0', levelBefore: 1, levelAfter: 2 }];

function world(opts: { record: SessionRecord; evidence?: SessionEvidence | null; rows?: ProgressRow[] }) {
  const calls = {
    completed: 0,
    evidence: 0,
    asked: [] as string[][],
    updated: [] as ProgressRow[][],
    snapshots: [] as unknown[][],
  };
  const session = stub<SessionRepo>({
    loadSession: async () => opts.record,
    insertAnswer: async () => {},
    completeSession: async () => {
      calls.completed += 1;
    },
    findState: async () => READY,
    transition: async () => true,
  });
  const progress = stub<ProgressRepo>({
    findSessionEvidence: async () => {
      calls.evidence += 1;
      return opts.evidence === null ? undefined : (opts.evidence ?? EVIDENCE);
    },
    findRows: async (input) => {
      calls.asked.push(input.senseIds);
      return opts.rows ?? ROWS;
    },
    updateRows: async (input) => {
      calls.updated.push(input.rows);
    },
    insertSnapshot: async (input) => {
      calls.snapshots.push(input.rows);
    },
    findSnapshot: async () => SNAPSHOT,
  });
  const service = createSessionService({
    transaction: createFakeTransaction({ session, progress }),
    rng: testRng(7),
    logger: createFakeLogger(),
    llm: createFakeLlmClient(''),
  });
  return { service, calls };
}

describe('progress when a session ends', () => {
  it('completing a session runs the rule over its answers and answers with the change', async () => {
    const { service, calls } = world({ record: record(9) });
    const result = await service.submitAnswer(SESSION, 'q9', 0);
    expect(calls.completed).toBe(1);
    expect(calls.asked).toEqual([['s1', 'sX']]);
    expect(calls.updated).toEqual([
      [{ senseId: 's1', dimension: 'written_receptive', level: 2, lastStepOn: DAY, lastWrongOn: null }],
    ]);
    expect(calls.snapshots[0]).toHaveLength(5);
    expect(result.progress).toEqual(CHANGE);
  });

  it('an answer that does not complete the session writes no progress', async () => {
    const { service, calls } = world({ record: record(8) });
    const result = await service.submitAnswer(SESSION, 'q8', 0);
    expect(calls.evidence).toBe(0);
    expect(result.progress).toEqual([]);
  });

  it('a replayed final answer writes nothing and still answers with the change', async () => {
    const { service, calls } = world({ record: record(10) });
    const result = await service.submitAnswer(SESSION, 'q9', 0);
    expect(calls.evidence).toBe(0);
    expect(result.progress).toEqual(CHANGE);
  });

  it('a skip runs the rule over the answers given so far', async () => {
    const { service, calls } = world({ record: record(3) });
    await service.skipSession(SESSION);
    expect(calls.evidence).toBe(1);
    expect(calls.updated).toHaveLength(1);
  });

  it('a skip with no answers writes nothing', async () => {
    const { service, calls } = world({ record: record(0), evidence: null });
    await service.skipSession(SESSION);
    expect(calls.asked).toEqual([]);
    expect(calls.updated).toEqual([]);
    expect(calls.snapshots).toEqual([]);
  });

  it('a session about senses that are not saved writes nothing', async () => {
    const { service, calls } = world({ record: record(9), rows: [] });
    await service.submitAnswer(SESSION, 'q9', 0);
    expect(calls.asked).toHaveLength(1);
    expect(calls.updated).toEqual([]);
    expect(calls.snapshots).toEqual([]);
  });

  it('getSession answers a completed session with its change, and any other with none', async () => {
    expect((await world({ record: record(10) }).service.getSession(SESSION)).progress).toEqual(CHANGE);
    expect((await world({ record: record(4) }).service.getSession(SESSION)).progress).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test -w apps/server -- src/services/sessions.progress.test.ts`
Expected: FAIL. In the first case `calls.completed` is 1 but `calls.asked` is `[]`, and `result.progress` is `undefined`.

- [ ] **Step 3: Implement**

In `apps/server/src/services/sessions.ts`:

1. Add to the imports:

```ts
import { LIVE_DIMENSIONS } from '@lang-tutor/core/domain';
import { evaluateSession, progressChanges, type ProgressChange } from '../domain/progress';
```

and change `import type { Transaction } from './transaction';` to `import type { Repos, Transaction } from './transaction';`.

2. After `logCompletedSession`, add:

```ts
/** A session as the routes answer it: the record, and what it did to the
 *  learner's saved words, which is empty until it is completed. */
export type SessionResult = SessionRecord & { progress: ProgressChange[] };

/**
 * Phase 20. Runs the progress rule over an ended session's answers, inside the
 * transaction that ended it. The status change and these writes are dependent
 * (ADR 0001 R8, spec §3): an ended session without its progress, or progress
 * for a session that did not end, would each be wrong.
 *
 * A sense with no rows is not saved, so it is skipped: that is the whole of
 * "only answers given while saved count". A session with no answers has no
 * evidence and writes nothing.
 */
async function recordProgress(repos: Repos, sessionId: string): Promise<void> {
  const evidence = await repos.progress.findSessionEvidence(sessionId);
  if (!evidence) return;
  const rows = await repos.progress.findRows({
    enrollmentId: evidence.enrollmentId,
    senseIds: [...new Set(evidence.answers.map((answer) => answer.senseId))],
    savedBy: null,
  });
  if (rows.length === 0) return;
  const outcome = evaluateSession(rows, evidence.answers, evidence.day);
  await repos.progress.updateRows({ enrollmentId: evidence.enrollmentId, rows: outcome.changed });
  await repos.progress.insertSnapshot({ sessionId, rows: outcome.snapshot });
}

/** What a completed session did, as badges. Empty for any other status. */
async function progressOf(repos: Repos, sessionId: string, record: SessionRecord): Promise<ProgressChange[]> {
  if (record.status !== 'completed') return [];
  return progressChanges(await repos.progress.findSnapshot(sessionId), LIVE_DIMENSIONS);
}
```

3. Replace `getSession` with:

```ts
    /** Resume and the poll both read through this. A completed session also
     *  carries what it did to the saved words. */
    getSession: (sessionId: string): Promise<SessionResult> =>
      transaction(async (repos) => {
        const record = await repos.session.loadSession(sessionId);
        if (!record) throw new SessionNotFound(sessionId);
        return { ...record, progress: await progressOf(repos, sessionId, record) };
      }),
```

4. In `skipSession`, replace the transaction body with:

```ts
      const skipped = await transaction(async (repos) => {
        const state = await repos.session.findState(sessionId);
        if (!state) throw new SessionNotFound(sessionId);
        if (state.status === 'skipped') return false;
        if (!isOpen(state.status)) throw new SessionNotSkippable(sessionId, state.status);
        const changed = await repos.session.transition(sessionId, ['preparing', 'ready'], 'skipped');
        // Phase 20. The answers given before the skip are real answers.
        if (changed) await recordProgress(repos, sessionId);
        return changed;
      });
```

and update its doc comment's last sentence to: `A skip counts the answers given before it toward progress.`

5. Replace `submitAnswer` with:

```ts
    submitAnswer: async (
      sessionId: string,
      questionId: string,
      optionIndex: number,
    ): Promise<SessionResult> => {
      // The transaction returns its outcome and the log fires after it resolves:
      // a commit that fails after completeSession must not leave a log claiming a
      // session the database never recorded.
      const { result, justCompleted } = await transaction(async (repos) => {
        const loaded = await repos.session.loadSession(sessionId);
        if (!loaded) throw new SessionNotFound(sessionId);

        // Phase 19. Preparing, skipped and failed sessions take no answers. A
        // completed one still reaches `step`, whose replay path answers a retry.
        if (loaded.status !== 'ready' && loaded.status !== 'completed') {
          throw new SessionNotReady(sessionId, loaded.status);
        }

        // Three failure modes, three domain outcomes, three errors — the domain
        // decides what is wrong, this layer only names it.
        const outcome = step(loaded, questionId, optionIndex);
        if (outcome.status === 'invalid_question') throw new QuestionDesynced(questionId);
        if (outcome.status === 'out_of_range') throw new OptionOutOfRange(optionIndex);
        // A replay reports justCompleted: false, so retrying a completed session
        // logs nothing and writes no progress.
        if (outcome.status === 'replayed') {
          const progress = await progressOf(repos, sessionId, outcome.record);
          return { result: { ...outcome.record, progress }, justCompleted: false };
        }

        await repos.session.insertAnswer(sessionId, loaded.answers.length, questionId, optionIndex);

        if (outcome.justCompleted) {
          await repos.session.completeSession(sessionId);
          await recordProgress(repos, sessionId);
        }

        const progress = await progressOf(repos, sessionId, outcome.record);
        return { result: { ...outcome.record, progress }, justCompleted: outcome.justCompleted };
      });

      if (justCompleted) {
        logCompletedSession(logger, sessionId, result);
      }

      return result;
    },
```

- [ ] **Step 4: Run the unit tests**

Run: `npm test -w apps/server`
Expected: PASS.

- [ ] **Step 5: Write the failing integration tests**

In `apps/server/tests/integration/services/sessions.test.ts`, add these imports. ADR 0001's R2 test scan forbids this folder from importing `src/repo/` except as types, so the unsave case below goes through the vocabulary service from the same deps:

```ts
import type { SessionRecord } from '../../../src/domain/session';
import type { VocabularyService } from '../../../src/services/vocabulary';
import {
  failInsertsInto,
  readProgress,
  readSnapshot,
  saveSessionSenses,
  sessionDay,
} from '../../support/progressRows';
```

Add `let vocabulary: VocabularyService;` beside `let service: SessionService;`, and in `beforeEach` replace the `service = …` line with:

```ts
  const deps = createTestServerDeps({ db: t.db, logger, rng: testRng(7), boss });
  service = deps.sessions;
  vocabulary = deps.vocabulary;
```

Append:

```ts
describe('progress (phase 20)', () => {
  const E = enrollmentOf('u_1');

  /** The seed, with the senses of its first three questions saved. */
  async function seedWithSavedSenses() {
    const { sessionId, record } = await startSeed(E);
    const saved = await saveSessionSenses(t.db, { sessionId, enrollmentId: E, positions: [0, 1, 2] });
    return { sessionId, record, saved };
  }

  async function answer(sessionId: string, q: SessionRecord['questions'][number], right: boolean) {
    return service.submitAnswer(sessionId, q.id, right ? q.correct_option : (q.correct_option + 1) % q.options.length);
  }

  async function answerAll(sessionId: string, record: SessionRecord, wrongAt: number[] = []) {
    let last;
    for (const [i, q] of record.questions.entries()) last = await answer(sessionId, q, !wrongAt.includes(i));
    return last!;
  }

  const receptive = (rows: Awaited<ReturnType<typeof readProgress>>, senseId: string) =>
    rows.find((row) => row.senseId === senseId && row.dimension === 'written_receptive');

  it('completing a session lifts each saved sense answered right, and records what it did', async () => {
    const { sessionId, record, saved } = await seedWithSavedSenses();
    const result = await answerAll(sessionId, record, [1]);
    const day = await sessionDay(t.db, sessionId);
    const rows = await readProgress(t.db, E);

    expect(receptive(rows, saved[0])).toMatchObject({ level: 2, lastStepOn: day, lastWrongOn: null });
    expect(receptive(rows, saved[1])).toMatchObject({ level: 1, lastStepOn: null, lastWrongOn: day });
    expect(receptive(rows, saved[2])).toMatchObject({ level: 2, lastStepOn: day });
    expect(rows.filter((row) => row.dimension !== 'written_receptive').every((row) => row.level === 1)).toBe(true);
    expect(await readSnapshot(t.db, sessionId)).toHaveLength(15);
    expect(result.progress.map((p) => [p.senseId, p.levelBefore, p.levelAfter])).toEqual([
      [saved[0], 1, 2],
      [saved[1], 1, 1],
      [saved[2], 1, 2],
    ]);
  });

  it('a skip counts the answers given before it', async () => {
    const { sessionId, record, saved } = await seedWithSavedSenses();
    await answer(sessionId, record.questions[0], true);
    await service.skipSession(sessionId);
    const rows = await readProgress(t.db, E);
    expect(receptive(rows, saved[0])).toMatchObject({ level: 2 });
    expect(rows.filter((row) => row.senseId !== saved[0]).every((row) => row.level === 1)).toBe(true);
    expect(await readSnapshot(t.db, sessionId)).toHaveLength(5);
  });

  it('a skip with no answers writes nothing', async () => {
    const { sessionId } = await seedWithSavedSenses();
    await service.skipSession(sessionId);
    expect((await readProgress(t.db, E)).every((row) => row.level === 1 && row.lastWrongOn === null)).toBe(true);
    expect(await readSnapshot(t.db, sessionId)).toEqual([]);
  });

  it('answers about senses that are not saved write nothing', async () => {
    const { sessionId, record } = await startSeed(E);
    const result = await answerAll(sessionId, record);
    expect(await readProgress(t.db, E)).toEqual([]);
    expect(await readSnapshot(t.db, sessionId)).toEqual([]);
    expect(result.progress).toEqual([]);
  });

  // Review Focus 2: a sense unsaved while its session is open.
  it('a sense unsaved mid-session is left out when the session completes', async () => {
    const { sessionId, record, saved } = await seedWithSavedSenses();
    await answer(sessionId, record.questions[0], true);
    await vocabulary.unsave(E, saved[0]);
    for (const q of record.questions.slice(1)) await answer(sessionId, q, true);

    const finished = await service.getSession(sessionId);
    expect(finished.status).toBe('completed');
    const rows = await readProgress(t.db, E);
    expect(rows.some((row) => row.senseId === saved[0])).toBe(false);
    expect(receptive(rows, saved[1])).toMatchObject({ level: 2 });
    expect(finished.progress.map((p) => p.senseId)).toEqual([saved[1], saved[2]]);
  });

  it('completion and its progress are one transaction', async () => {
    const { sessionId, record } = await seedWithSavedSenses();
    for (const q of record.questions.slice(0, 9)) await answer(sessionId, q, true);
    await failInsertsInto(t.db, 'session_progress');
    await expect(answer(sessionId, record.questions[9], true)).rejects.toThrow();
    const after = await service.getSession(sessionId);
    expect(after).toMatchObject({ status: 'ready', complete: false });
    expect(after.answers).toHaveLength(9);
    expect((await readProgress(t.db, E)).every((row) => row.level === 1)).toBe(true);
  });

  it('a skip and its progress are one transaction', async () => {
    const { sessionId, record } = await seedWithSavedSenses();
    await answer(sessionId, record.questions[0], true);
    await failInsertsInto(t.db, 'session_progress');
    await expect(service.skipSession(sessionId)).rejects.toThrow();
    expect((await service.getSession(sessionId)).status).toBe('ready');
    expect((await readProgress(t.db, E)).every((row) => row.level === 1)).toBe(true);
  });

  it('getSession answers a completed session with the change it made', async () => {
    const { sessionId, record, saved } = await seedWithSavedSenses();
    const finished = await answerAll(sessionId, record);
    expect(finished.progress.map((p) => p.senseId)).toEqual(saved);
    expect((await service.getSession(sessionId)).progress).toEqual(finished.progress);
  });
});
```

- [ ] **Step 6: Run the integration tests**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/services/sessions.test.ts tests/integration/session-flow.test.ts tests/integration/jobs tests/integration/composition.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck, lint and commit**

Run: `npm run typecheck && npm run lint:arch`
Expected: clean.

```bash
git add apps/server
git commit -m "feat(server): a session's end moves its saved senses' progress

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Wire and routes — the `progress` block on a completed session

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (`SessionViewSchema`, `NextStepResponseSchema`)
- Modify: `apps/server/src/routes/sessions.ts`
- Modify: `apps/server/tests/integration/routes/sessions.test.ts`

**Interfaces:**
- Consumes: `SessionProgressItemSchema` (Task 1); `SessionResult`, `ProgressChange` (Tasks 5 and 2).
- Produces: `progress: SessionProgressItem[]` on the completed `NextStepResponse` and on every `SessionView`, empty unless the session is completed.

- [ ] **Step 1: Write the failing route tests**

In `apps/server/tests/integration/routes/sessions.test.ts`, add `import { saveSessionSenses } from '../../support/progressRows';` and append:

```ts
describe('the progress block (phase 20)', () => {
  type Item = { sense_id: string; form: string; translation: string; level_before: number; level_after: number };
  type Step = { complete: boolean; question: SeedView['question'] | null; progress?: Item[] };

  /** Answers all ten questions right; returns the last response and the questions asked. */
  async function answerAll(app: Hono, first: SeedView) {
    const asked: SeedView['question'][] = [];
    let current = first.question;
    let last: Step = { complete: false, question: current };
    for (let i = 0; i < 10; i += 1) {
      asked.push(current);
      last = (await (
        await postJson(app, `/api/sessions/${first.session_id}/next-step`, {
          user_id: 'u_1',
          question_id: current.id,
          option_index: current.correct_option,
        })
      ).json()) as Step;
      if (!last.complete) current = last.question!;
    }
    return { last, asked };
  }

  it('the completing answer carries what the session did to the saved words, and a read repeats it', async () => {
    const app = buildTestApp();
    const first = await startSeed(app, enrollmentOf('u_1'));
    const [s0, s1] = await saveSessionSenses(t.db, {
      sessionId: first.session_id,
      enrollmentId: enrollmentOf('u_1'),
      positions: [0, 1],
    });

    const { last, asked } = await answerAll(app, first);
    expect(last.complete).toBe(true);
    expect(last.progress).toEqual([
      { sense_id: s0, form: asked[0].question, translation: asked[0].options[asked[0].correct_option], level_before: 1, level_after: 2 },
      { sense_id: s1, form: asked[1].question, translation: asked[1].options[asked[1].correct_option], level_before: 1, level_after: 2 },
    ]);

    const read = await (await getJson(app, `/api/sessions/${first.session_id}`)).json();
    expect(read.progress).toEqual(last.progress);
  });

  it('is empty for an open session, and for one about words that are not saved', async () => {
    const app = buildTestApp();
    const first = await startSeed(app, enrollmentOf('u_1'));
    expect((first as SeedView & { progress: unknown }).progress).toEqual([]);
    const { last } = await answerAll(app, first);
    expect(last.progress).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/routes/sessions.test.ts`
Expected: FAIL, `progress` is `undefined`.

- [ ] **Step 3: Extend the schemas**

In `packages/core/src/api/schemas.ts`:

- in `SessionViewSchema`, after `question: QuestionSchema.nullable(),`, add:

```ts
  // Phase 20. What a completed session did to the saved words; empty otherwise.
  progress: z.array(SessionProgressItemSchema),
```

- in `NextStepResponseSchema`'s `complete: true` member, after `missed_questions: z.array(MissedQuestionSchema),`, add:

```ts
    // Phase 20. Every practised saved sense, with its badge before and after.
    progress: z.array(SessionProgressItemSchema),
```

- [ ] **Step 4: Return it from the routes**

In `apps/server/src/routes/sessions.ts`:

- add `import type { ProgressChange } from '../domain/progress';` and change the service import to `import type { SessionResult, SessionService } from '../services/sessions';`;
- add, after the `failure` helper:

```ts
const progressItem = (change: ProgressChange) => ({
  sense_id: change.senseId,
  form: change.form,
  translation: change.translation,
  level_before: change.levelBefore,
  level_after: change.levelAfter,
});
```

- change `buildNextStepResponse`'s second parameter to `result: SessionResult`, rename its uses of `record` to `result`, and add `progress: result.progress.map(progressItem),` after `missed_questions` in the complete branch;
- change `sessionView`'s second parameter to `result: SessionResult`, rename its uses of `record` to `result`, and add `progress: result.progress.map(progressItem),` to the object it returns;
- in `nextStepRoute`'s 200 description, append ` The completing response also carries \`progress\`: each practised saved word with its level before and after.`

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npm test -w apps/server && bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/routes tests/integration/app.test.ts tests/integration/session-flow.test.ts`
Expected: PASS. `npm run typecheck` also covers `apps/mobile`, which reads these types and ignores the new field.

- [ ] **Step 6: Lint and commit**

Run: `npm run lint:arch`

```bash
git add packages/core apps/server
git commit -m "feat(server): a completed session answers with its progress

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The word list — level, sort and filter

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (`VocabularyPageQuerySchema`, `VocabularyWordSchema`)
- Modify: `apps/server/src/domain/vocabulary.ts`, `apps/server/src/domain/vocabulary.test.ts`
- Modify: `apps/server/src/repo/vocabulary.ts` (`wordsPage`, `findWordsPage`)
- Modify: `apps/server/src/services/vocabulary.ts` (`listWords`)
- Modify: `apps/server/src/routes/vocabulary.ts` (`listRoute` descriptions)
- Modify: `apps/server/tests/integration/repo/vocabulary.test.ts`, `apps/server/tests/integration/repo/vocabulary.plan.test.ts`, `apps/server/tests/integration/routes/vocabulary.test.ts`

**Interfaces:**
- Consumes: `VocabularySortSchema`, `LevelSchema`, `LIVE_DIMENSIONS`, `MIN_LEVEL`, `MAX_LEVEL` (Task 1); progress rows written on save (Task 4); `insertProgressRows`, `setLevel` (Task 4).
- Produces:
  - `type VocabularyCursor = { sort: 'newest'; savedAt: string; lexemeId: string } | { sort: 'level_asc' | 'level_desc'; savedAt: string; lexemeId: string; level: number }`;
  - `WordPageRow` gains `level: number`; `cursorAfter(sort, row): VocabularyCursor`;
  - `vocabularyQueries.wordsPage` and `findWordsPage` take `{ enrollmentId, limit, after, sort: VocabularySort, level: number | null, live: readonly Dimension[] }`;
  - `VocabularyWord.level`; query params `sort` and `level`.

- [ ] **Step 1: Write the failing domain tests**

In `apps/server/src/domain/vocabulary.test.ts`:

- add `cursorAfter` to the import from `./vocabulary`;
- change `const cursor = { savedAt: '2026-10-04 12:00:00.123456+00', lexemeId: 'lx-1' };` to `const cursor = { sort: 'newest' as const, savedAt: '2026-10-04 12:00:00.123456+00', lexemeId: 'lx-1' };`;
- in *accepts a leap day…*, change the expectation to `toEqual({ sort: 'newest', savedAt, lexemeId: 'lx-1' })`;
- in *round-trips a whole second…*, change `plain` to `{ sort: 'newest' as const, savedAt: '2026-10-04 12:00:00+05:30', lexemeId: 'lx-2' }`;
- in `assemblePage`'s two tests, give every page row a level — `{ lexemeId: 'b', lastSavedAt: 't2', level: 3 }`, `{ lexemeId: 'a', lastSavedAt: 't1', level: 1 }`, `{ lexemeId: 'a', lastSavedAt: 't2', level: 1 }`, `{ lexemeId: 'gone', lastSavedAt: 't1', level: 1 }` — and add `level: 3,` to the expected `page[0]` object.

Then add inside `describe('the cursor', …)`:

```ts
  // Review Focus 5: a phase 18 cursor an app already holds.
  it('reads a two-element cursor as a newest-sort cursor', () => {
    expect(decodeCursor(cursorOf('2026-10-04 12:00:00+00', 'lx-1'))).toEqual({
      sort: 'newest',
      savedAt: '2026-10-04 12:00:00+00',
      lexemeId: 'lx-1',
    });
  });

  it('round-trips a level-sort cursor', () => {
    for (const sort of ['level_asc', 'level_desc'] as const) {
      const levelCursor = { sort, savedAt: '2026-10-04 12:00:00.5+00', lexemeId: 'lx-3', level: 4 };
      expect(decodeCursor(encodeCursor(levelCursor))).toEqual(levelCursor);
    }
  });

  const fourOf = (sort: unknown, level: unknown) =>
    Buffer.from(JSON.stringify(['2026-10-04 12:00:00+00', 'lx-1', sort, level]), 'utf8').toString('base64url');

  it.each([
    ['an unknown sort', fourOf('oldest', 2)],
    ['newest in the four-element form', fourOf('newest', 2)],
    ['level 0', fourOf('level_asc', 0)],
    ['level 6', fourOf('level_asc', 6)],
    ['a fractional level', fourOf('level_desc', 2.5)],
    ['a level as a string', fourOf('level_desc', '2')],
  ])('refuses a level cursor with %s', (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });
```

and a new block:

```ts
describe('cursorAfter', () => {
  const row = { lexemeId: 'lx-9', lastSavedAt: '2026-10-04 12:00:00+00', level: 2 };

  it('carries the level only for a level sort', () => {
    expect(cursorAfter('newest', row)).toEqual({ sort: 'newest', savedAt: row.lastSavedAt, lexemeId: 'lx-9' });
    expect(cursorAfter('level_desc', row)).toEqual({
      sort: 'level_desc',
      savedAt: row.lastSavedAt,
      lexemeId: 'lx-9',
      level: 2,
    });
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test -w apps/server -- src/domain/vocabulary.test.ts`
Expected: FAIL, `cursorAfter` is not exported and decoded cursors lack `sort`.

- [ ] **Step 3: Implement the domain changes**

In `apps/server/src/domain/vocabulary.ts`:

1. Add `VocabularySort` to the `@lang-tutor/core/api` type import, and add `import { MAX_LEVEL, MIN_LEVEL } from '@lang-tutor/core/domain';`.

2. Replace the `VocabularyCursor` type and its comment with:

```ts
/**
 * Where the next list page starts: the last row's newest save and its lexeme
 * id, and under a level sort its level too. The sort is in the cursor so one
 * replayed under another sort is refused rather than read as a wrong position.
 *
 * `savedAt` is Postgres's own text for a timestamptz, never a JS Date. A Date
 * keeps milliseconds and created_at keeps microseconds, so a cursor rounded down
 * would silently skip every word saved later in the same millisecond. The
 * repository prints it with `::text` and casts it back with `::timestamptz`, and
 * the round trip is exact.
 */
export type VocabularyCursor =
  | { sort: 'newest'; savedAt: string; lexemeId: string }
  | { sort: 'level_asc' | 'level_desc'; savedAt: string; lexemeId: string; level: number };
```

3. Replace `encodeCursor` and `decodeCursor` with:

```ts
/** A newest-sort cursor keeps phase 18's two-element form, so a cursor an app
 *  already holds stays valid. A level-sort cursor carries four elements. */
export function encodeCursor(cursor: VocabularyCursor): string {
  const fields =
    cursor.sort === 'newest'
      ? [cursor.savedAt, cursor.lexemeId]
      : [cursor.savedAt, cursor.lexemeId, cursor.sort, cursor.level];
  return Buffer.from(JSON.stringify(fields), 'utf8').toString('base64url');
}

/** `null` for anything this server did not issue. The caller turns that into a 400. */
export function decodeCursor(raw: string): VocabularyCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || (parsed.length !== 2 && parsed.length !== 4)) return null;
  const [savedAt, lexemeId, sort, level] = parsed as unknown[];
  if (typeof savedAt !== 'string' || !isRealTimestamptz(savedAt)) return null;
  // A NUL cannot be a Postgres text parameter: it would raise there, a 500.
  if (typeof lexemeId !== 'string' || lexemeId.length === 0 || lexemeId.includes('\u0000')) {
    return null;
  }
  if (parsed.length === 2) return { sort: 'newest', savedAt, lexemeId };
  if (sort !== 'level_asc' && sort !== 'level_desc') return null;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    return null;
  }
  return { sort, savedAt, lexemeId, level };
}
```

4. Change `WordPageRow` to:

```ts
/** One row of the grouped keyset read, in page order. `level` is the word's
 *  badge: the rounded mean over its saved senses and the live dimensions. */
export type WordPageRow = { lexemeId: string; lastSavedAt: string; level: number };

/** The cursor that continues after `row` under `sort`. */
export function cursorAfter(sort: VocabularySort, row: WordPageRow): VocabularyCursor {
  return sort === 'newest'
    ? { sort, savedAt: row.lastSavedAt, lexemeId: row.lexemeId }
    : { sort, savedAt: row.lastSavedAt, lexemeId: row.lexemeId, level: row.level };
}
```

5. In `assemblePage`, add `level: row.level,` after `sense_count: s.senseCount,`.

- [ ] **Step 4: Run the domain tests**

Run: `npm test -w apps/server -- src/domain/vocabulary.test.ts`
Expected: PASS. Typecheck fails until Step 7; that is expected.

- [ ] **Step 5: Write the failing repository tests**

In `apps/server/tests/integration/repo/vocabulary.test.ts`:

- add `import { LIVE_DIMENSIONS } from '@lang-tutor/core/domain';`, `import type { VocabularyCursor } from '../../../src/domain/vocabulary';`, and add `insertProgressRows, setLevel` to the `../../support/progressRows` import;
- after the `pair` helper add:

```ts
// What every phase 18 test meant by a page: newest first, no filter.
const NEWEST = { sort: 'newest' as const, level: null, live: LIVE_DIMENSIONS };
```

- in each of the five `r.findWordsPage({ … })` calls, add `...NEWEST,` as the first property; in the call with a cursor, change `after` to `{ sort: 'newest', savedAt: last.lastSavedAt, lexemeId: last.lexemeId }`;
- in `saveAt`, after the insert, add `await insertProgressRows(t.db, E, [senseId]);` — an entry with no progress rows has no level, and the list leaves it out.

Append to `describe('findWordsPage', …)`:

```ts
  async function leveled(levels: number[]) {
    const words = await lexemes(levels.length);
    for (const [i, word] of words.entries()) {
      await saveAt(word.lexemeId, word.senseId, word.variantId, `2026-10-04 12:00:0${i}+00`);
      await setLevel(t.db, { enrollmentId: E, senseId: word.senseId, level: levels[i] });
    }
    return words.map((word) => word.lexemeId);
  }
  const wordsPage = (input: {
    sort: 'newest' | 'level_asc' | 'level_desc';
    level?: number | null;
    after?: VocabularyCursor;
    limit?: number;
  }) =>
    repo((r) =>
      r.findWordsPage({
        enrollmentId: E,
        limit: input.limit ?? 50,
        after: input.after ?? null,
        sort: input.sort,
        level: input.level ?? null,
        live: LIVE_DIMENSIONS,
      }),
    );

  it('gives each row its level', async () => {
    const [w0] = await leveled([3]);
    expect(await wordsPage({ sort: 'newest' })).toEqual([{ lexemeId: w0, lastSavedAt: expect.any(String), level: 3 }]);
  });

  it("averages a word's saved senses, rounding a tie up", async () => {
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:01+00');
    await setLevel(t.db, { enrollmentId: E, senseId: kite.senseIds[TOY], level: 2 });
    await setLevel(t.db, { enrollmentId: E, senseId: kite.senseIds[BIRD], level: 3 });
    expect((await wordsPage({ sort: 'newest' }))[0].level).toBe(3);
  });

  it('reads only the live dimensions', async () => {
    const [w] = await lexemes(1);
    await saveAt(w.lexemeId, w.senseId, w.variantId, '2026-10-04 12:00:00+00');
    await setLevel(t.db, { enrollmentId: E, senseId: w.senseId, level: 5, dimension: 'spelling' });
    expect(await wordsPage({ sort: 'newest' })).toEqual([expect.objectContaining({ lexemeId: w.lexemeId, level: 1 })]);
  });

  it('sorts by level both ways, the newer save first within a level', async () => {
    const [low, highOld, highNew, mid] = await leveled([1, 4, 4, 2]);
    expect((await wordsPage({ sort: 'level_desc' })).map((r) => r.lexemeId)).toEqual([highNew, highOld, mid, low]);
    expect((await wordsPage({ sort: 'level_asc' })).map((r) => r.lexemeId)).toEqual([low, mid, highNew, highOld]);
  });

  it('filters to one level under any sort', async () => {
    const [, highOld, highNew] = await leveled([1, 4, 4, 2]);
    expect((await wordsPage({ sort: 'newest', level: 4 })).map((r) => r.lexemeId)).toEqual([highNew, highOld]);
    expect(await wordsPage({ sort: 'level_asc', level: 3 })).toEqual([]);
  });

  it.each(['level_asc', 'level_desc'] as const)('continues a %s walk strictly after its cursor', async (sort) => {
    await leveled([2, 1, 2, 3, 1]);
    const all = await wordsPage({ sort });
    const first = await wordsPage({ sort, limit: 2 });
    const last = first[first.length - 1];
    const rest = await wordsPage({ sort, after: { sort, savedAt: last.lastSavedAt, lexemeId: last.lexemeId, level: last.level } });
    expect([...first, ...rest].map((r) => r.lexemeId)).toEqual(all.map((r) => r.lexemeId));
  });
```

- [ ] **Step 6: Run them to make sure they fail**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/repo/vocabulary.test.ts`
Expected: FAIL. Rows have no `level`, and the level sorts come back newest first.

- [ ] **Step 7: Implement the list query and the service**

In `apps/server/src/repo/vocabulary.ts`:

1. Add `VocabularySort` to a new `import type { VocabularySort } from '@lang-tutor/core/api';`, change the core domain import to `import { DIMENSIONS, type Dimension } from '@lang-tutor/core/domain';`.

2. Above `vocabularyQueries`, add:

```ts
// A word's badge: the rounded mean of its saved senses' live-dimension levels,
// ties up. badge() in packages/core is the same arithmetic in TypeScript.
const LEVEL = sql`floor(avg(p.level) + 0.5)::int`;
const SAVED_AT = sql`max(ve.created_at)`;

function orderBy(sort: VocabularySort): SQL {
  switch (sort) {
    case 'newest':
      return sql`${SAVED_AT} DESC, ve.lexeme_id DESC`;
    case 'level_asc':
      return sql`${LEVEL} ASC, ${SAVED_AT} DESC, ve.lexeme_id DESC`;
    case 'level_desc':
      return sql`${LEVEL} DESC, ${SAVED_AT} DESC, ve.lexeme_id DESC`;
  }
}

/** Strictly after the cursor in the order orderBy gives. level_asc mixes
 *  directions, so it cannot be one row comparison. */
function afterCursor(after: VocabularyCursor): SQL {
  const position = sql`(${after.savedAt}::timestamptz, ${after.lexemeId}::text)`;
  switch (after.sort) {
    case 'newest':
      return sql`(${SAVED_AT}, ve.lexeme_id) < ${position}`;
    case 'level_desc':
      return sql`(${LEVEL}, ${SAVED_AT}, ve.lexeme_id) < (${after.level}::int, ${after.savedAt}::timestamptz, ${after.lexemeId}::text)`;
    case 'level_asc':
      return sql`(${LEVEL} > ${after.level}::int OR (${LEVEL} = ${after.level}::int AND (${SAVED_AT}, ve.lexeme_id) < ${position}))`;
  }
}
```

3. Replace `vocabularyQueries.wordsPage` and its comment with:

```ts
  /**
   * One page of lexemes with their level, in the asked order, optionally one
   * level only. The join reads this enrollment's live-dimension progress rows
   * through sense_progress_enrollment_dimension_idx, an index-only scan.
   *
   * The timestamp goes out as `::text` and comes back with `::timestamptz` —
   * microseconds intact; see VocabularyCursor. The comparison is strictly
   * "after the cursor", so a word that moves between pages is never served
   * twice in one walk.
   */
  wordsPage: (input: {
    enrollmentId: string;
    limit: number;
    after: VocabularyCursor | null;
    sort: VocabularySort;
    level: number | null;
    live: readonly Dimension[];
  }): SQL => {
    const having: SQL[] = [];
    if (input.level !== null) having.push(sql`${LEVEL} = ${input.level}`);
    if (input.after) having.push(afterCursor(input.after));
    return sql`
      SELECT ve.lexeme_id, ${SAVED_AT}::text AS last_saved_at, ${LEVEL} AS level
      FROM vocabulary_entries ve
      JOIN sense_progress p ON p.enrollment_id = ve.enrollment_id
                           AND p.sense_id = ve.sense_id
                           AND p.dimension IN (${inList([...input.live])})
      WHERE ve.enrollment_id = ${input.enrollmentId}
      GROUP BY ve.lexeme_id
      ${having.length > 0 ? sql`HAVING ${sql.join(having, sql` AND `)}` : sql``}
      ORDER BY ${orderBy(input.sort)}
      LIMIT ${input.limit}`;
  },
```

4. Replace `findWordsPage` with:

```ts
    findWordsPage: async (input: {
      enrollmentId: string;
      limit: number;
      after: VocabularyCursor | null;
      sort: VocabularySort;
      level: number | null;
      live: readonly Dimension[];
    }): Promise<WordPageRow[]> => {
      const rows = await tx.execute<{ lexeme_id: string; last_saved_at: string; level: number }>(
        vocabularyQueries.wordsPage(input),
      );
      return rows.rows.map((row) => ({
        lexemeId: row.lexeme_id,
        lastSavedAt: row.last_saved_at,
        level: row.level,
      }));
    },
```

`DIMENSIONS` is still used by `insertEntries`.

In `apps/server/src/services/vocabulary.ts`:

1. Add `import { LIVE_DIMENSIONS } from '@lang-tutor/core/domain';` and add `cursorAfter` to the `../domain/vocabulary` import (drop `encodeCursor` from it only if nothing else uses it; `listWords` still does).

2. Replace `listWords` with:

```ts
    /**
     * Keyset pagination. One extra row is read to learn whether a next page
     * exists; the cursor is the last row KEPT — from the page rows, never from
     * the assembled items, which may be one short (assemblePage's comment). A
     * cursor issued under another sort is refused: it names a position in a
     * different order.
     */
    listWords: async (enrollmentId: string, query: VocabularyPageQuery): Promise<VocabularyPage> => {
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      const sort = query.sort ?? 'newest';
      const level = query.level ?? null;
      const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
      if (query.cursor !== undefined && (!after || after.sort !== sort)) throw new InvalidCursor();

      return transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
        const read = await repos.vocabulary.findWordsPage({
          enrollmentId,
          limit: limit + 1,
          after,
          sort,
          level,
          live: LIVE_DIMENSIONS,
        });
        const rows = read.slice(0, limit);
        const summaries = await repos.vocabulary.findWordSummaries({
          enrollmentId,
          lexemeIds: rows.map((row) => row.lexemeId),
          sourceLanguage: enrolled.source_language,
        });
        return {
          items: assemblePage(rows, summaries),
          next_cursor: read.length > limit ? encodeCursor(cursorAfter(sort, rows[rows.length - 1])) : null,
        };
      });
    },
```

In `packages/core/src/api/schemas.ts`:

- in `VocabularyPageQuerySchema`, add:

```ts
  // Phase 20. Order, and one level only. A cursor carries the sort it was
  // issued under, and the server refuses it under another.
  sort: VocabularySortSchema.optional(),
  level: z.coerce.number().int().min(1).max(5).optional(),
```

- in `VocabularyWordSchema`, add `level: LevelSchema,` with the comment `// Phase 20. The word's badge: the rounded mean over its saved senses and the live dimensions.`

`VocabularySortSchema` and `LevelSchema` are declared above these (Task 1), so the order works.

In `apps/server/src/routes/vocabulary.ts`, `listRoute`:

- description: `'One item per word (lexeme), each with its level. Ordered newest save first by default, or by level (`sort=level_asc` or `level_desc`, ties newest first); `level` keeps one level only. Keyset-paginated: pass `next_cursor` back as `cursor`, with the same sort. A word saved into again moves to the top; it is never served twice in one walk.'`
- 400 description: `'`limit` is outside 1–100, `sort` or `level` is not one of the published values, or `cursor` was not issued by this server under this sort.'`

- [ ] **Step 8: Run the repository tests**

Run: `npm run typecheck && bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/repo/vocabulary.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the route tests**

In `apps/server/tests/integration/routes/vocabulary.test.ts`:

- add `import { setLevel } from '../../support/progressRows';`;
- in *saves a sense, and the list shows its word*, add `level: 1,` to the expected item, after `sense_count: 2,`;
- append:

```ts
describe('levels on the list (phase 20)', () => {
  type Leveled = { items: { lexeme_id: string; level: number }[]; next_cursor: string | null };
  const ids = async (query: string) => ((await (await list(RU, query)).json()) as Leveled).items.map((i) => i.lexeme_id);

  async function savedWord(lemma: string, level: number) {
    const word = await russianWord(lemma);
    await save(RU, [{ sense_id: word.senseIds[0], variant_id: word.variantIds[0] }]);
    await setLevel(t.db, { enrollmentId: RU, senseId: word.senseIds[0], level });
    return word.lexemeId;
  }

  async function walk(query: string): Promise<Leveled['items']> {
    const seen: Leveled['items'] = [];
    let cursor: string | null = null;
    do {
      const page = (await (
        await list(RU, `${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      ).json()) as Leveled;
      seen.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    return seen;
  }

  it('shows a newly saved word at level 1', async () => {
    const id = await savedWord('арка', 1);
    expect(((await (await list(RU)).json()) as Leveled).items).toEqual([
      expect.objectContaining({ lexeme_id: id, level: 1 }),
    ]);
  });

  it("averages a word's saved senses, rounding a tie up", async () => {
    const word = await russianWord('рама');
    await save(RU, word.senseIds.map((senseId) => ({ sense_id: senseId, variant_id: word.variantIds[0] })));
    await setLevel(t.db, { enrollmentId: RU, senseId: word.senseIds[0], level: 2 });
    await setLevel(t.db, { enrollmentId: RU, senseId: word.senseIds[1], level: 3 });
    expect(((await (await list(RU)).json()) as Leveled).items[0].level).toBe(3);
  });

  it('sorts by level both ways, the newer save first within a level', async () => {
    const low = await savedWord('арка', 1);
    const highOld = await savedWord('бак', 4);
    const highNew = await savedWord('вал', 4);
    const mid = await savedWord('газ', 2);
    expect(await ids('?sort=level_desc')).toEqual([highNew, highOld, mid, low]);
    expect(await ids('?sort=level_asc')).toEqual([low, mid, highNew, highOld]);
  });

  it('filters to one level', async () => {
    await savedWord('арка', 1);
    const highOld = await savedWord('бак', 4);
    const highNew = await savedWord('вал', 4);
    expect(await ids('?level=4')).toEqual([highNew, highOld]);
    expect(await ids('?level=3')).toEqual([]);
  });

  it('walks a level sort page by page without repeating or losing a word', async () => {
    for (let i = 0; i < 12; i += 1) await savedWord(`слово${i}`, (i % 5) + 1);
    const seen = await walk('?sort=level_asc&limit=5');
    expect(seen).toHaveLength(12);
    expect(new Set(seen.map((item) => item.lexeme_id)).size).toBe(12);
    expect(seen.map((item) => item.level)).toEqual([...seen.map((item) => item.level)].sort((a, b) => a - b));
  });

  // Review Focus 4: a filtered, level-sorted walk.
  it('walks a filtered level sort page by page', async () => {
    for (let i = 0; i < 9; i += 1) await savedWord(`слово${i}`, i % 3 === 0 ? 2 : 1);
    const seen = await walk('?sort=level_desc&level=2&limit=2');
    expect(seen).toHaveLength(3);
    expect(seen.every((item) => item.level === 2)).toBe(true);
    expect(new Set(seen.map((item) => item.lexeme_id)).size).toBe(3);
  });

  it('answers 400 for a cursor replayed under another sort', async () => {
    for (let i = 0; i < 3; i += 1) await savedWord(`слово${i}`, 1);
    const page = (await (await list(RU, '?limit=1')).json()) as Leveled;
    const res = await list(RU, `?sort=level_asc&cursor=${encodeURIComponent(page.next_cursor!)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it.each(['?sort=oldest', '?level=0', '?level=6', '?level=two'])('answers 400 for %s', async (query) => {
    const res = await list(RU, query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });
});
```

- [ ] **Step 10: Update the query-plan test**

In `apps/server/tests/integration/repo/vocabulary.plan.test.ts`:

- add `import { LIVE_DIMENSIONS } from '@lang-tutor/core/domain';`;
- change `WATCHED` to `['vocabulary_entries', 'dict_var_translations', 'sense_progress']`;
- append to `LOAD`, after the two `vocabulary_entries` inserts:

```ts
    // Phase 20. Five progress rows per entry, levels spread over 1–5 so a level
    // sort has real work to do. `& 2147483647` keeps hashtext non-negative
    // without abs(), which overflows on the one negative int4 with no positive.
    `insert into sense_progress (enrollment_id, sense_id, dimension, level)
       select ve.enrollment_id, ve.sense_id, d, 1 + ((hashtext(ve.sense_id || d) & 2147483647) % 5)
       from vocabulary_entries ve
       cross join unnest(array['written_receptive', 'written_productive', 'spoken_receptive',
                               'spoken_productive', 'spelling']) d`,
```

- add `'sense_progress'` to the `vacuum analyze` table list;
- add, after `const FIRST_50 = …`:

```ts
const PAGE = { enrollmentId: HEAVY, limit: 51, level: null, live: LIVE_DIMENSIONS };
```

- replace the two `wordsPage` cases with:

```ts
    ['wordsPage, first page', () => vocabularyQueries.wordsPage({ ...PAGE, sort: 'newest', after: null })],
    ['wordsPage, after a cursor', () => vocabularyQueries.wordsPage({
      ...PAGE,
      sort: 'newest',
      after: { sort: 'newest', savedAt: '2000-01-01 00:00:00+00', lexemeId: 'pl1' },
    })],
    ['wordsPage, level_asc first page', () => vocabularyQueries.wordsPage({ ...PAGE, sort: 'level_asc', after: null })],
    ['wordsPage, level_desc after a cursor', () => vocabularyQueries.wordsPage({
      ...PAGE,
      sort: 'level_desc',
      after: { sort: 'level_desc', level: 3, savedAt: '2000-01-01 00:00:00+00', lexemeId: 'pl1' },
    })],
    ['wordsPage, one level', () => vocabularyQueries.wordsPage({ ...PAGE, sort: 'newest', level: 2, after: null })],
```

- change the budget test's two `wordsPage` calls to `vocabularyQueries.wordsPage({ ...PAGE, sort: 'newest', after: null })`, and add after it:

```ts
  it.each(['level_asc', 'level_desc'] as const)(
    `serves the heavy enrollment's first %s page in under ${BUDGET_MS} ms`,
    async (sort) => {
      await explain(vocabularyQueries.wordsPage({ ...PAGE, sort, after: null }));
      const plan = await explain(vocabularyQueries.wordsPage({ ...PAGE, sort, after: null }));
      expect(plan['Execution Time']).toBeLessThan(BUDGET_MS);
    },
  );
```

- [ ] **Step 11: Run every vocabulary test**

Run: `npm run typecheck && npm test -w apps/server && bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/repo/vocabulary.test.ts tests/integration/repo/vocabulary.plan.test.ts tests/integration/routes/vocabulary.test.ts tests/integration/routes/translations.vocabulary.test.ts`
Expected: PASS. If the plan test fails, read the plan in the failure before touching anything; the fix is an index or a query shape, never a looser assertion.

- [ ] **Step 12: Lint and commit**

Run: `npm run lint:arch`

```bash
git add packages/core apps/server
git commit -m "feat(server): the word list shows, sorts and filters by level

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The word detail — five levels per saved sense

**Files:**
- Modify: `packages/core/src/api/schemas.ts` (`VocabularySenseSchema`, `VocabularyWordDetailSchema`)
- Modify: `apps/server/src/domain/vocabulary.ts` (`buildWordDetail`), `apps/server/src/domain/vocabulary.test.ts`
- Modify: `apps/server/src/services/vocabulary.ts` (`wordDetail`)
- Modify: `apps/server/tests/integration/routes/vocabulary.test.ts`

**Interfaces:**
- Consumes: `ProgressRow` (Task 2); `repos.progress.findRows` (Task 4); `SenseProgressSchema`, `LevelSchema`, `badge`, `DIMENSIONS`, `LIVE_DIMENSIONS`, `MIN_LEVEL` (Task 1).
- Produces: `buildWordDetail(lexeme, renderings, saved, progress: ProgressRow[])`; `VocabularyWordDetail.level: number | null`; `VocabularySense.progress?: SenseProgress`, present on a saved sense only.

- [ ] **Step 1: Write the failing domain tests**

In `apps/server/src/domain/vocabulary.test.ts`:

- add `import { DIMENSIONS } from '@lang-tutor/core/domain';` and `import type { ProgressRow } from './progress';`;
- add `, []` as the fourth argument to every existing `buildWordDetail(…)` call;
- in *carries the lexeme fields* (the `buildWordDetail(LEXEME, [], [])` case, now `buildWordDetail(LEXEME, [], [], [])`), add `level: null,` to the expected object;
- append inside `describe('buildWordDetail', …)`:

```ts
  const levels = (senseId: string, written: number): ProgressRow[] =>
    DIMENSIONS.map((dimension) => ({
      senseId,
      dimension,
      level: dimension === 'written_receptive' ? written : 1,
      lastStepOn: null,
      lastWrongOn: null,
    }));

  it('gives a saved sense its badge and five levels, and an unsaved one neither', () => {
    const detail = buildWordDetail(
      LEXEME,
      [rendering({ senseId: 's1' }), rendering({ senseId: 's2', rank: 1, translation: 'להקריא' })],
      [{ senseId: 's1', variantId: 'v1' }],
      levels('s1', 3),
    );
    expect(detail.senses[0]).toMatchObject({
      sense_id: 's1',
      progress: {
        level: 3,
        dimensions: { written_receptive: 3, written_productive: 1, spoken_receptive: 1, spoken_productive: 1, spelling: 1 },
      },
    });
    expect(detail.senses[1]).not.toHaveProperty('progress');
  });

  it("gives the word the rounded mean of its saved senses' badges, ties up", () => {
    const detail = buildWordDetail(
      LEXEME,
      [rendering({ senseId: 's1' }), rendering({ senseId: 's2' })],
      [{ senseId: 's1', variantId: 'v1' }, { senseId: 's2', variantId: 'v1' }],
      [...levels('s1', 2), ...levels('s2', 3)],
    );
    expect(detail.level).toBe(3);
  });

  it('gives a word with nothing saved no level', () => {
    expect(buildWordDetail(LEXEME, [rendering({})], [], []).level).toBeNull();
  });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test -w apps/server -- src/domain/vocabulary.test.ts`
Expected: FAIL, `level` is undefined and no sense has `progress`.

- [ ] **Step 3: Implement**

In `apps/server/src/domain/vocabulary.ts`:

1. Extend the imports: `import { DIMENSIONS, LIVE_DIMENSIONS, MAX_LEVEL, MIN_LEVEL, badge, type Dimension } from '@lang-tutor/core/domain';` (replacing the Task 7 import), add `SenseProgress` to the `@lang-tutor/core/api` type import, and add `import type { ProgressRow } from './progress';`.

2. Add above `buildWordDetail`:

```ts
/** A saved sense's five levels and its badge over the live dimensions. A
 *  dimension with no row reads as level 1: every entry has five rows, so that
 *  only guards a broken fixture. */
function senseProgressOf(rows: ProgressRow[]): SenseProgress {
  const byDimension = new Map(rows.map((row) => [row.dimension, row.level]));
  const levelOf = (dimension: Dimension) => byDimension.get(dimension) ?? MIN_LEVEL;
  const dimensions = {} as SenseProgress['dimensions'];
  for (const dimension of DIMENSIONS) dimensions[dimension] = levelOf(dimension);
  return { level: badge(LIVE_DIMENSIONS.map(levelOf)), dimensions };
}
```

3. Change `buildWordDetail`'s signature to add `progress: ProgressRow[],` as the fourth parameter, and update its doc comment with:

```ts
 * Phase 20: a saved sense carries its five levels; the word carries the rounded
 * mean over every saved sense's live dimensions, the same number the list
 * shows, or null when nothing is saved. `progress` holds the rows of every
 * saved sense, including one with no rendering to show.
```

4. Inside, before `return`, add:

```ts
  const progressBySense = new Map<string, ProgressRow[]>();
  for (const row of progress) {
    progressBySense.set(row.senseId, [...(progressBySense.get(row.senseId) ?? []), row]);
  }
  const live = progress.filter((row) => LIVE_DIMENSIONS.includes(row.dimension));
```

5. In the returned object, add `level: live.length === 0 ? null : badge(live.map((row) => row.level)),` after `part_of_speech`, and in each sense, after `saved: isSaved,` add:

```ts
      ...(isSaved && progressBySense.has(r.senseId)
        ? { progress: senseProgressOf(progressBySense.get(r.senseId)!) }
        : {}),
```

`MAX_LEVEL` stays imported because `decodeCursor` uses it.

In `apps/server/src/services/vocabulary.ts`, `wordDetail`, replace the last two lines of the transaction body with:

```ts
        const saved = await repos.vocabulary.findSavedInLexeme({ enrollmentId, lexemeId });
        const progress = await repos.progress.findRows({
          enrollmentId,
          senseIds: saved.map((entry) => entry.senseId),
          savedBy: null,
        });
        return buildWordDetail(lexeme, renderings, saved, progress);
```

In `packages/core/src/api/schemas.ts`:

- in `VocabularySenseSchema`, after `saved: z.boolean(),`, add:

```ts
  // Phase 20. Present on a saved sense only: its badge and five levels.
  progress: SenseProgressSchema.optional(),
```

- in `VocabularyWordDetailSchema`, after `part_of_speech: z.string(),`, add:

```ts
  // Phase 20. The word's badge, as on the list; null when nothing is saved.
  level: LevelSchema.nullable(),
```

In `apps/server/src/routes/vocabulary.ts`, `detailRoute`'s description, append: `' A saved sense carries its level in each knowledge dimension; the word carries its overall level, null when nothing is saved.'`

- [ ] **Step 4: Write the route test**

Append inside `describe('GET /api/enrollments/{id}/vocabulary/words/{lexeme_id}', …)` in `apps/server/tests/integration/routes/vocabulary.test.ts`:

```ts
  it('shows a saved sense with its five levels, an unsaved one with none, and the word with its level', async () => {
    const rama = await russianWord('рама');
    await save(RU, [{ sense_id: rama.senseIds[0], variant_id: rama.variantIds[0] }]);
    await setLevel(t.db, { enrollmentId: RU, senseId: rama.senseIds[0], level: 3 });

    const body = (await (await detail(RU, rama.lexemeId)).json()) as {
      level: number | null;
      senses: { sense_id: string; progress?: unknown }[];
    };
    expect(body.level).toBe(3);
    expect(body.senses.find((s) => s.sense_id === rama.senseIds[0])?.progress).toEqual({
      level: 3,
      dimensions: { written_receptive: 3, written_productive: 1, spoken_receptive: 1, spoken_productive: 1, spelling: 1 },
    });
    expect(body.senses.find((s) => s.sense_id === rama.senseIds[1])).not.toHaveProperty('progress');
  });

  it('gives a word with nothing saved no level', async () => {
    const rama = await russianWord('рама');
    expect(((await (await detail(RU, rama.lexemeId)).json()) as { level: unknown }).level).toBeNull();
  });
```

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npm test -w apps/server && bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/routes/vocabulary.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

Run: `npm run lint:arch`

```bash
git add packages/core apps/server
git commit -m "feat(server): the word detail shows each saved sense's levels

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Recompute progress from the answer log

**Files:**
- Create: `apps/server/src/db/progressRecompute.ts`
- Modify: `apps/server/src/db/cli.ts`
- Modify: `apps/server/package.json`, `package.json`
- Create: `apps/server/tests/integration/db/progressRecompute.test.ts`

**Interfaces:**
- Consumes: `createProgressRepo` (Task 4); `evaluateSession` (Task 2); `createTransaction`.
- Produces: `recomputeProgress(db: Db): Promise<{ sessions: number }>`; `npm run db:progress:recompute`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/integration/db/progressRecompute.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { recomputeProgress } from '../../../src/db/progressRecompute';
import { insertLexeme } from '../../support/dictRows';
import {
  insertAnsweredSession,
  insertProgressRows,
  readProgress,
  readSnapshot,
  setLevel,
} from '../../support/progressRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;
const E = enrollmentOf('u_1');
let kite: { lexemeId: string; variantIds: string[]; senseIds: string[] };

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  kite = await insertLexeme(t.db, {
    lemma: 'kite',
    languageCode: 'en',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'toy' }],
    variants: [
      {
        form: 'kite',
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'toy', rank: 0, translation: 'עפיפון', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
});
afterEach(async () => {
  await t.close();
});

async function savedAt(at: string) {
  await t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id, created_at)
    values (${E}, ${kite.senseIds[0]}, ${kite.lexemeId}, ${kite.variantIds[0]}, ${at}::timestamptz)`);
  await insertProgressRows(t.db, E, [kite.senseIds[0]]);
}

/** A one-question session about kite, answered once at `at`. */
const session = (status: 'completed' | 'skipped' | 'ready', correct: boolean, at: string) =>
  insertAnsweredSession(t.db, {
    userId: 'u_1',
    enrollmentId: E,
    status,
    asked: [{ senseId: kite.senseIds[0], variantId: kite.variantIds[0], translation: 'עפיפון' }],
    answers: [{ position: 0, correct, at }],
  });

const receptive = async () =>
  (await readProgress(t.db, E)).find((row) => row.dimension === 'written_receptive');

describe('recomputeProgress', () => {
  it('rebuilds levels from ended sessions in the order they ended, and their snapshots', async () => {
    await savedAt('2026-01-01 00:00:00+00');
    const first = await session('completed', true, '2026-01-05 10:00:00+00');
    const second = await session('skipped', true, '2026-01-06 10:00:00+00');
    const third = await session('completed', false, '2026-01-07 10:00:00+00');
    await session('ready', true, '2026-01-20 10:00:00+00'); // open: does not count
    await setLevel(t.db, { enrollmentId: E, senseId: kite.senseIds[0], level: 5 }); // junk to reset

    expect(await recomputeProgress(t.db)).toEqual({ sessions: 3 });

    expect(await receptive()).toMatchObject({ level: 3, lastStepOn: '2026-01-06', lastWrongOn: '2026-01-07' });
    expect(await readSnapshot(t.db, first)).toHaveLength(5);
    expect(await readSnapshot(t.db, second)).toHaveLength(5);
    expect((await readSnapshot(t.db, third)).find((r) => r.dimension === 'written_receptive')).toMatchObject({
      levelBefore: 3,
      levelAfter: 3,
    });
  });

  it('does not count a session that ended before the sense was saved', async () => {
    await savedAt('2026-01-10 00:00:00+00');
    const before = await session('completed', true, '2026-01-05 10:00:00+00');
    await recomputeProgress(t.db);
    expect(await receptive()).toMatchObject({ level: 1, lastStepOn: null });
    expect(await readSnapshot(t.db, before)).toEqual([]);
  });

  it('is idempotent', async () => {
    await savedAt('2026-01-01 00:00:00+00');
    await session('completed', true, '2026-01-05 10:00:00+00');
    await recomputeProgress(t.db);
    const once = await readProgress(t.db, E);
    await recomputeProgress(t.db);
    expect(await readProgress(t.db, E)).toEqual(once);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/db/progressRecompute.test.ts`
Expected: FAIL, `Cannot find module '../../../src/db/progressRecompute'`.

- [ ] **Step 3: Implement**

Create `apps/server/src/db/progressRecompute.ts`:

```ts
import { evaluateSession } from '../domain/progress';
import { createProgressRepo } from '../repo/progress';
import type { Db } from './client';
import { createTransaction } from './transaction';

/**
 * Phase 20. Rebuilds sense_progress and session_progress from the answer log,
 * for when the rule changes (spec §3). Every ended session is replayed in the
 * order it ended, through the same evaluateSession the live path runs. One
 * transaction: a failure halfway leaves the old progress in place.
 *
 * Here rather than in services/ because db/cli.ts is the command's composition
 * root, and ADR 0001 R4 forbids db/ from importing services/. The four calls
 * below repeat recordProgress in services/sessions.ts; this file's integration
 * test is what keeps the two in step.
 *
 * A sense counts in a session only if it was saved by the session's last
 * answer, the live path's "its rows exist when the session ends" read back from
 * timestamps. A sense saved between a session's last answer and its skip is the
 * one case where the two disagree, and that is accepted.
 */
export async function recomputeProgress(db: Db): Promise<{ sessions: number }> {
  const inTransaction = createTransaction(db, (tx) => createProgressRepo(tx));
  return inTransaction(async (progress) => {
    await progress.resetAll();
    const ended = await progress.listEndedSessions();
    for (const sessionId of ended) {
      const evidence = await progress.findSessionEvidence(sessionId);
      if (!evidence) continue;
      const rows = await progress.findRows({
        enrollmentId: evidence.enrollmentId,
        senseIds: [...new Set(evidence.answers.map((answer) => answer.senseId))],
        savedBy: evidence.lastAnsweredAt,
      });
      if (rows.length === 0) continue;
      const outcome = evaluateSession(rows, evidence.answers, evidence.day);
      await progress.updateRows({ enrollmentId: evidence.enrollmentId, rows: outcome.changed });
      await progress.insertSnapshot({ sessionId, rows: outcome.snapshot });
    }
    return { sessions: ended.length };
  });
}
```

In `apps/server/src/db/cli.ts`, add `import { recomputeProgress } from './progressRecompute';`, and directly after `await runMigrations(db);` add:

```ts
    // Phase 20. After migrating, so the progress tables exist; before the seed,
    // which a recompute has no reason to touch.
    if (process.argv.includes('--recompute-progress')) {
      const { sessions } = await recomputeProgress(db);
      console.log(`recomputed progress in ${databaseUrl} from ${sessions} ended sessions`);
      return;
    }
```

In `apps/server/package.json` scripts, after `"db:reseed"`, add `"db:progress:recompute": "tsx src/db/cli.ts --recompute-progress",`.

In the root `package.json` scripts, after `"db:reseed"`, add `"db:progress:recompute": "bash scripts/lane-env.sh npm run db:progress:recompute --workspace apps/server",`.

- [ ] **Step 4: Run the test and the command**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/db/progressRecompute.test.ts && npm run db:progress:recompute`
Expected: PASS, then `recomputed progress in postgres://…/lang_tutor_phase_20_progress_… from N ended sessions`.

- [ ] **Step 5: Lint and commit**

Run: `npm run typecheck && npm run lint:arch`

```bash
git add apps/server package.json
git commit -m "feat(server): db:progress:recompute rebuilds progress from the answer log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Mobile — api client, progress rules and strings

**Files:**
- Modify: `apps/mobile/src/api/client.ts`, `apps/mobile/src/api/client.test.ts`
- Create: `apps/mobile/src/progress.ts`, `apps/mobile/src/progress.test.ts`
- Modify: `apps/mobile/src/strings.ts`

**Interfaces:**
- Consumes: `VocabularySort`, `SenseProgress`, `SessionProgressItem` (Task 1); `DIMENSIONS`, `MAX_LEVEL`, `Dimension` (Task 1).
- Produces:
  - `listVocabulary(enrollmentId, query: { cursor?: string; limit?: number; sort?: VocabularySort; level?: number })`;
  - `pipsFor(level: number): boolean[]`;
  - `type PractisedRow = SessionProgressItem & { raised: boolean }`, `practisedRows(progress): PractisedRow[]`;
  - `type DimensionRow = { dimension: Dimension; level: number | null }`, `dimensionRows(progress: SenseProgress, live: readonly Dimension[]): DimensionRow[]`;
  - `nextLevelFilter(current: number | null, tapped: number): number | null`;
  - strings `levelName`, `levelRaised`, `dimensionName`, `notPractised`, `sortNewest`, `sortLevelAsc`, `sortLevelDesc`, `vocabularyEmptyLevel`, `resultsPractisedTitle`.

- [ ] **Step 1: Write the failing tests**

In `apps/mobile/src/api/client.test.ts`, after the *listVocabulary passes cursor and limit…* case, add:

```ts
  it('listVocabulary passes sort and level when given', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) }));
    const client = buildClient(mockFetch);
    await client.listVocabulary('e1', { sort: 'level_desc', level: 2 });
    expect(mockFetch).toHaveBeenCalledWith('http://test.local/api/enrollments/e1/vocabulary?sort=level_desc&level=2', { method: 'GET' });
  });
```

Create `apps/mobile/src/progress.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import type { SenseProgress, SessionProgressItem } from '@lang-tutor/core/api';

import { dimensionRows, nextLevelFilter, pipsFor, practisedRows } from './progress';
import { strings } from './strings';

describe('pipsFor', () => {
  it('fills as many of the five pips as the level', () => {
    expect(pipsFor(1)).toEqual([true, false, false, false, false]);
    expect(pipsFor(3)).toEqual([true, true, true, false, false]);
    expect(pipsFor(5)).toEqual([true, true, true, true, true]);
  });
});

describe('practisedRows', () => {
  const item = (sense_id: string, level_before: number, level_after: number): SessionProgressItem => ({
    sense_id,
    form: `form-${sense_id}`,
    translation: `tr-${sense_id}`,
    level_before,
    level_after,
  });

  it('puts the words that moved up first, each group in session order', () => {
    const rows = practisedRows([item('a', 1, 1), item('b', 1, 2), item('c', 2, 2), item('d', 3, 4)]);
    expect(rows.map((row) => [row.sense_id, row.raised])).toEqual([
      ['b', true],
      ['d', true],
      ['a', false],
      ['c', false],
    ]);
  });

  it('is empty for no progress', () => {
    expect(practisedRows([])).toEqual([]);
  });
});

describe('dimensionRows', () => {
  const progress: SenseProgress = {
    level: 3,
    dimensions: { written_receptive: 3, written_productive: 1, spoken_receptive: 1, spoken_productive: 1, spelling: 1 },
  };

  it('lists the five dimensions in order, with no level for one that is not live', () => {
    expect(dimensionRows(progress, ['written_receptive'])).toEqual([
      { dimension: 'written_receptive', level: 3 },
      { dimension: 'written_productive', level: null },
      { dimension: 'spoken_receptive', level: null },
      { dimension: 'spoken_productive', level: null },
      { dimension: 'spelling', level: null },
    ]);
  });
});

describe('nextLevelFilter', () => {
  it('selects a level, and clears it when tapped again', () => {
    expect(nextLevelFilter(null, 2)).toBe(2);
    expect(nextLevelFilter(2, 4)).toBe(4);
    expect(nextLevelFilter(4, 4)).toBeNull();
  });
});

describe('level names', () => {
  it('names the five levels, feminine to agree with מילה', () => {
    expect([1, 2, 3, 4, 5].map(strings.levelName)).toEqual(['חדשה', 'נחשפה', 'מוכרת', 'ידועה', 'בשליטה']);
  });

  it('names each dimension', () => {
    expect(strings.dimensionName('written_receptive')).toBe('זיהוי בכתב');
    expect(strings.dimensionName('spelling')).toBe('איות');
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npm test -w apps/mobile -- src/api/client.test.ts src/progress.test.ts`
Expected: FAIL, `Cannot find module './progress'`, and the client ignores `sort`.

- [ ] **Step 3: Implement**

In `apps/mobile/src/api/client.ts`, add `VocabularySort` to the type import and replace `listVocabulary` with:

```ts
    listVocabulary: (
      enrollmentId: string,
      query: { cursor?: string; limit?: number; sort?: VocabularySort; level?: number },
    ) => {
      const params = new URLSearchParams();
      if (query.cursor !== undefined) params.set('cursor', query.cursor);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.sort !== undefined) params.set('sort', query.sort);
      if (query.level !== undefined) params.set('level', String(query.level));
      const search = params.toString();
      return getJson<VocabularyPage>(`${vocabularyPath(enrollmentId)}${search ? `?${search}` : ''}`);
    },
```

Create `apps/mobile/src/progress.ts`:

```ts
import type { SenseProgress, SessionProgressItem } from '@lang-tutor/core/api';
import { DIMENSIONS, MAX_LEVEL, type Dimension } from '@lang-tutor/core/domain';

/** Phase 20. The screens' progress rules, as pure functions the tests can reach. */

/** Which of the five pips a level fills. */
export function pipsFor(level: number): boolean[] {
  return Array.from({ length: MAX_LEVEL }, (_, i) => i < level);
}

export type PractisedRow = SessionProgressItem & { raised: boolean };

/** The results' practised words: the ones that moved up first, then the rest,
 *  each group in the order the session asked them. */
export function practisedRows(progress: SessionProgressItem[]): PractisedRow[] {
  const rows = progress.map((item) => ({ ...item, raised: item.level_after > item.level_before }));
  return [...rows.filter((row) => row.raised), ...rows.filter((row) => !row.raised)];
}

export type DimensionRow = { dimension: Dimension; level: number | null };

/** A saved sense's five dimensions in a fixed order. `level` is null for a
 *  dimension no exercise feeds yet, which the screen shows as not practised. */
export function dimensionRows(progress: SenseProgress, live: readonly Dimension[]): DimensionRow[] {
  return DIMENSIONS.map((dimension) => ({
    dimension,
    level: live.includes(dimension) ? progress.dimensions[dimension] : null,
  }));
}

/** Tapping the selected level clears the filter; tapping another selects it. */
export function nextLevelFilter(current: number | null, tapped: number): number | null {
  return current === tapped ? null : tapped;
}
```

In `apps/mobile/src/strings.ts`, add above `export const strings`:

```ts
// Phase 20. The five knowledge dimensions, as the word detail names them.
const DIMENSION_NAMES: Record<string, string> = {
  written_receptive: 'זיהוי בכתב',
  written_productive: 'כתיבה',
  spoken_receptive: 'הבנת הנשמע',
  spoken_productive: 'דיבור',
  spelling: 'איות',
};
```

and insert before `partOfSpeech`:

```ts
  // Phase 20. Five levels, feminine to agree with מילה (spec §5).
  levelName: (level: number): string => ['חדשה', 'נחשפה', 'מוכרת', 'ידועה', 'בשליטה'][level - 1] ?? '',
  levelRaised: (level: number) => `עלתה לרמה ${level}`,
  dimensionName: (dimension: string): string => DIMENSION_NAMES[dimension] ?? dimension,
  notPractised: 'טרם תורגל',
  sortNewest: 'חדשות',
  sortLevelAsc: 'רמה עולה',
  sortLevelDesc: 'רמה יורדת',
  vocabularyEmptyLevel: 'אין מילים ברמה הזו',
  resultsPractisedTitle: 'המילים שתרגלת',
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w apps/mobile && npm run typecheck -w apps/mobile`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `npm run lint:arch`

```bash
git add apps/mobile
git commit -m "feat(mobile): progress rules, level strings, and list sort and filter in the client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Mobile — the level badge, the list and the word detail

**Files:**
- Create: `apps/mobile/src/components/LevelBadge.tsx`
- Modify: `apps/mobile/src/hooks/useVocabulary.tsx`
- Modify: `apps/mobile/src/app/vocabulary/index.tsx`
- Modify: `apps/mobile/src/app/vocabulary/[lexemeId].tsx`

**Interfaces:**
- Consumes: `pipsFor`, `dimensionRows`, `nextLevelFilter`, strings, `listVocabulary` with `sort` and `level` (Task 10); `VocabularyWord.level`, `VocabularyWordDetail.level`, `VocabularySense.progress` (Tasks 7 and 8).
- Produces:
  - `LevelBadge({ level, testID })`, rendering `testID` on the badge and `${testID}-name` on its name;
  - `useVocabulary()` gains `query: VocabularyQuery` and `setQuery(query)`, with `type VocabularyQuery = { sort: VocabularySort; level: number | null }`;
  - test ids: `vocabulary-word-level`, `vocabulary-sort-newest`, `vocabulary-sort-level_asc`, `vocabulary-sort-level_desc`, `vocabulary-level-1` to `vocabulary-level-5`, `vocabulary-empty-level`, `vocabulary-detail-level`, `vocabulary-sense-level`, `vocabulary-dimension-<dimension>`.

The screens hold no logic beyond wiring; their rules were tested in Task 10, and Task 13 drives them end to end.

- [ ] **Step 1: Write the badge**

Create `apps/mobile/src/components/LevelBadge.tsx`:

```tsx
import { StyleSheet, Text, View } from 'react-native';

import { pipsFor } from '@/progress';
import { strings } from '@/strings';
import { colors, fontSizes, spacing } from '@/theme';

/** A level as five pips and its name: the one ladder every screen shows (spec §5). */
export function LevelBadge({ level, testID }: { level: number; testID: string }) {
  return (
    <View style={styles.badge} testID={testID} accessibilityLabel={strings.levelName(level)}>
      <View style={styles.pips}>
        {pipsFor(level).map((filled, i) => (
          <View key={i} style={[styles.pip, filled && styles.pipFilled]} />
        ))}
      </View>
      <Text style={styles.name} testID={`${testID}-name`}>
        {strings.levelName(level)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  pips: { flexDirection: 'row', gap: 2 },
  pip: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.primary },
  pipFilled: { backgroundColor: colors.primary },
  name: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
});
```

- [ ] **Step 2: Give the vocabulary hook a query**

In `apps/mobile/src/hooks/useVocabulary.tsx`:

1. Add `VocabularySort` to the `@lang-tutor/core/api` type import.

2. Add, after `VocabularyStatus`:

```ts
/** How the list is asked for: its order and, optionally, one level. */
export type VocabularyQuery = { sort: VocabularySort; level: number | null };
const DEFAULT_QUERY: VocabularyQuery = { sort: 'newest', level: null };
```

3. Add to `VocabularyValue`:

```ts
  query: VocabularyQuery;
  /** A new order or filter: reloads from the first page. */
  setQuery: (query: VocabularyQuery) => void;
```

4. In the provider, add after `const [cursor, setCursor] = …`:

```ts
  const [query, setQueryState] = useState<VocabularyQuery>(DEFAULT_QUERY);
  // Read by reload and loadMore so their identities stay stable across query
  // changes; the list screen hands reload to useFocusEffect.
  const queryRef = useRef(query);
```

5. Change `fetchPage` to take the query:

```ts
  const fetchPage = useCallback(
    async (after: string | null, replace: boolean, asked: VocabularyQuery) => {
      if (!active) return;
      const mine = replace ? ++generation.current : generation.current;
      setStatus('loading');
      try {
        const page = await api.listVocabulary(active.id, {
          ...(after ? { cursor: after } : {}),
          sort: asked.sort,
          ...(asked.level !== null ? { level: asked.level } : {}),
        });
        if (mine !== generation.current) return;
        setWords((loaded) => (replace ? page.items : appendPage(loaded, page.items)));
        setCursor(page.next_cursor);
        setStatus('ready');
      } catch {
        if (mine === generation.current) setStatus('error');
      }
    },
    [api, active],
  );
```

6. In the enrollment-switch effect, also reset the query:

```ts
  useEffect(() => {
    generation.current += 1;
    queryRef.current = DEFAULT_QUERY;
    setQueryState(DEFAULT_QUERY);
    setWords([]);
    setCursor(null);
    setStatus('idle');
  }, [active]);
```

7. Change `reload` and add `setQuery`:

```ts
  const reload = useCallback(() => void fetchPage(null, true, queryRef.current), [fetchPage]);
  const setQuery = useCallback(
    (next: VocabularyQuery) => {
      queryRef.current = next;
      setQueryState(next);
      void fetchPage(null, true, next);
    },
    [fetchPage],
  );
```

8. In the memoised value, change `loadMore` to call `fetchPage(cursor, false, queryRef.current)`, add `query,` and `setQuery,`, and add `query` and `setQuery` to the dependency array.

- [ ] **Step 3: The list screen**

In `apps/mobile/src/app/vocabulary/index.tsx`:

1. Add imports: `import type { VocabularySort } from '@lang-tutor/core/api';`, `import { LevelBadge } from '@/components/LevelBadge';`, `import { nextLevelFilter } from '@/progress';`.

2. Above the component, add:

```tsx
const SORTS: { sort: VocabularySort; label: string }[] = [
  { sort: 'newest', label: strings.sortNewest },
  { sort: 'level_asc', label: strings.sortLevelAsc },
  { sort: 'level_desc', label: strings.sortLevelDesc },
];
const LEVELS = [1, 2, 3, 4, 5];

function Chip({ label, selected, onPress, testID }: { label: string; selected: boolean; onPress: () => void; testID: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      testID={testID}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}
```

3. Between the error notice and the `FlatList`, add:

```tsx
      <View style={styles.chips}>
        {SORTS.map(({ sort, label }) => (
          <Chip
            key={sort}
            testID={`vocabulary-sort-${sort}`}
            label={label}
            selected={v.query.sort === sort}
            onPress={() => v.setQuery({ ...v.query, sort })}
          />
        ))}
      </View>
      <View style={styles.chips}>
        {LEVELS.map((level) => (
          <Chip
            key={level}
            testID={`vocabulary-level-${level}`}
            label={strings.levelName(level)}
            selected={v.query.level === level}
            onPress={() => v.setQuery({ ...v.query, level: nextLevelFilter(v.query.level, level) })}
          />
        ))}
      </View>
```

4. Replace `ListEmptyComponent` with:

```tsx
        ListEmptyComponent={
          v.status !== 'ready' ? null : v.query.level !== null ? (
            <View testID="vocabulary-empty-level" style={styles.empty}>
              <Text style={styles.notice}>{strings.vocabularyEmptyLevel}</Text>
            </View>
          ) : (
            <View testID="vocabulary-empty" style={styles.empty}>
              <Text style={styles.notice}>{strings.vocabularyEmpty}</Text>
              <Pressable accessibilityRole="button" onPress={() => router.push('/translate')}>
                <Text style={styles.link}>{strings.vocabularyGoTranslate}</Text>
              </Pressable>
            </View>
          )
        }
```

5. In `renderItem`, after the `rowTop` view, add `<LevelBadge level={item.level} testID="vocabulary-word-level" />`.

6. Add to `styles`:

```ts
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipLabel: { fontSize: fontSizes.sm, color: colors.text },
  chipLabelSelected: { color: colors.onPrimary, fontWeight: '700' },
```

- [ ] **Step 4: The word detail**

In `apps/mobile/src/app/vocabulary/[lexemeId].tsx`:

1. Add imports: `import { LIVE_DIMENSIONS } from '@lang-tutor/core/domain';`, `import { LevelBadge } from '@/components/LevelBadge';`, `import { dimensionRows } from '@/progress';`.

2. After the lemma `<Text>`, add:

```tsx
          {word.level !== null ? <LevelBadge level={word.level} testID="vocabulary-detail-level" /> : null}
```

3. Inside each sense card, after the example block and before the toggle, add:

```tsx
              {sense.saved && sense.progress ? (
                <View style={styles.progress}>
                  <LevelBadge level={sense.progress.level} testID="vocabulary-sense-level" />
                  {dimensionRows(sense.progress, LIVE_DIMENSIONS).map(({ dimension, level }) => (
                    <View key={dimension} style={styles.dimensionRow} testID={`vocabulary-dimension-${dimension}`}>
                      <Text style={styles.meta}>{strings.dimensionName(dimension)}</Text>
                      <Text style={styles.meta}>{level === null ? strings.notPractised : strings.levelName(level)}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
```

A sense saved on this screen has no `progress` until the next load, and shows none; one unsaved here hides its stale progress.

4. Add to `styles`:

```ts
  progress: { gap: spacing.xs },
  dimensionRow: { flexDirection: 'row', justifyContent: 'space-between' },
```

- [ ] **Step 5: Typecheck and test**

Run: `npm run typecheck -w apps/mobile && npm test -w apps/mobile && npm run lint -w apps/mobile`
Expected: PASS, no lint errors.

- [ ] **Step 6: Look at it**

Run the app in this lane (`npm run server` and `npm run mobile` in two terminals), open the saved list and a word's detail, and check: each row shows pips and a name, the sort and level chips reload the list, a level with no words shows `אין מילים ברמה הזו`, and a saved sense lists five dimensions with four `טרם תורגל`.

- [ ] **Step 7: Lint and commit**

Run: `npm run lint:arch`

```bash
git add apps/mobile
git commit -m "feat(mobile): level badges, sort and level chips, and the detail's dimensions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Mobile — the results screen's practised words

**Files:**
- Modify: `apps/mobile/src/hooks/useSession.tsx`
- Modify: `apps/mobile/src/app/results.tsx`

**Interfaces:**
- Consumes: `SessionProgressItem` (Task 1); `progress` on the completed next-step response (Task 6); `practisedRows`, `LevelBadge`, strings (Tasks 10 and 11).
- Produces: `SessionValue.progress: SessionProgressItem[]`; test ids `practised-section`, `practised-row`, `practised-level`, `practised-raised`, `results-done`.

- [ ] **Step 1: Carry `progress` through the session hook**

In `apps/mobile/src/hooks/useSession.tsx`:

1. Add `SessionProgressItem` to the `@lang-tutor/core/api` type import.
2. Add `progress: SessionProgressItem[];` to `SessionValue` (after `missedQuestions`) with the comment `/** Phase 20. Each practised saved word with its level before and after. */`, and to `QuizState`.
3. Change the complete member of `Queued` to `{ complete: true; score: Score; missedQuestions: MissedQuestion[]; progress: SessionProgressItem[] }`.
4. In `applyQueued`'s complete branch, add `progress: queued.progress,`.
5. In `enter`'s initial `setState`, add `progress: [],`.
6. In `select`'s `.then`, change the complete branch to `{ complete: true, score: response.score, missedQuestions: response.missed_questions, progress: response.progress }`.
7. In the memoised value, add `progress: [],` to the no-session object and `progress: state.progress,` to the session object.

- [ ] **Step 2: Show the practised words on the results screen**

In `apps/mobile/src/app/results.tsx`:

1. Add imports: `import { LevelBadge } from '@/components/LevelBadge';` and `import { practisedRows } from '@/progress';`.
2. Change `const { correctCount, total, missedQuestions } = session;` to `const { correctCount, total, missedQuestions, progress } = session;`.
3. Between the score `<Text>` and the missed block, add:

```tsx
        {progress.length > 0 ? (
          <View style={styles.missed} testID="practised-section">
            <Text style={styles.missedTitle}>{strings.resultsPractisedTitle}</Text>
            {practisedRows(progress).map((row) => (
              <View key={row.sense_id} style={[styles.missedRow, row.raised && styles.raisedRow]} testID="practised-row">
                <View style={styles.missedCellStart}>
                  <Text style={styles.missedPrompt}>{row.form}</Text>
                </View>
                <View style={styles.missedCellEnd}>
                  <Text style={styles.missedAnswer}>{row.translation}</Text>
                  <LevelBadge level={row.level_after} testID="practised-level" />
                  {row.raised ? (
                    <Text style={styles.raised} testID="practised-raised">
                      {strings.levelRaised(row.level_after)}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}
```

4. Give the secondary *done* button `testID="results-done"`.
5. Add to `styles`:

```ts
  raisedRow: { borderColor: colors.primary, borderWidth: 2 },
  raised: {
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.sm,
    fontWeight: '700',
    color: colors.primary,
    writingDirection: 'rtl',
  },
```

- [ ] **Step 3: Typecheck and test**

Run: `npm run typecheck && npm test -w apps/mobile && npm run lint -w apps/mobile`
Expected: PASS.

- [ ] **Step 4: Lint and commit**

Run: `npm run lint:arch`

```bash
git add apps/mobile
git commit -m "feat(mobile): the results screen shows each practised word's level

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: End to end

**Files:**
- Create: `e2e/tests/progress.spec.ts`

**Interfaces:**
- Consumes: the test ids of Tasks 11 and 12, and those phase 19 placed on home, session and translate.

- [ ] **Step 1: Write the spec**

Create `e2e/tests/progress.spec.ts`:

```ts
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { API_URL } from '../urls';
import { attachDiagnostics, diagnosticReport } from './support/diagnostics';
import { clearGemini, expectGemini, expectGeminiPayload } from './support/mockServer';
import { stripIsolates } from './support/text';
import { createLearner, logIn } from './support/users';

test.setTimeout(180_000);

// The same new lexemes next-session.spec.ts uses: four senses, two words.
const PROCHITALA = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'прочитать',
      part_of_speech: 'verb',
      senses: [
        { translation: 'קראה', sense_code: 'read_through' },
        { translation: 'הקריאה', sense_code: 'read_aloud' },
      ],
    },
  ],
};
const LUK = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'лук',
      part_of_speech: 'noun',
      senses: [
        { translation: 'בצל', sense_code: 'onion' },
        { translation: 'קשת', sense_code: 'bow' },
      ],
    },
  ],
};
const WRONG = ['דלת', 'קיר', 'תקרה'];
const DISTRACTORS = {
  items: Array.from({ length: 10 }, (_, i) => ({ key: `q${i + 1}`, distractors: WRONG })),
};

// Retried: a static export serves markup before React hydrates, so an early
// click is a silent no-op (the pattern the other specs use).
async function tapUntil(page: Page, testId: string, visible: string) {
  await expect(async () => {
    await page.getByTestId(testId).click();
    await expect(page.getByTestId(visible).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

async function lookUp(page: Page, request: APIRequestContext, text: string, payload: unknown) {
  await clearGemini(request);
  await expectGemini(request, payload as Parameters<typeof expectGemini>[1]);
  await page.getByTestId('translate-input').fill(text);
  await page.getByTestId('translate-submit').click();
  await expect(page.getByTestId('translate-sense').first()).toBeVisible();
}

async function tapAndWaitForWrite(page: Page, button: Locator) {
  const written = page.waitForResponse(
    (res) => /\/api\/enrollments\/[^/]+\/vocabulary/.test(res.url()) && res.request().method() === 'POST',
  );
  await button.click();
  expect((await written).ok()).toBe(true);
}

test('a session moves the words it practised up the ladder, and the list sorts and filters by level', async ({
  page,
  request,
}) => {
  const diagnostics = attachDiagnostics(page, API_URL);
  const report = () => diagnosticReport(diagnostics);
  page.on('dialog', (dialog) => void dialog.accept());

  await createLearner(request, 'e2e_progress_ru', 'ru');
  await logIn(page, 'e2e_progress_ru');

  // 1. Past the seed, with four saved senses of two words.
  await tapUntil(page, 'start-button', 'progress-label');
  await page.getByTestId('session-skip').click();
  await expect(page.getByTestId('save-words-first'), report()).toBeVisible();
  await tapUntil(page, 'translate-entry', 'translate-input');
  await lookUp(page, request, 'прочитала', PROCHITALA);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await page.getByTestId('translate-new-word').click();
  await lookUp(page, request, 'лук', LUK);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await page.getByTestId('translate-back').click();

  // 2. A list session: лук answered right, прочитала wrong.
  await clearGemini(request);
  await expectGeminiPayload(request, DISTRACTORS);
  await page.getByTestId('create-button').click();
  await expect(page.getByTestId('start-button'), `never became ready\n${report()}`).toBeVisible({ timeout: 30_000 });
  await tapUntil(page, 'start-button', 'progress-label');
  for (let position = 1; position <= 4; position++) {
    await expect(page.getByTestId('progress-label')).toHaveText(new RegExp(`${position}\\s*/\\s*4`));
    const prompt = stripIsolates(await page.getByTestId('question-prompt').textContent());
    const options = await Promise.all(
      [0, 1, 2, 3].map(async (i) => stripIsolates(await page.getByTestId(`option-${i}`).textContent())),
    );
    const pick = prompt === 'лук' ? options.findIndex((text) => !WRONG.includes(text)) : options.indexOf(WRONG[0]);
    await page.getByTestId(`option-${pick}`).click();
    await page.getByTestId('continue-button').click();
  }

  // 3. Results: four practised words, the two лук senses moved up to נחשפה.
  await expect(page.getByTestId('practised-row')).toHaveCount(4);
  await expect(page.getByTestId('practised-raised')).toHaveCount(2);
  const raised = page.getByTestId('practised-row').filter({ has: page.getByTestId('practised-raised') });
  for (const row of await raised.all()) {
    await expect(row).toContainText('лук');
    await expect(row.getByTestId('practised-level-name')).toHaveText('נחשפה');
  }

  // 4. The list: лук at נחשפה, прочитать at חדשה.
  await page.getByTestId('results-done').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  const words = page.getByTestId('vocabulary-word');
  await expect(words).toHaveCount(2);
  await expect(words.filter({ hasText: 'лук' }).getByTestId('vocabulary-word-level-name')).toHaveText('נחשפה');
  await expect(words.filter({ hasText: 'прочитать' }).getByTestId('vocabulary-word-level-name')).toHaveText('חדשה');

  // 5. Sort both ways.
  await page.getByTestId('vocabulary-sort-level_desc').click();
  await expect(words.first()).toContainText('лук');
  await page.getByTestId('vocabulary-sort-level_asc').click();
  await expect(words.first()).toContainText('прочитать');

  // 6. Filter, an empty level, and clearing it.
  await page.getByTestId('vocabulary-level-2').click();
  await expect(words).toHaveCount(1);
  await expect(words.first()).toContainText('лук');
  await page.getByTestId('vocabulary-level-2').click();
  await expect(words).toHaveCount(2);
  await page.getByTestId('vocabulary-level-4').click();
  await expect(page.getByTestId('vocabulary-empty-level')).toBeVisible();
  await page.getByTestId('vocabulary-level-4').click();
  await expect(words).toHaveCount(2);

  // 7. A word's detail: five dimensions, one live.
  await words.filter({ hasText: 'лук' }).click();
  await expect(page.getByTestId('vocabulary-sense-level')).toHaveCount(2);
  await expect(page.getByTestId('vocabulary-dimension-written_receptive').first()).toContainText('נחשפה');
  await expect(page.getByTestId('vocabulary-dimension-spelling').first()).toContainText('טרם תורגל');

  expect(diagnostics.pageErrors, report()).toEqual([]);
});
```

- [ ] **Step 2: Run the e2e suite**

Run: `npm run e2e`
Expected: every spec passes, including `progress.spec.ts` and the existing `session.spec.ts`, `next-session.spec.ts` and `vocabulary.spec.ts`.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/progress.spec.ts
git commit -m "test(e2e): a session raises levels; the list sorts and filters by level

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Final verification and spec touch-ups

**Files:**
- Modify: `docs/superpowers/specs/2026-10-05-lang-tutor-phase-20-progress-per-sense-design.md` (status line and the deviations)

- [ ] **Step 1: Run everything**

Run: `npm run typecheck && npm test && npm run test:all && npm run lint:arch && npm run db:check -w apps/server && npm run e2e`
Expected: every command passes. `npm run eval` is untouched by this phase; run it only if `GEMINI_API_KEY` and `GEMINI_MODEL` are set, and expect no change.

- [ ] **Step 2: Plant a check failure**

Confirm the ADR scripts still bite on the new code: add `import { sql } from 'drizzle-orm';` to `apps/server/src/services/sessions.ts`, run `npm run lint:arch`, and expect an R2 violation naming that line. Remove the import and rerun; expect no output.

- [ ] **Step 3: Fold the deviations into the spec**

In the spec, change the status line to:

```markdown
- **Status:** Design approved section by section, 2026-10-05; implemented on branch
  phase-20-progress-per-sense. Deviations from the approved design are folded in.
```

and fold in each difference this plan's header lists:

- §2 `session_progress`: one row for every dimension of every practised saved sense, moved or not;
- §2 Indexes: `sense_progress_enrollment_dimension_idx` with the measurement (35 ms to 12 ms);
- §4 Detail: `level` is null for a word with nothing saved;
- §4 List: a newest cursor keeps the two-element encoding;
- §3 Recompute: `db/progressRecompute.ts` behind `--recompute-progress`, and why it is not a service;
- §7 Unit, mobile: `pipsFor` is what the badge test covers.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-05-lang-tutor-phase-20-progress-per-sense-design.md
git commit -m "docs: phase 20 spec matches what was built

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
