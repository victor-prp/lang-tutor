# Phase 18 — Enrollment Vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A learner saves meanings from a lookup into the active enrollment's word list (one entry per sense), and browses that list paginated, one row per word, with a drill-down to every sense.

**Architecture:** There is one new table, `vocabulary_entries`, keyed `(enrollment_id, sense_id)`, plus a new index on `dict_var_translations`. A new vertical slice follows the existing layers:

- `domain/vocabulary.ts`: pure functions;
- `repo/vocabulary.ts`: the SQL, exported as builders so a plan test can `EXPLAIN` the exact statements;
- `services/vocabulary.ts` and `routes/vocabulary.ts`: the use cases and their routes.

The translation endpoint gains an optional `enrollment_id` and returns `sense_id`, `variant_id` and `saved` on each sense. Mobile gets per-card **שמור** toggles, save-all, and a paginated list and drill-down.

**Tech Stack:** Hono + `@hono/zod-openapi`, Zod 4 in `packages/core`, drizzle-orm 0.45 + drizzle-kit on Postgres, Jest (unit / integration buckets), Expo Router + React Native (web export for e2e), Playwright + MockServer.

**Spec:** `docs/superpowers/specs/2026-10-04-lang-tutor-phase-18-enrollment-vocabulary-design.md`. Read it before starting. Each task argues from it.

## Before Task 1

- [ ] Work in a lane, never on `master` in the main checkout. Create the worktree with
  superpowers:using-git-worktrees on branch `phase-18-enrollment-vocabulary`, then run
  `./scripts/setup-worktree.sh` in it. CLAUDE.md explains why: the script brings the gitignored
  files a new worktree lacks.
- [ ] Copy the spec into the worktree if it is not there yet. It was written untracked on
  `master`. Then commit it:

```bash
git add docs/superpowers/specs/2026-10-04-lang-tutor-phase-18-enrollment-vocabulary-design.md docs/superpowers/plans/2026-10-04-lang-tutor-phase-18-enrollment-vocabulary.md
git commit -m "docs: phase 18 enrollment vocabulary spec and plan"
```

## Global Constraints

- One entry per `(enrollment_id, sense_id)`. A repeat save is `ON CONFLICT DO NOTHING`, so the first form wins.
- Saves come only from target-language lookups. `saved` is present only when `enrollment_id` is given **and** `from` is the enrollment's target **and** the sense has ids.
- Save batch: 1–20 items, all-or-nothing in one transaction.
- List page: `limit` defaults to 50 with a maximum of 100. Keyset cursor on `(last_saved_at, lexeme_id)`, ordered newest save first with `lexeme_id DESC` breaking ties.
- `vocabulary_entries` indexes are exactly the PK `(enrollment_id, sense_id)` and `vocabulary_entries_enrollment_lexeme_idx (enrollment_id, lexeme_id, created_at)`. No single-column FK indexes.
- New `dict_var_translations_sense_language_idx (sense_id, user_language_code)`.
- No `vocabulary_words` rollup table.
- Plan-test budget: the list page for a 20k-entry enrollment has `Execution Time` under 50 ms. No plan may contain a `Seq Scan` on `vocabulary_entries` or `dict_var_translations`.
- Hebrew UI strings, verbatim:
  - `שמור` (save);
  - `נשמר ✓` (saved);
  - `שמור הכל` (save all);
  - `אוצר המילים שלי` (home entry).
- Layering (ADR 0001):
  - routes use `createRoute` (ADR 0003);
  - services call a bare `transaction(...)`;
  - `domain/` imports only `@lang-tutor/core`;
  - repo tests may use drizzle, but route and service tests may not.
- Never hardcode a port or a database name (ADR 0006). Run integration tests and e2e through
  the npm scripts, which use `scripts/lane-env.sh`.
- Every `scripts/check-adr-*.sh` must still pass. Run them with `npm run lint:arch`.

## Review Focus

These are inputs the spec implies but its listed tests don't pin. Each line names the task that adds its test.

1. **The same sense twice in one save batch**, which a double-tapped save-all can send, saves it once and returns 200. A unique-violation 500 would be wrong. *(Task 5)*
2. **`limit=abc`, `limit=0` and `limit=101`** each give 400 with `{ error: 'invalid request' }`, not a 500 or a silent clamp. *(Task 5)*
3. **A saved sense whose saved form no longer renders it** still appears in the drill-down, in the representative rendering, and stays marked saved. *(Task 3)*
4. **A legacy English-explained enrollment** (source `en`, target `he`) gets `saved` on a `he → en` lookup. The direction rule is "from == target", not "to == he". *(Task 6)*
5. **A list page whose lexeme lost every rendering of its saved senses** drops that word instead of crashing or returning a row with no headline, and `next_cursor` still advances. *(Task 4)*

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/src/db/schema.ts` (modify) | `vocabularyEntries` table; index on `dictVarTranslations` |
| `apps/server/src/db/migrations/0010_vocabulary_entries.sql` (generated) | the migration |
| `packages/core/src/api/schemas.ts`, `types.ts`, `index.ts` (modify) | wire contract: sense ids, `enrollment_id`, vocabulary schemas |
| `apps/server/src/domain/vocabulary.ts` (new) | cursor codec, page assembly, drill-down rendering choice and order, `markSaved`, `coversPair`, `firstPerSense` |
| `apps/server/src/repo/vocabulary.ts` (new) | `vocabularyQueries` SQL builders + `createVocabularyRepo` |
| `apps/server/src/services/vocabulary.ts` (new) | save / unsave / listWords / wordDetail use cases |
| `apps/server/src/routes/vocabulary.ts` (new) | four routes |
| `apps/server/src/errors.ts` (modify) | `PairNotEnrolled`, `InvalidVocabularyEntry`, `LexemeNotFound`, `InvalidCursor` |
| `apps/server/src/services/transaction.ts`, `composition.ts`, `app.ts` (modify) | wiring |
| `apps/server/src/domain/dictionary.ts`, `repo/dictionary.ts` (modify) | `SenseRow` gains `senseId` and `variantId`; `rowsToSenses` emits them |
| `apps/server/src/services/translations.ts`, `routes/translations.ts` (modify) | enrollment check, `saved` decoration, new statuses, description |
| `apps/server/tests/support/fakes.ts` (modify) | fake `vocabulary` repo/service slots |
| `apps/mobile/src/api/client.ts` (modify) | four client calls |
| `apps/mobile/src/vocabulary.ts` (new) | pure helpers for toggles, save-all and paging |
| `apps/mobile/src/hooks/useTranslation.tsx`, `app/translate.tsx` (modify) | toggles replace "choose" |
| `apps/mobile/src/hooks/useVocabulary.tsx` (new) | list pages + save/unsave + word detail |
| `apps/mobile/src/app/vocabulary/index.tsx`, `vocabulary/[lexemeId].tsx` (new) | list and drill-down screens |
| `apps/mobile/src/app/index.tsx`, `_layout.tsx`, `strings.ts` (modify) | entry point, provider, strings |
| `e2e/tests/translate.spec.ts` (modify), `e2e/tests/vocabulary.spec.ts` (new) | e2e |
| `docs/adr/adr-0002-di-with-closures.md` (modify) | R6 factory list |

---

### Task 1: Schema and migration

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create (generated): `apps/server/src/db/migrations/0010_vocabulary_entries.sql` and `meta/0010_snapshot.json`, `meta/_journal.json`
- Modify: `apps/server/tests/integration/db/schema.test.ts` (TABLES list)
- Test: `apps/server/tests/integration/db/vocabulary.schema.test.ts`

**Interfaces:**
- Produces: `vocabularyEntries` drizzle table with columns `enrollmentId`, `senseId`, `lexemeId`, `variantId`, `createdAt`; constraint names `vocabulary_entries_pkey`, `vocabulary_entries_enrollment_fk`, `vocabulary_entries_sense_fk`, `vocabulary_entries_lexeme_fk`, `vocabulary_entries_variant_fk`; index names `vocabulary_entries_enrollment_lexeme_idx`, `dict_var_translations_sense_language_idx`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/integration/db/vocabulary.schema.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { insertLexeme } from '../../support/dictRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';

let t: TestDb;
let kite: { lexemeId: string; variantIds: string[]; senseIds: string[] };

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1'); // enrolled in English as e_u_1
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

type Column = 'enrollment' | 'sense' | 'lexeme' | 'variant';
const insert = (over: Partial<Record<Column, string>> = {}) =>
  t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id)
    values (${over.enrollment ?? enrollmentOf('u_1')}, ${over.sense ?? kite.senseIds[0]},
            ${over.lexeme ?? kite.lexemeId}, ${over.variant ?? kite.variantIds[0]})`);

const violating = (constraint: string) =>
  expect.objectContaining({
    cause: expect.objectContaining({ message: expect.stringContaining(constraint) }),
  });

describe('vocabulary_entries', () => {
  it('accepts an entry and stamps created_at', async () => {
    await insert();
    const rows = await t.db.execute<{ created_at: Date }>(
      sql`select created_at from vocabulary_entries`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].created_at).toBeInstanceOf(Date);
  });

  it('holds one entry per (enrollment, sense) — the research decision as a constraint', async () => {
    await insert();
    await expect(insert()).rejects.toThrow(violating('vocabulary_entries_pkey'));
  });

  it.each([
    ['enrollment', 'vocabulary_entries_enrollment_fk'],
    ['sense', 'vocabulary_entries_sense_fk'],
    ['lexeme', 'vocabulary_entries_lexeme_fk'],
    ['variant', 'vocabulary_entries_variant_fk'],
  ] as const)('rejects an unknown %s', async (column, constraint) => {
    await expect(insert({ [column]: 'nope' })).rejects.toThrow(violating(constraint));
  });

  it('is wiped with the dictionary by TRUNCATE ... CASCADE, as db:reseed does', async () => {
    await insert();
    await t.db.execute(sql`truncate dict_lexemes cascade`);
    const rows = await t.db.execute(sql`select 1 from vocabulary_entries`);
    expect(rows.rows).toHaveLength(0);
  });

  it('carries exactly the two indexes the spec names, and no single-column FK index', async () => {
    const rows = await t.db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes where tablename = 'vocabulary_entries'
      order by indexname`);
    expect(rows.rows.map((r) => r.indexname)).toEqual([
      'vocabulary_entries_enrollment_lexeme_idx',
      'vocabulary_entries_pkey',
    ]);
    expect(rows.rows[0].indexdef).toContain('(enrollment_id, lexeme_id, created_at)');
  });

  it('indexes dict_var_translations by sense and language', async () => {
    const rows = await t.db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where indexname = 'dict_var_translations_sense_language_idx'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].indexdef).toContain('(sense_id, user_language_code)');
  });
});
```

In `apps/server/tests/integration/db/schema.test.ts`, add `'vocabulary_entries',` to the `TABLES` array after `'dict_corrections',`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/db/vocabulary.schema.test.ts`
Expected: FAIL with `relation "vocabulary_entries" does not exist`.

- [ ] **Step 3: Add the table and the index to `schema.ts`**

In `apps/server/src/db/schema.ts`, add `index,` to the `drizzle-orm/pg-core` import list, keeping it alphabetical after `foreignKey,`.

In `dictVarTranslations`'s constraint array, after the `check('dict_var_translations_rank_nonneg', …)` line, add:

```ts
    // Phase 18. The primary key leads with variant_id, so "which renderings does
    // this SENSE have in this language" — the vocabulary list's sense_count and
    // the drill-down's representative rendering — would otherwise scan the
    // dictionary's largest table. findSensesByLexeme's join on tr.sense_id
    // benefits too.
    index('dict_var_translations_sense_language_idx').on(t.senseId, t.userLanguageCode),
```

After the `dictCorrections` table, before `questions`, add:

```ts
/**
 * Phase 18. A learner's word list, one row per (enrollment, sense): the research
 * verdict, held as a primary key. Saving a meaning again from another form is ON
 * CONFLICT DO NOTHING, so the first form wins.
 *
 * `variant_id` is the form the sense was first saved from. It is not part of the
 * key; it is here because a sense has no wording of its own — translations and
 * examples live on dict_var_translations, per form — and the saved form is the
 * one rendering certain to exist.
 *
 * `lexeme_id` is a copy of dict_senses.lexeme_id. A sense never changes lexeme,
 * so the copy cannot go stale (dict_variants.language_code's reasoning), and it
 * keeps dict_senses out of every vocabulary read.
 *
 * **No FK to dict_var_translations**, though (variant, sense, language) would be
 * the tightest constraint: repairVariantRenderings deletes and re-inserts a
 * variant's renderings, which a statement-level FK would reject. The service
 * checks the rendering at save time; the repair's "may not drop a sense" rule
 * keeps it true afterwards.
 *
 * **No index on sense_id, variant_id or lexeme_id alone.** Postgres does not
 * index the referencing side of an FK, so a cascade from ONE deleted dictionary
 * row would scan this table. Nothing deletes dictionary rows one at a time:
 * db:reseed's TRUNCATE ... CASCADE does no lookups, and the dictionary has no
 * TTL. A phase that adds a per-row delete adds the index it needs.
 *
 * No user_id: sessions and questions carry one for their composite FK; an entry
 * reaches its learner through its enrollment, and nothing queries by user.
 */
export const vocabularyEntries = pgTable(
  'vocabulary_entries',
  {
    enrollmentId: text('enrollment_id').notNull(),
    senseId: text('sense_id').notNull(),
    lexemeId: text('lexeme_id').notNull(),
    variantId: text('variant_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'vocabulary_entries_pkey', columns: [t.enrollmentId, t.senseId] }),
    foreignKey({
      name: 'vocabulary_entries_enrollment_fk',
      columns: [t.enrollmentId],
      foreignColumns: [enrollments.id],
    }),
    foreignKey({
      name: 'vocabulary_entries_sense_fk',
      columns: [t.senseId],
      foreignColumns: [dictSenses.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'vocabulary_entries_lexeme_fk',
      columns: [t.lexemeId],
      foreignColumns: [dictLexemes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'vocabulary_entries_variant_fk',
      columns: [t.variantId],
      foreignColumns: [dictVariants.id],
    }).onDelete('cascade'),
    // Every read is scoped to one enrollment, which is what keeps the table's
    // total size irrelevant. created_at is a trailing KEY column rather than
    // INCLUDE (drizzle-kit cannot express INCLUDE); either way the list page's
    // GROUP BY lexeme_id / max(created_at) is an index-only scan of one
    // enrollment's slice.
    index('vocabulary_entries_enrollment_lexeme_idx').on(t.enrollmentId, t.lexemeId, t.createdAt),
  ],
);
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate -w apps/server -- --name vocabulary_entries`
Expected: it creates `apps/server/src/db/migrations/0010_vocabulary_entries.sql` and updates `meta/`. Open the SQL and confirm three things:
- a `CREATE TABLE "vocabulary_entries"` with `CONSTRAINT "vocabulary_entries_pkey" PRIMARY KEY("enrollment_id","sense_id")`;
- four `ADD CONSTRAINT … FOREIGN KEY`, three of them `ON DELETE cascade`;
- two `CREATE INDEX` statements.

Prepend this comment to the file, as 0009 does:

```sql
-- Phase 18. A learner's word list, keyed (enrollment, sense), and the index that
-- lets "which renderings does this sense have" avoid scanning
-- dict_var_translations. Nothing is backfilled: no saved-word data exists.
-- The index is built inside the migration transaction (no CONCURRENTLY); check
-- dict_var_translations' production row count before merging (spec §2).
```

Then run `npm run db:check -w apps/server`. Expected: no errors.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/db/`
Expected: PASS. That includes `schema.test.ts`, `migrations.test.ts` and `reseed.test.ts`. If `reseed.test.ts` fails, read the failure before touching anything: `TRUNCATE dict_lexemes … CASCADE` must reach `vocabulary_entries` through the FK, and nothing else should change.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations apps/server/tests/integration/db/vocabulary.schema.test.ts apps/server/tests/integration/db/schema.test.ts
git commit -m "feat(server): vocabulary_entries keyed on (enrollment, sense)"
```

---

### Task 2: Wire contract

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `packages/core/src/api/types.ts`, `packages/core/src/api/index.ts`
- Test: `packages/core/src/api/schemas.test.ts`

**Interfaces:**
- Produces (schemas):
  - `TranslationSenseSchema` gains optional `sense_id`, `variant_id` and `saved`;
  - `TranslationRequestSchema` gains optional `enrollment_id`;
  - `LlmSenseSchema` is unchanged in shape;
  - new: `VocabularyEntryInputSchema`, `SaveVocabularyRequestSchema`, `SaveVocabularyResponseSchema`, `VocabularyPageQuerySchema`, `VocabularyWordSchema`, `VocabularyPageSchema`, `VocabularySenseSchema`, `VocabularyWordDetailSchema`.
- Produces (types, all `z.infer`): `VocabularyEntryInput`, `SaveVocabularyRequest`, `SaveVocabularyResponse`, `VocabularyPageQuery`, `VocabularyWord`, `VocabularyPage`, `VocabularySense`, `VocabularyWordDetail`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/api/schemas.test.ts`. Extend its import from `./schemas` with `LlmSenseSchema`, `SaveVocabularyRequestSchema`, `VocabularyPageQuerySchema` and `VocabularyPageSchema`:

```ts
// Phase 18. The wire sense gained three fields; the MODEL's sense must not. It
// travels to Gemini as responseSchema, where an extra property is either an
// invitation to invent ids or one more state in a schema already at the
// provider's limit (see LlmTranslationSchema's comment).
describe('LlmSenseSchema after phase 18', () => {
  it('still has exactly translation, example and sense_code', () => {
    expect(Object.keys(LlmSenseSchema.shape).sort()).toEqual([
      'example',
      'sense_code',
      'translation',
    ]);
  });
});

describe('TranslationRequestSchema with an enrollment', () => {
  const base = { text: 'окно', from: 'ru', to: 'he' };

  it('accepts a request without enrollment_id, as every client before phase 18 sends', () => {
    expect(TranslationRequestSchema.safeParse(base).success).toBe(true);
  });

  it('accepts an enrollment_id', () => {
    expect(TranslationRequestSchema.safeParse({ ...base, enrollment_id: 'e1' }).success).toBe(true);
  });

  it('rejects an empty enrollment_id', () => {
    expect(TranslationRequestSchema.safeParse({ ...base, enrollment_id: '' }).success).toBe(false);
  });
});

describe('TranslationSenseSchema ids', () => {
  it('accepts a sense with ids and a saved flag', () => {
    expect(
      TranslationSenseSchema.safeParse({
        translation: 'חלון',
        sense_id: 's1',
        variant_id: 'v1',
        saved: false,
      }).success,
    ).toBe(true);
  });
});

describe('SaveVocabularyRequestSchema', () => {
  const entry = { sense_id: 's1', variant_id: 'v1' };

  it('accepts one entry and twenty', () => {
    expect(SaveVocabularyRequestSchema.safeParse({ entries: [entry] }).success).toBe(true);
    expect(
      SaveVocabularyRequestSchema.safeParse({ entries: Array(20).fill(entry) }).success,
    ).toBe(true);
  });

  it('rejects none and twenty-one', () => {
    expect(SaveVocabularyRequestSchema.safeParse({ entries: [] }).success).toBe(false);
    expect(
      SaveVocabularyRequestSchema.safeParse({ entries: Array(21).fill(entry) }).success,
    ).toBe(false);
  });

  it('rejects an entry missing its variant', () => {
    expect(SaveVocabularyRequestSchema.safeParse({ entries: [{ sense_id: 's1' }] }).success).toBe(
      false,
    );
  });
});

describe('VocabularyPageQuerySchema', () => {
  it('coerces a query-string limit', () => {
    expect(VocabularyPageQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 });
  });

  it('leaves both fields optional', () => {
    expect(VocabularyPageQuerySchema.parse({})).toEqual({});
  });

  it.each(['0', '101', 'abc', '1.5', ''])('rejects limit=%j', (limit) => {
    expect(VocabularyPageQuerySchema.safeParse({ limit }).success).toBe(false);
  });
});

describe('VocabularyPageSchema', () => {
  it('accepts a last page', () => {
    expect(VocabularyPageSchema.safeParse({ items: [], next_cursor: null }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w packages/core -- src/api/schemas.test.ts`
Expected: FAIL. TypeScript reports that `SaveVocabularyRequestSchema` and the others are not exported.

- [ ] **Step 3: Implement the schemas**

In `packages/core/src/api/schemas.ts`, replace `TranslationSenseSchema` with:

```ts
export const TranslationSenseSchema = z.object({
  translation: z.string().min(1),
  part_of_speech: z.string().optional(),
  example: z.object({ source: z.string().min(1), target: z.string().min(1) }).optional(),
  // Phase 18. The dictionary rows this sense was served from, so a client can
  // save it. Optional because two answers have none: a sentence is never
  // stored, and a word whose write failed is still answered, with 200, from the
  // model's reply.
  sense_id: z.string().optional(),
  variant_id: z.string().optional(),
  // Present only when the request named an enrollment AND `from` is that
  // enrollment's target language AND the sense has ids. Absent means "cannot be
  // saved here", never "not saved".
  saved: z.boolean().optional(),
});
```

In `TranslationRequestSchema`, replace the phase 16 comment above `from` with the text below, and add `enrollment_id` after `to`:

```ts
    // Phase 16. Always stated by the client: there is no detection. The client
    // reads the pair from the learner's active enrollment.
    from: LanguageCodeSchema,
    to: LanguageCodeSchema,
    // Phase 18. When present, the response marks which senses this enrollment
    // has saved, and it is used for nothing else. This reverses phase 16's "the
    // endpoint never learns who asked" — deliberately, and only for `saved`.
    enrollment_id: z.string().min(1).optional(),
```

Change `LlmSenseSchema` to omit the three new fields:

```ts
export const LlmSenseSchema = TranslationSenseSchema.omit({
  part_of_speech: true,
  // Phase 18's wire-only fields. The model neither knows nor may invent them,
  // and every property here travels to Gemini inside responseSchema.
  sense_id: true,
  variant_id: true,
  saved: true,
}).extend({
  sense_code: z.string().min(1).max(60),
});
```

Append after `TranslationResponseSchema`:

```ts
// Phase 18 — an enrollment's word list. One entry per (enrollment, sense); the
// form it was first saved from travels with it, because a sense has no wording
// of its own.
export const VocabularyEntryInputSchema = z.object({
  sense_id: z.string().min(1),
  variant_id: z.string().min(1),
});

// One card and save-all are the same call. Twenty is four lookups' worth of
// senses, since a lookup answers with at most five.
export const SaveVocabularyRequestSchema = z.object({
  entries: z.array(VocabularyEntryInputSchema).min(1).max(20),
});

// Every sense of the request, saved now or already: saving is idempotent.
export const SaveVocabularyResponseSchema = z.object({
  saved_sense_ids: z.array(z.string()),
});

// Query-string values arrive as strings, hence coerce. A cursor is opaque: the
// server decodes it and answers 400 when it cannot.
export const VocabularyPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

// One row per lexeme. `headline` is the lowest-ranked saved sense, in the
// wording of the form it was saved from; `sense_count` counts the senses with
// some rendering in the enrollment's source language — what the drill-down can
// show.
export const VocabularyWordSchema = z.object({
  lexeme_id: z.string(),
  lemma: z.string(),
  part_of_speech: z.string(),
  headline: z.object({ sense_id: z.string(), translation: z.string(), form: z.string() }),
  saved_count: z.number().int(),
  sense_count: z.number().int(),
});

export const VocabularyPageSchema = z.object({
  items: z.array(VocabularyWordSchema),
  next_cursor: z.string().nullable(),
});

// One sense in the drill-down. `variant_id` and `form` name the rendering shown:
// the saved form for a saved sense, a representative one otherwise. Saving from
// the drill-down records that variant.
export const VocabularySenseSchema = z.object({
  sense_id: z.string(),
  variant_id: z.string(),
  form: z.string(),
  translation: z.string(),
  example: z.object({ source: z.string(), target: z.string() }).optional(),
  saved: z.boolean(),
});

export const VocabularyWordDetailSchema = z.object({
  lexeme_id: z.string(),
  lemma: z.string(),
  part_of_speech: z.string(),
  senses: z.array(VocabularySenseSchema),
});
```

In `packages/core/src/api/types.ts`, add the eight schema names to the `import type` list, then append:

```ts
export type VocabularyEntryInput = z.infer<typeof VocabularyEntryInputSchema>;
export type SaveVocabularyRequest = z.infer<typeof SaveVocabularyRequestSchema>;
export type SaveVocabularyResponse = z.infer<typeof SaveVocabularyResponseSchema>;
export type VocabularyPageQuery = z.infer<typeof VocabularyPageQuerySchema>;
export type VocabularyWord = z.infer<typeof VocabularyWordSchema>;
export type VocabularyPage = z.infer<typeof VocabularyPageSchema>;
export type VocabularySense = z.infer<typeof VocabularySenseSchema>;
export type VocabularyWordDetail = z.infer<typeof VocabularyWordDetailSchema>;
```

In `packages/core/src/api/index.ts`, add the same eight names to the `export type { … }` list, keeping it alphabetical.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w packages/core -- src/api/schemas.test.ts`, then `npm run typecheck`
Expected: PASS for both. If `typecheck` flags `LlmSense` consumers, they now get the same three keys as before, so nothing should change.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/api
git commit -m "feat(core): vocabulary wire contract; sense ids and enrollment_id on translations"
```

---

### Task 3: Domain — `domain/vocabulary.ts`

**Files:**
- Create: `apps/server/src/domain/vocabulary.ts`
- Test: `apps/server/src/domain/vocabulary.test.ts`

**Interfaces:**
- Consumes: types `TranslationSense`, `VocabularyEntryInput`, `VocabularyWord`, `VocabularyWordDetail` from `@lang-tutor/core/api`.
- Produces:
  ```ts
  export type VocabularyCursor = { savedAt: string; lexemeId: string };
  export function encodeCursor(cursor: VocabularyCursor): string;
  export function decodeCursor(raw: string): VocabularyCursor | null;
  export type WordPageRow = { lexemeId: string; lastSavedAt: string };
  export type WordSummary = { lexemeId: string; lemma: string; partOfSpeech: string;
    headlineSenseId: string; headlineTranslation: string; headlineForm: string;
    savedCount: number; senseCount: number };
  export function assemblePage(rows: WordPageRow[], summaries: WordSummary[]): VocabularyWord[];
  export type LexemeRow = { lexemeId: string; lemma: string; partOfSpeech: string; languageCode: string };
  export type LexemeRendering = { senseId: string; variantId: string; form: string; rank: number;
    translation: string; exampleSource: string | null; exampleTarget: string | null };
  export type SavedEntry = { senseId: string; variantId: string };
  export function buildWordDetail(lexeme: LexemeRow, renderings: LexemeRendering[], saved: SavedEntry[]): VocabularyWordDetail;
  export function markSaved(senses: TranslationSense[], saved: ReadonlySet<string>): TranslationSense[];
  export function coversPair(enrollment: { source_language: string; target_language: string }, from: string, to: string): boolean;
  export function firstPerSense(entries: VocabularyEntryInput[]): VocabularyEntryInput[];
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/domain/vocabulary.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';

import {
  assemblePage,
  buildWordDetail,
  coversPair,
  decodeCursor,
  encodeCursor,
  firstPerSense,
  markSaved,
  type LexemeRendering,
  type WordSummary,
} from './vocabulary';

describe('the cursor', () => {
  const cursor = { savedAt: '2026-10-04 12:00:00.123456+00', lexemeId: 'lx-1' };

  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('round-trips a whole second and an offset with minutes', () => {
    const plain = { savedAt: '2026-10-04 12:00:00+05:30', lexemeId: 'lx-2' };
    expect(decodeCursor(encodeCursor(plain))).toEqual(plain);
  });

  it.each([
    ['not base64 json', '!!!'],
    ['an object', Buffer.from('{"a":1}').toString('base64url')],
    ['a junk timestamp', Buffer.from('["yesterday","lx-1"]').toString('base64url')],
    ['an empty lexeme id', Buffer.from('["2026-10-04 12:00:00+00",""]').toString('base64url')],
    ['three elements', Buffer.from('["2026-10-04 12:00:00+00","a","b"]').toString('base64url')],
  ])('refuses %s', (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });
});

const summary = (lexemeId: string, over: Partial<WordSummary> = {}): WordSummary => ({
  lexemeId,
  lemma: `lemma-${lexemeId}`,
  partOfSpeech: 'noun',
  headlineSenseId: `s-${lexemeId}`,
  headlineTranslation: `tr-${lexemeId}`,
  headlineForm: `form-${lexemeId}`,
  savedCount: 1,
  senseCount: 2,
  ...over,
});

describe('assemblePage', () => {
  it('keeps the page order, not the summaries order', () => {
    const rows = [
      { lexemeId: 'b', lastSavedAt: 't2' },
      { lexemeId: 'a', lastSavedAt: 't1' },
    ];
    const page = assemblePage(rows, [summary('a'), summary('b')]);
    expect(page.map((w) => w.lexeme_id)).toEqual(['b', 'a']);
    expect(page[0]).toEqual({
      lexeme_id: 'b',
      lemma: 'lemma-b',
      part_of_speech: 'noun',
      headline: { sense_id: 's-b', translation: 'tr-b', form: 'form-b' },
      saved_count: 1,
      sense_count: 2,
    });
  });

  // Review Focus 5: a word whose saved senses lost every rendering has no
  // headline to show. It is dropped, not served half-empty.
  it('drops a page row with no summary', () => {
    const rows = [
      { lexemeId: 'a', lastSavedAt: 't2' },
      { lexemeId: 'gone', lastSavedAt: 't1' },
    ];
    expect(assemblePage(rows, [summary('a')]).map((w) => w.lexeme_id)).toEqual(['a']);
  });
});

const rendering = (over: Partial<LexemeRendering>): LexemeRendering => ({
  senseId: 's1',
  variantId: 'v1',
  form: 'прочитать',
  rank: 0,
  translation: 'לקרוא',
  exampleSource: null,
  exampleTarget: null,
  ...over,
});

const LEXEME = { lexemeId: 'lx', lemma: 'прочитать', partOfSpeech: 'verb', languageCode: 'ru' };

describe('buildWordDetail', () => {
  it("shows a saved sense in the form it was saved from, even when the lemma's form renders it", () => {
    const detail = buildWordDetail(
      LEXEME,
      [
        rendering({ variantId: 'v-lemma', form: 'прочитать', translation: 'לקרוא' }),
        rendering({ variantId: 'v-past', form: 'прочитала', translation: 'קראה' }),
      ],
      [{ senseId: 's1', variantId: 'v-past' }],
    );
    expect(detail.senses).toEqual([
      { sense_id: 's1', variant_id: 'v-past', form: 'прочитала', translation: 'קראה', saved: true },
    ]);
  });

  it("shows an unsaved sense in the lemma's own form when one exists", () => {
    const detail = buildWordDetail(
      LEXEME,
      [
        rendering({ variantId: 'v-past', form: 'прочитала', translation: 'קראה' }),
        rendering({ variantId: 'v-lemma', form: 'Прочитать', translation: 'לקרוא' }),
      ],
      [],
    );
    expect(detail.senses[0]).toMatchObject({ variant_id: 'v-lemma', saved: false });
  });

  it('otherwise uses the form that renders the most of this lexeme, ties by variant id', () => {
    const detail = buildWordDetail(
      LEXEME,
      [
        rendering({ senseId: 's1', variantId: 'v-b', form: 'прочитаю' }),
        rendering({ senseId: 's2', variantId: 'v-b', form: 'прочитаю', rank: 1 }),
        rendering({ senseId: 's1', variantId: 'v-a', form: 'прочитала' }),
        rendering({ senseId: 's3', variantId: 'v-c', form: 'прочитал', rank: 2 }),
        rendering({ senseId: 's3', variantId: 'v-d', form: 'прочитали', rank: 2 }),
      ],
      [],
    );
    const shown = Object.fromEntries(detail.senses.map((s) => [s.sense_id, s.variant_id]));
    expect(shown).toEqual({ s1: 'v-b', s2: 'v-b', s3: 'v-c' });
  });

  // Review Focus 3: the saved form no longer renders the sense. A repair may not
  // drop a rendering, so this is a backstop — but it must not lose the entry.
  it('falls back to the representative rendering when the saved form no longer renders the sense', () => {
    const detail = buildWordDetail(
      LEXEME,
      [rendering({ variantId: 'v-lemma', form: 'прочитать' })],
      [{ senseId: 's1', variantId: 'v-gone' }],
    );
    expect(detail.senses).toEqual([
      expect.objectContaining({ sense_id: 's1', variant_id: 'v-lemma', saved: true }),
    ]);
  });

  it('orders saved senses first, each group by rank, then by sense id', () => {
    const detail = buildWordDetail(
      LEXEME,
      [
        rendering({ senseId: 's-a', rank: 0 }),
        rendering({ senseId: 's-b', rank: 2 }),
        rendering({ senseId: 's-c', rank: 1 }),
        rendering({ senseId: 's-d', rank: 1 }),
      ],
      [{ senseId: 's-b', variantId: 'v1' }],
    );
    expect(detail.senses.map((s) => s.sense_id)).toEqual(['s-b', 's-a', 's-c', 's-d']);
  });

  it('carries an example only when both halves are present', () => {
    const detail = buildWordDetail(
      LEXEME,
      [
        rendering({ senseId: 's1', exampleSource: 'Я прочитала книгу.', exampleTarget: 'קראתי את הספר.' }),
        rendering({ senseId: 's2', rank: 1, exampleSource: 'half', exampleTarget: null }),
      ],
      [],
    );
    expect(detail.senses[0].example).toEqual({
      source: 'Я прочитала книгу.',
      target: 'קראתי את הספר.',
    });
    expect(detail.senses[1]).not.toHaveProperty('example');
  });

  it('carries the lexeme fields', () => {
    expect(buildWordDetail(LEXEME, [], [])).toEqual({
      lexeme_id: 'lx',
      lemma: 'прочитать',
      part_of_speech: 'verb',
      senses: [],
    });
  });
});

describe('markSaved', () => {
  it('marks senses with ids and leaves a sense without ids alone', () => {
    const marked = markSaved(
      [
        { translation: 'a', sense_id: 's1', variant_id: 'v1' },
        { translation: 'b', sense_id: 's2', variant_id: 'v1' },
        { translation: 'sentence' },
      ],
      new Set(['s2']),
    );
    expect(marked.map((s) => s.saved)).toEqual([false, true, undefined]);
    expect(marked[2]).not.toHaveProperty('saved');
  });
});

describe('coversPair', () => {
  const ru = { source_language: 'he', target_language: 'ru' };

  it('covers both directions of the enrollment pair', () => {
    expect(coversPair(ru, 'ru', 'he')).toBe(true);
    expect(coversPair(ru, 'he', 'ru')).toBe(true);
  });

  it('refuses any other pair', () => {
    expect(coversPair(ru, 'en', 'he')).toBe(false);
    expect(coversPair(ru, 'he', 'en')).toBe(false);
  });
});

describe('firstPerSense', () => {
  // Review Focus 1: a double-tapped save-all sends a sense twice.
  it('keeps the first entry of each sense, in order', () => {
    expect(
      firstPerSense([
        { sense_id: 's1', variant_id: 'v1' },
        { sense_id: 's2', variant_id: 'v1' },
        { sense_id: 's1', variant_id: 'v2' },
      ]),
    ).toEqual([
      { sense_id: 's1', variant_id: 'v1' },
      { sense_id: 's2', variant_id: 'v1' },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w apps/server -- src/domain/vocabulary.test.ts`
Expected: FAIL with `Cannot find module './vocabulary'`.

- [ ] **Step 3: Implement**

Create `apps/server/src/domain/vocabulary.ts`:

```ts
import type {
  TranslationSense,
  VocabularyEntryInput,
  VocabularyWord,
  VocabularyWordDetail,
} from '@lang-tutor/core/api';

/**
 * Where the next list page starts: the last row's newest save and its lexeme id.
 *
 * `savedAt` is Postgres's own text for a timestamptz, never a JS Date. A Date
 * keeps milliseconds and created_at keeps microseconds, so a cursor rounded down
 * would silently skip every word saved later in the same millisecond. The
 * repository prints it with `::text` and casts it back with `::timestamptz`, and
 * the round trip is exact.
 */
export type VocabularyCursor = { savedAt: string; lexemeId: string };

// What `timestamptz::text` prints under DateStyle ISO: `2026-10-04 12:00:00.123456+00`.
// Anything else is refused here, because the repository casts it with
// ::timestamptz and a junk string there would be a 500 rather than a 400.
const PG_TIMESTAMPTZ = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

export function encodeCursor(cursor: VocabularyCursor): string {
  return Buffer.from(JSON.stringify([cursor.savedAt, cursor.lexemeId]), 'utf8').toString(
    'base64url',
  );
}

/** `null` for anything this server did not issue. The caller turns that into a 400. */
export function decodeCursor(raw: string): VocabularyCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [savedAt, lexemeId] = parsed as unknown[];
  if (typeof savedAt !== 'string' || !PG_TIMESTAMPTZ.test(savedAt)) return null;
  if (typeof lexemeId !== 'string' || lexemeId.length === 0) return null;
  return { savedAt, lexemeId };
}

/** One row of the grouped keyset read, in page order. */
export type WordPageRow = { lexemeId: string; lastSavedAt: string };

/** What the page's enrichment read returns per lexeme. Declared here rather than
 *  imported from the repository: R3 keeps this layer ignorant of Drizzle. */
export type WordSummary = {
  lexemeId: string;
  lemma: string;
  partOfSpeech: string;
  headlineSenseId: string;
  headlineTranslation: string;
  headlineForm: string;
  savedCount: number;
  senseCount: number;
};

/**
 * Page rows to the wire, in PAGE order. The enrichment read is keyed by lexeme
 * id and comes back in whatever order Postgres chose.
 *
 * A row with no summary is dropped. The enrichment read inner-joins each saved
 * entry to its saved form's rendering, so a word whose saved senses lost every
 * rendering has nothing to headline. A repair may not drop a rendering, so this
 * should not happen; if it does, the page is one word short and the cursor —
 * taken from the page rows, not from this output — still advances.
 */
export function assemblePage(rows: WordPageRow[], summaries: WordSummary[]): VocabularyWord[] {
  const byLexeme = new Map(summaries.map((s) => [s.lexemeId, s]));
  return rows.flatMap((row) => {
    const s = byLexeme.get(row.lexemeId);
    if (!s) return [];
    return [
      {
        lexeme_id: s.lexemeId,
        lemma: s.lemma,
        part_of_speech: s.partOfSpeech,
        headline: {
          sense_id: s.headlineSenseId,
          translation: s.headlineTranslation,
          form: s.headlineForm,
        },
        saved_count: s.savedCount,
        sense_count: s.senseCount,
      },
    ];
  });
}

export type LexemeRow = {
  lexemeId: string;
  lemma: string;
  partOfSpeech: string;
  languageCode: string;
};

/** One rendering of one of the lexeme's senses, by one of its forms, in the
 *  enrollment's source language. */
export type LexemeRendering = {
  senseId: string;
  variantId: string;
  form: string;
  rank: number;
  translation: string;
  exampleSource: string | null;
  exampleTarget: string | null;
};

export type SavedEntry = { senseId: string; variantId: string };

/**
 * The drill-down: every sense the lexeme can show in this language, each in one
 * rendering, saved senses first.
 *
 * Which rendering:
 * - a saved sense is shown in its saved form;
 * - an unsaved one in a representative form — the lemma's own spelling if anyone
 *   looked it up, otherwise the form that renders the most of this lexeme, ties
 *   broken by variant id.
 *
 * A saved sense whose saved form no longer renders it falls back to the
 * representative and stays saved. Ranks compared across forms are approximate —
 * rank is per form — and that is accepted: it orders a short list, it ranks
 * nothing that is stored.
 */
export function buildWordDetail(
  lexeme: LexemeRow,
  renderings: LexemeRendering[],
  saved: SavedEntry[],
): VocabularyWordDetail {
  const savedVariant = new Map(saved.map((entry) => [entry.senseId, entry.variantId]));
  const perVariant = new Map<string, number>();
  for (const r of renderings) perVariant.set(r.variantId, (perVariant.get(r.variantId) ?? 0) + 1);

  const lemma = lexeme.lemma.toLowerCase();
  const isLemma = (r: LexemeRendering) => Number(r.form.toLowerCase() === lemma);
  const better = (a: LexemeRendering, b: LexemeRendering) =>
    isLemma(b) - isLemma(a) ||
    perVariant.get(b.variantId)! - perVariant.get(a.variantId)! ||
    a.variantId.localeCompare(b.variantId);

  const bySense = new Map<string, LexemeRendering[]>();
  for (const r of renderings) {
    const list = bySense.get(r.senseId) ?? [];
    list.push(r);
    bySense.set(r.senseId, list);
  }

  const shown = [...bySense.entries()].map(([senseId, options]) => {
    const own = savedVariant.get(senseId);
    return {
      rendering: options.find((o) => o.variantId === own) ?? [...options].sort(better)[0],
      saved: savedVariant.has(senseId),
    };
  });

  shown.sort(
    (a, b) =>
      Number(b.saved) - Number(a.saved) ||
      a.rendering.rank - b.rendering.rank ||
      a.rendering.senseId.localeCompare(b.rendering.senseId),
  );

  return {
    lexeme_id: lexeme.lexemeId,
    lemma: lexeme.lemma,
    part_of_speech: lexeme.partOfSpeech,
    senses: shown.map(({ rendering: r, saved: isSaved }) => ({
      sense_id: r.senseId,
      variant_id: r.variantId,
      form: r.form,
      translation: r.translation,
      ...(r.exampleSource && r.exampleTarget
        ? { example: { source: r.exampleSource, target: r.exampleTarget } }
        : {}),
      saved: isSaved,
    })),
  };
}

/** `saved` on every sense that carries an id; a sense without one (a sentence, a
 *  failed write) is returned untouched, with no `saved` key at all. */
export function markSaved(
  senses: TranslationSense[],
  saved: ReadonlySet<string>,
): TranslationSense[] {
  return senses.map((sense) =>
    sense.sense_id === undefined ? sense : { ...sense, saved: saved.has(sense.sense_id) },
  );
}

/** Whether a lookup's pair is the enrollment's, in either direction. */
export function coversPair(
  enrollment: { source_language: string; target_language: string },
  from: string,
  to: string,
): boolean {
  return (
    (from === enrollment.target_language && to === enrollment.source_language) ||
    (from === enrollment.source_language && to === enrollment.target_language)
  );
}

/** The first entry of each sense, in order. Saving is first-form-wins in the
 *  database too, so this only spares a batch from validating a duplicate. */
export function firstPerSense(entries: VocabularyEntryInput[]): VocabularyEntryInput[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.sense_id)) return false;
    seen.add(entry.sense_id);
    return true;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w apps/server -- src/domain/vocabulary.test.ts`, then `npm run lint:arch`
Expected: PASS. ADR 0001 R3 must stay quiet: the only import is from `@lang-tutor/core/api`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain/vocabulary.ts apps/server/src/domain/vocabulary.test.ts
git commit -m "feat(server): vocabulary domain — cursor, page assembly, drill-down rendering"
```

---

### Task 4: Repository — `repo/vocabulary.ts`

**Files:**
- Create: `apps/server/src/repo/vocabulary.ts`
- Modify: `apps/server/src/services/transaction.ts`, `apps/server/src/composition.ts`, `apps/server/tests/support/fakes.ts`
- Test: `apps/server/tests/integration/repo/vocabulary.test.ts`

**Interfaces:**
- Consumes: `vocabularyEntries`, `dictLexemes` (Task 1); `VocabularyCursor`, `WordPageRow`, `WordSummary`, `LexemeRow`, `LexemeRendering`, `SavedEntry` (Task 3).
- Produces:
  ```ts
  export type SaveableEntry = { senseId: string; variantId: string; lexemeId: string };
  export const vocabularyQueries: {
    saveable(input: { entries: { senseId: string; variantId: string }[]; targetLanguage: string; sourceLanguage: string }): SQL;
    savedSenseIds(input: { enrollmentId: string; senseIds: string[] }): SQL;
    wordsPage(input: { enrollmentId: string; limit: number; after: VocabularyCursor | null }): SQL;
    wordSummaries(input: { enrollmentId: string; lexemeIds: string[]; sourceLanguage: string }): SQL;
    lexemeRenderings(input: { lexemeId: string; userLanguageCode: string }): SQL;
    savedInLexeme(input: { enrollmentId: string; lexemeId: string }): SQL;
  };
  export function createVocabularyRepo(tx: Tx): {
    findSaveable(input): Promise<SaveableEntry[]>;
    insertEntries(input: { enrollmentId: string; entries: SaveableEntry[] }): Promise<void>;
    deleteEntry(input: { enrollmentId: string; senseId: string }): Promise<void>;
    findSavedSenseIds(input: { enrollmentId: string; senseIds: string[] }): Promise<string[]>;
    findWordsPage(input: { enrollmentId: string; limit: number; after: VocabularyCursor | null }): Promise<WordPageRow[]>;
    findWordSummaries(input: { enrollmentId: string; lexemeIds: string[]; sourceLanguage: string }): Promise<WordSummary[]>;
    findLexeme(lexemeId: string): Promise<LexemeRow | undefined>;
    findLexemeRenderings(input: { lexemeId: string; userLanguageCode: string }): Promise<LexemeRendering[]>;
    findSavedInLexeme(input: { enrollmentId: string; lexemeId: string }): Promise<SavedEntry[]>;
  };
  export type VocabularyRepo = ReturnType<typeof createVocabularyRepo>;
  ```
- `Repos` gains `vocabulary: VocabularyRepo`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/tests/integration/repo/vocabulary.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { sql } from 'drizzle-orm';

import { createVocabularyRepo } from '../../../src/repo/vocabulary';
import { insertLexeme } from '../../support/dictRows';
import { enrollmentOf, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { withTx } from '../../support/withTx';

let t: TestDb;
const E = enrollmentOf('u_1'); // he → en
let kite: { lexemeId: string; variantIds: string[]; senseIds: string[] };
let hebrew: { lexemeId: string; variantIds: string[]; senseIds: string[] };

// `kite` renders both senses; `kites` renders only the toy, ranked first.
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
      {
        form: 'kites',
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'toy', rank: 0, translation: 'עפיפונים', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
  hebrew = await insertLexeme(t.db, {
    lemma: 'ספר',
    languageCode: 'he',
    partOfSpeech: 'noun',
    userLanguageCode: 'en',
    senses: [{ senseCode: 'book' }],
    variants: [
      {
        form: 'ספר',
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'book', rank: 0, translation: 'book', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
});
afterEach(async () => {
  await t.close();
});

const repo = <T>(fn: (r: ReturnType<typeof createVocabularyRepo>) => Promise<T>) =>
  withTx(t.db, (tx) => fn(createVocabularyRepo(tx)));

const [TOY, BIRD] = [0, 1];
const [KITE, KITES] = [0, 1];
const pair = (sense: number, variant: number) => ({
  senseId: kite.senseIds[sense],
  variantId: kite.variantIds[variant],
});

describe('findSaveable', () => {
  const ask = (entries: { senseId: string; variantId: string }[], target = 'en', source = 'he') =>
    repo((r) => r.findSaveable({ entries, targetLanguage: target, sourceLanguage: source }));

  it('passes a pair whose form renders the sense in the source language, with its lexeme', async () => {
    expect(await ask([pair(TOY, KITES)])).toEqual([{ ...pair(TOY, KITES), lexemeId: kite.lexemeId }]);
  });

  it('refuses a form that does not render that sense', async () => {
    expect(await ask([pair(BIRD, KITES)])).toEqual([]);
  });

  it("refuses a variant of another lexeme", async () => {
    expect(
      await ask([{ senseId: kite.senseIds[TOY], variantId: hebrew.variantIds[0] }]),
    ).toEqual([]);
  });

  it("refuses a sense outside the enrollment's target language", async () => {
    expect(
      await ask([{ senseId: hebrew.senseIds[0], variantId: hebrew.variantIds[0] }]),
    ).toEqual([]);
  });

  it("refuses a rendering in a language other than the enrollment's source", async () => {
    expect(await ask([pair(TOY, KITE)], 'en', 'ru')).toEqual([]);
  });

  it('answers nothing for nothing, without a query', async () => {
    expect(await ask([])).toEqual([]);
  });
});

describe('insertEntries and deleteEntry', () => {
  const entry = (sense: number, variant: number) => ({ ...pair(sense, variant), lexemeId: kite.lexemeId });

  it('keeps the first form when the same sense is saved again', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITES)] }));
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITE)] }));
    expect(await repo((r) => r.findSavedInLexeme({ enrollmentId: E, lexemeId: kite.lexemeId }))).toEqual([
      pair(TOY, KITES),
    ]);
  });

  it('deletes idempotently', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITE)] }));
    await repo((r) => r.deleteEntry({ enrollmentId: E, senseId: kite.senseIds[TOY] }));
    await repo((r) => r.deleteEntry({ enrollmentId: E, senseId: kite.senseIds[TOY] }));
    expect(await repo((r) => r.findSavedSenseIds({ enrollmentId: E, senseIds: kite.senseIds }))).toEqual([]);
  });

  it('finds which of the asked senses are saved', async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(BIRD, KITE)] }));
    expect(
      await repo((r) => r.findSavedSenseIds({ enrollmentId: E, senseIds: kite.senseIds })),
    ).toEqual([kite.senseIds[BIRD]]);
    expect(await repo((r) => r.findSavedSenseIds({ enrollmentId: E, senseIds: [] }))).toEqual([]);
  });
});

// Direct inserts with chosen timestamps: ordering must be provable against rows
// a test chose, not against how fast two transactions happened to commit.
async function saveAt(lexemeId: string, senseId: string, variantId: string, at: string) {
  await t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id, created_at)
    values (${E}, ${senseId}, ${lexemeId}, ${variantId}, ${at}::timestamptz)`);
}

async function lexemes(n: number) {
  const out: { lexemeId: string; senseId: string; variantId: string }[] = [];
  for (let i = 0; i < n; i += 1) {
    const ids = await insertLexeme(t.db, {
      lemma: `word${i}`,
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'only' }],
      variants: [
        {
          form: `word${i}`,
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'only', rank: 0, translation: `מילה${i}`, exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    out.push({ lexemeId: ids.lexemeId, senseId: ids.senseIds[0], variantId: ids.variantIds[0] });
  }
  return out;
}

describe('findWordsPage', () => {
  it('orders lexemes by their newest save, keeps microseconds, and continues strictly after a cursor', async () => {
    const [a, b, c] = await lexemes(3);
    await saveAt(a.lexemeId, a.senseId, a.variantId, '2026-10-04 12:00:00.000001+00');
    await saveAt(b.lexemeId, b.senseId, b.variantId, '2026-10-04 12:00:00.000003+00');
    await saveAt(c.lexemeId, c.senseId, c.variantId, '2026-10-04 12:00:00.000002+00');

    const first = await repo((r) => r.findWordsPage({ enrollmentId: E, limit: 2, after: null }));
    expect(first.map((row) => row.lexemeId)).toEqual([b.lexemeId, c.lexemeId]);

    const last = first[first.length - 1];
    const rest = await repo((r) =>
      r.findWordsPage({
        enrollmentId: E,
        limit: 2,
        after: { savedAt: last.lastSavedAt, lexemeId: last.lexemeId },
      }),
    );
    // Same millisecond, different microsecond: a Date-based cursor would lose `a`.
    expect(rest.map((row) => row.lexemeId)).toEqual([a.lexemeId]);
  });

  it("groups a lexeme's senses into one row at its newest save", async () => {
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 13:00:00+00');
    const page = await repo((r) => r.findWordsPage({ enrollmentId: E, limit: 50, after: null }));
    expect(page).toHaveLength(1);
    expect(page[0].lastSavedAt).toMatch(/^2026-10-04 13:00:00/);
  });
});

describe('findWordSummaries', () => {
  it('headlines the lowest-ranked saved sense in its saved form, and counts', async () => {
    // bird is rank 1 in `kite`; toy is rank 0 in `kites`, so toy headlines.
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITES], '2026-10-04 13:00:00+00');
    expect(
      await repo((r) =>
        r.findWordSummaries({ enrollmentId: E, lexemeIds: [kite.lexemeId], sourceLanguage: 'he' }),
      ),
    ).toEqual([
      {
        lexemeId: kite.lexemeId,
        lemma: 'kite',
        partOfSpeech: 'noun',
        headlineSenseId: kite.senseIds[TOY],
        headlineTranslation: 'עפיפונים',
        headlineForm: 'kites',
        savedCount: 2,
        senseCount: 2,
      },
    ]);
  });

  it('breaks a rank tie by the earlier save', async () => {
    // Make bird rank 0 in `kite` (toy moves to 2), so both saved senses are rank 0
    // in their own saved forms: toy in `kites`, bird in `kite`.
    await t.db.execute(sql`
      update dict_var_translations set rank = 2
       where variant_id = ${kite.variantIds[KITE]} and sense_id = ${kite.senseIds[TOY]}`);
    await t.db.execute(sql`
      update dict_var_translations set rank = 0
       where variant_id = ${kite.variantIds[KITE]} and sense_id = ${kite.senseIds[BIRD]}`);
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITES], '2026-10-04 13:00:00+00');
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    const [summary] = await repo((r) =>
      r.findWordSummaries({ enrollmentId: E, lexemeIds: [kite.lexemeId], sourceLanguage: 'he' }),
    );
    // bird was saved first.
    expect(summary.headlineSenseId).toBe(kite.senseIds[BIRD]);
  });

  // Review Focus 5, at the source.
  it('returns no summary for a lexeme whose saved senses have no rendering left', async () => {
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await t.db.execute(sql`delete from dict_var_translations
      where sense_id = ${kite.senseIds[BIRD]} and variant_id = ${kite.variantIds[KITE]}`);
    expect(
      await repo((r) =>
        r.findWordSummaries({ enrollmentId: E, lexemeIds: [kite.lexemeId], sourceLanguage: 'he' }),
      ),
    ).toEqual([]);
  });

  it('answers nothing for no lexemes', async () => {
    expect(
      await repo((r) => r.findWordSummaries({ enrollmentId: E, lexemeIds: [], sourceLanguage: 'he' })),
    ).toEqual([]);
  });
});

describe('the drill-down reads', () => {
  it('finds a lexeme with its language', async () => {
    expect(await repo((r) => r.findLexeme(kite.lexemeId))).toEqual({
      lexemeId: kite.lexemeId,
      lemma: 'kite',
      partOfSpeech: 'noun',
      languageCode: 'en',
    });
    expect(await repo((r) => r.findLexeme('nope'))).toBeUndefined();
  });

  it("returns every rendering of the lexeme's senses in one language", async () => {
    const rows = await repo((r) =>
      r.findLexemeRenderings({ lexemeId: kite.lexemeId, userLanguageCode: 'he' }),
    );
    expect(rows.map((row) => `${row.form}:${row.translation}`).sort()).toEqual([
      'kite:דיה',
      'kite:עפיפון',
      'kites:עפיפונים',
    ]);
    expect(
      await repo((r) => r.findLexemeRenderings({ lexemeId: kite.lexemeId, userLanguageCode: 'ru' })),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/repo/vocabulary.test.ts`
Expected: FAIL with `Cannot find module '../../../src/repo/vocabulary'`.

- [ ] **Step 3: Implement the repository**

Create `apps/server/src/repo/vocabulary.ts`:

```ts
import { and, eq, sql, type SQL } from 'drizzle-orm';

import type { Tx } from '../db/client';
import { dictLexemes, vocabularyEntries } from '../db/schema';
import type {
  LexemeRendering,
  LexemeRow,
  SavedEntry,
  VocabularyCursor,
  WordPageRow,
  WordSummary,
} from '../domain/vocabulary';

/** A pair that passed `findSaveable`, carrying the lexeme id the entry copies. */
export type SaveableEntry = { senseId: string; variantId: string; lexemeId: string };

// `IN (...)` from a list. Every caller guards the empty list first: `IN ()` is a
// syntax error, and an empty list has an obvious answer that needs no query.
const inList = (values: string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);

/**
 * Every read this repository runs, as a builder. Exported so
 * tests/integration/repo/vocabulary.plan.test.ts can EXPLAIN exactly these
 * statements at volume: a plan test of hand-copied SQL would prove something
 * about a query nobody runs.
 *
 * Every one is scoped to ONE enrollment or ONE lexeme and served by an index
 * leading with it — that is what keeps the table's total size irrelevant (spec
 * §3, "Cost of every query").
 */
export const vocabularyQueries = {
  /** Which asked pairs may be saved: the sense's lexeme is in the target
   *  language, the variant belongs to that lexeme, and the variant renders the
   *  sense in the source language. PK lookups throughout. */
  saveable: (input: {
    entries: { senseId: string; variantId: string }[];
    targetLanguage: string;
    sourceLanguage: string;
  }): SQL => sql`
    SELECT s.id AS sense_id, v.id AS variant_id, l.id AS lexeme_id
    FROM (VALUES ${sql.join(
      input.entries.map((e) => sql`(${e.senseId}::text, ${e.variantId}::text)`),
      sql`, `,
    )}) AS asked(sense_id, variant_id)
    JOIN dict_senses s            ON s.id = asked.sense_id
    JOIN dict_lexemes l           ON l.id = s.lexeme_id
                                 AND l.language_code = ${input.targetLanguage}
    JOIN dict_variants v          ON v.id = asked.variant_id
                                 AND v.lexeme_id = l.id
    JOIN dict_var_translations tr ON tr.variant_id = v.id
                                 AND tr.sense_id = s.id
                                 AND tr.user_language_code = ${input.sourceLanguage}`,

  /** The lookup's `saved` flags: point lookups on the primary key. */
  savedSenseIds: (input: { enrollmentId: string; senseIds: string[] }): SQL => sql`
    SELECT sense_id FROM vocabulary_entries
    WHERE enrollment_id = ${input.enrollmentId}
      AND sense_id IN (${inList(input.senseIds)})`,

  /**
   * One page of lexemes, newest save first. The grouping is an index-only scan
   * of this enrollment's slice of (enrollment_id, lexeme_id, created_at).
   *
   * The timestamp goes out as `::text` and comes back with `::timestamptz` —
   * microseconds intact; see VocabularyCursor. The row comparison is strictly
   * "after the cursor" in DESC order, so a word that moves to the top between
   * pages is never served twice.
   */
  wordsPage: (input: {
    enrollmentId: string;
    limit: number;
    after: VocabularyCursor | null;
  }): SQL => sql`
    SELECT lexeme_id, max(created_at)::text AS last_saved_at
    FROM vocabulary_entries
    WHERE enrollment_id = ${input.enrollmentId}
    GROUP BY lexeme_id
    ${
      input.after
        ? sql`HAVING (max(created_at), lexeme_id) < (${input.after.savedAt}::timestamptz, ${input.after.lexemeId}::text)`
        : sql``
    }
    ORDER BY max(created_at) DESC, lexeme_id DESC
    LIMIT ${input.limit}`,

  /**
   * One row per lexeme of a page: the headline, the two counts. The LATERAL is
   * an INNER join on purpose — a word with no rendered saved sense has nothing
   * to headline and is dropped (assemblePage's comment).
   *
   * Headline: lowest rank in its own saved form, then the earliest save, then
   * sense id — deterministic, and all inside SQL so no timestamp crosses into
   * TypeScript.
   */
  wordSummaries: (input: {
    enrollmentId: string;
    lexemeIds: string[];
    sourceLanguage: string;
  }): SQL => sql`
    SELECT l.id AS lexeme_id, l.lemma, l.part_of_speech,
           h.sense_id AS headline_sense_id,
           h.translation AS headline_translation,
           h.form AS headline_form,
           (SELECT count(*) FROM vocabulary_entries c
             WHERE c.enrollment_id = ${input.enrollmentId}
               AND c.lexeme_id = l.id)::int AS saved_count,
           (SELECT count(*) FROM dict_senses s
             WHERE s.lexeme_id = l.id
               AND EXISTS (SELECT 1 FROM dict_var_translations r
                            WHERE r.sense_id = s.id
                              AND r.user_language_code = ${input.sourceLanguage}))::int AS sense_count
    FROM dict_lexemes l
    JOIN LATERAL (
      SELECT ve.sense_id, tr.translation, v.form
      FROM vocabulary_entries ve
      JOIN dict_var_translations tr ON tr.variant_id = ve.variant_id
                                   AND tr.sense_id = ve.sense_id
                                   AND tr.user_language_code = ${input.sourceLanguage}
      JOIN dict_variants v          ON v.id = ve.variant_id
      WHERE ve.enrollment_id = ${input.enrollmentId}
        AND ve.lexeme_id = l.id
      ORDER BY tr.rank, ve.created_at, ve.sense_id
      LIMIT 1
    ) h ON true
    WHERE l.id IN (${inList(input.lexemeIds)})`,

  /** Every rendering of one lexeme's senses in one language, by any form. */
  lexemeRenderings: (input: { lexemeId: string; userLanguageCode: string }): SQL => sql`
    SELECT tr.sense_id, tr.variant_id, v.form, tr.rank, tr.translation,
           tr.example_source, tr.example_target
    FROM dict_senses s
    JOIN dict_var_translations tr ON tr.sense_id = s.id
                                 AND tr.user_language_code = ${input.userLanguageCode}
    JOIN dict_variants v          ON v.id = tr.variant_id
    WHERE s.lexeme_id = ${input.lexemeId}`,

  /** One lexeme's saved senses in one enrollment. */
  savedInLexeme: (input: { enrollmentId: string; lexemeId: string }): SQL => sql`
    SELECT sense_id, variant_id FROM vocabulary_entries
    WHERE enrollment_id = ${input.enrollmentId}
      AND lexeme_id = ${input.lexemeId}`,
};

export function createVocabularyRepo(tx: Tx) {
  return {
    findSaveable: async (input: {
      entries: { senseId: string; variantId: string }[];
      targetLanguage: string;
      sourceLanguage: string;
    }): Promise<SaveableEntry[]> => {
      if (input.entries.length === 0) return [];
      const rows = await tx.execute<{ sense_id: string; variant_id: string; lexeme_id: string }>(
        vocabularyQueries.saveable(input),
      );
      return rows.rows.map((row) => ({
        senseId: row.sense_id,
        variantId: row.variant_id,
        lexemeId: row.lexeme_id,
      }));
    },

    /** First form wins: a sense already saved keeps the variant it was saved from. */
    insertEntries: async (input: { enrollmentId: string; entries: SaveableEntry[] }): Promise<void> => {
      if (input.entries.length === 0) return;
      await tx
        .insert(vocabularyEntries)
        .values(input.entries.map((entry) => ({ enrollmentId: input.enrollmentId, ...entry })))
        // Named, not bare: only the PK may be swallowed. An FK violation must raise.
        .onConflictDoNothing({ target: [vocabularyEntries.enrollmentId, vocabularyEntries.senseId] });
    },

    deleteEntry: async (input: { enrollmentId: string; senseId: string }): Promise<void> => {
      await tx
        .delete(vocabularyEntries)
        .where(
          and(
            eq(vocabularyEntries.enrollmentId, input.enrollmentId),
            eq(vocabularyEntries.senseId, input.senseId),
          ),
        );
    },

    findSavedSenseIds: async (input: { enrollmentId: string; senseIds: string[] }): Promise<string[]> => {
      if (input.senseIds.length === 0) return [];
      const rows = await tx.execute<{ sense_id: string }>(vocabularyQueries.savedSenseIds(input));
      return rows.rows.map((row) => row.sense_id);
    },

    findWordsPage: async (input: {
      enrollmentId: string;
      limit: number;
      after: VocabularyCursor | null;
    }): Promise<WordPageRow[]> => {
      const rows = await tx.execute<{ lexeme_id: string; last_saved_at: string }>(
        vocabularyQueries.wordsPage(input),
      );
      return rows.rows.map((row) => ({ lexemeId: row.lexeme_id, lastSavedAt: row.last_saved_at }));
    },

    findWordSummaries: async (input: {
      enrollmentId: string;
      lexemeIds: string[];
      sourceLanguage: string;
    }): Promise<WordSummary[]> => {
      if (input.lexemeIds.length === 0) return [];
      const rows = await tx.execute<{
        lexeme_id: string;
        lemma: string;
        part_of_speech: string;
        headline_sense_id: string;
        headline_translation: string;
        headline_form: string;
        saved_count: number;
        sense_count: number;
      }>(vocabularyQueries.wordSummaries(input));
      return rows.rows.map((row) => ({
        lexemeId: row.lexeme_id,
        lemma: row.lemma,
        partOfSpeech: row.part_of_speech,
        headlineSenseId: row.headline_sense_id,
        headlineTranslation: row.headline_translation,
        headlineForm: row.headline_form,
        savedCount: row.saved_count,
        senseCount: row.sense_count,
      }));
    },

    findLexeme: async (lexemeId: string): Promise<LexemeRow | undefined> => {
      const [row] = await tx
        .select({
          lexemeId: dictLexemes.id,
          lemma: dictLexemes.lemma,
          partOfSpeech: dictLexemes.partOfSpeech,
          languageCode: dictLexemes.languageCode,
        })
        .from(dictLexemes)
        .where(eq(dictLexemes.id, lexemeId));
      return row;
    },

    findLexemeRenderings: async (input: {
      lexemeId: string;
      userLanguageCode: string;
    }): Promise<LexemeRendering[]> => {
      const rows = await tx.execute<{
        sense_id: string;
        variant_id: string;
        form: string;
        rank: number;
        translation: string;
        example_source: string | null;
        example_target: string | null;
      }>(vocabularyQueries.lexemeRenderings(input));
      return rows.rows.map((row) => ({
        senseId: row.sense_id,
        variantId: row.variant_id,
        form: row.form,
        rank: row.rank,
        translation: row.translation,
        exampleSource: row.example_source,
        exampleTarget: row.example_target,
      }));
    },

    findSavedInLexeme: async (input: { enrollmentId: string; lexemeId: string }): Promise<SavedEntry[]> => {
      const rows = await tx.execute<{ sense_id: string; variant_id: string }>(
        vocabularyQueries.savedInLexeme(input),
      );
      return rows.rows.map((row) => ({ senseId: row.sense_id, variantId: row.variant_id }));
    },
  };
}

export type VocabularyRepo = ReturnType<typeof createVocabularyRepo>;
```

- [ ] **Step 4: Wire it into `Repos`**

In `apps/server/src/services/transaction.ts`, add `import type { VocabularyRepo } from '../repo/vocabulary';` and add `vocabulary: VocabularyRepo;` to `Repos`.

In `apps/server/src/composition.ts`, add `import { createVocabularyRepo } from './repo/vocabulary';` and add `vocabulary: createVocabularyRepo(tx),` to the `createTransaction` bind object.

In `apps/server/tests/support/fakes.ts`, add `vocabulary: repos.vocabulary ?? unreachableRepo('vocabulary repo'),` to `createFakeTransaction`'s `bound` object.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/repo/vocabulary.test.ts`, then `npm run typecheck`
Expected: PASS. If `findSaveable` fails with `could not determine data type of parameter`, keep the `::text` casts in the `VALUES` list; they are there for that reason.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/repo/vocabulary.ts apps/server/src/services/transaction.ts apps/server/src/composition.ts apps/server/tests/support/fakes.ts apps/server/tests/integration/repo/vocabulary.test.ts
git commit -m "feat(server): vocabulary repository with exported query builders"
```

---

### Task 5: Service, errors and routes

**Files:**
- Modify: `apps/server/src/errors.ts`
- Create: `apps/server/src/services/vocabulary.ts`, `apps/server/src/routes/vocabulary.ts`
- Modify: `apps/server/src/composition.ts`, `apps/server/src/app.ts`, `apps/server/tests/support/fakes.ts`, `apps/server/src/openapi.test.ts`, `docs/adr/adr-0002-di-with-closures.md`
- Test: `apps/server/tests/integration/routes/vocabulary.test.ts`

**Interfaces:**
- Consumes: `VocabularyRepo` (Task 4); `decodeCursor`, `encodeCursor`, `assemblePage`, `buildWordDetail`, `firstPerSense` (Task 3); the schemas (Task 2).
- Produces:
  ```ts
  // errors.ts
  export class PairNotEnrolled extends Error { constructor(enrollmentId: string, from: string, to: string) }
  export class InvalidVocabularyEntry extends Error { constructor(senseId: string) }
  export class LexemeNotFound extends Error { constructor(lexemeId: string) }
  export class InvalidCursor extends Error { constructor() }
  // services/vocabulary.ts
  export function createVocabularyService(deps: { transaction: Transaction; logger: Logger }): {
    save(enrollmentId: string, entries: VocabularyEntryInput[]): Promise<SaveVocabularyResponse>;
    unsave(enrollmentId: string, senseId: string): Promise<void>;
    listWords(enrollmentId: string, query: VocabularyPageQuery): Promise<VocabularyPage>;
    wordDetail(enrollmentId: string, lexemeId: string): Promise<VocabularyWordDetail>;
  };
  export type VocabularyService = ReturnType<typeof createVocabularyService>;
  // routes/vocabulary.ts
  export function createVocabularyRouter(vocabulary: VocabularyService): OpenAPIHono;
  // AppDeps gains `vocabulary: VocabularyService`
  ```
- Paths, mounted at `/api`:
  - `POST /enrollments/{id}/vocabulary`
  - `GET /enrollments/{id}/vocabulary`
  - `DELETE /enrollments/{id}/vocabulary/senses/{sense_id}`
  - `GET /enrollments/{id}/vocabulary/words/{lexeme_id}`

- [ ] **Step 1: Write the failing route tests**

Create `apps/server/tests/integration/routes/vocabulary.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createVocabularyRouter } from '../../../src/routes/vocabulary';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedEnrollment, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
const RU = 'e_ru';

// A Russian word with two senses rendered in Hebrew by one form.
async function russianWord(lemma: string, form = lemma) {
  return insertLexeme(t.db, {
    lemma,
    languageCode: 'ru',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'first' }, { senseCode: 'second' }],
    variants: [
      {
        form,
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'first', rank: 0, translation: `${lemma}-1`, exampleSource: null, exampleTarget: null },
          { senseCode: 'second', rank: 1, translation: `${lemma}-2`, exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
}

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1'); // also holds e_u_1, English
  await seedEnrollment(t.db, { id: RU, userId: 'u_1', targetLanguage: 'ru' });
});
afterEach(async () => {
  await t.close();
});

function app() {
  const deps = createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
  const hono = new Hono();
  hono.route('/api', createVocabularyRouter(deps.vocabulary));
  return hono;
}

const save = (enrollmentId: string, entries: unknown) =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
const unsave = (enrollmentId: string, senseId: string) =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary/senses/${senseId}`, { method: 'DELETE' });
const list = (enrollmentId: string, query = '') =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary${query}`);
const detail = (enrollmentId: string, lexemeId: string) =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary/words/${lexemeId}`);

type Page = { items: { lexeme_id: string; saved_count: number; sense_count: number }[]; next_cursor: string | null };

describe('POST /api/enrollments/{id}/vocabulary', () => {
  it('saves a sense, and the list shows its word', async () => {
    const okno = await russianWord('окно');
    const res = await save(RU, [{ sense_id: okno.senseIds[0], variant_id: okno.variantIds[0] }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved_sense_ids: [okno.senseIds[0]] });

    const page = (await (await list(RU)).json()) as Page;
    expect(page.items).toEqual([
      {
        lexeme_id: okno.lexemeId,
        lemma: 'окно',
        part_of_speech: 'noun',
        headline: { sense_id: okno.senseIds[0], translation: 'окно-1', form: 'окно' },
        saved_count: 1,
        sense_count: 2,
      },
    ]);
    expect(page.next_cursor).toBeNull();
  });

  it('writes nothing when one item of the batch is refused', async () => {
    const okno = await russianWord('окно');
    const english = await insertLexeme(t.db, {
      lemma: 'window',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'pane' }],
      variants: [
        {
          form: 'window',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'pane', rank: 0, translation: 'חלון', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    const res = await save(RU, [
      { sense_id: okno.senseIds[0], variant_id: okno.variantIds[0] },
      { sense_id: english.senseIds[0], variant_id: english.variantIds[0] },
    ]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid vocabulary entry' });
    expect(((await (await list(RU)).json()) as Page).items).toEqual([]);
  });

  // Review Focus 1.
  it('saves a sense sent twice in one batch once, with 200', async () => {
    const okno = await russianWord('окно');
    const entry = { sense_id: okno.senseIds[0], variant_id: okno.variantIds[0] };
    const res = await save(RU, [entry, entry]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved_sense_ids: [okno.senseIds[0]] });
    expect(((await (await list(RU)).json()) as Page).items[0].saved_count).toBe(1);
  });

  it('answers 404 for an unknown enrollment', async () => {
    const okno = await russianWord('окно');
    const res = await save('e_nobody', [{ sense_id: okno.senseIds[0], variant_id: okno.variantIds[0] }]);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'enrollment not found' });
  });

  it.each([
    ['no entries', []],
    ['twenty-one entries', Array(21).fill({ sense_id: 's', variant_id: 'v' })],
  ])('answers 400 for %s', async (_label, entries) => {
    const res = await save(RU, entries);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });
});

describe('DELETE /api/enrollments/{id}/vocabulary/senses/{sense_id}', () => {
  it('unsaves, idempotently', async () => {
    const okno = await russianWord('окно');
    await save(RU, [{ sense_id: okno.senseIds[0], variant_id: okno.variantIds[0] }]);
    expect((await unsave(RU, okno.senseIds[0])).status).toBe(204);
    expect((await unsave(RU, okno.senseIds[0])).status).toBe(204);
    expect(((await (await list(RU)).json()) as Page).items).toEqual([]);
  });

  it('answers 404 for an unknown enrollment', async () => {
    expect((await unsave('e_nobody', 's')).status).toBe(404);
  });
});

describe('GET /api/enrollments/{id}/vocabulary', () => {
  // Review Focus 2.
  it.each(['?limit=abc', '?limit=0', '?limit=101', '?limit=1.5'])('answers 400 for %s', async (query) => {
    const res = await list(RU, query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('answers 400 for a cursor this server did not issue', async () => {
    const res = await list(RU, '?cursor=not-a-cursor');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('answers 404 for an unknown enrollment', async () => {
    expect((await list('e_nobody')).status).toBe(404);
  });

  it("keeps each enrollment's list to itself", async () => {
    const okno = await russianWord('окно');
    await save(RU, [{ sense_id: okno.senseIds[0], variant_id: okno.variantIds[0] }]);
    expect(((await (await list('e_u_1')).json()) as Page).items).toEqual([]);
  });

  describe('a 120-word walk in pages of 50', () => {
    let words: Awaited<ReturnType<typeof russianWord>>[];

    beforeEach(async () => {
      words = [];
      for (let i = 0; i < 120; i += 1) {
        const word = await russianWord(`слово${i}`);
        await save(RU, [{ sense_id: word.senseIds[0], variant_id: word.variantIds[0] }]);
        words.push(word);
      }
    }, 60_000);

    async function walk(onPage?: (n: number) => Promise<void>): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let n = 0; ; n += 1) {
        const query = `?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = (await (await list(RU, query)).json()) as Page;
        seen.push(...page.items.map((item) => item.lexeme_id));
        if (onPage) await onPage(n);
        if (!page.next_cursor) return seen;
        cursor = page.next_cursor;
      }
    }

    it('returns every word exactly once, newest first', async () => {
      const seen = await walk();
      expect(seen).toHaveLength(120);
      expect(seen[0]).toBe(words[119].lexemeId);
      expect(seen[119]).toBe(words[0].lexemeId);
      expect(new Set(seen).size).toBe(120);
    });

    it('neither duplicates nor loses a word when an old one moves to the top mid-walk', async () => {
      const moved = words[10];
      const seen = await walk(async (n) => {
        if (n === 0) {
          await save(RU, [{ sense_id: moved.senseIds[1], variant_id: moved.variantIds[0] }]);
        }
      });
      // The moved word is now before the cursor: this walk does not see it again,
      // and sees every other word exactly once.
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(119);
      expect(seen).not.toContain(moved.lexemeId);
      // A refresh starts with it.
      const fresh = (await (await list(RU, '?limit=1')).json()) as Page;
      expect(fresh.items[0]).toMatchObject({ lexeme_id: moved.lexemeId, saved_count: 2 });
    });

    it("drops a word whose last sense is unsaved", async () => {
      await unsave(RU, words[50].senseIds[0]);
      const seen = await walk();
      expect(seen).toHaveLength(119);
      expect(seen).not.toContain(words[50].lexemeId);
    });
  });
});

describe('GET /api/enrollments/{id}/vocabulary/words/{lexeme_id}', () => {
  it('lists every sense, saved first, and answers 200 once nothing is saved', async () => {
    const okno = await russianWord('окно');
    await save(RU, [{ sense_id: okno.senseIds[1], variant_id: okno.variantIds[0] }]);

    const res = await detail(RU, okno.lexemeId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { senses: { sense_id: string; saved: boolean }[] };
    expect(body.senses.map((s) => [s.sense_id, s.saved])).toEqual([
      [okno.senseIds[1], true],
      [okno.senseIds[0], false],
    ]);

    await unsave(RU, okno.senseIds[1]);
    expect((await detail(RU, okno.lexemeId)).status).toBe(200);
  });

  it("answers 404 for an unknown lexeme and for one outside the enrollment's target", async () => {
    const okno = await russianWord('окно');
    expect((await detail(RU, 'nope')).status).toBe(404);
    const wrongLanguage = await detail('e_u_1', okno.lexemeId);
    expect(wrongLanguage.status).toBe(404);
    expect(await wrongLanguage.json()).toEqual({ error: 'word not found' });
  });

  it('answers 404 for an unknown enrollment', async () => {
    const okno = await russianWord('окно');
    const res = await detail('e_nobody', okno.lexemeId);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'enrollment not found' });
  });
});
```

Then add to `apps/server/src/openapi.test.ts`:

1. In `'contains all seven paths and nothing else'`, rename the test to `'contains all ten paths and nothing else'` and add these three entries to the expected array, in sorted position:
   - `'/api/enrollments/{id}/vocabulary'`
   - `'/api/enrollments/{id}/vocabulary/senses/{sense_id}'`
   - `'/api/enrollments/{id}/vocabulary/words/{lexeme_id}'`
2. Append:

```ts
describe('the vocabulary endpoints in the published document', () => {
  const BASE = '/api/enrollments/{id}/vocabulary';

  it.each([
    [BASE, 'post', ['200', '400', '404']],
    [BASE, 'get', ['200', '400', '404']],
    [`${BASE}/senses/{sense_id}`, 'delete', ['204', '404']],
    [`${BASE}/words/{lexeme_id}`, 'get', ['200', '404']],
  ])('%s %s declares exactly its statuses', async (path, method, statuses) => {
    const doc = await openApiDocument();
    expect(Object.keys(doc.paths[path][method].responses).sort()).toEqual(statuses);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/routes/vocabulary.test.ts`
Expected: FAIL with `Cannot find module '../../../src/routes/vocabulary'`.

- [ ] **Step 3: Add the errors**

Append to `apps/server/src/errors.ts`:

```ts
/** Phase 18. A translation named an enrollment whose pair is not the lookup's. */
export class PairNotEnrolled extends Error {
  constructor(
    readonly enrollmentId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`enrollment ${enrollmentId} does not cover ${from} → ${to}`);
    this.name = 'PairNotEnrolled';
  }
}

/** Phase 18. A save item failed a check: its sense is not in the enrollment's
 *  target language, its variant is not a form of that lexeme, or that form has
 *  no rendering of the sense in the enrollment's source language. */
export class InvalidVocabularyEntry extends Error {
  constructor(readonly senseId: string) {
    super(`sense ${senseId} cannot be saved here`);
    this.name = 'InvalidVocabularyEntry';
  }
}

/** Phase 18. No lexeme with this id in the enrollment's target language. */
export class LexemeNotFound extends Error {
  constructor(readonly lexemeId: string) {
    super(`no lexeme ${lexemeId}`);
    this.name = 'LexemeNotFound';
  }
}

/** Phase 18. A list cursor this server did not issue. A schema cannot see inside
 *  the base64, so this is decided in domain/vocabulary.ts's decodeCursor. */
export class InvalidCursor extends Error {
  constructor() {
    super('malformed vocabulary cursor');
    this.name = 'InvalidCursor';
  }
}
```

- [ ] **Step 4: Implement the service**

Create `apps/server/src/services/vocabulary.ts`:

```ts
import type {
  Enrollment,
  SaveVocabularyResponse,
  VocabularyEntryInput,
  VocabularyPage,
  VocabularyPageQuery,
  VocabularyWordDetail,
} from '@lang-tutor/core/api';

import {
  assemblePage,
  buildWordDetail,
  decodeCursor,
  encodeCursor,
  firstPerSense,
} from '../domain/vocabulary';
import { EnrollmentNotFound, InvalidCursor, InvalidVocabularyEntry, LexemeNotFound } from '../errors';
import type { Logger } from '../logger';
import type { Repos, Transaction } from './transaction';

const DEFAULT_PAGE_SIZE = 50;

async function enrollmentOrThrow(repos: Repos, enrollmentId: string): Promise<Enrollment> {
  const enrolled = await repos.enrollment.findById(enrollmentId);
  if (!enrolled) throw new EnrollmentNotFound(enrollmentId);
  return enrolled;
}

/**
 * An enrollment's word list. One transaction per use case (ADR 0001 R8); the
 * enrollment check shares it, because an entry for an enrollment that does not
 * exist is wrong, and so is a page read against one.
 */
export function createVocabularyService({
  transaction,
  logger,
}: {
  transaction: Transaction;
  logger: Logger;
}) {
  return {
    /**
     * All-or-nothing: every item is checked before anything is written, and the
     * throw rolls the transaction back. A sense already saved is not an error —
     * the insert's DO NOTHING keeps its first form — so a repeat answers 200
     * with the same ids.
     */
    save: async (
      enrollmentId: string,
      entries: VocabularyEntryInput[],
    ): Promise<SaveVocabularyResponse> => {
      const asked = firstPerSense(entries);
      await transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
        const saveable = await repos.vocabulary.findSaveable({
          entries: asked.map((entry) => ({ senseId: entry.sense_id, variantId: entry.variant_id })),
          targetLanguage: enrolled.target_language,
          sourceLanguage: enrolled.source_language,
        });
        const passed = new Set(saveable.map((row) => `${row.senseId} ${row.variantId}`));
        const refused = asked.find((entry) => !passed.has(`${entry.sense_id} ${entry.variant_id}`));
        if (refused) throw new InvalidVocabularyEntry(refused.sense_id);
        await repos.vocabulary.insertEntries({ enrollmentId, entries: saveable });
      });
      logger.info({ event: 'vocabulary_saved', enrollment_id: enrollmentId, entry_count: asked.length });
      return { saved_sense_ids: asked.map((entry) => entry.sense_id) };
    },

    unsave: async (enrollmentId: string, senseId: string): Promise<void> => {
      await transaction(async (repos) => {
        await enrollmentOrThrow(repos, enrollmentId);
        await repos.vocabulary.deleteEntry({ enrollmentId, senseId });
      });
      logger.info({ event: 'vocabulary_unsaved', enrollment_id: enrollmentId });
    },

    /**
     * Keyset pagination. One extra row is read to learn whether a next page
     * exists; the cursor is the last row KEPT — from the page rows, never from
     * the assembled items, which may be one short (assemblePage's comment).
     */
    listWords: async (enrollmentId: string, query: VocabularyPageQuery): Promise<VocabularyPage> => {
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
      if (query.cursor !== undefined && !after) throw new InvalidCursor();

      return transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
        const read = await repos.vocabulary.findWordsPage({ enrollmentId, limit: limit + 1, after });
        const rows = read.slice(0, limit);
        const summaries = await repos.vocabulary.findWordSummaries({
          enrollmentId,
          lexemeIds: rows.map((row) => row.lexemeId),
          sourceLanguage: enrolled.source_language,
        });
        const last = rows[rows.length - 1];
        return {
          items: assemblePage(rows, summaries),
          next_cursor:
            read.length > limit ? encodeCursor({ savedAt: last.lastSavedAt, lexemeId: last.lexemeId }) : null,
        };
      });
    },

    wordDetail: (enrollmentId: string, lexemeId: string): Promise<VocabularyWordDetail> =>
      transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
        const lexeme = await repos.vocabulary.findLexeme(lexemeId);
        if (!lexeme || lexeme.languageCode !== enrolled.target_language) {
          throw new LexemeNotFound(lexemeId);
        }
        const renderings = await repos.vocabulary.findLexemeRenderings({
          lexemeId,
          userLanguageCode: enrolled.source_language,
        });
        const saved = await repos.vocabulary.findSavedInLexeme({ enrollmentId, lexemeId });
        return buildWordDetail(lexeme, renderings, saved);
      }),
  };
}

export type VocabularyService = ReturnType<typeof createVocabularyService>;
```

- [ ] **Step 5: Implement the routes**

Create `apps/server/src/routes/vocabulary.ts`:

```ts
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  ErrorSchema,
  SaveVocabularyRequestSchema,
  SaveVocabularyResponseSchema,
  VocabularyPageQuerySchema,
  VocabularyPageSchema,
  VocabularyWordDetailSchema,
} from '@lang-tutor/core/api/schemas';
import { z } from 'zod';

import { EnrollmentNotFound, InvalidCursor, InvalidVocabularyEntry, LexemeNotFound } from '../errors';
import type { VocabularyService } from '../services/vocabulary';

const BASE = '/enrollments/{id}/vocabulary';
const enrollmentParams = z.object({ id: z.string() });
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const NOT_ENROLLED = json(ErrorSchema, 'No enrollment has this id.');

const saveRoute = createRoute({
  method: 'post',
  path: BASE,
  tags: ['vocabulary'],
  summary: "Save senses to an enrollment's word list",
  description:
    'One entry per sense. Each item names the sense and the form (variant) it was saved from; ' +
    'saving a sense that is already saved keeps its first form and is not an error. The batch is ' +
    'all-or-nothing.',
  request: {
    params: enrollmentParams,
    body: { required: true, content: { 'application/json': { schema: SaveVocabularyRequestSchema } } },
  },
  responses: {
    200: json(SaveVocabularyResponseSchema, 'Every sense of the request is now saved.'),
    400: json(
      ErrorSchema,
      'The body did not validate, or an item cannot be saved here: its sense is not in the ' +
        "enrollment's target language, or its form does not render it in the source language.",
    ),
    404: NOT_ENROLLED,
  },
});

const listRoute = createRoute({
  method: 'get',
  path: BASE,
  tags: ['vocabulary'],
  summary: "List an enrollment's words",
  description:
    'One item per word (lexeme), newest save first, keyset-paginated: pass `next_cursor` back as ' +
    '`cursor`. A word saved into again moves to the top; it is never served twice in one walk.',
  request: { params: enrollmentParams, query: VocabularyPageQuerySchema },
  responses: {
    200: json(VocabularyPageSchema, 'One page; `next_cursor` is null on the last.'),
    400: json(ErrorSchema, '`limit` is outside 1–100, or `cursor` was not issued by this server.'),
    404: NOT_ENROLLED,
  },
});

const unsaveRoute = createRoute({
  method: 'delete',
  path: `${BASE}/senses/{sense_id}`,
  tags: ['vocabulary'],
  summary: 'Unsave a sense',
  description: 'Idempotent: unsaving a sense that is not saved also answers 204.',
  request: { params: z.object({ id: z.string(), sense_id: z.string() }) },
  responses: {
    204: { description: 'The sense is not saved.' },
    404: NOT_ENROLLED,
  },
});

const detailRoute = createRoute({
  method: 'get',
  path: `${BASE}/words/{lexeme_id}`,
  tags: ['vocabulary'],
  summary: 'One word, with every sense it can show',
  description:
    "Every sense of the lexeme that has a rendering in the enrollment's source language, saved " +
    'senses first. A saved sense is shown in the form it was saved from.',
  request: { params: z.object({ id: z.string(), lexeme_id: z.string() }) },
  responses: {
    200: json(VocabularyWordDetailSchema, 'The word, possibly with nothing saved.'),
    404: json(
      ErrorSchema,
      "No enrollment has this id, or no word with this id is in the enrollment's target language.",
    ),
  },
});

// Transport only (ADR 0001 R1). Mounted at /api.
export function createVocabularyRouter(vocabulary: VocabularyService) {
  const router = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: 'invalid request' }, 400);
    },
  });

  router.openapi(saveRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { entries } = c.req.valid('json');
    try {
      return c.json(await vocabulary.save(id, entries), 200);
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof InvalidVocabularyEntry) {
        return c.json({ error: 'invalid vocabulary entry' }, 400);
      }
      throw error;
    }
  });

  router.openapi(listRoute, async (c) => {
    const { id } = c.req.valid('param');
    try {
      return c.json(await vocabulary.listWords(id, c.req.valid('query')), 200);
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof InvalidCursor) return c.json({ error: 'invalid request' }, 400);
      throw error;
    }
  });

  router.openapi(unsaveRoute, async (c) => {
    const { id, sense_id } = c.req.valid('param');
    try {
      await vocabulary.unsave(id, sense_id);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      throw error;
    }
  });

  router.openapi(detailRoute, async (c) => {
    const { id, lexeme_id } = c.req.valid('param');
    try {
      return c.json(await vocabulary.wordDetail(id, lexeme_id), 200);
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof LexemeNotFound) return c.json({ error: 'word not found' }, 404);
      throw error;
    }
  });

  return router;
}
```

- [ ] **Step 6: Wire it up**

`apps/server/src/composition.ts`:
- add `import { createVocabularyService, type VocabularyService } from './services/vocabulary';`;
- add `vocabulary: VocabularyService;` to `AppDeps`;
- add `vocabulary: createVocabularyService({ transaction, logger: io.logger }),` to the returned object, after `translations`.

`apps/server/src/app.ts`:
- add `import { createVocabularyRouter } from './routes/vocabulary';`;
- add `app.route('/api', createVocabularyRouter(deps.vocabulary));` after the enrollments router line.

`apps/server/tests/support/fakes.ts`, in `createFakeAppDeps`:
- import `type VocabularyService` from `'../../src/services/vocabulary'`;
- add `const vocabulary: VocabularyService = { save: unreachable, unsave: unreachable, listWords: unreachable, wordDetail: unreachable };`;
- add `vocabulary,` to the returned object.

`docs/adr/adr-0002-di-with-closures.md` R6: in the factory list, add `createVocabularyRepo` after `createDictRepo`, and `createVocabularyService` after `createTranslationService`.

- [ ] **Step 7: Run the tests to verify they pass**

Run:
```bash
bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/routes/vocabulary.test.ts
npm test -w apps/server -- src/openapi.test.ts
npm run typecheck && npm run lint:arch
```
Expected: PASS, and all ADR checks print `ok`. If `tsc` rejects `c.body(null, 204)` against the typed route, return `new Response(null, { status: 204 })` instead: no route here has used a 204 before. If the `?limit=abc` case answers 200, `VocabularyPageQuerySchema` is not attached as `request.query`. Fix the route; do not loosen the test.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/errors.ts apps/server/src/services/vocabulary.ts apps/server/src/routes/vocabulary.ts apps/server/src/composition.ts apps/server/src/app.ts apps/server/src/openapi.test.ts apps/server/tests/support/fakes.ts apps/server/tests/integration/routes/vocabulary.test.ts docs/adr/adr-0002-di-with-closures.md
git commit -m "feat(server): save, unsave, list and drill-down vocabulary routes"
```

---

### Task 6: Translation — sense ids, `enrollment_id`, `saved`

**Files:**
- Modify: `apps/server/src/domain/dictionary.ts` (`SenseRow`, `rowsToSenses`), `apps/server/src/repo/dictionary.ts` (`findSensesByForm` select)
- Modify: `apps/server/src/services/translations.ts`, `apps/server/src/routes/translations.ts`, `apps/server/src/openapi.test.ts`
- Modify (fixtures): `apps/server/src/services/translations.test.ts`, `apps/server/src/domain/dictionary.test.ts`, `apps/server/tests/support/fakes.ts`
- Test: `apps/server/tests/integration/routes/translations.vocabulary.test.ts`

**Interfaces:**
- Consumes: `markSaved`, `coversPair` (Task 3); `repos.vocabulary.findSavedSenseIds`, `repos.enrollment.findById`; `PairNotEnrolled`, `EnrollmentNotFound`.
- Produces: `SenseRow` gains `senseId: string; variantId: string`. `rowsToSenses` emits `sense_id` and `variant_id`. `POST /api/translations` can now answer 404 and the new 400.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/tests/integration/routes/translations.vocabulary.test.ts`. Every lookup here is a cache hit on rows the test inserted, so no MockServer expectation is registered. A request that reached the model would fail on the unroutable default base URL and answer 502, which is how the test proves "no model call".

```ts
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { Hono } from 'hono';

import { createTranslationsRouter } from '../../../src/routes/translations';
import { insertLexeme } from '../../support/dictRows';
import { createFakeLogger } from '../../support/fakes';
import { createTestServerDeps } from '../../support/serverDeps';
import { seedEnrollment, seedLegacyLearner, seedUser } from '../../support/seedUser';
import { createTestDb, type TestDb } from '../../support/testDb';
import { testRng } from '../../support/testRng';

let t: TestDb;
const RU = 'e_ru';

beforeEach(async () => {
  t = await createTestDb();
  await seedUser(t.db, 'u_1');
  await seedEnrollment(t.db, { id: RU, userId: 'u_1', targetLanguage: 'ru' });
});
afterEach(async () => {
  await t.close();
});

function deps() {
  return createTestServerDeps({ db: t.db, logger: createFakeLogger(), rng: testRng(7) });
}

function translate(body: unknown) {
  const app = new Hono();
  const d = deps();
  app.route('/api', createTranslationsRouter(d.translations, d.logger));
  return app.request('/api/translations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

type Sense = { translation: string; sense_id?: string; variant_id?: string; saved?: boolean };

async function okno() {
  return insertLexeme(t.db, {
    lemma: 'окно',
    languageCode: 'ru',
    partOfSpeech: 'noun',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'window' }, { senseCode: 'gap' }],
    variants: [
      {
        form: 'окно',
        kind: 'word',
        entryRank: 0,
        translations: [
          { senseCode: 'window', rank: 0, translation: 'חלון', exampleSource: null, exampleTarget: null },
          { senseCode: 'gap', rank: 1, translation: 'חלון זמן', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
}

describe('POST /api/translations with an enrollment', () => {
  it('carries ids on every stored sense, and saved flags for a target-language lookup', async () => {
    const ids = await okno();
    await deps().vocabulary.save(RU, [{ sense_id: ids.senseIds[1], variant_id: ids.variantIds[0] }]);

    const res = await translate({ text: 'окно', from: 'ru', to: 'he', enrollment_id: RU });
    expect(res.status).toBe(200);
    const { senses } = (await res.json()) as { senses: Sense[] };
    expect(senses).toEqual([
      { translation: 'חלון', part_of_speech: 'noun', sense_id: ids.senseIds[0], variant_id: ids.variantIds[0], saved: false },
      { translation: 'חלון זמן', part_of_speech: 'noun', sense_id: ids.senseIds[1], variant_id: ids.variantIds[0], saved: true },
    ]);
  });

  it('carries ids but no saved flag without an enrollment', async () => {
    await okno();
    const { senses } = (await (await translate({ text: 'окно', from: 'ru', to: 'he' })).json()) as {
      senses: Sense[];
    };
    expect(senses[0].sense_id).toEqual(expect.any(String));
    expect(senses[0]).not.toHaveProperty('saved');
  });

  it('carries no saved flag on a reverse lookup', async () => {
    await insertLexeme(t.db, {
      lemma: 'חלון',
      languageCode: 'he',
      partOfSpeech: 'noun',
      userLanguageCode: 'ru',
      senses: [{ senseCode: 'window' }],
      variants: [
        {
          form: 'חלון',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'window', rank: 0, translation: 'окно', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    const { senses } = (await (
      await translate({ text: 'חלון', from: 'he', to: 'ru', enrollment_id: RU })
    ).json()) as { senses: Sense[] };
    expect(senses).toHaveLength(1);
    expect(senses[0]).not.toHaveProperty('saved');
  });

  it('answers 404 for an unknown enrollment, before any lookup', async () => {
    const res = await translate({ text: 'окно', from: 'ru', to: 'he', enrollment_id: 'e_nobody' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'enrollment not found' });
  });

  it("answers 400 for a pair that is not the enrollment's, before any model call", async () => {
    const res = await translate({ text: 'window', from: 'en', to: 'he', enrollment_id: RU });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'pair not enrolled' });
  });

  // Review Focus 4: the rule is "from is the enrollment's target", not "to is he".
  it('marks saved for a legacy English-explained enrollment on a he → en lookup', async () => {
    const { enrollmentId } = await seedLegacyLearner(t.db);
    const sefer = await insertLexeme(t.db, {
      lemma: 'ספר',
      languageCode: 'he',
      partOfSpeech: 'noun',
      userLanguageCode: 'en',
      senses: [{ senseCode: 'book' }],
      variants: [
        {
          form: 'ספר',
          kind: 'word',
          entryRank: 0,
          translations: [
            { senseCode: 'book', rank: 0, translation: 'book', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
    await deps().vocabulary.save(enrollmentId, [
      { sense_id: sefer.senseIds[0], variant_id: sefer.variantIds[0] },
    ]);
    const { senses } = (await (
      await translate({ text: 'ספר', from: 'he', to: 'en', enrollment_id: enrollmentId })
    ).json()) as { senses: Sense[] };
    expect(senses[0].saved).toBe(true);
  });
});
```

In `apps/server/src/openapi.test.ts`, change the translation status assertion in `'publishes the translation endpoint with all three statuses'`. Rename it to `'publishes the translation endpoint with all five statuses'`, and expect `['200', '400', '404', '502']` (look at how the existing test lists them and keep its style). Add:

```ts
  it('says the endpoint learns the enrollment, and uses it only for `saved`', async () => {
    const doc = await openApiDocument();
    expect(doc.paths['/api/translations'].post.description).toMatch(/enrollment_id/);
    expect(doc.paths['/api/translations'].post.description).toMatch(/only/i);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/routes/translations.vocabulary.test.ts`
Expected: FAIL. The senses have no `sense_id`, and the 404/400 cases answer 200.

- [ ] **Step 3: Put the ids on the rows and on the wire**

In `apps/server/src/domain/dictionary.ts`, add two fields to `SenseRow`, after `lexemeId`:

```ts
  /** Phase 18: the sense and the form this row renders, so the wire can name
   *  what a client saves. */
  senseId: string;
  variantId: string;
```

and in `rowsToSenses`, build the sense with them:

```ts
    const sense: TranslationSense = {
      translation: row.translation,
      sense_id: row.senseId,
      variant_id: row.variantId,
    };
```

Also update the doc comment above `rowsToSenses`: the line "Nothing here can emit `sense_code`, because nothing here reads it." stays true, so add after it: "From phase 18 it emits the sense and variant ids: identity, not model output."

In `apps/server/src/repo/dictionary.ts`'s `findSensesByForm`, add to the `select({ … })`:

```ts
        senseId: dictSenses.id,
        variantId: dictVariants.id,
```

Then fix the fixtures. Each fixture builder gains defaults for the two new required fields:

- `apps/server/src/services/translations.test.ts`: in `const row = (…)`, add `senseId: 's-1', variantId: 'v-1',` after `lexemeId: 't-1',`.
- `apps/server/src/domain/dictionary.test.ts`: every `SenseRow` literal or builder gains `senseId` and `variantId`. Use `'s-1'`/`'v-1'`, or distinct values where a test builds several rows.
- `apps/server/tests/support/fakes.ts`: any `SenseRow` literal gains the same fields.

Run `npm test -w apps/server` and `npm run typecheck`. Every remaining failure will be a `toEqual` on wire senses, which now carry `sense_id` and `variant_id`. Add `sense_id: 's-1', variant_id: 'v-1'` (the values the builder set) to those expected objects. Do not switch them to `toMatchObject`: the point of those assertions is that nothing extra reaches the wire.

- [ ] **Step 4: Add the enrollment check and the `saved` decoration**

In `apps/server/src/services/translations.ts`:

1. Extend imports:
   ```ts
   import { coversPair, markSaved } from '../domain/vocabulary';
   import { EnrollmentNotFound, PairNotEnrolled, TranslationUnreadable } from '../errors';
   ```
   This replaces the existing `TranslationUnreadable`-only import.
2. Inside `createTranslationService`, cut the whole existing `translate: async (input) => { … }` body. Paste it, unchanged, as a `const lookup = async (input: TranslationRequest): Promise<TranslationResponse> => { … };` declared **before** `return {`. It still uses `llm`, `transaction` and `logger` from the factory's destructured parameters, and still calls a bare `transaction(...)`.
3. Return:

```ts
  return {
    /**
     * Phase 18. The lookup above is unchanged; this wraps it.
     *
     * Before it, the enrollment is read and checked, so an unknown enrollment
     * (404) or a pair it does not cover (400) costs no model call. After it, ONE
     * read marks which senses this enrollment has saved, on a target-language
     * lookup only: the senses of a reverse lookup belong to the source-language
     * lexeme, which this enrollment does not learn (spec §1). Both are reads, each
     * its own transaction — R8 permits them; neither writes.
     *
     * `enrollment_id` is used for `saved` and nothing else. Any other use of it on
     * this path is a new decision, not an extension of this one.
     */
    translate: async (input: TranslationRequest): Promise<TranslationResponse> => {
      const enrollmentId = input.enrollment_id;
      const enrollment =
        enrollmentId === undefined
          ? null
          : await transaction((repos) => repos.enrollment.findById(enrollmentId));
      if (enrollmentId !== undefined) {
        if (!enrollment) throw new EnrollmentNotFound(enrollmentId);
        if (!coversPair(enrollment, input.from, input.to)) {
          throw new PairNotEnrolled(enrollmentId, input.from, input.to);
        }
      }

      const response = await lookup(input);
      if (!enrollment || input.from !== enrollment.target_language) return response;

      const senseIds = response.senses.flatMap((sense) => (sense.sense_id ? [sense.sense_id] : []));
      if (senseIds.length === 0) return response;
      const saved = await transaction((repos) =>
        repos.vocabulary.findSavedSenseIds({ enrollmentId: enrollment.id, senseIds }),
      );
      return { ...response, senses: markSaved(response.senses, new Set(saved)) };
    },
  };
```

4. In the long comment above `createTranslationService`, change "This file now has nine `transaction(...)` call sites" to "eleven".

In `apps/server/src/routes/translations.ts`:

- import `EnrollmentNotFound` and `PairNotEnrolled` from `'../errors'`;
- extend the `400` description to: `'The request body did not validate, or `enrollment_id` names an enrollment whose pair is not `from`/`to`.'`;
- add a response:
  ```ts
      404: {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'No enrollment has the given `enrollment_id`.',
      },
  ```
- add these sentences to the route `description`, before the `NOTE:`:
  > `'Optionally names the learner\'s `enrollment_id`; the response then marks, on a lookup from the enrollment\'s target language, which senses that enrollment has `saved`. The enrollment is used only for that. '`
- in the handler's `catch`, before the 502 branch:
  ```ts
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof PairNotEnrolled) return c.json({ error: 'pair not enrolled' }, 400);
  ```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/routes/translations.vocabulary.test.ts tests/integration/routes/translations.test.ts tests/integration/services
npm test -w apps/server
npm run typecheck && npm run lint:arch
```
Expected: PASS. The existing translation suites prove that the moved `lookup` body behaves exactly as before. If one of them fails on a senses `toEqual`, it needs the ids. Any other failure means the body was changed in the move; diff it against `master`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src apps/server/tests
git commit -m "feat(server): translations carry sense ids and, for an enrollment, saved flags"
```

---

### Task 7: The plan test at volume

**Files:**
- Test: `apps/server/tests/integration/repo/vocabulary.plan.test.ts`

**Interfaces:**
- Consumes: `vocabularyQueries` (Task 4).

- [ ] **Step 1: Write the test**

Create `apps/server/tests/integration/repo/vocabulary.plan.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { sql, type SQL } from 'drizzle-orm';

import { vocabularyQueries } from '../../../src/repo/vocabulary';
import { createTestDb, type TestDb } from '../../support/testDb';

// Spec §6. On a small table the planner rightly prefers a sequential scan, so
// the plan shape only means something at volume: ~200k entries over ~1k
// enrollments, plus one heavy enrollment with 20k. The assertion is the ABSENCE
// of a Seq Scan on the two big tables — the part of a plan that stays stable
// across Postgres versions — and an Execution Time budget for the list page.
//
// If one of these fails, read the plan in the failure before touching the
// assertion. The fix is an index or a query shape, never a looser test.

const WATCHED = ['vocabulary_entries', 'dict_var_translations'];
const HEAVY = 'pe1';
const BUDGET_MS = 50;

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; Plans?: PlanNode[] };
type Explained = { Plan: PlanNode; 'Execution Time': number };

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  // One statement per execute and no bind parameters: node-postgres refuses a
  // multi-statement string once it carries parameters.
  const LOAD = [
    `insert into users (id, username, display_name, age, native_language)
       select 'pu' || g, 'pu' || g, 'p', 30, 'he' from generate_series(1, 1000) g`,
    `insert into enrollments (id, user_id, source_language, target_language)
       select 'pe' || g, 'pu' || g, 'he', 'ru' from generate_series(1, 1000) g`,
    `insert into dict_lexemes (id, language_code, lemma, part_of_speech)
       select 'pl' || g, 'ru', 'слово' || g, 'noun' from generate_series(1, 20000) g`,
    `insert into dict_senses (id, lexeme_id, sense_code)
       select 'ps' || g, 'pl' || g, 'only' from generate_series(1, 20000) g`,
    `insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank)
       select 'pv' || g, 'pl' || g, 'ru', 'слово' || g, 'word', 0 from generate_series(1, 20000) g`,
    `insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank)
       select 'pv' || g, 'ps' || g, 'he', 'מילה' || g, 0 from generate_series(1, 20000) g`,
    `insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id, created_at)
       select 'pe' || e, 'ps' || s, 'pl' || s, 'pv' || s, now() - (s || ' seconds')::interval
       from generate_series(2, 1000) e, generate_series(1, 200) s`,
    `insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id, created_at)
       select '${HEAVY}', 'ps' || s, 'pl' || s, 'pv' || s, now() - (s || ' seconds')::interval
       from generate_series(1, 20000) s`,
  ];
  for (const statement of LOAD) await t.db.execute(sql.raw(statement));
  // Outside any transaction (VACUUM refuses one), so the visibility map is set
  // and an index-only scan is available, and the planner has real statistics.
  for (const table of ['vocabulary_entries', 'dict_var_translations', 'dict_senses', 'dict_lexemes', 'dict_variants']) {
    await t.db.execute(sql.raw(`vacuum analyze ${table}`));
  }
}, 120_000);

afterAll(async () => {
  await t.close();
});

async function explain(query: SQL): Promise<Explained> {
  const result = await t.db.execute<{ 'QUERY PLAN': Explained[] }>(
    sql`explain (analyze, format json) ${query}`,
  );
  return result.rows[0]['QUERY PLAN'][0];
}

const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
const seqScans = (plan: Explained) =>
  nodes(plan.Plan)
    .filter((n) => n['Node Type'] === 'Seq Scan' && WATCHED.includes(n['Relation Name'] ?? ''))
    .map((n) => n['Relation Name']);

const FIRST_50 = Array.from({ length: 50 }, (_, i) => `pl${i + 1}`);

describe('every vocabulary read at volume', () => {
  it.each([
    ['saveable', () => vocabularyQueries.saveable({
      entries: [{ senseId: 'ps5', variantId: 'pv5' }, { senseId: 'ps6', variantId: 'pv6' }],
      targetLanguage: 'ru',
      sourceLanguage: 'he',
    })],
    ['savedSenseIds', () => vocabularyQueries.savedSenseIds({
      enrollmentId: HEAVY,
      senseIds: ['ps1', 'ps2', 'ps3', 'ps4', 'ps5'],
    })],
    ['wordsPage, first page', () => vocabularyQueries.wordsPage({ enrollmentId: HEAVY, limit: 51, after: null })],
    ['wordsPage, after a cursor', () => vocabularyQueries.wordsPage({
      enrollmentId: HEAVY,
      limit: 51,
      after: { savedAt: '2000-01-01 00:00:00+00', lexemeId: 'pl1' },
    })],
    ['wordSummaries', () => vocabularyQueries.wordSummaries({
      enrollmentId: HEAVY,
      lexemeIds: FIRST_50,
      sourceLanguage: 'he',
    })],
    ['lexemeRenderings', () => vocabularyQueries.lexemeRenderings({ lexemeId: 'pl7', userLanguageCode: 'he' })],
    ['savedInLexeme', () => vocabularyQueries.savedInLexeme({ enrollmentId: HEAVY, lexemeId: 'pl7' })],
  ])('%s scans no watched table sequentially', async (_name, build) => {
    const plan = await explain(build());
    expect(seqScans(plan)).toEqual([]);
  });

  it(`serves the heavy enrollment's first list page in under ${BUDGET_MS} ms`, async () => {
    // Warm once, so the budget measures the plan rather than a cold cache.
    await explain(vocabularyQueries.wordsPage({ enrollmentId: HEAVY, limit: 51, after: null }));
    const plan = await explain(vocabularyQueries.wordsPage({ enrollmentId: HEAVY, limit: 51, after: null }));
    expect(plan['Execution Time']).toBeLessThan(BUDGET_MS);
  });
});
```

- [ ] **Step 2: Prove the test can fire before trusting it passes**

CLAUDE.md requires this: a check that cannot fire prints nothing, just like a check that passes. Temporarily drop the phase 18 dictionary index in `beforeAll`, after the load and before the `vacuum analyze` loop:

```ts
  await t.db.execute(sql`drop index dict_var_translations_sense_language_idx`);
```

Do not plant this by dropping `vocabulary_entries_enrollment_lexeme_idx` instead. The primary key also leads with `enrollment_id`, so the planner can fall back to it without a Seq Scan, and the check might stay silent.

Run: `bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/repo/vocabulary.plan.test.ts`
Expected: FAIL on `lexemeRenderings` (and on `wordSummaries`, whose `sense_count` subquery asks the same question) with `["dict_var_translations"]`. That is the planted violation being reported. **Remove the planted line.**

- [ ] **Step 3: Run the test to verify it passes**

Run the same command.
Expected: PASS. If the timing fails on a slow machine while every plan assertion passes, look at the plan's `Node Type`s. An index-only scan feeding the aggregate is right. Report the measured time rather than raising `BUDGET_MS`; the spec fixes the budget.

- [ ] **Step 4: Commit**

```bash
git add apps/server/tests/integration/repo/vocabulary.plan.test.ts
git commit -m "test(server): vocabulary query plans at volume, and the list-page budget"
```

---

### Task 8: Mobile — client calls and pure helpers

**Files:**
- Modify: `apps/mobile/src/api/client.ts`, `apps/mobile/src/api/client.test.ts`
- Create: `apps/mobile/src/vocabulary.ts`, `apps/mobile/src/vocabulary.test.ts`

**Interfaces:**
- Produces (client):
  ```ts
  saveVocabulary(enrollmentId: string, request: SaveVocabularyRequest): Promise<SaveVocabularyResponse>;
  unsaveVocabulary(enrollmentId: string, senseId: string): Promise<void>;
  listVocabulary(enrollmentId: string, query: { cursor?: string; limit?: number }): Promise<VocabularyPage>;
  vocabularyWord(enrollmentId: string, lexemeId: string): Promise<VocabularyWordDetail>;
  ```
- Produces (`src/vocabulary.ts`):
  ```ts
  export type SavedState = Record<string, boolean>;
  export function savedStateOf(senses: TranslationSense[]): SavedState;
  export function unsavedEntries(senses: TranslationSense[], saved: SavedState): VocabularyEntryInput[];
  export function canSaveAll(senses: TranslationSense[], saved: SavedState): boolean;
  export function appendPage(loaded: VocabularyWord[], page: VocabularyWord[]): VocabularyWord[];
  export function showsMark(word: VocabularyWord): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/vocabulary.test.ts`:

```ts
import { describe, expect, it } from '@jest/globals';
import type { TranslationSense, VocabularyWord } from '@lang-tutor/core/api';

import { appendPage, canSaveAll, savedStateOf, showsMark, unsavedEntries } from './vocabulary';

const SENSES: TranslationSense[] = [
  { translation: 'a', sense_id: 's1', variant_id: 'v1', saved: false },
  { translation: 'b', sense_id: 's2', variant_id: 'v1', saved: true },
  { translation: 'c', sense_id: 's3', variant_id: 'v1', saved: false },
  { translation: 'reverse', sense_id: 's4', variant_id: 'v2' },
  { translation: 'sentence' },
];

describe('savedStateOf', () => {
  it('maps only the senses the server said can be saved here', () => {
    expect(savedStateOf(SENSES)).toEqual({ s1: false, s2: true, s3: false });
  });
});

describe('unsavedEntries and canSaveAll', () => {
  it('lists the unsaved, saveable senses', () => {
    expect(unsavedEntries(SENSES, savedStateOf(SENSES))).toEqual([
      { sense_id: 's1', variant_id: 'v1' },
      { sense_id: 's3', variant_id: 'v1' },
    ]);
  });

  it('offers save-all from two unsaved senses, not one', () => {
    const saved = savedStateOf(SENSES);
    expect(canSaveAll(SENSES, saved)).toBe(true);
    expect(canSaveAll(SENSES, { ...saved, s1: true })).toBe(false);
  });
});

const word = (lexeme_id: string, over: Partial<VocabularyWord> = {}): VocabularyWord => ({
  lexeme_id,
  lemma: lexeme_id,
  part_of_speech: 'noun',
  headline: { sense_id: `s-${lexeme_id}`, translation: 't', form: lexeme_id },
  saved_count: 1,
  sense_count: 1,
  ...over,
});

describe('appendPage', () => {
  it('appends, dropping a word already loaded', () => {
    expect(appendPage([word('a'), word('b')], [word('b'), word('c')]).map((w) => w.lexeme_id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('showsMark', () => {
  it('marks a word with more than one sense', () => {
    expect(showsMark(word('a', { sense_count: 2 }))).toBe(true);
    expect(showsMark(word('a', { sense_count: 1 }))).toBe(false);
  });
});
```

Append to `apps/mobile/src/api/client.test.ts`, inside `describe('api/client', …)`:

```ts
  it('saveVocabulary posts the entries to the enrollment', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ saved_sense_ids: ['s1'] }) }));
    const client = buildClient(mockFetch);
    await client.saveVocabulary('e 1', { entries: [{ sense_id: 's1', variant_id: 'v1' }] });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.local/api/enrollments/e%201/vocabulary',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ entries: [{ sense_id: 's1', variant_id: 'v1' }] }) }),
    );
  });

  it('unsaveVocabulary sends DELETE and reads no body', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 204 }));
    const client = buildClient(mockFetch);
    await client.unsaveVocabulary('e1', 's1');
    expect(mockFetch).toHaveBeenCalledWith('http://test.local/api/enrollments/e1/vocabulary/senses/s1', {
      method: 'DELETE',
    });
  });

  it('listVocabulary passes cursor and limit as a query string, and nothing when absent', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) }));
    const client = buildClient(mockFetch);
    await client.listVocabulary('e1', { cursor: 'a+b', limit: 50 });
    await client.listVocabulary('e1', {});
    expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://test.local/api/enrollments/e1/vocabulary?cursor=a%2Bb&limit=50', { method: 'GET' });
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://test.local/api/enrollments/e1/vocabulary', { method: 'GET' });
  });

  it('vocabularyWord gets one word', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const client = buildClient(mockFetch);
    await client.vocabularyWord('e1', 'lx1');
    expect(mockFetch).toHaveBeenCalledWith('http://test.local/api/enrollments/e1/vocabulary/words/lx1', { method: 'GET' });
  });

  it('unsaveVocabulary throws ApiError on failure', async () => {
    const client = buildClient(jest.fn(async () => ({ ok: false, status: 404 })));
    await expect(client.unsaveVocabulary('e1', 's1')).rejects.toBeInstanceOf(ApiError);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w apps/mobile -- src/vocabulary.test.ts src/api/client.test.ts`
Expected: FAIL. `./vocabulary` is not found, and `saveVocabulary` is not a function.

- [ ] **Step 3: Implement**

Create `apps/mobile/src/vocabulary.ts`:

```ts
import type { TranslationSense, VocabularyEntryInput, VocabularyWord } from '@lang-tutor/core/api';

/** sense_id → saved, for the senses the server said can be saved here. A sense
 *  absent from the map gets no toggle: a reverse lookup, a sentence, a failed
 *  write. The server decides; the screen only reads this. */
export type SavedState = Record<string, boolean>;

export function savedStateOf(senses: TranslationSense[]): SavedState {
  const state: SavedState = {};
  for (const sense of senses) {
    if (sense.sense_id && sense.variant_id && sense.saved !== undefined) state[sense.sense_id] = sense.saved;
  }
  return state;
}

export function unsavedEntries(senses: TranslationSense[], saved: SavedState): VocabularyEntryInput[] {
  return senses.flatMap((sense) =>
    sense.sense_id && sense.variant_id && saved[sense.sense_id] === false
      ? [{ sense_id: sense.sense_id, variant_id: sense.variant_id }]
      : [],
  );
}

/** Save-all from two: with one unsaved sense it would only repeat that card's button. */
export function canSaveAll(senses: TranslationSense[], saved: SavedState): boolean {
  return unsavedEntries(senses, saved).length >= 2;
}

/** A word can move to the top between pages and be served on a refresh while an
 *  older copy is loaded; the server never serves one twice in a walk, but a
 *  refresh racing a scroll can. The first copy stays. */
export function appendPage(loaded: VocabularyWord[], page: VocabularyWord[]): VocabularyWord[] {
  const seen = new Set(loaded.map((word) => word.lexeme_id));
  return [...loaded, ...page.filter((word) => !seen.has(word.lexeme_id))];
}

export function showsMark(word: VocabularyWord): boolean {
  return word.sense_count > 1;
}
```

In `apps/mobile/src/api/client.ts`:

- add `SaveVocabularyRequest`, `SaveVocabularyResponse`, `VocabularyPage` and `VocabularyWordDetail` to the type import;
- add a helper beside `getJson`:

```ts
  async function deleteResource(path: string): Promise<void> {
    const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE' });
    if (!res.ok) throw new ApiError(res.status);
  }

  const vocabularyPath = (enrollmentId: string) =>
    `/api/enrollments/${encodeURIComponent(enrollmentId)}/vocabulary`;
```

- add these four calls to the returned object:

```ts
    saveVocabulary: (enrollmentId: string, request: SaveVocabularyRequest) =>
      postJson<SaveVocabularyResponse>(vocabularyPath(enrollmentId), request),
    unsaveVocabulary: (enrollmentId: string, senseId: string) =>
      deleteResource(`${vocabularyPath(enrollmentId)}/senses/${encodeURIComponent(senseId)}`),
    listVocabulary: (enrollmentId: string, query: { cursor?: string; limit?: number }) => {
      const params = new URLSearchParams();
      if (query.cursor !== undefined) params.set('cursor', query.cursor);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const search = params.toString();
      return getJson<VocabularyPage>(`${vocabularyPath(enrollmentId)}${search ? `?${search}` : ''}`);
    },
    vocabularyWord: (enrollmentId: string, lexemeId: string) =>
      getJson<VocabularyWordDetail>(`${vocabularyPath(enrollmentId)}/words/${encodeURIComponent(lexemeId)}`),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w apps/mobile -- src/vocabulary.test.ts src/api/client.test.ts`, then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/vocabulary.ts apps/mobile/src/vocabulary.test.ts apps/mobile/src/api/client.ts apps/mobile/src/api/client.test.ts
git commit -m "feat(mobile): vocabulary client calls and toggle/page helpers"
```

---

### Task 9: Mobile — the translate screen saves

**Files:**
- Modify: `apps/mobile/src/hooks/useTranslation.tsx`, `apps/mobile/src/app/translate.tsx`, `apps/mobile/src/strings.ts`
- Modify: `e2e/tests/translate.spec.ts` (the three `translate-choose` uses)

**Interfaces:**
- Consumes: `savedStateOf`, `unsavedEntries`, `canSaveAll` (Task 8); `api.saveVocabulary`, `api.unsaveVocabulary`.
- Produces, on `TranslationValue`:
  - removed: `chosenIndex` and `choose`;
  - added:
    ```ts
    saved: SavedState;
    pending: Record<string, true>;
    saveFailed: boolean;
    toggleSave: (senseId: string) => void;
    saveAll: () => void;
    canSaveAll: boolean;
    ```
- testIDs: `translate-save` (one per saveable card; its label is שמור or נשמר ✓), `translate-save-all`, `translate-save-failed`. `translate-choose` and `translate-chosen` are removed.

- [ ] **Step 1: Update the e2e assertions first (they are this task's failing test)**

In `e2e/tests/translate.spec.ts`:

1. In `'a word shows every sense at once, ranked, and confirms a choice'`, rename the test to `'a word shows every sense at once, ranked, and saves one'` and replace

   ```ts
     await page.getByTestId('translate-choose').nth(1).click();
     await expect(page.getByTestId('translate-chosen')).toHaveText('התרגום נשמר לאוצר המילים שלך');
     await expect(page.getByTestId('translate-new-word')).toBeVisible();
   ```

   with

   ```ts
     // Every card can be saved on its own, and save-all is offered for three unsaved.
     await expect(page.getByTestId('translate-save')).toHaveCount(3);
     await expect(page.getByTestId('translate-save-all')).toBeVisible();
     await page.getByTestId('translate-save').nth(1).click();
     await expect(page.getByTestId('translate-save').nth(1)).toHaveText('נשמר ✓');
     await expect(page.getByTestId('translate-save').nth(0)).toHaveText('שמור');
     await expect(page.getByTestId('translate-new-word')).toBeVisible();
   ```

2. In the sentence test, replace `await expect(page.getByTestId('translate-choose')).toHaveCount(0);` with `await expect(page.getByTestId('translate-save')).toHaveCount(0);`, and update its comment: "a sentence is known not to belong in a vocabulary".
3. In the kite reuse test, delete the four lines from `// Choosing is what reveals…` through the `translate-chosen` assertion. Keep `await page.getByTestId('translate-new-word').click();`, which is now always visible with results.

- [ ] **Step 2: Run e2e to verify it fails**

Run: `npm run e2e -- tests/translate.spec.ts`
Expected: FAIL, because `translate-save` is not found.

- [ ] **Step 3: Strings**

In `apps/mobile/src/strings.ts`, replace the `translateChoose` and `translateChosen` lines with:

```ts
  // Phase 18. The card's own toggle states the save, truthfully — which closes the
  // caveat phase 10 carried on `התרגום נשמר לאוצר המילים שלך`, now deleted.
  translateSave: 'שמור',
  translateSaved: 'נשמר ✓',
  translateSaveAll: 'שמור הכל',
  translateSaveFailed: 'השמירה נכשלה, נסו שוב',
```

- [ ] **Step 4: The hook**

In `apps/mobile/src/hooks/useTranslation.tsx`:

- import `canSaveAll as canSaveAllOf, savedStateOf, unsavedEntries, type SavedState` from `'@/vocabulary'`;
- in `TranslationValue`, delete `chosenIndex` and `choose`, and add:

```ts
  /** sense_id → saved, for the senses that can be saved here (see savedStateOf). */
  saved: SavedState;
  /** Senses with a save or unsave in flight; their toggle is disabled, so a double
   *  tap cannot race a save against an unsave. */
  pending: Record<string, true>;
  /** The last toggle failed and was reverted. Cleared by the next toggle or lookup. */
  saveFailed: boolean;
  toggleSave: (senseId: string) => void;
  saveAll: () => void;
  canSaveAll: boolean;
```

- in the provider:
  - replace `const [chosenIndex, setChosenIndex] = useState<number | null>(null);` with:

```ts
  const [saved, setSaved] = useState<SavedState>({});
  const [pending, setPending] = useState<Record<string, true>>({});
  const [saveFailed, setSaveFailed] = useState(false);
```

  - every `setChosenIndex(null)` becomes `setSaved({}); setPending({}); setSaveFailed(false);`. There are three: in the `active` effect, at the top of `run`, and in `reset`.
  - in `run`, send the enrollment and seed the toggles. `run` already reads `along`; add `active` to its dependency list:

```ts
        const response = await api.translate({
          text: trimmed,
          from: along.from,
          to: along.to,
          // Phase 18. The server marks `saved` for a target-language lookup and
          // nothing else; the client never decides which senses are saveable.
          ...(active ? { enrollment_id: active.id } : {}),
        });
        setResult(response);
        setSaved(savedStateOf(response.senses));
```

  - add, before `const value = useMemo`:

```ts
  // Optimistic: flip first, revert on failure. `pending` keeps one request per
  // sense in flight.
  const send = useCallback(
    async (entries: { sense_id: string; variant_id: string }[], next: boolean) => {
      if (!active || entries.length === 0) return;
      const ids = entries.map((entry) => entry.sense_id);
      const set = (value: boolean) =>
        setSaved((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, value])) }));
      set(next);
      setPending((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, true as const])) }));
      setSaveFailed(false);
      try {
        if (next) await api.saveVocabulary(active.id, { entries });
        else await api.unsaveVocabulary(active.id, ids[0]);
      } catch {
        set(!next);
        setSaveFailed(true);
      } finally {
        setPending((current) => {
          const rest = { ...current };
          for (const id of ids) delete rest[id];
          return rest;
        });
      }
    },
    [api, active],
  );
```

  - in the `value` object:
    - remove `chosenIndex` and `choose`;
    - add the members below;
    - in `flip`, replace `const sense = result?.senses[chosenIndex ?? 0];` and its comment with `// The top-ranked sense: the card wearing the badge.` followed by `const sense = result?.senses[0];`.

```ts
      saved,
      pending,
      saveFailed,
      canSaveAll: result ? canSaveAllOf(result.senses, saved) : false,
      toggleSave: (senseId: string) => {
        const sense = result?.senses.find((s) => s.sense_id === senseId);
        if (!sense?.variant_id || saved[senseId] === undefined || pending[senseId]) return;
        void send([{ sense_id: senseId, variant_id: sense.variant_id }], !saved[senseId]);
      },
      saveAll: () => {
        if (!result) return;
        void send(unsavedEntries(result.senses, saved).filter((e) => !pending[e.sense_id]), true);
      },
```

  - the `useMemo` dependency list: replace `chosenIndex` with `saved, pending, saveFailed, send`.

- [ ] **Step 5: The screen**

In `apps/mobile/src/app/translate.tsx`:

- delete the `chosen` / `showChoose` / `onChoose` props of `SenseCard`, the `translate-chosen` text and the `translate-choose` button;
- give `SenseCard` these props instead, `saveState: boolean | undefined; pending: boolean; onToggle: () => void`, and render, where the choose button was:

```tsx
      {/* The card's own button saves it, not the card body: these cards are read
          and compared, and a tap-anywhere card turns reading into saving. */}
      {saveState !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: saveState, disabled: pending }}
          disabled={pending}
          testID="translate-save"
          onPress={onToggle}
          style={[styles.chooseButton, saveState && styles.savedButton]}
        >
          <Text style={styles.chooseLabel}>
            {saveState ? strings.translateSaved : strings.translateSave}
          </Text>
        </Pressable>
      ) : null}
```

- the `senses.map` becomes:

```tsx
          {senses.map((sense, index) => (
            <SenseCard
              key={`${sense.translation}-${index}`}
              sense={sense}
              isTop={index === 0 && !isSentence}
              saveState={sense.sense_id ? t.saved[sense.sense_id] : undefined}
              pending={sense.sense_id ? Boolean(t.pending[sense.sense_id]) : false}
              onToggle={() => sense.sense_id && t.toggleSave(sense.sense_id)}
            />
          ))}
```

- just above it, after the count line:

```tsx
          {t.canSaveAll ? (
            <Pressable
              accessibilityRole="button"
              testID="translate-save-all"
              onPress={t.saveAll}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryLabel}>{strings.translateSaveAll}</Text>
            </Pressable>
          ) : null}
          {t.saveFailed ? (
            <Text testID="translate-save-failed" style={styles.noticeText}>
              {strings.translateSaveFailed}
            </Text>
          ) : null}
```

- the "מלה חדשה" button: change its condition from `t.chosenIndex !== null` to always render inside the `answered` branch;
- add `savedButton: { backgroundColor: colors.background },` to `styles`;
- delete the now-unused `cardChosen` and `chosenLabel` styles.

- [ ] **Step 6: Run the checks to verify they pass**

Run:
```bash
npm run typecheck && npm test -w apps/mobile && npm run lint:arch
npm run e2e -- tests/translate.spec.ts
```
Expected: PASS. The e2e server is a fresh process per run (playwright `webServer`), so it already serves Tasks 1–6.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/hooks/useTranslation.tsx apps/mobile/src/app/translate.tsx apps/mobile/src/strings.ts e2e/tests/translate.spec.ts
git commit -m "feat(mobile): שמור toggles and save-all replace the decorative choose"
```

---

### Task 10: Mobile — the list, the drill-down, the home entry

**Files:**
- Create: `apps/mobile/src/hooks/useVocabulary.tsx`, `apps/mobile/src/app/vocabulary/index.tsx`, `apps/mobile/src/app/vocabulary/[lexemeId].tsx`
- Modify: `apps/mobile/src/app/_layout.tsx`, `apps/mobile/src/app/index.tsx`, `apps/mobile/src/strings.ts`
- Test: `e2e/tests/vocabulary.spec.ts` (Task 11 writes it; this task is verified by typecheck, unit tests and a manual run)

**Interfaces:**
- Consumes: `api.listVocabulary`, `api.vocabularyWord`, `api.saveVocabulary`, `api.unsaveVocabulary`; `appendPage`, `showsMark`.
- Produces:
  ```ts
  export type VocabularyValue = {
    words: VocabularyWord[];
    status: 'idle' | 'loading' | 'ready' | 'error';
    hasMore: boolean;
    reload: () => void;
    loadMore: () => void;
    loadWord: (lexemeId: string) => Promise<VocabularyWordDetail>;
    save: (entries: VocabularyEntryInput[]) => Promise<void>;
    unsave: (senseId: string) => Promise<void>;
  };
  export function VocabularyProvider(props: { api: ApiClient; children: ReactNode }): JSX.Element;
  export function useVocabulary(): VocabularyValue;
  ```
- testIDs: `vocabulary-entry`, `vocabulary-title`, `vocabulary-word`, `vocabulary-mark`, `vocabulary-empty`, `vocabulary-back`, `vocabulary-sense`, `vocabulary-sense-save`, `vocabulary-word-back`.

- [ ] **Step 1: Strings**

Add to `apps/mobile/src/strings.ts`, after the translate strings:

```ts
  vocabularyEntry: 'אוצר המילים שלי',
  vocabularyTitle: (language: string) => `אוצר המילים שלי ב${languageName(language)}`,
  vocabularyEmpty: 'עוד לא שמרת מילים. חפשו מילה בתרגום ולחצו על שמור.',
  vocabularyGoTranslate: 'לתרגום',
  vocabularyLoadFailed: 'הרשימה לא נטענה',
  // "2/5": saved of total. Isolated for the reason progressLabel is: a run with
  // no strong direction is reordered by the RTL layout on Android.
  vocabularyMark: (saved: number, total: number) => isolateLtr(`${saved}/${total}`),
  // FSI/PDI around the form, as in translateCorrectionNotice: a Cyrillic or Latin
  // word inside a Hebrew sentence.
  vocabularyFromForm: (form: string) => `מתוך ⁨${form}⁩`,
```

- [ ] **Step 2: The hook**

Create `apps/mobile/src/hooks/useVocabulary.tsx`:

```tsx
import type {
  VocabularyEntryInput,
  VocabularyWord,
  VocabularyWordDetail,
} from '@lang-tutor/core/api';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { ApiClient } from '@/api/client';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { appendPage } from '@/vocabulary';

// Mirrors TranslationProvider: constructed at the composition root with the api
// client passed in (ADR 0002). The server is the single source of truth — no
// cross-screen cache; the list reloads on focus.
export type VocabularyStatus = 'idle' | 'loading' | 'ready' | 'error';

export type VocabularyValue = {
  words: VocabularyWord[];
  status: VocabularyStatus;
  hasMore: boolean;
  /** From the top: on focus, on pull-to-refresh, after an enrollment switch. */
  reload: () => void;
  /** The next page, if there is one and none is loading. */
  loadMore: () => void;
  loadWord: (lexemeId: string) => Promise<VocabularyWordDetail>;
  save: (entries: VocabularyEntryInput[]) => Promise<void>;
  unsave: (senseId: string) => Promise<void>;
};

const VocabularyContext = createContext<VocabularyValue | undefined>(undefined);

export function VocabularyProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const { active } = useCurrentUser();
  const [words, setWords] = useState<VocabularyWord[]>([]);
  const [status, setStatus] = useState<VocabularyStatus>('idle');
  const [cursor, setCursor] = useState<string | null>(null);
  // A reload bumps this; a page that lands for an older generation is dropped,
  // so a slow page 3 cannot append to a list that was reloaded meanwhile.
  const generation = useRef(0);

  const fetchPage = useCallback(
    async (after: string | null, replace: boolean) => {
      if (!active) return;
      const mine = replace ? ++generation.current : generation.current;
      setStatus('loading');
      try {
        const page = await api.listVocabulary(active.id, after ? { cursor: after } : {});
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

  // A switch of enrollment is another list.
  useEffect(() => {
    generation.current += 1;
    setWords([]);
    setCursor(null);
    setStatus('idle');
  }, [active]);

  // Stable identities, not inline arrows in the memo below. The list screen hands
  // `reload` to useFocusEffect and the drill-down puts `loadWord` in an effect's
  // dependencies; a new function on every render would re-run both on every
  // state change — a reload loop.
  const reload = useCallback(() => void fetchPage(null, true), [fetchPage]);
  const loadWord = useCallback(
    (lexemeId: string) => {
      if (!active) return Promise.reject(new Error('no active enrollment'));
      return api.vocabularyWord(active.id, lexemeId);
    },
    [api, active],
  );
  const save = useCallback(
    async (entries: VocabularyEntryInput[]) => {
      if (!active) return;
      await api.saveVocabulary(active.id, { entries });
    },
    [api, active],
  );
  const unsave = useCallback(
    async (senseId: string) => {
      if (!active) return;
      await api.unsaveVocabulary(active.id, senseId);
    },
    [api, active],
  );

  const value = useMemo<VocabularyValue>(
    () => ({
      words,
      status,
      hasMore: cursor !== null,
      reload,
      loadMore: () => {
        if (cursor !== null && status !== 'loading') void fetchPage(cursor, false);
      },
      loadWord,
      save,
      unsave,
    }),
    [words, status, cursor, fetchPage, reload, loadWord, save, unsave],
  );

  return <VocabularyContext.Provider value={value}>{children}</VocabularyContext.Provider>;
}

export function useVocabulary(): VocabularyValue {
  const value = useContext(VocabularyContext);
  if (!value) throw new Error('useVocabulary must be used inside a VocabularyProvider');
  return value;
}
```

In `apps/mobile/src/app/_layout.tsx`:

- import `VocabularyProvider` from `'@/hooks/useVocabulary'`;
- wrap it inside `TranslationProvider`, around the `<View …>`: `<VocabularyProvider api={api}> … </VocabularyProvider>`.

- [ ] **Step 3: The list screen**

Create `apps/mobile/src/app/vocabulary/index.tsx`:

```tsx
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useVocabulary } from '@/hooks/useVocabulary';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';
import { showsMark } from '@/vocabulary';

export default function VocabularyScreen() {
  const { active } = useCurrentUser();
  const v = useVocabulary();
  const { reload } = v;
  // On every focus, including the return from a drill-down: that is what makes
  // a change made there appear here.
  useFocusEffect(useCallback(() => reload(), [reload]));
  if (!active) return <Redirect href="/" />;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" testID="vocabulary-back" onPress={() => router.back()}>
          <Text style={styles.link}>{strings.back}</Text>
        </Pressable>
        <Text testID="vocabulary-title" style={styles.title}>
          {strings.vocabularyTitle(active.target_language)}
        </Text>
      </View>

      {v.status === 'error' ? (
        <Text style={styles.notice}>{strings.vocabularyLoadFailed}</Text>
      ) : null}

      <FlatList
        data={v.words}
        keyExtractor={(word) => word.lexeme_id}
        onEndReached={v.loadMore}
        onEndReachedThreshold={0.5}
        refreshing={v.status === 'loading' && v.words.length === 0}
        onRefresh={v.reload}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          v.status === 'ready' ? (
            <View testID="vocabulary-empty" style={styles.empty}>
              <Text style={styles.notice}>{strings.vocabularyEmpty}</Text>
              <Pressable accessibilityRole="button" onPress={() => router.push('/translate')}>
                <Text style={styles.link}>{strings.vocabularyGoTranslate}</Text>
              </Pressable>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const partOfSpeech = strings.partOfSpeech(item.part_of_speech);
          return (
            <Pressable
              accessibilityRole="button"
              testID="vocabulary-word"
              onPress={() => router.push(`/vocabulary/${item.lexeme_id}`)}
              style={styles.row}
            >
              <View style={styles.rowTop}>
                <Text style={styles.lemma}>{item.lemma}</Text>
                {showsMark(item) ? (
                  <Text testID="vocabulary-mark" style={styles.mark}>
                    {strings.vocabularyMark(item.saved_count, item.sense_count)}
                  </Text>
                ) : null}
              </View>
              {partOfSpeech ? <Text style={styles.meta}>{partOfSpeech}</Text> : null}
              <Text style={styles.translation}>{item.headline.translation}</Text>
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.text, writingDirection: 'rtl' },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  list: { gap: spacing.sm, paddingBottom: spacing.xl },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lemma: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.text },
  mark: { fontSize: fontSizes.sm, color: colors.muted },
  meta: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
  translation: { fontSize: fontSizes.md, lineHeight: lineHeights.md, color: colors.text, writingDirection: 'rtl' },
  empty: { gap: spacing.sm, alignItems: 'center', paddingTop: spacing.xl },
  notice: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl', textAlign: 'center' },
});
```

If `fontSizes.sm` does not exist in `apps/mobile/src/theme.ts`, use the smallest key that does. Check before writing.

- [ ] **Step 4: The drill-down screen**

Create `apps/mobile/src/app/vocabulary/[lexemeId].tsx`:

```tsx
import type { VocabularyWordDetail } from '@lang-tutor/core/api';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useVocabulary } from '@/hooks/useVocabulary';
import { strings } from '@/strings';
import { colors, fontSizes, lineHeights, radii, spacing } from '@/theme';

export default function VocabularyWordScreen() {
  const { lexemeId } = useLocalSearchParams<{ lexemeId: string }>();
  const { loadWord, save, unsave } = useVocabulary();
  const [word, setWord] = useState<VocabularyWordDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<Record<string, true>>({});

  useEffect(() => {
    let live = true;
    loadWord(lexemeId)
      .then((detail) => live && setWord(detail))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [lexemeId, loadWord]);

  // Optimistic, as on the translate screen. No save-all here: these senses are
  // browsed, not just looked up (spec §5).
  async function toggle(senseId: string) {
    const sense = word?.senses.find((s) => s.sense_id === senseId);
    if (!word || !sense || pending[senseId]) return;
    const next = !sense.saved;
    const set = (saved: boolean) =>
      setWord((w) => w && { ...w, senses: w.senses.map((s) => (s.sense_id === senseId ? { ...s, saved } : s)) });
    set(next);
    setPending((p) => ({ ...p, [senseId]: true }));
    setFailed(false);
    try {
      if (next) await save([{ sense_id: senseId, variant_id: sense.variant_id }]);
      else await unsave(senseId);
    } catch {
      set(!next);
      setFailed(true);
    } finally {
      setPending(({ [senseId]: _done, ...rest }) => rest);
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Pressable accessibilityRole="button" testID="vocabulary-word-back" onPress={() => router.back()}>
        <Text style={styles.link}>{strings.back}</Text>
      </Pressable>

      {failed ? <Text style={styles.notice}>{strings.translateSaveFailed}</Text> : null}
      {!word ? (
        failed ? null : <ActivityIndicator />
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.lemma}>{word.lemma}</Text>
          {strings.partOfSpeech(word.part_of_speech) ? (
            <Text style={styles.meta}>{strings.partOfSpeech(word.part_of_speech)}</Text>
          ) : null}
          {word.senses.map((sense) => (
            <View key={sense.sense_id} testID="vocabulary-sense" style={styles.card}>
              <Text style={styles.translation}>{sense.translation}</Text>
              {sense.form.toLowerCase() !== word.lemma.toLowerCase() ? (
                <Text style={styles.meta}>{strings.vocabularyFromForm(sense.form)}</Text>
              ) : null}
              {sense.example ? (
                <View style={styles.example}>
                  <Text style={styles.exampleSource}>{sense.example.source}</Text>
                  <Text style={styles.meta}>{sense.example.target}</Text>
                </View>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: sense.saved, disabled: Boolean(pending[sense.sense_id]) }}
                disabled={Boolean(pending[sense.sense_id])}
                testID="vocabulary-sense-save"
                onPress={() => void toggle(sense.sense_id)}
                style={[styles.toggle, sense.saved && styles.toggleSaved]}
              >
                <Text style={styles.toggleLabel}>
                  {sense.saved ? strings.translateSaved : strings.translateSave}
                </Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  link: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '700' },
  list: { gap: spacing.sm, paddingBottom: spacing.xl },
  lemma: { fontSize: fontSizes.xl, fontWeight: '700', color: colors.text },
  meta: { fontSize: fontSizes.sm, color: colors.muted, writingDirection: 'rtl' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  translation: { fontSize: fontSizes.lg, lineHeight: lineHeights.lg, color: colors.text, writingDirection: 'rtl' },
  example: { gap: spacing.xs },
  exampleSource: { fontSize: fontSizes.md, color: colors.text },
  toggle: {
    alignSelf: 'flex-start',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  toggleSaved: { backgroundColor: colors.background },
  toggleLabel: { color: colors.primary, fontWeight: '700' },
  notice: { fontSize: fontSizes.md, color: colors.muted, writingDirection: 'rtl' },
});
```

Use the same `theme.ts` check as Step 3 for `fontSizes.xl` and `fontSizes.sm`.

- [ ] **Step 5: The home entry**

In `apps/mobile/src/app/index.tsx`, after the `translate-entry` `Pressable`, add:

```tsx
      <Pressable
        accessibilityRole="button"
        testID="vocabulary-entry"
        onPress={() => router.push('/vocabulary')}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryButtonLabel}>{strings.vocabularyEntry}</Text>
      </Pressable>
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test -w apps/mobile && npm run lint:arch`
Expected: PASS. ADR 0002 R1 must stay quiet: `AsyncStorage` is still imported only by `_layout.tsx`.

Then use the `run` skill (or `npm run server` + `npm run mobile` with `npm run db:reseed`) to look at it on web:

1. Log in as a Russian learner.
2. Look up a word and save one sense.
3. Open **אוצר המילים שלי**.
4. Open the word, toggle, go back.

Confirm the row updates on return.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/hooks/useVocabulary.tsx apps/mobile/src/app/vocabulary apps/mobile/src/app/_layout.tsx apps/mobile/src/app/index.tsx apps/mobile/src/strings.ts
git commit -m "feat(mobile): my vocabulary list and word drill-down"
```

---

### Task 11: e2e — the vocabulary flow

**Files:**
- Create: `e2e/tests/vocabulary.spec.ts`

**Interfaces:**
- Consumes: `createLearner(request, username, 'ru')`, `logIn`, `clearGemini`, `expectGemini`; the testIDs from Tasks 9 and 10.

- [ ] **Step 1: Write the spec**

Create `e2e/tests/vocabulary.spec.ts`:

```ts
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { clearGemini, expectGemini } from './support/mockServer';
import { createLearner, logIn } from './support/users';

test.setTimeout(180_000);

// Strings the seed does not contain, so each lookup reaches MockServer once and
// is written to the e2e database. The lexemes are new, so no reconciliation call.
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
const BATZAL = {
  kind: 'word' as const,
  entries: [{ lemma: 'בצל', part_of_speech: 'noun', senses: [{ translation: 'лук', sense_code: 'onion' }] }],
};

test.beforeEach(async ({ request }) => {
  await clearGemini(request);
});

// Retried: a static export serves markup before React hydrates, so an early click
// is a silent no-op (the pattern session.spec.ts and translate.spec.ts use).
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

test('a Russian learner saves senses, browses the list, and changes it from the drill-down', async ({
  page,
  request,
}) => {
  await createLearner(request, 'e2e_vocab_ru', 'ru');
  await logIn(page, 'e2e_vocab_ru');
  await tapUntil(page, 'translate-entry', 'translate-input');

  // One sense of прочитала.
  await lookUp(page, request, 'прочитала', PROCHITALA);
  await page.getByTestId('translate-save').first().click();
  await expect(page.getByTestId('translate-save').first()).toHaveText('נשמר ✓');

  // Both senses of лук, in one tap.
  await page.getByTestId('translate-new-word').click();
  await lookUp(page, request, 'лук', LUK);
  await page.getByTestId('translate-save-all').click();
  await expect(page.getByTestId('translate-save')).toHaveText(['נשמר ✓', 'נשמר ✓']);
  await expect(page.getByTestId('translate-save-all')).toHaveCount(0);

  // A reverse lookup offers no save: its senses belong to the Hebrew lexeme.
  await page.getByTestId('translate-new-word').click();
  await page.getByTestId('translate-flip').click();
  await lookUp(page, request, 'בצל', BATZAL);
  await expect(page.getByTestId('translate-save')).toHaveCount(0);

  // The list: newest save first, and прочитать carries 1/2.
  await page.getByTestId('translate-back').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  const words = page.getByTestId('vocabulary-word');
  await expect(words).toHaveCount(2);
  await expect(words.nth(0)).toContainText('лук');
  await expect(words.nth(1)).toContainText('прочитать');
  await expect(words.nth(1).getByTestId('vocabulary-mark')).toContainText('1/2');
  await expect(words.nth(0).getByTestId('vocabulary-mark')).toContainText('2/2');

  // Drill-down: save the second meaning, unsave the first.
  await words.nth(1).click();
  const senses = page.getByTestId('vocabulary-sense');
  await expect(senses).toHaveCount(2);
  await expect(senses.nth(0)).toContainText('קראה');
  await expect(senses.nth(0).getByTestId('vocabulary-sense-save')).toHaveText('נשמר ✓');
  await senses.nth(1).getByTestId('vocabulary-sense-save').click();
  await expect(senses.nth(1).getByTestId('vocabulary-sense-save')).toHaveText('נשמר ✓');
  await senses.nth(0).getByTestId('vocabulary-sense-save').click();
  await expect(senses.nth(0).getByTestId('vocabulary-sense-save')).toHaveText('שמור');

  // Back on the list the counts agree: one of two saved, and прочитать moved to
  // the top, because its newest save is now the newest of all.
  await page.getByTestId('vocabulary-word-back').click();
  await expect(words.nth(0)).toContainText('прочитать');
  await expect(words.nth(0).getByTestId('vocabulary-mark')).toContainText('1/2');
  await expect(words.nth(0)).toContainText('הקריאה');
});
```

- [ ] **Step 2: Run it**

Run: `npm run e2e -- tests/vocabulary.spec.ts`
Expected: PASS. If the flip step fails because `translate-flip` with nothing on screen only swaps the direction (the hook's documented behaviour), that is correct. The `lookUp` that follows types `בצל` in the swapped direction.

If the list's first assertion fails because the drill-down's toggles have not landed when the list reloads, the reload-on-focus is racing the unsave. Wait on the toggle's final text before going back, as the spec already does, and do not add sleeps.

- [ ] **Step 3: Run the full gates**

Run each, in order:
```bash
npm test
npm run test:all
npm run lint:arch
npm run typecheck
npm run e2e
```
Expected: all PASS. `npm run eval` needs `GEMINI_API_KEY` and `GEMINI_MODEL`. The model's schema is unchanged (Task 2's `LlmSenseSchema` test proves it), so run it if the key is available and say so either way. Never lower `TIER2_THRESHOLD`.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/vocabulary.spec.ts
git commit -m "test(e2e): save, save-all, list, drill-down and a reverse lookup with no save"
```
