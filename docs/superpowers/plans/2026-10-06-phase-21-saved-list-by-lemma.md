# Phase 21 — Saved List by Lemma Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The saved list shows one row per lemma instead of one per lexeme, and the word detail, addressed by lemma, shows every part of speech of that lemma with a label on each card.

**Architecture:** `vocabulary_entries` gains a `lemma` column copied from the lexeme at save time and pinned to it by a composite foreign key. The list groups by that column, so its query keeps phase 20's shape and cost. The detail route takes `?lemma=` and reads every lexeme with that lemma in the enrollment's target language. The level sorts and the `sort` parameter are removed end to end; the level filter gains an "all" chip.

**Tech Stack:** Node 24, TypeScript, Hono + @hono/zod-openapi, Drizzle ORM 0.45 and drizzle-kit 0.31 on node-postgres, Postgres 17, Jest 29, Expo Router / React Native, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-06-lang-tutor-phase-21-saved-list-by-lemma-design.md`. Read it before starting a task. Where this plan and the spec differ, this plan wins. There are no deliberate differences.

## Global Constraints

- **You work in the worktree** `/Users/victorprp/git/lang-tutor/.claude/worktrees/phase-21-saved-list-by-lemma`, on branch `phase-21-saved-list-by-lemma`. Never `cd` to, read from, or write into `/Users/victorprp/git/lang-tutor` itself: that is the main checkout, on `master`, with a live server.
- **Never hardcode a port or a database name** (ADR 0006). Run one integration test file through the lane wrapper:
  `bash scripts/lane-env.sh npm run test:integration -w apps/server -- <paths>`
- `npm` and `docker` are not on a tool shell's `PATH`. Prefix commands with `export PATH="/opt/homebrew/bin:$PATH";`.
- **Wire contract** (ADR 0003): every request and response schema lives in `packages/core/src/api/schemas.ts`; `types.ts` only exports `z.infer<...>` types; `index.ts` only re-exports types. Routes are declared with `createRoute` and `router.openapi`.
- **Layering** (ADR 0001): `domain/` imports only `@lang-tutor/core`; `services/` imports repo types only; `routes/` never imports `repo/` or `db/`.
- **The cursor** is base64url of the JSON array `['lemma', savedAt, lemma]`. Anything else decodes to `null`, which the route answers with `400 { error: 'invalid request' }`.
- **Error bodies:** list and detail validation failures are `400 { error: 'invalid request' }`; an unknown enrollment is `404 { error: 'enrollment not found' }`; no lexeme with the lemma in the target language is `404 { error: 'word not found' }`.
- **Lemmas match exactly**, case-sensitive, as `dict_lexemes.lemma` stores them.
- **Detail card order:** saved first, then `part_of_speech` ascending, then rank, then sense id.
- **Row parts of speech:** distinct codes of the lemma's saved senses, ascending; the app names each through `strings.partOfSpeech`, drops a code with no name, and joins the rest with `' · '`.
- **Hebrew strings:** `levelAll` is `'הכל'`. `sortNewest`, `sortLevelAsc` and `sortLevelDesc` are deleted.
- **Gates for every task:** `npm run typecheck`, `npm test`, the task's integration test files, and `npm run lint:arch` all pass before its commit. Task 4 adds `npm run e2e`; Task 5 runs everything.
- **Commits** use the repo's conventional style, `feat(server): …`, `test(e2e): …`, and end with the line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

These are the inputs the spec implies but no happy-path test exercises. Each has a pinned test in the task named.

1. **A lemma with a space or a slash, or in Cyrillic, on the detail route.** It is found and echoed, and the app encodes it. Route test with `всё равно` and `и/или` (Task 2), client test with `ice cream` and `знать` (Task 2).
2. **Lemmas that differ only in case.** `May` and `may` stay two rows, and each detail shows only its own lexeme (Task 2 detail, Task 3 list).
3. **A phase 18 or phase 20 cursor held across the deploy.** It answers 400, not 500, and is never read as a position (Task 3, unit and route).
4. **Unsaving the last saved sense of one lexeme while another lexeme of the lemma stays saved.** The row stays, with its counts and level recomputed (Task 3 route test, Task 4 e2e).
5. **A walk during which an old word gains a save in its other lexeme.** The word moves to the top behind the cursor and is not served twice (Task 3 route test).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/server/src/db/schema.ts` | `vocabulary_entries.lemma`, the composite FK, the index swap, `dict_lexemes_id_lemma_key` | 1 |
| `apps/server/src/db/migrations/0013_vocabulary_entries_lemma.sql` + `meta/` | the migration and its drizzle snapshot | 1 |
| `apps/server/src/repo/vocabulary.ts` | save writes the lemma (1); detail reads by lemma (2); list groups by lemma (3) | 1, 2, 3 |
| `apps/server/tests/support/vocabularyRows.ts`, `progressRows.ts` | fixtures pass the lemma | 1 |
| `packages/core/src/api/schemas.ts`, `types.ts`, `index.ts` | detail by lemma (2); list item and query (3) | 2, 3 |
| `apps/server/src/errors.ts` | `WordNotFound` replaces `LexemeNotFound` | 2 |
| `apps/server/src/domain/vocabulary.ts` | `buildWordDetail` over several lexemes (2); cursor, page rows and `assemblePage` by lemma (3) | 2, 3 |
| `apps/server/src/services/vocabulary.ts` | `wordDetail(enrollmentId, lemma)` (2); `listWords` without sort (3) | 2, 3 |
| `apps/server/src/routes/vocabulary.ts` | `GET …/vocabulary/word?lemma=` (2); list description (3) | 2, 3 |
| `apps/mobile/src/app/vocabulary/word.tsx` | the detail screen, renamed from `[lexemeId].tsx` | 2 |
| `apps/mobile/src/app/vocabulary/index.tsx` | row navigation (2); list rows by lemma, "all" chip, no sort chips (3) | 2, 3 |
| `apps/mobile/src/api/client.ts`, `hooks/useVocabulary.tsx` | `vocabularyWord(…, lemma)` (2); no `sort` (3) | 2, 3 |
| `apps/mobile/src/vocabulary.ts` | `appendPage` by lemma, `partsOfSpeechLabel` | 3 |
| `apps/mobile/src/progress.ts`, `strings.ts` | remove `nextLevelFilter` and the sort labels, add `levelAll` | 3 |
| `e2e/tests/vocabulary.spec.ts`, `progress.spec.ts`, `support/lexemes.ts` | the merged word end to end; the filter without sorts | 4 |

---

### Task 1: The copied lemma

Adds `vocabulary_entries.lemma`, pins it to the lexeme's lemma with a composite foreign key, swaps the lexeme index for a lemma index, and makes every writer of entries supply it. Nothing reads the column yet: the list and detail still work by lexeme at the end of this task, and every existing test still passes.

**Files:**
- Modify: `apps/server/src/db/schema.ts` (the `dictLexemes` table, the `vocabularyEntries` table)
- Create: `apps/server/src/db/migrations/0013_vocabulary_entries_lemma.sql`, plus the snapshot and journal entry drizzle-kit writes under `apps/server/src/db/migrations/meta/`
- Modify: `apps/server/src/repo/vocabulary.ts` (`SaveableEntry`, `saveable`, `insertEntries`, `findSaveable`)
- Modify: `apps/server/tests/support/vocabularyRows.ts`, `apps/server/tests/support/progressRows.ts`
- Test: `apps/server/tests/integration/db/vocabulary.schema.test.ts`, `db/migrations.test.ts`, `repo/vocabulary.test.ts`, `db/progress.schema.test.ts`, `db/progressRecompute.test.ts`, `repo/progress.test.ts`, `repo/vocabulary.plan.test.ts` (all under `apps/server/tests/integration/`)

**Interfaces:**
- Produces: `SaveableEntry = { senseId: string; variantId: string; lexemeId: string; lemma: string }` from `repo/vocabulary.ts`. `findSaveable` returns it, and `insertEntries({ enrollmentId, entries: SaveableEntry[] })` takes it.
- Produces: the column `vocabulary_entries.lemma text NOT NULL`, the index `vocabulary_entries_enrollment_lemma_idx (enrollment_id, lemma, created_at)`, and the FK `vocabulary_entries_lexeme_lemma_fk (lexeme_id, lemma) → dict_lexemes (id, lemma) ON DELETE CASCADE ON UPDATE CASCADE`. Tasks 2 and 3 read by lemma through this index.

- [ ] **Step 1: Write the failing schema tests**

In `apps/server/tests/integration/db/vocabulary.schema.test.ts`, give the `insert` helper a `lemma` column, defaulting to the lexeme's own lemma `'kite'`:

```ts
type Column = 'enrollment' | 'sense' | 'lexeme' | 'lemma' | 'variant';
const insert = (over: Partial<Record<Column, string>> = {}) =>
  t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id)
    values (${over.enrollment ?? enrollmentOf('u_1')}, ${over.sense ?? kite.senseIds[0]},
            ${over.lexeme ?? kite.lexemeId}, ${over.lemma ?? 'kite'}, ${over.variant ?? kite.variantIds[0]})`);
```

Replace the `lexeme` row of the "rejects an unknown %s" table with the composite key, and add a `lemma` row:

```ts
  it.each<[Column, string]>([
    ['enrollment', 'vocabulary_entries_enrollment_fk'],
    ['sense', 'vocabulary_entries_sense_fk'],
    ['lexeme', 'vocabulary_entries_lexeme_lemma_fk'],
    ['lemma', 'vocabulary_entries_lexeme_lemma_fk'],
    ['variant', 'vocabulary_entries_variant_fk'],
  ])('rejects an unknown %s', async (column, constraint) => {
    await expect(insert({ [column]: 'nope' })).rejects.toThrow(violating(constraint));
  });

  it("rejects a lemma that is not its lexeme's, even one another lexeme has", async () => {
    await insertLexeme(t.db, {
      lemma: 'fly',
      languageCode: 'en',
      partOfSpeech: 'verb',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'move' }],
      variants: [],
    });
    await expect(insert({ lemma: 'fly' })).rejects.toThrow(violating('vocabulary_entries_lexeme_lemma_fk'));
  });

  it('requires a lemma', async () => {
    await expect(
      t.db.execute(sql`
        insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id)
        values (${enrollmentOf('u_1')}, ${kite.senseIds[0]}, ${kite.lexemeId}, ${kite.variantIds[0]})`),
    ).rejects.toThrow(expect.objectContaining({ cause: expect.objectContaining({ message: expect.stringContaining('lemma') }) }));
  });
```

Replace the index test:

```ts
  it('carries exactly the two indexes the spec names, and no single-column FK index', async () => {
    const rows = await t.db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes where tablename = 'vocabulary_entries'
      order by indexname`);
    expect(rows.rows.map((r) => r.indexname)).toEqual([
      'vocabulary_entries_enrollment_lemma_idx',
      'vocabulary_entries_pkey',
    ]);
    expect(rows.rows[0].indexdef).toContain('(enrollment_id, lemma, created_at)');
  });
```

- [ ] **Step 2: Write the failing migration test**

Append to `apps/server/tests/integration/db/migrations.test.ts`, after the `0012_sense_progress` block, using the helpers that file already imports:

```ts
describe('0013_vocabulary_entries_lemma', () => {
  it("gives every existing entry its lexeme's lemma", async () => {
    const db = await emptyDatabase();
    await runMigrationsFrom(db, migrationsUpTo('0012_sense_progress'));

    await db.execute(sql`
      insert into users (id, username, display_name, age, native_language)
        values ('u_1', 'u_1', 'one', 30, 'he');
      insert into enrollments (id, user_id, source_language, target_language)
        values ('e_1', 'u_1', 'he', 'en');
      insert into dict_lexemes (id, language_code, lemma, part_of_speech)
        values ('l1', 'en', 'kite', 'noun'), ('l2', 'en', 'kite', 'verb');
      insert into dict_senses (id, lexeme_id, sense_code)
        values ('s1', 'l1', 'toy'), ('s2', 'l2', 'fly');
      insert into dict_variants (id, lexeme_id, language_code, form, kind, entry_rank)
        values ('v1', 'l1', 'en', 'kite', 'word', 0), ('v2', 'l2', 'en', 'kite', 'word', 1);
      insert into dict_var_translations (variant_id, sense_id, user_language_code, translation, rank)
        values ('v1', 's1', 'he', 'עפיפון', 0), ('v2', 's2', 'he', 'להטיס', 0);
      insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, variant_id)
        values ('e_1', 's1', 'l1', 'v1'), ('e_1', 's2', 'l2', 'v2');
    `);

    await runMigrations(db);

    const rows = await db.execute<{ sense_id: string; lemma: string }>(
      sql`select sense_id, lemma from vocabulary_entries order by sense_id`,
    );
    expect(rows.rows).toEqual([
      { sense_id: 's1', lemma: 'kite' },
      { sense_id: 's2', lemma: 'kite' },
    ]);
  });
});
```

- [ ] **Step 3: Run the two test files and watch them fail**

Run: `export PATH="/opt/homebrew/bin:$PATH"; bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/db/vocabulary.schema.test.ts tests/integration/db/migrations.test.ts`
Expected: FAIL. The inserts fail with `column "lemma" of relation "vocabulary_entries" does not exist`, the index list still names `vocabulary_entries_enrollment_lexeme_idx`, and `migrationsUpTo('0012_sense_progress')` followed by `runMigrations` leaves no `lemma` column.

- [ ] **Step 4: Change the schema**

In `apps/server/src/db/schema.ts`, add a unique constraint to `dictLexemes`, beside the existing one:

```ts
  (t) => [
    unique('dict_lexemes_language_lemma_pos_key').on(t.languageCode, t.lemma, t.partOfSpeech),
    // Phase 21. What vocabulary_entries_lexeme_lemma_fk references: an entry's
    // copied lemma must be its lexeme's. Redundant as a uniqueness rule (id is the
    // primary key), required by Postgres as a foreign-key target.
    unique('dict_lexemes_id_lemma_key').on(t.id, t.lemma),
  ],
```

In `vocabularyEntries`, add the column after `lexemeId`:

```ts
    lexemeId: text('lexeme_id').notNull(),
    // Phase 21. The lexeme's lemma, copied at save time. The saved list groups by
    // it, and the copy is what keeps that list as cheap as phase 20's: joining
    // dict_lexemes at read time measured 98.6 ms against a 50 ms budget (spec §1).
    // vocabulary_entries_lexeme_lemma_fk keeps it equal to the lexeme's.
    lemma: text('lemma').notNull(),
```

Replace the `vocabulary_entries_lexeme_fk` foreign key and the index:

```ts
    foreignKey({
      name: 'vocabulary_entries_lexeme_lemma_fk',
      columns: [t.lexemeId, t.lemma],
      foreignColumns: [dictLexemes.id, dictLexemes.lemma],
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
```

```ts
    // Every read is scoped to one enrollment, which is what keeps the table's
    // total size irrelevant. Phase 21 reads by lemma: the list's GROUP BY lemma /
    // max(created_at), the summaries' counts, and the detail's saved entries.
    index('vocabulary_entries_enrollment_lemma_idx').on(t.enrollmentId, t.lemma, t.createdAt),
```

Update the comment on the old index accordingly (it is gone), and nothing else in the file.

- [ ] **Step 5: Generate the migration, then write its body by hand**

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm run db:generate --workspace apps/server -- --name vocabulary_entries_lemma`
Expected: a new `apps/server/src/db/migrations/0013_vocabulary_entries_lemma.sql`, `meta/0013_snapshot.json`, and a new entry in `meta/_journal.json`.

drizzle-kit adds a NOT NULL column in one statement, which fails on a table with rows. Replace the whole body of `0013_vocabulary_entries_lemma.sql` with:

```sql
-- Phase 21. The saved list groups by lemma, so each entry carries its lexeme's
-- lemma. Added nullable, backfilled from dict_lexemes, then made NOT NULL, so
-- existing entries survive. The composite foreign key keeps the copy equal to
-- the lexeme's lemma, and cascades a rewrite of it; nothing rewrites one today.
-- The lexeme index is replaced by a lemma index: its two readers now read by
-- lemma. Both indexes are built inside the migration transaction.
ALTER TABLE "vocabulary_entries" DROP CONSTRAINT "vocabulary_entries_lexeme_fk";--> statement-breakpoint
DROP INDEX "vocabulary_entries_enrollment_lexeme_idx";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD COLUMN "lemma" text;--> statement-breakpoint
UPDATE "vocabulary_entries" ve SET "lemma" = l."lemma" FROM "dict_lexemes" l WHERE l."id" = ve."lexeme_id";--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ALTER COLUMN "lemma" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "dict_lexemes" ADD CONSTRAINT "dict_lexemes_id_lemma_key" UNIQUE("id","lemma");--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD CONSTRAINT "vocabulary_entries_lexeme_lemma_fk" FOREIGN KEY ("lexeme_id","lemma") REFERENCES "public"."dict_lexemes"("id","lemma") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "vocabulary_entries_enrollment_lemma_idx" ON "vocabulary_entries" USING btree ("enrollment_id","lemma","created_at");
```

Then confirm the snapshot still matches the schema, the same way CI does:

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm run db:check -w apps/server && npm run db:generate -w apps/server && git status --porcelain apps/server/src/db/migrations`
Expected: `db:check` passes, the second `db:generate` reports nothing to generate, and `git status` lists only the three new or changed files from the first generate (the `.sql`, `meta/0013_snapshot.json`, `meta/_journal.json`). A fourth file means schema.ts and the snapshot disagree; fix schema.ts, delete the extra file, and repeat.

- [ ] **Step 6: Run the two test files and watch them pass**

Run: `export PATH="/opt/homebrew/bin:$PATH"; bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/db/vocabulary.schema.test.ts tests/integration/db/migrations.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing repository tests for save**

In `apps/server/tests/integration/repo/vocabulary.test.ts`:

The first `findSaveable` test now expects the lemma:

```ts
  it('passes a pair whose form renders the sense in the source language, with its lexeme and lemma', async () => {
    expect(await ask([pair(TOY, KITES)])).toEqual([{ ...pair(TOY, KITES), lexemeId: kite.lexemeId, lemma: 'kite' }]);
  });
```

The `entry` helper in `describe('insertEntries and deleteEntry')` carries it:

```ts
  const entry = (sense: number, variant: number) => ({ ...pair(sense, variant), lexemeId: kite.lexemeId, lemma: 'kite' });
```

Add, in the same describe:

```ts
  it("writes the lexeme's lemma onto the entry", async () => {
    await repo((r) => r.insertEntries({ enrollmentId: E, entries: [entry(TOY, KITES)] }));
    const rows = await t.db.execute<{ lemma: string }>(
      sql`select lemma from vocabulary_entries where enrollment_id = ${E}`,
    );
    expect(rows.rows).toEqual([{ lemma: 'kite' }]);
  });
```

The `saveAt` helper inserts directly, so it must supply the lemma too. Read it from the lexeme, so the helper's signature stays the same:

```ts
async function saveAt(lexemeId: string, senseId: string, variantId: string, at: string) {
  await t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id, created_at)
    values (${E}, ${senseId}, ${lexemeId}, (select lemma from dict_lexemes where id = ${lexemeId}),
            ${variantId}, ${at}::timestamptz)`);
  // An entry with no progress rows has no level, and the list leaves it out.
  await insertProgressRows(t.db, E, [senseId]);
}
```

- [ ] **Step 8: Run it and watch it fail**

Run: `export PATH="/opt/homebrew/bin:$PATH"; bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/repo/vocabulary.test.ts`
Expected: FAIL. `findSaveable` returns no `lemma`; `insertEntries` violates the NOT NULL on `lemma`; the TypeScript in `entry` is accepted by Jest's Babel transform, so the failures are runtime ones.

- [ ] **Step 9: Make save write the lemma**

In `apps/server/src/repo/vocabulary.ts`:

```ts
/** A pair that passed `findSaveable`, carrying the lexeme id and lemma the entry copies. */
export type SaveableEntry = { senseId: string; variantId: string; lexemeId: string; lemma: string };
```

In `vocabularyQueries.insertEntries`, insert the lemma:

```ts
      INSERT INTO vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id)
      VALUES ${sql.join(
        input.entries.map(
          (e) => sql`(${input.enrollmentId}, ${e.senseId}, ${e.lexemeId}, ${e.lemma}, ${e.variantId})`,
        ),
        sql`, `,
      )}
```

In `vocabularyQueries.saveable`, select it:

```ts
    SELECT s.id AS sense_id, v.id AS variant_id, l.id AS lexeme_id, l.lemma
```

In `findSaveable`, map it:

```ts
      const rows = await tx.execute<{ sense_id: string; variant_id: string; lexeme_id: string; lemma: string }>(
        vocabularyQueries.saveable(input),
      );
      return rows.rows.map((row) => ({
        senseId: row.sense_id,
        variantId: row.variant_id,
        lexemeId: row.lexeme_id,
        lemma: row.lemma,
      }));
```

`services/vocabulary.ts` passes `findSaveable`'s rows straight to `insertEntries`, so it needs no change.

- [ ] **Step 10: Update every other writer of entries**

`apps/server/tests/support/vocabularyRows.ts`, in `seedSavedSenses`:

```ts
      entries: word.senseIds.map((senseId) => ({ senseId, variantId, lexemeId: word.lexemeId, lemma: input.lemma })),
```

`apps/server/tests/support/progressRows.ts`, in `saveSessionSenses`: join the lexeme and select its lemma. Add `dictLexemes` to the existing import from `'../../src/db/schema'`.

```ts
  const rows = await db
    .select({
      position: sessionQuestions.position,
      senseId: questions.senseId,
      variantId: questions.promptVariantId,
      lexemeId: dictVariants.lexemeId,
      lemma: dictLexemes.lemma,
    })
    .from(sessionQuestions)
    .innerJoin(questions, eq(questions.id, sessionQuestions.questionId))
    .innerJoin(dictVariants, eq(dictVariants.id, questions.promptVariantId))
    .innerJoin(dictLexemes, eq(dictLexemes.id, dictVariants.lexemeId))
    .where(eq(sessionQuestions.sessionId, input.sessionId))
    .orderBy(asc(sessionQuestions.position));
  const picked = rows.filter((row) => input.positions.includes(row.position));
  await withTx(db, (tx) =>
    createVocabularyRepo(tx).insertEntries({
      enrollmentId: input.enrollmentId,
      entries: picked.map(({ senseId, variantId, lexemeId, lemma }) => ({ senseId, variantId, lexemeId, lemma })),
    }),
  );
```

Three test files insert entries with raw SQL. In each, add the `lemma` column and read its value from the lexeme with a scalar subquery, exactly as `saveAt` does in Step 7:

- `apps/server/tests/integration/db/progress.schema.test.ts`, the insert in `beforeEach`:
  ```ts
  await t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id)
    values (${E}, ${senseId}, ${kite.lexemeId}, (select lemma from dict_lexemes where id = ${kite.lexemeId}),
            ${kite.variantIds[0]})`);
  ```
- `apps/server/tests/integration/db/progressRecompute.test.ts`, in `savedAt`:
  ```ts
  await t.db.execute(sql`
    insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id, created_at)
    values (${E}, ${kite.senseIds[0]}, ${kite.lexemeId}, (select lemma from dict_lexemes where id = ${kite.lexemeId}),
            ${kite.variantIds[0]}, ${at}::timestamptz)`);
  ```
- `apps/server/tests/integration/repo/progress.test.ts`, in `saveAt`:
  ```ts
    await t.db.execute(sql`
      insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id, created_at)
      values (${E}, ${kite.senseIds[i]}, ${kite.lexemeId}, (select lemma from dict_lexemes where id = ${kite.lexemeId}),
              ${kite.variantIds[0]}, ${at}::timestamptz)`);
  ```

`apps/server/tests/integration/repo/vocabulary.plan.test.ts`: the two fixture inserts write the lemma. Lexeme `'pl' || s` has lemma `'слово' || s`, so:

```ts
    `insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id, created_at)
       select 'pe' || e, 'ps' || s, 'pl' || s, 'слово' || s, 'pv' || s, now() - (s || ' seconds')::interval
       from generate_series(2, 1000) e, generate_series(1, 200) s`,
    `insert into vocabulary_entries (enrollment_id, sense_id, lexeme_id, lemma, variant_id, created_at)
       select '${HEAVY}', 'ps' || s, 'pl' || s, 'слово' || s, 'pv' || s, now() - (s || ' seconds')::interval
       from generate_series(1, 20000) s`,
```

and the `insertEntries` case gives its entry a lemma:

```ts
      entries: [{ senseId: 'ps300', lexemeId: 'pl300', lemma: 'слово300', variantId: 'pv300' }],
```

Then confirm nothing else writes entries:

Run: `grep -rn "insert into vocabulary_entries\|insertEntries(" apps/server/src apps/server/tests`
Expected: every hit is one of the places above, `repo/vocabulary.ts` itself, or `services/vocabulary.ts`.

- [ ] **Step 11: Run every gate**

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm run typecheck && npm test && npm run test:all && npm run lint:arch`
Expected: all pass. `test:all` includes every integration file, including the plan test and the three progress tests.

- [ ] **Step 12: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/db/migrations apps/server/src/repo/vocabulary.ts apps/server/tests
git commit -m "feat(server): each saved entry carries its lexeme's lemma, pinned by a composite foreign key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The word detail by lemma

The detail route becomes `GET /enrollments/{id}/vocabulary/word?lemma=` and shows every sense of every lexeme with that lemma in the target language, each labelled with its part of speech. The app's detail screen moves to `/vocabulary/word?lemma=`. The list still has one row per lexeme at the end of this task; its rows navigate by lemma.

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `packages/core/src/api/types.ts`, `packages/core/src/api/index.ts`
- Modify: `apps/server/src/errors.ts`, `apps/server/src/domain/vocabulary.ts`, `apps/server/src/repo/vocabulary.ts`, `apps/server/src/services/vocabulary.ts`, `apps/server/src/routes/vocabulary.ts`
- Modify: `apps/mobile/src/api/client.ts`, `apps/mobile/src/hooks/useVocabulary.tsx`, `apps/mobile/src/app/vocabulary/index.tsx`
- Rename and modify: `apps/mobile/src/app/vocabulary/[lexemeId].tsx` → `apps/mobile/src/app/vocabulary/word.tsx`
- Test: `apps/server/src/domain/vocabulary.test.ts`, `apps/server/src/openapi.test.ts`, `apps/server/src/services/sessions.test.ts`, `apps/server/tests/integration/repo/vocabulary.test.ts`, `apps/server/tests/integration/routes/vocabulary.test.ts`, `apps/server/tests/integration/repo/vocabulary.plan.test.ts`, `apps/mobile/src/api/client.test.ts`, `apps/mobile/src/vocabulary.test.ts`

**Interfaces:**
- Consumes: `vocabulary_entries.lemma` and `vocabulary_entries_enrollment_lemma_idx` (Task 1).
- Produces, in `packages/core`: `VocabularyWordQuerySchema = z.object({ lemma: z.string().min(1) })` and type `VocabularyWordQuery`; `VocabularySenseSchema` gains `part_of_speech: z.string()`; `VocabularyWordDetailSchema` is `{ lemma, level: Level | null, senses }`.
- Produces, in `domain/vocabulary.ts`: `type WordLexeme = { lexemeId: string; partOfSpeech: string }`; `LexemeRendering` gains `lexemeId: string`; `buildWordDetail(lemma: string, lexemes: WordLexeme[], renderings: LexemeRendering[], saved: SavedEntry[], progress: ProgressRow[]): VocabularyWordDetail`. `LexemeRow` is deleted.
- Produces, in `repo/vocabulary.ts`: `vocabularyQueries.lemmaLexemes({ languageCode, lemma })`, `vocabularyQueries.lemmaRenderings({ languageCode, lemma, userLanguageCode })`, `vocabularyQueries.savedInLemma({ enrollmentId, lemma })`, and repo methods `findLemmaLexemes(...) → WordLexeme[]`, `findLemmaRenderings(...) → LexemeRendering[]`, `findSavedInLemma(...) → SavedEntry[]`. `lexemeRenderings`, `savedInLexeme`, `findLexeme`, `findLexemeRenderings` and `findSavedInLexeme` are deleted.
- Produces, in `errors.ts`: `class WordNotFound extends Error { constructor(readonly lemma: string) }`. `LexemeNotFound` is deleted.
- Produces, in the app: `api.vocabularyWord(enrollmentId: string, lemma: string)`, `loadWord(lemma: string)`, and the route `/vocabulary/word` with search param `lemma`.

- [ ] **Step 1: Change the wire contract**

In `packages/core/src/api/schemas.ts`, replace `VocabularySenseSchema` and `VocabularyWordDetailSchema`, and add the query schema after them:

```ts
// One sense in the drill-down. `variant_id` and `form` name the rendering shown:
// the saved form for a saved sense, a representative one otherwise. Saving from
// the drill-down records that variant.
export const VocabularySenseSchema = z.object({
  sense_id: z.string(),
  variant_id: z.string(),
  form: z.string(),
  translation: z.string(),
  // Phase 21. The detail spans every lexeme of a lemma, so each sense names its own.
  part_of_speech: z.string(),
  example: z.object({ source: z.string(), target: z.string() }).optional(),
  saved: z.boolean(),
  // Phase 20. Present on a saved sense only: its badge and five levels.
  progress: SenseProgressSchema.optional(),
});

// Phase 21. One word is every lexeme with this lemma in the enrollment's target
// language.
export const VocabularyWordDetailSchema = z.object({
  lemma: z.string(),
  // Phase 20. The word's badge, as on the list; null when nothing is saved.
  level: LevelSchema.nullable(),
  senses: z.array(VocabularySenseSchema),
});

// Phase 21. A query parameter rather than a path segment: a lemma may hold a
// space or a slash. Matched exactly.
export const VocabularyWordQuerySchema = z.object({
  lemma: z.string().min(1),
});
```

In `types.ts`, import `VocabularyWordQuerySchema` and add `export type VocabularyWordQuery = z.infer<typeof VocabularyWordQuerySchema>;` beside `VocabularyWordDetail`. In `index.ts`, add `VocabularyWordQuery` to the type re-exports.

- [ ] **Step 2: Write the failing domain tests**

In `apps/server/src/domain/vocabulary.test.ts`, replace everything from `const rendering = …` through the end of `describe('buildWordDetail', …)` with the block below. It keeps every phase 18 and phase 20 case, adapted to the new signature, and adds the multi-lexeme cases.

```ts
const rendering = (over: Partial<LexemeRendering>): LexemeRendering => ({
  lexemeId: 'lx',
  senseId: 's1',
  variantId: 'v1',
  form: 'прочитать',
  rank: 0,
  translation: 'לקרוא',
  exampleSource: null,
  exampleTarget: null,
  ...over,
});

const LEMMA = 'прочитать';
const VERB: WordLexeme[] = [{ lexemeId: 'lx', partOfSpeech: 'verb' }];

describe('buildWordDetail', () => {
  it("shows a saved sense in the form it was saved from, even when the lemma's form renders it", () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        rendering({ variantId: 'v-lemma', form: 'прочитать', translation: 'לקרוא' }),
        rendering({ variantId: 'v-past', form: 'прочитала', translation: 'קראה' }),
      ],
      [{ senseId: 's1', variantId: 'v-past' }],
      [],
    );
    expect(detail.senses).toEqual([
      { sense_id: 's1', variant_id: 'v-past', form: 'прочитала', translation: 'קראה', part_of_speech: 'verb', saved: true },
    ]);
  });

  it("shows an unsaved sense in the lemma's own form when one exists", () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        rendering({ variantId: 'v-past', form: 'прочитала', translation: 'קראה' }),
        rendering({ variantId: 'v-lemma', form: 'Прочитать', translation: 'לקרוא' }),
      ],
      [],
      [],
    );
    expect(detail.senses[0]).toMatchObject({ variant_id: 'v-lemma', saved: false });
  });

  it('otherwise uses the form that renders the most of this lexeme, ties by variant id', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        rendering({ senseId: 's1', variantId: 'v-b', form: 'прочитаю' }),
        rendering({ senseId: 's2', variantId: 'v-b', form: 'прочитаю', rank: 1 }),
        rendering({ senseId: 's1', variantId: 'v-a', form: 'прочитала' }),
        rendering({ senseId: 's3', variantId: 'v-c', form: 'прочитал', rank: 2 }),
        rendering({ senseId: 's3', variantId: 'v-d', form: 'прочитали', rank: 2 }),
      ],
      [],
      [],
    );
    const shown = Object.fromEntries(detail.senses.map((s) => [s.sense_id, s.variant_id]));
    expect(shown).toEqual({ s1: 'v-b', s2: 'v-b', s3: 'v-c' });
  });

  // Review Focus 3 of phase 18: the saved form no longer renders the sense.
  it('falls back to the representative rendering when the saved form no longer renders the sense', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [rendering({ variantId: 'v-lemma', form: 'прочитать' })],
      [{ senseId: 's1', variantId: 'v-gone' }],
      [],
    );
    expect(detail.senses).toEqual([
      expect.objectContaining({ sense_id: 's1', variant_id: 'v-lemma', saved: true }),
    ]);
  });

  it('orders saved senses first, each group by rank, then by sense id', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        rendering({ senseId: 's-a', rank: 0 }),
        rendering({ senseId: 's-b', rank: 2 }),
        rendering({ senseId: 's-c', rank: 1 }),
        rendering({ senseId: 's-d', rank: 1 }),
      ],
      [{ senseId: 's-b', variantId: 'v1' }],
      [],
    );
    expect(detail.senses.map((s) => s.sense_id)).toEqual(['s-b', 's-a', 's-c', 's-d']);
  });

  it('carries an example only when both halves are present', () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [
        rendering({ senseId: 's1', exampleSource: 'Я прочитала книгу.', exampleTarget: 'קראתי את הספר.' }),
        rendering({ senseId: 's2', rank: 1, exampleSource: 'half', exampleTarget: null }),
      ],
      [],
      [],
    );
    expect(detail.senses[0].example).toEqual({
      source: 'Я прочитала книгу.',
      target: 'קראתי את הספר.',
    });
    expect(detail.senses[1]).not.toHaveProperty('example');
  });

  it('carries the lemma, and no lexeme fields', () => {
    expect(buildWordDetail(LEMMA, VERB, [], [], [])).toEqual({ lemma: LEMMA, level: null, senses: [] });
  });

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
      LEMMA,
      VERB,
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

  it("gives the word one flat mean over every saved sense's live-dimension levels, rounded once, ties up", () => {
    const detail = buildWordDetail(
      LEMMA,
      VERB,
      [rendering({ senseId: 's1' }), rendering({ senseId: 's2' })],
      [{ senseId: 's1', variantId: 'v1' }, { senseId: 's2', variantId: 'v1' }],
      [...levels('s1', 2), ...levels('s2', 3)],
    );
    expect(detail.level).toBe(3);
  });

  it('gives a word with nothing saved no level', () => {
    expect(buildWordDetail(LEMMA, VERB, [rendering({})], [], []).level).toBeNull();
  });

  describe('a lemma with two lexemes', () => {
    // знать: the verb (to know) and the noun (nobility). Ids chosen so that sense
    // id order and part-of-speech order disagree, which the ordering must survive.
    const ZNAT: WordLexeme[] = [
      { lexemeId: 'lx-noun', partOfSpeech: 'noun' },
      { lexemeId: 'lx-verb', partOfSpeech: 'verb' },
    ];
    const verb = (over: Partial<LexemeRendering>) =>
      rendering({ lexemeId: 'lx-verb', variantId: 'v-verb', form: 'знать', translation: 'לדעת', ...over });
    const noun = (over: Partial<LexemeRendering>) =>
      rendering({ lexemeId: 'lx-noun', variantId: 'v-noun', form: 'знать', translation: 'אצולה', ...over });

    it('shows every sense of both, each with its own part of speech', () => {
      const detail = buildWordDetail('знать', ZNAT, [verb({ senseId: 'a-know' }), noun({ senseId: 'z-nobility' })], [], []);
      expect(detail.senses.map((s) => [s.sense_id, s.part_of_speech])).toEqual([
        ['z-nobility', 'noun'],
        ['a-know', 'verb'],
      ]);
    });

    it('orders saved first, then by part of speech, then by rank, then by sense id', () => {
      const detail = buildWordDetail(
        'знать',
        ZNAT,
        [
          verb({ senseId: 'v1', rank: 0 }),
          verb({ senseId: 'v2', rank: 1, translation: 'להכיר' }),
          noun({ senseId: 'n1', rank: 0 }),
          noun({ senseId: 'n2', rank: 1, translation: 'עילית' }),
        ],
        [{ senseId: 'v2', variantId: 'v-verb' }, { senseId: 'n2', variantId: 'v-noun' }],
        [],
      );
      expect(detail.senses.map((s) => s.sense_id)).toEqual(['n2', 'v2', 'n1', 'v1']);
    });

    it("labels a saved sense with its lexeme's part of speech, not the saved form's neighbours'", () => {
      // Both lexemes have a form spelled знать; the saved noun sense must still read
      // as a noun even though the verb's sense sorts beside it.
      const detail = buildWordDetail(
        'знать',
        ZNAT,
        [verb({ senseId: 'v1' }), noun({ senseId: 'n1' })],
        [{ senseId: 'n1', variantId: 'v-noun' }],
        [],
      );
      expect(detail.senses.map((s) => [s.sense_id, s.part_of_speech, s.saved])).toEqual([
        ['n1', 'noun', true],
        ['v1', 'verb', false],
      ]);
    });

    it("averages the word's level over the saved senses of both lexemes", () => {
      const detail = buildWordDetail(
        'знать',
        ZNAT,
        [verb({ senseId: 'v1' }), noun({ senseId: 'n1' })],
        [{ senseId: 'v1', variantId: 'v-verb' }, { senseId: 'n1', variantId: 'v-noun' }],
        [...levels('v1', 5), ...levels('n1', 2)],
      );
      expect(detail.level).toBe(4);
    });
  });
});
```

Update the import at the top of the file to add `type WordLexeme`.

- [ ] **Step 3: Run it and watch it fail**

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm test -w apps/server -- src/domain/vocabulary.test.ts`
Expected: FAIL. `buildWordDetail` still takes a `LexemeRow`, so every case reports a wrong shape or a thrown error; `WordLexeme` is not exported.

- [ ] **Step 4: Rewrite `buildWordDetail`**

In `apps/server/src/domain/vocabulary.ts`, delete `LexemeRow` and replace it, `LexemeRendering` and `buildWordDetail`:

```ts
/** One lexeme of the word: the detail spans every lexeme with the lemma. */
export type WordLexeme = { lexemeId: string; partOfSpeech: string };

/** One rendering of one of the word's senses, by one form of that sense's own
 *  lexeme, in the enrollment's source language. */
export type LexemeRendering = {
  lexemeId: string;
  senseId: string;
  variantId: string;
  form: string;
  rank: number;
  translation: string;
  exampleSource: string | null;
  exampleTarget: string | null;
};
```

```ts
/**
 * The drill-down: every sense of every lexeme with this lemma that the enrollment's
 * source language can show, each in one rendering and labelled with its part of
 * speech. Saved senses first, then by part of speech, then by rank, then by sense id.
 *
 * Which rendering:
 * - a saved sense is shown in its saved form;
 * - an unsaved one in a representative form — the lemma's own spelling if anyone
 *   looked it up, otherwise the form that renders the most senses, ties broken by
 *   variant id. A form belongs to one lexeme and a sense's renderings are all forms
 *   of its own lexeme, so the choice is always made within that lexeme.
 *
 * A saved sense whose saved form no longer renders it falls back to the
 * representative and stays saved. Ranks compared across forms are approximate —
 * rank is per form — and that is accepted: it orders a short list, it ranks
 * nothing that is stored.
 *
 * Phase 20: a saved sense carries its five levels; the word carries the rounded
 * mean over every saved sense's live dimensions, the same number the list
 * shows, or null when nothing is saved. `progress` holds the rows of every
 * saved sense, including one with no rendering to show.
 */
export function buildWordDetail(
  lemma: string,
  lexemes: WordLexeme[],
  renderings: LexemeRendering[],
  saved: SavedEntry[],
  progress: ProgressRow[],
): VocabularyWordDetail {
  const partOfSpeech = new Map(lexemes.map((lexeme) => [lexeme.lexemeId, lexeme.partOfSpeech]));
  const savedVariant = new Map(saved.map((entry) => [entry.senseId, entry.variantId]));
  const perVariant = new Map<string, number>();
  for (const r of renderings) perVariant.set(r.variantId, (perVariant.get(r.variantId) ?? 0) + 1);

  const lowered = lemma.toLowerCase();
  const isLemma = (r: LexemeRendering) => Number(r.form.toLowerCase() === lowered);
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
    const rendering = options.find((o) => o.variantId === own) ?? [...options].sort(better)[0];
    return {
      rendering,
      partOfSpeech: partOfSpeech.get(rendering.lexemeId) ?? '',
      saved: savedVariant.has(senseId),
    };
  });

  shown.sort(
    (a, b) =>
      Number(b.saved) - Number(a.saved) ||
      (a.partOfSpeech < b.partOfSpeech ? -1 : a.partOfSpeech > b.partOfSpeech ? 1 : 0) ||
      a.rendering.rank - b.rendering.rank ||
      a.rendering.senseId.localeCompare(b.rendering.senseId),
  );

  const progressBySense = new Map<string, ProgressRow[]>();
  for (const row of progress) {
    progressBySense.set(row.senseId, [...(progressBySense.get(row.senseId) ?? []), row]);
  }
  const live = progress.filter((row) => LIVE_DIMENSIONS.includes(row.dimension));

  return {
    lemma,
    level: live.length === 0 ? null : badge(live.map((row) => row.level)),
    senses: shown.map(({ rendering: r, partOfSpeech: pos, saved: isSaved }) => ({
      sense_id: r.senseId,
      variant_id: r.variantId,
      form: r.form,
      translation: r.translation,
      part_of_speech: pos,
      ...(r.exampleSource && r.exampleTarget
        ? { example: { source: r.exampleSource, target: r.exampleTarget } }
        : {}),
      saved: isSaved,
      ...(isSaved && progressBySense.has(r.senseId)
        ? { progress: senseProgressOf(progressBySense.get(r.senseId)!) }
        : {}),
    })),
  };
}
```

Part-of-speech codes are compared with `<`, not `localeCompare`, so the order is the codes' byte order on every machine. The renderings query always returns a lexeme id that is in `lexemes`, so the `?? ''` only guards a broken fixture.

- [ ] **Step 5: Run the domain test and watch it pass**

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm test -w apps/server -- src/domain/vocabulary.test.ts`
Expected: PASS. `npm run typecheck` still fails at this point, in `services/vocabulary.ts` and `repo/vocabulary.ts`; the next steps fix them.

- [ ] **Step 6: Write the failing repository tests for the lemma reads**

In `apps/server/tests/integration/repo/vocabulary.test.ts`, replace `describe('the drill-down reads', …)` with:

```ts
describe('the drill-down reads', () => {
  // A second `kite` lexeme, a verb, so a lemma spans two lexemes. Its form is also
  // `kite`, so it takes entry rank 1 (dict_variants_form_entry_rank_key).
  let kiteVerb: { lexemeId: string; variantIds: string[]; senseIds: string[] };
  beforeEach(async () => {
    kiteVerb = await insertLexeme(t.db, {
      lemma: 'kite',
      languageCode: 'en',
      partOfSpeech: 'verb',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'fly' }],
      variants: [
        {
          form: 'kite',
          kind: 'word',
          entryRank: 1,
          translations: [
            { senseCode: 'fly', rank: 0, translation: 'להטיס עפיפון', exampleSource: null, exampleTarget: null },
          ],
        },
      ],
    });
  });

  it('finds every lexeme of a lemma in one language, by part of speech', async () => {
    expect(await repo((r) => r.findLemmaLexemes({ languageCode: 'en', lemma: 'kite' }))).toEqual([
      { lexemeId: kite.lexemeId, partOfSpeech: 'noun' },
      { lexemeId: kiteVerb.lexemeId, partOfSpeech: 'verb' },
    ]);
    expect(await repo((r) => r.findLemmaLexemes({ languageCode: 'he', lemma: 'kite' }))).toEqual([]);
  });

  // Review Focus 2: lemmas match exactly.
  it('matches the lemma exactly, case included', async () => {
    expect(await repo((r) => r.findLemmaLexemes({ languageCode: 'en', lemma: 'Kite' }))).toEqual([]);
  });

  it("returns every rendering of every lexeme's senses in one language, with its lexeme", async () => {
    const rows = await repo((r) =>
      r.findLemmaRenderings({ languageCode: 'en', lemma: 'kite', userLanguageCode: 'he' }),
    );
    expect(rows.map((row) => `${row.lexemeId === kite.lexemeId ? 'noun' : 'verb'}:${row.form}:${row.translation}`).sort()).toEqual([
      'noun:kite:דיה',
      'noun:kite:עפיפון',
      'noun:kites:עפיפונים',
      'verb:kite:להטיס עפיפון',
    ]);
    expect(
      await repo((r) => r.findLemmaRenderings({ languageCode: 'en', lemma: 'kite', userLanguageCode: 'ru' })),
    ).toEqual([]);
  });

  it("finds the enrollment's saved entries across the lemma's lexemes", async () => {
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITES], '2026-10-04 12:00:00+00');
    await saveAt(kiteVerb.lexemeId, kiteVerb.senseIds[0], kiteVerb.variantIds[0], '2026-10-04 12:00:01+00');
    const saved = await repo((r) => r.findSavedInLemma({ enrollmentId: E, lemma: 'kite' }));
    expect(saved.sort((a, b) => a.senseId.localeCompare(b.senseId))).toEqual(
      [
        pair(TOY, KITES),
        { senseId: kiteVerb.senseIds[0], variantId: kiteVerb.variantIds[0] },
      ].sort((a, b) => a.senseId.localeCompare(b.senseId)),
    );
    expect(await repo((r) => r.findSavedInLemma({ enrollmentId: E, lemma: 'fly' }))).toEqual([]);
  });
});
```

Two existing tests call `findSavedInLexeme`. Replace each call with `findSavedInLemma`:

- in `'keeps the first form when the same sense is saved again'`:
  `expect(await repo((r) => r.findSavedInLemma({ enrollmentId: E, lemma: 'kite' }))).toEqual([pair(TOY, KITES)]);`
- in `describe('a repaired variant')`:
  `expect(await repo((r) => r.findSavedInLemma({ enrollmentId: E, lemma: 'kite' }))).toEqual([pair(TOY, KITES)]);`

- [ ] **Step 7: Replace the drill-down reads in the repository**

In `apps/server/src/repo/vocabulary.ts`, delete `vocabularyQueries.lexemeRenderings` and `vocabularyQueries.savedInLexeme`, and add:

```ts
  /** Every lexeme with this lemma in one language, through
   *  dict_lexemes_language_lemma_pos_key. Exact match, case included. */
  lemmaLexemes: (input: { languageCode: string; lemma: string }): SQL => sql`
    SELECT id AS lexeme_id, part_of_speech FROM dict_lexemes
    WHERE language_code = ${input.languageCode}
      AND lemma = ${input.lemma}
    ORDER BY part_of_speech`,

  /** Every rendering of the senses of every lexeme with this lemma, in one user
   *  language, by any form, each with its lexeme. */
  lemmaRenderings: (input: { languageCode: string; lemma: string; userLanguageCode: string }): SQL => sql`
    SELECT s.lexeme_id, tr.sense_id, tr.variant_id, v.form, tr.rank, tr.translation,
           tr.example_source, tr.example_target
    FROM dict_lexemes l
    JOIN dict_senses s            ON s.lexeme_id = l.id
    JOIN dict_var_translations tr ON tr.sense_id = s.id
                                 AND tr.user_language_code = ${input.userLanguageCode}
    JOIN dict_variants v          ON v.id = tr.variant_id
    WHERE l.language_code = ${input.languageCode}
      AND l.lemma = ${input.lemma}`,

  /** One lemma's saved senses in one enrollment, through
   *  vocabulary_entries_enrollment_lemma_idx. */
  savedInLemma: (input: { enrollmentId: string; lemma: string }): SQL => sql`
    SELECT sense_id, variant_id FROM vocabulary_entries
    WHERE enrollment_id = ${input.enrollmentId}
      AND lemma = ${input.lemma}`,
```

In `createVocabularyRepo`, delete `findLexeme`, `findLexemeRenderings` and `findSavedInLexeme`, and add:

```ts
    findLemmaLexemes: async (input: { languageCode: string; lemma: string }): Promise<WordLexeme[]> => {
      const rows = await tx.execute<{ lexeme_id: string; part_of_speech: string }>(
        vocabularyQueries.lemmaLexemes(input),
      );
      return rows.rows.map((row) => ({ lexemeId: row.lexeme_id, partOfSpeech: row.part_of_speech }));
    },

    findLemmaRenderings: async (input: {
      languageCode: string;
      lemma: string;
      userLanguageCode: string;
    }): Promise<LexemeRendering[]> => {
      const rows = await tx.execute<{
        lexeme_id: string;
        sense_id: string;
        variant_id: string;
        form: string;
        rank: number;
        translation: string;
        example_source: string | null;
        example_target: string | null;
      }>(vocabularyQueries.lemmaRenderings(input));
      return rows.rows.map((row) => ({
        lexemeId: row.lexeme_id,
        senseId: row.sense_id,
        variantId: row.variant_id,
        form: row.form,
        rank: row.rank,
        translation: row.translation,
        exampleSource: row.example_source,
        exampleTarget: row.example_target,
      }));
    },

    findSavedInLemma: async (input: { enrollmentId: string; lemma: string }): Promise<SavedEntry[]> => {
      const rows = await tx.execute<{ sense_id: string; variant_id: string }>(
        vocabularyQueries.savedInLemma(input),
      );
      return rows.rows.map((row) => ({ senseId: row.sense_id, variantId: row.variant_id }));
    },
```

Fix the imports: drop `LexemeRow` from the domain import, add `WordLexeme`. Drop `dictLexemes` from the schema import if nothing else uses it (keep `vocabularyEntries`, which `listSavedSenses` uses), and drop `asc`/`eq` only if they become unused.

- [ ] **Step 8: Replace the error and the service use case**

In `apps/server/src/errors.ts`, replace `LexemeNotFound`:

```ts
/** Phase 21. No lexeme with this lemma in the enrollment's target language. */
export class WordNotFound extends Error {
  constructor(readonly lemma: string) {
    super(`no word ${lemma}`);
    this.name = 'WordNotFound';
  }
}
```

In `apps/server/src/services/vocabulary.ts`, import `WordNotFound` instead of `LexemeNotFound`, and replace `wordDetail`:

```ts
    /** Every lexeme with this lemma in the target language is one word. None is a
     *  404; a word with nothing saved is a 200 with no level. */
    wordDetail: (enrollmentId: string, lemma: string): Promise<VocabularyWordDetail> =>
      transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
        const lexemes = await repos.vocabulary.findLemmaLexemes({
          languageCode: enrolled.target_language,
          lemma,
        });
        if (lexemes.length === 0) throw new WordNotFound(lemma);
        const renderings = await repos.vocabulary.findLemmaRenderings({
          languageCode: enrolled.target_language,
          lemma,
          userLanguageCode: enrolled.source_language,
        });
        const saved = await repos.vocabulary.findSavedInLemma({ enrollmentId, lemma });
        const progress = await repos.progress.findRows({
          enrollmentId,
          senseIds: saved.map((entry) => entry.senseId),
          savedBy: null,
        });
        return buildWordDetail(lemma, lexemes, renderings, saved, progress);
      }),
```

In `apps/server/src/services/sessions.test.ts`, the fake vocabulary repo lists every method as `forbidden`. Replace the three lines `findLexeme`, `findLexemeRenderings`, `findSavedInLexeme` with:

```ts
    findLemmaLexemes: forbidden,
    findLemmaRenderings: forbidden,
    findSavedInLemma: forbidden,
```

- [ ] **Step 9: Write the failing route tests**

In `apps/server/tests/integration/routes/vocabulary.test.ts`, add a verb helper after `russianWord`:

```ts
// A Russian verb with one sense. Its form is the lemma at entry rank 1, so it can
// share a lemma, and a form, with a noun from russianWord.
async function russianVerb(lemma: string, translation: string) {
  return insertLexeme(t.db, {
    lemma,
    languageCode: 'ru',
    partOfSpeech: 'verb',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'verb' }],
    variants: [
      {
        form: lemma,
        kind: 'word',
        entryRank: 1,
        translations: [{ senseCode: 'verb', rank: 0, translation, exampleSource: null, exampleTarget: null }],
      },
    ],
  });
}
```

Replace the `detail` helper:

```ts
const detail = (enrollmentId: string, lemma: string) =>
  app().request(`/api/enrollments/${enrollmentId}/vocabulary/word?lemma=${encodeURIComponent(lemma)}`);
```

Replace `describe('GET /api/enrollments/{id}/vocabulary/words/{lexeme_id}', …)` with:

```ts
describe('GET /api/enrollments/{id}/vocabulary/word', () => {
  type Detail = {
    lemma: string;
    level: number | null;
    senses: { sense_id: string; saved: boolean; part_of_speech: string; progress?: unknown }[];
  };

  it('lists every sense, saved first, and answers 200 once nothing is saved', async () => {
    const rama = await russianWord('рама');
    await save(RU, [{ sense_id: rama.senseIds[1], variant_id: rama.variantIds[0] }]);

    const res = await detail(RU, 'рама');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Detail;
    expect(body.lemma).toBe('рама');
    expect(body).not.toHaveProperty('lexeme_id');
    expect(body).not.toHaveProperty('part_of_speech');
    expect(body.senses.map((s) => [s.sense_id, s.saved, s.part_of_speech])).toEqual([
      [rama.senseIds[1], true, 'noun'],
      [rama.senseIds[0], false, 'noun'],
    ]);

    await unsave(RU, rama.senseIds[1]);
    expect((await detail(RU, 'рама')).status).toBe(200);
  });

  it('merges every lexeme of the lemma: saved first, then by part of speech', async () => {
    const noun = await russianWord('знать');
    const verb = await russianVerb('знать', 'לדעת');
    await save(RU, [
      { sense_id: verb.senseIds[0], variant_id: verb.variantIds[0] },
      { sense_id: noun.senseIds[1], variant_id: noun.variantIds[0] },
    ]);
    await setLevel(t.db, { enrollmentId: RU, senseId: verb.senseIds[0], level: 5 });
    await setLevel(t.db, { enrollmentId: RU, senseId: noun.senseIds[1], level: 2 });

    const body = (await (await detail(RU, 'знать')).json()) as Detail;
    expect(body.senses.map((s) => [s.sense_id, s.saved, s.part_of_speech])).toEqual([
      [noun.senseIds[1], true, 'noun'],
      [verb.senseIds[0], true, 'verb'],
      [noun.senseIds[0], false, 'noun'],
    ]);
    expect(body.level).toBe(4);
  });

  // Review Focus 1.
  it.each(['всё равно', 'и/или'])('finds a lemma that holds a space or a slash: %s', async (lemma) => {
    await russianWord(lemma);
    const res = await detail(RU, lemma);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Detail).lemma).toBe(lemma);
  });

  // Review Focus 2.
  it('matches the lemma exactly, case included', async () => {
    await russianWord('Рама');
    await russianVerb('рама', 'למסגר');
    const body = (await (await detail(RU, 'рама')).json()) as Detail;
    expect(body.senses.map((s) => s.part_of_speech)).toEqual(['verb']);
  });

  it("answers 404 for an unknown lemma and for one outside the enrollment's target", async () => {
    await russianWord('рама');
    expect((await detail(RU, 'нет')).status).toBe(404);
    const wrongLanguage = await detail('e_u_1', 'рама');
    expect(wrongLanguage.status).toBe(404);
    expect(await wrongLanguage.json()).toEqual({ error: 'word not found' });
  });

  it.each(['', '?lemma='])('answers 400 for a missing or empty lemma: "%s"', async (query) => {
    const res = await app().request(`/api/enrollments/${RU}/vocabulary/word${query}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('answers 404 for an unknown enrollment', async () => {
    await russianWord('рама');
    const res = await detail('e_nobody', 'рама');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'enrollment not found' });
  });

  it('shows a saved sense with its five levels, an unsaved one with none, and the word with its level', async () => {
    const rama = await russianWord('рама');
    await save(RU, [{ sense_id: rama.senseIds[0], variant_id: rama.variantIds[0] }]);
    await setLevel(t.db, { enrollmentId: RU, senseId: rama.senseIds[0], level: 3 });

    const body = (await (await detail(RU, 'рама')).json()) as Detail;
    expect(body.level).toBe(3);
    expect(body.senses.find((s) => s.sense_id === rama.senseIds[0])?.progress).toEqual({
      level: 3,
      dimensions: { written_receptive: 3, written_productive: 1, spoken_receptive: 1, spoken_productive: 1, spelling: 1 },
    });
    expect(body.senses.find((s) => s.sense_id === rama.senseIds[1])).not.toHaveProperty('progress');
  });

  it('gives a word with nothing saved no level', async () => {
    await russianWord('рама');
    expect(((await (await detail(RU, 'рама')).json()) as Detail).level).toBeNull();
  });
});
```

In `apps/server/src/openapi.test.ts`, replace the path `'/api/enrollments/{id}/vocabulary/words/{lexeme_id}'` in the list of thirteen paths with `'/api/enrollments/{id}/vocabulary/word'` (the list stays sorted: it sits in the same place), and replace the status row:

```ts
    [`${BASE}/word`, 'get', ['200', '400', '404']],
```

- [ ] **Step 10: Replace the detail route**

In `apps/server/src/routes/vocabulary.ts`, import `VocabularyWordQuerySchema` from `@lang-tutor/core/api/schemas` and `WordNotFound` instead of `LexemeNotFound`, and replace `detailRoute`:

```ts
const detailRoute = createRoute({
  method: 'get',
  path: `${BASE}/word`,
  tags: ['vocabulary'],
  summary: 'One word, with every sense it can show',
  description:
    "A word is every lexeme with this lemma in the enrollment's target language; the lemma is " +
    'matched exactly. Every sense of those lexemes that has a rendering in the source language is ' +
    'listed with its part of speech, saved senses first, then by part of speech. A saved sense is ' +
    'shown in the form it was saved from and carries its level in each knowledge dimension; the ' +
    'word carries its overall level, null when nothing is saved.',
  request: { params: enrollmentParams, query: VocabularyWordQuerySchema },
  responses: {
    200: json(VocabularyWordDetailSchema, 'The word, possibly with nothing saved.'),
    400: json(ErrorSchema, '`lemma` is missing or empty.'),
    404: json(
      ErrorSchema,
      "No enrollment has this id, or no word with this lemma is in the enrollment's target language.",
    ),
  },
});
```

and its handler:

```ts
  router.openapi(detailRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { lemma } = c.req.valid('query');
    try {
      return c.json(await vocabulary.wordDetail(id, lemma), 200);
    } catch (error) {
      if (error instanceof EnrollmentNotFound) return c.json({ error: 'enrollment not found' }, 404);
      if (error instanceof WordNotFound) return c.json({ error: 'word not found' }, 404);
      throw error;
    }
  });
```

- [ ] **Step 11: Pin the new reads in the plan test**

In `apps/server/tests/integration/repo/vocabulary.plan.test.ts`:

- Add `'dict_lexemes'` to `WATCHED`: the detail now looks lexemes up by lemma, and a scan of the dictionary would be the failure to catch.
- Replace the `'lexemeRenderings'` and `'savedInLexeme'` cases in the first `it.each` with:

```ts
    ['lemmaLexemes', () => vocabularyQueries.lemmaLexemes({ languageCode: 'ru', lemma: 'слово7' })],
    ['lemmaRenderings', () => vocabularyQueries.lemmaRenderings({
      languageCode: 'ru',
      lemma: 'слово7',
      userLanguageCode: 'he',
    })],
    ['savedInLemma', () => vocabularyQueries.savedInLemma({ enrollmentId: HEAVY, lemma: 'слово7' })],
```

- Add, after the `sense_progress_enrollment_dimension_idx` test:

```ts
  // The scan check alone cannot tell the lemma index from a bitmap scan of the
  // primary key's enrollment prefix, which reads the whole heavy enrollment.
  it('reads one lemma of the heavy enrollment through vocabulary_entries_enrollment_lemma_idx', async () => {
    const plan = await explain(vocabularyQueries.savedInLemma({ enrollmentId: HEAVY, lemma: 'слово7' }));
    expect(indexesUsed(plan)).toContain('vocabulary_entries_enrollment_lemma_idx');
  });
```

Before trusting that assertion, prove it can fire: temporarily change `savedInLemma`'s `AND lemma = ${input.lemma}` to `AND lemma || '' = ${input.lemma}` (which no index can serve), run the plan test, confirm this test fails, and restore the query.

- [ ] **Step 12: Run the server tests and watch them pass**

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm run typecheck -w apps/server && npm test -w apps/server && bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/repo/vocabulary.test.ts tests/integration/routes/vocabulary.test.ts tests/integration/repo/vocabulary.plan.test.ts`
Expected: PASS. If a plan-test case fails, read the plan in its output before changing anything: the fix is a query shape, never a looser assertion.

- [ ] **Step 13: Write the failing app tests**

In `apps/mobile/src/api/client.test.ts`, replace `'vocabularyWord gets one word'` with:

```ts
  // Review Focus 1: a lemma travels as an encoded query parameter.
  it.each(['ice cream', 'знать', 'и/или'])('vocabularyWord gets one word by its lemma: %s', async (lemma) => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const client = buildClient(mockFetch);
    await client.vocabularyWord('e1', lemma);
    expect(mockFetch).toHaveBeenCalledWith(
      `http://test.local/api/enrollments/e1/vocabulary/word?lemma=${encodeURIComponent(lemma)}`,
      { method: 'GET' },
    );
  });
```

In `apps/mobile/src/vocabulary.test.ts`, inside `describe('keepSenseOrder')`, give `sense` a part of speech and `detail` the new shape:

```ts
  const sense = (sense_id: string, saved: boolean, level?: number): VocabularySense => ({
    sense_id,
    variant_id: 'v1',
    form: 'прочитала',
    translation: `tr-${sense_id}`,
    part_of_speech: 'verb',
    saved,
    ...(level === undefined
      ? {}
      : {
          progress: {
            level,
            dimensions: {
              written_receptive: level,
              written_productive: 1,
              spoken_receptive: 1,
              spoken_productive: 1,
              spelling: 1,
            },
          },
        }),
  });
  const detail = (level: number | null, senses: VocabularySense[]): VocabularyWordDetail => ({
    lemma: 'прочитать',
    level,
    senses,
  });
```

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm test -w apps/mobile -- src/api/client.test.ts`
Expected: FAIL, the client still requests `/words/{id}`.

- [ ] **Step 14: Move the app to the lemma route**

`apps/mobile/src/api/client.ts`:

```ts
    vocabularyWord: (enrollmentId: string, lemma: string) =>
      getJson<VocabularyWordDetail>(`${vocabularyPath(enrollmentId)}/word?lemma=${encodeURIComponent(lemma)}`),
```

`apps/mobile/src/hooks/useVocabulary.tsx`: the type is `loadWord: (lemma: string) => Promise<VocabularyWordDetail>;`, and the implementation:

```ts
  const loadWord = useCallback(
    (lemma: string) => {
      if (!active) return Promise.reject(new Error('no active enrollment'));
      return api.vocabularyWord(active.id, lemma);
    },
    [api, active],
  );
```

Rename the screen with git so its history follows:

Run: `git mv 'apps/mobile/src/app/vocabulary/[lexemeId].tsx' apps/mobile/src/app/vocabulary/word.tsx`

In `word.tsx`:

- Read the lemma: `const { lemma } = useLocalSearchParams<{ lemma: string }>();`, and rename every other `lexemeId` in the file to `lemma` (the effect's `loadWord(lemma)` and its dependency list `[lemma, loadWord]`, and the re-read inside `request`).
- Delete the word-level part of speech under the badge:
  ```tsx
          {strings.partOfSpeech(word.part_of_speech) ? (
            <Text style={styles.meta}>{strings.partOfSpeech(word.part_of_speech)}</Text>
          ) : null}
  ```
- Label each card with its part of speech, first inside the card:
  ```tsx
            <View key={sense.sense_id} testID="vocabulary-sense" style={styles.card}>
              {strings.partOfSpeech(sense.part_of_speech) ? (
                <Text testID="vocabulary-sense-pos" style={styles.meta}>
                  {strings.partOfSpeech(sense.part_of_speech)}
                </Text>
              ) : null}
              <Text style={styles.translation}>{sense.translation}</Text>
  ```

Nothing else in the screen changes: the toggle, its optimistic flow and `keepSenseOrder` stay as they are.

In `apps/mobile/src/app/vocabulary/index.tsx`, the row navigates by lemma:

```tsx
              onPress={() => router.push({ pathname: '/vocabulary/word', params: { lemma: item.lemma } })}
```

Confirm nothing still points at the old route or the old names:

Run: `grep -rn "lexemeId\|/words/" apps/mobile/src`
Expected: no hits. (`appendPage` in `vocabulary.ts` still keys by `lexeme_id`, with an underscore, until Task 3; that is expected and the grep does not match it.)

- [ ] **Step 15: Run every gate**

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm run typecheck && npm test && npm run test:all && npm run lint:arch`
Expected: all pass.

- [ ] **Step 16: Commit**

```bash
git add packages/core apps/server apps/mobile
git commit -m "feat: the word detail is addressed by lemma and shows every part of speech of it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The list by lemma, without sorts

The list groups by lemma, its item carries the parts of speech of its saved senses, the `sort` parameter and the level orders are gone, and the app's level filter gains an "all" chip.

**Files:**
- Modify: `packages/core/src/api/schemas.ts`, `types.ts`, `index.ts`
- Modify: `apps/server/src/domain/vocabulary.ts`, `apps/server/src/repo/vocabulary.ts`, `apps/server/src/services/vocabulary.ts`, `apps/server/src/routes/vocabulary.ts`
- Modify: `apps/mobile/src/app/vocabulary/index.tsx`, `apps/mobile/src/hooks/useVocabulary.tsx`, `apps/mobile/src/api/client.ts`, `apps/mobile/src/vocabulary.ts`, `apps/mobile/src/progress.ts`, `apps/mobile/src/strings.ts`
- Test: `apps/server/src/domain/vocabulary.test.ts`, `apps/server/tests/integration/repo/vocabulary.test.ts`, `apps/server/tests/integration/routes/vocabulary.test.ts`, `apps/server/tests/integration/repo/vocabulary.plan.test.ts`, `apps/mobile/src/vocabulary.test.ts`, `apps/mobile/src/progress.test.ts`, `apps/mobile/src/api/client.test.ts`

**Interfaces:**
- Consumes: `vocabulary_entries.lemma` (Task 1); `buildWordDetail` and the detail route (Task 2), unchanged here.
- Produces, in `packages/core`: `VocabularyPageQuerySchema = { limit?, cursor?, level? }`; `VocabularyWordSchema = { lemma, parts_of_speech: string[], headline: { sense_id, translation, form }, saved_count, sense_count, level }`. `VocabularySortSchema` and `VocabularySort` are deleted.
- Produces, in `domain/vocabulary.ts`: `type VocabularyCursor = { savedAt: string; lemma: string }`; `encodeCursor(cursor)`, `decodeCursor(raw) → VocabularyCursor | null`; `type WordPageRow = { lemma: string; lastSavedAt: string; level: number }`; `cursorAfter(row: WordPageRow): VocabularyCursor`; `type WordSummary = { lemma, partsOfSpeech: string[], headlineSenseId, headlineTranslation, headlineForm, savedCount, senseCount }`; `assemblePage(rows, summaries): VocabularyWord[]`.
- Produces, in `repo/vocabulary.ts`: `findWordsPage({ enrollmentId, limit, after: VocabularyCursor | null, level: number | null, live })`, `findWordSummaries({ enrollmentId, lemmas: string[], targetLanguage, sourceLanguage })`.
- Produces, in the app: `VocabularyQuery = { level: number | null }`; `partsOfSpeechLabel(codes: string[]): string` in `vocabulary.ts`; `strings.levelAll`.

- [ ] **Step 1: Change the wire contract**

In `packages/core/src/api/schemas.ts`, delete `VocabularySortSchema` and its comment, and replace `VocabularyPageQuerySchema` and `VocabularyWordSchema`:

```ts
// Query-string values arrive as strings, hence coerce. A cursor is opaque: the
// server decodes it and answers 400 when it cannot.
export const VocabularyPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
  // Phase 20. One level only.
  level: z.coerce.number().int().min(1).max(5).optional(),
});

// Phase 21: one row per lemma. `headline` is the lowest-ranked saved sense, in
// the wording of the form it was saved from; `parts_of_speech` are its saved
// senses' parts of speech, distinct and ascending; `sense_count` counts the senses
// of every lexeme with the lemma that have some rendering in the enrollment's
// source language — what the drill-down can show.
export const VocabularyWordSchema = z.object({
  lemma: z.string(),
  parts_of_speech: z.array(z.string()),
  headline: z.object({ sense_id: z.string(), translation: z.string(), form: z.string() }),
  saved_count: z.number().int(),
  sense_count: z.number().int(),
  // Phase 20. The word's badge: the rounded mean over its saved senses and the live dimensions.
  level: LevelSchema,
});
```

Delete `VocabularySort` from `types.ts` (and `VocabularySortSchema` from its import) and from `index.ts`.

- [ ] **Step 2: Write the failing domain tests**

In `apps/server/src/domain/vocabulary.test.ts`, replace `describe('the cursor')`, `describe('cursorAfter')`, the `summary` helper and `describe('assemblePage')` with:

```ts
describe('the cursor', () => {
  const cursorOf = (savedAt: string, lemma: string) =>
    Buffer.from(JSON.stringify(['lemma', savedAt, lemma]), 'utf8').toString('base64url');
  const raw = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const cursor = { savedAt: '2026-10-04 12:00:00.123456+00', lemma: 'знать' };

  it('round-trips, as a tagged three-element array', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(JSON.parse(Buffer.from(encodeCursor(cursor), 'base64url').toString('utf8'))).toEqual([
      'lemma',
      cursor.savedAt,
      'знать',
    ]);
  });

  it('round-trips a lemma with a space and a slash', () => {
    for (const lemma of ['всё равно', 'и/или']) {
      const c = { savedAt: '2026-10-04 12:00:00+00', lemma };
      expect(decodeCursor(encodeCursor(c))).toEqual(c);
    }
  });

  it('accepts a leap day in a leap year and every offset form the server issues', () => {
    for (const savedAt of [
      '2028-02-29 23:59:59.999999+00',
      '2026-10-04 12:00:00.1-08',
      '2026-10-04 12:00:00+05:45',
      '2026-10-04 00:00:00-03:30',
    ]) {
      expect(decodeCursor(cursorOf(savedAt, 'kite'))).toEqual({ savedAt, lemma: 'kite' });
    }
  });

  it.each([
    ['not base64 json', '!!!'],
    ['an object', raw({ a: 1 })],
    ['a junk timestamp', cursorOf('yesterday', 'kite')],
    ['an empty lemma', cursorOf('2026-10-04 12:00:00+00', '')],
    ['a lemma that is not a string', raw(['lemma', '2026-10-04 12:00:00+00', 7])],
    ['a lemma containing NUL', cursorOf('2026-10-04 12:00:00+00', 'ki\u0000te')],
    ['a wrong tag', raw(['lexeme', '2026-10-04 12:00:00+00', 'kite'])],
    // Review Focus 3: cursors an app may hold from before this phase.
    ['a phase 18 newest cursor', raw(['2026-10-04 12:00:00+00', 'lx-1'])],
    ['a phase 20 level cursor', raw(['2026-10-04 12:00:00+00', 'lx-1', 'level_asc', 2])],
    ['a well-shaped but out-of-range timestamp', cursorOf('2026-13-45 25:61:00+00', 'kite')],
    ['a day the month does not have', cursorOf('2026-02-30 12:00:00+00', 'kite')],
    ['a leap day in a common year', cursorOf('2026-02-29 12:00:00+00', 'kite')],
    ['an hour of 24', cursorOf('2026-10-04 24:00:00+00', 'kite')],
    ['a second of 60', cursorOf('2026-10-04 12:00:60+00', 'kite')],
    ['an offset of 99 hours', cursorOf('2026-10-04 12:00:00+99', 'kite')],
    ['an offset with 75 minutes', cursorOf('2026-10-04 12:00:00+05:75', 'kite')],
  ])('refuses %s', (_label, value) => {
    expect(decodeCursor(value)).toBeNull();
  });
});

describe('cursorAfter', () => {
  it('continues after the row', () => {
    expect(cursorAfter({ lemma: 'kite', lastSavedAt: '2026-10-04 12:00:00+00', level: 2 })).toEqual({
      savedAt: '2026-10-04 12:00:00+00',
      lemma: 'kite',
    });
  });
});

const summary = (lemma: string, over: Partial<WordSummary> = {}): WordSummary => ({
  lemma,
  partsOfSpeech: ['noun'],
  headlineSenseId: `s-${lemma}`,
  headlineTranslation: `tr-${lemma}`,
  headlineForm: `form-${lemma}`,
  savedCount: 1,
  senseCount: 2,
  ...over,
});

describe('assemblePage', () => {
  it('keeps the page order, not the summaries order', () => {
    const rows = [
      { lemma: 'b', lastSavedAt: 't2', level: 3 },
      { lemma: 'a', lastSavedAt: 't1', level: 1 },
    ];
    const page = assemblePage(rows, [summary('a'), summary('b', { partsOfSpeech: ['noun', 'verb'] })]);
    expect(page.map((w) => w.lemma)).toEqual(['b', 'a']);
    expect(page[0]).toEqual({
      lemma: 'b',
      parts_of_speech: ['noun', 'verb'],
      headline: { sense_id: 's-b', translation: 'tr-b', form: 'form-b' },
      saved_count: 1,
      sense_count: 2,
      level: 3,
    });
  });

  it('drops a page row with no summary', () => {
    const rows = [
      { lemma: 'a', lastSavedAt: 't2', level: 1 },
      { lemma: 'gone', lastSavedAt: 't1', level: 1 },
    ];
    expect(assemblePage(rows, [summary('a')]).map((w) => w.lemma)).toEqual(['a']);
  });
});
```

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm test -w apps/server -- src/domain/vocabulary.test.ts`
Expected: FAIL on the cursor, `cursorAfter` and `assemblePage` cases.

- [ ] **Step 3: Rewrite the cursor, page rows and assembly**

In `apps/server/src/domain/vocabulary.ts`, remove `VocabularySort` from the `@lang-tutor/core/api` import and `MAX_LEVEL` from the `@lang-tutor/core/domain` import. Keep `PG_TIMESTAMPTZ` and `isRealTimestamptz` as they are. Replace `VocabularyCursor`, `encodeCursor`, `decodeCursor`, `WordPageRow`, `cursorAfter`, `WordSummary` and `assemblePage` with:

```ts
/**
 * Where the next list page starts: the last row's newest save and its lemma.
 *
 * `savedAt` is Postgres's own text for a timestamptz, never a JS Date. A Date
 * keeps milliseconds and created_at keeps microseconds, so a cursor rounded down
 * would silently skip every word saved later in the same millisecond. The
 * repository prints it with `::text` and casts it back with `::timestamptz`, and
 * the round trip is exact.
 */
export type VocabularyCursor = { savedAt: string; lemma: string };

// Phase 21. The leading tag is what makes a phase 18 or phase 20 cursor — two or
// four elements, keyed by lexeme id — decode to null and answer 400, rather than
// be read as a position among lemmas.
const CURSOR_TAG = 'lemma';
```

```ts
export function encodeCursor(cursor: VocabularyCursor): string {
  return Buffer.from(JSON.stringify([CURSOR_TAG, cursor.savedAt, cursor.lemma]), 'utf8').toString('base64url');
}

/** `null` for anything this server did not issue. The caller turns that into a 400. */
export function decodeCursor(raw: string): VocabularyCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [tag, savedAt, lemma] = parsed as unknown[];
  if (tag !== CURSOR_TAG) return null;
  if (typeof savedAt !== 'string' || !isRealTimestamptz(savedAt)) return null;
  // A NUL cannot be a Postgres text parameter: it would raise there, a 500.
  if (typeof lemma !== 'string' || lemma.length === 0 || lemma.includes('\u0000')) return null;
  return { savedAt, lemma };
}

/** One row of the grouped keyset read, in page order. `level` is the word's
 *  badge: the rounded mean over every saved sense of the lemma and the live
 *  dimensions. */
export type WordPageRow = { lemma: string; lastSavedAt: string; level: number };

/** The cursor that continues after `row`. */
export function cursorAfter(row: WordPageRow): VocabularyCursor {
  return { savedAt: row.lastSavedAt, lemma: row.lemma };
}

/** What the page's enrichment read returns per lemma. Declared here rather than
 *  imported from the repository: R3 keeps this layer ignorant of Drizzle. */
export type WordSummary = {
  lemma: string;
  partsOfSpeech: string[];
  headlineSenseId: string;
  headlineTranslation: string;
  headlineForm: string;
  savedCount: number;
  senseCount: number;
};

/**
 * Page rows to the wire, in PAGE order. The enrichment read is keyed by lemma
 * and comes back in whatever order Postgres chose.
 *
 * A row with no summary is dropped. The enrichment read inner-joins each saved
 * entry to its saved form's rendering, so a word whose saved senses lost every
 * rendering has nothing to headline. A repair may not drop a rendering, so this
 * should not happen; if it does, the page is one word short and the cursor —
 * taken from the page rows, not from this output — still advances.
 */
export function assemblePage(rows: WordPageRow[], summaries: WordSummary[]): VocabularyWord[] {
  const byLemma = new Map(summaries.map((s) => [s.lemma, s]));
  return rows.flatMap((row) => {
    const s = byLemma.get(row.lemma);
    if (!s) return [];
    return [
      {
        lemma: s.lemma,
        parts_of_speech: s.partsOfSpeech,
        headline: {
          sense_id: s.headlineSenseId,
          translation: s.headlineTranslation,
          form: s.headlineForm,
        },
        saved_count: s.savedCount,
        sense_count: s.senseCount,
        level: row.level,
      },
    ];
  });
}
```

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm test -w apps/server -- src/domain/vocabulary.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing repository tests**

In `apps/server/tests/integration/repo/vocabulary.test.ts`:

Delete the `NEWEST` constant and its comment; after this step nothing uses it. Add a page helper at file level, below `lexemes`, for every page read in the file. No test may keep a local variable named `page` or `summaries`, which would shadow these:

```ts
const page = (input: { after?: VocabularyCursor; limit?: number; level?: number | null } = {}) =>
  repo((r) =>
    r.findWordsPage({
      enrollmentId: E,
      limit: input.limit ?? 50,
      after: input.after ?? null,
      level: input.level ?? null,
      live: LIVE_DIMENSIONS,
    }),
  );
const summaries = (lemmas: string[]) =>
  repo((r) => r.findWordSummaries({ enrollmentId: E, lemmas, targetLanguage: 'en', sourceLanguage: 'he' }));
```

Add a second `kite` lexeme for the merge cases, beside `lexemes`:

```ts
/** `kite` the verb: a second lexeme of the lemma, its form at entry rank 1. */
async function kiteVerb() {
  return insertLexeme(t.db, {
    lemma: 'kite',
    languageCode: 'en',
    partOfSpeech: 'verb',
    userLanguageCode: 'he',
    senses: [{ senseCode: 'fly' }],
    variants: [
      {
        form: 'kite',
        kind: 'word',
        entryRank: 1,
        translations: [
          { senseCode: 'fly', rank: 0, translation: 'להטיס עפיפון', exampleSource: null, exampleTarget: null },
        ],
      },
    ],
  });
}
```

Replace `describe('findWordsPage', …)` with:

```ts
describe('findWordsPage', () => {
  it('orders lemmas by their newest save, keeps microseconds, and continues strictly after a cursor', async () => {
    const [a, b, c] = await lexemes(3);
    await saveAt(a.lexemeId, a.senseId, a.variantId, '2026-10-04 12:00:00.000001+00');
    await saveAt(b.lexemeId, b.senseId, b.variantId, '2026-10-04 12:00:00.000003+00');
    await saveAt(c.lexemeId, c.senseId, c.variantId, '2026-10-04 12:00:00.000002+00');

    const first = await page({ limit: 2 });
    expect(first.map((row) => row.lemma)).toEqual(['word1', 'word2']);

    const last = first[first.length - 1];
    const rest = await page({ limit: 2, after: { savedAt: last.lastSavedAt, lemma: last.lemma } });
    // Same millisecond, different microsecond: a Date-based cursor would lose `a`.
    expect(rest.map((row) => row.lemma)).toEqual(['word0']);
  });

  it('breaks a tie on the save time by lemma, descending, and continues through it', async () => {
    const words = await lexemes(3);
    for (const w of words) await saveAt(w.lexemeId, w.senseId, w.variantId, '2026-10-04 12:00:00+00');
    expect((await page()).map((row) => row.lemma)).toEqual(['word2', 'word1', 'word0']);
    const [first] = await page({ limit: 1 });
    expect((await page({ after: { savedAt: first.lastSavedAt, lemma: first.lemma } })).map((r) => r.lemma)).toEqual([
      'word1',
      'word0',
    ]);
  });

  it("groups a lexeme's senses into one row at its newest save", async () => {
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 13:00:00+00');
    const rows = await page();
    expect(rows).toHaveLength(1);
    expect(rows[0].lastSavedAt).toMatch(/^2026-10-04 13:00:00/);
  });

  it('groups two lexemes of one lemma into one row, at the newer save, with one level', async () => {
    const verb = await kiteVerb();
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(verb.lexemeId, verb.senseIds[0], verb.variantIds[0], '2026-10-04 14:00:00+00');
    await setLevel(t.db, { enrollmentId: E, senseId: kite.senseIds[TOY], level: 5 });
    await setLevel(t.db, { enrollmentId: E, senseId: verb.senseIds[0], level: 2 });
    expect(await page()).toEqual([{ lemma: 'kite', lastSavedAt: expect.stringMatching(/^2026-10-04 14:00:00/), level: 4 }]);
    // The filter sees the merged level, not either lexeme's.
    expect((await page({ level: 4 })).map((r) => r.lemma)).toEqual(['kite']);
    expect(await page({ level: 5 })).toEqual([]);
    expect(await page({ level: 2 })).toEqual([]);
  });

  // Review Focus 2.
  it('keeps lemmas that differ only in case apart', async () => {
    const may = await insertLexeme(t.db, {
      lemma: 'May',
      languageCode: 'en',
      partOfSpeech: 'noun',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'month' }],
      variants: [{ form: 'May', kind: 'word', entryRank: 0, translations: [
        { senseCode: 'month', rank: 0, translation: 'מאי', exampleSource: null, exampleTarget: null },
      ] }],
    });
    const mayVerb = await insertLexeme(t.db, {
      lemma: 'may',
      languageCode: 'en',
      partOfSpeech: 'verb',
      userLanguageCode: 'he',
      senses: [{ senseCode: 'might' }],
      variants: [{ form: 'may', kind: 'word', entryRank: 1, translations: [
        { senseCode: 'might', rank: 0, translation: 'עשוי', exampleSource: null, exampleTarget: null },
      ] }],
    });
    await saveAt(may.lexemeId, may.senseIds[0], may.variantIds[0], '2026-10-04 12:00:00+00');
    await saveAt(mayVerb.lexemeId, mayVerb.senseIds[0], mayVerb.variantIds[0], '2026-10-04 12:00:01+00');
    expect((await page()).map((r) => r.lemma)).toEqual(['may', 'May']);
  });

  async function leveled(levels: number[]) {
    const words = await lexemes(levels.length);
    for (const [i, word] of words.entries()) {
      await saveAt(word.lexemeId, word.senseId, word.variantId, `2026-10-04 12:00:0${i}+00`);
      await setLevel(t.db, { enrollmentId: E, senseId: word.senseId, level: levels[i] });
    }
    return words.map((_, i) => `word${i}`);
  }

  it('gives each row its level', async () => {
    const [w0] = await leveled([3]);
    expect(await page()).toEqual([{ lemma: w0, lastSavedAt: expect.any(String), level: 3 }]);
  });

  it("averages a word's saved senses, rounding a tie up", async () => {
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:01+00');
    await setLevel(t.db, { enrollmentId: E, senseId: kite.senseIds[TOY], level: 2 });
    await setLevel(t.db, { enrollmentId: E, senseId: kite.senseIds[BIRD], level: 3 });
    expect((await page())[0].level).toBe(3);
  });

  it('reads only the live dimensions', async () => {
    const [w] = await lexemes(1);
    await saveAt(w.lexemeId, w.senseId, w.variantId, '2026-10-04 12:00:00+00');
    await setLevel(t.db, { enrollmentId: E, senseId: w.senseId, level: 5, dimension: 'spelling' });
    expect(await page()).toEqual([expect.objectContaining({ lemma: 'word0', level: 1 })]);
  });

  it('filters to one level, newest first, and continues a filtered walk after its cursor', async () => {
    const [, highOld, highNew] = await leveled([1, 4, 4, 2]);
    expect((await page({ level: 4 })).map((r) => r.lemma)).toEqual([highNew, highOld]);
    expect(await page({ level: 3 })).toEqual([]);
    const [first] = await page({ level: 4, limit: 1 });
    const rest = await page({ level: 4, after: { savedAt: first.lastSavedAt, lemma: first.lemma } });
    expect(rest.map((r) => r.lemma)).toEqual([highOld]);
  });
});
```

Replace `describe('findWordSummaries', …)` with:

```ts
describe('findWordSummaries', () => {
  it('headlines the lowest-ranked saved sense in its saved form, and counts', async () => {
    // bird is rank 1 in `kite`; toy is rank 0 in `kites`, so toy headlines.
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITES], '2026-10-04 13:00:00+00');
    expect(await summaries(['kite'])).toEqual([
      {
        lemma: 'kite',
        partsOfSpeech: ['noun'],
        headlineSenseId: kite.senseIds[TOY],
        headlineTranslation: 'עפיפונים',
        headlineForm: 'kites',
        savedCount: 2,
        senseCount: 2,
      },
    ]);
  });

  it('counts and names parts of speech across every lexeme of the lemma', async () => {
    const verb = await kiteVerb();
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await saveAt(verb.lexemeId, verb.senseIds[0], verb.variantIds[0], '2026-10-04 13:00:00+00');
    expect(await summaries(['kite'])).toEqual([
      expect.objectContaining({ lemma: 'kite', partsOfSpeech: ['noun', 'verb'], savedCount: 2, senseCount: 3 }),
    ]);
  });

  it('names only the parts of speech that have a saved sense, but counts every sense', async () => {
    await kiteVerb();
    await saveAt(kite.lexemeId, kite.senseIds[TOY], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    expect(await summaries(['kite'])).toEqual([
      expect.objectContaining({ partsOfSpeech: ['noun'], savedCount: 1, senseCount: 3 }),
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
    const [summary] = await summaries(['kite']);
    // bird was saved first.
    expect(summary.headlineSenseId).toBe(kite.senseIds[BIRD]);
  });

  it('returns no summary for a lemma whose saved senses have no rendering left', async () => {
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await t.db.execute(sql`delete from dict_var_translations
      where sense_id = ${kite.senseIds[BIRD]} and variant_id = ${kite.variantIds[KITE]}`);
    expect(await summaries(['kite'])).toEqual([]);
  });

  it('drops such a word from an assembled page while its page row still advances the cursor', async () => {
    await saveAt(kite.lexemeId, kite.senseIds[BIRD], kite.variantIds[KITE], '2026-10-04 12:00:00+00');
    await t.db.execute(sql`delete from dict_var_translations
      where sense_id = ${kite.senseIds[BIRD]} and variant_id = ${kite.variantIds[KITE]}`);
    const rows = await page();
    expect(rows.map((row) => row.lemma)).toEqual(['kite']);
    expect(assemblePage(rows, await summaries(rows.map((row) => row.lemma)))).toEqual([]);
  });

  it('answers nothing for no lemmas', async () => {
    expect(await summaries([])).toEqual([]);
  });
});
```

In `describe('a repaired variant')`, replace the page and summary reads with the helpers:

```ts
    expect((await page()).map((row) => row.lemma)).toEqual(['kite']);
    expect(await summaries(['kite'])).toEqual([
      expect.objectContaining({
        headlineSenseId: kite.senseIds[TOY],
        headlineTranslation: 'עפיפונים מתוקנים',
        headlineForm: 'kites',
        savedCount: 1,
      }),
    ]);
```

- [ ] **Step 5: Group the repository's list reads by lemma**

In `apps/server/src/repo/vocabulary.ts`, remove the `VocabularySort` import, `orderBy`, and the sort switch in `afterCursor`. Replace them with:

```ts
/** Strictly after the cursor in the list's one order: newest save first, lemma
 *  descending on a tie. */
function afterCursor(after: VocabularyCursor): SQL {
  return sql`(${SAVED_AT}, ve.lemma) < (${after.savedAt}::timestamptz, ${after.lemma}::text)`;
}
```

Replace `vocabularyQueries.wordsPage`:

```ts
  /**
   * One page of lemmas with their level, newest save first, optionally one level
   * only. The join reads this enrollment's live-dimension progress rows through
   * sense_progress_enrollment_dimension_idx, an index-only scan, and the grouping
   * is on the entry's own copy of the lemma, so no dictionary row is read.
   *
   * The timestamp goes out as `::text` and comes back with `::timestamptz` —
   * microseconds intact; see VocabularyCursor. The comparison is strictly
   * "after the cursor". A word saved into again, in any of its lexemes, only
   * moves to the top, behind the cursor, so it is never served twice in one walk.
   */
  wordsPage: (input: {
    enrollmentId: string;
    limit: number;
    after: VocabularyCursor | null;
    level: number | null;
    live: readonly Dimension[];
  }): SQL => {
    const having: SQL[] = [];
    if (input.level !== null) having.push(sql`${LEVEL} = ${input.level}`);
    if (input.after) having.push(afterCursor(input.after));
    // The join below is an inner join: an entry with no live-dimension progress
    // rows drops out of the list, while the detail reads the same entry as level 1
    // (senseProgressOf's fallback). Acceptable because it cannot happen today: the
    // only writer of entries (insertEntries) creates their rows in the same
    // statement, and the migration backfilled the older ones.
    return sql`
      SELECT ve.lemma, ${SAVED_AT}::text AS last_saved_at, ${LEVEL} AS level
      FROM vocabulary_entries ve
      JOIN sense_progress p ON p.enrollment_id = ve.enrollment_id
                           AND p.sense_id = ve.sense_id
                           AND p.dimension IN (${inList([...input.live])})
      WHERE ve.enrollment_id = ${input.enrollmentId}
      GROUP BY ve.lemma
      ${having.length > 0 ? sql`HAVING ${sql.join(having, sql` AND `)}` : sql``}
      ORDER BY ${SAVED_AT} DESC, ve.lemma DESC
      LIMIT ${input.limit}`;
  },
```

Replace `vocabularyQueries.wordSummaries`:

```ts
  /**
   * One row per lemma of a page: the headline, the saved parts of speech, the two
   * counts. The LATERAL is an INNER join on purpose — a word with no rendered saved
   * sense has nothing to headline and is dropped (assemblePage's comment).
   *
   * Headline: lowest rank in its own saved form, then the earliest save, then
   * sense id, across every lexeme of the lemma — deterministic, and all inside SQL
   * so no timestamp crosses into TypeScript. `sense_count` counts the senses of
   * every lexeme with the lemma in the target language, found through
   * dict_lexemes_language_lemma_pos_key.
   */
  wordSummaries: (input: {
    enrollmentId: string;
    lemmas: string[];
    targetLanguage: string;
    sourceLanguage: string;
  }): SQL => sql`
    SELECT w.lemma,
           h.sense_id AS headline_sense_id,
           h.translation AS headline_translation,
           h.form AS headline_form,
           (SELECT array_agg(DISTINCT l.part_of_speech ORDER BY l.part_of_speech)
              FROM vocabulary_entries c
              JOIN dict_lexemes l ON l.id = c.lexeme_id
             WHERE c.enrollment_id = ${input.enrollmentId}
               AND c.lemma = w.lemma) AS parts_of_speech,
           (SELECT count(*) FROM vocabulary_entries c
             WHERE c.enrollment_id = ${input.enrollmentId}
               AND c.lemma = w.lemma)::int AS saved_count,
           (SELECT count(*) FROM dict_lexemes l
              JOIN dict_senses s ON s.lexeme_id = l.id
             WHERE l.language_code = ${input.targetLanguage}
               AND l.lemma = w.lemma
               AND EXISTS (SELECT 1 FROM dict_var_translations r
                            WHERE r.sense_id = s.id
                              AND r.user_language_code = ${input.sourceLanguage}))::int AS sense_count
    FROM (VALUES ${sql.join(
      input.lemmas.map((lemma) => sql`(${lemma}::text)`),
      sql`, `,
    )}) AS w(lemma)
    JOIN LATERAL (
      SELECT ve.sense_id, tr.translation, v.form
      FROM vocabulary_entries ve
      JOIN dict_var_translations tr ON tr.variant_id = ve.variant_id
                                   AND tr.sense_id = ve.sense_id
                                   AND tr.user_language_code = ${input.sourceLanguage}
      JOIN dict_variants v          ON v.id = ve.variant_id
      WHERE ve.enrollment_id = ${input.enrollmentId}
        AND ve.lemma = w.lemma
      ORDER BY tr.rank, ve.created_at, ve.sense_id
      LIMIT 1
    ) h ON true`,
```

Replace the two repo methods:

```ts
    findWordsPage: async (input: {
      enrollmentId: string;
      limit: number;
      after: VocabularyCursor | null;
      level: number | null;
      live: readonly Dimension[];
    }): Promise<WordPageRow[]> => {
      const rows = await tx.execute<{ lemma: string; last_saved_at: string; level: number }>(
        vocabularyQueries.wordsPage(input),
      );
      return rows.rows.map((row) => ({ lemma: row.lemma, lastSavedAt: row.last_saved_at, level: row.level }));
    },

    findWordSummaries: async (input: {
      enrollmentId: string;
      lemmas: string[];
      targetLanguage: string;
      sourceLanguage: string;
    }): Promise<WordSummary[]> => {
      if (input.lemmas.length === 0) return [];
      const rows = await tx.execute<{
        lemma: string;
        parts_of_speech: string[];
        headline_sense_id: string;
        headline_translation: string;
        headline_form: string;
        saved_count: number;
        sense_count: number;
      }>(vocabularyQueries.wordSummaries(input));
      return rows.rows.map((row) => ({
        lemma: row.lemma,
        partsOfSpeech: row.parts_of_speech,
        headlineSenseId: row.headline_sense_id,
        headlineTranslation: row.headline_translation,
        headlineForm: row.headline_form,
        savedCount: row.saved_count,
        senseCount: row.sense_count,
      }));
    },
```

node-postgres returns a `text[]` column as a JS array, so `parts_of_speech` needs no parsing.

- [ ] **Step 6: Drop the sort from the service and the route**

In `apps/server/src/services/vocabulary.ts`, replace `listWords`:

```ts
    /**
     * Keyset pagination. One extra row is read to learn whether a next page
     * exists; the cursor is the last row KEPT — from the page rows, never from
     * the assembled items, which may be one short (assemblePage's comment).
     */
    listWords: async (enrollmentId: string, query: VocabularyPageQuery): Promise<VocabularyPage> => {
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      const level = query.level ?? null;
      const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
      if (query.cursor !== undefined && !after) throw new InvalidCursor();

      return transaction(async (repos) => {
        const enrolled = await enrollmentOrThrow(repos, enrollmentId);
        const read = await repos.vocabulary.findWordsPage({
          enrollmentId,
          limit: limit + 1,
          after,
          level,
          live: LIVE_DIMENSIONS,
        });
        const rows = read.slice(0, limit);
        const summaries = await repos.vocabulary.findWordSummaries({
          enrollmentId,
          lemmas: rows.map((row) => row.lemma),
          targetLanguage: enrolled.target_language,
          sourceLanguage: enrolled.source_language,
        });
        return {
          items: assemblePage(rows, summaries),
          next_cursor: read.length > limit ? encodeCursor(cursorAfter(rows[rows.length - 1])) : null,
        };
      });
    },
```

In `apps/server/src/routes/vocabulary.ts`, replace the list route's description and its 400 text:

```ts
  description:
    'One item per word: every lexeme with the same lemma is one word, with one level over all its ' +
    'saved senses. Ordered newest save first; `level` keeps one level only. Keyset-paginated: pass ' +
    '`next_cursor` back as `cursor`. A word saved into again moves to the top and is never served ' +
    'twice in one walk.',
```

```ts
    400: json(
      ErrorSchema,
      '`limit` is outside 1–100, `level` is not one of the published values, or `cursor` was not issued by this server.',
    ),
```

- [ ] **Step 7: Write the failing route tests**

In `apps/server/tests/integration/routes/vocabulary.test.ts`:

The `Page` type keys by lemma:

```ts
type Page = { items: { lemma: string; saved_count: number; sense_count: number; parts_of_speech: string[] }[]; next_cursor: string | null };
```

In `describe('a 120-word walk in pages of 50')`, `walk` collects lemmas, and the three tests compare lemmas:

```ts
        seen.push(...page.items.map((item) => item.lemma));
```

```ts
    it('returns every word exactly once, newest first', async () => {
      const seen = await walk();
      expect(seen).toHaveLength(120);
      expect(seen[0]).toBe('слово119');
      expect(seen[119]).toBe('слово0');
      expect(new Set(seen).size).toBe(120);
    });

    it('neither duplicates nor loses a word when an old one moves to the top mid-walk', async () => {
      const moved = words[10];
      const seen = await walk(async (n) => {
        if (n === 0) {
          await save(RU, [{ sense_id: moved.senseIds[1], variant_id: moved.variantIds[0] }]);
        }
      });
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(119);
      expect(seen).not.toContain('слово10');
      const fresh = (await (await list(RU, '?limit=1')).json()) as Page;
      expect(fresh.items[0]).toMatchObject({ lemma: 'слово10', saved_count: 2 });
    });

    // Review Focus 5: the save lands in the word's OTHER lexeme.
    it("neither duplicates nor loses a word that gains a save in another lexeme of its lemma mid-walk", async () => {
      const verb = await russianVerb('слово10', 'לדבר');
      const seen = await walk(async (n) => {
        if (n === 0) await save(RU, [{ sense_id: verb.senseIds[0], variant_id: verb.variantIds[0] }]);
      });
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(119);
      expect(seen).not.toContain('слово10');
      const fresh = (await (await list(RU, '?limit=1')).json()) as Page;
      expect(fresh.items[0]).toMatchObject({ lemma: 'слово10', saved_count: 2, parts_of_speech: ['noun', 'verb'] });
    });

    it("drops a word whose last sense is unsaved", async () => {
      await unsave(RU, words[50].senseIds[0]);
      const seen = await walk();
      expect(seen).toHaveLength(119);
      expect(seen).not.toContain('слово50');
    });
```

Add a describe for the merge, after the walk describe and inside `describe('GET /api/enrollments/{id}/vocabulary')`:

```ts
  describe('a lemma with two lexemes', () => {
    it('is one row with both parts of speech, counts across both, and one level', async () => {
      const noun = await russianWord('знать');
      const verb = await russianVerb('знать', 'לדעת');
      await save(RU, [
        { sense_id: noun.senseIds[0], variant_id: noun.variantIds[0] },
        { sense_id: verb.senseIds[0], variant_id: verb.variantIds[0] },
      ]);
      await setLevel(t.db, { enrollmentId: RU, senseId: noun.senseIds[0], level: 1 });
      await setLevel(t.db, { enrollmentId: RU, senseId: verb.senseIds[0], level: 4 });

      const body = (await (await list(RU)).json()) as { items: Record<string, unknown>[] };
      expect(body.items).toEqual([
        {
          lemma: 'знать',
          parts_of_speech: ['noun', 'verb'],
          headline: expect.objectContaining({ sense_id: expect.any(String) }),
          saved_count: 2,
          sense_count: 3,
          level: 3,
        },
      ]);
    });

    // Review Focus 4.
    it('keeps the row when the last saved sense of one lexeme is unsaved', async () => {
      const noun = await russianWord('знать');
      const verb = await russianVerb('знать', 'לדעת');
      await save(RU, [
        { sense_id: noun.senseIds[0], variant_id: noun.variantIds[0] },
        { sense_id: verb.senseIds[0], variant_id: verb.variantIds[0] },
      ]);
      await setLevel(t.db, { enrollmentId: RU, senseId: verb.senseIds[0], level: 5 });
      await unsave(RU, noun.senseIds[0]);

      const body = (await (await list(RU)).json()) as Page & { items: { level: number }[] };
      expect(body.items).toEqual([
        expect.objectContaining({ lemma: 'знать', parts_of_speech: ['verb'], saved_count: 1, sense_count: 3, level: 5 }),
      ]);
    });
  });

  // Review Focus 3.
  it.each([
    ['a phase 18 cursor', ['2026-10-04 12:00:00+00', 'lx-1']],
    ['a phase 20 level cursor', ['2026-10-04 12:00:00+00', 'lx-1', 'level_asc', 2]],
  ])('answers 400 for %s', async (_label, fields) => {
    const old = Buffer.from(JSON.stringify(fields), 'utf8').toString('base64url');
    const res = await list(RU, `?cursor=${encodeURIComponent(old)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });

  it('ignores a sort an older app still sends', async () => {
    const res = await list(RU, '?sort=level_asc');
    expect(res.status).toBe(200);
  });
```

Replace the forged-cursor test's payload so it is shaped like a cursor this phase issues:

```ts
    const forged = Buffer.from(JSON.stringify(['lemma', '2026-13-45 25:61:00+00', 'рама']), 'utf8').toString(
      'base64url',
    );
```

Replace `describe('levels on the list (phase 20)', …)` with:

```ts
describe('levels on the list (phase 20)', () => {
  type Leveled = { items: { lemma: string; level: number }[]; next_cursor: string | null };
  const lemmas = async (query: string) => ((await (await list(RU, query)).json()) as Leveled).items.map((i) => i.lemma);

  async function savedWord(lemma: string, level: number) {
    const word = await russianWord(lemma);
    await save(RU, [{ sense_id: word.senseIds[0], variant_id: word.variantIds[0] }]);
    await setLevel(t.db, { enrollmentId: RU, senseId: word.senseIds[0], level });
    return lemma;
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
    const lemma = await savedWord('арка', 1);
    expect(((await (await list(RU)).json()) as Leveled).items).toEqual([expect.objectContaining({ lemma, level: 1 })]);
  });

  it("averages a word's saved senses, rounding a tie up", async () => {
    const word = await russianWord('рама');
    await save(RU, word.senseIds.map((senseId) => ({ sense_id: senseId, variant_id: word.variantIds[0] })));
    await setLevel(t.db, { enrollmentId: RU, senseId: word.senseIds[0], level: 2 });
    await setLevel(t.db, { enrollmentId: RU, senseId: word.senseIds[1], level: 3 });
    expect(((await (await list(RU)).json()) as Leveled).items[0].level).toBe(3);
  });

  it('filters to one level, newest first', async () => {
    await savedWord('арка', 1);
    const highOld = await savedWord('бак', 4);
    const highNew = await savedWord('вал', 4);
    expect(await lemmas('?level=4')).toEqual([highNew, highOld]);
    expect(await lemmas('?level=3')).toEqual([]);
  });

  it('walks a filtered list page by page without repeating or losing a word', async () => {
    for (let i = 0; i < 9; i += 1) await savedWord(`слово${i}`, i % 3 === 0 ? 2 : 1);
    const seen = await walk('?level=2&limit=2');
    expect(seen).toHaveLength(3);
    expect(seen.every((item) => item.level === 2)).toBe(true);
    expect(new Set(seen.map((item) => item.lemma)).size).toBe(3);
  });

  it.each(['?level=0', '?level=6', '?level=two'])('answers 400 for %s', async (query) => {
    const res = await list(RU, query);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
  });
});
```

The `"keeps each enrollment's list to itself"` test needs no change.

- [ ] **Step 8: Re-shape the plan test's list cases**

In `apps/server/tests/integration/repo/vocabulary.plan.test.ts`:

```ts
const FIRST_50 = Array.from({ length: 50 }, (_, i) => `слово${i + 1}`);
const PAGE = { enrollmentId: HEAVY, limit: 51, level: null, live: LIVE_DIMENSIONS };

// Every shape of the list page. Each reads progress through the covering index.
const WORDS_PAGES: [string, () => SQL][] = [
  ['wordsPage, first page', () => vocabularyQueries.wordsPage({ ...PAGE, after: null })],
  ['wordsPage, after a cursor', () => vocabularyQueries.wordsPage({
    ...PAGE,
    after: { savedAt: '2000-01-01 00:00:00+00', lemma: 'слово1' },
  })],
  ['wordsPage, one level', () => vocabularyQueries.wordsPage({ ...PAGE, level: 2, after: null })],
];
```

The summaries case:

```ts
    ['wordSummaries', () => vocabularyQueries.wordSummaries({
      enrollmentId: HEAVY,
      lemmas: FIRST_50,
      targetLanguage: 'ru',
      sourceLanguage: 'he',
    })],
```

The budget tests: keep the newest first-page test with `vocabularyQueries.wordsPage({ ...PAGE, after: null })` in both calls, and replace the `it.each(['level_asc', 'level_desc'])` budget test with a one-level budget test:

```ts
  it(`serves the heavy enrollment's first one-level page in under ${BUDGET_MS} ms`, async () => {
    await explain(vocabularyQueries.wordsPage({ ...PAGE, level: 2, after: null }));
    const plan = await explain(vocabularyQueries.wordsPage({ ...PAGE, level: 2, after: null }));
    expect(plan['Execution Time']).toBeLessThan(BUDGET_MS);
  });
```

- [ ] **Step 9: Run the server tests and watch them pass**

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm run typecheck -w packages/core -w apps/server && npm test -w apps/server && bash scripts/lane-env.sh npm run test:integration -w apps/server -- tests/integration/repo/vocabulary.test.ts tests/integration/routes/vocabulary.test.ts tests/integration/repo/vocabulary.plan.test.ts`
Expected: PASS. The plan test's first page was measured at 13.4 ms for this query shape while designing; a budget failure means a plan changed, so read the plan in the output.

- [ ] **Step 10: Write the failing app tests**

`apps/mobile/src/vocabulary.test.ts`: import `partsOfSpeechLabel`, re-shape the `word` helper, and add the label tests:

```ts
const word = (lemma: string, over: Partial<VocabularyWord> = {}): VocabularyWord => ({
  lemma,
  parts_of_speech: ['noun'],
  headline: { sense_id: `s-${lemma}`, translation: 't', form: lemma },
  saved_count: 1,
  sense_count: 1,
  level: 1,
  ...over,
});

describe('appendPage', () => {
  it('appends, dropping a word already loaded', () => {
    expect(appendPage([word('a'), word('b')], [word('b'), word('c')]).map((w) => w.lemma)).toEqual(['a', 'b', 'c']);
  });
});

describe('partsOfSpeechLabel', () => {
  it('names one part of speech', () => {
    expect(partsOfSpeechLabel(['noun'])).toBe('שם עצם');
  });

  it('joins several, in the order given', () => {
    expect(partsOfSpeechLabel(['noun', 'verb'])).toBe('שם עצם · פועל');
  });

  it('drops a code with no name, and is empty for none', () => {
    expect(partsOfSpeechLabel(['noun', 'particle'])).toBe('שם עצם');
    expect(partsOfSpeechLabel([])).toBe('');
  });
});
```

`apps/mobile/src/progress.test.ts`: delete `describe('nextLevelFilter')` and remove `nextLevelFilter` from the import. Add, inside `describe('level names')`:

```ts
  it('names the filter that shows every level', () => {
    expect(strings.levelAll).toBe('הכל');
  });
```

`apps/mobile/src/api/client.test.ts`: replace `'listVocabulary passes sort and level when given'` with:

```ts
  it('listVocabulary passes a level when given, and never a sort', async () => {
    const mockFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [], next_cursor: null }) }));
    const client = buildClient(mockFetch);
    await client.listVocabulary('e1', { level: 2 });
    expect(mockFetch).toHaveBeenCalledWith('http://test.local/api/enrollments/e1/vocabulary?level=2', { method: 'GET' });
  });
```

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm test -w apps/mobile`
Expected: FAIL. `partsOfSpeechLabel` and `strings.levelAll` do not exist, and `appendPage` keys by `lexeme_id`.

- [ ] **Step 11: Change the app**

`apps/mobile/src/strings.ts`: delete `sortNewest`, `sortLevelAsc` and `sortLevelDesc`, and add beside `levelName`:

```ts
  levelAll: 'הכל',
```

`apps/mobile/src/progress.ts`: delete `nextLevelFilter` and its comment.

`apps/mobile/src/vocabulary.ts`: add `import { strings } from '@/strings';` after the type import, replace `appendPage`, and add `partsOfSpeechLabel`:

```ts
/** A word can move to the top between pages and be served on a refresh while an
 *  older copy is loaded. The server never serves one twice in a walk, but a
 *  refresh racing a scroll can. Dropping repeats by lemma makes that harmless.
 *  The first copy stays. */
export function appendPage(loaded: VocabularyWord[], page: VocabularyWord[]): VocabularyWord[] {
  const seen = new Set(loaded.map((word) => word.lemma));
  return [...loaded, ...page.filter((word) => !seen.has(word.lemma))];
}

/** A row's parts of speech, named in Hebrew and joined: a merged word says it is
 *  merged. A code with no Hebrew name is left out rather than shown raw. */
export function partsOfSpeechLabel(codes: string[]): string {
  return codes
    .map((code) => strings.partOfSpeech(code))
    .filter((name): name is string => Boolean(name))
    .join(' · ');
}
```

If importing `@/strings` into `vocabulary.ts` makes Jest fail to resolve the alias, check how `progress.ts` imports `strings` and do the same.

`apps/mobile/src/api/client.ts`: remove `VocabularySort` from the import and `sort` from `listVocabulary`:

```ts
    listVocabulary: (enrollmentId: string, query: { cursor?: string; limit?: number; level?: number }) => {
      const params = new URLSearchParams();
      if (query.cursor !== undefined) params.set('cursor', query.cursor);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.level !== undefined) params.set('level', String(query.level));
      const search = params.toString();
      return getJson<VocabularyPage>(`${vocabularyPath(enrollmentId)}${search ? `?${search}` : ''}`);
    },
```

`apps/mobile/src/hooks/useVocabulary.tsx`: remove `VocabularySort` from the import, and:

```ts
/** How the list is asked for: optionally, one level. */
export type VocabularyQuery = { level: number | null };
const DEFAULT_QUERY: VocabularyQuery = { level: null };
```

In `fetchPage`, delete the `sort: asked.sort,` line.

`apps/mobile/src/app/vocabulary/index.tsx`:

- Remove the `VocabularySort` import, the `nextLevelFilter` import and `SORTS`. Import `partsOfSpeechLabel` beside `showsMark` from `@/vocabulary`.
- Replace the two chip rows with one:
  ```tsx
      <View style={styles.chips}>
        <Chip
          testID="vocabulary-level-all"
          label={strings.levelAll}
          selected={v.query.level === null}
          onPress={() => {
            if (v.query.level !== null) v.setQuery({ level: null });
          }}
        />
        {LEVELS.map((level) => (
          <Chip
            key={level}
            testID={`vocabulary-level-${level}`}
            label={strings.levelName(level)}
            selected={v.query.level === level}
            onPress={() => {
              if (v.query.level !== level) v.setQuery({ level });
            }}
          />
        ))}
      </View>
  ```
- `keyExtractor={(word) => word.lemma}`.
- In `renderItem`, the parts of speech line:
  ```tsx
        renderItem={({ item }) => {
          const partsOfSpeech = partsOfSpeechLabel(item.parts_of_speech);
  ```
  and `{partsOfSpeech ? <Text style={styles.meta}>{partsOfSpeech}</Text> : null}` where the single part of speech was.

Confirm nothing in the repo still names a sort:

Run: `grep -rnE "VocabularySort|level_asc|level_desc|sortNewest|sortLevel|nextLevelFilter" apps packages --include='*.ts' --include='*.tsx' | grep -v node_modules`
Expected: hits only in test files, where `level_asc` is the input an older app or a phase 20 cursor would send (Steps 2 and 7). Any hit in a non-test file is a leftover to remove.

- [ ] **Step 12: Run every gate**

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm run typecheck && npm test && npm run test:all && npm run lint:arch`
Expected: all pass.

- [ ] **Step 13: Commit**

```bash
git add packages/core apps/server apps/mobile
git commit -m "feat: one saved-list row per lemma, no sorts, and an \"all\" level chip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: End to end

**Files:**
- Modify: `e2e/tests/support/lexemes.ts`, `e2e/tests/vocabulary.spec.ts`, `e2e/tests/progress.spec.ts`

**Interfaces:**
- Consumes: the testIDs `vocabulary-word`, `vocabulary-mark`, `vocabulary-sense`, `vocabulary-sense-pos`, `vocabulary-sense-save`, `vocabulary-word-back`, `vocabulary-level-all`, `vocabulary-level-{n}`, `vocabulary-empty-level` (Tasks 2 and 3).

- [ ] **Step 1: Add the two-lexeme lookup**

Append to `e2e/tests/support/lexemes.ts`:

```ts
// One form, two lexemes: знать the verb (to know) and знать the noun (nobility).
// Used only by the merged-word test, so no other spec has it in the e2e database.
export const ZNAT = {
  kind: 'word' as const,
  entries: [
    {
      lemma: 'знать',
      part_of_speech: 'verb',
      senses: [{ translation: 'לדעת', sense_code: 'know' }],
    },
    {
      lemma: 'знать',
      part_of_speech: 'noun',
      senses: [{ translation: 'אצולה', sense_code: 'nobility' }],
    },
  ],
};
```

- [ ] **Step 2: Write the merged-word test**

Append to `e2e/tests/vocabulary.spec.ts`, importing `ZNAT` beside `LUK` and `PROCHITALA`:

```ts
test('a word saved in two parts of speech is one row, and its detail labels each sense', async ({
  page,
  request,
}) => {
  await createLearner(request, 'e2e_vocab_merge_ru', 'ru');
  await logIn(page, 'e2e_vocab_merge_ru');
  await tapUntil(page, 'translate-entry', 'translate-input');

  // Both lexemes of знать, in one tap.
  await lookUp(page, request, 'знать', ZNAT);
  const save = page.getByTestId('translate-save');
  await expect(save).toHaveCount(2);
  await tapAndWaitForWrite(page, page.getByTestId('translate-save-all'));
  await expect(save).toHaveText(['נשמר ✓', 'נשמר ✓']);

  // One row, both saved senses counted, both parts of speech named.
  await page.getByTestId('translate-back').click();
  await tapUntil(page, 'vocabulary-entry', 'vocabulary-word');
  const words = page.getByTestId('vocabulary-word');
  await expect(words).toHaveCount(1);
  await expect(words.first()).toContainText('знать');
  await expect(words.first()).toContainText('שם עצם · פועל');
  await expect(words.first().getByTestId('vocabulary-mark')).toContainText(/2\/2/);

  // The detail: two cards, saved first and then by part of speech, so the noun
  // comes first. Each names its part of speech.
  await words.first().click();
  const senses = page.getByTestId('vocabulary-sense');
  await expect(senses).toHaveCount(2);
  await expect(senses.nth(0).getByTestId('vocabulary-sense-pos')).toHaveText('שם עצם');
  await expect(senses.nth(0)).toContainText('אצולה');
  await expect(senses.nth(1).getByTestId('vocabulary-sense-pos')).toHaveText('פועל');
  await expect(senses.nth(1)).toContainText('לדעת');

  // Unsave the noun. The row stays, now one of two, naming only the verb.
  const toggle = senses.nth(0).getByTestId('vocabulary-sense-save');
  await tapAndWaitForWrite(page, toggle);
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveText('שמור');
  await page.getByTestId('vocabulary-word-back').click();
  await expect(words).toHaveCount(1);
  await expect(words.first().getByTestId('vocabulary-mark')).toContainText(/1\/2/);
  await expect(words.first()).toContainText('פועל');
  await expect(words.first()).not.toContainText('שם עצם');
});
```

`tapAndWaitForWrite` here is the file's own copy, which also waits for a DELETE.

The existing test in this file needs no change: it opens the detail by tapping a row, and the row now navigates by lemma.

- [ ] **Step 3: Replace the sort steps in the progress test**

In `e2e/tests/progress.spec.ts`, rename the test to `'a session moves the words it practised up the ladder, and the list filters by level'`, and replace steps 5 and 6 with:

```ts
  // 5. No sorts any more, and the filter opens on "all".
  await expect(page.locator('[data-testid^="vocabulary-sort-"]')).toHaveCount(0);
  await expect(page.getByTestId('vocabulary-level-all')).toBeVisible();

  // 6. Filter to a level, an empty level, and "all" to clear it.
  await page.getByTestId('vocabulary-level-2').click();
  await expect(words).toHaveCount(1);
  await expect(words.first()).toContainText('лук');
  await page.getByTestId('vocabulary-level-all').click();
  await expect(words).toHaveCount(2);
  await page.getByTestId('vocabulary-level-4').click();
  await expect(page.getByTestId('vocabulary-empty-level')).toBeVisible();
  await page.getByTestId('vocabulary-level-all').click();
  await expect(words).toHaveCount(2);
```

- [ ] **Step 4: Run the end-to-end suite**

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm run e2e`
Expected: every spec passes. If the e2e database or MockServer is not up, `npm run db:up` must be run from the main checkout, which this task may not touch: report it and stop instead.

If the merged-word test fails on the part-of-speech text, print the row's text with `console.log(await words.first().textContent())` once to see what the screen renders, then remove the log.

- [ ] **Step 5: Commit**

```bash
git add e2e
git commit -m "test(e2e): a word in two parts of speech is one row; the list filters without sorts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Final verification and the spec

- [ ] **Step 1: Run everything CI runs**

Run: `export PATH="/opt/homebrew/bin:$PATH"; npm run typecheck && npm test && npm run test:all && npm run lint:arch && npm run db:check -w apps/server && npm run db:generate -w apps/server && git status --porcelain apps/server/src/db/migrations && npm run e2e`
Expected: everything passes, and `git status` prints nothing for the migrations folder.

- [ ] **Step 2: Bring the spec in line with what was built**

Read `docs/superpowers/specs/2026-10-06-lang-tutor-phase-21-saved-list-by-lemma-design.md` against the branch's diff (`git diff origin/master...HEAD -- apps packages e2e`). For every place the code differs from the spec, change the spec to say what was built. Set its status line to say the design was implemented on branch `phase-21-saved-list-by-lemma`, with deviations folded in. If nothing differs, change only the status line.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-06-lang-tutor-phase-21-saved-list-by-lemma-design.md
git commit -m "docs: phase 21 spec matches what was built

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
